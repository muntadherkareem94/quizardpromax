"""Fast offline tests: no network, no API credits, no Supabase dependencies."""
import unittest
import fitz

from local_mcq import extract_local_section, local_book_metadata, layout_figures, classify_local_questions, partition_long_sections


def make_textbook(*, answer="Correct answer: B. Second choice",
                  explanation="Explanation: Printed source explanation.",
                  duplicate=False, options=("A. First choice", "B. Second choice"),
                  with_figure=False, scanned=False):
    pdf = fitz.open()
    cover = pdf.new_page(width=612, height=792)
    cover.insert_text((50,100), "Quizard Parser Fixture — Medicine", fontsize=16)
    title = pdf.new_page(width=612,height=792)
    title.insert_text((60,100), "Quizard Parser Fixture", fontsize=17)
    chapter = pdf.new_page(width=612,height=792)
    if scanned:
        pix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,180,120),False)
        chapter.insert_image(fitz.Rect(80,200,340,375),pixmap=pix)
        return pdf
    lines = [
       "Chapter 1: Questions",
       "Question 1. Which choice is confirmed by the printed key?",
       *options,
       answer,
       explanation,
    ]
    y=70
    for line in lines:
        chapter.insert_text((60,y),line,fontsize=11)
        y+=26
    if with_figure:
        pix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,180,120),False)
        chapter.insert_image(fitz.Rect(100,300,360,420),pixmap=pix)
        chapter.insert_text((165,438),"Explanation Image",fontsize=11)
    if duplicate:
        chapter.insert_text((60,500),"Question 1. Another printed question?",fontsize=11)
        chapter.insert_text((60,530),"A. First choice",fontsize=11)
        chapter.insert_text((60,555),"B. Second choice",fontsize=11)
        chapter.insert_text((60,580),"Correct answer: B. Second choice",fontsize=11)
        chapter.insert_text((60,605),"Explanation: Source says second.",fontsize=11)
    return pdf


