"""Conservative no-API MCQ extraction from selectable-text PDFs.

Only unambiguous layouts with printed answer keys qualify for automatic local
validation. Any uncertainty returns issues and should use an AI fallback or
human review. Never solve a medical question or invent an explanation.
"""
from __future__ import annotations
import re
import time
from collections import Counter

# Named anchors are reliable; bare numeric anchors need nearby option labels.
Q = re.compile(r'^\s*(?:Question|Q(?:uestion)?\.?|MCQ)\s*#?\s*(\d+)(?:\s*[.):\-]\s*|\s*$)(.*)$', re.I)
NUMBERED_Q = re.compile(r'^\s*(\d{1,5})\s*[.)]\s+(\S.*)$')
OPT = re.compile(r'^\s*(?:\(([A-J])\)|([A-J])\s*[.):])\s*(\S.*)$', re.I)
KEY = re.compile(r'^\s*(?:Correct\s+(?:Answer|Option|Choice)(?:\s+is)?|Answer\s+Key|Answer|Ans\.?|Key)\s*(?::|is|-)\s*\(?([A-J])\)?(?:[.)\s:-]+(.*))?$', re.I)
EXPL = re.compile(r'^\s*(?:(?:Explanation|Rationale|Discussion|Commentary|Teaching\s+Point)(?::\s*(.*))?|Critique(?:\s*:\s*(.*))?)\s*$', re.I)
IMARK = re.compile(r'^\s*(Question|Explanation)\s+Image\s*$', re.I)
FIGCAP = re.compile(r'^\s*Figure\s+\d+\s*[.):]?\s*$', re.I)
REFS = re.compile(r'^\s*References\s*:?\s*$', re.I)


def join_source(lines):
    """Join wrapped PDF lines without changing their wording or answer text."""
    return ' '.join(s.strip() for s in lines if s.strip()).strip()


import fitz
from separated_key_mcq import (
    is_separated_key_section, extract_separated_key_section,
    separated_key_figure_layout, has_separate_answer_marker
)
from paired_mcq import pair_ranges,extract_pairs,paired_figure_layout

def _question_starts(lines):
    """Find named anchors plus conservative numbered MCQs, never bibliography lists.

    An unlabeled number is an MCQ only if *two consecutive options* and a
    printed answer marker occur before the next numbered/named anchor.
    Without these, the source remains a manual-review case.
    """
    result=[]
    for idx,(page,line) in enumerate(lines):
        named=Q.match(line)
        if named:
            result.append((idx,page,int(named.group(1)),named.group(2)))
            continue
        numeric=NUMBERED_Q.match(line)
        if not numeric:
            continue
        # Guard against citations, contents pages and numbered explanations.
        # Looking ahead only to the next possible heading prevents borrowing
        # the options/answer of the next actual question.
        seen=[]
        key=False
        for _page,look in lines[idx+1:idx+65]:
            if Q.match(look) or NUMBERED_Q.match(look):
                break
            opt=OPT.match(look)
            if opt:
                label=(opt.group(1) or opt.group(2)).upper()
                seen.append(label)
            if KEY.match(look):
                key=True
        if len(seen)>=2 and seen[:2]==['A','B'] and key:
            result.append((idx,page,int(numeric.group(1)),numeric.group(2)))
    return result


