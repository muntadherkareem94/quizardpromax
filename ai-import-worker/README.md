# Quizard autonomous MCQ book importer (initial implementation)

## What is implemented

- Full-admin-only, multi-PDF bulk upload with *existing Quizard specialty names*.
- 500 MB per-book private storage bucket (subject to the project's global file-size limit).
- Signed resumable/TUS upload into private Supabase Storage.
- Persistent queue: jobs stay in PostgreSQL, independent of browser availability.
- Dedicated Python worker downloads PDF, inspects its actual cover/title, maps chapters via bookmarks or visible headings, extracts MCQs batch-by-batch using the OpenAI Responses API with strict structured JSON, runs a separate AI source audit, validates fields, and tries to extract embedded figures.
- Existing Quizard tables used: books, chapters, questions, disciplines. Existing public image buckets used: book_covers, question_images.
- A single PostgreSQL transaction publishes an entire book only after all sections are verified; paid/purchasable access is the default, with no automatic subscription entitlements.
- Uncertain cases become **needs_review**, not silently auto-published. This is deliberate: 100% accurate transcription cannot be guaranteed by models.

## Deployment (required; PR alone does NOT activate background processing)

1. Review and merge the PR. Confirm the database schema matches the existing books/chapters/questions definitions in your live Supabase database.
2. Apply migration from \`supabase/migrations/20261116000000_ai_book_import.sql\` using your Supabase migration process or SQL editor (review the migration before execution).
3. Confirm the existing \`book_covers\` and \`question_images\` buckets are public (the current Quizard UI uses their public URLs). The source PDF bucket \`ai_import_sources\` must remain **private**.
4. Deploy \`supabase/functions/ai-import-admin\` as an Edge Function with JWT verification enabled. Supabase must provide SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY as server-side environment variables.
5. Deploy \`ai-import-worker\` as a **persistent container/worker**, not a static Netlify site or a short-lived Edge Function. For example, build its Dockerfile with Render Background Worker, Railway worker, or your own VPS.
6. Set worker server-side secrets: \`SUPABASE_URL\`, \`SUPABASE_SERVICE_ROLE_KEY\`, \`OPENAI_API_KEY\`. Never expose service role or OpenAI keys to the website/client/GitHub.
7. Set \`OPENAI_EXTRACTION_MODEL\` and \`OPENAI_VERIFICATION_MODEL\` to models actually enabled in your OpenAI project. The example defaults to \`gpt-6.1-sol\` for extraction and \`gpt-6-astra\` for an independent, high-accuracy audit. These are paid API models, not ChatGPT subscription entitlements; check API access, costs and limits before starting 10 books.
8. Check your Supabase project-level Storage file size limit and raise it appropriately before testing large textbooks.
9. In Quizard super-admin dashboard open **AI Autonomous Book Import**, choose a specialty, upload PDF books; repeat for additional specialties. Leave the worker running.
10. Before accepting paid/public content, benchmark against manually reviewed books and confirm copyright/licensing.

## Safety / known limitations of initial implementation

- The chapter planner tries PDF bookmarks, then printed "Chapter ..." headings. If neither exists (e.g. an entirely scanned PDF lacking bookmarks) it flags the chapter structure for review instead of hallucinating it.
- Answer keys/explanations separated far from stems may not appear within the extraction window; such questions are blocked for review instead of fabricating answers. A full book-wide key reconciliation pass is a planned improvement.
- Embedded raster figures are cropped from the **source PDF**, not generated. Vector figures, ambiguous image-to-question matches, multi-question page figures and figures on adjacent pages trigger manual review, not incorrect automatic attribution.
- The automatic source verifier is a separate model pass with up to two discrepancy-repair attempts, not a proof of 100% correctness. It must be benchmarked.
- The system is not yet an image-aware source-side correction editor. The UI displays exact issue descriptions and can retry, but review/edit tooling is a separate phase.
- The title/cover finder inspects the opening five pages; books whose real cover is elsewhere will require review.
- The uploaded specialty is a Quizard specialty (e.g. General Surgery or Rheumatology), and is **never** overridden by the AI.
- Source PDFs are kept private and not served publicly.
- Running twice for the same title creates separate import jobs. Each job is idempotent on publication, but global deduplication against existing books is not implemented.
- Publication uses an atomic SQL RPC; existing plans/subscriptions are not changed.

## Operational notes

Stop a container gracefully and restart it to resume the queue; sections already verified are reused. Jobs have stale worker locks that can be reclaimed after 90 minutes.

Status transitions: uploading → queued → processing → ready → published. Failed or uncertain content uses failed/needs_review.

If \`AUTO_PUBLISH=false\`, the worker sets \`ready\`; the publisher requires an admin-initiated secure approval procedure (not yet implemented), so leave it enabled only after acceptance tests.

> **Important:** This is a substantial first implementation committed to a feature branch. It has not been deployed or tested against the live Quizard database. Do not merge directly into production without migration preview and end-to-end tests.
