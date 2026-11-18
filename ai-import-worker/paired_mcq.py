"""Layout-aware, publisher-independent PDF extractor for separate question/answer sets.

Works on bounded printed 'Questions' -> 'Answers' sections where numbered
question headings and numbered answer headings can be matched by source number.
The extractor NEVER infers a correct answer from medical knowledge.
"""
from __future__ import annotations
import re
import time
from collections import Counter
import fitz

HEADING = re.compile(
    r'^\s*(?:(?:practice\s*)?paper|set|test|section)\s*(\d{1,4})\s*[:.\-]\s*(questions|answers)\s*$',
    re.I)
NUMBER = re.compile(r'^\s*(\d{1,4})\s*[.)]\s+(.+)$')
OPTION = re.compile(r'^\s*(?:\(([A-J])\)|([A-J])\s*[.):])\s*(.+)$',re.I)
KEY_LINE = re.compile(r'^\s*([A-J])\s*[–—\-:.]\s*(.+)$',re.I)
PRINTED_ANSWER = re.compile(r'^\s*(?:The\s+)?correct\s+answer\s+is\s*:\s*([A-J])\s*[.)]?\s*(.*)$',re.I)
ONLY_PAGE_NUMBER = re.compile(r'^\d{1,4}$')
CLEAN_HEADER = re.compile(r'^(?:Questions|Answers|Practice\s+Paper\s+\d+\s*:\s*(?:Questions|Answers))$',re.I)


def _lines(page,pno):
    """Read ordered horizontal PDF text spans, excluding rotated margin labels.

    PyMuPDF get_text('text',sort=True) can interleave vertical page headers
    with options, corrupting the letters and clinical text.
    """
    output=[]
    data=page.get_text('dict',sort=True)
    for block in data['blocks']:
        if block.get('type')!=0:continue
        for line in block.get('lines',[]):
            dx,dy=line.get('dir',(1,0))
            if dx < .95 or abs(dy)>.25:continue
            spans=sorted(line.get('spans',[]),key=lambda s:s['bbox'][0])
            if not spans:continue
            text=''
            right=None
            for span in spans:
                part=span.get('text','')
                if not part:continue
                if right is not None and span['bbox'][0]-right>3:
                    text+=' '
                text+=part
                right=span['bbox'][2]
            text=text.strip()
            if not text:continue
            rect=fitz.Rect(line['bbox'])
            # Exclude narrow page-edge labels and vertical ornamental rules.
            if rect.x1<page.rect.width*.095 or rect.x0>page.rect.width*.95:
                continue
            output.append((pno,rect.y0,rect.x0,text))
    return sorted(output,key=lambda v:(v[1],v[2]))


def pair_ranges(document):
    """Find explicit printed Questions/Answers pairs across a document.

    A pair must have a Questions heading, a later Answers heading, and
    source-numbered questions and keys, preventing false matches in TOCs.
    """
    markers=[]
    for p in range(len(document)):
        lines=_lines(document[p],p+1)
        for _,_,_,t in lines[:12]:
            match=HEADING.fullmatch(t)
            if match:
                markers.append((p+1,int(match.group(1)),match.group(2).lower()))
                break
    pairs=[]
    for i,(start,num,kind) in enumerate(markers):
        if kind!='questions':continue
        answer=next(((page,j) for j,(page,n,k) in enumerate(markers[i+1:],i+1)
                     if k=='answers' and n==num and page>start),None)
        if answer is None:continue
        answer_page,answer_index=answer
        next_question=next((page for page,n,k in markers[answer_index+1:]
                            if k=='questions' and page>answer_page),len(document)+1)
        last=next_question-1
        if start < answer_page <= last:
            pairs.append({'section_index':len(pairs)+1,
                          'title':f'Practice Paper {num}',
                          'start_page':start,'end_page':last,
                          'question_start':start,'question_end':answer_page-1,
                          'answer_start':answer_page,'answer_end':last})
    # Prevent overlapping/ambiguous source ranges.
    if any(a['end_page']>=b['start_page'] for a,b in zip(pairs,pairs[1:])):
        return []
    return pairs


def _heading_entries(lines,answer_section=False):
    starts=[]
    for i,(_,_,_,txt) in enumerate(lines):
        m=NUMBER.match(txt)
        if not m:continue
        # Answer headings must be followed by a printed letter key.
        if answer_section:
            following=[x[3] for x in lines[i+1:i+6]]
            if not any(KEY_LINE.match(x) or PRINTED_ANSWER.match(x) for x in following):
                continue
        else:
            # The named item must contain actual lettered choices before the
            # next candidate item. A numbered medical paragraph is not enough.
            choices=[]
            for _,_,_,line in lines[i+1:i+115]:
                if NUMBER.match(line):break
                opt=OPTION.match(line)
                if opt:choices.append((opt.group(1) or opt.group(2)).upper())
            if choices[:2]!=['A','B']:continue
        starts.append((i,int(m.group(1)),m.group(2)))
    return starts


def _clean(t):
    return ' '.join(x.strip() for x in t if x and x.strip()).strip()


