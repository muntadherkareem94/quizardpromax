-- Prevent incomplete/incorrect synthetic test books from being marked published
-- in Quizard even when a worker erroneously calls the publication RPC.
-- This is the final database-side fail-closed gate; transaction rollback also
-- rolls back test books, chapters and questions created by the RPC.

create or replace function public.ai_guard_synthetic_test_publication()
returns trigger language plpgsql security invoker set search_path=public as $$
declare
  verified_sections integer;
  bad_sections integer;
begin
  if new.status <> 'published' or new.file_name not in (
    'surgery_test_book_1.pdf',
    'surgery_test_book_2.pdf',
    'gynecology_test_book_1.pdf',
    'gynecology_test_book_2.pdf'
  ) then return new; end if;

  select count(*) filter (
           where status='verified'
             and jsonb_array_length(coalesce(questions,'[]'::jsonb))=4
             and jsonb_array_length(coalesce(issues,'[]'::jsonb))=0),
         count(*) filter (
           where status<>'verified'
              or jsonb_array_length(coalesce(issues,'[]'::jsonb))>0)
    into verified_sections,bad_sections
  from public.ai_import_sections
  where job_id=new.id;

  if coalesce(new.total_questions,0) <> 4
     or coalesce(new.verified_questions,0) <> 4
     or jsonb_array_length(coalesce(new.review_issues,'[]'::jsonb)) > 0
     or verified_sections <> 1
     or bad_sections <> 0
  then
    raise exception using message =
      'Synthetic test publication blocked: independent source audit incomplete or review issues remain';
  end if;
  return new;
end $$;

drop trigger if exists ai_synthetic_test_publication_quality_guard
  on public.ai_import_jobs;
create trigger ai_synthetic_test_publication_quality_guard
before update of status on public.ai_import_jobs
for each row execute function public.ai_guard_synthetic_test_publication();

comment on function public.ai_guard_synthetic_test_publication() is
  'Fail-closed defense: even internal test publications require 4 independently verified questions, exactly one verified chapter, and zero review issues.';
