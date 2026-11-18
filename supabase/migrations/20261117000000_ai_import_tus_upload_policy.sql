-- Permit only a logged-in Quizard full admin to upload a PDF
-- at the exact private path prepared for that user's pending import job.
-- TUS resumable uploads use the user's Bearer access token, NOT a signed upload URL token.
-- No read/update/delete access to the private source bucket is granted here.

create policy "ai_import_sources_owner_admin_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'ai_import_sources'
    and (select public.is_admin())
    and exists (
      select 1 from public.ai_import_jobs j
      where j.source_path = storage.objects.name
        and j.uploaded_by = (select auth.uid())
        and j.status = 'uploading'
    )
  );
