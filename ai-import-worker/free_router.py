"""Free-first Quizard provider routing: no paid API fallback or quota evasion."""
import os
import json
import base64
import logging
from datetime import datetime,timezone,timedelta
import httpx
import fitz
from jsonschema import validate, ValidationError

LOG=logging.getLogger("quizard-free-router")
SYNTHETIC={"surgery_test_book_1.pdf","surgery_test_book_2.pdf",
           "gynecology_test_book_1.pdf","gynecology_test_book_2.pdf"}

class ProvidersUnavailable(RuntimeError):
    def __init__(self,reason,retry_seconds=3600):
        super().__init__(reason)
        # Retries are bounded by actual Retry-After/provider limits, not an
        # arbitrary 5-minute floor after short temporary service outages.
        self.retry_seconds=max(45,min(86400,int(retry_seconds)))

class ProviderFault(RuntimeError):
    def __init__(self,name,status,retry_seconds=3600):
        super().__init__(name+" returned "+str(status))
        self.retry_seconds=retry_seconds
        self.status=status

def configured():
    definitions=[
      ("gemini","GEMINI_API_KEY","GEMINI_MODEL","gemini-2.5-flash",True),
      ("groq","GROQ_API_KEY","GROQ_MODEL","qwen/qwen3.8-27b",True),
      ("mistral","MISTRAL_API_KEY","MISTRAL_MODEL","mistral-small-latest",False),
      ("openrouter","OPENROUTER_API_KEY","OPENROUTER_MODEL","",False),
      ("cloudflare","CLOUDFLARE_API_TOKEN","CLOUDFLARE_MODEL",
       "@cf/meta/llama-3.1-8b-instruct",False)]
    result=[]
    for name,keyvar,modelvar,default,vision in definitions:
        key=os.getenv(keyvar,"").strip()
        model=os.getenv(modelvar,default).strip()
        try:cap=int(os.getenv(name.upper()+"_DAILY_REQUEST_CAP","0"))
        except ValueError:cap=0
        confirmed=os.getenv(name.upper()+"_FREE_CONFIRMED","").lower()=="true"
        if not (key and model and confirmed and cap>0):continue
        if name=="openrouter" and not model.endswith(":free"):continue
        if name=="cloudflare" and not os.getenv("CLOUDFLARE_ACCOUNT_ID"):continue
        result.append({"name":name,"key":key,"model":model,"cap":min(cap,100000),
                       "vision":vision,"bucket":name})
    # A second, independently trained Gemini model can verify Groq output
    # if Flash-Lite has a transient 503. The ACCOUNT and API key remain the
    # same, while usage obeys the separate model limit visible in AI Studio.
    # Never activate this backup without explicit free-tier confirmation.
    try: backup_cap=int(os.getenv("GEMINI_VERIFY_DAILY_REQUEST_CAP","0"))
    except ValueError:backup_cap=0
    backup_model=os.getenv("GEMINI_VERIFY_MODEL","").strip()
    backup_key=os.getenv("GEMINI_API_KEY","").strip()
    if (backup_key and backup_model and backup_cap>0
            and os.getenv("GEMINI_VERIFY_FREE_CONFIRMED","").lower()=="true"
            and backup_model!=os.getenv("GEMINI_MODEL","gemini-2.5-flash").strip()):
        result.append({"name":"gemini","key":backup_key,"model":backup_model,
                       "cap":min(backup_cap,100000),"vision":True,
                       "bucket":"gemini_flash"})
    order=os.getenv("FREE_PROVIDER_ORDER","gemini,groq,mistral,openrouter,cloudflare").split(",")
    result.sort(key=lambda p:(order.index(p["name"]) if p["name"] in order else len(order),
                              1 if p.get("bucket")=="gemini_flash" else 0))
    return result

def render_pages(pdf):
    doc=fitz.open(stream=pdf,filetype="pdf")
    try:
        if len(doc)>3:raise ValueError("Groq vision supports at most three PDF images per request")
        return [base64.b64encode(p.get_pixmap(
            matrix=fitz.Matrix(1.2,1.2),alpha=False).tobytes("jpeg",jpg_quality=70)
        ).decode("ascii") for p in doc]
    finally:doc.close()

