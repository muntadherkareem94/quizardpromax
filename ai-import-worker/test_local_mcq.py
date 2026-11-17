"""Fast offline tests: no network, no API credits, no Supabase dependencies."""
import unittest
import fitz

from local_mcq import extract_local_section, local_book_metadata


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


if __name__=="__main__":
    unittest.main()
