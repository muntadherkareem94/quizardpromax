-- Quizard AI book-import queue. Run before deploying ai-import-admin / worker.
-- No public upload or direct publication permissions are granted.
create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ai_import_sources','ai_import_sources',false,524288000,array['application/pdf'])
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
  unique (job_id, section_index),
  check (start_page > 0 and end_page >= start_page)
);

create index if not exists ai_import_jobs_queue_idx on public.ai_import_jobs(status, created_at);

alter table public.ai_import_jobs enable row level security;
alter table public.ai_import_sections enable row level security;

-- Existing Quizard is_admin() RPC is used by the super-admin dashboard.
drop policy if exists ai_jobs_admin_read on public.ai_import_jobs;
create policy ai_jobs_admin_read on public.ai_import_jobs
  for select to authenticated using (public.is_admin());
drop policy if exists ai_sections_admin_read on public.ai_import_sections;
create policy ai_sections_admin_read on public.ai_import_sections
  for select to authenticated using (public.is_admin());

revoke all on public.ai_import_jobs, public.ai_import_sections from anon, authenticated;
grant select on public.ai_import_jobs, public.ai_import_sections to authenticated;
grant all on public.ai_import_jobs, public.ai_import_sections to service_role;

-- A single worker claims at most one queued or stale job.
create or replace function public.ai_claim_import_job()
returns public.ai_import_jobs
language plpgsql security definer set search_path = public
as $$
declare j public.ai_import_jobs;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role only'; end if;
  select * into j from public.ai_import_jobs
  where status = 'queued'
     or (status = 'processing' and worker_lock_at < now() - interval '90 minutes')
  order by created_at
  for update skip locked limit 1;
  if j.id is null then return null; end if;
  update public.ai_import_jobs set status = 'processing', worker_lock_at = now(),
    attempts = attempts + 1, last_error = null, updated_at = now()
  where id = j.id returning * into j;
  return j;
end $$;
revoke all on function public.ai_claim_import_job() from public, anon, authenticated;
grant execute on function public.ai_claim_import_job() to service_role;

-- One transaction publishes a verified book. A failure rolls the entire book back.
create or replace function public.ai_publish_import_job(p_job_id uuid)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  j public.ai_import_jobs;
  sec public.ai_import_sections;
  item jsonb;
  b_id uuid;
  ch_id uuid;
  d_id uuid;
  typed_q public.questions%rowtype;
  n integer := 0;
  sec_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role only'; end if;
  select * into j from public.ai_import_jobs where id=p_job_id for update;
  if j.id is null then raise exception 'Job not found'; end if;
  if j.status = 'published' and j.book_id is not null then return j.book_id; end if;
  if j.status <> 'ready' then raise exception 'Job is not ready'; end if;
  if j.cover_url is null then raise exception 'Missing verified cover'; end if;
  if jsonb_array_length(j.review_issues) <> 0 then raise exception 'Review issues remain'; end if;
  select count(*) into sec_count from public.ai_import_sections where job_id = j.id;
  if sec_count = 0 or exists(select 1 from public.ai_import_sections
     where job_id = j.id and (status <> 'verified' or jsonb_array_length(issues) <> 0
       or jsonb_array_length(questions) = 0))
  then raise exception 'Unverified or missing chapters'; end if;

  select id into d_id from public.disciplines where speciality=j.speciality order by name limit 1;
  if d_id is null then
    insert into public.disciplines(name, speciality) values ('General',j.speciality)
    returning id into d_id;
  end if;

  insert into public.books(title, description, speciality, image, access_level)
  values (j.title_hint, 'AI-imported question bank; verified against uploaded PDF',
          j.speciality,j.cover_url,'purchasable')
  returning id into b_id;

  for sec in select * from public.ai_import_sections where job_id=j.id order by section_index loop
    insert into public.chapters("chapterNumber",name,description,discipline_id,book_id,is_free)
    values (sec.section_index,sec.title,'Imported from source PDF',d_id,b_id,false)
    returning id into ch_id;

    for item in select value from jsonb_array_elements(sec.questions) loop
      if item->>'question' is null or item->>'explanation' is null
       or item->'options' is null or item->'correctAnswerIndex' is null
      then raise exception 'Missing question fields in chapter %',sec.section_index; end if;
      select * into typed_q from jsonb_populate_record(NULL::public.questions,
        jsonb_build_object(
          'questionNumber',item->'questionNumber',
          'question',item->'question',
          'options',item->'options',
          'correctAnswerIndex',item->'correctAnswerIndex',
          'explanation',item->'explanation',
          'imageUrl',item->'imageUrl',
          'imageUrls',item->'imageUrls',
          'explanationImageUrl',item->'explanationImageUrl',
          'explanationImageUrls',item->'explanationImageUrls'
        ));
      insert into public.questions
        ("questionNumber",question,options,"correctAnswerIndex",explanation,
          "imageUrl","imageUrls","explanationImageUrl","explanationImageUrls",
          book_id,chapter_id,discipline_id)
      values (typed_q."questionNumber",typed_q.question,typed_q.options,
          typed_q."correctAnswerIndex",typed_q.explanation,typed_q."imageUrl",
          typed_q."imageUrls",typed_q."explanationImageUrl",typed_q."explanationImageUrls",
          b_id,ch_id,d_id);
      n := n + 1;
    end loop;
  end loop;
  if n <> j.verified_questions or n = 0 then
    raise exception 'Verified question count mismatch: % vs %',n,j.verified_questions;
  end if;
  update public.ai_import_jobs set book_id=b_id,status='published',total_questions=n,
      updated_at=now() where id=j.id;
  return b_id;
end $$;
revoke all on function public.ai_publish_import_job(uuid) from public, anon, authenticated;
grant execute on function public.ai_publish_import_job(uuid) to service_role;