def retry_seconds(headers,status):
    try:
        return min(86400,max(1,int(float(headers.get("retry-after","")))))
    except (ValueError,TypeError):
        # Temporary 503s are NOT exhausted daily credits. A 20-minute
        # cooldown needlessly stranded the pilot; 429s remain rate-limited.
        if status in (500,502,503,504):return 45
        if status==429:return 180
        return 21600

def request_provider(client,p,prompt,schema,pdf,stage):
    name=p["name"]
    full_prompt=prompt+"\nReturn only source-faithful JSON satisfying this schema:\n"+json.dumps(schema)
    headers={"Accept":"application/json"}
    output_cap={"metadata":1500,"extraction":12000,"verification":4500,"repair":12000}[stage]
    # Groq's free Qwen vision account can have an 8K TPM limit. Reserving
    # 12K output tokens alone would trigger HTTP 429 before generation.
    # A one-page batch (+one overlap page) keeps input image costs bounded.
    if name=="groq":
        output_cap=min(output_cap,{"metadata":1200,"extraction":2400,
                                   "verification":1800,"repair":2400}[stage])
    if name=="gemini":
        url="https://generativelanguage.googleapis.com/v1beta/models/"+p["model"]+":generateContent"
        headers["x-goog-api-key"]=p["key"]
        parts=[{"text":full_prompt}]
        if pdf:parts.append({"inline_data":{"mime_type":"application/pdf",
                                             "data":base64.b64encode(pdf).decode("ascii")}})
        body={"contents":[{"role":"user","parts":parts}],
              "generationConfig":{"responseMimeType":"application/json",
                                  "maxOutputTokens":output_cap,"temperature":0}}
    else:
        url={"groq":"https://api.groq.com/openai/v1/chat/completions",
             "mistral":"https://api.mistral.ai/v1/chat/completions",
             "openrouter":"https://openrouter.ai/api/v1/chat/completions",
             "cloudflare":"https://api.cloudflare.com/client/v4/accounts/"+
             os.getenv("CLOUDFLARE_ACCOUNT_ID","")+"/ai/v1/chat/completions"}[name]
        headers["Authorization"]="Bearer "+p["key"]
        content=full_prompt
        if pdf:
            if name!="groq":raise ValueError("No visual capability")
            content=[{"type":"text","text":full_prompt}]
            content += [{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+s}}
                        for s in render_pages(pdf)]
        body={"model":p["model"],"messages":[{"role":"user","content":content}],
              "temperature":0,"max_tokens":output_cap}
        if name in ("groq","mistral","openrouter"):
            body["response_format"]={"type":"json_object"}
    try:
        res=client.post(url,headers=headers,json=body)
    except httpx.RequestError as exc:
        raise ProviderFault(name,503,1200) from exc
    if res.status_code>=400:
        raise ProviderFault(name,res.status_code,retry_seconds(res.headers,res.status_code))
    try:
        data=res.json()
        if name=="gemini":
            result="".join(x.get("text","") for x in data["candidates"][0]["content"]["parts"])
            usage=data.get("usageMetadata",{})
            in_tokens=usage.get("promptTokenCount")
            out_tokens=usage.get("candidatesTokenCount")
        else:
            obj=data.get("result",data) if name=="cloudflare" else data
            result=obj["choices"][0]["message"]["content"]
            usage=obj.get("usage",{})
            in_tokens=usage.get("prompt_tokens")
            out_tokens=usage.get("completion_tokens")
        if not isinstance(result,str) or not result:raise ValueError("Empty response")
        result=result.strip()
        fence=chr(96)*3
        if result.startswith(fence):result=result.split("\n",1)[-1].rsplit(fence,1)[0].strip()
        parsed=json.loads(result)
        validate(parsed,schema)
        return parsed,in_tokens,out_tokens
    except (ValueError,KeyError,IndexError,TypeError,ValidationError) as exc:
        raise ProviderFault(name,422,1800) from exc

