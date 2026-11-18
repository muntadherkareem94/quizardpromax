-- Fix the broken random discipline UUID default. The optional FK must be
-- assigned to a real discipline explicitly, or left NULL pending classification.
ALTER TABLE public.chapters ALTER COLUMN discipline_id DROP DEFAULT;

-- Atomic, super-admin-authorized draft import with explicit nullable discipline.
-- Real book content stays in the restricted test tier, and draft chapters are
-- never marked free by the chapters table's usual default.
CREATE OR REPLACE FUNCTION public.ai_create_review_draft(
  p_job_id uuid, p_rights_confirmed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp
AS $function$
DECLARE
 v_job public.ai_import_jobs%ROWTYPE;
 v_section public.ai_import_sections%ROWTYPE;
 v_q jsonb;
 v_book uuid;
 v_chapter uuid;
 v_total integer:=0;
 v_seen text[]:=ARRAY[]::text[];
 v_number integer;
 v_answer integer;
 v_opts text[];
 v_text text;
 v_explanation text;
 v_existing public.ai_import_draft_links%ROWTYPE;
BEGIN
 IF auth.role() <> 'service_role' THEN
   RAISE EXCEPTION 'Only the authorized import service may call this function';
 END IF;
 IF p_rights_confirmed IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Rights confirmation is required';
 END IF;
 SELECT * INTO v_job FROM public.ai_import_jobs
 WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR v_job.status NOT IN ('needs_review','ready') THEN
   RAISE EXCEPTION 'This import job is not ready for a controlled draft';
 END IF;
 SELECT * INTO v_existing FROM public.ai_import_draft_links
 WHERE job_id=p_job_id;
 IF FOUND THEN
   RETURN jsonb_build_object('book_id',v_existing.book_id,
      'approved_count',v_existing.approved_count,'existing',true);
 END IF;
 IF coalesce(v_job.book_metadata->>'confidence','')<>'high'
    OR nullif(btrim(v_job.book_metadata->>'title'),'') IS NULL THEN
   RAISE EXCEPTION 'Confirm the printed book title before importing';
 END IF;
 -- Book remains restricted test-tier: no public cover or private figure copy.
 INSERT INTO public.books (title, speciality, description, access_level)
 VALUES (left(v_job.book_metadata->>'title',300), v_job.speciality,
   'Admin-only reviewed MCQ draft. Source figures remain in private import staging.',
   'test') RETURNING id INTO v_book;
 FOR v_section IN SELECT * FROM public.ai_import_sections
                  WHERE job_id=p_job_id ORDER BY section_index LOOP
   v_chapter:=NULL;
   FOR v_q IN SELECT value FROM jsonb_array_elements(
        COALESCE(v_section.questions,'[]'::jsonb)) LOOP
     IF v_q #>> '{reviewDecision,status}' IS DISTINCT FROM 'approved' THEN
       CONTINUE;
     END IF;
     IF v_q #>> '{reviewDecision,sourceConfirmed}' IS DISTINCT FROM 'true' THEN
       RAISE EXCEPTION 'Approved question lacks source confirmation';
     END IF;
     v_number:=(v_q->>'questionNumber')::integer;
     v_answer:=(v_q->>'correctAnswerIndex')::integer;
     v_text:=btrim(coalesce(v_q->>'question',''));
     v_explanation:=btrim(coalesce(v_q->>'explanation',''));
     IF jsonb_typeof(v_q->'options') IS DISTINCT FROM 'array' THEN
       RAISE EXCEPTION 'Approved question missing options';
     END IF;
     SELECT array_agg(value) INTO v_opts
       FROM jsonb_array_elements_text(v_q->'options') AS value;
     IF v_number < 1 OR v_text='' OR v_explanation=''
       OR v_explanation ILIKE '%critique will display after all linked items%'
       OR COALESCE(array_length(v_opts,1),0) < 2
       OR v_answer < 0 OR v_answer >= array_length(v_opts,1)
       OR EXISTS(SELECT 1 FROM unnest(v_opts) AS x WHERE btrim(x)='') THEN
       RAISE EXCEPTION 'Incomplete approved question %',v_number;
     END IF;
     IF v_number::text=ANY(v_seen) THEN
       RAISE EXCEPTION 'Duplicate question number %',v_number;
     END IF;
     v_seen:=array_append(v_seen,v_number::text);
     IF v_chapter IS NULL THEN
       -- discipline_id is optional until the admin assigns a confirmed
       -- discipline. Setting NULL avoids the old random-UUID FK failure.
       INSERT INTO public.chapters
         (book_id,name,"chapterNumber",discipline_id,"linkedSpecialty",is_free)
       VALUES (v_book,coalesce(nullif(v_section.title,''),'Unclassified questions'),
               v_section.section_index,NULL,v_job.speciality,false)
       RETURNING id INTO v_chapter;
     END IF;
     INSERT INTO public.questions (
       book_id,chapter_id,"questionNumber",question,options,
       "correctAnswerIndex",explanation)
     VALUES (v_book,v_chapter,v_number,v_text,v_opts,v_answer,v_explanation);
     v_total:=v_total+1;
   END LOOP;
 END LOOP;
 IF v_total=0 THEN RAISE EXCEPTION 'No manually approved questions to import'; END IF;
 INSERT INTO public.ai_import_draft_links(job_id,book_id,approved_count)
 VALUES (p_job_id,v_book,v_total);
 RETURN jsonb_build_object('book_id',v_book,'approved_count',v_total,'existing',false);
END $function$;

REVOKE ALL ON FUNCTION public.ai_create_review_draft(uuid,boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ai_create_review_draft(uuid,boolean)
 TO service_role;
