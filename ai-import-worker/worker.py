"""Quizard high-fidelity, fail-closed MCQ book importer.

Run as a continuously scheduled worker, not in a browser/Edge Function.
It never publishes a book unless extraction, independent review, source answers
and image attribution all pass. Jobs can be resumed after interruption.
"""
from __future__ import annotations
import base64
import hashlib
import io
import json
import logging
import os
import re
import time
import traceback
import unicodedata
from collections import Counter
from pathlib import Path

import fitz
from openai import OpenAI, APIConnectionError, APITimeoutError, RateLimitError, InternalServerError
from supabase import create_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("quizard-ai-import")

URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
MODEL = os.getenv("OPENAI_EXTRACTION_MODEL", "gpt-6.1-sol")
VERIFY_MODEL = os.getenv("OPENAI_VERIFICATION_MODEL", "gpt-6-astra")
PAGES_PER_BATCH = max(1, min(6, int(os.getenv("PAGES_PER_BATCH", "3"))))
POLL_SECONDS = max(10, int(os.getenv("POLL_SECONDS", "60")))
AUTO_PUBLISH = os.getenv("AUTO_PUBLISH", "true").lower() == "true"
DB = create_client(URL, SERVICE_KEY)
AI = OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=300, max_retries=3)

EXTRACTION_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "questions": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "questionNumber": {"type": "integer"},
                "sourcePage": {"type": "integer"},
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}},
                "correctAnswerIndex": {"type": "integer"},
                "explanation": {"type": "string"},
                "answerEvidence": {"type": "string"},
                "figureInQuestion": {"type": "boolean"},
                "figureInExplanation": {"type": "boolean"},
            },
            "required": ["questionNumber", "sourcePage", "question", "options",
                         "correctAnswerIndex", "explanation", "answerEvidence",
                         "figureInQuestion", "figureInExplanation"],
        }},
    }, "required": ["questions"],
}

BOOK_SCHEMA = {
    "type":"object","additionalProperties":False,
    "properties":{
        "title":{"type":"string"},
        "coverPage":{"type":"integer"},
        "titleEvidence":{"type":"string"},
        "confidence":{"type":"string","enum":["high","medium","low"]},
    },
    "required":["title","coverPage","titleEvidence","confidence"]
}

VERIFICATION_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "questionNumbersInSource": {"type": "array", "items": {"type": "integer"}},
        "issues": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "properties": {"number": {"type": "integer"}, "detail": {"type": "string"}},
            "required": ["number", "detail"],
        }},
    },
    "required": ["questionNumbersInSource", "issues"],
}

def update_job(job_id, **fields):
    fields["updated_at"] = "now()" if False else __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc).isoformat()
    DB.table("ai_import_jobs").update(fields).eq("id", job_id).execute()

def assert_job_active(job_id):
    row = DB.table("ai_import_jobs").select("status").eq("id",job_id).single().execute().data
    if row["status"] not in ("processing",): raise RuntimeError("Job is no longer processing")

def page_part(document, first, last):
    """1-based inclusive range; its page numbering is deliberately reported to AI."""
    result = fitz.open()
    result.insert_pdf(document, from_page=first-1, to_page=last-1)
    data = result.tobytes(garbage=4, deflate=True)
    result.close()
    return data

def source_page_text(document, first, last):
    return "\n".join(
        f"\n=== ORIGINAL PDF PAGE {p} ===\n" + document[p-1].get_text(sort=True)[:25000]
        for p in range(first, last+1)
    )

def run_structured(pdf_bytes, prompt, schema, name, model):
    encoded = base64.b64encode(pdf_bytes).decode("ascii")
    response = AI.responses.create(
        model=model,
        input=[{"role":"user","content":[
            {"type":"input_text","text":prompt},
            {"type":"input_file","filename":"source-pages.pdf",
             "file_data":"data:application/pdf;base64,"+encoded},
        ]}],
        text={"format":{"type":"json_schema","name":name,"strict":True,"schema":schema}},
        max_output_tokens=16000,
        store=False,
    )
    raw = response.output_text
    if not raw: raise ValueError("AI returned empty response")
    return json.loads(raw)

