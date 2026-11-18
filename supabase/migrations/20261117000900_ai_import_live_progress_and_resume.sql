-- Quizard pilot: preserve successful text extraction ahead of independent
-- verification; make stalled on-demand jobs safely recoverable after worker death.
-- No bypass of independent medical source verification or free quotas.

alter table public.ai_import_batches
  drop constraint if exists ai_import_batches_status_check;
alter table public.ai_import_batches
  add constraint ai_import_batches_status_check
  check (status in ('extracted','verified','needs_review'));

alter table public.ai_import_batches
  add column if not exists extraction_provider text;

alter table public.ai_import_jobs
  add column if not exists progress_note text;

create or replace function public.ai_issue_import_dispatch_token(p_job_id uuid)
returns uuid language plpgsql security invoker set search_path=public as $$
declare issued uuid;
begin
  if not exists (
    select 1 from public.ai_import_jobs
    where id=p_job_id
      and provider_mode='free_only'
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
end $$;

create or replace function public.ai_claim_import_job_by_id(p_job_id uuid)
returns public.ai_import_jobs
language plpgsql security invoker set search_path=public as $$
declare j public.ai_import_jobs;
begin
  select * into j from public.ai_import_jobs
  where id=p_job_id
    and provider_mode='free_only'
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
end $$;

revoke all on function public.ai_issue_import_dispatch_token(uuid)
 from public,anon,authenticated;
revoke all on function public.ai_claim_import_job_by_id(uuid)
 from public,anon,authenticated;
grant execute on function public.ai_issue_import_dispatch_token(uuid) to service_role;
grant execute on function public.ai_claim_import_job_by_id(uuid) to service_role;