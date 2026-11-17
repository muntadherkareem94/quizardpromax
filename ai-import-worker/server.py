"""Authenticated on-demand Quizard importer for the admin "Process Now" button.

No OpenAI payment keys are ever exposed to the browser.
Supabase Edge Function authenticates the super-admin, signs a short-lived
request using its existing service-role secret, then calls this endpoint.
The Railway worker verifies the signature and atomically claims that job.
This app does not process other users' queued books opportunistically.
"""
import hashlib
import hmac
import json
import logging
import os
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from worker import (
    DB, BudgetExceeded, ProvidersUnavailable, update_job,
    normalize_claimed_job, process_job
)

LOG = logging.getLogger("quizard-import-on-demand")
SECRET = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ACTIVE = threading.Lock()


def valid_signature(job_id: str, timestamp: str, signature: str, now=None) -> bool:
    """Fresh signed request; never transmit or log the shared service-role key."""
    try:
        timestamp_int = int(timestamp)
        instant = int(time.time() if now is None else now)
        if abs(instant - timestamp_int) > 90:
            return False
        if len(job_id) != 36 or any(c not in "0123456789abcdef-" for c in job_id.lower()):
            return False
        if len(signature) != 64:
            return False
        message = f"{job_id}:{timestamp}".encode()
        expected = hmac.new(SECRET.encode(),message,hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected,signature.lower())
    except (TypeError,ValueError):
        return False


def execute_one(job_id):
    try:
        claimed = DB.rpc("ai_claim_import_job_by_id",{"p_job_id":job_id}).execute()
        job = normalize_claimed_job(claimed.data)
        if job is None:
            LOG.info("Job not eligible for on-demand claim (cancelled, busy or cooldown)")
            return
        LOG.info("On-demand processing started job_id=%s",job_id)
        try:
            process_job(job)
        except BudgetExceeded as exc:
            update_job(job_id,status="paused_budget",last_error=str(exc)[:500])
        except ProvidersUnavailable as exc:
            update_job(job_id,status="waiting_provider",
                next_attempt_at=(datetime.now(timezone.utc)+
                                 timedelta(seconds=exc.retry_seconds)).isoformat(),
                last_error=str(exc)[:500])
        except Exception as exc:
            LOG.error("On-demand job failed id=%s error=%s\n%s",
                      job_id,exc,traceback.format_exc())
            update_job(job_id,status="failed",last_error=str(exc)[:500])
    except Exception:
        LOG.exception("On-demand worker could not claim job %s",job_id)
    finally:
        ACTIVE.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self,format,*args):
        # Avoid printing authorization headers, cookies or request bodies.
        LOG.info("HTTP %s",format % args)

    def respond(self,status,body):
        data=json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type","application/json")
        self.send_header("Cache-Control","no-store")
        self.send_header("Content-Length",str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.respond(200,{"ok":True,"busy":ACTIVE.locked()})
        return self.respond(404,{"error":"Not found"})

    def do_POST(self):
        if self.path != "/run":
            return self.respond(404,{"error":"Not found"})
        try:
            size=int(self.headers.get("Content-Length","0"))
            if size<2 or size>2048:
                return self.respond(400,{"error":"Invalid request size"})
            payload=json.loads(self.rfile.read(size))
            job_id=str(payload.get("job_id",""))
            timestamp=str(self.headers.get("X-Quizard-Timestamp",""))
            signature=str(self.headers.get("X-Quizard-Signature",""))
            if not valid_signature(job_id,timestamp,signature):
                return self.respond(401,{"error":"Unauthorized"})
        except (ValueError,TypeError,json.JSONDecodeError):
            return self.respond(400,{"error":"Malformed request"})
        if not ACTIVE.acquire(blocking=False):
            return self.respond(409,{"error":"Worker busy with another book"})
        try:
            threading.Thread(target=execute_one,args=(job_id,),daemon=True).start()
        except Exception:
            ACTIVE.release()
            raise
        return self.respond(202,{"accepted":True,"job_id":job_id})


if __name__=="__main__":
    port=int(os.environ.get("PORT","8080"))
    LOG.info("Quizard AI on-demand HTTP worker ready on port %s",port)
    ThreadingHTTPServer(("0.0.0.0",port),Handler).serve_forever()
