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

type DraftDb = ReturnType<typeof createClient>;

async function readPrivateDraftFigures(db: DraftDb, bookId: string) {
  const {data: rows, error} = await db.from('ai_import_draft_figures')
    .select('question_id,kind,sort_index,object_path')
    .eq('book_id', bookId).order('sort_index');
  if (error) throw error;
  const figures: Record<string,{question: string[], explanation: string[]}> = {};
  let missing = 0;
  for (const row of rows || []) {
    if (!figures[row.question_id])
      figures[row.question_id] = {question: [], explanation: []};
    const {data: signed, error: urlError} = await db.storage
      .from('ai_import_draft_figures').createSignedUrl(row.object_path, 900);
    if (urlError || !signed?.signedUrl) {
      missing++;
      continue;
    }
    figures[row.question_id][row.kind as 'question' | 'explanation']
      .push(signed.signedUrl);
  }
  return {figures, count: rows?.length || 0, unavailable: missing};
}

async function syncPrivateDraftFigures(db: DraftDb, jobId: string, bookId: string) {
  const {data: book, error: bookError} = await db.from('books')
    .select('id,access_level').eq('id', bookId).single();
  if (bookError || !book || book.access_level !== 'test')
    throw new Error('Only an admin-only TEST book can receive private draft figures');

  const [sectionsResult, chaptersResult, questionResult] = await Promise.all([
    db.from('ai_import_sections').select('section_index,questions').eq('job_id', jobId),
    db.from('chapters').select('id,chapterNumber').eq('book_id', bookId),
    db.from('questions').select('id,chapter_id,questionNumber').eq('book_id', bookId),
  ]);
  if (sectionsResult.error) throw sectionsResult.error;
  if (chaptersResult.error) throw chaptersResult.error;
  if (questionResult.error) throw questionResult.error;
  const chapterNumbers = new Map(
    (chaptersResult.data || []).map(ch => [ch.id, Number(ch.chapterNumber)]));
  const recordBySourceNumber = new Map<string,string>();
  for (const q of questionResult.data || []) {
    recordBySourceNumber.set(chapterNumbers.get(q.chapter_id) + ':' +
      Number(q.questionNumber), q.id);
  }
  const sourcePrefix = 'staging://ai_import_assets/';
  const copied: Array<{question_id:string,kind:string,index:number}> = [];
  for (const section of sectionsResult.data || []) {
    const chapterIndex = Number(section.section_index);
    for (const q of section.questions || []) {
      if (q?.reviewDecision?.status !== 'approved' ||
          q.reviewDecision.sourceConfirmed !== true) continue;
      const questionNumber = Number(q.questionNumber);
      const questionId = recordBySourceNumber.get(chapterIndex + ':' + questionNumber);
      if (!questionId) continue; // No imported question for this source candidate.
      for (const [field,kind,letter] of [
        ['imageUrls','question','q'],
        ['explanationImageUrls','explanation','e'],
      ] as const) {
        const refs: unknown = q[field];
        if (refs == null) continue;
        if (!Array.isArray(refs) || refs.length > 20)
          throw new Error('Invalid source image list at Q' + questionNumber);
        for (let i=0; i<refs.length; i++) {
          const expected = sourcePrefix + 'ai-import/' + jobId +
            '/ch' + chapterIndex + '/' + questionNumber + letter + (i+1) + '.png';
          if (refs[i] !== expected)
            throw new Error('Image source does not match the audited question/figure position');
          const sourcePath = expected.slice(sourcePrefix.length);
          const objectPath = 'drafts/' + bookId + '/' + questionId +
            '/' + kind + '/' + (i+1) + '.png';
          const {data: original, error: downloadError} = await db.storage
            .from('ai_import_assets').download(sourcePath);
          if (downloadError || !original)
            throw downloadError || new Error('Source image could not be downloaded');
          const {error: uploadError} = await db.storage
            .from('ai_import_draft_figures').upload(objectPath, original,
              {contentType: 'image/png', upsert: true});
          if (uploadError) throw uploadError;
          const {error: mapError} = await db.from('ai_import_draft_figures')
            .upsert({question_id: questionId, book_id: bookId,
              job_id: jobId, kind, sort_index: i+1,
              object_path: objectPath, source_path: sourcePath},
              {onConflict: 'question_id,kind,sort_index'});
          if (mapError) throw mapError;
          copied.push({question_id: questionId,kind,index:i+1});
        }
      }
    }
  }
  return {attached: copied.length, private: true};
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
    if (action === 'draft-figures') {
      const bookId = String(input?.book_id || '');
      if (!uuid.test(bookId)) return respond({error: 'Valid draft book ID required'}, 400);
      const {data: link, error: linkError} = await db.from('ai_import_draft_links')
        .select('book_id').eq('book_id', bookId).maybeSingle();
      if (linkError) throw linkError;
      if (!link) return respond({ok: true, linked: false, figures: {}, count: 0});
      const signed = await readPrivateDraftFigures(db, bookId);
      return respond({ok: true, linked: true, ...signed});
    }
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
      let draftFigureCount = 0;
      if (draft) {
        const {count, error: figureCountError} = await db.from('ai_import_draft_figures')
          .select('question_id', {count: 'exact', head: true})
          .eq('book_id', draft.book_id);
        if (figureCountError) throw figureCountError;
        draftFigureCount = count || 0;
      }
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
      images, draft: draft ? {...draft, figure_count: draftFigureCount} : null});
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
      try {
        const figureSync = await syncPrivateDraftFigures(db,id,data.book_id);
        return respond({ok: true, draft: data, figure_sync: figureSync});
      } catch (imageError) {
        // The book transaction already succeeded. Let the admin retry figures
        // separately; never misreport that the draft import itself failed.
        console.error('Draft saved but private image sync failed', imageError);
        return respond({ok: true, draft: data,
          figure_warning: imageError instanceof Error ? imageError.message : 'Private figure sync failed'});
      }
    }

    if (action === 'sync-draft-figures') {
      const {data: draft, error: draftError} = await db.from('ai_import_draft_links')
        .select('book_id,approved_count').eq('job_id', id).maybeSingle();
      if (draftError) throw draftError;
      if (!draft) return respond({error: 'Import the approved questions first'}, 409);
      if (input?.rights_confirmed !== true ||
          input?.confirm_title !== job.book_metadata?.title)
        return respond({error: 'Reconfirm rights and printed book title to transfer private figures'}, 400);
      const result = await syncPrivateDraftFigures(db, id, draft.book_id);
      return respond({ok: true, ...result});
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
      const changedText = next.question !== current.question ||
        next.explanation !== current.explanation ||
        next.correctAnswerIndex !== current.correctAnswerIndex ||
        JSON.stringify(next.options) !== JSON.stringify(current.options);
      if (changedText) {
        next.sourceVerification = {
          status: 'needs_review',
          method: 'manual_edit_pending_source_check',
          issues: [{type: 'manual_edit', detail:
            'Original local verification was invalidated by an edit. Manually check the revised text against the PDF.'}]
        };
      }
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
    if (action === 'save') {
      const {data: allSections, error: countError} = await db.from('ai_import_sections')
        .select('status,questions').eq('job_id', id);
      if (countError) throw countError;
      const verifiedCount = (allSections || []).reduce((sum: number, sec: any) =>
        sum + (sec.questions || []).filter((q: Candidate) => sec.status === 'verified' ||
          (q.sourceVerification?.status === 'verified_local' &&
           q.sourceVerification?.method === 'local_pdf_source_checks')).length, 0);
      const {error: jobUpdateError} = await db.from('ai_import_jobs')
        .update({verified_questions: verifiedCount}).eq('id', id);
      if (jobUpdateError) throw jobUpdateError;
    }
    return respond({ok: true, question: {...next, _fingerprint: await fingerprint(next)}});
  } catch (error) {
    console.error('AI import review failed', error);
    return respond({error: error instanceof Error ? error.message : 'Request failed'}, 500);
  }
});
