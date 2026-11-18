/**
 * Quizard Admin - One-folder, one-action whole-book importer (v2).
 * Put this file next to admin_dashboard.html and supabaseClient.js.
 * admin_dashboard.html: <script type="module" src="./book-bulk-import.js"></script>
 *
 * Folder layout:
 *   book.json
 *   cover.png (or jpg/jpeg/webp)
 *   chapters/ch1_cardiology.json
 *   chapters/ch2_respiratory.json
 *   images/question images/ch1-q3-1.png
 *   images/explanation images/ch5-e5-2.png
 *
 * Clicking the button selects ONE FOLDER; selecting it validates and imports
 * automatically. No PDF parsing, separate image uploads or Preview step.
 * The browser must support <input webkitdirectory> (Chrome / Edge).
 */
import { supabase } from './supabaseClient.js';

const LIMITS = Object.freeze({maxImagesBytes: 15 * 1024 * 1024,
  maxCoverBytes: 15 * 1024 * 1024, maxJsonBytes: 10 * 1024 * 1024,
  maxChapters: 1000, maxQuestions: 50000, chunk: 100, uploadParallel: 4});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif)$/i;
let busy = false;
let inputEl;
let panel;
let statusEl;
let closeEl;
let openEl;
let importTrigger;

function safeText(s) { return typeof s === 'string' ? s.trim() : ''; }
function abort(message) { throw new Error(message); }
function report(message, error = false) {
  if (!statusEl) return;
  statusEl.textContent = String(message);
  statusEl.style.color = error ? '#991b1b' : '#1e293b';
  statusEl.style.borderColor = error ? '#fecaca' : '#c7d2fe';
  statusEl.style.background = error ? '#fef2f2' : '#eef2ff';
}
function visible(show) {
  panel.hidden = !show;
  if (show) panel.style.display = 'flex';
  else panel.style.display = 'none';
}
function imgMime(file) {
  if (/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) return file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'})[ext] || '';
}
function checkImage(file, what, maxBytes = LIMITS.maxImagesBytes) {
  if (!imgMime(file) || !IMAGE_EXT.test(file.name) || file.size < 1 || file.size > maxBytes)
    abort(`${what}: ${file.name} must be PNG/JPG/WEBP/GIF, under ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
}
function relativePath(file) {
  const s = String(file.webkitRelativePath || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || s.includes('/../')) abort(`Invalid folder path for ${file.name}.`);
  const parts = s.split('/');
  if (parts.length < 2 || parts.some(x => !x || x === '.' || x === '..')) abort(`Malformed folder path: ${s}`);
  return parts.slice(1).join('/'); // ignore arbitrary selected parent-folder name
}
function normalizeFolderToken(s) { return s.toLowerCase().replace(/[\s_-]+/g,''); }
function positiveInteger(value, context) {
  if (!Number.isInteger(value) || value < 1) abort(`${context} must be a positive whole number.`);
  return value;
}
function parseChapterFilename(filename) {
  const m = filename.match(/^ch(?:apter)?[_ -]?0*(\d+)[_ -]+(.+)\.json$/i);
  if (!m) return null;
  const number = positiveInteger(Number(m[1]), `Chapter number in ${filename}`);
  const fallback = m[2].replace(/[_-]+/g,' ').trim();
  return {number, fallback};
}
function parseImageFilename(filename) {
  const m = filename.match(/^ch0*(\d+)[-_ ]+([qe])0*(\d+)[-_ ]+0*(\d+)\.(png|jpg|jpeg|webp|gif)$/i);
  if (!m) return null;
  const chapterNumber = positiveInteger(Number(m[1]), `Chapter in ${filename}`);
  const questionNumber = positiveInteger(Number(m[3]), `Question in ${filename}`);
  const index = positiveInteger(Number(m[4]), `Image index in ${filename}`);
  return {chapterNumber, questionNumber, index, kind:m[2].toLowerCase()};
}
function normalizeChapterQuestions(data, chapterNumber, file) {
  const list = Array.isArray(data) ? data : data?.questions;
  if (!Array.isArray(list) || !list.length) abort(`${file}: expected a nonempty {"questions":[...]} array.`);
  const ids = new Set();
  return list.map((q, idx) => {
    if (!q || typeof q !== 'object' || Array.isArray(q)) abort(`${file}: invalid question at position ${idx + 1}.`);
    const n = positiveInteger(q.questionNumber, `${file} questionNumber at position ${idx + 1}`);
    if (ids.has(n)) abort(`${file}: duplicate questionNumber ${n}.`);
    ids.add(n);
    if (!safeText(q.question)) abort(`${file} Q${n}: question text required.`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10 ||
        !q.options.every(o => typeof o === 'string' && o.trim()))
      abort(`${file} Q${n}: options must contain 2 to 10 nonempty strings.`);
    if (!Number.isInteger(q.correctAnswerIndex) || q.correctAnswerIndex < 0 || q.correctAnswerIndex >= q.options.length)
      abort(`${file} Q${n}: correctAnswerIndex must be zero-based (0 to ${q.options.length - 1}).`);
    if (!safeText(q.explanation)) abort(`${file} Q${n}: explanation is required.`);
    for (const field of ['imageUrl','imageUrls','explanationImageUrl','explanationImageUrls']) {
      if (q[field] != null && q[field] !== '' && (!Array.isArray(q[field]) || q[field].length))
        abort(`${file} Q${n}: remove ${field}; attach images as files under the images folder.`);
    }
    return {questionNumber:n, question:q.question, options:q.options,
      correctAnswerIndex:q.correctAnswerIndex, explanation:q.explanation};
  }).sort((a,b)=>a.questionNumber-b.questionNumber);
}
async function readJson(file) {
  if (!file || file.size > LIMITS.maxJsonBytes || file.size === 0) abort(`Invalid JSON size: ${file?.name || 'missing'}.`);
  try {return JSON.parse(await file.text());} catch(e) {abort(`Invalid JSON in ${file.name}: ${e.message}`);}
}
function normalizeMetadata(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) abort('book.json must contain an object.');
  const d = data.book && typeof data.book === 'object' ? data.book : data;
  const title=safeText(d.title), description=safeText(d.description);
  const speciality=safeText(d.speciality || d.specialty);
  const access_level=safeText(d.access_level);
  if (!title || title.length > 300) abort('book.json: title is required (max 300 characters).');
  if (!description || description.length > 3000) abort('book.json: description is required (max 3000 characters).');
  if (!speciality) abort('book.json: speciality is required (e.g. "Internal Medicine - General").');
  if (!['free','premium','purchasable','test'].includes(access_level))
    abort('book.json: access_level must be free, premium, purchasable or test (admin-only).');
  const linked = d.linked_specialties ?? [];
  if (!Array.isArray(linked) || !linked.every(s => typeof s==='string' && s.trim()))
    abort('book.json: linked_specialties must be an array of specialty names.');
  if (new Set(linked).size !== linked.length) abort('book.json: duplicate linked_specialties.');
  return {title,description,speciality,access_level,linked_specialties:linked};
}
async function readFolder(files) {
  if (!files.length) abort('Choose a folder containing book.json, cover, chapters and images.');
  const foundPaths = new Set();
  let bookFile = null, coverFile = null;
  const chapterInputs = [];
  const imageInputs = [];
  for (const file of files) {
    const rel = relativePath(file);
    const canonical = rel.toLowerCase();
    if (foundPaths.has(canonical)) abort(`Duplicate file path (case-insensitive): ${rel}`);
    foundPaths.add(canonical);
    const parts = rel.split('/');
    const basename = parts[parts.length-1];
    if (parts.length === 1 && basename.toLowerCase() === 'book.json') {
      bookFile = file;
    } else if (parts.length === 1 && /^cover\.(?:png|jpg|jpeg|webp)$/i.test(basename)) {
      if (coverFile) abort('Only one root cover image may be supplied. Name it cover.png or cover.jpg.');
      checkImage(file,'Cover',LIMITS.maxCoverBytes);
      coverFile=file;
    } else if ((parts.length === 1 || (parts.length === 2 && normalizeFolderToken(parts[0])==='chapters')) && /\.json$/i.test(basename)) {
      const parsed=parseChapterFilename(basename);
      if (!parsed) abort(`Unexpected JSON file: ${rel}. Name chapters ch1_cardiology.json, ch2_respiratory.json, etc.`);
      chapterInputs.push({file, ...parsed});
    } else if (parts.length === 3 && normalizeFolderToken(parts[0])==='images' &&
               ['questionimages','explanationimages'].includes(normalizeFolderToken(parts[1]))) {
      const parsed=parseImageFilename(basename);
      if (!parsed) abort(`Invalid image filename ${rel}. Use ch1-q3-1.png or ch5-e5-2.png.`);
      const folderKind = normalizeFolderToken(parts[1]) === 'questionimages' ? 'q' : 'e';
      if (folderKind !== parsed.kind) abort(`${rel}: image type in filename disagrees with its folder.`);
      checkImage(file,'Image');
      imageInputs.push({file,...parsed});
    } else if (/^(?:\.ds_store|thumbs\.db|desktop\.ini)$/i.test(basename) || /^readme\.(?:txt|md)$/i.test(basename)) {
      // benign platform or documentation files
    } else {
      abort(`Unexpected file in folder: ${rel}. Only book.json, cover, ch*.json, and images subfolders are accepted.`);
    }
  }
  if (!bookFile) abort('Missing book.json in the root of your selected folder.');
  if (!coverFile) abort('Missing cover image in the root. Name it cover.png (or cover.jpg, cover.webp).');
  if (!chapterInputs.length) abort('No ch1_cardiology.json / ch2_respiratory.json files were found.');
  if (chapterInputs.length > LIMITS.maxChapters) abort(`At most ${LIMITS.maxChapters} chapters per import.`);
  const meta = normalizeMetadata(await readJson(bookFile));
  const chapterIds = new Set();
  const chapters=[];
  let totalQuestions=0;
  for (const source of chapterInputs) {
    if (chapterIds.has(source.number)) abort(`Two JSON files refer to chapter ${source.number}.`);
    chapterIds.add(source.number);
    const data=await readJson(source.file);
    const n = data && !Array.isArray(data) && data.chapterNumber !== undefined ?
      data.chapterNumber : source.number;
    if (n !== source.number) abort(`${source.file.name}: chapterNumber does not match the filename (ch${source.number}).`);
    const name=safeText(data?.name || data?.chapterName || data?.title || source.fallback);
    if (!name) abort(`${source.file.name}: missing chapter name.`);
    const discipline_id = data?.discipline_id ?? null;
    if (discipline_id !== null && !UUID.test(discipline_id)) abort(`${source.file.name}: discipline_id must be a UUID or null.`);
    const questions=normalizeChapterQuestions(data,source.number,source.file.name);
    totalQuestions+=questions.length;
    if (totalQuestions > LIMITS.maxQuestions) abort(`At most ${LIMITS.maxQuestions} questions per import.`);
    chapters.push({chapterNumber:source.number,name,description:safeText(data?.description),
      discipline_id,discipline:safeText(data?.discipline || data?.disciplineName),questions});
  }
  chapters.sort((a,b)=>a.chapterNumber-b.chapterNumber);
  const keys = new Set();
  const qKeys = new Set(chapters.flatMap(ch => ch.questions.map(q => `${ch.chapterNumber}:${q.questionNumber}`)));
  const groups = new Map();
  for (const item of imageInputs) {
    const qKey=`${item.chapterNumber}:${item.questionNumber}`;
    if (!qKeys.has(qKey)) abort(`Image ${item.file.name} doesn't match a question in ch${item.chapterNumber}.`);
    const pos=`${qKey}:${item.kind}:${item.index}`;
    if (keys.has(pos)) abort(`Duplicate image number ${item.file.name} at ${pos}.`);
    keys.add(pos);
    const groupKey=`${qKey}:${item.kind}`;
    if (!groups.has(groupKey)) groups.set(groupKey,[]);
    groups.get(groupKey).push(item);
  }
  for (const [key, entries] of groups) {
    entries.sort((a,b)=>a.index-b.index);
    entries.forEach((item,i) => {if(item.index !== i+1) abort(`Non-contiguous image numbers for ${key}: expected ${i+1}, found ${item.index}.`);});
  }
  return {meta,coverFile,chapters,groups,totalQuestions,imageCount:imageInputs.length};
}
async function resolveDisciplines(book) {
  const {data,error} = await supabase.from('disciplines')
    .select('id,name,speciality').eq('speciality',book.meta.speciality).limit(1000);
  if(error) throw error;
  const norm = v => String(v || '').trim().replace(/\s+/g,' ').toLowerCase();
  const known=new Map((data||[]).map(d => [norm(d.name),d.id]));
  const ids=new Set((data||[]).map(d=>d.id));
  for(const chapter of book.chapters) {
    if(chapter.discipline_id) {
      if(!ids.has(chapter.discipline_id))
        abort(`Chapter ${chapter.chapterNumber}: discipline_id not found in ${book.meta.speciality}.`);
    } else if(chapter.discipline) {
      const id=known.get(norm(chapter.discipline));
      if(!id) abort(`Chapter ${chapter.chapterNumber}: discipline "${chapter.discipline}" does not exist in ${book.meta.speciality}.`);
      chapter.discipline_id=id;
    } else {
      // When a discipline name exactly matches the chapter title, use it.
      chapter.discipline_id=known.get(norm(chapter.name)) || null;
    }
  }
}
async function adminCheck() {
  const {data:{user},error}=await supabase.auth.getUser();
  if (error || !user) abort('You must be signed in as an administrator.');
  const {data:isAdmin,error:roleError}=await supabase.rpc('is_admin');
  if (roleError || isAdmin!==true) abort('Super-admin permission is required for importing books.');
}
async function upload(bucket,path,file,uploads) {
  const {error}=await supabase.storage.from(bucket).upload(path,file,
    {upsert:false,contentType:imgMime(file),cacheControl:'3600'});
  if (error) abort(`Storage upload failed (${file.name}): ${error.message}`);
  uploads.push({bucket,path});
  const {data}=supabase.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) abort(`Could not obtain public URL for ${file.name}`);
  return data.publicUrl;
}
async function eachLimited(items, concurrency, fn) {
  const output = new Array(items.length);
  let next=0;
  let firstError=null;
  const worker=async () => {
    while (!firstError && next < items.length) {
      const index=next++;
      try { output[index]=await fn(items[index],index); }
      catch(e) { firstError=e; }
    }
  };
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},worker));
  if (firstError) throw firstError;
  return output;
}
async function cleanup(bookId, assets) {
  const errors=[];
  if (bookId) {
    for (const table of ['questions','chapters','books']) {
      const filter = table === 'books' ? 'id' : 'book_id';
      const {error}=await supabase.from(table).delete().eq(filter,bookId);
      if (error) errors.push(`${table}: ${error.message}`);
    }
  }
  for (const bucket of new Set(assets.map(a=>a.bucket))) {
    const paths=assets.filter(a=>a.bucket===bucket).map(a=>a.path);
    for (let i=0;i<paths.length;i+=100) {
      const {error}=await supabase.storage.from(bucket).remove(paths.slice(i,i+100));
      if(error)errors.push(`${bucket}: ${error.message}`);
    }
  }
  return errors;
}
async function importFolder(book) {
  const {meta,coverFile,chapters,groups,totalQuestions,imageCount}=book;
  let bookId=null,uploadedImages=0,insertedQuestions=0;
  const assets=[];
  try {
    report(`Checking admin access and duplicate books...\n${chapters.length} chapters · ${totalQuestions} questions · ${imageCount} images · 1 cover`);
    await adminCheck();
    const allowedSpecialties=new Set(Array.from(document.querySelectorAll('#bookSpecialty option'))
      .map(o=>o.value).filter(Boolean));
    if(allowedSpecialties.size && !allowedSpecialties.has(meta.speciality))
      abort(`Unknown specialty in book.json: ${meta.speciality}. Use a specialty listed in Add New Book.`);
    for(const linked of meta.linked_specialties) if(allowedSpecialties.size && !allowedSpecialties.has(linked))
      abort(`Unknown linked specialty in book.json: ${linked}`);
    await resolveDisciplines(book);
    // Don't create duplicate copies on an accidental second folder selection.
    const existing=await supabase.from('books').select('id').eq('title',meta.title)
      .eq('speciality',meta.speciality).limit(1);
    if(existing.error) throw existing.error;
    if(existing.data?.length) abort('A book with this exact title and specialty already exists. Rename it in book.json to import a separate copy.');
    // Stage as non-public TEST so partial imports are not exposed as a live book.
    const created=await supabase.from('books').insert([{title:meta.title,description:meta.description,
      speciality:meta.speciality,image:'pending-cover',access_level:'test',
      linked_specialties:[]}]).select('id').single();
    if(created.error) throw created.error;
    bookId=created.data.id;
    const coverExtension=coverFile.name.split('.').pop().toLowerCase();
    report('Uploading cover.png and creating book...');
    const coverUrl=await upload('book_covers',`books/${bookId}/cover.${coverExtension}`,coverFile,assets);
    for (const [chapterIndex, chapter] of chapters.entries()) {
      report(`Creating chapter ${chapterIndex+1}/${chapters.length}: ch${chapter.chapterNumber} ${chapter.name}\nQuestions saved ${insertedQuestions}/${totalQuestions} · Images ${uploadedImages}/${imageCount}`);
      const createdChapter=await supabase.from('chapters').insert([{
        book_id:bookId,chapterNumber:chapter.chapterNumber,name:chapter.name,
        description:chapter.description,discipline_id:chapter.discipline_id,is_free:false
      }]).select('id').single();
      if(createdChapter.error) throw createdChapter.error;
      const chapterId=createdChapter.data.id;
      const rows=[];
      for(const q of chapter.questions){
        const key=`${chapter.chapterNumber}:${q.questionNumber}`;
        const questionEntries=groups.get(`${key}:q`) || [];
        const explanationEntries=groups.get(`${key}:e`) || [];
        // Preserve numeric positions in the returned URLs even with parallel uploads.
        const allEntries=[...questionEntries,...explanationEntries];
        const urls=await eachLimited(allEntries,LIMITS.uploadParallel,async entry => {
          const ext=entry.file.name.split('.').pop().toLowerCase();
          const filePath=`chapter_${chapterId}/book_${bookId}/ch${chapter.chapterNumber}-${entry.kind}${entry.questionNumber}-${entry.index}-${crypto.randomUUID()}.${ext}`;
          const url=await upload('question_images',filePath,entry.file,assets);
          uploadedImages++;
          report(`Ch ${chapter.chapterNumber} Q${q.questionNumber}: ${uploadedImages}/${imageCount} images uploaded\n${insertedQuestions}/${totalQuestions} questions saved`);
          return url;
        });
        const qi=urls.slice(0,questionEntries.length);
        const ei=urls.slice(questionEntries.length);
        rows.push({questionNumber:q.questionNumber,question:q.question,options:q.options,
          correctAnswerIndex:q.correctAnswerIndex,explanation:q.explanation,
          imageUrl:qi[0] || null,imageUrls:qi.length ? qi : null,
          explanationImageUrl:ei[0] || null,explanationImageUrls:ei.length ? ei : null,
          book_id:bookId,chapter_id:chapterId,discipline_id:chapter.discipline_id});
      }
      for(let offset=0;offset<rows.length;offset+=LIMITS.chunk){
        const page=rows.slice(offset,offset+LIMITS.chunk);
        const result=await supabase.from('questions').insert(page);
        if(result.error) throw result.error;
        insertedQuestions+=page.length;
        report(`Chapter ${chapterIndex+1}/${chapters.length} done in batches\n${insertedQuestions}/${totalQuestions} questions · ${uploadedImages}/${imageCount} images`);
      }
    }
    // Verify persisted question count before publishing.
    const counted=await supabase.from('questions').select('id',{head:true,count:'exact'}).eq('book_id',bookId);
    if(counted.error) throw counted.error;
    if(counted.count !== totalQuestions) abort(`Saved question count mismatch: expected ${totalQuestions}, found ${counted.count}.`);
    if(meta.access_level==='free') {
      const freeUpdate=await supabase.from('chapters').update({is_free:true}).eq('book_id',bookId);
      if(freeUpdate.error) throw freeUpdate.error;
    }
    // Publishing is intentionally the final DB write.
    const publication=await supabase.from('books').update({image:coverUrl,
      access_level:meta.access_level,linked_specialties:meta.linked_specialties}).eq('id',bookId);
    if(publication.error) throw publication.error;
    sessionStorage.removeItem('masterBookList');
    return {bookId, title:meta.title, chapters:chapters.length,questions:insertedQuestions,
      images:uploadedImages,coverUrl};
  } catch(error) {
    const message=error instanceof Error ? error.message : String(error);
    report(`Import failed: ${message}\nCleaning up any partial data...`,true);
    const problems=await cleanup(bookId,assets);
    const detail=problems.length ? `Cleanup incomplete for book ID ${bookId}: ${problems.join(' | ')}`:
      'Newly created book records and uploaded files have been cleaned up.';
    throw new Error(`${message}\n${detail}`);
  }
}
async function onFolderSelected() {
  const files=Array.from(inputEl.files || []);
  // Allow importing the same folder again after an error.
  inputEl.value='';
  if (!files.length || busy) return;
  busy=true;
  importTrigger.disabled=true;
  openEl.hidden=true;
  closeEl.disabled=true;
  visible(true);
  report('Reading selected folder. Validating JSON, filenames and matching all images...');
  try {
    const book=await readFolder(files);
    const result=await importFolder(book);
    report(`SUCCESS — ${result.title}\n${result.chapters} chapters · ${result.questions} questions · ${result.images} images · 1 cover\nThe book is now published and ready in Manage Chapters.`);
    openEl.href=`manage_chapters.html?bookId=${encodeURIComponent(result.bookId)}`;
    openEl.hidden=false;
  } catch(err) {
    console.error('Whole-book folder import failed:',err);
    report(`Import failed:\n${err?.message || err}`,true);
  } finally {
    busy=false;
    importTrigger.disabled=false;
    closeEl.disabled=false;
  }
}
function init() {
  const form=document.getElementById('addBookForm');
  if (!form || document.getElementById('qzBookFolderTrigger')) return;
  const actions=form.querySelector('.flex.justify-end.pt-4');
  if(!actions) return console.error('Book import: cannot find Add New Book action row');
  importTrigger=document.createElement('button');
  importTrigger.id='qzBookFolderTrigger';
  importTrigger.type='button';
  importTrigger.className='bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-3 rounded-lg mr-auto';
  importTrigger.textContent='Import Entire Book Folder';
  actions.prepend(importTrigger);
  actions.classList.add('flex-wrap','gap-2');
  inputEl=document.createElement('input');
  inputEl.type='file';
  inputEl.multiple=true;
  inputEl.setAttribute('webkitdirectory','');
  inputEl.setAttribute('directory','');
  inputEl.style.display='none';
  document.body.append(inputEl);
  panel=document.createElement('div');
  panel.id='qzFolderImportProgress';
  panel.hidden=true;
  Object.assign(panel.style,{position:'fixed',inset:'0',zIndex:'99999',display:'none',
    alignItems:'center',justifyContent:'center',background:'rgba(15,23,42,.76)',padding:'16px'});
  const content=document.createElement('section');
  Object.assign(content.style,{width:'min(560px,100%)',background:'#fff',color:'#1e293b',
    borderRadius:'14px',padding:'24px',boxShadow:'0 20px 60px #0005'});
  const heading=document.createElement('h3');
  heading.textContent='Import Entire Book Folder';
  Object.assign(heading.style,{fontSize:'22px',fontWeight:'700',marginBottom:'12px'});
  const tip=document.createElement('p');
  tip.textContent='Folder selection automatically validates and imports the book, all chapters, all images and the cover. Keep this tab open until complete.';
  Object.assign(tip.style,{fontSize:'13px',color:'#475569',marginBottom:'16px'});
  statusEl=document.createElement('pre');
  statusEl.setAttribute('aria-live','polite');
  Object.assign(statusEl.style,{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontFamily:'inherit',
    fontSize:'14px',lineHeight:'1.6',border:'1px solid #c7d2fe',padding:'12px',borderRadius:'8px'});
  const controls=document.createElement('div');
  Object.assign(controls.style,{display:'flex',gap:'12px',justifyContent:'flex-end',marginTop:'20px'});
  openEl=document.createElement('a');
  openEl.textContent='Open Imported Book';
  openEl.hidden=true;
  Object.assign(openEl.style,{background:'#7c3aed',color:'#fff',padding:'10px 14px',borderRadius:'8px',fontWeight:'600'});
  closeEl=document.createElement('button');
  closeEl.type='button';
  closeEl.textContent='Close';
  Object.assign(closeEl.style,{background:'#e2e8f0',padding:'10px 16px',borderRadius:'8px'});
  controls.append(openEl,closeEl);
  content.append(heading,tip,statusEl,controls);
  panel.append(content);
  document.body.append(panel);
  closeEl.addEventListener('click',()=>{if (!busy) visible(false);});
  importTrigger.addEventListener('click',()=>{
    if(busy) return;
    if(document.getElementById('bookId')?.value) {
      alert('Import Entire Book creates a NEW book. Open Add New Book, not Edit Book.');
      return;
    }
    if(!('webkitdirectory' in inputEl)) return alert('Folder selection requires Google Chrome or Microsoft Edge.');
    inputEl.click();
  });
  inputEl.addEventListener('change',onFolderSelected);
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});
else init();