def find_sections(document):
    """Use native PDF bookmarks first, then actual printed chapter headings."""
    pages = len(document)
    toc = document.get_toc()
    candidates = [(level,str(title).strip(),int(start))
                  for level,title,start,*_ in toc
                  if 1 <= int(start) <= pages and title.strip()]
    if candidates:
        counts = Counter(level for level,_,_ in candidates)
        levels = sorted(counts)
        # The first level with actual chapter-like entries is preferable.
        chapter_level = next(
            (level for level in levels if sum(l == level and
              re.search(r"chapter|section",t,re.I) is not None
              for l,t,_ in candidates) >= 2), None)
        if chapter_level is None:
            chapter_level = next((level for level in levels if counts[level] >= 2), None)
        if chapter_level is not None:
            entries = [(title,p) for level,title,p in candidates if level == chapter_level]
            entries = [(t,p) for t,p in entries if p >= 1]
            if len(entries) >= 2:
                return finalize_sections(entries,pages), []
    entries = []
    seen = set()
    # Restrict to first lines of each page; do not confuse ordinary MCQ mentions of chapter.
    regex = re.compile(r"^(?:(?:chapter|section)\s+\d+[a-z]?\b[\s:.\-]*(.*)|(?:ch\.)\s*\d+\b[\s:.\-]*(.*))$",re.I)
    for p in range(1,pages+1):
        text = document[p-1].get_text(sort=True)
        for line in text.splitlines()[:12]:
            line = re.sub(r"\s+"," ",line.strip())
            if regex.fullmatch(line) and len(line) < 135 and p not in seen:
                entries.append((line,p));seen.add(p);break
    if len(entries) >= 2: return finalize_sections(entries,pages), []
    # Never silently create fictitious chapter titles.
    return [dict(section_index=1,title="Unclassified questions",start_page=1,end_page=pages)], [
        {"type":"chapters_unverified","detail":
         "No reliable PDF bookmarks or chapter headings found. Chapter structure needs verification."}
    ]

def finalize_sections(entries,pages):
    result=[]
    for title,p in sorted(entries,key=lambda x:x[1]):
        if result and p <= result[-1]["start_page"]: continue
        if result: result[-1]["end_page"]=p-1
        result.append(dict(section_index=len(result)+1,title=title[:250],
                           start_page=p,end_page=pages))
    return result

def inspect_book_metadata(document):
    count=min(5,len(document))
    mini=page_part(document,1,count)
    prompt="""Examine these original PDF pages (first page corresponds to original page 1).
Identify the real book title, preserving the exact printed title and edition, and
which page is the actual book cover or title page (1-based). Do not infer a title
from generic headers, ISBN-only or copyright-only pages. If no reliable title or
cover is visible set confidence='low', title='', coverPage=1,
titleEvidence=''. Only report 'high' when clearly printed on the selected page.
Return structured JSON."""
    return run_structured(mini,prompt,BOOK_SCHEMA,"quizard_book_metadata",MODEL)

def clean(s):
    return re.sub(r"\s+"," ",unicodedata.normalize("NFKC",str(s or "")).strip())

def validate_question(q,first,last):
    issues=[]
    number=q.get("questionNumber")
    src=q.get("sourcePage")
    if not isinstance(number,int) or number < 0:
        issues.append("Invalid question number")
    if not isinstance(src,int) or src < first or src > last:
        issues.append("Source page number outside batch")
    if len(clean(q.get("question"))) < 8: issues.append("Missing or truncated question stem")
    options=q.get("options") or []
    if not isinstance(options,list) or not 2 <= len(options) <= 10 or any(
        not isinstance(o,str) or not clean(o) for o in options):
        issues.append("Invalid or missing answer options")
    index=q.get("correctAnswerIndex")
    if not isinstance(index,int) or index < 0 or index >= len(options):
        issues.append("Source answer key absent or invalid")
    if not clean(q.get("explanation")): issues.append("Explanation missing in source")
    if not clean(q.get("answerEvidence")): issues.append("No exact source evidence for correct answer")
    return issues

def detect_raster_figures(document, page):
    """Get embedded raster image rectangles. Vector plots must be flagged separately."""
    p=document[page-1]
    found=[]; seen=set()
    for im in p.get_images(full=True):
        xref=im[0]
        try:
            for rect in p.get_image_rects(xref):
                if rect.width < 90 or rect.height < 70: continue
                key=(xref,round(rect.x0),round(rect.y0))
                if key in seen: continue
                seen.add(key)
                found.append((xref,rect))
        except Exception: pass
    return found

