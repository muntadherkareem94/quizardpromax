-- OpenAI-only jobs are authorized per book by super-admin upload.
ALTER TABLE public.ai_import_jobs DROP CONSTRAINT ai_import_jobs_provider_mode_check;
ALTER TABLE public.ai_import_jobs ADD CONSTRAINT ai_import_jobs_provider_mode_check
 CHECK (provider_mode IN ('legacy','free_only','openai_only'));
ALTER TABLE public.ai_import_jobs DROP CONSTRAINT ai_import_jobs_budget_usd_check;
ALTER TABLE public.ai_import_jobs ADD CONSTRAINT ai_import_jobs_budget_usd_check
 CHECK (budget_usd>=0.20 AND budget_usd<=25.00);
CREATE OR REPLACE FUNCTION public.ai_claim_import_job()
 RETURNS ai_import_jobs
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare j public.ai_import_jobs;
begin
  select * into j from public.ai_import_jobs
  where provider_mode='free_only' and (status='queued'
    or (status='waiting_provider' and next_attempt_at <= now())
    or (status='processing' and worker_lock_at < now() - interval '90 minutes'))
  order by case status when 'queued' then 0 when 'waiting_provider' then 1 else 2 end,
           created_at
  for update skip locked limit 1;
  if j.id is null then return null; end if;
  update public.ai_import_jobs
    set status='processing', worker_lock_at=now(),next_attempt_at=null,
        attempts=attempts+1,last_error=null,updated_at=now()
  where id=j.id returning * into j;
  return j;
end $function$
;

CREATE OR REPLACE FUNCTION public.ai_claim_import_job_by_id(p_job_id uuid)
 RETURNS ai_import_jobs
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare j public.ai_import_jobs;
begin
  select * into j from public.ai_import_jobs
  where id=p_job_id
    and provider_mode in ('free_only','openai_only')
    and (
      status='queued'
      or (status='waiting_provider' and next_attempt_at<=now())
      or (status='processing' and worker_lock_at<now()-interval '3 minutes')
    )
  for update skip locked;
  if j.id is null then return null; end if;
  update public.ai_import_jobs
    set status='processing',worker_lock_at=now(),
        next_attempt_at=null,attempts=attempts+1,
        last_error=null,progress_note='Worker started; loading source PDF',
        updated_at=now()
  where id=j.id
  returning * into j;
  return j;
end $function$
;

CREATE OR REPLACE FUNCTION public.ai_issue_import_dispatch_token(p_job_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare issued uuid;
begin
  if not exists (
    select 1 from public.ai_import_jobs
    where id=p_job_id
      and provider_mode in ('free_only','openai_only')
      and (
         status='queued'
         or (status='waiting_provider' and next_attempt_at<=now())
         -- Recovery is safe only if the 15-second worker heartbeat died.
         or (status='processing' and worker_lock_at<now()-interval '3 minutes')
      )
  ) then return null; end if;
  insert into public.ai_import_dispatch_tokens(job_id) values(p_job_id)
  returning token into issued;
  return issued;
end $function$
;
REVOKE EXECUTE ON FUNCTION public.ai_issue_import_dispatch_token(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ai_issue_import_dispatch_token(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public.ai_claim_import_job_by_id(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ai_claim_import_job_by_id(uuid) TO service_role;