class FreeRouter:
    def __init__(self,db,client=None,now=None):
        self.db=db
        # Never let an unreliable free verifier leave a book in "processing"
        # indefinitely. A timed-out provider is cooled down, then another
        # eligible free model is tried; the extracted page remains checkpointed.
        self.client=client or httpx.Client(timeout=httpx.Timeout(65,connect=12))
        self.now=now or (lambda:datetime.now(timezone.utc))
        self.last_provider=None

    def call(self,*,pdf_bytes,prompt,schema,job_id,stage,page_count,text_source=None,
             exclude_provider=None):
        self.last_provider=None
        job=self.db.table("ai_import_jobs").select("file_name").eq("id",job_id).single().execute().data
        if not job:raise RuntimeError("Job missing")
        if (job["file_name"] not in SYNTHETIC and
            os.getenv("FREE_API_REAL_BOOKS_APPROVED","").lower()!="true"):
            raise ProvidersUnavailable("Real textbooks need explicit third-party sharing approval",86400)
        providers=configured()
        # Verification is a different MODEL from extraction, not necessarily
        # a different vendor account. Prefer the independently configured
        # Gemini Flash model for source-auditing, then the Lite model (when
        # it did not extract the candidate), then Groq. This avoids Groq's
        # particularly restrictive 8K tokens/minute vision verification cap.
        if stage=="verification":
            priority={"gemini_flash":0,"gemini":1,"groq":2}
            providers.sort(key=lambda p:priority.get(
                p.get("bucket",p["name"]),3))
        wait=[]
        for p in providers:
            name=p["name"]
            bucket=p.get("bucket",name)
            # Backup is restricted to verification and discrepancy repair.
            # A repaired transcript MUST undergo a separate new audit with
            # a different model; it cannot verify its own output.
            if bucket=="gemini_flash" and stage not in ("verification","repair"):continue
            # Do not re-use the SAME MODEL as extraction for the audit.
            # The original excluded the whole Gemini company, inadvertently
            # disabling the independently configured Gemini Flash verifier.
            if bucket==exclude_provider:continue
            if text_source is None and not p["vision"]:continue
            if text_source is None and name=="groq" and page_count>3:continue
            states=self.db.table("ai_import_provider_state").select("cooldown_until").eq(
                "provider",bucket).limit(1).execute().data or []
            if states and states[0].get("cooldown_until"):
                until=datetime.fromisoformat(states[0]["cooldown_until"].replace("Z","+00:00"))
                if until>self.now():
                    wait.append((until-self.now()).total_seconds())
                    continue
            reserved=self.db.rpc("ai_reserve_free_provider_request",{
                "p_provider":bucket,"p_max_calls":p["cap"]}).execute().data
            if not reserved:
                next_day=datetime.combine(self.now().date()+timedelta(days=1),
                                          datetime.min.time(),timezone.utc)
                wait.append((next_day-self.now()).total_seconds())
                continue
            text=prompt if text_source is None else prompt+"\nORIGINAL PDF SOURCE TEXT:\n"+text_source
            try:
                data,ins,outs=request_provider(self.client,p,text,schema,
                                               pdf_bytes if text_source is None else None,stage)
                self.db.table("ai_import_provider_calls").insert({
                    "job_id":job_id,"provider":name,"model":p["model"],"stage":stage,
                    "input_tokens":ins,"output_tokens":outs}).execute()
                self.last_provider=bucket
                LOG.info("Free provider completed %s model %s stage %s",
                         name,p["model"],stage)
                return data
            except ProviderFault as exc:
                LOG.warning("Free provider %s model %s failed for stage %s status %s",
                            name,p["model"],stage,exc.status)
                until=(self.now()+timedelta(seconds=exc.retry_seconds)).isoformat()
                self.db.table("ai_import_provider_state").upsert({
                    "provider":bucket,"cooldown_until":until,
                    "last_error":(p["model"]+" "+str(exc))[:190],
                    "updated_at":self.now().isoformat()},on_conflict="provider").execute()
                wait.append(exc.retry_seconds)
        reason="No eligible free provider currently available for "+stage
        if exclude_provider:reason+="; independent verification requires a different model"
        if not providers:reason="No confirmed free providers configured; add keys and daily limits in Railway"
        raise ProvidersUnavailable(reason,min(wait,default=21600))
