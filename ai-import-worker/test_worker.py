"""Offline smoke tests: no real Supabase, OpenAI calls, or user data."""
import os
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from datetime import datetime,timezone
import json
import httpx
import fitz
from decimal import Decimal
from cost_guard import (
    BudgetExceeded, rate, usage_cost_usd, reserve_cost_usd,
    assert_budget, safely_selectable_text,
)

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "not-a-real-service-key")
os.environ.setdefault("OPENAI_API_KEY", "not-a-real-api-key")

from free_router import (configured, request_provider, FreeRouter, ProvidersUnavailable, retry_seconds)
from server import valid_dispatch_identifiers
from worker import (find_sections, validate_question, page_part, EXTRACTION_SCHEMA,
                    normalize_claimed_job, figure_layout, normalize_mcq_options,
                    plan_mcq_batches, synthetic_test_passes_quality_gate)

class ImportTests(unittest.TestCase):
    def test_secure_dispatch_uuid_validation(self):
        job_id="25a9dcf4-be33-470b-9a94-0ca542aacbb2"
        token="738f4bcd-239b-428a-a5fb-e2c31a321758"
        self.assertTrue(valid_dispatch_identifiers(job_id,token))
        self.assertFalse(valid_dispatch_identifiers(job_id,"not-a-token"))
        self.assertFalse(valid_dispatch_identifiers("non-uuid",token))
        self.assertFalse(valid_dispatch_identifiers(job_id,"00000000-0000-0000-0000-00000000000g"))

    def test_synthetic_publisher_rejects_reviewed_or_incomplete_mcqs(self):
        clean=[{"status":"verified","issues":[],"questions":[{} for _ in range(4)]}]
        self.assertTrue(synthetic_test_passes_quality_gate(clean,[],4))
        self.assertFalse(synthetic_test_passes_quality_gate(clean,[{"type":"figure_mismatch"}],4))
        reviewed=[{"status":"needs_review","issues":[{"type":"duplicate_number"}],
                   "questions":[{} for _ in range(4)]}]
        self.assertFalse(synthetic_test_passes_quality_gate(reviewed,[],4))
        self.assertFalse(synthetic_test_passes_quality_gate(clean,[],3))

    def test_multi_page_batches_preserve_prior_verified_work(self):
        checkpoints={
            3:{"start_page":3,"end_page":3,"status":"verified","questions":[{"questionNumber":1}]},
            4:{"start_page":4,"end_page":4,"status":"extracted","questions":[]},
        }
        self.assertEqual(plan_mcq_batches(3,5,checkpoints,3),[(3,3),(4,5)])
        self.assertEqual(plan_mcq_batches(3,5,{},3),[(3,5)])
        self.assertEqual(plan_mcq_batches(3,8,{},3),[(3,5),(6,8)])
        checkpoints[4]["questions"]=[{"questionNumber":3}]
        self.assertEqual(plan_mcq_batches(3,5,checkpoints,3),[(3,3),(4,4),(5,5)])

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
        page=doc[0]  # Refresh page reference after the PDF page tree changes.
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


