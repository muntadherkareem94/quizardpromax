-- The authenticated admin may request processing of one specific import.
-- This RPC is service-role only and atomically claims precisely that job.
-- It never bypasses a provider cooldown or a cancelled/published job.

create or replace function public.ai_claim_import_job_by_id(p_job_id uuid)
returns public.ai_import_jobs
language plpgsql
security invoker
set search_path=public
as $$
declare j public.ai_import_jobs;
begin
  select * into j
    from public.ai_import_jobs
    where id=p_job_id
      and (
        status='queued'
        or (status='waiting_provider' and next_attempt_at<=now())
      )
    for update skip locked;
  if j.id is null then return null; end if;

  update public.ai_import_jobs
     set status='processing', worker_lock_at=now(),
         next_attempt_at=null,attempts=attempts+1,
         last_error=null,updated_at=now()
   where id=j.id returning * into j;
  return j;
end $$;

revoke all on function public.ai_claim_import_job_by_id(uuid)
  from public,anon,authenticated;
grant execute on function public.ai_claim_import_job_by_id(uuid) to service_role;