class LocalMCQTests(unittest.TestCase):
    def test_exact_printed_question_and_answer_without_ai(self):
        d=make_textbook()
        try:
            result=extract_local_section(d,3,3)
            self.assertTrue(result["strict_pass"],result["issues"])
            self.assertEqual(len(result["questions"]),1)
            q=result["questions"][0]
            self.assertEqual(q["questionNumber"],1)
            self.assertEqual(q["sourcePage"],3)
            self.assertEqual(q["options"],["First choice","Second choice"])
            self.assertEqual(q["correctAnswerIndex"],1)
            self.assertEqual(q["answerEvidence"],"Correct answer: B. Second choice")
            self.assertEqual(q["explanation"],"Printed source explanation.")
            self.assertEqual(local_book_metadata(d)["title"],"Quizard Parser Fixture")
        finally:d.close()

    def test_labeled_explanation_figure_is_attributed_without_ai(self):
        d=make_textbook(with_figure=True)
        try:
            result=extract_local_section(d,3,3)
            self.assertTrue(result["strict_pass"],result["issues"])
            self.assertFalse(result["questions"][0]["figureInQuestion"])
            self.assertTrue(result["questions"][0]["figureInExplanation"])
        finally:d.close()

    def test_wrong_answer_label_text_fails_closed(self):
        d=make_textbook(answer="Correct answer: B. First choice")
        try:
            result=extract_local_section(d,3,3)
            self.assertFalse(result["strict_pass"])
            self.assertIn("answer_option_mismatch",
                          [x["type"] for x in result["issues"]])
        finally:d.close()

    def test_no_printed_key_is_not_solved_medically(self):
        d=make_textbook(answer="")
        try:
            result=extract_local_section(d,3,3)
            self.assertFalse(result["strict_pass"])
            self.assertEqual(result["questions"][0]["correctAnswerIndex"],-1)
        finally:d.close()

    def test_missing_explanation_fails_closed(self):
        d=make_textbook(explanation="")
        try:
            result=extract_local_section(d,3,3)
            self.assertFalse(result["strict_pass"])
            self.assertIn("no_printed_explanation",
                          [x["type"] for x in result["issues"]])
        finally:d.close()

    def test_duplicate_question_number_is_rejected(self):
        d=make_textbook(duplicate=True)
        try:
            result=extract_local_section(d,3,3)
            self.assertFalse(result["strict_pass"])
            self.assertEqual(len(result["questions"]),2)
            self.assertIn("duplicate_question_number",
                          [x["type"] for x in result["issues"]])
        finally:d.close()

    def test_wrong_option_order_is_rejected(self):
        d=make_textbook(options=("B. Second choice","A. First choice"))
        try:
            result=extract_local_section(d,3,3)
            self.assertFalse(result["strict_pass"])
            self.assertIn("option_order",[x["type"] for x in result["issues"]])
        finally:d.close()

    def test_image_only_scanned_pdf_requires_fallback(self):
        d=make_textbook(scanned=True)
        try:
            result=extract_local_section(d,3,3)
            self.assertFalse(result["strict_pass"])
            self.assertEqual(result["questions"],[])
        finally:d.close()

    def test_answer_and_explanation_can_continue_on_next_page(self):
        d=fitz.open()
        p=d.new_page()
        p.insert_text((60,80),"Question 1. Which option is correct?")
        p.insert_text((70,105),"A. No")
        p.insert_text((70,130),"B. Yes")
        p=d.new_page()
        p.insert_text((60,80),"Correct answer: B. Yes")
        p.insert_text((60,105),"Explanation: Printed continuation.")
        try:
            result=extract_local_section(d,1,2)
            self.assertTrue(result["strict_pass"],result["issues"])
            self.assertEqual(result["questions"][0]["sourcePage"],1)
        finally:d.close()


    def test_sesap_style_critique_spanning_pages_and_captioned_figures(self):
        """Synthetic SESAP-like pages (no copyrighted source PDF in repository)."""
        d=fitz.open()
        d.new_page().insert_text((60,60),"Sample Cover")
        p=d.new_page()
        entries=[
            (70,"Question 1"),
            (95,"Which of the following source options is correct?"),
            (125,"Figure 1."),
            (325,"A. The first option"),
            (350,"B. The second option"),
            (380,"Answer: B. The second option"),
            (405,"Critique"),
            (430,"This explanation continues on the next source page."),
        ]
        for y,line in entries:p.insert_text((60,y),line)
        pix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,180,120),False)
        p.insert_image(fitz.Rect(80,148,340,298),pixmap=pix)
        p=d.new_page()
        p.insert_text((60,70),"The second page supplies more of this critique.")
        p.insert_text((60,110),"Figure 2.")
        p.insert_image(fitz.Rect(80,135,340,285),pixmap=pix)
        p.insert_text((60,330),"References")
        p.insert_text((60,360),"1. Source reference must not appear in explanation.")
        p=d.new_page()
        for y,line in [
            (70,"Question 2"),
            (95,"What answer does the source print for this question?"),
            (120,"A. No"),
            (145,"B. Yes"),
            (170,"Answer: B. Yes"),
            (195,"Critique"),
            (220,"Linked Item: The critique will display after all linked items in the series are answered."),
        ]:p.insert_text((60,y),line)
        try:
            result=extract_local_section(d,2,4)
            self.assertEqual([q["questionNumber"] for q in result["questions"]],[1,2])
            q1,q2=result["questions"]
            self.assertEqual(q1["correctAnswerIndex"],1)
            self.assertTrue(q1["figureInQuestion"])
            self.assertTrue(q1["figureInExplanation"])
            self.assertIn("continues on the next",q1["explanation"])
            self.assertNotIn("Source reference",q1["explanation"])
            self.assertFalse(result["strict_pass"])
            self.assertIn("linked_critique_not_provided",
                          [i["type"] for i in result["issues"]])
            statuses=classify_local_questions(result["questions"],result["issues"])
            self.assertEqual([a["status"] for a in statuses],
                             ["verified_local","needs_review"])
            self.assertEqual(statuses[0]["issues"],[])
            self.assertEqual(statuses[1]["issues"][0]["type"],
                             "linked_critique_not_provided")
            figure_map,figure_issues=layout_figures(d,2,4,include_rects=True)
            self.assertEqual(figure_issues,[])
            self.assertEqual([f[0] for f in figure_map[1]],
                             ["question","explanation"])
            self.assertEqual(q2["correctAnswerIndex"],1)
        finally:
            d.close()

    def test_unnumbered_layout_issue_blocks_all_local_verification(self):
        questions=[{"questionNumber":1},{"questionNumber":2}]
        issues=[{"type":"unclassified_image","page":1,
                 "detail":"Cannot attribute image to printed question"}]
        audits=classify_local_questions(questions,issues)
        self.assertEqual([a["status"] for a in audits],
                         ["needs_review","needs_review"])

    def test_question_specific_issue_does_not_block_other_questions(self):
        questions=[{"questionNumber":1},{"questionNumber":2},{"questionNumber":3}]
        issues=[{"type":"no_printed_explanation","number":3}]
        audits=classify_local_questions(questions,issues)
        self.assertEqual([a["status"] for a in audits],
                         ["verified_local","verified_local","needs_review"])

    def test_sesap_title_and_volume_are_confirmed_from_printed_cover(self):
        d=fitz.open()
        page=d.new_page()
        for y,text in [(55,"SESAP 19"),(90,"SELF-ASSESSMENT PROGRAM"),
                       (125,"FOR SURGICAL TRAINING"),(170,"VOLUME 19")]:
            page.insert_text((70,y),text)
        d.new_page().insert_text((60,60),"CHAPTER 1 BREAST")
        try:
            info=local_book_metadata(d)
            self.assertEqual(info["title"],"SESAP 19")
            self.assertEqual(info["confidence"],"high")
            self.assertIn("VOLUME 19",info["titleEvidence"])
        finally:d.close()

    def test_mismatched_sesap_cover_does_not_verify_title(self):
        d=fitz.open()
        page=d.new_page()
        for y,text in [(55,"SESAP 19"),(90,"SELF-ASSESSMENT PROGRAM"),
                       (125,"VOLUME 18")]:
            page.insert_text((70,y),text)
        d.new_page().insert_text((60,60),"CHAPTER 1 BREAST")
        try:self.assertIsNone(local_book_metadata(d))
        finally:d.close()


    def test_plain_numbered_question_with_parenthesized_options(self):
        d=fitz.open()
        page=d.new_page()
        entries=[
            (65,"1. Which option is printed as correct?"),
            (95,"(A) First choice"),
            (125,"(B) Second choice"),
            (155,"Correct option: (B)"),
            (185,"Discussion: The source states the second choice."),
        ]
        for y,line in entries:page.insert_text((60,y),line)
        try:
            result=extract_local_section(d,1,1)
            self.assertTrue(result["strict_pass"],result["issues"])
            self.assertEqual(result["questions"][0]["questionNumber"],1)
            self.assertEqual(result["questions"][0]["correctAnswerIndex"],1)
            self.assertEqual(result["questions"][0]["options"],["First choice","Second choice"])
            self.assertIn("second choice",result["questions"][0]["explanation"])
        finally:d.close()

    def test_numbered_bibliography_without_choices_is_not_a_question(self):
        d=fitz.open()
        p=d.new_page()
        for y,line in [(70,"References"),(90,"1. Smith 2024."),
                       (110,"2. Jones 2025.")]:
            p.insert_text((60,y),line)
        try:
            result=extract_local_section(d,1,1)
            self.assertEqual(result["questions"],[])
            self.assertFalse(result["strict_pass"])
            self.assertEqual(result["issues"][0]["type"],"no_question_anchors")
        finally:d.close()

    def test_numbered_question_without_printed_key_never_autoverifies(self):
        d=fitz.open()
        p=d.new_page()
        for y,line in [(70,"1. What is the correct source answer?"),
                       (95,"A. Yes"),(120,"B. No"),(150,"Discussion: Not supplied")]:
            p.insert_text((60,y),line)
        try:
            result=extract_local_section(d,1,1)
            self.assertFalse(result["strict_pass"])
            self.assertFalse(result["questions"])
        finally:d.close()

    def test_long_pdf_splits_at_question_start_pages(self):
        d=fitz.open()
        for i in range(1,66):
            p=d.new_page()
            if i % 7 == 1:
                for y,line in [
                    (60,f"Question {i}. Printed question for this page?"),
                    (100,"A. First choice"),
                    (125,"B. Second choice"),
                    (150,"Answer: B. Second choice"),
                    (175,"Explanation: Printed explanation."),
                ]:p.insert_text((60,y),line)
        try:
            parts=partition_long_sections(d,[dict(section_index=1,title="Chapter 1",
                           start_page=1,end_page=65)],max_pages=12)
            self.assertGreater(len(parts),1)
            self.assertEqual(parts[0]["start_page"],1)
            self.assertEqual(parts[-1]["end_page"],65)
            for left,right in zip(parts,parts[1:]):
                self.assertEqual(left["end_page"]+1,right["start_page"])
            self.assertTrue(all(part["end_page"]-part["start_page"]<12 for part in parts))
            self.assertFalse(any(part["boundary_issues"] for part in parts))
        finally:d.close()

    def test_unavoidable_long_page_split_requires_review(self):
        d=fitz.open()
        for i in range(25):
            p=d.new_page()
            p.insert_text((50,60),"Continuation of an unknown question or scanned page")
        try:
            parts=partition_long_sections(d,[dict(section_index=1,title="Unknown",
                           start_page=1,end_page=25)],max_pages=9)
            self.assertGreater(len(parts),2)
            self.assertTrue(any(p["boundary_issues"] for p in parts))
            self.assertEqual(parts[-1]["end_page"],25)
        finally:d.close()


if __name__=="__main__":
    unittest.main()
