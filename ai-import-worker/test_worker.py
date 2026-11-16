"""Offline smoke tests: no real Supabase, OpenAI calls, or user data."""
import os
import unittest
import fitz

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "not-a-real-service-key")
os.environ.setdefault("OPENAI_API_KEY", "not-a-real-api-key")

from worker import find_sections, validate_question, page_part, EXTRACTION_SCHEMA

class ImportTests(unittest.TestCase):
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

    def test_strict_schema(self):
        self.assertFalse(EXTRACTION_SCHEMA["additionalProperties"])
        self.assertEqual(EXTRACTION_SCHEMA["properties"]["questions"]["items"]["properties"]["correctAnswerIndex"]["type"],"integer")

if __name__ == "__main__":unittest.main()
