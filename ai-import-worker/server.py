"""On-demand Quizard worker, started by an authenticated super-admin action.

The Edge Function creates a one-use 90-second dispatch token in Supabase.
This Railway service consumes that token atomically through Supabase before it
claims exactly one job. No shared signing key, API key or login token is sent
over the public HTTP endpoint. Real-book sharing restrictions and free-only
provider rules are enforced separately inside the importer.
"""
import json
import logging
import os
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import UUID

from worker import (
    DB, BudgetExceeded, ProvidersUnavailable, update_job,
    normalize_claimed_job, process_job,
)

LOG = logging.getLogger("quizard-import-on-demand")
ACTIVE = threading.Lock()


def valid_dispatch_identifiers(job_id: str, token: str) -> bool:
    """Accept only canonical UUID strings, so RPC inputs are predictable."""
    try:
        return (str(UUID(job_id)) == job_id.lower()
                and str(UUID(token)) == token.lower())
    except (ValueError, AttributeError, TypeError):
        return False


def heartbeat(job_id, stop):
    """Maintain a live claim while the model is responding.

    If Railway restarts or the process dies, this heartbeat stops. Only then
    can the admin recover the same job after the stale-claim timeout.
    """
    while not stop.wait(15):
        try:
            moment=datetime.now(timezone.utc).isoformat()
            DB.table("ai_import_jobs").update({
                "worker_lock_at":moment,"updated_at":moment
            }).eq("id",job_id).eq("status","processing").execute()
        except Exception:
            LOG.exception("Worker heartbeat failed job=%s",job_id)


def execute_one(job):
    job_id = job["id"]
    stop=threading.Event()
    thread=threading.Thread(target=heartbeat,args=(job_id,stop),daemon=True)
    thread.start()
    try:
        LOG.info("On-demand processing started job_id=%s", job_id)
        try:
            process_job(job)
        except BudgetExceeded as exc:
            update_job(job_id, status="paused_budget", last_error=str(exc)[:500])
        except ProvidersUnavailable as exc:
            update_job(
                job_id, status="waiting_provider",
                next_attempt_at=(datetime.now(timezone.utc)
                                 + timedelta(seconds=exc.retry_seconds)).isoformat(),
                last_error=str(exc)[:500],
            )
        except Exception as exc:
            LOG.error("On-demand job failed id=%s error=%s\n%s",
                      job_id, exc, traceback.format_exc())
            update_job(job_id, status="failed", last_error=str(exc)[:500])
    finally:
        stop.set()
        ACTIVE.release()


def auto_resume_loop():
    """Resume free jobs and explicitly authorized OpenAI-only book imports.

    Paid jobs exist only after per-book super-admin consent and estimated
    budget confirmation. Legacy paid jobs are excluded. Remaining budget is
    checked again before EVERY OpenAI request by the worker.
    """
    while True:
        if ACTIVE.acquire(blocking=False):
            started=False
            try:
                now=datetime.now(timezone.utc)
                current=now.isoformat()
                waiting=DB.table("ai_import_jobs").select("id").eq(
                    "provider_mode",["free_only","openai_only"]).eq("status","waiting_provider").lte(
                    "next_attempt_at",current).order("next_attempt_at").limit(1).execute().data or []
                queued=DB.table("ai_import_jobs").select("id").eq(
                    "provider_mode",["free_only","openai_only"]).eq("status","queued").order(
                    "created_at").limit(1).execute().data or []
                stale=DB.table("ai_import_jobs").select("id").eq(
                    "provider_mode",["free_only","openai_only"]).eq("status","processing").lt(
                    "worker_lock_at",(now-timedelta(minutes=3)).isoformat()
                ).order("updated_at").limit(1).execute().data or []
                candidate=(waiting or queued or stale)
                if candidate:
                    job_id=candidate[0]["id"]
                    claimed=DB.rpc("ai_claim_import_job_by_id",{
                        "p_job_id":job_id}).execute()
                    job=normalize_claimed_job(claimed.data)
                    if job:
                        LOG.info("Auto-resuming consented import job %s",job_id)
                        threading.Thread(target=execute_one,args=(job,),daemon=True).start()
                        started=True
            except Exception:
                LOG.exception("On-demand automatic resume check failed")
            finally:
                if not started:ACTIVE.release()
        time.sleep(20)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Never print auth headers, request body, or private credentials.
        LOG.info("HTTP %s", format % args)

    def respond(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.respond(200, {"ok": True, "busy": ACTIVE.locked()})
        return self.respond(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/run":
            return self.respond(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 2 or size > 2048:
                return self.respond(400, {"error": "Invalid request size"})
            payload = json.loads(self.rfile.read(size))
            job_id = str(payload.get("job_id", ""))
            token = str(payload.get("dispatch_token", ""))
            if not valid_dispatch_identifiers(job_id, token):
                return self.respond(401, {"error": "Invalid dispatch authorization"})
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.respond(400, {"error": "Malformed request"})

        if not ACTIVE.acquire(blocking=False):
            return self.respond(409, {"error": "Worker is processing another book"})
        try:
            consumed = DB.rpc("ai_consume_import_dispatch_token", {
                "p_job_id": job_id, "p_token": token,
            }).execute().data
            if consumed is not True:
                ACTIVE.release()
                return self.respond(401, {"error": "Dispatch token expired or already used"})

            # Claim before confirming success to the admin. If the job was
            # cancelled or another process claimed it, respond with 409.
            claimed = DB.rpc("ai_claim_import_job_by_id", {
                "p_job_id": job_id,
            }).execute()
            job = normalize_claimed_job(claimed.data)
            if job is None:
                ACTIVE.release()
                return self.respond(409, {
                    "error": "Book is not eligible (already processing, cancelled or waiting for provider cooldown)"
                })
            threading.Thread(target=execute_one, args=(job,), daemon=True).start()
        except Exception:
            ACTIVE.release()
            LOG.exception("Secure dispatch failed for job %s", job_id)
            return self.respond(503, {"error": "Unable to start this job; try again"})

        return self.respond(202, {"accepted": True, "job_id": job_id})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    LOG.info("Quizard AI on-demand HTTP worker ready on port %s", port)
    threading.Thread(target=auto_resume_loop,daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
