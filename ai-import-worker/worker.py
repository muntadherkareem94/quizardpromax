"""Quizard high-fidelity, fail-closed MCQ book importer.

Run as a scheduled Railway job, not in a browser/Edge Function.
Only named synthetic test fixtures can publish to the hidden admin-only test tier.
Real books are staged for review, not published. Jobs resume after interruption.
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
from datetime import datetime, timezone
import unicodedata
from collections import Counter
from pathlib import Path

import fitz
from openai import OpenAI, APIConnectionError, APITimeoutError, RateLimitError, InternalServerError
from supabase import create_client
from cost_guard import (BudgetExceeded, assert_budget, reserve_cost_usd,
                        usage_cost_usd, safely_selectable_text)
from free_router import FreeRouter, ProvidersUnavailable
from local_mcq import extract_local_section, local_book_metadata

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOG = logging.getLogger("quizard-ai-import")

URL = os.environ["SUPABASE_URL"]
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
MODEL = os.getenv("OPENAI_EXTRACTION_MODEL", "gpt-6.1-sol")
VERIFY_MODEL = os.getenv("OPENAI_VERIFICATION_MODEL", "gpt-6-astra")
PAGES_PER_BATCH = max(1, min(6, int(os.getenv("PAGES_PER_BATCH", "3"))))
POLL_SECONDS = max(10, int(os.getenv("POLL_SECONDS", "60")))
RUN_ONCE = os.getenv("RUN_ONCE", "false").lower() == "true"
MAX_PAGES_PER_JOB = max(1, int(os.getenv("MAX_PAGES_PER_JOB", "30")))  # Pilot cost guard
# Flex uses the same requested model at Batch-rate prices (slower and sometimes unavailable).
OPENAI_SERVICE_TIER = os.getenv("OPENAI_SERVICE_TIER", "flex").lower()
TEXT_FIRST_ENABLED = os.getenv("TEXT_FIRST_ENABLED", "true").lower() == "true"
LOCAL_FIRST_ENABLED = os.getenv("LOCAL_FIRST_ENABLED", "true").lower() == "true"
if OPENAI_SERVICE_TIER not in ("flex", "auto"):
    raise ValueError("OPENAI_SERVICE_TIER must be flex or auto")
AUTO_PUBLISH = False  # Safety interlock: this branch is staging-only
DB = create_client(URL, SERVICE_KEY)
# The original paid path stays available in code but is OFF by default.
ALLOW_PAID_OPENAI = os.getenv("ALLOW_PAID_OPENAI", "false").lower() == "true"
AI = OpenAI(api_key=os.getenv("OPENAI_API_KEY","disabled"), timeout=900, max_retries=2)
FREE_ROUTER = FreeRouter(DB)

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
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
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

def run_structured(pdf_bytes, prompt, schema, name, model, *,
                   job_id, stage, page_count, text_source=None, exclude_provider=None):
    """Route explicit free-only jobs to confirmed free models, otherwise paid opt-in."""
    mode=DB.table("ai_import_jobs").select("provider_mode").eq(
        "id",job_id).single().execute().data
    if not mode:
        raise RuntimeError("Job not found")
    if mode.get("provider_mode")=="free_only":
        return FREE_ROUTER.call(
            pdf_bytes=pdf_bytes,prompt=prompt,schema=schema,job_id=job_id,
            stage=stage,page_count=page_count,text_source=text_source,
            exclude_provider=exclude_provider)
    if not ALLOW_PAID_OPENAI:
        raise ProvidersUnavailable("Paid OpenAI requests are disabled; select free-only provider mode.",21600)
    max_output_tokens = {
        "metadata": 1500, "extraction": 12000,
        "verification": 4500, "repair": 12000,
    }[stage]
    has_pdf = text_source is None
    content = [{"type":"input_text","text":prompt}]
    if has_pdf:
        encoded = base64.b64encode(pdf_bytes).decode("ascii")
        content.append({"type":"input_file","filename":"source-pages.pdf",
                        "file_data":"data:application/pdf;base64,"+encoded})
    else:
        content[0]["text"] += (
            "\n\nORIGINAL PDF SOURCE TEXT, pages are numbered and not paraphrased:\n"
            + text_source
        )

    effective_prompt = content[0]["text"]
    reserve = reserve_cost_usd(
        model,OPENAI_SERVICE_TIER,effective_prompt,page_count,has_pdf,
        max_output_tokens)
    balance = DB.table("ai_import_jobs").select(
        "budget_usd,api_spend_estimate_usd"
    ).eq("id",job_id).single().execute().data
    if not balance:
        raise RuntimeError("Job missing from cost ledger")
    assert_budget(balance["budget_usd"],balance["api_spend_estimate_usd"],reserve)

    LOG.info("AI request %s model=%s mode=%s expected_reserve_usd=%s",
             stage,model,"source-pdf" if has_pdf else "text-first",reserve)
    response = AI.responses.create(
        model=model,
        input=[{"role":"user","content":content}],
        text={"format":{"type":"json_schema","name":name,"strict":True,"schema":schema}},
        max_output_tokens=max_output_tokens,
        service_tier=OPENAI_SERVICE_TIER,
        store=False,
    )
    usage = response.usage
    if usage is None or response.id is None:
        raise RuntimeError("OpenAI response missing usage or response id; cannot safely account cost")
    cached = getattr(getattr(usage,"input_tokens_details",None),"cached_tokens",0) or 0
    tier = getattr(response,"service_tier",None) or OPENAI_SERVICE_TIER
    tier = "flex" if tier == "flex" else "standard"
    charged = usage_cost_usd(model,tier,usage.input_tokens,usage.output_tokens,cached)

    # Insert-once ledger (response_id unique) + database trigger updates job
    # totals atomically. The recorded amount is estimated from public token rates.
    DB.table("ai_import_api_calls").upsert({
        "job_id":job_id,
        "response_id":response.id,
        "stage":stage,
        "model":model,
        "service_tier":tier,
        "input_tokens":usage.input_tokens,
        "output_tokens":usage.output_tokens,
        "cached_input_tokens":cached,
        "estimated_cost_usd":str(charged),
    },on_conflict="response_id",ignore_duplicates=True).execute()
    LOG.info("AI accounted stage=%s model=%s tier=%s tokens=%s/%s estimated_usd=%s",
             stage,model,tier,usage.input_tokens,usage.output_tokens,charged)

    balance = DB.table("ai_import_jobs").select(
        "budget_usd,api_spend_estimate_usd"
    ).eq("id",job_id).single().execute().data
    if float(balance["api_spend_estimate_usd"]) >= float(balance["budget_usd"]):
        raise BudgetExceeded("Tracked API usage reached this book's selected budget.")
    raw = response.output_text
    if not raw:
        raise ValueError("AI returned empty response (usage already recorded)")
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
    if entries:
        entries = refine_duplicate_chapter_headings(document, entries)
        if entries: return finalize_sections(entries,pages), []
    # Never silently create fictitious chapter titles.
    return [dict(section_index=1,title="Unclassified questions",start_page=1,end_page=pages)], [
        {"type":"chapters_unverified","detail":
         "No reliable PDF bookmarks or chapter headings found. Chapter structure needs verification."}
    ]

def refine_duplicate_chapter_headings(document, entries):
    """A frontmatter chapter teaser is not a separate chapter when its number is
    repeated immediately before the MCQs begin. Keep the *real* heading."""
    result=[]
    def chapter_id(title):
        match=re.match(r"^\s*(?:chapter|ch\.|section)\s*(\d+)[a-z]?\b",title,re.I)
        return int(match.group(1)) if match else None
    for title, page in sorted(entries,key=lambda z:z[1]):
        if result:
            previous_title,previous_page=result[-1]
            same=chapter_id(title) is not None and chapter_id(title)==chapter_id(previous_title)
            near=0 < page-previous_page <= 2
            has_mcq=re.search(r"(?:^|\n)\s*(?:Question|Q)\s+\d+\s*[.):]",
                              document[previous_page-1].get_text(sort=True),re.I)
            if same and near and not has_mcq:
                result[-1]=(title,page)
                continue
        result.append((title,page))
    return result

def finalize_sections(entries,pages):
    result=[]
    for title,p in sorted(entries,key=lambda x:x[1]):
        if result and p <= result[-1]["start_page"]: continue
        if result: result[-1]["end_page"]=p-1
        result.append(dict(section_index=len(result)+1,title=title[:250],
                           start_page=p,end_page=pages))
    return result

def inspect_book_metadata(document,job_id):
    count=min(3,len(document))  # Groq vision supports at most 3 images per request
    mini=page_part(document,1,count)
    prompt="""Examine these original PDF pages (first page corresponds to original page 1).
