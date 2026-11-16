-- Safe, isolated AI-import staging. Does not modify any existing Quizard table.
-- No publish function is created in the first phase. No automatic access to books.
-- Images and original PDFs stay in private storage until explicitly released.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('ai_import_sources','ai_import_sources',false,524288000,array['application/pdf']),
  ('ai_import_assets','ai_import_assets',false,52428800,array['image/png','image/jpeg'])
on conflict (id) do nothing;

create table if not exists public.ai_import_jobs (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references auth.users(id),
  file_name text not null,
  title_hint text not null,
  speciality text not null,
  source_path text not null unique,
  cover_url text,
  status text not null default 'uploading'
    check (status in ('uploading','queued','processing','needs_review','ready','publishing','published','failed','cancelled')),
  total_pages integer not null default 0,
  processed_pages integer not null default 0,
  total_questions integer not null default 0,
  verified_questions integer not null default 0,
  review_issues jsonb not null default '[]'::jsonb,
  last_error text,
  worker_lock_at timestamptz,
  attempts integer not null default 0,
  book_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_import_sections (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_import_jobs(id) on delete cascade,
  section_index integer not null,
  title text not null,
  start_page integer not null,
  end_page integer not null,
  status text not null default 'pending'
    check (status in ('pending','verified','needs_review')),
  questions jsonb not null default '[]'::jsonb,
  issues jsonb not null default '[]'::jsonb,
  unique(job_id,section_index),
  check(start_page>0 and end_page>=start_page)
);

create index if not exists ai_import_jobs_queue_idx
  on public.ai_import_jobs(status,created_at);

alter table public.ai_import_jobs enable row level security;
alter table public.ai_import_sections enable row level security;

-- Readable only by Quizard full admins, checked by existing server-side is_admin().
drop policy if exists ai_jobs_admin_read on public.ai_import_jobs;
create policy ai_jobs_admin_read on public.ai_import_jobs
  for select to authenticated using ((select public.is_admin()));
drop policy if exists ai_sections_admin_read on public.ai_import_sections;
create policy ai_sections_admin_read on public.ai_import_sections
  for select to authenticated using ((select public.is_admin()));

revoke all on public.ai_import_jobs,public.ai_import_sections from public,anon,authenticated;
grant select on public.ai_import_jobs,public.ai_import_sections to authenticated;
grant select,insert,update,delete on public.ai_import_jobs,public.ai_import_sections to service_role;

-- The isolated worker exclusively claims queued jobs with the server-side service role.
-- SECURITY INVOKER avoids owner privilege escalation; normal users have no EXECUTE.
create or replace function public.ai_claim_import_job()
returns public.ai_import_jobs
language plpgsql security invoker set search_path=public
as $$
declare j public.ai_import_jobs;
begin
  select * into j from public.ai_import_jobs
  where status='queued'
    or (status='processing' and worker_lock_at < now() - interval '90 minutes')
  order by created_at
  for update skip locked limit 1;
  if j.id is null then return null; end if;
  update public.ai_import_jobs
     set status='processing',
         worker_lock_at=now(),
         attempts=attempts+1,
         last_error=null,
         updated_at=now()
  where id=j.id
  returning * into j;
  return j;
end $$;

revoke all on function public.ai_claim_import_job() from public,anon,authenticated;
grant execute on function public.ai_claim_import_job() to service_role;

-- Publication to public.books/chapters/questions is intentionally NOT installed.
-- It will be a separate migration after a measured, human-reviewed pilot.
