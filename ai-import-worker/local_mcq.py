"""Conservative no-API MCQ extraction from selectable-text PDFs.

Only unambiguous layouts with printed answer keys qualify for automatic local
validation. Any uncertainty returns issues and should use an AI fallback or
human review. Never solve a medical question or invent an explanation.
"""
from __future__ import annotations
import re
import time
from collections import Counter

Q = re.compile(r'^\s*(?:Question|Q)\s*(\d+)(?:\s*[.):]\s*|\s*$)(.*)$', re.I)
OPT = re.compile(r'^\s*([A-J])\s*[.):]\s*(\S.*)$')
KEY = re.compile(r'^\s*(?:Correct\s+Answer|Answer\s+Key|Answer)\s*:\s*([A-J])(?:[.)\s:-]+(.*))?$', re.I)
EXPL = re.compile(r'^\s*(?:Explanation|Rationale|Critique)\s*:?\s*(.*)$', re.I)
IMARK = re.compile(r'^\s*(Question|Explanation)\s+Image\s*$', re.I)
FIGCAP = re.compile(r'^\s*Figure\s+\d+\s*[.):]?\s*$', re.I)
REFS = re.compile(r'^\s*References\s*:?\s*$', re.I)


def join_source(lines):
    """Join wrapped PDF lines without changing their wording or answer text."""
    return ' '.join(s.strip() for s in lines if s.strip()).strip()


import fitz

def layout_figures(document, first, last, include_rects=False):
    """Match source-labeled figures to MCQs across pages, ignoring cover artwork.

    A nearby printed figure caption is required. A generic image inside an
    MCQ that cannot be attributed remains a review issue. The shared geometry
    is used by the validator and private-staging image uploader.
    """
    anchors, labels, images, issues = [], [], [], []
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
                if m:
                    anchors.append((pno, box.y0, int(m.group(1))))
                    state = 'stem'
                elif KEY.match(line):
                    state = 'answer'
                elif EXPL.match(line):
                    state = 'explanation'
                elif REFS.fullmatch(line):
                    state = 'references'
                elif (m := IMARK.fullmatch(line)):
                    labels.append((pno, box, m.group(1).lower(), 'marker'))
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
    lines = _read_lines(document,first,last)
    issues = []
    starts = [(i,p,int(m.group(1))) for i,(p,s) in enumerate(lines)
              if (m:=Q.match(s))]
    if not starts:
        return {'questions':[], 'issues':[{'type':'no_question_anchors',
                'detail':'No explicit numbered MCQ anchors in selectable PDF text'}],
                'sourceQuestionNumbers':[], 'strict_pass':False,
                'elapsed_ms':round((time.monotonic()-start)*1000,2)}
    ids = [q for _,_,q in starts]
    if len(set(ids)) != len(ids):
        issues.append({'type':'duplicate_question_number', 'sourceNumbers':ids})
    if len(ids)>1 and any(b!=a+1 for a,b in zip(ids,ids[1:])):
        issues.append({'type':'nonconsecutive_question_numbers','sourceNumbers':ids})
    figures, figure_issues = layout_figures(document,first,last)
    issues.extend(figure_issues)
    questions = []
    for j,(idx,pno,number) in enumerate(starts):
        end = starts[j+1][0] if j+1 < len(starts) else len(lines)
        raw = lines[idx:end]
        q_line = Q.match(raw[0][1]).group(2)
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
                explanation.append(m_expl.group(1))
                state='explanation'
            elif m_opt and state in ('stem','options'):
                opt_labels.append(m_opt.group(1))
                options.append([m_opt.group(2)])
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
    first = [x.strip() for x in document[0].get_text('text', sort=True).splitlines()
             if x.strip()]
    if not first:
        return None
    title = first[0].split(' — ', 1)[0].strip()
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