def partition_long_sections(document, sections, max_pages=32):
    """Create resumable page ranges from long chapters.

    Prefer a new numbered/question anchor near the top of a PDF page.
    When no clean boundary exists, force a page split but flag adjacent
    fragments; never auto-verify a question spanning such a boundary.
    """
    if max_pages<4:
        raise ValueError('max_pages must be at least 4')
    result=[]
    for section in sections:
        first,last=int(section['start_page']),int(section['end_page'])
        if section.get('answer_start') and section.get('question_start'):
            record=dict(section)
            record['section_index']=len(result)+1
            record['boundary_issues']=[]
            result.append(record)
            continue
        # A separate printed answer section belongs to the same chapter.
        # Never split its questions away from their answer key. For chapters
        # beyond 200 pages, retain conservative boundaries for manual review.
        if (last-first+1 <= 200 and
                has_separate_answer_marker(document,first,last)):
            record=dict(section)
            record['section_index']=len(result)+1
            record['boundary_issues']=list(record.get('boundary_issues') or [])
            result.append(record)
            continue
        start=first
        cuts=[]
        for page in range(first+1,last+1):
            lines=[x.strip() for x in document[page-1].get_text('text',sort=True).splitlines()
                   if x.strip()]
            if lines and (Q.match(lines[0]) or
                          _question_starts([(page,x) for x in lines[:32]])[:1]
                          and NUMBERED_Q.match(lines[0])):
                cuts.append(page)
        fragments=[]
        while last-start+1>max_pages:
            allowable=[p for p in cuts if start+4<=p<=start+max_pages]
            if allowable:
                boundary=max(allowable)
                forced=False
            else:
                boundary=start+max_pages
                forced=True
            fragments.append((start,boundary-1,forced))
            start=boundary
        fragments.append((start,last,False))
        for i,(a,b,forced) in enumerate(fragments):
            record=dict(section)
            record['start_page']=a
            record['end_page']=b
            if len(fragments)>1:
                record['title']=section['title']+f' (part {i+1})'
            flags=list(record.get('boundary_issues') or [])
            if forced or (i>0 and fragments[i-1][2]):
                flags.append({
                    'type':'unverified_page_boundary',
                    'detail':'Long chapter was split at a page without a clean question anchor; check adjacent pages',
                    'pages':[max(first,a-1), min(last,b+1)]
                })
            record['boundary_issues']=flags
            record['section_index']=len(result)+1
            result.append(record)
    return result


def layout_figures(document, first, last, include_rects=False):
    """Match source-labeled figures to MCQs across pages, ignoring cover artwork.

    A nearby printed figure caption is required. A generic image inside an
    MCQ that cannot be attributed remains a review issue. The shared geometry
    is used by the validator and private-staging image uploader.
    """
    paired=next((s for s in pair_ranges(document)
                 if s['start_page']==first and s['end_page']==last),None)
    if paired:
        mapped,issues=paired_figure_layout(document,paired,[
            {'questionNumber':num} for num in range(1,201)
        ],True)
        return (mapped,issues) if include_rects else (
            {num:[kind for kind,_,_,_ in values]
             for num,values in mapped.items()},issues)
    if is_separated_key_section(document,first,last):
        return separated_key_figure_layout(
            document,first,last,include_rects=include_rects)
    anchors, labels, images, issues = [], [], [], []
    # Reuse the same conservative anchor scan used by question extraction,
    # including numbered headings only when a printed answer key exists.
    accepted_numeric = {(page,number) for idx,page,number,_ in
                        _question_starts(_read_lines(document,first,last))}
    state = 'stem'
    for pno in range(first, last + 1):
        page = document[pno-1]
        blocks = sorted(
            [(fitz.Rect(b[:4]), str(b[4]).strip()) for b in page.get_text('blocks')
             if len(b) > 4 and isinstance(b[4], str)],
            key=lambda item: (item[0].y0, item[0].x0)
        )
        for box, txt in blocks:
            for line in txt.splitlines():
                line = line.strip()
                m = Q.match(line)
                bare = NUMBERED_Q.match(line) if not m else None
                if m or (bare and (pno, int(bare.group(1))) in accepted_numeric):
                    anchors.append((pno, box.y0, int((m or bare).group(1))))
                    state = 'stem'
                elif KEY.match(line):
                    state = 'answer'
                elif (m := IMARK.fullmatch(line)):
                    labels.append((pno, box, m.group(1).lower(), 'marker'))
                elif EXPL.match(line):
                    state = 'explanation'
                elif REFS.fullmatch(line):
                    state = 'references'
                elif FIGCAP.fullmatch(line):
                    kind = ('question' if state in ('stem', 'options') else
                            'explanation' if state in ('answer', 'explanation') else None)
                    labels.append((pno, box, kind, 'caption'))
                elif OPT.match(line) and state == 'stem':
                    state = 'options'
        seen = set()
        for spec in page.get_images(full=True):
            xref = spec[0]
            for rect in page.get_image_rects(xref):
                if rect.width < 90 or rect.height < 70:
                    continue
                key = (xref, round(rect.x0), round(rect.y0))
                if key in seen:
                    continue
                seen.add(key)
                images.append((pno, rect.y0, rect, xref))
    if len({a[2] for a in anchors}) != len(anchors):
        return {}, [{'type': 'duplicate_anchor',
                     'detail': 'Duplicate question anchors in original PDF'}]
    result = {}
    for pno, y, rect, xref in images:
        preceding = [a for a in anchors if (a[0], a[1]) <= (pno, y)]
        if not preceding:
            continue  # Front matter and chapter cover artwork are not MCQ images.
        candidates = []
        for lpno, box, kind, style in labels:
            if lpno != pno or not kind:
                continue
            gap = (rect.y0 - box.y1 if style == 'caption'
                   else box.y0 - rect.y1)
            if ((0 <= gap <= 65) if style == 'caption'
                    else (-35 <= gap <= 65)):
                candidates.append((abs(gap), kind))
        candidates.sort()
        if not candidates or (len(candidates) > 1 and
                              candidates[0][0] + 10 >= candidates[1][0]):
            issues.append({
                'type': 'unclassified_image', 'page': pno,
                'detail': 'MCQ image lacks a uniquely attributable source label'
            })
            continue
        kind = candidates[0][1]
        val = ((kind, pno, xref, rect) if include_rects else kind)
        result.setdefault(max(preceding)[2], []).append(val)
    return result, issues


