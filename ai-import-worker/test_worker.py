"""Offline smoke tests: no real Supabase, OpenAI calls, or user data."""
import os
import unittest
import fitz
from decimal import Decimal
from cost_guard import (
    BudgetExceeded, rate, usage_cost_usd, reserve_cost_usd,
    assert_budget, safely_selectable_text,
)

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "not-a-real-service-key")
os.environ.setdefault("OPENAI_API_KEY", "not-a-real-api-key")

from worker import (find_sections, validate_question, page_part, EXTRACTION_SCHEMA,
                    normalize_claimed_job, figure_layout, normalize_mcq_options)

class ImportTests(unittest.TestCase):
    def test_flex_costs_and_cached_input_tokens(self):
        self.assertEqual(rate("gpt-6.1-sol","flex")[:2],(Decimal("1"),Decimal("5")))
        self.assertEqual(rate("gpt-6-astra","flex")[:2],(Decimal("5"),Decimal("25")))
        self.assertEqual(usage_cost_usd("gpt-6.1-sol","flex",1_000_000,0),Decimal("1.00000000"))
        self.assertEqual(usage_cost_usd("gpt-6.1-sol","flex",1_000_000,0,100_000),
                         Decimal("0.90500000"))
        self.assertEqual(usage_cost_usd("gpt-6-astra","flex",0,100_000),
                         Decimal("2.50000000"))
        with self.assertRaises(ValueError):
            rate("unpriced-model","flex")

    def test_per_book_budget_guard(self):
        reserve=reserve_cost_usd("gpt-6-astra","flex","Question text",3,True,4500)
        self.assertGreater(reserve,Decimal("0.1"))
        assert_budget(0.75,0.3,reserve)
        with self.assertRaises(BudgetExceeded):
            assert_budget(0.35,0.3,reserve)
        with self.assertRaises(ValueError):
            usage_cost_usd("gpt-6-astra","flex",100,200,300)

    def test_text_first_accepts_selectable_text_and_rejects_scans_or_figures(self):
        doc=fitz.open()
        page=doc.new_page()
        page.insert_text((72,90), "Question 1. A source MCQ with selectable text. "
                         "Which answer is correct?\n"
                         "A. This option contains several explanatory words and clinical detail.\n"
                         "B. Another option contains meaningful supporting words.\n"
                         "Correct answer: B. Explanation: present in the PDF.",
                         fontsize=11)
        sample=safely_selectable_text(doc,1,1)
        self.assertIsNotNone(sample)
        self.assertIn("ORIGINAL PDF PAGE 1",sample)
        self.assertIn("Correct answer: B",sample)
        blank=doc.new_page()
        self.assertIsNone(safely_selectable_text(doc,1,2))
        doc.delete_page(1)
        pix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,200,100),False)
        page.insert_image(fitz.Rect(100,350,300,450),pixmap=pix)
        self.assertIsNone(safely_selectable_text(doc,1,1))
        doc.close()

    def test_bookmarked_chapters(self):
        document=fitz.open()
        for _ in range(9): document.new_page()
        document.set_toc([[1, "Chapter 1: Surgery", 1],
                          [1, "Chapter 2: Rheumatology", 5]])
        chunks,issues=find_sections(document)
        self.assertEqual(issues,[])
        self.assertEqual([(c["start_page"],c["end_page"]) for c in chunks],[(1,4),(5,9)])
        document.close()

    def test_text_chapter_fallback(self):
        document=fitz.open()
        for i in range(7):
            p=document.new_page()
            if i in (0,3): p.insert_text((72,72),f"Chapter {1 if i==0 else 2} - Questions")
        chunks,issues=find_sections(document)
        self.assertEqual(issues,[])
        self.assertEqual(len(chunks),2)
        document.close()

    def test_ambiguous_chapters_fail_closed(self):
        document=fitz.open()
        for _ in range(4): document.new_page()
        chunks,issues=find_sections(document)
        self.assertTrue(any(x["type"]=="chapters_unverified" for x in issues))
        document.close()

    def test_question_answer_must_come_from_source(self):
        q={"questionNumber":1,"sourcePage":2,"question":"A case question about renal function?",
           "options":["A","B","C","D"],"correctAnswerIndex":-1,
           "explanation":"","answerEvidence":""}
        errors=validate_question(q,1,3)
        self.assertTrue(any("answer key" in x for x in errors))
        self.assertTrue(any("Explanation" in x for x in errors))
        q.update(correctAnswerIndex=2,explanation="As printed.",answerEvidence="Page 2 answer: C")
        self.assertEqual(validate_question(q,1,3),[])

    def test_page_pdf_has_expected_count(self):
        source=fitz.open()
        for _ in range(5):source.new_page()
        data=page_part(source,2,4)
        snippet=fitz.open(stream=data,filetype="pdf")
        self.assertEqual(len(snippet),3)
        snippet.close();source.close()

    def test_empty_queue_composite_is_not_a_job(self):
        self.assertIsNone(normalize_claimed_job(None))
        self.assertIsNone(normalize_claimed_job([]))
        self.assertIsNone(normalize_claimed_job({"id":None,"source_path":None}))
        self.assertIsNone(normalize_claimed_job([{"id":None}]))
        job={"id":"8f43e841-a424-4ab9-afda-2e9ac3611480","source_path":"x/book.pdf"}
        self.assertEqual(normalize_claimed_job(job),job)
        self.assertEqual(normalize_claimed_job([{"id":None},job]),job)

    def test_duplicate_frontmatter_chapter_skipped(self):
        doc=fitz.open()
        for i in range(5):
            pg=doc.new_page()
            if i==1:
                pg.insert_text((72,72),"Chapter 1: Practice MCQs")
            if i==2:
                pg.insert_text((72,72),"Chapter 1: Questions")
                pg.insert_text((72,108),"Question 1. Which answer is correct?")
        chunks,issues=find_sections(doc)
        self.assertEqual(issues,[])
        self.assertEqual(len(chunks),1)
        self.assertEqual(chunks[0]["start_page"],3)
        doc.close()

    def test_images_on_adjacent_pages_attach_to_preceding_mcq(self):
        doc=fitz.open()
        pix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,200,100),False)
        png=pix.tobytes("png")
        pg=doc.new_page()
        pg.insert_text((72,70),"Question 1. A stem")
        pg.insert_text((72,340),"Question 2. A second stem")
        pg.insert_image(fitz.Rect(100,400,300,500),stream=png)
        pg.insert_text((100,520),"Explanation Image")
        pg=doc.new_page()
        pg.insert_image(fitz.Rect(100,40,300,140),stream=png)
        pg.insert_text((100,160),"Question Image")
        pg.insert_text((72,300),"Question 3. A third stem")
        mapping,issues=figure_layout(doc,1,2)
        self.assertEqual(issues,[])
        self.assertEqual([x[0] for x in mapping[2]],["explanation","question"])
        self.assertNotIn(1,mapping)
        self.assertNotIn(3,mapping)
        doc.close()

    def test_option_labels_removed_only_when_sequential(self):
        q={"options":["A. Option one","B. Option two","C. Option three"]}
        normalize_mcq_options(q)
        self.assertEqual(q["options"],["Option one","Option two","Option three"])
        q2={"options":["A. Option one","C. Option two"]}
        normalize_mcq_options(q2)
        self.assertEqual(q2["options"],["A. Option one","C. Option two"])

    def test_strict_schema(self):
        self.assertFalse(EXTRACTION_SCHEMA["additionalProperties"])
        self.assertEqual(EXTRACTION_SCHEMA["properties"]["questions"]["items"]["properties"]["correctAnswerIndex"]["type"],"integer")

if __name__ == "__main__":unittest.main()
