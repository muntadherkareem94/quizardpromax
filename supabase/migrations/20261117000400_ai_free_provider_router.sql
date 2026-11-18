-- Free-provider router state. Isolated from existing paid books and subscribers.
-- Only service_role may reserve provider calls / change cooldowns.

create table if not exists public.ai_import_provider_daily (
  provider text not null check (provider in ('gemini','groq','mistral','openrouter','cloudflare')),
  quota_date date not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (provider, quota_date)
);
create table if not exists public.ai_import_provider_state (
  provider text primary key check (provider in ('gemini','groq','mistral','openrouter','cloudflare')),
  cooldown_until timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
create table if not exists public.ai_import_provider_calls (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_import_jobs(id) on delete cascade,
  provider text not null check (provider in ('gemini','groq','mistral','openrouter','cloudflare')),
  model text not null,
  stage text not null check (stage in ('metadata','extraction','verification','repair')),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  created_at timestamptz not null default now()
);
create index if not exists ai_import_provider_calls_job_idx
  on public.ai_import_provider_calls(job_id,created_at);

alter table public.ai_import_provider_daily enable row level security;
alter table public.ai_import_provider_state enable row level security;
alter table public.ai_import_provider_calls enable row level security;
revoke all on public.ai_import_provider_daily, public.ai_import_provider_state,
              public.ai_import_provider_calls from public, anon, authenticated;
grant select,insert,update,delete on public.ai_import_provider_daily,
      public.ai_import_provider_state, public.ai_import_provider_calls to service_role;
grant select on public.ai_import_provider_calls to authenticated;
drop policy if exists ai_provider_calls_admin_select on public.ai_import_provider_calls;
create policy ai_provider_calls_admin_select on public.ai_import_provider_calls
  for select to authenticated using ((select public.is_admin()));

alter table public.ai_import_jobs add column if not exists next_attempt_at timestamptz;
alter table public.ai_import_jobs add column if not exists provider_mode text not null default 'legacy'
  check (provider_mode in ('legacy','free_only'));
alter table public.ai_import_jobs drop constraint if exists ai_import_jobs_status_check;
alter table public.ai_import_jobs add constraint ai_import_jobs_status_check
  check (status in ('uploading','queued','processing','needs_review','ready',
                   'publishing','published','failed','cancelled','paused_budget','waiting_provider'));

-- Atomic conservative daily-cap reservation, with no bypass or alternate accounts.
create or replace function public.ai_reserve_free_provider_request(p_provider text,p_max_calls integer)
returns boolean language plpgsql security invoker set search_path=public as $$
declare n integer;
begin
  if p_provider not in ('gemini','groq','mistral','openrouter','cloudflare')
     or p_max_calls < 1 or p_max_calls > 100000 then
     raise exception 'Invalid free provider cap';
  end if;
  insert into public.ai_import_provider_daily(provider,quota_date,request_count)
    values(p_provider,(now() at time zone 'utc')::date,1)
  on conflict (provider,quota_date) do update
    set request_count=public.ai_import_provider_daily.request_count+1,
        updated_at=now()
    where public.ai_import_provider_daily.request_count < p_max_calls
  returning request_count into n;
  return n is not null;
end $$;
revoke all on function public.ai_reserve_free_provider_request(text,integer)
 from public,anon,authenticated;
grant execute on function public.ai_reserve_free_provider_request(text,integer) to service_role;

-- Waiting jobs are claimable when their retry time arrives; queued jobs first.
-- No new public API for accessing private source PDFs.
create or replace function public.ai_claim_import_job()
returns public.ai_import_jobs
language plpgsql security invoker set search_path=public as $$
declare j public.ai_import_jobs;
begin
  select * into j from public.ai_import_jobs
  where status='queued'
    or (status='waiting_provider' and next_attempt_at <= now())
    or (status='processing' and worker_lock_at < now() - interval '90 minutes')
  order by case status when 'queued' then 0 when 'waiting_provider' then 1 else 2 end,
           created_at
  for update skip locked limit 1;
  if j.id is null then return null; end if;
  update public.ai_import_jobs
    set status='processing', worker_lock_at=now(),next_attempt_at=null,
        attempts=attempts+1,last_error=null,updated_at=now()
  where id=j.id returning * into j;
  return j;
end $$;
revoke all on function public.ai_claim_import_job() from public,anon,authenticated;
grant execute on function public.ai_claim_import_job() to service_role;
