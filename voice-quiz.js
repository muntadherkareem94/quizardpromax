/* Quizard Smart Voice Quiz Assistant v2
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
    expression: 65, medicalPronunciation: true,
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
    #qvPanel .qvNote{margin:8px 0 16px;padding:11px 12px;border-radius:9px;
      background:#f0f9ff;border:1px solid #bae6fd;color:#075985;font-size:12px;line-height:1.5}
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
      <div class="qvHeader"><div><strong>🎙 Smart Voice Assistant</strong>
        <div class="qvMuted">One hands-free study mode</div></div>
        <button id="qvClose" type="button" aria-label="Close voice window">✕</button></div>
      <div class="qvBody">
        <section id="qvHome">
          <div class="qvBox"><span class="qvPill" id="qvStatus" role="status" aria-live="polite">Ready</span>
            <div class="qvHeading" style="margin-top:12px">A more natural hands-free quiz.</div>
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
          
      
          <p class="qvMuted">Wait for the beep after Quizard finishes talking. To answer and submit immediately, say
            <code id="qvAnswerExample">My answer is B</code>.
            Do not say only a letter. You can also say Repeat question, Repeat options,
            Skip question, or Next question. Open Settings to customize other voice commands.</p>


          <div id="qvCommandList" class="qvBox"></div>
          <div class="qvRow"><button data-qv-home type="button">← Back to assistant</button></div>
        </section>
        <section id="qvSettingsPage" class="qvHidden">
          <div class="qvHeading">Voice settings</div>
          <div class="qvField"><label for="qvVoice">Reading voice</label><select id="qvVoice"></select></div>
          <p class="qvNote">Tip: Choose a voice with “Natural” or “Neural” in its name if available.
            Voice quality depends on your browser and device. No paid AI is used.</p>
          <div class="qvField"><label for="qvSpeed">Reading speed: <span id="qvSpeedLabel"></span></label>
            <input id="qvSpeed" type="range" min="0.7" max="1.6" step="0.05"></div>
          <div class="qvField"><label for="qvExpression">Speech expression: <span id="qvExpressionLabel"></span></label>
            <input id="qvExpression" type="range" min="0" max="100" step="10"></div>
          <label><input id="qvMedicalPronunciation" type="checkbox"> Improve spoken medical units and abbreviations</label><br>
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
      'After Quizard finishes reading the question and choices, wait for the beep. Then say “My answer is B” or another available letter. Quizard will immediately submit your answer and announce whether it is correct or wrong. You do not need to say Confirm. After the next beep, you can say Repeat question, Read explanation, Skip question, or Next question.' },


    { title: 'Control your studying', body:
      'Say “Repeat question”, “Repeat options”, “Read explanation”, “Next question”, “Previous question”, or “Skip question”. Say “Voice help” to hear the main commands. To change these phrases, open Settings.' },
    { title: 'Important things to know', body:
      'Choose a preferred English voice in Settings. Expressive reading adds pauses and gentle pitch variation, but browser speech is not an AI conversation. Quizard can read only the explanation saved with the question. Recognition may need internet and may stop when the phone is locked. Open Tutorial or Commands whenever needed.' }
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
    $('qvAnswerExample').textContent = 'My answer is B';

    const list = $('qvCommandList');
    list.replaceChildren();

    const add = (name, phrase) => {
      const row = document.createElement('div');
      row.className = 'qvCmd';

      const label = document.createElement('span');
      label.textContent = name;

      const code = document.createElement('code');
      code.textContent = phrase;

      row.append(label, code);
      list.appendChild(row);
    };

    add('Answer and submit', 'my answer is A / B / C / D ...');
    add('Alternative answer phrase', `${settings.answerPrefix} B`);

    for (const [key, label] of Object.entries(COMMAND_LABELS)) {
      add(label, settings.commands[key]);
    }
  }

  function listVoices() {
    if (!canSpeak) return;
    voices = window.speechSynthesis.getVoices()
      .filter(v => (v.lang || '').toLowerCase().startsWith('en'));
    const quality = v => {
      const name = (v.name || '').toLowerCase();
      return (/(natural|neural|premium|enhanced)/.test(name) ? 100 : 0) +
        (/(google|microsoft)/.test(name) ? 15 : 0) +
        (v.lang === 'en-US' ? 5 : 0) + (v.localService ? 2 : 0);
    };
    voices.sort((a, b) => quality(b) - quality(a));
    const select = $('qvVoice');
    select.replaceChildren();
    select.add(new Option('Best available English voice (automatic)', ''));
    voices.forEach(v => select.add(new Option(`${v.name} (${v.lang})`, v.voiceURI)));
    select.value = voices.some(v => v.voiceURI === settings.voice) ? settings.voice : '';
    selectedVoice = voices.find(v => v.voiceURI === settings.voice) || voices[0] || null;
  }
  function renderSettings() {
    $('qvSpeed').value = settings.speed;
    $('qvSpeedLabel').textContent = `${Number(settings.speed).toFixed(1)}×`;
    $('qvAutoExplain').checked = settings.autoExplanation;
    $('qvMedicalPronunciation').checked = settings.medicalPronunciation !== false;
    $('qvExpression').value = settings.expression ?? 65;
    $('qvExpressionLabel').textContent = `${settings.expression ?? 65}%`;
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
      expression: Number($('qvExpression').value),
      medicalPronunciation: $('qvMedicalPronunciation').checked,
      autoExplanation: $('qvAutoExplain').checked, answerPrefix, commands };
    writeStore(STORAGE_KEY, JSON.stringify(settings));
    selectedVoice = voices.find(v => v.voiceURI === settings.voice) || voices[0] || null;
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
    pendingAnswer = null;
    stopListening(); stopSpeaking();
    status('Stopped');
    icon.classList.remove('active');
    $('qvStart').textContent = '▶ Start hands-free';
  }
  // Speech script: preserve quiz content while introducing natural, separate beats.
  // Browser engines vary in how they honor pitch and punctuation.

  function pronunciationText(source) {
    let text = String(source || '').replace(/\s+/g, ' ').trim();
    if (!settings.medicalPronunciation) return text;

    // Expand medical measurement units before reading them aloud.
    // Important: µmol = micromoles; µg = micrograms (not interchangeable).
    const medicalUnits = [
      [/\bmg\s*\/\s*kg\s*\/\s*day\b/gi, 'milligrams per kilogram per day'],
      [/\bmg\s*\/\s*kg\b/gi, 'milligrams per kilogram'],
      [/\bmg\s*\/\s*d[lL]\b/gi, 'milligrams per deciliter'],
      [/\bmg\s*\/\s*m[lL]\b/gi, 'milligrams per milliliter'],
      [/\bmg\s*\/\s*[lL]\b/gi, 'milligrams per liter'],
      [/\bg\s*\/\s*d[lL]\b/gi, 'grams per deciliter'],
      [/(?:µ|μ|u)g\s*\/\s*[lL]\b/gi, 'micrograms per liter'],
      [/(?:µ|μ|u)g\s*\/\s*m[lL]\b/gi, 'micrograms per milliliter'],
      [/\bmcg\s*\/\s*[lL]\b/gi, 'micrograms per liter'],
      [/\bmcg\s*\/\s*m[lL]\b/gi, 'micrograms per milliliter'],
      [/\bng\s*\/\s*m[lL]\b/gi, 'nanograms per milliliter'],
      [/\bpg\s*\/\s*m[lL]\b/gi, 'picograms per milliliter'],
      [/(?:µ|μ|u)mol\s*\/\s*[lL]\b/gi, 'micromoles per liter'],
      [/\bmmol\s*\/\s*[lL]\b/gi, 'millimoles per liter'],
      [/\bmEq\s*\/\s*[lL]\b/gi, 'milliequivalents per liter'],
      [/\bmIU\s*\/\s*m[lL]\b/gi, 'milli international units per milliliter'],
      [/\bIU\s*\/\s*[lL]\b/gi, 'international units per liter'],
      [/\bIU\s*\/\s*m[lL]\b/gi, 'international units per milliliter'],
      [/\bU\s*\/\s*[lL]\b/gi, 'units per liter'],
      [/\bmm\s*Hg\b/gi, 'millimeters of mercury'],
      [/\bcm\s*H2O\b/gi, 'centimeters of water'],
      [/\bmIU\b/gi, 'milli international units'],
      [/\bIU\b/gi, 'international units'],
      [/(?:µ|μ|u)mol\b/gi, 'micromoles'],
      [/(?:µ|μ|u)g\b/gi, 'micrograms'],
      [/\bmcg\b/gi, 'micrograms'],
      [/\bmg\b/gi, 'milligrams'],
      [/\bm[lL]\b/g, 'milliliters'],
      [/\bHbA1c\b/gi, 'hemoglobin A one C'],
      [/\bECG\b/g, 'E C G'],
      [/\bMRI\b/g, 'M R I'],
      [/\bCT\b/g, 'C T'],
      [/\bIgG4\b/g, 'I G G four']
    ];
    for (const [pattern, spoken] of medicalUnits) {
      text = text.replace(pattern, spoken);
    }

    // Phonetic hints for common medications, based on MedlinePlus.
    // These affect narration only; the actual question is unchanged.
    const medicationNames = {
      lisinopril: 'lye sin oh pril',
      amlodipine: 'am loh dih peen',
      carvedilol: 'kar veh dil ol',
      metoprolol: 'meh toe proh lohl',
      furosemide: 'fyur oh seh mide',
      spironolactone: 'speer on oh lak tone'
    };
    for (const [name, spoken] of Object.entries(medicationNames)) {
      text = text.replace(new RegExp(`\\b${name}\\b`, 'gi'), spoken);
    }

    // Say percent ranges as ranges rather than two isolated numbers.
    return text
      .replace(/(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*%/g,
        '$1 to $2 percent')
      .replace(/(\d+(?:\.\d+)?)\s*%/g, '$1 percent');
  }

  function sentences(text, style = 'normal', pauseAfter = 110) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];

    // Sentence segmentation avoids awkward pauses inside numbers such as 3.5.
    let fragments = [];
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      try {
        fragments = Array.from(
          new Intl.Segmenter('en', { granularity: 'sentence' }).segment(clean),
          item => item.segment.trim()
        );
      } catch { /* Use fallback below. */ }
    }
    if (!fragments.length) {
      fragments = clean.match(/[^.!?]+(?:[.!?]+|$)/g) || [clean];
    }

    const result = [];
    for (const fragment of fragments) {
      const sentence = fragment.trim();
      if (!sentence) continue;
      // Long clinical cases can exceed the limits of some speech engines.
      if (sentence.length <= 240) {
        result.push({ text: sentence, style, pauseAfter });
        continue;
      }
      const words = sentence.split(/\s+/);
      let chunk = '';
      for (const word of words) {
        if (chunk && (chunk + ' ' + word).length > 220) {
          result.push({ text: chunk, style, pauseAfter: 60 });
          chunk = '';
        }
        chunk += (chunk ? ' ' : '') + word;
      }
      if (chunk) result.push({ text: chunk, style, pauseAfter });
    }
    return result;
  }


  function say(input, done = () => {}) {
    if (!active || !canSpeak) return;
    stopListening(); stopSpeaking();
    const myToken = speechToken;
    speaking = true;
    status('Speaking naturally…');
    const script = Array.isArray(input) ? input : sentences(input);
    if (!script.length) { speaking = false; done(); return; }

    // Different sentence types receive their own pacing and emphasis.
    // The selected device voice still determines the maximum voice quality.
    const profiles = {
      intro:       { pitch: 1.05, rate: 0.97 },
      question:    { pitch: 1.07, rate: 0.95 },
      option:      { pitch: 1.01, rate: 0.92 },
      result:      { pitch: 1.10, rate: 0.98 },
      explanation: { pitch: 0.98, rate: 0.93 },
      prompt:      { pitch: 1.08, rate: 0.96 },
      normal:      { pitch: 1.00, rate: 1.00 }
    };
    const expression = Math.max(0, Math.min(1, Number(settings.expression ?? 65) / 100));
    let position = 0;

    function nextPart() {
      if (!active || myToken !== speechToken) return;
      if (position >= script.length) {
        speaking = false;
        done();
        return;
      }
      const part = script[position++];
      if (!part.text) { nextPart(); return; }
      const profile = profiles[part.style] || profiles.normal;
      const utterance = new SpeechSynthesisUtterance(pronunciationText(part.text));
      utterance.lang = selectedVoice?.lang || 'en-US';
      utterance.voice = selectedVoice || null;
      const questionRise = part.style === 'question' && /\?\s*$/.test(part.text)
        ? 0.035 : 0;
      utterance.pitch = Math.max(0.8, Math.min(1.25,
        1 + (profile.pitch - 1 + questionRise) * expression));
      utterance.rate = Math.max(0.7, Math.min(1.5,
        Number(settings.speed || 1) * profile.rate));
      utterance.onend = () => {
        if (myToken !== speechToken || !active) return;
        const delay = Math.round((part.pauseAfter ?? 120) * (0.65 + expression * 0.6));
        retryTimer = setTimeout(nextPart, delay);
      };
      utterance.onerror = event => {
        if (myToken !== speechToken || !active) return;
        console.warn('Speech playback issue:', event.error);
        speaking = false;
        status('Speech interrupted. Press Repeat to try again.');
      };
      window.speechSynthesis.speak(utterance);
    }
    nextPart();
  }
  const plainText = (el) => el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  function quizReady() {
    return !$('quizContainer')?.classList.contains('hidden') &&
      plainText($('questionDisplay')) && $('optionsContainer')?.querySelectorAll('input[name="quizOption"]').length;
  }
  function getOptions() { return [...document.querySelectorAll('#optionsContainer label')]; }
  function getCleanOptionText(index) {
    const letter = String.fromCharCode(65 + index);
    const raw = plainText(getOptions()[index]?.querySelector('.option-text'));
    // Some question banks already include labels like "A.", "B)", "Option C:".
    // Remove ONLY the expected option letter when it is clearly a label.
    // Don't remove the "A" in a real answer such as "A patient with fever".
    const labelPattern = new RegExp(
      `^(?:option\\s+)?${letter}\\s*[.)\\]:\\-–—]\\s*`, 'i'
    );
    return raw.replace(labelPattern, '').trim();
  }
  function hasExplanation() { return !$('explanationDisplay')?.classList.contains('hidden') && plainText($('explanationText')); }
  function announceQuestion() {
    if (!quizReady()) { say('The quiz is not ready. Please open a question first.', listen); return; }
    const n = plainText($('currentQuestionNumber'));
    const total = plainText($('totalQuestions'));
    const q = plainText($('questionDisplay'));
    const options = getOptions().map((node, i) =>
      `Option ${String.fromCharCode(65 + i)}. ${getCleanOptionText(i)}`);
    
    
    const ending = hasExplanation()
      ? 'This question was already answered. Say read explanation, next question, or previous question.'
      : 'What is your answer? After the beep, say my answer is B, or another available letter.';


    const script = [
      { text: `Question ${n} of ${total}.`, style: 'intro', pauseAfter: 360 },
      ...sentences(q, 'question', 250),
      ...options.map(option => ({ text: option, style: 'option', pauseAfter: 380 })),
      ...sentences(ending, 'prompt', 120)
    ];
    say(script, listen);
  }

  function readOptions() {
    if (!quizReady()) { status('Quiz is not ready'); return; }
    const options = getOptions().map((node, i) =>
      `Option ${String.fromCharCode(65 + i)}. ${getCleanOptionText(i)}`);
    say([...options.map(text => ({ text, style: 'option', pauseAfter: 380 })),
      { text: 'After the beep, say my answer is B, or another available letter.',
        style: 'prompt', pauseAfter: 100 }], listen);
  }

  function readExplanation() {
    if (!hasExplanation()) {
      say('Please answer this question first, then I can read its explanation.', listen);
      return;
    }
    say([{ text: 'Let us review the explanation.', style: 'intro', pauseAfter: 300 },
      ...sentences(plainText($('explanationText')), 'explanation', 180),
      { text: 'You can say next question, previous question, or repeat question.', style: 'prompt', pauseAfter: 100 }], listen);
  }
  // Keep the selected answer pending until the student confirms it aloud.
  // This prevents a misheard letter from being graded as a wrong answer.
  let pendingAnswer = null;


  function chooseAnswer(letter, submitImmediately = false) {
    if (!quizReady()) { say('The quiz is not ready yet.', listen); return; }
    if (hasExplanation()) {
      pendingAnswer = null;
      say('You already answered this question. Say read explanation or next question.', listen);
      return;
    }
    const index = letter.toUpperCase().charCodeAt(0) - 65;
    const inputs = [...document.querySelectorAll('#optionsContainer input[name="quizOption"]')];
    const radio = inputs[index];
    if (!radio || radio.disabled) {
      say(`Option ${letter} is not available for this question.`, listen);
      return;
    }

    pendingAnswer = {
      letter: letter.toUpperCase(),
      question: plainText($('currentQuestionNumber'))
    };
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));

    // A single spoken letter grades immediately through Quizard's own button.
    if (submitImmediately) {
      status(`Submitting option ${pendingAnswer.letter}`);
      confirmPendingAnswer();
      return;
    }

    // Longer spoken phrases still allow a confirmation before grading.
    const optionText = getCleanOptionText(index);
    status(`Awaiting confirmation: option ${pendingAnswer.letter}`);
    say(`I heard option ${pendingAnswer.letter}. ${optionText}. Say confirm to submit, or say another answer letter to change it. You can also say cancel.`, listen);
  }


  function cancelPendingAnswer() {
    pendingAnswer = null;
    const checked = document.querySelector('#optionsContainer input[name="quizOption"]:checked');
    if (checked && !checked.disabled) checked.checked = false;
    say('Selection cancelled. Your question is still unanswered. What would you like to do?', listen);
  }

  function confirmPendingAnswer() {
    if (!pendingAnswer) {
      say('You have not selected an answer yet. Say answer A, B, C, or another available letter.', listen);
      return;
    }
    const selection = pendingAnswer;
    pendingAnswer = null;
    if (!quizReady() || hasExplanation() ||
        plainText($('currentQuestionNumber')) !== selection.question) {
      say('The question changed, so I did not submit that answer. Please select an answer again.', listen);
      return;
    }
    const index = selection.letter.charCodeAt(0) - 65;
    const inputs = [...document.querySelectorAll('#optionsContainer input[name="quizOption"]')];
    const radio = inputs[index];
    const submit = $('submitAnswerButton');
    if (!radio || radio.disabled || !submit) {
      say('I could not submit that answer. Please check the quiz screen.', listen);
      return;
    }
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    submit.click(); // Quizard's existing grading, saving and statistics.
    if (!hasExplanation()) {
      say('Your answer could not be confirmed on the quiz screen. Please check it before trying again.', listen);
      return;
    }

    const correctIndex = getOptions().findIndex(el => el.classList.contains('border-green-500'));
    const correctLetter = correctIndex >= 0 ? String.fromCharCode(65 + correctIndex) : '';
        const correctText = correctIndex >= 0
      ? getCleanOptionText(correctIndex) : '';
    const feedback = correctIndex < 0 ? 'Your answer was submitted.' :
      correctIndex === index ? `Correct. You chose option ${selection.letter}.` :
      `Not quite. You chose option ${selection.letter}. The correct answer is option ${correctLetter}. ${correctText}.`;

    if (settings.autoExplanation) {
      say([{ text: feedback, style: 'result', pauseAfter: 480 },
        { text: 'Let us look at the explanation.', style: 'intro', pauseAfter: 310 },
        ...sentences(plainText($('explanationText')), 'explanation', 180),
        { text: 'When you are ready, say next question, repeat question, or previous question.',
          style: 'prompt', pauseAfter: 80 }], listen);
    } else {
      say([{ text: feedback, style: 'result', pauseAfter: 400 },
        { text: 'Say read explanation, or next question.', style: 'prompt', pauseAfter: 80 }], listen);
    }
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

  function listen(withBeep = true) {
    if (!active || speaking || navigating || document.hidden) return;
    if (!SpeechRecognition) {
      status('Speech recognition unavailable in this browser');
      return;
    }
    if (listening) return;

    // Reserve the listening turn during the beep.
    listening = true;

    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;

    recognition.onstart = () => {
      status(paused
        ? 'Paused — say resume'
        : 'Listening… Say “My answer is B” or a command.');
    };

    recognition.onresult = (event) => {
      const alternatives = Array.from(event.results[0]).map(a => a.transcript);

      $('qvLastHeard').textContent = `Heard: ${alternatives[0]}`;
      stopListening();

      for (const phrase of alternatives) {
        if (handleCommand(phrase)) return;
      }

      say(
        'I did not catch that. Please say my answer is B, or another available letter.',
        listen
      );
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

        // Restart silently after a microphone timeout.
        // Repeated beeps during silence would be annoying.
        retryTimer = setTimeout(() => listen(false), 900);
      }
    };

    function beginRecognition() {
      if (!active || speaking || navigating || document.hidden || !listening) {
        listening = false;
        return;
      }

      try {
        recognition.start();
      } catch (error) {
        listening = false;
        status('Could not start microphone. Press Start again.');
      }
    }

    if (withBeep && !paused) {
      status('Please answer after the beep…');

      playReadyBeep();

      // Start the microphone after the 170 ms beep has finished.
      retryTimer = setTimeout(beginRecognition, 240);
    } else {
      beginRecognition();
    }
  }

  function handleCommand(raw) {
    const phrase = normalize(raw);
    if (!phrase) return false;

    if (paused) {
      if ([normalize(settings.commands.resume), 'continue', 'keep going', 'carry on'].includes(phrase)) {
        paused = false; markActivity();
        if (pendingAnswer) {
          say(`You selected option ${pendingAnswer.letter}. Say confirm, change the answer, or cancel.`, listen);
        } else announceQuestion();
        return true;
      }
      if ([normalize(settings.commands.stop), 'stop', 'stop listening'].includes(phrase)) {
        stopVoice(); return true;
      }
      say(`Voice mode is paused. Say ${settings.commands.resume} to continue.`, listen);
      return true;
    }

    // Confirmation is available only after a valid spoken selection.
    if (pendingAnswer && ['confirm', 'yes', 'yes submit', 'submit',
        'submit answer', 'thats right', 'go ahead', 'correct'].includes(phrase)) {
      markActivity(); confirmPendingAnswer(); return true;
    }
    if (pendingAnswer && ['cancel', 'no', 'nope', 'never mind',
        'change answer', 'change my answer', 'not that one'].includes(phrase)) {
      markActivity(); cancelPendingAnswer(); return true;
    }



    // Require a complete answer phrase instead of a bare letter.
    // "My answer is B" is easier for Chrome to recognize reliably.
    const spokenLetters = {
      a: 'A', ay: 'A',
      b: 'B', bee: 'B', be: 'B',
      c: 'C', see: 'C', sea: 'C',
      d: 'D', dee: 'D',
      e: 'E', ee: 'E',
      f: 'F', eff: 'F',
      g: 'G', gee: 'G',
      h: 'H', aitch: 'H'
    };

    const prefixes = [...new Set([
      'my answer is',
      'my answer',
      normalize(settings.answerPrefix)
    ])].filter(Boolean);

    const answerPattern = new RegExp(
      `^(?:${prefixes.join('|')})\\s+([a-z]+)$`
    );

    const answerMatch = phrase.match(answerPattern);
    const answerLetter = answerMatch
      ? spokenLetters[answerMatch[1]]
      : null;

    if (answerLetter && answerLetter.charCodeAt(0) - 65 < getOptions().length) {
      markActivity();

      // Submit immediately using Quizard's existing grading system.
      chooseAnswer(answerLetter, true);
      return true;
    }



    const aliases = {
      repeat: ['repeat that', 'say that again', 'read it again', 'start over', 'again', 'read question'],
      options: ['what are the choices', 'read the choices', 'what are the options', 'read options', 'choices only'],
      explanation: ['explain', 'explain it', 'why is that correct', 'why was i wrong',
        'why', 'explain the answer', 'can you explain', 'tell me why'],
      next: ['next', 'continue', 'move on', 'go forward', 'keep going'],
      previous: ['previous', 'go back', 'back one', 'last question', 'previous one'],
      skip: ['skip', 'i want to skip', 'pass'],
      help: ['help', 'what can i say', 'list commands', 'what are the commands'],
      stop: ['stop the quiz', 'stop listening', 'end voice', 'stop'],
      pause: ['hold on', 'wait a moment', 'wait'],
      resume: ['carry on', 'resume', 'keep going']
    };
    let action = Object.keys(settings.commands)
      .find(key => phrase === normalize(settings.commands[key]));
    if (!action) action = Object.keys(aliases)
      .find(key => aliases[key].includes(phrase));
    if (action) {
      markActivity();
      if (['repeat', 'options', 'next', 'skip', 'previous'].includes(action)) {
        pendingAnswer = null;
      }
      if (action === 'repeat') announceQuestion();
      else if (action === 'options') readOptions();
      else if (action === 'explanation') readExplanation();
      else if (action === 'next' || action === 'skip') moveQuestion('next');
      else if (action === 'previous') moveQuestion('previous');
      else if (action === 'pause') {
        paused = true;
        say(`Paused. Say ${settings.commands.resume} to continue.`, listen);
      } else if (action === 'resume') {
        paused = false; announceQuestion();
      } else if (action === 'help') {
       
        say(`After the beep, say my answer is B, or another available letter, to submit. You can also say ${settings.commands.repeat}, ${settings.commands.options}, ${settings.commands.explanation}, ${settings.commands.next}, ${settings.commands.previous}, ${settings.commands.skip}, or ${settings.commands.stop}.`, listen);

      } else if (action === 'stop') stopVoice();
      return true;
    }

    if (['i dont know', 'i do not know', 'not sure', 'i am not sure', 'im not sure'].includes(phrase)) {
      say('You can listen to the choices again or skip this question without marking it wrong.', listen);
      return true;
    }
    return false;
  }


  // Create a short, gentle beep when the student may speak.
  let readyAudioContext = null;

  function prepareReadyBeep() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      if (!readyAudioContext) {
        readyAudioContext = new AudioContextClass();
      }

      if (readyAudioContext.state === 'suspended') {
        readyAudioContext.resume().catch(() => {});
      }
    } catch (error) {
      console.warn('Voice readiness sound unavailable:', error);
    }
  }

  function playReadyBeep() {
    if (!readyAudioContext || readyAudioContext.state !== 'running') return;

    try {
      const now = readyAudioContext.currentTime;
      const oscillator = readyAudioContext.createOscillator();
      const gain = readyAudioContext.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.10, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

      oscillator.connect(gain);
      gain.connect(readyAudioContext.destination);

      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };

      oscillator.start(now);
      oscillator.stop(now + 0.17);
    } catch (error) {
      console.warn('Could not play readiness beep:', error);
    }
  }

  function startVoice() {
    if (!canSpeak || !SpeechRecognition) {
      status('This browser does not support both speech reading and microphone recognition. Try a current desktop Chrome browser.');
      return;
    }

    // Prepare audio while handling the student's Start click.
    prepareReadyBeep();

    stopVoice();
    active = true;
    paused = false;

    writeStore(LAST_USED_KEY, String(Date.now()));
    icon.classList.add('active');

    $('qvStart').textContent = '↻ Restart narration';

    selectedVoice = voices.find(v => v.voiceURI === settings.voice) || voices[0] || null;

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
    $('qvSpeedLabel').textContent = `${Number($('qvSpeed').value).toFixed(2)}×`);
  $('qvExpression').addEventListener('input', () =>
    $('qvExpressionLabel').textContent = `${$('qvExpression').value}%`);
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
