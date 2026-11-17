-- Safe, idempotent per-page-batch checkpoints for the private Quizard import queue.
-- Completed, source-audited batches are reused on retry after free-provider
-- quota exhaustion. No student-facing access or subscription modifications.

alter table public.ai_import_jobs
  add column if not exists book_metadata jsonb;

create table if not exists public.ai_import_batches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ai_import_jobs(id) on delete cascade,
  section_index integer not null check(section_index >= 1),
  start_page integer not null check(start_page >= 1),
  end_page integer not null check(end_page >= start_page),
  status text not null check(status in ('verified','needs_review')),
  questions jsonb not null default '[]'::jsonb,
  issues jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique(job_id,section_index,start_page)
);
create index if not exists ai_import_batches_job_idx
  on public.ai_import_batches(job_id,section_index,start_page);

alter table public.ai_import_batches enable row level security;
revoke all on public.ai_import_batches from public,anon,authenticated;
grant select,insert,update,delete on public.ai_import_batches to service_role;

comment on table public.ai_import_batches is
  'Private, source-audited MCQ page-batch checkpoints for free-tier quota failover; not published books.';
