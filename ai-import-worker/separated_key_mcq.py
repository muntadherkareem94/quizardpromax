"""Source-only extraction for books with QUESTIONS followed by a numbered ANSWERS section.

Recognize printed 1. Question, A/B/C options, and a later
1. The correct answer is: B. Explanation block. No inferred medical answers.
"""
from __future__ import annotations
import re
import time
from collections import Counter
import fitz

NUMBERED = re.compile(r'^\s*(\d{1,4})\s*[.]\s+(\S.*)$')
ANSWER = re.compile(r'^\s*(\d{1,4})\s*[.]\s+The\s+correct\s+answer\s+is\s*:\s*([A-J])\s*[.]\s*(.*)$', re.I)
OPTION = re.compile(r'^\s*(?:\(([A-J])\)|([A-J])\s*[.):])\s*(\S.*)$', re.I)
SKIP = re.compile(r'^\s*Freemedicalbooks4download\s*$', re.I)

def _join(lines):
    return ' '.join(t.strip() for t in lines if t.strip()).strip()

def _segments(doc, first, last):
    questions, answers = [], []
    state = None
    for pno in range(first, last + 1):
        for raw in doc[pno-1].get_text('text', sort=True).splitlines():
            txt = raw.strip()
            if not txt or SKIP.fullmatch(txt):
                continue
            if txt.upper() == 'QUESTIONS':
                state = 'q'
                continue
            if txt.upper() == 'ANSWERS':
                state = 'a'
                continue
            if state == 'q':
                questions.append((pno, txt))
            elif state == 'a':
                answers.append((pno, txt))
    return questions, answers

def is_separated_key_section(doc, first, last):
    q, a = _segments(doc, first, last)
    return bool(q and any(ANSWER.match(line) for _, line in a))

def has_separate_answer_marker(doc, first, last):
    q_marker, a_marker = False, False
    for pno in range(first, last + 1):
        lines = {s.strip().upper() for s in doc[pno-1].get_text('text', sort=True).splitlines()}
        q_marker |= 'QUESTIONS' in lines
        a_marker |= 'ANSWERS' in lines
        if q_marker and a_marker:
            return True
    return False

def _find_questions(lines):
    starts = []
    for idx, (p, line) in enumerate(lines):
        match = NUMBERED.match(line)
        if not match:
            continue
        letters = []
        for _, test in lines[idx+1:]:
            if NUMBERED.match(test):
                break
            m = OPTION.match(test)
            if m:
                letters.append((m.group(1) or m.group(2)).upper())
        if letters[:2] == ['A', 'B']:
            starts.append((idx, p, int(match.group(1)), match.group(2)))
    return starts

def _answer_blocks(lines):
    marks = [(idx, p, int(m.group(1)), m.group(2).upper(), m.group(3))
             for idx, (p, line) in enumerate(lines) if (m := ANSWER.match(line))]
    answer_map, issues = {}, []
    for j, (i, p, num, letter, opening) in enumerate(marks):
        finish = marks[j+1][0] if j+1 < len(marks) else len(lines)
        if num in answer_map:
            issues.append({'type': 'duplicate_printed_answer', 'number': num})
        explanation = _join([opening] + [ln for _, ln in lines[i+1:finish]])
        answer_map[num] = (letter, explanation, p)
    return answer_map, issues