def upload_image(bucket,path,data,mime):
    # Unique job-scoped paths; never overwrite existing content in another book.
    DB.storage.from_(bucket).upload(path,data,{"content-type":mime,"upsert":"true"})
    return DB.storage.from_(bucket).get_public_url(path)

def attach_figures(document,job,section_index,questions):
    """Fail closed on ambiguous figure associations rather than attach wrong images."""
    issues=[]
    pages=Counter(q["sourcePage"] for q in questions if isinstance(q.get("sourcePage"),int))
    used=set()
    for q in questions:
        page=q.get("sourcePage")
        if not isinstance(page,int) or not 1 <= page <= len(document):continue
        need_q=bool(q.get("figureInQuestion"))
        need_e=bool(q.get("figureInExplanation"))
        if not need_q and not need_e: continue
        figures=detect_raster_figures(document,page)
        number=q.get("questionNumber")
        if len(figures)==0:
            issues.append({"page":page,"number":number,"type":"figure",
                           "detail":"Figure indicated but no embedded raster image. Possible vector figure or adjacent page."})
            continue
        if pages[page]!=1 or (need_q and need_e):
            issues.append({"page":page,"number":number,"type":"figure",
                           "detail":"Ambiguous figure ownership/type. Multiple questions or figure contexts on this page."})
            continue
        urls=[]
        for idx,(xref,rect) in enumerate(figures,1):
            key=(page,xref)
            if key in used: continue
            used.add(key)
            # Crop rendered page to retain layered annotations and figure labels.
            pix=document[page-1].get_pixmap(matrix=fitz.Matrix(2,2),clip=rect,alpha=False)
            data=pix.tobytes("png")
            path=f"ai-import/{job['id']}/ch{section_index}/{number}{'e' if need_e else 'q'}{idx}.png"
            urls.append(upload_image("question_images",path,data,"image/png"))
        if urls:
            field="explanationImageUrls" if need_e else "imageUrls"
            field_first="explanationImageUrl" if need_e else "imageUrl"
            q[field]=urls;q[field_first]=urls[0]
    return issues

def to_json_question(q):
    return {k:q.get(k) for k in
            ("questionNumber","question","options","correctAnswerIndex","explanation",
             "imageUrl","imageUrls","explanationImageUrl","explanationImageUrls")}

