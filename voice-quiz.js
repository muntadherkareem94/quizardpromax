/* Quizard Voice Quiz Assistant v1
   One hands-free mode. Uses Quizard's existing DOM buttons for grading/navigation.
   Browser speech recognition support varies by browser and network.
*/
(() => {
  'use strict';

  const icon = document.getElementById('voiceQuizIcon');
  if (!icon || document.getElementById('qvWindow')) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const STORAGE_KEY = 'quizardVoiceSettingsV1';
  const TUTORIAL_KEY = 'quizardVoiceTutorialV1';
  const LAST_USED_KEY = 'quizardVoiceLastUsedV1';
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const DEFAULT_COMMANDS = {
    repeat: 'repeat question',
    options: 'repeat options',
    explanation: 'read explanation',
    next: 'next question',
    previous: 'previous question',
    skip: 'skip question',
    pause: 'pause',
    resume: 'resume',
    help: 'voice help',
    stop: 'stop voice mode'
  };
  const COMMAND_LABELS = {
    repeat: 'Read question again', options: 'Repeat choices',
    explanation: 'Read explanation', next: 'Next question',
    previous: 'Previous question', skip: 'Skip unanswered question',
    pause: 'Pause narration', resume: 'Resume narration',
    help: 'Hear available commands', stop: 'Stop voice mode'
  };
  function readStore(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  }
  let settings = { speed: 1, voice: '', autoExplanation: true,
    answerPrefix: 'answer', commands: { ...DEFAULT_COMMANDS } };
  try {
    const previous = JSON.parse(readStore(STORAGE_KEY) || '{}');
    settings = { ...settings, ...previous,
      commands: { ...DEFAULT_COMMANDS, ...(previous.commands || {}) } };
  } catch { /* use defaults */ }

  const css = document.createElement('style');
  css.textContent = `
    #qvWindow[hidden]{display:none!important}
    #qvWindow{position:fixed;inset:0;z-index:110000;background:rgba(15,23,42,.55);
      display:flex;justify-content:center;align-items:center;padding:14px;font-family:Inter,Arial,sans-serif}
    #qvWindow *{box-sizing:border-box}
    #qvPanel{background:#fff;color:#1f2937;width:min(100%,560px);max-height:min(88vh,850px);
      overflow:auto;border-radius:18px;box-shadow:0 20px 65px #0003}
    #qvPanel button{cursor:pointer;border-radius:9px;border:1px solid #ddd;padding:9px 13px;
      font-weight:650;font-size:13px;background:#fff;color:#374151}
    #qvPanel button:hover{background:#f5f3ff;border-color:#a78bfa}
    #qvPanel button:disabled{opacity:.5;cursor:not-allowed}
    #qvPanel .qvPrimary{background:#6d28d9;color:white;border-color:#6d28d9}
    #qvPanel .qvPrimary:hover{background:#5b21b6;color:white}
    #qvPanel .qvDanger{color:#b91c1c;border-color:#fecaca}
    #qvPanel .qvHeader{display:flex;justify-content:space-between;align-items:center;
      gap:10px;padding:18px 20px;border-bottom:1px solid #e5e7eb}
    #qvPanel .qvHeader strong{font-size:17px;color:#111827}
    #qvPanel .qvBody{padding:20px}
    #qvPanel .qvPill{display:inline-flex;align-items:center;border-radius:99px;
      background:#f3f4f6;padding:7px 11px;color:#4b5563;font-size:12px;font-weight:700}
    #qvPanel .qvRow{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin:14px 0}
    #qvPanel .qvBox{padding:16px;border:1px solid #e5e7eb;border-radius:12px;background:#faf9ff}
    #qvPanel .qvMuted{color:#6b7280;font-size:13px;line-height:1.6}
    #qvPanel .qvHeading{font-size:19px;font-weight:750;margin:8px 0 12px;color:#1f2937}
    #qvPanel .qvCmd{display:flex;justify-content:space-between;gap:10px;align-items:center;
      border-bottom:1px solid #e5e7eb;padding:9px 0;font-size:13px}
    #qvPanel .qvCmd:last-child{border-bottom:0}
    #qvPanel code{background:#ede9fe;color:#5b21b6;border-radius:5px;
      padding:3px 6px;font-weight:700;font-size:12px}
    #qvPanel input[type=text],#qvPanel select{border:1px solid #d1d5db;border-radius:8px;
      padding:9px 10px;min-width:0;width:100%;font-size:13px;color:#1f2937;background:#fff}
    #qvPanel input[type=range]{width:100%}
    #qvPanel label{font-size:13px;font-weight:650;color:#374151}
    #qvPanel .qvField{display:grid;grid-template-columns:1fr 1.15fr;gap:10px;
      align-items:center;margin:10px 0}
    #qvPanel .qvHidden{display:none!important}
    #qvPanel .qvDots{display:flex;justify-content:center;gap:7px;margin:14px 0}
    #qvPanel .qvDot{height:7px;width:7px;border-radius:20px;background:#d1d5db}
    #qvPanel .qvDot.on{width:20px;background:#7c3aed}
    @media(max-width:480px){#qvPanel .qvBody{padding:14px}#qvPanel .qvField{grid-template-columns:1fr}}
  `;
  document.head.appendChild(css);

  const windowEl = document.createElement('div');
  windowEl.id = 'qvWindow';
  windowEl.hidden = true;
  windowEl.setAttribute('role', 'dialog');
  windowEl.setAttribute('aria-modal', 'true');
  windowEl.setAttribute('aria-label', 'Quizard Voice Assistant');
  windowEl.innerHTML = `
    <div id="qvPanel">
      <div class="qvHeader"><div><strong>🎙 Voice Quiz Assistant</strong>
        <div class="qvMuted">One hands-free study mode</div></div>
        <button id="qvClose" type="button" aria-label="Close voice window">✕</button></div>
      <div class="qvBody">
        <section id="qvHome">
          <div class="qvBox"><span class="qvPill" id="qvStatus" role="status" aria-live="polite">Ready</span>
            <div class="qvHeading" style="margin-top:12px">Listen, answer, learn.</div>
            <p class="qvMuted">Quizard reads each question and its options, waits for your voice answer,
              checks it using the existing quiz, and can read its explanation.</p>
            <p class="qvMuted" id="qvLastHeard">Tap Start to begin.</p></div>
          <div class="qvRow">
            <button id="qvStart" class="qvPrimary" type="button">▶ Start hands-free</button>
            <button id="qvStop" class="qvDanger" type="button">■ Stop</button>
            <button id="qvRepeat" type="button">↻ Repeat question</button>
          </div>
          <div class="qvRow">
            <button id="qvTutorial" type="button">Tutorial</button>
            <button id="qvCommands" type="button">Commands / Help</button>
            <button id="qvSettings" type="button">Settings</button>
          </div>
          <p class="qvMuted">Headphones recommended. Microphone permission is needed.
            Voice recognition may require internet. With screen locked or browser suspended,
            continuous operation is not guaranteed.</p>
        </section>
        <section id="qvTutorialPage" class="qvHidden">
          <span class="qvPill" id="qvStep">Step 1 of 4</span>
          <div class="qvHeading" id="qvSlideTitle"></div>
          <div class="qvBox" id="qvSlideBody"></div>
          <div class="qvDots" id="qvDots"></div>
          <div class="qvRow" style="justify-content:space-between">
            <button id="qvSlideBack" type="button">Back</button>
            <button id="qvSlideSkip" type="button">Skip tutorial</button>
            <button id="qvSlideNext" class="qvPrimary" type="button">Next</button>
          </div>
        </section>
        <section id="qvCommandsPage" class="qvHidden">
          <div class="qvHeading">Voice commands</div>
          <p class="qvMuted">Speak when Quizard says it is listening. To answer, say
            <code id="qvAnswerExample">Answer B</code>. To change commands, open Settings.</p>
          <div id="qvCommandList" class="qvBox"></div>
          <div class="qvRow"><button data-qv-home type="button">← Back to assistant</button></div>
        </section>
        <section id="qvSettingsPage" class="qvHidden">
          <div class="qvHeading">Voice settings</div>
          <div class="qvField"><label for="qvVoice">Reading voice</label><select id="qvVoice"></select></div>
          <div class="qvField"><label for="qvSpeed">Reading speed: <span id="qvSpeedLabel"></span></label>
            <input id="qvSpeed" type="range" min="0.7" max="1.6" step="0.1"></div>
          <label><input id="qvAutoExplain" type="checkbox"> Automatically read explanation after answering</label>
          <div class="qvHeading" style="font-size:16px;margin-top:20px">Customize commands</div>
          <p class="qvMuted">Use short, distinct English phrases. They are saved on this device.</p>
          <div id="qvCustomFields"></div>
          <div class="qvField"><label for="qvAnswerPrefix">Answer prefix (e.g. “answer B”)</label>
            <input id="qvAnswerPrefix" type="text" maxlength="30"></div>
          <p class="qvMuted" id="qvSettingsError" role="alert"></p>
          <div class="qvRow">
            <button id="qvSaveSettings" class="qvPrimary" type="button">Save settings</button>
            <button id="qvResetSettings" type="button">Reset commands</button>
            <button data-qv-home type="button">Cancel</button>
          </div>
        </section>
      </div>
    </div>`;
  document.body.appendChild(windowEl);

  const $ = (id) => document.getElementById(id);
  const sections = ['qvHome', 'qvTutorialPage', 'qvCommandsPage', 'qvSettingsPage'];
  const slides = [
    { title: 'Welcome to hands-free Quizard', body:
      'Wear headphones, open a quiz, and tap Start. Quizard reads the question and each available choice, then waits for your response. Keep the page open and give the browser microphone permission.' },
    { title: 'Answer aloud', body:
      'After the choices, say “Answer B”, “Option C”, or just the answer letter. Your choice is submitted to the existing Quizard grading system. Once an answer is submitted, it cannot be changed through voice mode.' },
    { title: 'Control your studying', body:
      'Say “Repeat question”, “Repeat options”, “Read explanation”, “Next question”, “Previous question”, or “Skip question”. Say “Voice help” to hear the main commands. To change these phrases, open Settings.' },
    { title: 'Important things to know', body:
      'The microphone listens after the narration, not while Quizard is speaking. Recognition sometimes mishears words and can require internet. Keep your screen awake for reliable testing; this browser version is not guaranteed to operate on a locked phone. You can revisit this tutorial and the commands whenever you want.' }
  ];

  let active = false;
  let paused = false;
  let navigating = false;
  let speaking = false;
  let listening = false;
  let recognition = null;
  let speechToken = 0;
  let tutorialIndex = 0;
  let retryTimer = null;
  let selectedVoice = null;
  let voices = [];

  function status(message) { $('qvStatus').textContent = message; }
  function setPage(sectionId) {
    for (const id of sections) $(id).classList.toggle('qvHidden', id !== sectionId);
    if (sectionId === 'qvCommandsPage') renderCommands();
    if (sectionId === 'qvSettingsPage') renderSettings();
  }
  function openWindow() {
    windowEl.hidden = false;
    icon.setAttribute('aria-expanded', 'true');
    const lastTutorial = Number(readStore(TUTORIAL_KEY) || '0');
    const lastUse = Number(readStore(LAST_USED_KEY) || '0');
    const lastActivity = Math.max(lastUse, lastTutorial);
    if (!lastActivity || Date.now() - lastActivity > THIRTY_DAYS) {
      tutorialIndex = 0;
      renderSlide();
      setPage('qvTutorialPage');
    } else setPage('qvHome');
  }
  function closeWindow() {
    windowEl.hidden = true;
    icon.setAttribute('aria-expanded', 'false');
  }
  function renderSlide() {
    $('qvStep').textContent = `Step ${tutorialIndex + 1} of ${slides.length}`;
    $('qvSlideTitle').textContent = slides[tutorialIndex].title;
    $('qvSlideBody').textContent = slides[tutorialIndex].body;
    $('qvSlideBack').disabled = tutorialIndex === 0;
    $('qvSlideNext').textContent = tutorialIndex === slides.length - 1 ? 'Start voice quiz' : 'Next';
    $('qvDots').innerHTML = slides.map((_, i) =>
      `<span class="qvDot ${i === tutorialIndex ? 'on' : ''}"></span>`).join('');
  }
  function finishTutorial(start) {
    writeStore(TUTORIAL_KEY, String(Date.now()));
    setPage('qvHome');
    if (start) startVoice();
  }
  function renderCommands() {
    $('qvAnswerExample').textContent = `${settings.answerPrefix} B`;
    const list = $('qvCommandList');
    list.replaceChildren();
    const add = (name, phrase) => {
      const row = document.createElement('div'); row.className = 'qvCmd';
      const label = document.createElement('span'); label.textContent = name;
      const code = document.createElement('code'); code.textContent = phrase;
      row.append(label, code); list.appendChild(row);
    };
    add('Select an answer', `${settings.answerPrefix} A, B, C...`);
    for (const [key, label] of Object.entries(COMMAND_LABELS)) add(label, settings.commands[key]);
  }
  function listVoices() {
    if (!canSpeak) return;
    voices = window.speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith('en'));
    const select = $('qvVoice');
    select.replaceChildren();
    select.add(new Option('System default voice', ''));
    voices.forEach(v => select.add(new Option(`${v.name} (${v.lang})`, v.voiceURI)));
    select.value = voices.some(v => v.voiceURI === settings.voice) ? settings.voice : '';
    selectedVoice = voices.find(v => v.voiceURI === settings.voice) || null;
  }
  function renderSettings() {
    $('qvSpeed').value = settings.speed;
    $('qvSpeedLabel').textContent = `${Number(settings.speed).toFixed(1)}×`;
    $('qvAutoExplain').checked = settings.autoExplanation;
    $('qvAnswerPrefix').value = settings.answerPrefix;
    $('qvSettingsError').textContent = '';
    const area = $('qvCustomFields'); area.replaceChildren();
    Object.entries(COMMAND_LABELS).forEach(([key, title]) => {
      const row = document.createElement('div'); row.className = 'qvField';
      const label = document.createElement('label'); label.textContent = title;
      label.htmlFor = `qvCmd-${key}`;
      const input = document.createElement('input'); input.type = 'text';
      input.id = `qvCmd-${key}`; input.maxLength = 40; input.value = settings.commands[key];
      row.append(label, input); area.appendChild(row);
    });
    listVoices();
  }
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  function saveSettings() {
    const commands = {};
    for (const key of Object.keys(DEFAULT_COMMANDS)) commands[key] =
      normalize($(`qvCmd-${key}`).value);
    const answerPrefix = normalize($('qvAnswerPrefix').value);
    const all = [...Object.values(commands), answerPrefix];
    if (all.some(s => s.length < 2) || new Set(all).size !== all.length ||
        all.some(s => s.length > 40)) {
      $('qvSettingsError').textContent = 'Every command must be distinct and at least 2 characters long.';
      return;
    }
    settings = { speed: Number($('qvSpeed').value), voice: $('qvVoice').value,
      autoExplanation: $('qvAutoExplain').checked, answerPrefix, commands };
    writeStore(STORAGE_KEY, JSON.stringify(settings));
    selectedVoice = voices.find(v => v.voiceURI === settings.voice) || null;
    setPage('qvHome');
    status('Settings saved');
  }

  function stopListening() {
    clearTimeout(retryTimer);
    listening = false;
    if (recognition) { try { recognition.abort(); } catch {} }
  }
  function stopSpeaking() {
    speechToken++;
    speaking = false;
    if (canSpeak) window.speechSynthesis.cancel();
  }
  function stopVoice() {
    active = false; paused = false; navigating = false;
    stopListening(); stopSpeaking();
    status('Stopped');
    icon.classList.remove('active');
    $('qvStart').textContent = '▶ Start hands-free';
  }
  function textChunks(text) {
    const parts = String(text).replace(/\s+/g, ' ').trim().match(/.{1,170}(?:\s|$)|\S+/g);
    return (parts || []).map(s => s.trim()).filter(Boolean);
  }
  function say(text, done = () => {}) {
    if (!active || !canSpeak) return;
    stopListening(); stopSpeaking();
    const myToken = speechToken;
    speaking = true;
    status('Speaking…');
    const chunks = textChunks(text);
    if (!chunks.length) { speaking = false; done(); return; }
    let pos = 0;
    function nextChunk() {
      if (!active || myToken !== speechToken) return;
      if (pos >= chunks.length) {
        speaking = false;
        done();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[pos++]);
      utterance.lang = selectedVoice?.lang || 'en-US';
      utterance.rate = settings.speed;
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.onend = nextChunk;
      utterance.onerror = (e) => {
        if (myToken !== speechToken || !active) return;
        console.warn('Voice narration error', e.error);
        speaking = false;
        status('Speech playback interrupted. Press Repeat.');
      };
      window.speechSynthesis.speak(utterance);
    }
    nextChunk();
  }
  const plainText = (el) => el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  function quizReady() {
    return !$('quizContainer')?.classList.contains('hidden') &&
      plainText($('questionDisplay')) && $('optionsContainer')?.querySelectorAll('input[name="quizOption"]').length;
  }
  function getOptions() { return [...document.querySelectorAll('#optionsContainer label')]; }
  function hasExplanation() { return !$('explanationDisplay')?.classList.contains('hidden') && plainText($('explanationText')); }
  function announceQuestion() {
    if (!quizReady()) { say('The quiz is not ready. Please open a question first.', listen); return; }
    const n = plainText($('currentQuestionNumber'));
    const total = plainText($('totalQuestions'));
    const q = plainText($('questionDisplay'));
    const options = getOptions().map((node, i) =>
      `${String.fromCharCode(65 + i)}. ${plainText(node.querySelector('.option-text'))}`);
    const ending = hasExplanation()
      ? 'This question was already answered. Say read explanation, next question, or previous question.'
      : `What is your answer? Say ${settings.answerPrefix} B, repeat question, skip question, or next question.`;
    say(`Question ${n} of ${total}. ${q}. ${options.join('. ')}. ${ending}`, listen);
  }
  function readOptions() {
    if (!quizReady()) { status('Quiz is not ready'); return; }
    const options = getOptions().map((node, i) =>
      `${String.fromCharCode(65 + i)}. ${plainText(node.querySelector('.option-text'))}`);
    say(`${options.join('. ')}. What is your answer?`, listen);
  }
  function readExplanation() {
    if (!hasExplanation()) {
      say('Please answer this question first, then I can read its explanation.', listen);
      return;
    }
    say(`Explanation. ${plainText($('explanationText'))}. Say next question, previous question, or repeat question.`, listen);
  }
  function chooseAnswer(letter) {
    if (!quizReady()) { say('Quiz is not ready.', listen); return; }
    if (hasExplanation()) { say('This question has already been answered. Say next question or read explanation.', listen); return; }
    const index = letter.toUpperCase().charCodeAt(0) - 65;
    const inputs = [...document.querySelectorAll('#optionsContainer input[name="quizOption"]')];
    const radio = inputs[index];
    if (!radio || radio.disabled) { say(`Choice ${letter} is unavailable for this question.`, listen); return; }
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    const submit = $('submitAnswerButton');
    if (!submit) { say('Could not find the quiz submit button.', listen); return; }
    submit.click(); // Quizard's original grading, saving and progress system
    if (!hasExplanation()) { say('The answer could not be submitted. Please check the quiz screen.', listen); return; }
    const correctIndex = getOptions().findIndex(el => el.classList.contains('border-green-500'));
    const correctLetter = correctIndex >= 0 ? String.fromCharCode(65 + correctIndex) : '';
    const feedback = correctIndex < 0 ? 'Your answer was submitted.' :
      correctIndex === index ? `Correct. You selected ${letter}.` :
      `Incorrect. You selected ${letter}. The correct answer is ${correctLetter}.`;
    if (settings.autoExplanation) {
      say(`${feedback} Explanation. ${plainText($('explanationText'))}. Say next question, repeat question, or previous question.`, listen);
    } else say(`${feedback} Say read explanation or next question.`, listen);
  }
  function moveQuestion(direction) {
    if (!quizReady()) { say('Quiz is not ready.', listen); return; }
    const current = plainText($('currentQuestionNumber'));
    const n = Number(current);
    const total = Number(plainText($('totalQuestions')));
    if (direction === 'previous' && n <= 1) { say('This is the first question.', listen); return; }
    if (direction === 'next' && n >= total) {
      say('This is the last question. To finish the quiz, use the Finish Quiz button on screen.', listen);
      return;
    }
    const button = $(direction === 'previous' ? 'backButton' : 'nextButton');
    if (!button || button.disabled) { say('That navigation is currently unavailable.', listen); return; }
    stopListening();
    navigating = true;
    status('Moving to another question…');
    button.click(); // Quizard's original navigation system
    let tries = 0;
    function waitForQuestion() {
      if (!active) return;
      const newNumber = plainText($('currentQuestionNumber'));
      const text = plainText($('questionDisplay'));
      if (newNumber !== current && text && !/loading question data/i.test(text) &&
          getOptions().length) { navigating = false; announceQuestion(); return; }
      if (++tries < 35) { retryTimer = setTimeout(waitForQuestion, 200); return; }
      navigating = false;
      say('The next question has not loaded yet. Please check your connection and say repeat question.', listen);
    }
    retryTimer = setTimeout(waitForQuestion, 350);
  }
  function markActivity() {
    // Spoken interaction is genuine user activity; allow existing quiz timer to reset.
    document.dispatchEvent(new Event('keypress', { bubbles: true }));
  }
  function listen() {
    if (!active || speaking || navigating || document.hidden) return;
    if (!SpeechRecognition) { status('Speech recognition unavailable in this browser'); return; }
    if (listening) return;
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;
    recognition.onstart = () => { listening = true; status(paused ? 'Paused — say resume to continue' : 'Listening for your command…'); };
    recognition.onresult = (event) => {
      const alternatives = Array.from(event.results[0]).map(a => a.transcript);
      $('qvLastHeard').textContent = `Heard: ${alternatives[0]}`;
      stopListening();
      for (const phrase of alternatives) {
        if (handleCommand(phrase)) return;
      }
      say('I did not recognize that command. Say voice help to hear the available commands.', listen);
    };
    recognition.onerror = (event) => {
      listening = false;
      if (!active || event.error === 'aborted') return;
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(event.error)) {
        active = false;
        stopSpeaking();
        status(`Microphone unavailable: ${event.error}. Press Start to retry.`);
        $('qvStart').textContent = '▶ Retry hands-free';
        return;
      }
      status(`Listening interrupted (${event.error}). Retrying…`);
    };
    recognition.onend = () => {
      listening = false;
      if (active && !speaking && !navigating && !document.hidden) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(listen, 900);
      }
    };
    try { recognition.start(); }
    catch (e) { listening = false; status('Could not start microphone. Press Start again.'); }
  }
  function handleCommand(raw) {
    const phrase = normalize(raw);
    if (!phrase) return false;
    if (paused) {
      if (phrase === normalize(settings.commands.resume)) {
        paused = false; markActivity(); announceQuestion(); return true;
      }
      if (phrase === normalize(settings.commands.stop)) { stopVoice(); return true; }
      if (phrase === normalize(settings.commands.help)) {
        say(`Paused. Say ${settings.commands.resume} to continue or ${settings.commands.stop} to stop.`, listen);
        return true;
      }
      say(`Voice mode is paused. Say ${settings.commands.resume} to continue.`, listen);
      return true;
    }
    const words = { a:'a', ay:'a', hey:'a', b:'b', bee:'b', be:'b', c:'c', see:'c', sea:'c', d:'d', dee:'d', e:'e', ee:'e', f:'f', eff:'f', g:'g', gee:'g', h:'h', aitch:'h' };
    const match = phrase.match(/^(?:(?:my )?(?:answer|option|choice|select|i choose|i pick)\s+)?([a-z]+)$/);
    const prefix = normalize(settings.answerPrefix);
    const customMatch = phrase.startsWith(prefix + ' ') ? phrase.slice(prefix.length + 1) : '';
    const answerWord = customMatch || (match ? match[1] : '');
    if (words[answerWord] && words[answerWord].charCodeAt(0) - 97 < getOptions().length) {
      markActivity(); chooseAnswer(words[answerWord]); return true;
    }
    for (const [action, command] of Object.entries(settings.commands)) {
      if (phrase !== normalize(command)) continue;
      markActivity();
      if (action === 'repeat') announceQuestion();
      if (action === 'options') readOptions();
      if (action === 'explanation') readExplanation();
      if (action === 'next' || action === 'skip') moveQuestion('next');
      if (action === 'previous') moveQuestion('previous');
      if (action === 'pause') {
        paused = true;
        say(`Paused. Say ${settings.commands.resume} to continue.`, listen);
      }
      if (action === 'resume') { paused = false; announceQuestion(); }
      if (action === 'help') say(`You may say ${settings.answerPrefix} B, ${settings.commands.repeat}, ${settings.commands.options}, ${settings.commands.explanation}, ${settings.commands.next}, ${settings.commands.previous}, ${settings.commands.skip}, or ${settings.commands.stop}.`, listen);
      if (action === 'stop') stopVoice();
      return true;
    }
    return false;
  }
  function startVoice() {
    if (!canSpeak || !SpeechRecognition) {
      status('This browser does not support both speech reading and microphone recognition. Try a current desktop Chrome browser.');
      return;
    }
    stopVoice();
    active = true; paused = false;
    writeStore(LAST_USED_KEY, String(Date.now()));
    icon.classList.add('active');
    $('qvStart').textContent = '↻ Restart narration';
    selectedVoice = voices.find(v => v.voiceURI === settings.voice) || null;
    announceQuestion();
  }

  icon.disabled = false;
  icon.removeAttribute('disabled');
  icon.title = 'Voice Quiz Assistant';
  icon.setAttribute('aria-label', 'Open Voice Quiz Assistant');
  icon.addEventListener('click', openWindow);
  $('qvClose').addEventListener('click', closeWindow);
  $('qvStart').addEventListener('click', startVoice);
  $('qvStop').addEventListener('click', stopVoice);
  $('qvRepeat').addEventListener('click', () => { if (!active) startVoice(); else announceQuestion(); });
  $('qvTutorial').addEventListener('click', () => { stopVoice(); tutorialIndex = 0; renderSlide(); setPage('qvTutorialPage'); });
  $('qvCommands').addEventListener('click', () => { stopVoice(); setPage('qvCommandsPage'); });
  $('qvSettings').addEventListener('click', () => { stopVoice(); setPage('qvSettingsPage'); });
  $('qvSlideBack').addEventListener('click', () => { tutorialIndex = Math.max(0,tutorialIndex - 1); renderSlide(); });
  $('qvSlideNext').addEventListener('click', () => {
    if (tutorialIndex < slides.length - 1) { tutorialIndex++; renderSlide(); }
    else finishTutorial(true);
  });
  $('qvSlideSkip').addEventListener('click', () => finishTutorial(false));
  windowEl.querySelectorAll('[data-qv-home]').forEach(b =>
    b.addEventListener('click', () => setPage('qvHome')));
  $('qvSpeed').addEventListener('input', () =>
    $('qvSpeedLabel').textContent = `${Number($('qvSpeed').value).toFixed(1)}×`);
  $('qvSaveSettings').addEventListener('click', saveSettings);
  $('qvResetSettings').addEventListener('click', () => {
    Object.entries(DEFAULT_COMMANDS).forEach(([key, val]) => { $(`qvCmd-${key}`).value = val; });
    $('qvAnswerPrefix').value = 'answer';
    $('qvSettingsError').textContent = 'Defaults restored in the form. Click Save settings to apply.';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) {
      // Browser may suspend recognition in the background; don't spam restart attempts.
      stopListening(); stopSpeaking(); paused = true;
      status('Browser in background — tap Start to resume when visible');
    }
  });
  window.addEventListener('pagehide', stopVoice);
  if (canSpeak) {
    listVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', listVoices);
  }
})();
