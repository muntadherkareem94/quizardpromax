"""Conservative no-API MCQ extraction from selectable-text PDFs.

Only unambiguous layouts with printed answer keys qualify for automatic local
validation. Any uncertainty returns issues and should use an AI fallback or
human review. Never solve a medical question or invent an explanation.
"""
from __future__ import annotations
import re
import time
from collections import Counter

Q = re.compile(r'^\s*(?:Question|Q)\s*(\d+)\s*[.):]\s*(.*)$', re.I)
OPT = re.compile(r'^\s*([A-J])\s*[.):]\s*(\S.*)$')
KEY = re.compile(r'^\s*(?:Correct\s+Answer|Answer\s+Key|Answer)\s*:\s*([A-J])(?:[.)\s:-]+(.*))?$', re.I)
EXPL = re.compile(r'^\s*(?:Explanation|Rationale)\s*:\s*(.*)$', re.I)
IMARK = re.compile(r'^\s*(Question|Explanation)\s+Image\s*$', re.I)


def join_source(lines):
    """Join wrapped PDF lines without changing their wording or answer text."""
    return ' '.join(s.strip() for s in lines if s.strip()).strip()


def layout_figures(document, first, last):
    """Map labeled raster figures using original page geometry, never AI."""
    anchors, figures, issues = [], [], []
    for pno in range(first, last + 1):
        page = document[pno-1]
        blocks = [(b[:4], b[4].strip()) for b in page.get_text('blocks')
                  if len(b) > 4 and isinstance(b[4], str)]
        for box, txt in blocks:
            for line in txt.splitlines():
                m = Q.match(line)
                if m:
                    anchors.append((pno, box[1], int(m.group(1))))
                    break
        seen = set()
        for spec in page.get_images(full=True):
            xref = spec[0]
            for rect in page.get_image_rects(xref):
                if rect.width < 90 or rect.height < 70:
                    continue
                k = (xref, round(rect.x0), round(rect.y0))
                if k in seen:
                    continue
                seen.add(k)
                labels = []
                for b, txt in blocks:
                    marker = IMARK.fullmatch(txt.strip())
                    gap = b[1]-rect.y1
                    if marker and -35 <= gap <= 65:
                        labels.append((abs(gap), marker.group(1).lower()))
                labels.sort()
                kind = (labels[0][1] if labels and
                        (len(labels)==1 or labels[0][0]+10 < labels[1][0]) else None)
                figures.append((pno, rect.y0, kind))
    if len({q for _,_,q in anchors}) != len(anchors):
        return {}, [{'type':'duplicate_anchor','detail':'Duplicate question anchors in original PDF'}]
    result = {}
    for pno, y, kind in figures:
        before = [a for a in anchors if (a[0],a[1]) <= (pno,y)]
        if not before or not kind:
            issues.append({'type':'unclassified_image','page':pno,
                           'detail':'Figure lacks uniquely attributable question and source image label'})
            continue
        qno = max(before)[2]
        result.setdefault(qno, []).append(kind)
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
            mark = IMARK.fullmatch(line)
            if mark:
                markers.append(mark.group(1).lower())
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


def local_book_metadata(document):
    """Only skip AI metadata when cover and title page independently agree."""
    if len(document)<2: return None
    first=[x.strip() for x in document[0].get_text('text',sort=True).splitlines() if x.strip()]
    second=[x.strip() for x in document[1].get_text('text',sort=True).splitlines() if x.strip()]
    if not first or not second:return None
    title=first[0].split(' — ',1)[0].strip()
    if not (8<=len(title)<180):return None
    if not any(title.casefold()==line.casefold() for line in second[:8]):return None
    return {'title':title,'coverPage':1,'titleEvidence':first[0],
            'confidence':'high'}