def process_section(document,job,section,common_issues):
    job_id=job["id"]
    existing=DB.table("ai_import_sections").select("status,questions,issues").eq(
        "job_id",job_id).eq("section_index",section["section_index"]).execute().data
    if existing and existing[0]["status"] == "verified":
        return existing[0]
    questions=[]; issues=[]
    first=section["start_page"]; end=section["end_page"]
    for start in range(first,end+1,PAGES_PER_BATCH):
        finish=min(end,start+PAGES_PER_BATCH-1)
        # The overlap helps finish an MCQ spanning the page boundary.
        extended_end=min(end,finish+1)
        mini=page_part(document,start,extended_end)
        prompt=f"""You are a forensic transcription expert. Extract every MCQ whose STEM STARTS
on original PDF pages {start} through {finish} from the attached PDF, including
continuations on page {extended_end}. The first page of this PDF is original page {start}.
Read visually (not only OCR) and exactly preserve all clinical values, stem text,
option order, explanation and original question numbers. Preserve tables as simple
HTML table/tr/td. No paraphrasing, no invented text, no invented explanations.
Do not include questions starting on overlap page {extended_end} unless it equals {finish}.
If the printed answer and explanation are NOT VISIBLE, output correctAnswerIndex=-1,
explanation="" and answerEvidence="". Do not solve the question medically.
If a printed key exists, correctAnswerIndex is zero-based and answerEvidence must
quote or closely locate the actual key text (not your reasoning).
sourcePage is the original 1-based PDF page where the stem begins.
Indicate whether the QUESTION or the EXPLANATION contains a figure needing extraction.
Never generate text placeholders for images. Return all questions; omit headers,
advertisements, table of contents, and standalone answer explanations without stems."""
        result=run_structured(mini,prompt,EXTRACTION_SCHEMA,"quizard_extract",MODEL)
        part=[q for q in result.get("questions",[]) if
              isinstance(q.get("sourcePage"),int) and start <= q["sourcePage"] <= finish]
        def audit_candidate(candidate):
            verifier_prompt=f"""Act as an independent source-audit reviewer. Read ALL original PDF
pages {start}-{extended_end}, where attached PDF page 1 corresponds to original {start}.
Review only questions whose stems start on source pages {start}-{finish}.
The candidate JSON follows. Independently enumerate all visible MCQ QUESTION NUMBERS.
Compare each candidate stem, options, answer, explanation, medical values, numbering,
and figure presence to the PDF. Detect any omitted questions, merged questions,
hallucinated source answers, wrong option order, missing explanation, or dropped
table. Do NOT accept correctness merely because the medical answer seems plausible.
If answers are elsewhere in the book, report this uncertainty. Report every
discrepancy using the numbered issue list. Return empty issues ONLY if fully supported.
CANDIDATE JSON:
{json.dumps(candidate,ensure_ascii=False)}"""
            check=run_structured(mini,verifier_prompt,VERIFICATION_SCHEMA,
                                 "quizard_source_audit",VERIFY_MODEL)
            reported=[]
            original=[int(x) for x in check["questionNumbersInSource"]]
            captured=[q["questionNumber"] for q in candidate]
            if Counter(original)!=Counter(captured):
                reported.append({"pages":[start,finish],"type":"completeness",
                                 "detail":"Independent source question numbers differ from extraction",
                                 "source":original,"extracted":captured})
            for i in check["issues"]:
                reported.append({"pages":[start,finish],"type":"independent_audit",**i})
            for q in candidate:
                for issue in validate_question(q,start,finish):
                    reported.append({"pages":[start,finish],"type":"validation",
                                     "number":q.get("questionNumber"),"detail":issue})
            return reported
        batch_issues=audit_candidate(part)
        # The agent tries to fix each source disagreement itself before involving an admin.
        # Do not "repair" absent source answer keys by medical reasoning.
        for attempt in range(2):
            if not batch_issues: break
            if all(i["type"]=="validation" and (
                "answer key absent" in i["detail"] or
                "Explanation missing" in i["detail"] or
                "No exact source evidence" in i["detail"])
                for i in batch_issues):
                break
            correction_prompt=f"""Repair an MCQ transcription from the ATTACHED ORIGINAL PDF.
The first PDF page is original page {start}. Extract ONLY questions whose stem
starts on original pages {start}-{finish}. Preserve exact source text, options,
order, numerical values, HTML tables, and explanations. DO NOT invent answers
or explanations. If not visibly printed, use correctAnswerIndex=-1 and empty
explanation/answerEvidence. Do not omit a question to make the audit pass.
Current candidate:
{json.dumps(part,ensure_ascii=False)}
Independent auditor's specific findings:
{json.dumps(batch_issues,ensure_ascii=False)}
Return a complete corrected question array using the supplied JSON schema.
Only correct faults supported by visible text in these PDF pages."""
            repaired=run_structured(mini,correction_prompt,EXTRACTION_SCHEMA,
                                    "quizard_repair",MODEL)
            part=[q for q in repaired.get("questions",[]) if
                  isinstance(q.get("sourcePage"),int) and start <= q["sourcePage"] <= finish]
            batch_issues=audit_candidate(part)
            LOG.info("Re-audit %s pages %s-%s attempt %s: %s issues",
                     job_id,start,finish,attempt+1,len(batch_issues))
        issues.extend(batch_issues)
        questions.extend(part)
        update_job(job_id,worker_lock_at=
                   __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat())
        LOG.info("Job %s chapter %s processed PDF pages %s-%s",job_id,
                 section["section_index"],start,finish)
    if not questions:
        issues.append({"type":"empty_chapter","detail":"No MCQs found; a chapter cannot be safely published without review"})
    seen_numbers=set()
    for q in questions:
        number=q["questionNumber"]
        if number in seen_numbers:
            issues.append({"type":"duplicate_number","number":number,
                           "detail":"Duplicate original question number within the chapter"})
        seen_numbers.add(number)
    issues.extend(attach_figures(document,job,section["section_index"],questions))
    if common_issues:
        issues.extend(common_issues)
    state="needs_review" if issues else "verified"
    record={
        "job_id":job_id,"section_index":section["section_index"],
        "title":section["title"],"start_page":first,"end_page":end,
        "status":state,"questions":[to_json_question(q) for q in questions],
        "issues":issues,
    }
    DB.table("ai_import_sections").upsert(record,on_conflict="job_id,section_index").execute()
    return record