def extract_pairs(document,section):
    first,last=section['start_page'],section['end_page']
    qs=[v for p in range(section['question_start'],section['question_end']+1)
        for v in _lines(document[p-1],p)]
    ans=[v for p in range(section['answer_start'],section['answer_end']+1)
         for v in _lines(document[p-1],p)]
    qstarts=_heading_entries(qs)
    astarts=_heading_entries(ans,True)
    if not qstarts or not astarts:
        return None
    key_map={}
    issues=[]
    for i,(idx,n,title) in enumerate(astarts):
        stop=astarts[i+1][0] if i+1<len(astarts) else len(ans)
        body=[v[3] for v in ans[idx+1:stop]
              if not CLEAN_HEADER.fullmatch(v[3]) and not ONLY_PAGE_NUMBER.fullmatch(v[3])]
        mark=next(((j,KEY_LINE.match(t) or PRINTED_ANSWER.match(t))
                   for j,t in enumerate(body[:8])
                   if KEY_LINE.match(t) or PRINTED_ANSWER.match(t)),None)
        if not mark:
            issues.append({'type':'missing_printed_key','number':n})
            continue
        k,m=mark
        letter=m.group(1).upper()
        explanation=_clean([m.group(2)]+body[k+1:])
        if n in key_map:
            issues.append({'type':'duplicate_answer','number':n})
        key_map[n]=(letter,explanation,ans[idx][0],body[k])
    questions=[]
    for i,(idx,n,title) in enumerate(qstarts):
        stop=qstarts[i+1][0] if i+1<len(qstarts) else len(qs)
        body=[v for v in qs[idx+1:stop]
              if not CLEAN_HEADER.fullmatch(v[3]) and not ONLY_PAGE_NUMBER.fullmatch(v[3])]
        stem=[title]
        options=[]
        labels=[]
        state='stem'
        for _,_,_,line in body:
            opt=OPTION.match(line)
            if opt and state in ('stem','options'):
                label=(opt.group(1) or opt.group(2)).upper()
                labels.append(label)
                options.append([opt.group(3)])
                state='options'
            elif state=='stem':stem.append(line)
            elif options:options[-1].append(line)
        opts=[_clean(x) for x in options]
        if len(opts)<2 or len(opts)>10 or labels!=list('ABCDEFGHIJ')[:len(labels)]:
            issues.append({'type':'options_not_trustworthy','number':n})
        if n in key_map:
            letter,explanation,answer_page,printed=key_map[n]
            answer_index=ord(letter)-65
            if answer_index>=len(opts):
                issues.append({'type':'printed_answer_outside_options','number':n})
            if not explanation:
                issues.append({'type':'missing_explanation','number':n})
            evidence=f'{n}. {title} / {printed}'
        else:
            answer_index=-1
            explanation=''
            evidence=''
            issues.append({'type':'no_printed_answer','number':n})
        questions.append({'questionNumber':n,'sourcePage':qs[idx][0],
                          'question':_clean(stem),'options':opts,
                          'correctAnswerIndex':answer_index,
                          'explanation':explanation,'answerEvidence':evidence,
                          'figureInQuestion':False,'figureInExplanation':False})
    found=[x['questionNumber'] for x in questions]
    if len(set(found))!=len(found):
        issues.append({'type':'duplicate_question_number','sourceNumbers':found})
    missing_keys=set(found)^set(key_map)
    for num in sorted(missing_keys):
        issues.append({'type':'unmatched_question_or_answer','number':num})
    figures,figure_issues=paired_figure_layout(document,section,questions,True)
    issues.extend(figure_issues)
    for q in questions:
        kinds=[x[0] for x in figures.get(q['questionNumber'],[])]
        q['figureInQuestion']='question' in kinds
        q['figureInExplanation']='explanation' in kinds
    return {'questions':questions,'issues':issues,
            'sourceQuestionNumbers':found,'strict_pass':not issues,
            'elapsed_ms':0.0}


def paired_figure_layout(document,section,questions,include_rects=True):
    """Assign raster figures to the immediately preceding numbered source entry.

    Ambiguous or decorative images remain issues, never silently attached.
    """
    source_nums={q['questionNumber'] for q in questions}
    results={}
    issues=[]
    for kind,a,b in (
       ('question',section['question_start'],section['question_end']),
       ('explanation',section['answer_start'],section['answer_end'])):
        lines=[v for p in range(a,b+1) for v in _lines(document[p-1],p)]
        starts=_heading_entries(lines,answer_section=kind=='explanation')
        anchors=[(lines[i][0],lines[i][1],n) for i,n,_ in starts if n in source_nums]
        for page_num in range(a,b+1):
            page=document[page_num-1]
            seen=set()
            for img in page.get_images(full=True):
                xref=img[0]
                for rect in page.get_image_rects(xref):
                    if rect.width < 95 or rect.height < 75:continue
                    key=(xref,round(rect.x0),round(rect.y0))
                    if key in seen:continue
                    seen.add(key)
                    preceding=[v for v in anchors if (v[0],v[1])<=(page_num,rect.y0)]
                    if not preceding:
                        issues.append({'type':'unclassified_image','page':page_num})
                        continue
                    num=max(preceding)[2]
                    if include_rects:
                        results.setdefault(num,[]).append((kind,page_num,xref,rect))
                    else:
                        results.setdefault(num,[]).append(kind)
    return results,issues