Identify the real book title, preserving the exact printed title and edition, and
which page is the actual book cover or title page (1-based). Do not infer a title
from generic headers, ISBN-only or copyright-only pages. If no reliable title or
cover is visible set confidence='low', title='', coverPage=1,
titleEvidence=''. Only report 'high' when clearly printed on the selected page.
Return structured JSON."""
    return run_structured(mini,prompt,BOOK_SCHEMA,"quizard_book_metadata",MODEL,
                          job_id=job_id,stage="metadata",page_count=count)

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
    # Stage image bytes in PRIVATE bucket: never publish source figures before approval.
    if bucket != "ai_import_assets":
        raise ValueError("Only the private staging asset bucket is allowed")
    DB.storage.from_(bucket).upload(path,data,{"content-type":mime,"upsert":"true"})
    return "staging://" + bucket + "/" + path

def figure_layout(document, first, last):
    """Assign embedded raster figures to preceding numbered MCQ anchors in reading order.
    A source label near the image is required to classify question vs explanation.
    This permits adjacent-page figures and multiple questions on one PDF page.
    Returns image layout metadata only; no uploads or model calls.
    """
    anchors=[]
    images=[]
    qpat=re.compile(r"(?:^|\n)\s*(?:Question|Q)\s+(\d+)\s*[.):]",re.I)
    for page_number in range(first,last+1):
        page=document[page_number-1]
        blocks=[(fitz.Rect(b[:4]),str(b[4]).strip())
                for b in page.get_text("blocks") if len(b)>=5 and isinstance(b[4],str)]
        for rect,txt in blocks:
            m=qpat.search(txt)
            if m:
                anchors.append((page_number,rect.y0,int(m.group(1))))
        for xref,rect in detect_raster_figures(document,page_number):
            labels=[]
            for lr,txt in blocks:
                kind=None
                if re.fullmatch(r"Question Image",txt,re.I): kind="question"
                elif re.fullmatch(r"Explanation Image",txt,re.I): kind="explanation"
                if kind is not None:
                    gap=lr.y0-rect.y1
                    if -35<=gap<=65:
                        labels.append((abs(gap),kind))
            labels.sort()
            kind=None
            if len(labels)==1 or (len(labels)>1 and labels[0][0]+10<labels[1][0]):
                kind=labels[0][1]
            images.append((page_number,rect.y0,kind,xref,rect))
    mapped={}
    issues=[]
    ids=[a[2] for a in anchors]
    if len(set(ids))!=len(ids):
        issues.append({"type":"figure_anchor","detail":"Repeated MCQ number in PDF layout: cannot match images safely"})
        return {},issues
    for page_number,y0,kind,xref,rect in images:
        preceding=[a for a in anchors if a[0]<page_number or (a[0]==page_number and a[1]<=y0)]
        if not preceding:
            issues.append({"type":"figure_unmatched","page":page_number,
                           "detail":"Image appears before any question stem in this chapter"})
            continue
        owner=max(preceding,key=lambda a:(a[0],a[1]))[2]
        if kind is None:
            issues.append({"type":"figure_unclassified","page":page_number,"number":owner,
                           "detail":"No unambiguous Question Image/Explanation Image source label"})
            continue
        mapped.setdefault(owner,[]).append((kind,page_number,xref,rect))
    return mapped,issues


def upload_image(bucket,path,data,mime):
    # Stage image bytes in PRIVATE bucket: never publish source figures before approval.
    if bucket != "ai_import_assets":
        raise ValueError("Only the private staging asset bucket is allowed")
    DB.storage.from_(bucket).upload(path,data,{"content-type":mime,"upsert":"true"})
    return "staging://" + bucket + "/" + path


def attach_figures(document,job,section_index,questions,first,last):
    """Fail closed unless source geometry and labels provide a unique match."""
    mapped,issues=figure_layout(document,first,last)
    expected_numbers={q.get("questionNumber") for q in questions}
    for number in mapped:
        if number not in expected_numbers:
            issues.append({"type":"figure_unmatched","number":number,
                           "detail":"Image belongs to a PDF question not found in extracted JSON"})
    for q in questions:
        number=q.get("questionNumber")
        assigned=mapped.get(number,[])
        for kind,key,plural,single in (
            ("question","figureInQuestion","imageUrls","imageUrl"),
            ("explanation","figureInExplanation","explanationImageUrls","explanationImageUrl"),
        ):
            need=bool(q.get(key))
            candidates=[(p,x,r) for k,p,x,r in assigned if k==kind]
            if bool(candidates)!=need:
                issues.append({"type":"figure_mismatch","number":number,
                               "detail":f"PDF {kind} figure presence differs from AI extraction"})
                continue
            if not candidates:continue
            urls=[]
            for idx,(page_number,xref,rect) in enumerate(candidates,1):
                pix=document[page_number-1].get_pixmap(
                    matrix=fitz.Matrix(2,2),clip=rect,alpha=False)
                path=f"ai-import/{job['id']}/ch{section_index}/{number}{'q' if kind=='question' else 'e'}{idx}.png"
                urls.append(upload_image("ai_import_assets",path,pix.tobytes("png"),"image/png"))
            q[plural]=urls
            q[single]=urls[0]
    return issues


def normalize_mcq_options(q):
    """Quizard shows A/B/C itself. Remove only an entire sequential label set."""
    opts=q.get("options")
    if not isinstance(opts,list) or not (2<=len(opts)<=10):return
    matches=[re.match(r"^\s*([A-J])[\).:]\s+(.+)$",s,re.S) if isinstance(s,str) else None
             for s in opts]
    if all(matches) and all(m.group(1)==chr(65+i) for i,m in enumerate(matches)):
        q["options"]=[m.group(2).strip() for m in matches]


def to_json_question(q):
    normalize_mcq_options(q)
    return {k:q.get(k) for k in
            ("questionNumber","question","options","correctAnswerIndex","explanation",
             "imageUrl","imageUrls","explanationImageUrl","explanationImageUrls",
             "sourcePage","answerEvidence","figureInQuestion","figureInExplanation")}


def plan_mcq_batches(first,end,checkpoints,batch_pages):
    """Minimize model calls while preserving independently audited checkpoints.

    Never overwrite a previously verified range. New free-only books use three
    source pages per extraction/audit request, not one API round trip per page.
    Previously extracted non-empty ranges are preserved for separate audit.
    """
    if batch_pages<1 or first<1 or end<first:
        raise ValueError("Invalid MCQ batch range")
    plan=[]
    cursor=first
    while cursor<=end:
        saved=checkpoints.get(cursor)
        if (saved and saved.get("status") in ("verified","needs_review")
                and first<=int(saved["end_page"])<=end):
            finish=int(saved["end_page"])
        elif (saved and saved.get("status")=="extracted"
              and saved.get("questions")):
            finish=int(saved["end_page"])
        else:
            finish=min(end,cursor+batch_pages-1)
            for next_start in range(cursor+1,finish+1):
                upcoming=checkpoints.get(next_start)
                if upcoming and (
                    upcoming.get("status") in ("verified","needs_review")
                    or (upcoming.get("status")=="extracted" and upcoming.get("questions"))
                ):
                    finish=next_start-1
                    break
        if finish<cursor or finish>end:
            raise ValueError("Invalid checkpoint page range")
        plan.append((cursor,finish))
        cursor=finish+1
    return plan


def process_section(document,job,section,common_issues):
    job_id=job["id"]
    existing=DB.table("ai_import_sections").select("*").eq(
        "job_id",job_id).eq("section_index",section["section_index"]).execute().data
    if existing and existing[0]["status"] == "verified":
        return existing[0]

    # First-choice zero-token path: directly transcribe original selectable PDF
    # text, compare printed answer letters to option text and source figures,
    # and reject any incomplete or ambiguous MCQ. No AI call is made.
    if LOCAL_FIRST_ENABLED and job.get("provider_mode") == "free_only":
        first_page,end_page=section["start_page"],section["end_page"]
        update_job(job_id,progress_note=f"Local PDF extraction: pages {first_page}-{end_page}")
        local=extract_local_section(document,first_page,end_page)
        if local["strict_pass"] and local["questions"]:
            candidate=local["questions"]
            issues=[]
            for q in candidate:
                issues.extend({"type":"local_validation","number":q.get("questionNumber"),
                               "detail":problem} for problem in validate_question(
                                  q,first_page,end_page))
            # Keep identical figure-upload semantics and naming as existing
            # Quizard imports. A mismatch remains a review issue, never success.
            issues.extend(attach_figures(document,job,section["section_index"],
                                         candidate,first_page,end_page))
            issues.extend(common_issues)
            record={
                "job_id":job_id,"section_index":section["section_index"],
                "title":section["title"],"start_page":first_page,
                "end_page":end_page,
                "status":"needs_review" if issues else "verified",
                "questions":[to_json_question(q) for q in candidate],
                "issues":issues,
            }
            DB.table("ai_import_sections").upsert(
                record,on_conflict="job_id,section_index").execute()
            # A verified LOCAL chapter supersedes stale AI batch checkpoints
            # from interrupted previous runs. Never count old/new twice.
            DB.table("ai_import_batches").delete().eq("job_id",job_id).eq(
                "section_index",section["section_index"]).execute()
            DB.table("ai_import_batches").upsert({
                "job_id":job_id,"section_index":section["section_index"],
                "start_page":first_page,"end_page":end_page,
                "status":"needs_review" if issues else "verified",
                "questions":candidate,"issues":issues,
                "extraction_provider":"local_pdf",
                "updated_at":datetime.now(timezone.utc).isoformat(),
            },on_conflict="job_id,section_index,start_page").execute()
            update_job(job_id,processed_pages=end_page,
                       verified_questions=(len(candidate) if not issues else 0),
                       progress_note=(f"LOCAL source validation: "
                         f"{len(candidate) if not issues else 0}/{len(candidate)} "
                         f"verified MCQs in {local['elapsed_ms']} ms; "
                         "no AI tokens used for this chapter"))
            LOG.info("LOCAL PDF chapter job=%s chapter=%s questions=%s issues=%s duration_ms=%s",
                     job_id,section["section_index"],len(candidate),len(issues),
                     local["elapsed_ms"])
            return record
        LOG.info("LOCAL PDF fallback job=%s chapter=%s issues=%s anchors=%s",
                 job_id,section["section_index"],len(local["issues"]),
                 len(local["sourceQuestionNumbers"]))
        update_job(job_id,progress_note=(
            f"Source layout ambiguous ({len(local['issues'])} checks); "
            "using free AI for this chapter"))
    questions=[]; issues=[]
    first=section["start_page"]; end=section["end_page"]
    # Reuse only batches previously processed AND independently source-audited.
    # This prevents redundant AI calls after free-tier rate limit pauses.
    saved_batches=DB.table("ai_import_batches").select("*").eq(
        "job_id",job_id).eq("section_index",section["section_index"]).execute().data or []
    batch_checkpoints={int(row["start_page"]):row for row in saved_batches}
    # Gemini free Flash-Lite has a large 250K TPM allowance; one-page batches
    # created multiple sequential extraction + verification calls, causing
    # avoidable rate limits. Three pages per batch is also Groq's image ceiling.
    batch_pages = 3 if job.get("provider_mode") == "free_only" else PAGES_PER_BATCH
    for start,finish in plan_mcq_batches(first,end,batch_checkpoints,batch_pages):
        # The overlap helps finish an MCQ spanning the page boundary.
        extended_end=min(end,finish+1)
        old=batch_checkpoints.get(start)
        if old and int(old["end_page"])==finish and old["status"] in ("verified","needs_review"):
            cached=old.get("questions") or []
            if not isinstance(cached,list):raise ValueError("Corrupted saved batch checkpoint")
            questions.extend(cached)
            issues.extend(old.get("issues") or [])
            LOG.info("Reused saved MCQ audit checkpoint job=%s chapter=%s start_page=%s",
                     job_id,section["section_index"],start)
            continue
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
        text_source = safely_selectable_text(document,start,extended_end) if TEXT_FIRST_ENABLED else None
        if old and int(old["end_page"])==finish and old["status"]=="extracted":
            part=old.get("questions") or []
            if not isinstance(part,list):raise ValueError("Corrupted extraction checkpoint")
            extraction_provider=old.get("extraction_provider")
            if job.get("provider_mode")=="free_only" and not extraction_provider:
                raise ValueError("Extraction checkpoint lacks independent-audit provider identity")
            LOG.info("Reusing already extracted page %s (provider=%s) job=%s",
                     start,extraction_provider,job_id)
        else:
            update_job(job_id,progress_note=f"Extracting source page {start} of {end}")
            result=run_structured(mini,prompt,EXTRACTION_SCHEMA,"quizard_extract",MODEL,
                                  job_id=job_id,stage="extraction",
                                  page_count=extended_end-start+1,text_source=text_source)
            part=[q for q in result.get("questions",[]) if
                  isinstance(q.get("sourcePage"),int) and start <= q["sourcePage"] <= finish]
            extraction_provider=FREE_ROUTER.last_provider if job.get("provider_mode")=="free_only" else None
            # Persist extracted text BEFORE sending it to the independent AI.
            # Provider outage/timeout will not force us to re-spend extraction tokens.
            DB.table("ai_import_batches").upsert({
                "job_id":job_id,"section_index":section["section_index"],
                "start_page":start,"end_page":finish,"status":"extracted",
                "questions":part,"issues":[],"extraction_provider":extraction_provider,
                "updated_at":datetime.now(timezone.utc).isoformat(),
            },on_conflict="job_id,section_index,start_page").execute()
        update_job(job_id,progress_note=f"Checking source page {start} of {end} against the PDF")
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
                                 "quizard_source_audit",VERIFY_MODEL,
                                 job_id=job_id,stage="verification",
                                 page_count=extended_end-start+1,
                                 text_source=text_source,
                                 exclude_provider=extraction_provider)
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
                                    "quizard_repair",MODEL,
                                    job_id=job_id,stage="repair",
                                    page_count=extended_end-start+1,text_source=text_source)
            part=[q for q in repaired.get("questions",[]) if
                  isinstance(q.get("sourcePage"),int) and start <= q["sourcePage"] <= finish]
            extraction_provider=FREE_ROUTER.last_provider if job.get("provider_mode")=="free_only" else None
            batch_issues=audit_candidate(part)
            LOG.info("Re-audit %s pages %s-%s attempt %s: %s issues",
                     job_id,start,finish,attempt+1,len(batch_issues))
        # Persist each audited page batch BEFORE moving to the next provider call.
        # Failed chapters remain reviewable; retry does not silently discard text.
        checkpoint={
            "job_id":job_id,"section_index":section["section_index"],
            "start_page":start,"end_page":finish,
            "status":"needs_review" if batch_issues else "verified",
            "questions":part,"issues":batch_issues,
            "extraction_provider":extraction_provider,
            "updated_at":datetime.now(timezone.utc).isoformat(),
        }
        DB.table("ai_import_batches").upsert(
            checkpoint,on_conflict="job_id,section_index,start_page").execute()
        issues.extend(batch_issues)
        questions.extend(part)
        batch_checkpoints[start]=checkpoint
        verified_in_section=sum(
            len(b.get("questions") or []) for b in batch_checkpoints.values()
            if b.get("status")=="verified")
        update_job(job_id,processed_pages=finish,
                   verified_questions=verified_in_section,
                   progress_note=(f"Source-audited page {finish}/{end}; "+
                      f"{verified_in_section} verified questions in this chapter"+
                      (" (issues require review)" if batch_issues else "")),
                   worker_lock_at=datetime.now(timezone.utc).isoformat())
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
    issues.extend(attach_figures(document,job,section["section_index"],questions,first,end))
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

TEST_SPECIALTIES = {
    "surgery_test_book_1.pdf": "General Surgery",
    "surgery_test_book_2.pdf": "General Surgery",
    "gynecology_test_book_1.pdf": "Obstetrics & Gynecology - General",
    "gynecology_test_book_2.pdf": "Obstetrics & Gynecology - General",
}

def is_synthetic_test_job(job):
    return TEST_SPECIALTIES.get(job.get("file_name")) == job.get("speciality")

def copy_test_asset(job_id, staging_url, target_bucket, suffix):
    """Copy private source-derived images to Quizard's normal public buckets.
    Only called for the four synthetic book fixtures, never arbitrary user PDFs."""
    if not staging_url:
        return None
    if not isinstance(staging_url, str) or not staging_url.startswith(
        f"staging://ai_import_assets/ai-import/{job_id}/"
    ):
        raise ValueError("Unexpected private asset URL for test import")
    source_path = staging_url[len("staging://ai_import_assets/"):]
    content = DB.storage.from_("ai_import_assets").download(source_path)
    target_path = f"ai-test/{job_id}/{suffix}"
    DB.storage.from_(target_bucket).upload(
        target_path, content, {"content-type":"image/png","upsert":"true"})
    from urllib.parse import quote
    return URL.rstrip("/") + "/storage/v1/object/public/" + target_bucket + "/" + quote(target_path,safe="/")

def count_verified_questions(job_id):
    """Count independently audited questions even in partly reviewed chapters."""
    rows=DB.table("ai_import_batches").select("status,questions").eq(
        "job_id",job_id).eq("status","verified").execute().data or []
    return sum(len(row.get("questions") or []) for row in rows)


def synthetic_test_passes_quality_gate(records,review,total):
    """A four-MCQ smoke test is publishable only when fully source verified."""
    return (
        total==4
        and not review
        and len(records)==1
        and records[0].get("status")=="verified"
        and not records[0].get("issues")
        and len(records[0].get("questions") or [])==4
    )


def publish_synthetic_test_job(job,records,review,total,cover_staging_url):
    """End-to-end smoke test: real books, chapters, questions, cover and images.
    Database RPC enforces EXACTLY four pre-defined synthetic book names, one chapter
    and four MCQs; access_level='test' hides them from student dashboards and plans."""
    if not is_synthetic_test_job(job):
        return False
    job_id=job["id"]
    if not synthetic_test_passes_quality_gate(records,review,total):
        LOG.warning(
            "Test publication BLOCKED: job=%s extracted=%s review_issues=%s "
            "verified_chapters=%s (must be exactly 4/4 independently verified)",
            job_id,total,len(review),
            sum(r.get("status")=="verified" for r in records),
        )
        return False
    nonempty=records
    cover_public=copy_test_asset(job_id,cover_staging_url,"book_covers","cover.png")
    for record in nonempty:
        changed=False
        for q in record["questions"]:
            for singular, plural, typ in (
                ("imageUrl","imageUrls","question"),
                ("explanationImageUrl","explanationImageUrls","explanation")
            ):
                originals=q.get(plural) or ([q[singular]] if q.get(singular) else [])
                mapped=[]
                for index,url in enumerate(originals,1):
                    mapped.append(copy_test_asset(
                        job_id,url,"question_images",
                        f"ch{record['section_index']}/{q['questionNumber']}{typ}{index}.png"))
                if mapped:
                    q[singular]=mapped[0]
                    q[plural]=mapped
                    changed=True
        if changed:
            DB.table("ai_import_sections").update(
                {"questions":record["questions"]}).eq("id",record["id"]).execute() if record.get("id") else DB.table("ai_import_sections").update(
                {"questions":record["questions"]}).eq("job_id",job_id).eq(
                "section_index",record["section_index"]).execute()
    response=DB.rpc("ai_publish_test_import",{"p_job_id":job_id,
                                                "p_cover_url":cover_public}).execute()
    LOG.info("Test-published job %s to Quizard book %s; source review issues: %d",
             job_id,response.data,len(review))
    return True

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
        if pages > MAX_PAGES_PER_JOB:
            raise ValueError(f"Pilot safety limit: {pages} pages exceeds {MAX_PAGES_PER_JOB}. Raise MAX_PAGES_PER_JOB after acceptance testing.")
        update_job(job_id,total_pages=pages,
                   progress_note="Loading existing checkpoints and preparing source pages")
        job["total_pages"]=pages
        sections,global_issues=find_sections(document)
        if len(sections)<1:raise ValueError("No sections detected")
        meta_row=DB.table("ai_import_jobs").select("book_metadata").eq(
            "id",job_id).single().execute().data or {}
        metadata=meta_row.get("book_metadata")
        if not isinstance(metadata,dict) or not all(
            k in metadata for k in ("title","coverPage","titleEvidence","confidence")
        ):
            metadata = (
                local_book_metadata(document)
                if LOCAL_FIRST_ENABLED and job.get("provider_mode")=="free_only"
                else None
            )
            if metadata:
                LOG.info("LOCAL PDF metadata recognized job=%s title=%s",
                         job_id,metadata["title"])
            else:
                metadata=inspect_book_metadata(document,job_id)
            update_job(job_id,book_metadata=metadata)
        else:
            LOG.info("Reused validated book title metadata checkpoint job=%s",job_id)
        cover_page=metadata.get("coverPage",1)
        if not isinstance(cover_page,int) or not 1 <= cover_page <= min(5,pages):
            cover_page=1
            global_issues.append({"type":"cover","detail":"AI-selected cover page was invalid"})
        if metadata.get("confidence")!="high" or not clean(metadata.get("titleEvidence")):
            global_issues.append({"type":"book_metadata","detail":"Book cover/title not unambiguously identified"})
        else:
            title=clean(metadata.get("title"))
            if title and len(title)<300: update_job(job_id,title_hint=title)
        # Reuse source-derived cover if already staged during a previous attempt.
        # No artificial covers, and no repeated cover uploads after quota pause.
        cover_row=DB.table("ai_import_jobs").select("cover_url").eq(
            "id",job_id).single().execute().data or {}
        cover_url=cover_row.get("cover_url")
        if not cover_url:
            cover=document[cover_page-1].get_pixmap(matrix=fitz.Matrix(1.3,1.3),alpha=False)
            cover_bytes=cover.tobytes("png")
            cover_url=upload_image(
                "ai_import_assets",f"ai-import/{job_id}/cover.png",cover_bytes,"image/png")
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
            verified=count_verified_questions(job_id)
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
                   total_questions=total,verified_questions=count_verified_questions(job_id),
                   processed_pages=pages)
        # The user explicitly requested an end-to-end multi-book test.
        # Only the four named synthetic fixtures can enter the test-only publisher.
        # Real books remain in private staging until a separately reviewed release.
        test_published=publish_synthetic_test_job(job,records,review,total,cover_url)
        LOG.info("Job %s: %s; %s questions; %d review issues",
                 job_id, "test_published" if test_published else
                 ("needs_review" if review else "ready"),total,len(review))
    finally:
        document.close()

def normalize_claimed_job(data):
    """PostgREST represents an empty composite return as a row with null fields."""
    if isinstance(data, list):
        data = next((item for item in data if isinstance(item, dict) and item.get("id")), None)
    if not isinstance(data, dict) or not data.get("id"):
        return None
    return data


def main():
    LOG.info("Quizard importer running. Extraction=%s, verification=%s",MODEL,VERIFY_MODEL)
    while True:
        try:
            result=DB.rpc("ai_claim_import_job").execute()
            job=normalize_claimed_job(result.data)
            if job is None:
                if RUN_ONCE:
                    LOG.info("Queue empty; scheduled worker exiting cleanly")
                    return
                time.sleep(POLL_SECONDS)
                continue
            try:
                process_job(job)
            except Exception as exc:
                LOG.error("Failed job %s: %s\n%s",job["id"],exc,traceback.format_exc())
                if isinstance(exc,BudgetExceeded):
                    update_job(job["id"],status="paused_budget",last_error=str(exc)[:2000])
                    continue
                if isinstance(exc,ProvidersUnavailable):
                    update_job(job["id"],status="waiting_provider",
                        next_attempt_at=(datetime.now(timezone.utc)+
                                         __import__("datetime").timedelta(seconds=exc.retry_seconds)).isoformat(),
                        last_error=str(exc)[:500])
                    continue
                quota_exhausted=(
                    isinstance(exc,RateLimitError)
                    and ('credit_balance_exhausted' in str(exc) or 'insufficient_quota' in str(exc))
                )
                transient=not quota_exhausted and isinstance(exc,(
                    APIConnectionError,APITimeoutError,RateLimitError,InternalServerError))
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