def process_job(job):
    job_id=job["id"]
    LOG.info("Processing %s (%s)",job["file_name"],job_id)
    raw=DB.storage.from_("ai_import_sources").download(job["source_path"])
    if raw[:4] != b"%PDF": raise ValueError("Not a valid PDF")
    document=fitz.open(stream=raw,filetype="pdf")
    try:
        if document.needs_pass: raise ValueError("Password-protected PDFs are not supported")
        pages=len(document)
        if not pages:raise ValueError("Empty PDF")
        update_job(job_id,total_pages=pages,processed_pages=0)
        job["total_pages"]=pages
        sections,global_issues=find_sections(document)
        if len(sections)<1:raise ValueError("No sections detected")
        metadata=inspect_book_metadata(document)
        cover_page=metadata.get("coverPage",1)
        if not isinstance(cover_page,int) or not 1 <= cover_page <= min(5,pages):
            cover_page=1
            global_issues.append({"type":"cover","detail":"AI-selected cover page was invalid"})
        if metadata.get("confidence")!="high" or not clean(metadata.get("titleEvidence")):
            global_issues.append({"type":"book_metadata","detail":"Book cover/title not unambiguously identified"})
        else:
            title=clean(metadata.get("title"))
            if title and len(title)<300: update_job(job_id,title_hint=title)
        # Render the actual source cover/title page; never generate a fictional cover.
        cover=document[cover_page-1].get_pixmap(matrix=fitz.Matrix(1.3,1.3),alpha=False)
        cover_bytes=cover.tobytes("png")
        cover_url=upload_image("book_covers",f"ai-import/{job_id}/cover.png",cover_bytes,"image/png")
        update_job(job_id,cover_url=cover_url)
        records=[]
        total=0
        pages_completed=0
        for section in sections:
            assert_job_active(job_id)
            record=process_section(document,job,section,[])
            records.append(record)
            total+=len(record["questions"])
            pages_completed+=section["end_page"]-section["start_page"]+1
            verified=sum(len(r["questions"]) for r in records if r["status"]=="verified")
            update_job(job_id,total_questions=total,verified_questions=verified,
                       processed_pages=min(pages,pages_completed))
        review=list(global_issues)
        for r in records:
            review.extend({"chapter":r["section_index"],**i} for i in r["issues"])
        if total==0:
            review.append({"type":"empty","detail":"No MCQs could be extracted from this book"})
        if any(r["status"]!="verified" for r in records):
            review.append({"type":"chapter_review","detail":"One or more chapters did not pass source audit"})
        # A precise completeness check needs verified page-by-page coverage, done by the verifier.
        update_job(job_id,review_issues=review,status="needs_review" if review else "ready",
                   total_questions=total,verified_questions=sum(
                      len(r["questions"]) for r in records if r["status"]=="verified"),
                   processed_pages=pages)
        if not review and AUTO_PUBLISH:
            DB.rpc("ai_publish_import_job",{"p_job_id":job_id}).execute()
            LOG.info("Published %s, %s questions",job_id,total)
        else:
            LOG.info("Job %s %s, %d review issues",job_id,
                     "requires review" if review else "ready",len(review))
    finally:
        document.close()

def main():
    LOG.info("Quizard importer running. Extraction=%s, verification=%s",MODEL,VERIFY_MODEL)
    while True:
        try:
            result=DB.rpc("ai_claim_import_job").execute()
            job=result.data
            if isinstance(job,list):job=job[0] if job else None
            if not job:
                time.sleep(POLL_SECONDS);continue
            try:
                process_job(job)
            except Exception as exc:
                LOG.error("Failed job %s: %s\n%s",job["id"],exc,traceback.format_exc())
                transient=isinstance(exc,(APIConnectionError,APITimeoutError,
                                           RateLimitError,InternalServerError))
                if transient and int(job.get("attempts",0)) < 5:
                    # Leave already verified sections intact; recover autonomously.
                    update_job(job["id"],status="queued",last_error=str(exc)[:2000])
                    time.sleep(min(600,30*2**int(job.get("attempts",1))))
                else:
                    update_job(job["id"],status="failed",last_error=str(exc)[:2000])
        except KeyboardInterrupt:raise
        except Exception as exc:
            LOG.exception("Worker queue error: %s",exc)
            time.sleep(POLL_SECONDS)

if __name__=="__main__":main()
