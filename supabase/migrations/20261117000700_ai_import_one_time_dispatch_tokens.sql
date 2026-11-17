-- Secure on-demand dispatch without assuming the Supabase Edge Function and
-- Railway use identical literal SUPABASE_SERVICE_ROLE_KEY values.
-- The authenticated super-admin Edge Function issues a one-time token through
-- service_role; the Railway service consumes it through service_role.
-- No service-role secret is exposed over HTTP to Railway or a browser.

create table if not exists public.ai_import_dispatch_tokens (
  token uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_import_jobs(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 seconds'),
  consumed_at timestamptz
);

create index if not exists ai_import_dispatch_tokens_job_idx
  on public.ai_import_dispatch_tokens(job_id,expires_at);

alter table public.ai_import_dispatch_tokens enable row level security;
revoke all on public.ai_import_dispatch_tokens from public,anon,authenticated;
grant select,insert,update,delete on public.ai_import_dispatch_tokens to service_role;

create or replace function public.ai_issue_import_dispatch_token(p_job_id uuid)
returns uuid
language plpgsql security invoker set search_path=public
as $$
declare
  issued uuid;
begin
  if not exists (
    select 1 from public.ai_import_jobs
    where id=p_job_id
      and provider_mode='free_only'
      and (
        status='queued'
        or (status='waiting_provider' and next_attempt_at<=now())
      )
  ) then
    return null;
  end if;

  -- Random 128-bit value, one-time and short-lived.
  insert into public.ai_import_dispatch_tokens(job_id)
  values(p_job_id)
  returning token into issued;
  return issued;
end $$;

create or replace function public.ai_consume_import_dispatch_token(
    p_job_id uuid, p_token uuid)
returns boolean
language plpgsql security invoker set search_path=public
as $$
declare
  result uuid;
begin
  update public.ai_import_dispatch_tokens
     set consumed_at=now()
   where token=p_token
     and job_id=p_job_id
     and consumed_at is null
     and expires_at > now()
  returning token into result;
  return result is not null;
end $$;

revoke all on function public.ai_issue_import_dispatch_token(uuid) from public,anon,authenticated;
revoke all on function public.ai_consume_import_dispatch_token(uuid,uuid) from public,anon,authenticated;
grant execute on function public.ai_issue_import_dispatch_token(uuid) to service_role;
grant execute on function public.ai_consume_import_dispatch_token(uuid,uuid) to service_role;

comment on table public.ai_import_dispatch_tokens is
  'Single-use 90-second dispatch authorization. Only the service role may issue or consume; never grant browser access.';