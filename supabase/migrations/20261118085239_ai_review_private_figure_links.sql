
-- Keep imported draft figures private until an explicitly approved release.
INSERT INTO storage.buckets (id,name,public)
VALUES ('ai_import_draft_figures','ai_import_draft_figures',false)
ON CONFLICT (id) DO UPDATE SET public=false;

CREATE TABLE IF NOT EXISTS public.ai_import_draft_figures (
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  book_id uuid NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.ai_import_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('question','explanation')),
  sort_index integer NOT NULL CHECK (sort_index > 0),
  object_path text NOT NULL,
  source_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, kind, sort_index),
  UNIQUE (object_path)
);
CREATE INDEX IF NOT EXISTS ai_import_draft_figures_book_idx
  ON public.ai_import_draft_figures (book_id,question_id);

ALTER TABLE public.ai_import_draft_figures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_import_draft_figures FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_import_draft_figures TO authenticated;
DROP POLICY IF EXISTS ai_draft_figures_admin_read ON public.ai_import_draft_figures;
CREATE POLICY ai_draft_figures_admin_read ON public.ai_import_draft_figures
FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
