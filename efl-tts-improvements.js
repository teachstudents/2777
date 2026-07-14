// efl-tts-improvements.js
// Browser-only: improved TTS for EFL pages (voice selection, name->gender heuristics, queueing, UI)
// Drop into your pages and include <script src="efl-tts-improvements.js"></script> before </body>.
// Recommended: insert the small voice-control HTML in your #app-container so users can override.

(function () {
  if (window.__EFL_TTS_IMPROVEMENTS_INSTALLED) return;
  window.__EFL_TTS_IMPROVEMENTS_INSTALLED = true;

  // Small local name -> gender overrides (expand as needed)
  const NAME_GENDER_OVERRIDES = {
    mary: 'female', maria: 'female', anna: 'female', sarah: 'female', amina: 'female', laila: 'female',
    john: 'male', mike: 'male', david: 'male', james: 'male', tom: 'male', youssef: 'male', ahmed: 'male'
  };

  // Utility: inject voice preference UI if an #app-container exists
  function injectVoiceControls() {
    if (!document.getElementById('app-container')) return;
    if (document.getElementById('voice-controls-wrapper')) return; // already injected
    const wrapper = document.createElement('div');
    wrapper.id = 'voice-controls-wrapper';
    wrapper.style.margin = '0.5rem 0';
    wrapper.innerHTML = `
      <label for="voice-preference" style="font-weight:600;margin-right:.5rem">Voice</label>
      <select id="voice-preference" style="padding:.2rem;border-radius:.25rem;border:1px solid #cbd5e1">
        <option value="auto">Auto (by name)</option>
        <option value="female">Female</option>
        <option value="male">Male</option>
        <option value="system">System default</option>
      </select>
      <label style="margin-left:1rem;font-size:.9rem"><input id="voice-auto-by-name" type="checkbox" checked /> Use name for gender</label>
    `;
    const container = document.getElementById('app-container');
    container.insertBefore(wrapper, container.firstChild);
  }

  // Speech synthesis & voice helpers
  const synth = window.speechSynthesis;
  let voices = [];
  let voicesLoaded = false;

  function loadVoicesOnce() {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) {
        voices = [];
        voicesLoaded = true;
        return resolve(voices);
      }
      function populate() {
        voices = (speechSynthesis.getVoices() || []).filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
        voicesLoaded = true;
        resolve(voices);
      }
      const existing = speechSynthesis.getVoices();
      if (existing && existing.length) {
        populate();
      } else {
        speechSynthesis.onvoiceschanged = populate;
        // Some browsers need a tiny nudge
        try {
          const u = new SpeechSynthesisUtterance(' ');
          u.volume = 0;
          speechSynthesis.speak(u);
          setTimeout(() => speechSynthesis.cancel(), 80);
        } catch (e) { /* ignore */ }
        // fallback timer to avoid waiting forever
        setTimeout(() => { if (!voicesLoaded) populate(); }, 1500);
      }
    });
  }

  // Heuristic inference of gender from a first name (local only)
  function inferGenderFromName(name) {
    if (!name) return 'unknown';
    const first = name.trim().split(/\s+/)[0].toLowerCase();
    if (NAME_GENDER_OVERRIDES[first]) return NAME_GENDER_OVERRIDES[first];
    if (first.endsWith('a') || first.endsWith('ie') || (first.endsWith('y') && first.length > 2)) return 'female';
    if (first.endsWith('o') || first.endsWith('n') || first.endsWith('d')) return 'male';
    return 'unknown';
  }

  function getVoicePreferenceUI() {
    const sel = document.getElementById('voice-preference');
    const useByName = document.getElementById('voice-auto-by-name');
    return {
      preference: sel ? sel.value : 'auto',
      useByName: useByName ? useByName.checked : true
    };
  }

  // Score voices to pick the best candidate for desired gender
  function chooseVoiceForGender(desiredGender = 'unknown') {
    if (!voices || voices.length === 0) return null;
    const ua = (navigator.userAgent || '').toLowerCase();
    function score(v) {
      const name = (v.name || '').toLowerCase();
      const lang = (v.lang || '').toLowerCase();
      let s = 0;
      if (name.includes('wavenet') || name.includes('neural') || name.includes('google') || name.includes('microsoft') || name.includes('natural') || name.includes('aria')) s += 5;
      if (lang.startsWith('en-us')) s += 1;
      if (desiredGender === 'female' && (name.includes('female') || name.includes('aria') || name.includes('samantha') || name.includes('zira') || name.includes('-f') || name.includes('alloy') || name.includes('joanna'))) s += 4;
      if (desiredGender === 'male' && (name.includes('male') || name.includes('guy') || name.includes('matthew') || name.includes('justin') || name.includes('-d') || name.includes('joey'))) s += 4;
      if (ua.includes('edg') && name.includes('microsoft')) s += 2;
      if ((ua.includes('chrome') || ua.includes('android')) && (name.includes('google') || name.includes('wavenet'))) s += 2;
      return s + Math.random() * 0.5; // small jitter as tiebreaker
    }
    const sorted = voices.slice().sort((a, b) => score(b) - score(a));
    return sorted.length ? sorted[0] : null;
  }

  // Queued speaking to avoid overlap/cutoff and allow stable behavior
  let utterQueue = [];
  let speaking = false;
  let ttsEnabled = true;

  function processQueue() {
    if (!ttsEnabled) { utterQueue = []; speaking = false; return; }
    if (speaking || utterQueue.length === 0) return;
    const u = utterQueue.shift();
    speaking = true;
    u.onend = () => { speaking = false; setTimeout(processQueue, 60); };
    try { speechSynthesis.speak(u); } catch (e) { console.warn('TTS speak error', e); speaking = false; }
  }

  async function speakForName(text, playerName = '', rate = 0.85, callback) {
    if (!('speechSynthesis' in window)) { if (callback) callback(); return; }
    await loadVoicesOnce();
    if (!ttsEnabled) { if (callback) callback(); return; }
    const pref = getVoicePreferenceUI();
    let desiredGender = 'unknown';
    if (pref.preference === 'female') desiredGender = 'female';
    else if (pref.preference === 'male') desiredGender = 'male';
    else if (pref.preference === 'system') desiredGender = 'unknown';
    else { if (pref.useByName && playerName) desiredGender = inferGenderFromName(playerName); }

    const chosen = chooseVoiceForGender(desiredGender) || voices[0] || null;
    // If speaking, we queue rather than cancel to preserve flow, but short utterances cancel previous silence
    try { speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    const u = new SpeechSynthesisUtterance(text);
    if (chosen) u.voice = chosen;
    u.lang = 'en-US';
    u.rate = rate;
    if (callback) u.onend = callback;
    utterQueue.push(u);
    processQueue();
  }

  // Backwards-compatible "speak" alias that preserves previous signature
  function speak(text, rate = 0.85, callback) {
    // no name provided -> use UI preference
    speakForName(text, '', rate, callback);
  }

  // Expose friendly APIs to page
  window.speakForPlayer = speakForName;
  window.speak = speak; // override existing or set if missing

  // Toggle TTS on/off (can be bound by page)
  window.toggleTTS = function (buttonEl) {
    ttsEnabled = !ttsEnabled;
    if (!ttsEnabled) {
      try { speechSynthesis.cancel(); } catch (e) {}
      utterQueue = [];
      speaking = false;
    } else {
      // optionally read current page content
      const activeReadable = document.querySelector('.page.active .readable-content') || document.querySelector('.page.active');
      if (activeReadable) speakForName((activeReadable.innerText || '').trim(), '', 0.85);
    }
    if (buttonEl) buttonEl.setAttribute('aria-pressed', String(ttsEnabled));
  };

  // On DOM ready, inject UI and start loading voices
  document.addEventListener('DOMContentLoaded', () => {
    try { injectVoiceControls(); } catch (e) {}
    loadVoicesOnce(); // warm voices early
    // If the page defines startApp or a similar initializer, try to hook in to ensure voices ready before starting
    const originalStart = window.startApp;
    if (typeof originalStart === 'function') {
      window.startApp = async function () {
        await loadVoicesOnce();
        return originalStart.apply(this, arguments);
      };
    }
  });

  // Expose a small helper: speakById(id, playerName) to find readable-content and speak it
  window.speakById = function (id, playerName, rate) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = (el.innerText || el.textContent || '').trim();
    if (text) speakForName(text, playerName || '', rate || 0.85);
  };

  // Helpful note: pages can call speakForPlayer("Hello", "Anna") to use name-aware voice

})();