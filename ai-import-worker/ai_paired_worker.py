"""OpenAI-only extraction of separate question and answer sections.

Every transcription and answer choice comes from an OpenAI call supplied with
BOTH the original question pages and the corresponding original answer pages.
The geometry-based planner only selects document pages and question numbers.
No book title or publisher-specific wording is required by this processor.
No automatic repair loops: unresolved evidence remains private for review.
"""
from __future__ import annotations
from collections import Counter
from datetime import datetime, timezone
import json
import fitz

from ai_source_context import paired_source_batches

PROCESSOR_VERSION = "openai_paired_v1"


def _selected_pdf(document, pages):
    part = fitz.open()
    for p in pages:
        part.insert_pdf(document, from_page=p - 1, to_page=p - 1)
    payload = part.tobytes(garbage=4, deflate=True)
    part.close()
    return payload


def process_paired_openai_section(
        document, job, section, common_issues, *,
        db, run_structured, update_job, attach_figures, validate_question,
        to_json_question, model, verify_model, extraction_schema,
        verification_schema, pages_per_batch=3):
    job_id = job["id"]
    chapter = section["section_index"]
    first, last = section["start_page"], section["end_page"]
    batches, planning_issues = paired_source_batches(
        document, section, question_page_batch=pages_per_batch)
    issues = list(common_issues or []) + list(planning_issues)
    questions = []
    if not batches:
        issues.append({"type":"cannot_identify_question_answer_pages",
            "detail":"Question and answer page anchors were not verifiable; no AI answers inferred"})
    for batch in batches:
        start, finish = batch["start"],batch["finish"]
        previous = db.table("ai_import_batches").select("*").eq(
            "job_id",job_id).eq("section_index",chapter).eq(
            "start_page",start).execute().data or []
        old=next((x for x in previous
                  if x.get("extraction_provider")==PROCESSOR_VERSION and
                     x.get("status") in ("verified","needs_review") and
                     int(x["end_page"])==finish),None)
        if old:
            questions.extend(old.get("questions") or [])
            issues.extend(old.get("issues") or [])
            continue

        targets = batch["numbers"]
        if not targets:
            continue
        if not batch["answer_pages"]:
            # Do not send OpenAI a question-only PDF to elicit nonexistent
            # explanations. This was the root cause of the previous 91 calls.
            batch_issues=[{"type":"missing_answer_context","numbers":targets,
                "detail":"Printed answer source pages could not be linked"}]
            candidates=[]
        else:
            payload=_selected_pdf(document,batch["pages"])
            mapping=batch["page_label"]
            permitted=", ".join(str(x) for x in targets)
            extract_prompt=f"""Transcribe printed medical multiple choice questions
from this ORIGINAL PDF excerpt, strictly as source text, not by solving medicine.

ORIGINAL DOCUMENT PAGE MAP:
{mapping}

Target printed QUESTION NUMBERS: {permitted}
Question starts are on ORIGINAL source pages {start} through {finish}.
The attached PDF includes some later ANSWER and explanation pages matched by
printed question number. These answer entries are NOT new MCQs.
Only output questions listed in target numbers. Each source question number
must occur at most once in the JSON output; do not include unrelated questions
that appear on overlap pages.

Exact transcription: preserve the complete stem, option order, units, numerical
values, tables (simple HTML), answer index 0-based, and printed explanation.
Do not paraphrase, solve medically, infer answers, or invent missing text.
If a printed answer/explanation is not identifiable for a given question, use
correctAnswerIndex=-1, explanation="", answerEvidence="".
answerEvidence must quote the printed answer key and identify its original
ANSWER PDF page. sourcePage is the original PDF page where the QUESTION starts
(as mapped above, NOT the attached excerpt's page number).
Indicate whether question or explanation contains a figure; never invent media.
If a full question is not present or readable, omit it; the independent audit
will report its missing source number for human review.
Return only JSON conforming to the given schema."""
            update_job(job_id,progress_note=(
                f"OpenAI reading original question pages {start}-{finish} "
                f"and their matching answer pages; no automatic repairs"))
            extraction=run_structured(
                payload,extract_prompt,extraction_schema,"quizard_paired_mcqs",
                model,job_id=job_id,stage="extraction",
                page_count=len(batch["pages"]),text_source=None)
            returned=extraction.get("questions") or []
            candidates=[]
            batch_issues=[]
            requested=set(targets)
            for q in returned:
                if not isinstance(q,dict) or q.get("questionNumber") not in requested:
                    batch_issues.append({"type":"non_source_question",
                                         "detail":"OpenAI returned an unrequested question number"})
                    continue
                candidates.append(q)
            actual=[q.get("questionNumber") for q in candidates]
            if Counter(actual)!=Counter(targets):
                batch_issues.append({
                    "type":"source_question_completeness",
                    "detail":"Printed question numbers differ from AI extraction",
                    "source":targets,"extracted":actual,"pages":[start,finish]})
            for q in candidates:
                validations=validate_question(q,first,last)
                if validations:
                    batch_issues.append({"type":"source_validation",
                        "number":q.get("questionNumber"),
                        "detail":"; ".join(validations)})
            # A single independent OpenAI pass, after both source sections
            # are included. A failed audit is manual review, not 2 repair
            # passes and 3 repeated audit calls.
            if candidates:
                audit_prompt=f"""Independently verify the proposed MCQs against
BOTH original QUESTION and ANSWER pages in the attached PDF. Do not use
medical knowledge to infer source answers.
ORIGINAL DOCUMENT PAGE MAP:
{mapping}
Only the TARGET printed question numbers {permitted} matter.
Enumerate those target numbers visible as QUESTION stems, excluding
ANSWER headings and overlap-page questions outside the target set.
Compare each proposed stem, options, correct index, printed explanation,
answerEvidence, sourcePage and source figure presence against BOTH source
sections. Flag incorrect transcription, missing options or explanation,
answer-number mismatches, figures, and unsupported facts.
Do not mark a candidate correct merely because its medical answer is plausible.
Return the complete source question-number list and specific discrepancies.
Candidate JSON:
{json.dumps(candidates,ensure_ascii=False)}"""
                audit=run_structured(
                    payload,audit_prompt,verification_schema,
                    "quizard_paired_audit",verify_model,
                    job_id=job_id,stage="verification",
                    page_count=len(batch["pages"]),text_source=None)
                source_numbers=audit.get("questionNumbersInSource") or []
                if Counter(source_numbers)!=Counter(targets):
                    batch_issues.append({"type":"auditor_source_mismatch",
                        "detail":"Source auditor failed to confirm all target question numbers",
                        "source":targets,"auditor":source_numbers})
                for item in audit.get("issues") or []:
                    batch_issues.append({
                        "type":"independent_source_audit",
                        "number":item.get("number"),
                        "detail":str(item.get("detail",""))[:1200]})
        checkpoint={
            "job_id":job_id,"section_index":chapter,
            "start_page":start,"end_page":finish,
            "status":"needs_review" if batch_issues else "verified",
            "questions":candidates,"issues":batch_issues,
            "extraction_provider":PROCESSOR_VERSION,
            "updated_at":datetime.now(timezone.utc).isoformat(),
        }
        db.table("ai_import_batches").upsert(
            checkpoint,on_conflict="job_id,section_index,start_page").execute()
        questions.extend(candidates)
        issues.extend(batch_issues)
        update_job(job_id,progress_note=(
            f"Joint question/answer source review completed PDF question "
            f"pages {start}-{finish}; {len(candidates)} candidates in batch"))
    number_list=[q.get("questionNumber") for q in questions]
    if len(number_list)!=len(set(number_list)):
        issues.append({"type":"duplicate_question_across_batches",
                       "detail":"The same source question number appeared in multiple batches"})
    if questions:
        issues.extend(attach_figures(document,job,chapter,questions,first,last))
    if not questions:
        issues.append({"type":"no_paired_mcqs",
                       "detail":"No complete source-grounded MCQs available for review"})
    # Do not label all candidates verified just because one batch succeeded.
    verified = not issues
    result={
        "job_id":job_id,"section_index":chapter,"title":section["title"],
        "start_page":first,"end_page":last,
        "status":"verified" if verified else "needs_review",
        "questions":[to_json_question(q) for q in questions],
        "issues":issues,
    }
    db.table("ai_import_sections").upsert(
        result,on_conflict="job_id,section_index").execute()
    return result