def _image_anchor_rectangles(doc, first, last, questions):
    # Only this question/answer book layout: assign embedded images according
    # to their position between the previous and next numbered MCQ headings.
    starts = {(q['sourcePage'], q['questionNumber']) for q in questions}
    events, images, issues = [], [], []
    state = 'start'
    for pno in range(first, last + 1):
        page = doc[pno-1]
        blocks = sorted((b for b in page.get_text('blocks')
                         if len(b) > 4 and isinstance(b[4], str)),
                        key=lambda b: (b[1], b[0]))
        for b in blocks:
            for text in b[4].splitlines():
                line = text.strip()
                if line.upper() == 'QUESTIONS':
                    state = 'question'
                elif line.upper() == 'ANSWERS':
                    state = 'answer'
                elif state == 'question':
                    m = NUMBERED.match(line)
                    if m and (pno, int(m.group(1))) in starts:
                        events.append((pno, float(b[1]), int(m.group(1))))
        answer_y = next((float(b[1]) for b in blocks
                         if any(t.strip().upper() == 'ANSWERS'
                                for t in b[4].splitlines())), None)
        for item in page.get_images(full=True):
            xref = item[0]
            for rect in page.get_image_rects(xref):
                if rect.width < 90 or rect.height < 70:
                    continue
                if answer_y is not None and rect.y0 >= answer_y:
                    continue
                images.append((pno, rect.y0, xref, rect))
    assigned, seen = {}, set()
    for pno, y, xref, rect in images:
        key = (pno, xref, round(rect.x0), round(rect.y0))
        if key in seen:
            continue
        seen.add(key)
        previous = [(page, top, num) for page, top, num in events
                    if (page, top) <= (pno, y)]
        if not previous:
            issues.append({'type': 'unclassified_image', 'page': pno,
                           'detail': 'Image appears before any numbered MCQ'})
            continue
        num = max(previous)[2]
        assigned.setdefault(num, []).append(('question', pno, xref, rect))
    return assigned, issues

def separated_key_figure_layout(doc, first, last, include_rects=False):
    qlines, _ = _segments(doc, first, last)
    found = _find_questions(qlines)
    qs = [{'questionNumber': n, 'sourcePage': p} for _, p, n, _ in found]
    figures, issues = _image_anchor_rectangles(doc, first, last, qs)
    if include_rects:
        return figures, issues
    return {num: [kind for kind, _, _, _ in values]
            for num, values in figures.items()}, issues

def extract_separated_key_section(doc, first, last):
    started = time.monotonic()
    qlines, alines = _segments(doc, first, last)
    if not qlines or not alines:
        return None
    starts = _find_questions(qlines)
    keys, issues = _answer_blocks(alines)
    if not starts or not keys:
        return None
    figures, figure_issues = separated_key_figure_layout(doc, first, last)
    issues.extend(figure_issues)
    questions = []
    for j, (start, page, num, opening) in enumerate(starts):
        end = starts[j+1][0] if j+1 < len(starts) else len(qlines)
        raw = [(page, opening)] + qlines[start+1:end]
        labels, stem, options = [], [opening], []
        state = 'stem'
        for pno, line in raw[1:]:
            m = OPTION.match(line)
            if m and state in ('stem', 'options'):
                labels.append((m.group(1) or m.group(2)).upper())
                options.append([m.group(3)])
                state = 'options'
            elif state == 'options' and options:
                options[-1].append(line)
            else:
                stem.append(line)
        opts = [_join(o) for o in options]
        if not 2 <= len(opts) <= 10:
            issues.append({'type': 'invalid_options', 'number': num})
        if labels != [chr(65+i) for i in range(len(labels))]:
            issues.append({'type': 'option_order', 'number': num})
        if num not in keys:
            answer_index, explanation, evidence = -1, '', ''
            issues.append({'type': 'missing_printed_answer', 'number': num})
        else:
            letter, explanation, _ = keys[num]
            answer_index = ord(letter) - 65
            evidence = f'{num}. The correct answer is: {letter}.'
            if answer_index >= len(opts):
                issues.append({'type': 'invalid_printed_answer', 'number': num})
            if not explanation:
                issues.append({'type': 'missing_explanation', 'number': num})
        questions.append({
            'questionNumber': num, 'sourcePage': page, 'question': _join(stem),
            'options': opts, 'correctAnswerIndex': answer_index,
            'explanation': explanation, 'answerEvidence': evidence,
            'figureInQuestion': 'question' in figures.get(num, []),
            'figureInExplanation': 'explanation' in figures.get(num, [])
        })
    ids = [q['questionNumber'] for q in questions]
    if len(set(ids)) != len(ids):
        issues.append({'type': 'duplicate_question_number', 'sourceNumbers': ids})
    for missing in keys.keys() - set(ids):
        issues.append({'type': 'unmatched_answer_key', 'number': missing})
    if len(ids) > 1 and any(b != a+1 for a, b in zip(ids, ids[1:])):
        issues.append({'type': 'nonconsecutive_question_numbers', 'sourceNumbers': ids})
    return {
        'questions': questions, 'issues': issues, 'sourceQuestionNumbers': ids,
        'strict_pass': not issues,
        'elapsed_ms': round((time.monotonic()-started)*1000, 2)
    }
