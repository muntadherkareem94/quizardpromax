import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const respond = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return respond({ error: 'POST required' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anon || !secret) return respond({ error: 'Server is not configured' }, 500);

    const authorization = req.headers.get('Authorization') || '';
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!token) return respond({ error: 'Sign-in required' }, 401);

    const auth = createClient(url, anon);
    const { data: { user }, error: authError } = await auth.auth.getUser(token);
    if (authError || !user) return respond({ error: 'Invalid session' }, 401);

    const db = createClient(url, secret);
    const { data: profile, error: profileError } = await db.from('users')
      .select('role').eq('id', user.id).single();
    // This endpoint is reserved for full admins, not specialty admins.
    if (profileError || profile?.role !== 'admin')
      return respond({ error: 'Super-admin role required' }, 403);

    const input = await req.json();
    const action = String(input.action || '');
    if (action === 'prepare-upload') {
      const filename = String(input.filename || '').trim();
      const speciality = String(input.speciality || '').trim();
      const titleHint = String(input.title || '').trim();
      const size = Number(input.size || 0);
      const budget = Number(input.budget_usd ?? 0.75);
      if (!Number.isFinite(budget) || budget < 0.20 || budget > 5 || Math.abs(budget * 100 - Math.round(budget * 100)) > 0.0001)
        return respond({ error: 'Budget per book must be between $0.20 and $5.00 in cents' }, 400);
      if (!filename.toLowerCase().endsWith('.pdf') || size < 1 || size > 500 * 1024 * 1024)
        return respond({ error: 'A PDF smaller than 500 MB is required' }, 400);
      if (!speciality || speciality.length > 120 || !titleHint || titleHint.length > 300)
        return respond({ error: 'Book title and specialty are required' }, 400);
      const id = crypto.randomUUID();
      const path = user.id + '/' + id + '/book.pdf';
      // The browser uses TUS with its own authenticated Supabase session JWT.
      // Storage RLS restricts INSERT to this exact prepared job path.
      const { error } = await db.from('ai_import_jobs').insert({
        id, uploaded_by: user.id, file_name: filename.slice(0, 300),
        title_hint: titleHint, speciality, source_path: path, status: 'uploading',
        budget_usd: budget, provider_mode: 'free_only'
      });
      if (error) throw error;
      return respond({ id, path });
    }

    const id = String(input.id || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      return respond({ error: 'Valid job id required' }, 400);
    const { data: job, error: fetchError } = await db.from('ai_import_jobs')
      .select('id, status, provider_mode, next_attempt_at, worker_lock_at, source_path, budget_usd, api_spend_estimate_usd').eq('id', id).single();
    if (fetchError || !job) return respond({ error: 'Job not found' }, 404);

    if (action === 'finalize-upload') {
      if (job.status !== 'uploading') return respond({ error: 'Not awaiting upload' }, 409);
      const parent = job.source_path.substring(0, job.source_path.lastIndexOf('/'));
      const { data: entries, error: listError } = await db.storage.from('ai_import_sources')
        .list(parent, { limit: 100, search: 'book.pdf' });
      if (listError || !entries?.some((file) => file.name === 'book.pdf'))
        return respond({ error: 'PDF upload not found in storage' }, 409);
      const { error } = await db.from('ai_import_jobs').update({
        status: 'queued', updated_at: new Date().toISOString()
      }).eq('id', id).eq('status', 'uploading');
      if (error) throw error;
      return respond({ ok: true });
    }

    if (action === 'upload-failed') {
      // Preserve useful diagnostic state without ever starting an incomplete job.
      if (job.status !== 'uploading') return respond({ error: 'Job is not uploading' }, 409);
      const reason = String(input.reason || 'PDF upload failed').slice(0, 500);
      const { error } = await db.from('ai_import_jobs').update({
        status: 'failed', last_error: reason, updated_at: new Date().toISOString()
      }).eq('id', id).eq('status', 'uploading');
      if (error) throw error;
      return respond({ ok: true });
    }

    if (action === 'remove-test') {
      const { data, error } = await db.rpc('ai_remove_test_import', { p_job_id: id });
      if (error) throw error;
      if (!data) return respond({ error: 'No test book associated with this job' }, 409);
      return respond({ ok: true });
    }

    if (action === 'set-budget') {
      if (!['uploading','queued','failed','paused_budget','needs_review','ready','waiting_provider'].includes(job.status))
        return respond({ error: 'Budget cannot be edited in this state' }, 409);
      const amount = Number(input.budget_usd);
      if (!Number.isFinite(amount) || amount < 0.20 || amount > 5.00 ||
          Math.abs(amount * 100 - Math.round(amount * 100)) > 0.0001 ||
          amount < Number(job.api_spend_estimate_usd) + 0.01)
        return respond({ error: 'Enter a budget above tracked spending, between $0.20 and $5.00' }, 400);
      const { error } = await db.from('ai_import_jobs').update({
        budget_usd: amount, updated_at: new Date().toISOString()
      }).eq('id', id).eq('status', job.status);
      if (error) throw error;
      return respond({ ok: true });
    }

    if (action === 'process-now') {
      // Server-triggered processing: only real super-admin sessions reach here.
      // One-time database token authorizes only this job; no service-role key
      // is transmitted to Railway or to the browser.
      if (job.provider_mode !== 'free_only')
        return respond({ error: 'Process Now is enabled only for free-only test imports' }, 409);
      // A live worker heartbeats every 15 seconds. Recover only an old claim.
      const crashed = job.status === 'processing' &&
        job.worker_lock_at && Date.parse(job.worker_lock_at) < Date.now()-180000;
      if (job.status === 'processing' && !crashed)
        return respond({ ok: true, already_processing: true, started: false });
      if (!['queued', 'waiting_provider'].includes(job.status) && !crashed)
        return respond({ error: 'This book cannot start in state: ' + job.status }, 409);
      if (job.status === 'waiting_provider' && job.next_attempt_at &&
          Date.parse(job.next_attempt_at) > Date.now())
        return respond({
          error: 'Free provider cooldown is still active. Earliest eligible retry: ' +
            new Date(job.next_attempt_at).toISOString()
        }, 409);
      // Only this super-admin-authorized Edge Function can issue a dispatch token.
      // Supabase stores it for 90 seconds, and Railway consumes it exactly once.
      // The service-role key is never transmitted between the two services.
      const { data: dispatchToken, error: issueError } = await db.rpc(
        'ai_issue_import_dispatch_token', { p_job_id: id });
      if (issueError) throw issueError;
      if (!dispatchToken)
        return respond({ error: 'Book is not eligible to start, or its provider cooldown is active.' }, 409);
      const workerUrl = 'https://quizard-ai-worker-staging.up.railway.app/run';
      let workerResponse: Response;
      try {
        workerResponse = await fetch(workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id: id, dispatch_token: dispatchToken }),
          signal: AbortSignal.timeout(30000)
        });
      } catch (dispatchError) {
        console.error('AI worker dispatch unavailable', dispatchError);
        return respond({ error: 'AI worker is unavailable. The book remains safely queued; try Process Now again.' }, 503);
      }
      const result = await workerResponse.json().catch(() => ({}));
      if (workerResponse.status !== 202) {
        if (workerResponse.status === 409) {
          // Another click or tab may have dispatched this job while the page
          // was still refreshing; treat an already-running job as success.
          const { data: latest } = await db.from('ai_import_jobs')
            .select('status').eq('id', id).single();
          if (latest?.status === 'processing')
            return respond({ ok: true, already_processing: true, started: false });
        }
        const safeMessage = String((result as {error?: string}).error || 'Unable to dispatch this book');
        return respond({ error: safeMessage }, workerResponse.status >= 500 ? 503 : 409);
      }
      return respond({ ok: true, started: true });
    }

    if (action === 'retry') {
      if (!['failed', 'needs_review', 'paused_budget', 'waiting_provider'].includes(job.status))
        return respond({ error: 'Only failed/review/budget-paused jobs can be retried' }, 409);
      if (job.status === 'paused_budget' && Number(job.budget_usd) <= Number(job.api_spend_estimate_usd) + 0.02)
        return respond({ error: 'Increase this book budget before retrying' }, 409);
      // Retrying an import rewrites source checkpoints. Preserve human reviews:
      // they must never be silently erased by a worker rerun.
      const { data: reviewSections, error: reviewError } = await db
        .from('ai_import_sections').select('questions').eq('job_id', id);
      if (reviewError) throw reviewError;
      const hasHumanReviews = (reviewSections || []).some((section) =>
        (Array.isArray(section.questions) ? section.questions : []).some(
          (q) => q && q.reviewDecision && ['approved','rejected','pending'].includes(
            q.reviewDecision.status)
        )
      );
      if (hasHumanReviews)
        return respond({error:'This book has saved manual review decisions. Retry is blocked to avoid overwriting edits and approvals.'},409);
      // Upload failures have no source PDF. Do not queue them for AI processing.
      const folder = job.source_path.substring(0, job.source_path.lastIndexOf('/'));
      const { data: files, error: storageError } = await db.storage
        .from('ai_import_sources').list(folder, { limit: 10, search: 'book.pdf' });
      if (storageError || !files?.some((f) => f.name === 'book.pdf'))
        return respond({ error: 'The original PDF was not uploaded. Upload this book again.' }, 409);
      const { error } = await db.from('ai_import_jobs').update({
        status: 'queued', resume_section_index: 1, last_error: null, next_attempt_at: null, updated_at: new Date().toISOString()
      }).eq('id', id).eq('status', job.status);
      if (error) throw error;
      return respond({ ok: true });
    }

    if (action === 'cancel') {
      if (!['queued', 'failed', 'needs_review', 'ready', 'paused_budget', 'waiting_provider'].includes(job.status))
        return respond({ error: 'Only non-running jobs may be cancelled' }, 409);
      const { error } = await db.from('ai_import_jobs').update({
        status: 'cancelled', updated_at: new Date().toISOString()
      }).eq('id', id).eq('status', job.status);
      if (error) throw error;
      return respond({ ok: true });
    }

    if (action === 'source-link') {
      const { data, error } = await db.storage.from('ai_import_sources')
        .createSignedUrl(job.source_path, 120);
      if (error || !data?.signedUrl) throw error || new Error('Cannot open source');
      return respond({ url: data.signedUrl });
    }
    return respond({ error: 'Unknown action' }, 400);
  } catch (error) {
    console.error('AI import request failed', error);
    return respond({ error: error instanceof Error ? error.message : 'Request failed' }, 500);
  }
});