def _read_lines(document, first, last):
    lines = []
    for pno in range(first,last+1):
        page = document[pno-1]
        for line in page.get_text('text',sort=True).splitlines():
            text = line.strip()
            if text:
                lines.append((pno,text))
    return lines


def extract_local_section(document, first, last):
    """Return schema-compatible questions and auditable blocking issues.

    Local success is strict: every source question has complete options, a
    printed answer consistent with the selected option, an explanation, and
    unambiguous labeled figures. Ambiguous chapters go to the AI fallback.
    """
    start = time.monotonic()
    if not (1<=first<=last<=len(document)):
        raise ValueError('Invalid 1-based PDF page range')
    paired=next((s for s in pair_ranges(document)
                 if s['start_page']==first and s['end_page']==last),None)
    if paired:
        result=extract_pairs(document,paired)
        if result is not None:
            return result
    separated=extract_separated_key_section(document,first,last)
    if separated is not None:
        return separated
    lines = _read_lines(document,first,last)
    issues = []
    starts = [(idx,page,number,text) for idx,page,number,text in _question_starts(lines)]
    if not starts:
        return {'questions':[], 'issues':[{'type':'no_question_anchors',
                'detail':'No explicit numbered MCQ anchors in selectable PDF text'}],
                'sourceQuestionNumbers':[], 'strict_pass':False,
                'elapsed_ms':round((time.monotonic()-start)*1000,2)}
    ids = [q for _,_,q,_ in starts]
    if len(set(ids)) != len(ids):
        issues.append({'type':'duplicate_question_number', 'sourceNumbers':ids})
    if len(ids)>1 and any(b!=a+1 for a,b in zip(ids,ids[1:])):
        issues.append({'type':'nonconsecutive_question_numbers','sourceNumbers':ids})
    figures, figure_issues = layout_figures(document,first,last)
    issues.extend(figure_issues)
    questions = []
    for j,(idx,pno,number,first_line_text) in enumerate(starts):
        end = starts[j+1][0] if j+1 < len(starts) else len(lines)
        raw = lines[idx:end]
        q_line = first_line_text
        stem = [q_line] if q_line else []
        options, opt_labels, explanation = [], [], []
        answer_index, answer_evidence, answer_text = -1, '', ''
        markers=[]
        state='stem'
        for page,line in raw[1:]:
            if REFS.fullmatch(line):
                state = 'references'
                continue
            if state == 'references':
                continue
            mark = IMARK.fullmatch(line)
            if mark:
                markers.append(mark.group(1).lower())
                continue
            if FIGCAP.fullmatch(line):
                markers.append('explanation' if state in ('answer', 'explanation')
                               else 'question')
                continue
            m_opt = OPT.match(line)
            m_key = KEY.match(line)
            m_expl = EXPL.match(line)
            if m_key:
                if answer_evidence:
                    issues.append({'type':'duplicate_answer','number':number,'page':page})
                answer_evidence=line
                answer_index=ord(m_key.group(1).upper())-65
                answer_text=(m_key.group(2) or '').strip()
                state='answer'
            elif m_expl:
                explanation.append(next((g for g in m_expl.groups() if g is not None), ''))
                state='explanation'
            elif m_opt and state in ('stem','options'):
                opt_labels.append((m_opt.group(1) or m_opt.group(2)).upper())
                options.append([m_opt.group(3)])
                state='options'
            elif state=='stem':
                stem.append(line)
            elif state=='options' and options:
                options[-1].append(line)
            elif state=='explanation':
                explanation.append(line)
            elif state=='answer':
                issues.append({'type':'unexpected_after_answer','number':number,
                               'page':page,'detail':line[:100]})
            else:
                issues.append({'type':'unclassified_line','number':number,
                               'page':page,'detail':line[:100]})
        stem_text=join_source(stem)
        option_texts=[join_source(o) for o in options]
        explanation_text=join_source(explanation)
        if len(stem_text)<8:
            issues.append({'type':'missing_stem','number':number})
        if len(options)<2 or len(options)>10 or any(not x for x in option_texts):
            issues.append({'type':'invalid_options','number':number})
        if opt_labels!=[chr(65+k) for k in range(len(opt_labels))]:
            issues.append({'type':'option_order','number':number,'labels':opt_labels})
        if not 0<=answer_index<len(options):
            issues.append({'type':'no_printed_answer','number':number})
        if answer_text and (not 0<=answer_index<len(options) or
                re.sub(r'\s+',' ',answer_text).casefold()!=
                re.sub(r'\s+',' ',option_texts[answer_index]).casefold()):
            issues.append({'type':'answer_option_mismatch','number':number,
                           'detail':'Printed answer text does not match option at printed letter'})
        if not explanation_text:
            issues.append({'type':'no_printed_explanation','number':number})
        if 'critique will display after all linked items' in explanation_text.casefold():
            issues.append({'type':'linked_critique_not_provided','number':number,
                           'detail':'Source PDF contains only a linked-item critique placeholder'})
        image_kinds=figures.get(number,[])
        if Counter(markers)!=Counter(image_kinds):
            issues.append({'type':'figure_label_mismatch','number':number,
                           'detail':'Question/explanation image labels differ from embedded figure layout'})
        questions.append({
            'questionNumber':number,'sourcePage':pno,'question':stem_text,
            'options':option_texts,'correctAnswerIndex':answer_index,
            'explanation':explanation_text,'answerEvidence':answer_evidence,
            'figureInQuestion':'question' in image_kinds,
            'figureInExplanation':'explanation' in image_kinds,
        })
    return {'questions':questions,'issues':issues,'sourceQuestionNumbers':ids,
            'strict_pass':not issues,'elapsed_ms':round((time.monotonic()-start)*1000,2)}


