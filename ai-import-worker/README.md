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

**No publication RPC exists.** The AI worker *cannot* insert into the existing `books`, `chapters`, or `questions` tables. `AUTO_PUBLISH` is hard-disabled in code. Existing Quizard payments, subscribers, quiz access and books remain unchanged.

## What the worker does

1. Read privately uploaded PDF and inspect title and cover page.
2. Discover chapters using PDF table of contents/bookmarks or printed headings; flag uncertainties.
3. Extract every question in small PDF page batches with exact source text, options and source-provided answer/explanation.
4. Independently audit transcription with a second model and attempt up to two source-grounded repairs.
5. Extract and stage source images *privately*; flag ambiguous figure matching.
6. Save verified chapter/question JSON to staging tables. Uncertain items go to `needs_review`. A fully checked book is `ready`, **not** published.

## How to operate (not yet running)

1. Deploy `ai-import-worker` to Railway from this feature branch, with root directory `/ai-import-worker` and Dockerfile `Dockerfile`.
2. Configure the required secrets as Railway **sealed/server-side** variables: `SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY`. Do not paste them into ChatGPT, code or public GitHub.
3. `SUPABASE_URL=https://ftcttxpmuqhqtbcdwgtr.supabase.co`, `AUTO_PUBLISH=false`, `PAGES_PER_BATCH=3`, `POLL_SECONDS=60` are non-secret settings.
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

**Current safety policy:** deploy only isolated staging resources; do not merge to production or start paid AI processing until credentials, cost limits and acceptance tests are configured.
