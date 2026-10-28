/* Quizard AI Tutor (connection + text reasoning + optional browser speech).
   Loads after voice-quiz.js. OpenRouter OAuth PKCE creates a personal key invisibly.
   The key is exchanged and encrypted by a Supabase Edge Function and never stored in browser.
*/
import { supabase } from './supabaseClient.js';

(() => {
  'use strict';
  const PENDING = 'quizardOpenRouterPKCE';
  const $ = id => document.getElementById(id);
  const readSession = k => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const storeSession = (k,v) => { sessionStorage.setItem(k,v); };
  const clearSession = k => { try { sessionStorage.removeItem(k); } catch {} };
  const escapeText = text => String(text || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const chosenStore = 'quizardAiModelV1';
  let models = [];
  let selectedModel = localStorage.getItem(chosenStore) || '';
  let connected = false;
  let microphone = null;
  let requesting = false;
  let latestQuestion = '';
  let lastAnswer = '';

  const style = document.createElement('style');
  style.textContent = `
    #qzaModal[hidden]{display:none!important}
    #qzaModal{position:fixed;inset:0;z-index:120000;display:flex;align-items:center;justify-content:center;
      padding:12px;background:rgba(15,23,42,.65);font-family:Inter,Arial,sans-serif}
    #qzaModal *{box-sizing:border-box}
    #qzaPanel{width:min(100%,600px);max-height:92vh;overflow-y:auto;background:white;color:#1f2937;
      border-radius:18px;box-shadow:0 15px 55px #0003;padding:18px}
    #qzaModal button{cursor:pointer;border:1px solid #d1d5db;border-radius:9px;padding:10px 13px;
      font-weight:600;background:white;color:#334155}
    #qzaModal button:disabled{opacity:.6;cursor:not-allowed}
    #qzaModal .qzaPurple{background:#6d28d9;color:white;border-color:#6d28d9}
    #qzaModal .qzaRow{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:11px 0}
    #qzaModal .qzaNote{color:#64748b;font-size:12px;line-height:1.5}
    #qzaModal select,#qzaModal textarea{background:white;border-radius:9px;border:1px solid #cbd5e1;
      padding:10px;color:#111827;font:inherit;width:100%}
    #qzaModal textarea{min-height:70px;resize:vertical}
    #qzaLog{height:210px;overflow:auto;background:#f8fafc;border-radius:10px;padding:12px;
      font-size:14px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
    #qzaStatus{padding:9px;background:#faf5ff;border-radius:9px;margin:11px 0;font-size:13px}
    #qzaLaunch{width:100%;text-align:left;display:block;margin:14px 0 8px;
      border:1px solid #ddd6fe!important;border-radius:12px;padding:12px!important;background:#faf5ff!important}
  `;
  document.head.appendChild(style);

  const aiModal = document.createElement('div');
  aiModal.id = 'qzaModal';
  aiModal.hidden = true;
  aiModal.innerHTML = `
    <div id="qzaPanel" role="dialog" aria-modal="true" aria-label="Quizard AI Tutor">
      <div class="qzaRow" style="justify-content:space-between">
        <strong style="font-size:18px">✦ Quizard AI Tutor</strong>
        <button id="qzaClose" type="button" aria-label="Close AI Tutor">✕</button>
      </div>
      <div class="qzaNote">Your personal OpenRouter account can access supported Google Gemini, OpenAI, and Claude models. Quizard does not receive your password.</div>
      <div id="qzaStatus" role="status" aria-live="polite">Checking connection…</div>
      <section id="qzaDisconnected" hidden>
        <p><strong>No API key setup is needed.</strong> Sign in with OpenRouter and approve Quizard. You can use Google sign-in if OpenRouter offers it.</p>
        <button id="qzaConnect" class="qzaPurple" type="button">Connect my AI account</button>
        <p class="qzaNote">The AI provider might require a separate account and credits. A normal email login does not automatically include paid AI requests.</p>
      </section>
      <section id="qzaConnected" hidden>
        <label for="qzaProvider"><strong>Choose AI provider</strong></label>
        <select id="qzaProvider">
          <option value="google">Google Gemini — affordable option</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic Claude</option>
        </select>
        <label for="qzaPower"><strong>AI level</strong></label>
        <select id="qzaPower">
          <option value="economy">Economy — recommended for low cost</option>
          <option value="balanced">Balanced — more capable model</option>
          <option value="advanced">Advanced — may be expensive</option>
        </select>
        <label for="qzaModel"><strong>Actual AI model (and its price)</strong></label>
        <select id="qzaModel"></select>
        <div id="qzaPrice" class="qzaNote" style="padding:8px 0">Model prices loading…</div>
        <div id="qzaLog" role="log" aria-live="polite">Hello! Ask about the question currently displayed. Select a model and press Ask AI.</div>
        <textarea id="qzaText" placeholder="Why is option B wrong? Explain the correct approach…" maxlength="1000" aria-label="Ask the AI tutor"></textarea>
        <div class="qzaRow">
          <button id="qzaAsk" class="qzaPurple" type="button">Ask AI</button>
          <button id="qzaMic" type="button">🎙 Speak a question</button>
          <button id="qzaSpeak" type="button">🔊 Read last reply</button>
          <button id="qzaStopAudio" type="button">■ Stop audio</button>
        </div>
        <p class="qzaNote">This first AI version uses a conversational text model with browser speech input/output. Real-time natural AI voices are a separate upgrade. Replies may be incorrect; Quizard's original answer key remains authoritative.</p>
        <div class="qzaRow">
          <a href="https://openrouter.ai/credits" target="_blank" rel="noopener noreferrer">Manage credits</a>
          <a id="qzaManage" href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">Manage authorization</a>
          <button id="qzaDisconnect" type="button">Disconnect</button>
        </div>
        <p class="qzaNote">Disconnect removes Quizard's stored credential. To revoke the key at OpenRouter too, use “Manage authorization”.</p>
      </section>
    </div>`;
  document.body.appendChild(aiModal);

  function status(message) { $('qzaStatus').textContent = message; }
  async function invoke(action, other = {}) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Please log in to Quizard again before connecting AI.');
    const { data, error } = await supabase.functions.invoke('quizard-ai-gateway', {
      body: { action, ...other },
    });
    if (error) {
      let message = error.message || 'Could not reach the Supabase AI gateway.';
      try { const detail = await error.context?.json?.(); message = detail?.error || message; } catch {}
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  function log(name, message) {
    const el = $('qzaLog');
    const line = document.createElement('div');
    line.style.marginBottom = '11px';
    const label = document.createElement('strong');
    label.textContent = name + ': ';
    line.append(label, document.createTextNode(message));
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  async function showAI() {
    aiModal.hidden = false;
    status('Checking your AI account…');
    try {
      const r = await invoke('status');
      connected = Boolean(r.connected);
      $('qzaDisconnected').hidden = connected;
      $('qzaConnected').hidden = !connected;
      if (connected) {
        status('AI account connected. Usage will be billed to your own OpenRouter account.');
        $('qzaManage').href = r.manage_url || 'https://openrouter.ai/keys';
        await loadModels();
      } else status('AI account is not connected yet.');
    } catch (e) {
      status(e.message);
      $('qzaDisconnected').hidden = false;
      $('qzaConnected').hidden = true;
    }
  }
  function closeAI() {
    aiModal.hidden = true;
    window.speechSynthesis?.cancel();
    try { microphone?.stop(); } catch {}
  }
  function makeRandom(size) {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    return Array.from(bytes, c => String.fromCharCode(c)).join('');
  }
  function toBase64Url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function connect() {
    try {
      const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const state = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
      storeSession(PENDING, JSON.stringify({ verifier, state, created: Date.now() }));
      const callback = new URL(window.location.href);
      callback.searchParams.delete('code');
      callback.searchParams.delete('state');
      callback.hash = '';
      const auth = new URL('https://openrouter.ai/auth');
      auth.searchParams.set('callback_url', callback.toString());
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      auth.searchParams.set('state', state);
      auth.searchParams.set('key_label', 'Quizard AI Tutor');
      window.location.assign(auth.toString());
    } catch (e) { status('Could not start connection: ' + e.message); }
  }
  async function processCallback() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    if (!code) return;
    const state = url.searchParams.get('state');
    // Remove the one-time authorization code from the visible URL immediately.
    url.searchParams.delete('code'); url.searchParams.delete('state');
    history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    let pending = null;
    try { pending = JSON.parse(readSession(PENDING) || 'null'); } catch {}
    clearSession(PENDING);
    if (!pending || !state || pending.state !== state || Date.now() - pending.created > 10 * 60 * 1000) {
      alert('OpenRouter connection expired or failed verification. Please click Connect again.');
      return;
    }
    try {
      await invoke('connect', { code, code_verifier: pending.verifier });
      await showAI();
    } catch (e) {
      alert('Could not connect AI: ' + e.message);
    }
  }
  function questionContext() {
    const q = $('questionDisplay')?.innerText?.trim() || '';
    const opts = Array.from(document.querySelectorAll('#optionsContainer label .option-text'))
      .map((v,i) => String.fromCharCode(65 + i) + '. ' + (v.innerText || '').trim()).join('\n');
    const expl = !$('explanationDisplay')?.classList.contains('hidden')
      ? ($('explanationText')?.innerText || '').slice(0,3500) : '';
    return `Question: ${q}\nOptions:\n${opts}${expl ? '\nVerified explanation shown by Quizard:\n' + expl : ''}`;
  }
  async function loadModels() {
    try {
      const r = await invoke('models');
      models = (r.models || []).filter(m =>
        !/(?:\:free|\:batch|\:preview|\:online)$/i.test(m.id) &&
        m.prompt >= 0 && m.completion >= 0
      );
      if (!models.length) {
        status('No compatible models found. Please check OpenRouter.');
        return;
      }
      if (selectedModel && models.some(m => m.id === selectedModel)) {
        $('qzaProvider').value = selectedModel.split('/')[0];
      }
      updateModelOptions(Boolean(selectedModel));
    } catch (e) { status('Model pricing error: ' + e.message); }
  }
  function costScore(m) { return m.prompt + m.completion * 2; }
  function suggestedForPower(list, power) {
    // Model-family preferences; the student's chosen model and price are always visible.
    const regex = {
      economy: /(flash[- ]lite|flash|haiku|mini|nano)/i,
      balanced: /(sonnet|flash|gpt[- ]4\.1 mini|gpt[- ]5 mini)/i,
      advanced: /(pro|opus|gpt[- ]6|gpt[- ]5\.5)/i,
    }[power];
    const matches = list.filter(m => regex.test(m.name + ' ' + m.id));
    const options = matches.length ? matches : list;
    if (power === 'advanced') return options.at(-1);
    return options[0];
  }
  function updateModelOptions(restoreSelection = false) {
    const provider = $('qzaProvider').value;
    const power = $('qzaPower').value;
    const subset = models.filter(m => m.id.startsWith(provider + '/'))
      .sort((a,b) => costScore(a) - costScore(b));
    const select = $('qzaModel');
    select.replaceChildren();
    if (!subset.length) {
      selectedModel = '';
      $('qzaPrice').textContent = 'No available models from this provider.';
      return;
    }
    const recommended = suggestedForPower(subset, power);
    const optionModels = [recommended, ...subset.filter(m => m.id !== recommended.id)];
    for (const m of optionModels) {
      const opt = document.createElement('option');
      opt.value = m.id;
      const tag = m.id === recommended.id ? 'Recommended for selected level: ' : '';
      opt.textContent = `${tag}${m.name} — $${m.prompt.toFixed(2)} in / $${m.completion.toFixed(2)} out per 1M tokens`;
      select.appendChild(opt);
    }
    selectedModel = restoreSelection && subset.some(m => m.id === selectedModel)
      ? selectedModel : recommended.id;
    select.value = selectedModel;
    modelChanged();
  }
  function modelChanged() {
    selectedModel = $('qzaModel').value;
    localStorage.setItem(chosenStore, selectedModel);
    const m = models.find(m => m.id === selectedModel);
    $('qzaPrice').textContent = m ?
      `Selected: ${m.name}. Price: $${m.prompt.toFixed(4)}/1M input tokens and $${m.completion.toFixed(4)}/1M output tokens. Higher price does NOT guarantee higher accuracy. Other charges may apply.` : 'Choose a model.';
  }
  async function ask() {
    if (requesting) return;
    const question = $('qzaText').value.trim();
    if (!question) return;
    if (!selectedModel) { status('Select an AI model first.'); return; }
    requesting = true;
    $('qzaAsk').disabled = true;
    $('qzaText').value = '';
    log('You', question);
    status('AI is preparing a response…');
    try {
      const r = await invoke('chat', { message: question, model: selectedModel, question: questionContext() });
      lastAnswer = r.answer || '';
      log('Quizard AI', lastAnswer);
      const cost = typeof r.cost_usd === 'number' ? ` · reported request cost $${r.cost_usd.toFixed(5)}` : '';
      status(`Reply received${cost}. Charges are on your OpenRouter account.`);
    } catch (e) {
      status(e.message);
      log('Error', e.message);
    } finally {
      requesting = false;
      $('qzaAsk').disabled = false;
    }
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) { status('Browser speech output is unavailable here.'); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 5000));
    u.rate = 1;
    u.lang = 'en-US';
    window.speechSynthesis.speak(u);
  }
  function startMic() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { status('Speech recognition is unavailable in this browser. Please type your question.'); return; }
    try { microphone?.stop(); } catch {}
    window.speechSynthesis?.cancel();
    microphone = new SpeechRecognition();
    microphone.lang = 'en-US';
    microphone.interimResults = false;
    microphone.continuous = false;
    microphone.onresult = e => {
      $('qzaText').value = e.results[0][0].transcript;
      status('Voice captured. Press Ask AI to send.');
    };
    microphone.onerror = e => status('Microphone issue: ' + e.error);
    microphone.onend = () => { microphone = null; };
    status('Listening to your question…');
    microphone.start();
  }

  function install() {
    const home = $('qvHome');
    if (!home) { console.warn('Standard voice window was not found. Load voice-quiz.js first.'); return; }
    const entry = document.createElement('button');
    entry.id = 'qzaLaunch';
    entry.type = 'button';
    entry.innerHTML = `<strong>✦ AI Tutor — choose Gemini, OpenAI or Claude</strong><br>
      <span style="color:#64748b;font-size:12px">Connect your own AI account without creating an API key. Optional paid usage.</span>`;
    home.appendChild(entry);
    entry.addEventListener('click', () => {
      $('qvWindow').hidden = true;
      showAI();
    });
    $('qzaClose').addEventListener('click', closeAI);
    $('qzaConnect').addEventListener('click', connect);
    $('qzaDisconnect').addEventListener('click', async () => {
      if (!confirm('Disconnect your AI account from Quizard? You can revoke the generated key in OpenRouter separately.')) return;
      try { await invoke('disconnect'); await showAI(); }
      catch (e) { status(e.message); }
    });
    $('qzaProvider').addEventListener('change', () => updateModelOptions());
    $('qzaPower').addEventListener('change', () => updateModelOptions());
    $('qzaModel').addEventListener('change', modelChanged);
    $('qzaAsk').addEventListener('click', ask);
    $('qzaMic').addEventListener('click', startMic);
    $('qzaSpeak').addEventListener('click', () => lastAnswer && speak(lastAnswer));
    $('qzaStopAudio').addEventListener('click', () => window.speechSynthesis?.cancel());
    $('qzaText').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
    });
    processCallback();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
