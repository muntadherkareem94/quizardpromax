-- AI Import test-only removal fix, November 17, 2026.
-- The old function raised "Not a Quizard test book" when a published book row
-- had already been removed, leaving a dangling ai_import_jobs.book_id.
-- This function clears those orphan pointers and refuses to touch non-test books.

create or replace function public.ai_remove_test_import(p_job_id uuid)
returns boolean
language plpgsql
security invoker
set search_path=public
as $$
declare
  j public.ai_import_jobs%rowtype;
  existing_book public.books%rowtype;
begin
  select * into j
  from public.ai_import_jobs
  where id=p_job_id
  for update;

  if not found then
    return false;
  end if;

  -- An explicit allowlist makes this unsuitable for deleting real imported books.
  if j.file_name not in (
    'surgery_test_book_1.pdf',
    'surgery_test_book_2.pdf',
    'gynecology_test_book_1.pdf',
    'gynecology_test_book_2.pdf'
  ) or
  (j.file_name like 'surgery_%' and j.speciality is distinct from 'General Surgery') or
  (j.file_name like 'gynecology_%'
    and j.speciality is distinct from 'Obstetrics & Gynecology - General')
  then
    raise exception 'Refusing to remove a non-synthetic import job';
  end if;

  if j.status not in ('published','cancelled') then
    raise exception 'Only completed synthetic test jobs can be removed';
  end if;

  if j.book_id is null then
    return j.status='cancelled';
  end if;

  select * into existing_book
  from public.books
  where id=j.book_id
  for update;

  if found then
    -- Never delete an ordinary book, even when a job points to it incorrectly.
    if existing_book.access_level is distinct from 'test'
      or existing_book.description is distinct from
          'QUIZARD_AI_TEST_IMPORT:'||p_job_id::text
    then
      raise exception 'Refusing to delete a book not owned by this synthetic test job';
    end if;

    -- Even TEST books should not destroy real customer purchase records.
    if exists (
      select 1 from public.user_purchases p
      where p.book_id=j.book_id
    ) then
      raise exception 'Cannot delete a test book that has user purchases';
    end if;

    delete from public.books
    where id=j.book_id
      and access_level='test'
      and description='QUIZARD_AI_TEST_IMPORT:'||p_job_id::text;
  end if;
  -- If the book row was already deleted, leave unrelated data untouched and
  -- clear only this synthetic job's stale publication pointer.
  update public.ai_import_jobs
  set book_id=null, status='cancelled', updated_at=now()
  where id=p_job_id;

  return true;
end;
$$;

revoke all on function public.ai_remove_test_import(uuid) from public,anon,authenticated;
grant execute on function public.ai_remove_test_import(uuid) to service_role;