class FreeRouterTests(unittest.TestCase):
    SCHEMA={"type":"object","additionalProperties":False,
            "properties":{"ok":{"type":"boolean"}},"required":["ok"]}
    def test_configuration_requires_explicit_free_plan_and_cap(self):
        with patch.dict(os.environ,{"GEMINI_API_KEY":"test-only","GEMINI_FREE_CONFIRMED":"false",
                                    "GEMINI_DAILY_REQUEST_CAP":"10","GROQ_FREE_CONFIRMED":"false",
                                    "OPENROUTER_FREE_CONFIRMED":"false"},clear=False):
            self.assertNotIn("gemini",[p["name"] for p in configured()])
        with patch.dict(os.environ,{"OPENROUTER_API_KEY":"test-only",
                                    "OPENROUTER_MODEL":"openai/gpt-6",
                                    "OPENROUTER_FREE_CONFIRMED":"true",
                                    "OPENROUTER_DAILY_REQUEST_CAP":"20"},clear=False):
            self.assertNotIn("openrouter",[p["name"] for p in configured()])

    def test_secondary_gemini_model_requires_confirmation_and_separate_cap(self):
        settings={
            "GEMINI_API_KEY":"test-secret",
            "GEMINI_MODEL":"gemini-3.5-flash-lite",
            "GEMINI_FREE_CONFIRMED":"true",
            "GEMINI_DAILY_REQUEST_CAP":"30",
            "GEMINI_VERIFY_MODEL":"gemini-3.8-flash",
            "GEMINI_VERIFY_FREE_CONFIRMED":"true",
            "GEMINI_VERIFY_DAILY_REQUEST_CAP":"4",
        }
        with patch.dict(os.environ,settings,clear=True):
            gemini=[p for p in configured() if p["name"]=="gemini"]
            self.assertEqual({p["bucket"] for p in gemini},{"gemini","gemini_flash"})
            self.assertEqual([p["model"] for p in gemini],
                             ["gemini-3.5-flash-lite","gemini-3.8-flash"])
            self.assertEqual(gemini[1]["cap"],4)
        settings["GEMINI_VERIFY_FREE_CONFIRMED"]="false"
        with patch.dict(os.environ,settings,clear=True):
            self.assertEqual(len([p for p in configured() if p["name"]=="gemini"]),1)

    def test_brief_503_retry_does_not_wait_twenty_minutes(self):
        self.assertEqual(retry_seconds({},503),45)
        self.assertEqual(retry_seconds({},429),180)
        self.assertEqual(retry_seconds({"retry-after":"80"},429),80)

    def test_backup_model_is_available_for_discrepancy_repair(self):
        settings={
            "GEMINI_API_KEY":"test-only",
            "GEMINI_MODEL":"gemini-3.5-flash-lite",
            "GEMINI_FREE_CONFIRMED":"true",
            "GEMINI_DAILY_REQUEST_CAP":"30",
            "GEMINI_VERIFY_MODEL":"gemini-3.1-flash-lite",
            "GEMINI_VERIFY_FREE_CONFIRMED":"true",
            "GEMINI_VERIFY_DAILY_REQUEST_CAP":"30",
        }
        with patch.dict(os.environ,settings,clear=True):
            self.assertEqual(len([p for p in configured() if p["name"]=="gemini"]),2)

    def test_gemini_pdf_request_schema_validated_offline(self):
        pdf=fitz.open()
        pdf.new_page()
        data=pdf.tobytes()
        pdf.close()
        def respond(req):
            body=json.loads(req.content)
            self.assertEqual(req.headers["x-goog-api-key"],"test-only")
            self.assertEqual(body["contents"][0]["parts"][1]["inline_data"]["mime_type"],"application/pdf")
            return httpx.Response(200,json={"candidates":[{"content":{"parts":[{"text":"{\"ok\":true}"}]}}],
                "usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":12}})
        client=httpx.Client(transport=httpx.MockTransport(respond))
        model={"name":"gemini","model":"gemini-2.5-flash","key":"test-only"}
        result,ins,outs=request_provider(client,model,"Return JSON",self.SCHEMA,data,"extraction")
        self.assertEqual(result,{"ok":True})
        self.assertEqual((ins,outs),(30,12))

    def test_quota_exhaustion_switches_providers_without_paid_api(self):
        class FakeDB:
            def __init__(self):
                self.name=None
                self.cooldowns=[]
                self.records=[]
                self.reservations=0
            def table(self,name):
                self.name=name
                return self
            def select(self,*args):return self
            def eq(self,*args):return self
            def single(self):return self
            def limit(self,*args):return self
            def insert(self,obj):
                self.records.append(obj)
                return self
            def upsert(self,obj,**kwargs):
                self.cooldowns.append(obj)
                return self
            def execute(self):
                if self.name=="ai_import_jobs":data={"file_name":"surgery_test_book_1.pdf"}
                elif self.name=="ai_import_provider_state":data=[]
                elif self.name=="ai_reserve_free_provider_request":data=True
                else:data=[]
                return SimpleNamespace(data=data)
            def rpc(self,*args,**kwargs):
                self.name="ai_reserve_free_provider_request"
                self.reservations+=1
                return self
        # Preserve the original request type and use one real internal fallback.
        def handler(req):
            if "generativelanguage.googleapis.com" in str(req.url):
                return httpx.Response(429,headers={"retry-after":"180"},json={"error":"quota"})
            self.assertIn("api.groq.com",str(req.url))
            return httpx.Response(200,json={"choices":[{"message":{"content":"{\"ok\":true}"}}],
                                             "usage":{"prompt_tokens":22,"completion_tokens":8}})
        db=FakeDB()
        client=httpx.Client(transport=httpx.MockTransport(handler))
        specs=[{"name":"gemini","model":"gemini-2.5-flash","key":"fake","cap":2,"vision":True},
               {"name":"groq","model":"qwen/qwen3.8-27b","key":"fake","cap":2,"vision":True}]
        with patch("free_router.configured",return_value=specs):
            router=FreeRouter(db,client=client,now=lambda:datetime(2026,11,17,tzinfo=timezone.utc))
            result=router.call(pdf_bytes=b"unused",prompt="Test",schema=self.SCHEMA,
                     job_id="sample",stage="extraction",page_count=1,text_source="Source question")
        self.assertEqual(result,{"ok":True})
        self.assertEqual(router.last_provider,"groq")
        self.assertEqual(db.reservations,2)
        self.assertEqual(len(db.records),1)
        self.assertEqual(db.cooldowns[0]["provider"],"gemini")

    def test_independent_gemini_model_allowed_when_lite_extracted(self):
        class FakeDB:
            def __init__(self):
                self.table_name=None
                self.bucket=None
            def table(self,name):
                self.table_name=name
                return self
            def select(self,*args):return self
            def eq(self,*args):return self
            def single(self):return self
            def limit(self,*args):return self
            def rpc(self,name,args):
                self.table_name=name
                self.bucket=args.get("p_provider")
                return self
            def insert(self,*args):return self
            def execute(self):
                if self.table_name=="ai_import_jobs":
                    return SimpleNamespace(data={"file_name":"surgery_test_book_1.pdf"})
                if self.table_name=="ai_reserve_free_provider_request":
                    return SimpleNamespace(data=True)
                return SimpleNamespace(data=[])
        called_models=[]
        def handler(req):
            called_models.append(str(req.url))
            return httpx.Response(200,json={
                "candidates":[{"content":{"parts":[{"text":json.dumps({"ok":True})}]}}],
                "usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":8}
            })
        sources=[
            {"name":"gemini","model":"gemini-3.5-flash-lite","key":"fake",
             "cap":30,"vision":True,"bucket":"gemini"},
            {"name":"gemini","model":"gemini-3.1-flash-lite","key":"fake",
             "cap":30,"vision":True,"bucket":"gemini_flash"},
        ]
        with patch("free_router.configured",return_value=sources):
            router=FreeRouter(FakeDB(),client=httpx.Client(
                transport=httpx.MockTransport(handler)))
            result=router.call(pdf_bytes=b"source",prompt="Audit",schema=self.SCHEMA,
                job_id="id",stage="verification",page_count=2,
                text_source="Printed answer evidence",exclude_provider="gemini")
        self.assertEqual(result,{"ok":True})
        self.assertEqual(router.last_provider,"gemini_flash")
        self.assertEqual(len(called_models),1)
        self.assertIn("gemini-3.1-flash-lite",called_models[0])

    def test_independent_audit_refuses_same_only_provider(self):
        class FakeDB:
            def table(self,name):return self
            def select(self,*args):return self
            def eq(self,*args):return self
            def single(self):return self
            def execute(self):return SimpleNamespace(data={"file_name":"surgery_test_book_1.pdf"})
        p={"name":"gemini","model":"gemini-2.5-flash","key":"fake","cap":2,"vision":True}
        with patch("free_router.configured",return_value=[p]):
            router=FreeRouter(FakeDB())
            with self.assertRaises(ProvidersUnavailable):
                router.call(pdf_bytes=b"unused",prompt="Test",schema=self.SCHEMA,
                            job_id="sample",stage="verification",page_count=1,
                            text_source="Source",exclude_provider="gemini")

if __name__ == "__main__":unittest.main()
