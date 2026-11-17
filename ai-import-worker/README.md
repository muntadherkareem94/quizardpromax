# Quizard AI Book Import — isolated staging phase

## Current state (16 November 2026)

This is a test-only importer on the GitHub feature branch `feature/ai-book-import-v1`.
The production Supabase project has only the following *new* isolated resources:

- `public.ai_import_jobs` — admin-readable, service-role writable.
- `public.ai_import_sections` — admin-readable, service-role writable.
- `ai_import_sources` private PDF bucket.
- `ai_import_assets` private original-cover and extracted-figure bucket.
- `public.ai_claim_import_job()` service-role-only, invoker-security queue function.
- `ai-import-admin` Edge Function, authorized full admins only, with JWT verification.

**Production auto-publication is disabled.** A separate `ai_publish_test_import` RPC is now installed solely for the four synthetic PDFs named `surgery_test_book_1.pdf`, `surgery_test_book_2.pdf`, `gynecology_test_book_1.pdf`, and `gynecology_test_book_2.pdf`. For these, the worker creates real Quizard books/chapters/questions with `access_level='test'` (admin-only via restrictive RLS; excluded from store/plans and new-book notifications). It copies source-extracted covers and figures into the existing public image buckets and leaves source-review issues visible. Other PDFs remain in private staging and are not published.

## What the worker does

1. Read privately uploaded PDF and inspect title and cover page.
2. Discover chapters using PDF table of contents/bookmarks or printed headings; flag uncertainties.
3. Extract every question in small PDF page batches with exact source text, options and source-provided answer/explanation.
4. Independently audit transcription with a second model and attempt up to two source-grounded repairs.
5. Extract and stage source images *privately*; flag ambiguous figure matching.
6. Save verified chapter/question JSON to staging tables. Uncertain items go to `needs_review`. A fully checked book is `ready`, **not** published.

## How to operate (Railway worker deployed, scheduled hourly in staging)

1. Railway staging uses root directory `/ai-import-worker`, Dockerfile `Dockerfile`, and schedule `0 * * * *` (hourly UTC). `RUN_ONCE=true` makes the worker exit when queue empties, limiting idle compute cost.
2. Configure the required secrets as Railway **sealed/server-side** variables: `SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY`. Do not paste them into ChatGPT, code or public GitHub.
3. `SUPABASE_URL=https://ftcttxpmuqhqtbcdwgtr.supabase.co`, `AUTO_PUBLISH=false`, `RUN_ONCE=true`, `MAX_PAGES_PER_JOB=10`, and `PAGES_PER_BATCH=3` are non-secret settings.
4. The models are configurable. Current defaults are `gpt-6.1-sol` extraction and `gpt-6-astra` independent audit; verify your API access and watch token costs before sending an entire textbook.
5. Make the new `ai_book_import.html` page available through a controlled test deployment (do not merge an unreviewed feature branch to the customer-facing site).
6. Test with an appropriately licensed short book/sample first. Manually inspect ALL extracted question stems, answers, explanations, original source pages, image matches, and chapter divisions before enabling an automatic publishing migration.
7. Only after a successful pilot, design a separate reviewed publish path to copy private assets to approved public buckets and transactionally create books/chapters/questions.

## Known limitations / safeguards

- No automatic publishing, no subscription changes.
- There is no source page review editor yet; results and issues can be inspected in the queue and database.
- Books with answers/explanations only in a distant answer key will be flagged, not fabricated.
- Scanned books with no printed chapter headings/bookmarks need a more robust document-wide chapter planner.
- Complex tables/vector graphics and multiple figures on the same page can be ambiguous; the worker flags these instead of guessing.
- The current upload flow allows signed TUS PDF uploads and an admin-only queue. It must be tested against the live storage size limits before processing large files.
- The AI verifier is not a substitute for manual sampling; a machine-generated "verified" result does not prove perfect source fidelity.
- Only process source books you have appropriate rights to reproduce and make available to Quizard users.
- Even without a paid Supabase development branch, storage, Railway compute and OpenAI API usage can generate charges.

**Current safety policy:** no production merge or publication until licensed sample-PDF pilot and accuracy review. The hourly staging worker is deployed; no PDF jobs have yet been queued. Railway compute and model API processing may incur usage charges.

## One-batch 4-PDF end-to-end smoke test

1. Download the four synthetic PDFs generated in the ChatGPT conversation and select all four in `ai_book_import.html` on the Netlify feature preview.
2. The per-file selectors must assign two PDFs to **General Surgery** and two to **Obstetrics & Gynecology - General**.
3. The Railway worker runs hourly UTC and exits when the queue empties; `RUN_ONCE=true`, `MAX_PAGES_PER_JOB=10`.
4. Each synthetic PDF is imported as one hidden TEST-tier book with an original-source cover, one nonempty chapter and four questions. The test report displays live database counts and image links. Expected across four: **4 books, 4 chapters, 16 MCQs, 4 covers, 8 question images and 8 explanation images**.
5. Any image association or source-verification issues remain visible. The test tier is to verify operational plumbing, not a claim that extracted source content is automatically verified.
6. Admins may remove a test book using `Remove test book`; the Edge Function invokes `ai_remove_test_import`, which only deletes test-tier books tagged with the matching job ID.
7. **A database-only transaction dry-run** verified that four fixture rows create the correct four books, four chapters, sixteen questions, two Surgery specialties, two Gynecology specialties and four cover-link fields; the transaction was rolled back. Full browser-to-PDF processing of the four real files remains to be tested.

**Warning:** OpenAI API and Railway processing are paid separately. The monthly project limit protects OpenAI usage, not Railway. Never merge this feature branch or make real textbooks visible to customers without further validation and a separate production release.
