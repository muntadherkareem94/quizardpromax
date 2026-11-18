"""Offline tests of joint question/answer context and paid-call behavior."""
import unittest
from types import SimpleNamespace
import fitz

from ai_source_context import paired_source_batches
from ai_paired_worker import process_paired_openai_section


def paired_sample():
    doc=fitz.open()
    pg=doc.new_page()
    for y,s in [(50,"Practice Paper 1: Questions"),
                (90,"1. CARDIOLOGY CASE (1)"),
                (125,"A patient has palpitations."),
                (150,"A. First choice"),(175,"B. Second choice"),
                (230,"2. SURGERY CASE (1)"),
                (260,"A second patient's question."),
                (285,"A. Third choice"),(310,"B. Fourth choice")]:
        pg.insert_text((60,y),s)
    pg=doc.new_page()
    for y,s in [(50,"3. ENDOCRINOLOGY CASE (1)"),
                (80,"A third clinical question."),
                (110,"A. Fifth choice"),(140,"B. Sixth choice")]:
        pg.insert_text((60,y),s)
    pg=doc.new_page()
    for y,s in [(50,"Practice Paper 1: Answers"),(100,"1. CARDIOLOGY CASE (1)"),
                (135,"B – Second choice"),(160,"Explanation 1."),
                (200,"2. SURGERY CASE (1)"),(230,"A – Third choice"),
                (265,"Explanation 2.")]:
        pg.insert_text((60,y),s)
    pg=doc.new_page()
    for y,s in [(50,"3. ENDOCRINOLOGY CASE (1)"),(90,"B – Sixth choice"),
                (125,"Explanation 3.")]:
        pg.insert_text((60,y),s)
    section=dict(section_index=1,title="Practice Paper 1",start_page=1,end_page=4,
                 question_start=1,question_end=2,
                 answer_start=3,answer_end=4)
    return doc,section


class SourceContextTests(unittest.TestCase):
    def test_batches_include_matching_answer_and_question_pages(self):
        doc,sec=paired_sample()
        try:
            batches,issues=paired_source_batches(doc,sec,question_page_batch=1)
            self.assertEqual(issues,[])
            self.assertEqual(len(batches),2)
            self.assertEqual(batches[0]["numbers"],[1,2])
            self.assertEqual(batches[1]["numbers"],[3])
            self.assertEqual(batches[0]["question_pages"],[1,2])
            self.assertIn(3,batches[0]["answer_pages"])
            self.assertIn(4,batches[1]["answer_pages"])
            self.assertIn("original PDF page 4",batches[1]["page_label"])
        finally: doc.close()

    def test_answer_page_was_not_found_and_no_content_was_invented(self):
        doc,sec=paired_sample()
        doc.delete_page(3)
        sec["end_page"]=3
        sec["answer_end"]=3
        try:
            batches,issues=paired_source_batches(doc,sec,question_page_batch=1)
            self.assertEqual(len(batches),2)
            self.assertTrue(any(i["type"]=="missing_answer_page_anchor" and
                                3 in i["numbers"] for i in issues))
            self.assertEqual(batches[1]["answer_pages"],[])
        finally: doc.close()

    def test_ai_joint_context_has_one_extraction_and_one_audit(self):
        doc,sec=paired_sample()
        class DB:
            def __init__(self):
                self.rows={}
                self.filters={}
                self.pending=None
            def table(self,name):
                self.name=name
                self.filters={}
                return self
            def select(self,*args):
                return self
            def eq(self,key,value):
                self.filters[key]=value
                return self
            def execute(self):
                if self.pending is not None:
                    self.rows[(self.name,self.pending.get("start_page",0))]=self.pending
                    self.pending=None
                    return SimpleNamespace(data=[])
                if self.name=="ai_import_batches":
                    row=self.rows.get((self.name,self.filters.get("start_page")))
                    return SimpleNamespace(data=[row] if row else [])
                return SimpleNamespace(data=[])
            def upsert(self,data,**kwargs):
                self.pending=data
                return self
        db=DB()
        calls=[]
        originals={
            1:{"questionNumber":1,"sourcePage":1,"question":"First question",
               "options":["One","Two"],"correctAnswerIndex":1,
               "explanation":"Explained 1","answerEvidence":"original answer page 3",
               "figureInQuestion":False,"figureInExplanation":False},
            2:{"questionNumber":2,"sourcePage":1,"question":"Second question",
               "options":["One","Two"],"correctAnswerIndex":0,
               "explanation":"Explained 2","answerEvidence":"original answer page 3",
               "figureInQuestion":False,"figureInExplanation":False},
            3:{"questionNumber":3,"sourcePage":2,"question":"Third question",
               "options":["One","Two"],"correctAnswerIndex":1,
               "explanation":"Explained 3","answerEvidence":"original answer page 4",
               "figureInQuestion":False,"figureInExplanation":False},
        }
        def model_call(data,prompt,schema,name,model,**kwargs):
            calls.append(kwargs["stage"])
            if kwargs["stage"]=="extraction":
                numbers=[int(s) for s in prompt.split("Target printed QUESTION NUMBERS: ")[1].split("\n")[0].split(", ")]
                self.assertIn("matching answer",prompt.lower())
                self.assertIn("original PDF page",prompt)
                return {"questions":[originals[n] for n in numbers]}
            if kwargs["stage"]=="verification":
                targets=[int(s) for s in prompt.split("TARGET printed question numbers ")[1].split(" matter")[0].split(", ")]
                return {"questionNumbersInSource":targets,"issues":[]}
            raise AssertionError("An unplanned repair API request was attempted")
        try:
            result=process_paired_openai_section(
                doc,{"id":"synthetic"},sec,[],
                db=db,run_structured=model_call,
                update_job=lambda *args,**kwargs:None,
                attach_figures=lambda *args:[],
                validate_question=lambda *args:[],
                to_json_question=lambda x:x,model="test-model",verify_model="test-model",
                extraction_schema={},verification_schema={},pages_per_batch=1)
            self.assertEqual(result["status"],"verified",result["issues"])
            self.assertEqual(len(result["questions"]),3)
            self.assertEqual(calls,["extraction","verification"]*2)
            # Checkpoints must prevent charges on a normal resume.
            process_paired_openai_section(
                doc,{"id":"synthetic"},sec,[],
                db=db,run_structured=model_call,
                update_job=lambda *args,**kwargs:None,
                attach_figures=lambda *args:[],
                validate_question=lambda *args:[],
                to_json_question=lambda x:x,model="test-model",verify_model="test-model",
                extraction_schema={},verification_schema={},pages_per_batch=1)
            self.assertEqual(len(calls),4)
        finally: doc.close()


if __name__=="__main__":
    unittest.main()
