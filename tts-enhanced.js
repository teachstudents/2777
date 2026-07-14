// TTS-enhanced: client-side Web Speech improvements (no cloud keys)
// Usage:
//  - Include <script src="tts-enhanced.js"></script> in your HTML (after other scripts).
//  - Call await TTS.init() before first use (e.g., in startApp).
//  - Use TTS.speak(text, opts), TTS.readDilemma(element), TTS.showVoiceSelector(), TTS.toggle()
//  - opts: { interrupt:false, gender:'male'|'female', voiceName: 'Voice Name', rate:0.9, pitch:1 }

(function (global) {
  const synth = window.speechSynthesis;
  const TTS = {
    voices: [],
    femaleVoice: null,
    maleVoice: null,
    initialized: false,
    enabled: true,
    utteranceQueue: [],
    isSpeaking: false,
    // Hints for scoring voices (names commonly associated with higher quality)
    HQ_HINTS: [/google/i, /microsoft/i, /samantha/i, /alex/i, /zira/i, /alloy/i, /david/i, /daniel/i, /wave|neural/i],
    // Load voices with fallback timeout
    loadVoices(timeout = 1400) {
      return new Promise(resolve => {
        const v = synth.getVoices();
        if (v && v.length) {
          this.voices = v; return resolve(v);
        }
        let resolved = false;
        const cb = () => {
          if (resolved) return;
          resolved = true;
          this.voices = synth.getVoices() || [];
          resolve(this.voices);
        };
        synth.onvoiceschanged = cb;
        setTimeout(cb, timeout);
      });
    },
    // Score a voice: prefer en-US, then en; boost default and known vendor/name hints
    scoreVoice(v) {
      let score = 0;
      const lang = (v.lang || '').toLowerCase();
      if (lang.startsWith('en-us')) score += 40;
      else if (lang.startsWith('en')) score += 12;
      if (v.default) score += 8;
      const name = (v.name || '').toLowerCase();
      this.HQ_HINTS.forEach(re => { if (re.test(name)) score += 6; });
      // slight boost if voiceURI exists
      if (v.voiceURI && v.voiceURI !== 'native') score += 2;
      return score;
    },
    // Heuristic gender guess from name
    guessGenderFromName(name) {
      if (!name) return null;
      name = name.toLowerCase();
      if (/(samantha|ava|aria|zira|amy|olivia|sara|linda|emma|sue|ella|nina|female)/.test(name)) return 'female';
      if (/(david|daniel|brian|alex|john|matthew|thomas|paul|male|dave|tony)/.test(name)) return 'male';
      return null;
    },
    // Choose best female and male voices (distinct)
    selectBestVoices() {
      if (!this.voices || !this.voices.length) return;
      const scored = this.voices.map(v => ({ v, score: this.scoreVoice(v) }));
      scored.sort((a, b) => b.score - a.score);
      // pick female best
      const femaleItem = scored.find(item => {
        const g = this.guessGenderFromName(item.v.name) || this.guessGenderFromName(item.v.voiceURI);
        return g === 'female' && (item.v.lang || '').toLowerCase().startsWith('en');
      }) || scored.find(item => (item.v.lang || '').toLowerCase().startsWith('en-us')) || scored[0];
      // pick male best (ensure not same as female)
      const maleItem = scored.find(item => {
        const g = this.guessGenderFromName(item.v.name) || this.guessGenderFromName(item.v.voiceURI);
        return g === 'male' && (item.v.lang || '').toLowerCase().startsWith('en');
      }) || scored.find(item => item.v !== (femaleItem && femaleItem.v)) || scored.find(item => item.v !== (femaleItem && femaleItem.v)) || scored[0];
      this.femaleVoice = femaleItem ? femaleItem.v : null;
      this.maleVoice = (maleItem && maleItem.v !== (this.femaleVoice)) ? maleItem.v : (this.femaleVoice || null);
    },
    // Init routine
    async init() {
      if (this.initialized) return;
      await this.loadVoices();
      if (!this.voices.length) {
        console.warn('TTS: no available speechSynthesis voices in this environment.');
      }
      this.selectBestVoices();
      // warm up quietly
      try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); synth.cancel(); } catch (e) {}
      this.initialized = true;
    },
    // Queuing model
    processQueue() {
      if (!this.enabled) return;
      if (this.isSpeaking || !this.utteranceQueue.length) return;
      const u = this.utteranceQueue.shift();
      this.isSpeaking = true;
      u.onend = () => { this.isSpeaking = false; this.processQueue(); };
      u.onerror = () => { this.isSpeaking = false; this.processQueue(); };
      try { synth.speak(u); } catch (e) { console.error('TTS speak error', e); this.isSpeaking = false; this.processQueue(); }
    },
    enqueue(text, opts = {}) {
      if (!this.enabled) return null;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = ('rate' in opts) ? opts.rate : 0.9;
      u.pitch = ('pitch' in opts) ? opts.pitch : 1.0;
      // explicit voiceName overrides gender/auto
      if (opts.voiceName) {
        const byName = this.voices.find(v => v.name === opts.voiceName);
        if (byName) u.voice = byName;
      } else if (opts.gender === 'male' && this.maleVoice) u.voice = this.maleVoice;
      else if (opts.gender === 'female' && this.femaleVoice) u.voice = this.femaleVoice;
      else u.voice = this.femaleVoice || this.maleVoice || null;
      this.utteranceQueue.push(u);
      // If user requested interrupt, cancel current and force immediate play
      if (opts.interrupt) {
        try { synth.cancel(); } catch (e) {}
        this.utteranceQueue = [u];
        this.isSpeaking = false;
      }
      this.processQueue();
      return u;
    },
    // Public speak: speak(text, {interrupt:false, gender:'male'|'female', voiceName, rate, pitch})
    speak(text, opts = {}) {
      if (!this.initialized) {
        // initialize in background, but enqueue speak after init
        this.init().then(() => { this.enqueue(text, opts); });
        return;
      }
      return this.enqueue(text, opts);
    },
    // readDilemma: container element with <p> blocks and <strong> speaker markers
    readDilemma(containerEl) {
      if (!containerEl) return;
      const paragraphs = Array.from(containerEl.querySelectorAll('p'));
      if (!paragraphs.length) return;
      // stop and clear queue so dilemma reads in order
      try { synth.cancel(); } catch (e) {}
      this.utteranceQueue = [];
      this.isSpeaking = false;
      paragraphs.forEach(p => {
        const speaker = p.querySelector('strong') ? p.querySelector('strong').innerText : '';
        let gender = null;
        if (/youssef|yousef|mohammad|ali|ahmed|mohamed|john|tom|david/i.test(speaker)) gender = 'male';
        else if (/she|her|ms|mrs|samantha|sara|amal|lina|maria/i.test(speaker)) gender = 'female';
        this.enqueue(p.innerText, { gender, rate: 0.92 });
      });
    },
    // toggle on/off for TTS (used by UI toggle)
    toggle(buttonEl) {
      this.enabled = !this.enabled;
      if (!this.enabled) {
        try { synth.cancel(); } catch (e) {}
        this.utteranceQueue = []; this.isSpeaking = false;
        if (buttonEl) buttonEl.dataset.tts = 'off';
      } else {
        if (buttonEl) buttonEl.dataset.tts = 'on';
      }
    },
    // Small UI modal for selecting local voices manually
    showVoiceSelector(onSave) {
      // build modal
      const root = document.createElement('div');
      Object.assign(root.style, { position: 'fixed', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', zIndex: 9999 });
      const box = document.createElement('div');
      Object.assign(box.style, { background: '#fff', padding: '14px', borderRadius: '10px', width: 'min(760px,94%)', maxHeight: '80vh', overflow: 'auto' });
      box.innerHTML = '<h3 style="margin:0 0 8px 0">Select local voices</h3>';
      const femaleLabel = document.createElement('div'); femaleLabel.textContent = 'Female voice';
      const femaleSelect = document.createElement('select'); femaleSelect.style.width = '100%';
      const maleLabel = document.createElement('div'); maleLabel.textContent = 'Male voice'; maleLabel.style.marginTop = '8px';
      const maleSelect = document.createElement('select'); maleSelect.style.width = '100%';
      this.voices.forEach(v => {
        const opt1 = document.createElement('option'); opt1.value = v.name; opt1.text = `${v.name} — ${v.lang}${v.default ? ' (default)' : ''}`;
        const opt2 = opt1.cloneNode(true);
        femaleSelect.appendChild(opt1); maleSelect.appendChild(opt2);
      });
      if (this.femaleVoice) femaleSelect.value = this.femaleVoice.name;
      if (this.maleVoice) maleSelect.value = this.maleVoice.name;
      const save = document.createElement('button'); save.textContent = 'Save'; save.style.marginTop = '10px';
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.style.marginLeft = '8px';
      const sampleFemale = document.createElement('button'); sampleFemale.textContent = '▶ Sample female'; sampleFemale.style.marginLeft = '8px';
      const sampleMale = document.createElement('button'); sampleMale.textContent = '▶ Sample male'; sampleMale.style.marginLeft = '8px';
      box.appendChild(femaleLabel); box.appendChild(femaleSelect);
      box.appendChild(maleLabel); box.appendChild(maleSelect);
      const row = document.createElement('div'); row.style.marginTop = '10px';
      row.appendChild(save); row.appendChild(cancel); row.appendChild(sampleFemale); row.appendChild(sampleMale);
      box.appendChild(row);
      root.appendChild(box);
      document.body.appendChild(root);
      sampleFemale.onclick = () => {
        const name = femaleSelect.value;
        const v = this.voices.find(x => x.name === name);
        if (v) {
          const u = new SpeechSynthesisUtterance('This is a sample female voice.');
          u.voice = v; u.rate = 0.95; synth.cancel(); synth.speak(u);
        }
      };
      sampleMale.onclick = () => {
        const name = maleSelect.value;
        const v = this.voices.find(x => x.name === name);
        if (v) {
          const u = new SpeechSynthesisUtterance('This is a sample male voice.');
          u.voice = v; u.rate = 0.95; synth.cancel(); synth.speak(u);
        }
      };
      save.onclick = () => {
        const f = this.voices.find(x => x.name === femaleSelect.value);
        const m = this.voices.find(x => x.name === maleSelect.value);
        if (f) this.femaleVoice = f;
        if (m) this.maleVoice = m;
        document.body.removeChild(root);
        if (typeof onSave === 'function') onSave({ female: this.femaleVoice, male: this.maleVoice });
      };
      cancel.onclick = () => document.body.removeChild(root);
    },
    // simple getters
    getVoices() { return this.voices; },
    getSelected() { return { female: this.femaleVoice, male: this.maleVoice }; },
  };

  // attach to window
  global.TTS = TTS;
})(window);