import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
const respond = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: cors });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Candidate = Record<string, any>;

function requiredText(value: unknown, label: string, max = 100000): string {
  if (typeof value !== 'string' || value.length > max)
    throw new Error(label + ' must be text up to ' + max + ' characters');
  return value;
}
function validCandidate(q: Candidate) {
  return typeof q.question === 'string' && q.question.trim().length >= 8 &&
    Array.isArray(q.options) && q.options.length >= 2 &&
    q.options.length <= 10 && q.options.every((o: unknown) => typeof o === 'string' && o.trim()) &&
    Number.isInteger(q.correctAnswerIndex) &&
    q.correctAnswerIndex >= 0 && q.correctAnswerIndex < q.options.length &&
    typeof q.explanation === 'string' && q.explanation.trim().length > 0 &&
    !/critique will display after all linked items/i.test(q.explanation);
}
async function fingerprint(q: Candidate) {
  const bytes = new TextEncoder().encode(JSON.stringify(q));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(n => n.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  if (req.method !== 'POST') return respond({error: 'POST required'}, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anon || !secret) return respond({error: 'Server not configured'}, 500);
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return respond({error: 'Sign-in required'}, 401);
    const auth = createClient(url, anon);
    const {data: {user}, error: authError} = await auth.auth.getUser(token);
    if (authError || !user) return respond({error: 'Invalid session'}, 401);
    const db = createClient(url, secret);
    const {data: profile, error: roleError} = await db.from('users')
      .select('role').eq('id', user.id).single();
    if (roleError || profile?.role !== 'admin')
      return respond({error: 'Super-admin role required'}, 403);

    const input = await req.json();
    const action = String(input?.action || '');
    const id = String(input?.id || '');
    if (!uuid.test(id)) return respond({error: 'Valid import job ID required'}, 400);
    const {data: job, error: jobError} = await db.from('ai_import_jobs')
      .select('id,file_name,title_hint,speciality,source_path,status,book_metadata,book_id')
      .eq('id', id).single();
    if (jobError || !job) return respond({error: 'Import not found'}, 404);

    if (action === 'get') {
      const {data: sections, error} = await db.from('ai_import_sections')
        .select('id,section_index,title,start_page,end_page,status,questions,issues')
        .eq('job_id', id).order('section_index');
      if (error) throw error;
      const {data: draft} = await db.from('ai_import_draft_links')
        .select('book_id,approved_count').eq('job_id', id).maybeSingle();
      const staged = new Set<string>();
      const resultSections = await Promise.all((sections || []).map(async s => {
        const qs = await Promise.all((s.questions || []).map(async (q: Candidate) =>
          ({...q, _fingerprint: await fingerprint(q)})));
        for (const q of qs) {
          for (const k of ['imageUrls', 'explanationImageUrls']) {
            for (const value of Array.isArray(q[k]) ? q[k] : []) {
              if (typeof value === 'string') staged.add(value);
            }
          }
        }
        return {...s, questions: qs};
      }));
      const prefix = 'staging://ai_import_assets/ai-import/' + id + '/';
      const images: Record<string,string> = {};
      await Promise.all([...staged].map(async value => {
        if (!value.startsWith(prefix)) return;
        const path = value.slice('staging://ai_import_assets/'.length);
        const {data, error} = await db.storage.from('ai_import_assets')
          .createSignedUrl(path, 900);
        if (!error && data?.signedUrl) images[value] = data.signedUrl;
      }));
      const source = await db.storage.from('ai_import_sources')
        .createSignedUrl(job.source_path, 900);
      return respond({job: {
        id: job.id, title: job.book_metadata?.title || job.title_hint,
        speciality: job.speciality, file_name: job.file_name, status: job.status
      }, sections: resultSections, source_url: source.data?.signedUrl || null,
      images, draft});
    }

    if (action === 'import-draft') {
      if (job.status !== 'needs_review' && job.status !== 'ready')
        return respond({error: 'Only finished imports can be drafted'}, 409);
      if (input?.rights_confirmed !== true ||
          input?.confirm_title !== job.book_metadata?.title)
        return respond({error: 'Confirm reproduction rights and type the exact printed book title'}, 400);
      const {data, error} = await db.rpc('ai_create_review_draft', {
        p_job_id: id, p_rights_confirmed: true
      });
      if (error) return respond({error: error.message}, 409);
      return respond({ok: true, draft: data});
    }

    if (!['save', 'decision'].includes(action))
      return respond({error: 'Unknown action'}, 400);
    if (job.status !== 'needs_review' && job.status !== 'ready')
      return respond({error: 'Review is unavailable while this job is processing'}, 409);
    const sectionIndex = Number(input.section_index);
    const number = Number(input.question_number);
    if (!Number.isInteger(sectionIndex) || sectionIndex < 1 ||
        !Number.isInteger(number) || number < 1)
      return respond({error: 'Valid chapter and question numbers required'}, 400);
    const {data: section, error: sectionError} = await db.from('ai_import_sections')
      .select('id,questions').eq('job_id', id)
      .eq('section_index', sectionIndex).single();
    if (sectionError || !section || !Array.isArray(section.questions))
      return respond({error: 'Review chapter not found'}, 404);
    const index = section.questions.findIndex((q: Candidate) => q.questionNumber === number);
    if (index < 0) return respond({error: 'Question not found'}, 404);
    const current = section.questions[index] as Candidate;
    if (typeof input.fingerprint !== 'string' ||
        input.fingerprint !== await fingerprint(current))
      return respond({error: 'Question changed since loading. Refresh before saving.'}, 409);
    const next = {...current};
    const timestamp = new Date().toISOString();

    if (action === 'save') {
      next.question = requiredText(input.question, 'Question', 40000).trim();
      next.explanation = requiredText(input.explanation, 'Explanation', 100000).trim();
      if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 10)
        return respond({error: 'Provide between 2 and 10 options'}, 400);
      next.options = input.options.map((o: unknown) => requiredText(o, 'Option', 20000).trim());
      const answer = Number(input.correctAnswerIndex);
      if (!Number.isInteger(answer) || answer < 0 || answer >= next.options.length)
        return respond({error: 'Correct-answer index must match an option'}, 400);
      next.correctAnswerIndex = answer;
      next.reviewDecision = {status: 'pending', by: user.id, at: timestamp,
        note: 'Edited content requires new explicit review'};
    } else {
      const choice = String(input.decision || '');
      if (!['approved', 'rejected', 'pending'].includes(choice))
        return respond({error: 'Invalid review decision'}, 400);
      const sourceNote = requiredText(input.source_note || '', 'Source note', 800).trim();
      if (choice === 'approved') {
        if (!validCandidate(current))
          return respond({error: 'Incomplete question or critique. Edit and save the source text first.'}, 409);
        if (input.source_confirmed !== true)
          return respond({error: 'Explicit source confirmation is required'}, 400);
        if (current.sourceVerification?.status !== 'verified_local' && sourceNote.length < 8)
          return respond({error: 'Explain where the corrected material appears in the original source'}, 400);
      }
      next.reviewDecision = {status: choice, by: user.id, at: timestamp,
        sourceConfirmed: choice === 'approved' && input.source_confirmed === true,
        sourceNote};
    }
    const newQuestions = [...section.questions];
    newQuestions[index] = next;
    // Optimistic concurrency at the JSONB row: never overwrite a concurrent
    // reviewer or re-run worker checkpoint with a stale browser copy.
    const {data: changed, error: updateError} = await db.from('ai_import_sections')
      .update({questions: newQuestions}).eq('id', section.id)
      .eq('questions', JSON.stringify(section.questions))
      .select('id');
    if (updateError) throw updateError;
    if (!changed?.length)
      return respond({error: 'Review conflict: reload this book before changing the question'}, 409);
    return respond({ok: true, question: {...next, _fingerprint: await fingerprint(next)}});
  } catch (error) {
    console.error('AI import review failed', error);
    return respond({error: error instanceof Error ? error.message : 'Request failed'}, 500);
  }
});