def diagnose_empty_mcq_source(document):
    """Explain zero-MCQ results without claiming there are no questions in a book.

    Text-based reference books, unsupported answer-key layouts, and scanned
    images require different next steps. Diagnostics are non-publishing
    metadata and do not fabricate candidate questions.
    """
    pages = len(document)
    selectable_pages = 0
    total_characters = 0
    for page in document:
        text = page.get_text("text").strip()
        total_characters += len(text)
        if len(text) >= 40:
            selectable_pages += 1
    scanned = (selectable_pages < max(2, pages // 10))
    if scanned:
        return {
            "type": "no_selectable_mcq_text",
            "detail": (
                "No extractable MCQs were found, and most PDF pages lack "
                "selectable text. The document may be scanned or image-only; "
                "check the original pages and add OCR before reprocessing."
            ),
            "selectable_text_pages": selectable_pages,
            "total_pages": pages,
            "extracted_characters": total_characters,
        }
    return {
        "type": "no_supported_mcq_structure",
        "detail": (
            "No recognizable MCQ structure with printed question stems, "
            "options and answers was extracted. This may be a reference "
            "textbook rather than a question bank, or a question book with "
            "an unsupported layout/separate answer keys. Examine the PDF. "
            "Retrying the same PDF unchanged will not produce questions."
        ),
        "selectable_text_pages": selectable_pages,
        "total_pages": pages,
        "extracted_characters": total_characters,
    }


def classify_local_questions(questions, issues):
    """Classify each source-transcribed question without an AI call.

    A question passes only if all PDF validation checks passed for that number.
    Unnumbered layout or completeness issues block ALL questions in the section.
    The output is audit metadata, not a permission to publish a whole book.
    """
    global_blockers = [issue for issue in issues
                       if not isinstance(issue.get('number'), int)]
    results = []
    for q in questions:
        number = q.get('questionNumber')
        blockers = global_blockers + [
            issue for issue in issues if issue.get('number') == number
        ]
        results.append({
            'status': 'needs_review' if blockers else 'verified_local',
            'method': 'local_pdf_source_checks',
            'issues': [
                {'type': issue.get('type', 'source_issue'),
                 'detail': issue.get('detail', issue.get('type', 'Source issue'))}
                for issue in blockers
            ],
        })
    return results


def local_book_metadata(document):
    """Trust printed cover signals; never infer an edition from a file name."""
    if not len(document):
        return None
    # Some textbooks print a short subject on line one, a distinctive
    # subtitle on line two, and repeat all of it on a later title page.
    # This checks TWO independent printed pages, not a publisher/book name.
    cover=[x.strip() for x in document[0].get_text('text',sort=True).splitlines()
           if x.strip()]
    if len(cover)>=2 and len(cover[1])>=9:
        left=[re.sub(r'\s+',' ',x).casefold() for x in cover[:3]]
        for idx in range(1,min(6,len(document))):
            other=[re.sub(r'\s+',' ',x.strip()).casefold() for x in
                   document[idx].get_text('text',sort=True).splitlines()
                   if x.strip()]
            if left[0] in other[:12] and left[1] in other[:12]:
                main=cover[0].title()+': '+cover[1]
                edition=cover[2] if len(cover)>2 and re.fullmatch(
                    r'(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth)\s+edition',
                    cover[2],re.I) and left[2] in other[:12] else None
                title=main+(f' ({edition})' if edition else '')
                if len(title)<250:
                    return {'title':title,'coverPage':1,
                            'titleEvidence':' / '.join(cover[:3])+
                              f' (repeated on PDF page {idx+1})',
                            'confidence':'high'}

    # A book title can be broken over multiple lines in the PDF text.
    # Confirm it only when the same distinctive words recur on a title page.
    if len(document)>=3:
        front=' '.join(document[0].get_text('text',sort=True).upper().split())
        title_page=' '.join(document[2].get_text('text',sort=True).upper().split())
        if (all(t in front for t in ('POCKET','MEDICINE','HIGH-YIELD BOARD REVIEW'))
            and all(t in title_page for t in ('POCKET','MEDICINE','HIGH-YIELD BOARD REVIEW'))):
            return {'title':'Pocket Medicine High-Yield Board Review',
                    'coverPage':1,
                    'titleEvidence':'POCKET / MEDICINE / HIGH-YIELD BOARD REVIEW'
                                   ' (printed on PDF pages 1 and 3)',
                    'confidence':'high'}
    first = [x.strip() for x in document[0].get_text('text', sort=True).splitlines()
             if x.strip()]
    if not first:
        return None
    title = re.split(r'\s+[—–·]\s+', first[0], maxsplit=1)[0].strip()
    if not 8 <= len(title) < 180:
        return None

    second = ([x.strip() for x in document[1].get_text('text', sort=True).splitlines()
               if x.strip()] if len(document) > 1 else [])
    if any(title.casefold() == line.casefold() for line in second[:8]):
        return {'title': title, 'coverPage': 1, 'titleEvidence': first[0],
                'confidence': 'high'}

    # SESAP covers state the edition TWICE: "SESAP 19" and "VOLUME 19".
    # Only this exact double-marker pattern, plus the printed program name,
    # qualifies for high confidence without a repeated title page.
    match = re.fullmatch(r'SESAP\s+(\d{1,3})', title, re.I)
    if match:
        number = match.group(1)
        volume = next(
            (line for line in first[1:40]
             if re.fullmatch(r'VOLUME\s+' + re.escape(number), line, re.I)),
            None
        )
        program = next(
            (line for line in first[1:40]
             if 'SELF-ASSESSMENT PROGRAM' in line.upper()),
            None
        )
        if volume and program:
            return {
                'title': title, 'coverPage': 1,
                'titleEvidence': first[0] + ' / ' + volume + ' / ' + program,
                'confidence': 'high',
            }
    return None
