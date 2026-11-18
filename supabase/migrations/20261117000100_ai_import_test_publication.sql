-- TEST ONLY: exercise real Quizard books/chapters/questions without user visibility.
-- Only four named synthetic MCQ fixture PDFs may use this path.
-- Live subscription rules and book entitlements are unchanged.

-- Restrictive visibility for the special 'test' access level. No existing rows use it.
drop policy if exists "hide_ai_test_books_from_students" on public.books;
create policy "hide_ai_test_books_from_students" on public.books
  as restrictive for select to public
  using (access_level <> 'test' or (select public.is_admin()));

drop policy if exists "hide_ai_test_chapters_from_students" on public.chapters;
create policy "hide_ai_test_chapters_from_students" on public.chapters
  as restrictive for select to public
  using (
    (select public.is_admin())
    or exists (select 1 from public.books b
               where b.id = book_id and b.access_level <> 'test')
  );

drop policy if exists "hide_ai_test_questions_from_students" on public.questions;
create policy "hide_ai_test_questions_from_students" on public.questions
  as restrictive for select to public
  using (
    (select public.is_admin())
    or exists (select 1 from public.books b
               where b.id = book_id and b.access_level <> 'test')
  );

create or replace function public.ai_publish_test_import(p_job_id uuid,p_cover_url text)
returns uuid
language plpgsql security invoker set search_path=public
as $$
declare
  j public.ai_import_jobs%rowtype;
  s record;
  q jsonb;
  new_book uuid;
  new_chapter uuid;
  n integer:=0;
  n_chapters integer:=0;
  expected_speciality text;
  chapter_index bigint;
begin
  select * into j from public.ai_import_jobs where id=p_job_id for update;
  if not found then raise exception 'Import job not found'; end if;
  if j.book_id is not null then return j.book_id; end if;
  if j.file_name in ('surgery_test_book_1.pdf','surgery_test_book_2.pdf') then
    expected_speciality:='General Surgery';
  elsif j.file_name in ('gynecology_test_book_1.pdf','gynecology_test_book_2.pdf') then
    expected_speciality:='Obstetrics & Gynecology - General';
  else
    raise exception 'Only Quizard synthetic test fixtures may be published by this function';
  end if;
  if j.speciality is distinct from expected_speciality then
    raise exception 'Test PDF specialty mismatch: %',j.speciality;
  end if;
  if j.status not in ('ready','needs_review') or j.total_pages > 10 or j.total_pages < 1 then
    raise exception 'Test import must be processed and no longer than 10 pages';
  end if;
  select count(*),coalesce(sum(jsonb_array_length(sec.questions)),0) into n_chapters,n
  from public.ai_import_sections sec
  where sec.job_id=j.id and jsonb_array_length(sec.questions)>0;
  if n<>4 or n_chapters<>1 then
    raise exception 'Expected exactly 1 nonempty chapter and 4 questions; got % chapters and % questions',n_chapters,n;
  end if;
  if p_cover_url is null or p_cover_url not like
    ('https://%/storage/v1/object/public/book_covers/ai-test/' || j.id::text || '/%')
  then
    raise exception 'A public cover URL for this job is required';
  end if;
  insert into public.books(title,description,speciality,image,"isVirtual",access_level,linked_specialties,
                           "originalBookId","linkedChapterId")
  values(j.title_hint,'QUIZARD_AI_TEST_IMPORT:'||j.id::text,j.speciality,p_cover_url,
         false,'test',null,null,null)
  returning id into new_book;

  for s in select * from public.ai_import_sections
           where job_id=j.id and jsonb_array_length(questions)>0 order by section_index
  loop
    chapter_index:=s.section_index;
    insert into public.chapters(name,description,"chapterNumber",book_id,discipline_id,
                               "linkedSpecialty",is_free)
    values(s.title,'Synthetic AI import test; source pages '||s.start_page||'-'||s.end_page,
           chapter_index,new_book,null,j.speciality,false)
    returning id into new_chapter;
    for q in select value from jsonb_array_elements(s.questions)
    loop
      if nullif(q->>'question','') is null
         or jsonb_typeof(q->'options') <> 'array'
         or jsonb_array_length(q->'options') < 2
         or (q->>'correctAnswerIndex')::int not between 0 and jsonb_array_length(q->'options')-1
         or nullif(q->>'explanation','') is null then
        raise exception 'Unsafe test question in book %',j.file_name;
      end if;
      insert into public.questions(
        question,options,"correctAnswerIndex",explanation,book_id,chapter_id,
        discipline_id,"questionNumber","imageUrl","imageUrls",
        "explanationImageUrl","explanationImageUrls")
      values(
        q->>'question',ARRAY(SELECT jsonb_array_elements_text(q->'options')),
        (q->>'correctAnswerIndex')::int,q->>'explanation',new_book,new_chapter,
        null,(q->>'questionNumber')::bigint,q->>'imageUrl',
        case when jsonb_typeof(q->'imageUrls')='array' then
          ARRAY(SELECT jsonb_array_elements_text(q->'imageUrls')) else null end,
        q->>'explanationImageUrl',
        case when jsonb_typeof(q->'explanationImageUrls')='array' then
          ARRAY(SELECT jsonb_array_elements_text(q->'explanationImageUrls')) else null end
      );
    end loop;
  end loop;
  update public.ai_import_jobs set book_id=new_book,status='published',updated_at=now()
  where id=j.id;
  return new_book;
end $$;

revoke all on function public.ai_publish_test_import(uuid,text) from public,anon,authenticated;
grant execute on function public.ai_publish_test_import(uuid,text) to service_role;

create or replace function public.ai_remove_test_import(p_job_id uuid)
returns boolean
language plpgsql security invoker set search_path=public
as $$
declare b_id uuid;
begin
  select j.book_id into b_id from public.ai_import_jobs j where j.id=p_job_id for update;
  if b_id is null then return false; end if;
  if not exists (
    select 1 from public.books b where b.id=b_id
      and b.access_level='test'
      and b.description='QUIZARD_AI_TEST_IMPORT:'||p_job_id::text
  ) then raise exception 'Not a Quizard test book'; end if;
  delete from public.books where id=b_id;
  update public.ai_import_jobs set book_id=null,status='cancelled',updated_at=now()
  where id=p_job_id;
  return true;
end $$;

revoke all on function public.ai_remove_test_import(uuid) from public,anon,authenticated;
grant execute on function public.ai_remove_test_import(uuid) to service_role;
