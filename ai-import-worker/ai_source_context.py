"""Plan source-grounded OpenAI MCQ requests with BOTH question and answer pages.

Only finds page boundaries and printed question numbers. No question, answer,
explanation, or medical content is inferred or transcribed here: OpenAI handles
source content. Missing evidence remains reviewable, never fabricated.

Compatible with any independently identified question/answer section whose
numbered entries can be anchored. Does not require a particular publisher name.
"""
from __future__ import annotations
from paired_mcq import _lines, _heading_entries


def _anchors(document, first, last, *, answer_section):
    rows = [line for p in range(first, last + 1)
            for line in _lines(document[p - 1], p)]
    entries = _heading_entries(rows, answer_section=answer_section)
    result = []
    seen = set()
    for idx, number, _ in entries:
        page = rows[idx][0]
        if number in seen:
            raise ValueError(f"Duplicate printed {'answer' if answer_section else 'question'} number {number}")
        seen.add(number)
        result.append((page, int(number)))
    return result


def paired_source_batches(document, section, question_page_batch=3):
    """Return separate original source pages for joint OpenAI reading.

    Each candidate is indexed by the PDF page where its QUESTION begins.
    All associated answer pages up to the next answer anchor are included
    (inclusive of that anchor page for a multi-column continuation).
    Source pages may be repeated across requests; each question number is
    assigned to exactly one batch. Report all unresolved anchors.
    """
    qfirst = int(section["question_start"])
    qlast = int(section["question_end"])
    afirst = int(section["answer_start"])
    alast = int(section["answer_end"])
    if not (1 <= qfirst <= qlast < afirst <= alast <= len(document)):
        raise ValueError("Invalid or overlapping question and answer page ranges")
    if not 1 <= question_page_batch <= 8:
        raise ValueError("Invalid question-page batch size")

    questions = _anchors(document, qfirst, qlast, answer_section=False)
    answers = _anchors(document, afirst, alast, answer_section=True)
    if not questions:
        return [], [{"type":"unindexed_question_pages",
                      "detail":"No source-numbered questions could be indexed; needs review"}]
    if not answers:
        return [], [{"type":"unindexed_answer_pages",
                      "detail":"No printed answer headings could be indexed; needs review"}]

    answer_map = {number:(page,index) for index,(page,number) in enumerate(answers)}
    result=[]
    issues=[]
    covered=set()
    for start in range(qfirst, qlast+1, question_page_batch):
        finish=min(qlast,start+question_page_batch-1)
        targets=[(page,number) for page,number in questions
                 if start <= page <= finish]
        if not targets:
            continue
        numbers=[number for _,number in targets]
        if any(number in covered for number in numbers):
            raise ValueError("Duplicate source question across batches")
        covered.update(numbers)
        # Include the last page of the extraction window plus one continuation
        # page for a question whose stem spans a page boundary. Exclude questions
        # starting outside the window in the extraction prompt.
        question_pages=set(range(start,min(qlast,finish+1)+1))
        answer_pages=set()
        missing=[]
        for _,num in targets:
            found=answer_map.get(num)
            if found is None:
                missing.append(num)
                continue
            page,index=found
            next_page=(answers[index+1][0]
                       if index+1 < len(answers) else alast)
            answer_pages.update(range(page,min(alast,next_page)+1))
        unique_pages=sorted(question_pages | answer_pages)
        if missing:
            issues.append({"type":"missing_answer_page_anchor",
                           "numbers":missing,"pages":[start,finish]})
        result.append({
            "start":start,"finish":finish,
            "numbers":numbers,
            "question_pages":sorted(question_pages),
            "answer_pages":sorted(answer_pages),
            "pages":unique_pages,
            "page_label":", ".join(
                f"attached page {i} = original PDF page {num} ({'QUESTIONS' if num in question_pages else 'ANSWERS'})"
                for i,num in enumerate(unique_pages,1)),
        })
    return result,issues
