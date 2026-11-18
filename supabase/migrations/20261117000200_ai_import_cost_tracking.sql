-- Isolated per-book API cost tracking; no changes to existing Quizard books,
-- subscriptions, users, or questions. Amounts are ESTIMATES using published
-- token prices, not provider invoices. Does not implement a billing hard cap.

alter table public.ai_import_jobs
  add column if not exists budget_usd numeric(10,4) not null default 0.7500,
  add column if not exists api_spend_estimate_usd numeric(14,6) not null default 0,
  add column if not exists api_input_tokens bigint not null default 0,
  add column if not exists api_output_tokens bigint not null default 0,
  add column if not exists api_request_count integer not null default 0;

alter table public.ai_import_jobs
  drop constraint if exists ai_import_jobs_budget_usd_check;
alter table public.ai_import_jobs
  add constraint ai_import_jobs_budget_usd_check
  check (budget_usd >= 0.20 and budget_usd <= 5.00);

alter table public.ai_import_jobs
  drop constraint if exists ai_import_jobs_status_check;
alter table public.ai_import_jobs
  add constraint ai_import_jobs_status_check
  check (status in ('uploading','queued','processing','needs_review','ready',
                   'publishing','published','failed','cancelled','paused_budget'));

create table if not exists public.ai_import_api_calls (
    id uuid primary key default gen_random_uuid(),
    job_id uuid not null references public.ai_import_jobs(id) on delete cascade,
    response_id text not null unique,
    stage text not null check (stage in ('metadata','extraction','verification','repair')),
    model text not null,
    service_tier text not null,
    input_tokens bigint not null check (input_tokens >= 0),
    output_tokens bigint not null check (output_tokens >= 0),
    cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
    estimated_cost_usd numeric(14,8) not null check (estimated_cost_usd >= 0),
    created_at timestamptz not null default now()
);

create index if not exists ai_import_api_calls_job_idx
  on public.ai_import_api_calls(job_id,created_at);

alter table public.ai_import_api_calls enable row level security;
drop policy if exists ai_calls_full_admin_read on public.ai_import_api_calls;
create policy ai_calls_full_admin_read on public.ai_import_api_calls
  for select to authenticated using ((select public.is_admin()));
revoke all on public.ai_import_api_calls from public,anon,authenticated;
grant select on public.ai_import_api_calls to authenticated;
grant select,insert,update,delete on public.ai_import_api_calls to service_role;

create or replace function public.ai_import_account_api_call()
returns trigger language plpgsql security invoker set search_path=public
as $$
begin
  update public.ai_import_jobs
     set api_spend_estimate_usd = api_spend_estimate_usd + new.estimated_cost_usd,
         api_input_tokens = api_input_tokens + new.input_tokens,
         api_output_tokens = api_output_tokens + new.output_tokens,
         api_request_count = api_request_count + 1,
         updated_at = now()
   where id=new.job_id;
  if not found then raise exception 'AI import job missing'; end if;
  return new;
end $$;

drop trigger if exists ai_import_api_calls_account_insert on public.ai_import_api_calls;
create trigger ai_import_api_calls_account_insert
after insert on public.ai_import_api_calls
for each row execute function public.ai_import_account_api_call();

-- Older jobs keep default zero cost because their historical API calls were not
-- tracked; the interface explicitly labels costs as "tracked since update".