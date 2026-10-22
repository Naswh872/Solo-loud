(() => {
  'use strict';
  if (window.__soloWarriorPanV14) return;
  window.__soloWarriorPanV14 = true;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------- stereo pan state ----------
  let pan = 0, auto = false, timer = null, phase = 0, speed = 0.10;
  const nodes = new WeakMap();

  function findPanel() {
    return document.querySelector('.altminus-panel-body') ||
           document.querySelector('.altminus-panel');
  }

  function ensureAudioNode(media) {
    if (nodes.has(media)) return nodes.get(media);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      const ctx = new Ctx();
      const source = ctx.createMediaElementSource(media);
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (!panner) return null;
      source.disconnect();
      source.connect(panner);
      panner.connect(ctx.destination);
      const n = { ctx, panner };
      nodes.set(media, n);
      return n;
    } catch (_) { return null; }
  }

  function applyPan() {
    document.querySelectorAll('audio,video').forEach(media => {
      const n = ensureAudioNode(media);
      if (!n) return;
      try {
        n.panner.pan.value = clamp(pan / 100, -1, 1);
        if (n.ctx.state === 'suspended') n.ctx.resume().catch(() => {});
      } catch (_) {}
    });
  }

  function stopAuto() { if (timer) clearInterval(timer); timer = null; }

  function startAuto() {
    stopAuto();
    timer = setInterval(() => {
      phase += (Math.PI * 2) / Math.max(2, Math.round(speed * 1000 / 10));
      pan = Math.sin(phase) * 100;
      const slider = document.getElementById('sw-stereo-pan');
      const value  = document.getElementById('sw-stereo-pan-value');
      if (slider) slider.value = String(Math.round(pan));
      if (value)  value.textContent = pan === 0 ? 'MID'
                    : (pan < 0 ? `L ${Math.abs(Math.round(pan))}` : `R ${Math.round(pan)}`);
      applyPan();
    }, 50);
  }

  // ---------- mode presets (VOICE / MUSIC / TURBO) ----------
  const MODES = {
    voice: { clearGain: 2.6, masterGain: 18, rageBoost: 40, bitrate: 2500, stereoWidth: 1.15 },
    music: { clearGain: 2.2, masterGain: 22, rageBoost: 34, bitrate: 2500, stereoWidth: 1.35 },
    turbo: { clearGain: 2.9, masterGain: 32, rageBoost: 60, bitrate: 2500, stereoWidth: 1.55 },
  };

  function applyMode(name) {
    // The obfuscated injector keeps its state on window.__AltMinusPanelReady via
    // its internal applyProfile().  We click its profile <select> so state stays
    // consistent, then override the sliders with our numbers.
    const sel = document.getElementById('altminus-profile');
    if (sel) {
      sel.value = 'max';                // force injector into max envelope
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const preset = MODES[name];
    if (!preset) return;
    Object.entries(preset).forEach(([param, val]) => {
      const slider = document.querySelector(
        `#altminus-panel-body input[data-param="${param}"]`);
      if (!slider) return;
      slider.value = String(val);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function mount() {
    const panel = findPanel();
    if (!panel || document.getElementById('sw-stereo-pan-box')) return false;

    const box = document.createElement('section');
    box.id = 'sw-stereo-pan-box';
    box.innerHTML = `
      <div class="sw-sp-head">
        <b>FIELD PAN</b><span id="sw-stereo-pan-value">MID</span>
      </div>
      <div class="sw-sp-row">
        <span>L</span>
        <input id="sw-stereo-pan" type="range" min="-100" max="100" step="1" value="0" aria-label="Field Pan">
        <span>R</span>
      </div>
      <button id="sw-auto-pan" type="button">SWEEP <em>OFF</em></button>
      <div class="sw-sp-speed">
        <label for="sw-auto-speed">Rate</label>
        <select id="sw-auto-speed">
          <option value="0.05">0.05s</option>
          <option value="0.10" selected>0.10s</option>
          <option value="0.20">0.20s</option>
          <option value="0.50">0.50s</option>
          <option value="1.00">1.00s</option>
        </select>
      </div>
      <div class="sw-sp-head" style="margin-top:14px;"><b>CLARITY MODE</b></div>
      <div class="sw-sp-modes">
        <button data-mode="voice" class="sw-mode-btn active" type="button">VOICE</button>
        <button data-mode="music" class="sw-mode-btn" type="button">MUSIC</button>
        <button data-mode="turbo" class="sw-mode-btn" type="button">TURBO</button>
      </div>
    `;
    panel.appendChild(box);

    const slider   = box.querySelector('#sw-stereo-pan');
    const value    = box.querySelector('#sw-stereo-pan-value');
    const autoBtn  = box.querySelector('#sw-auto-pan');
    const speedSel = box.querySelector('#sw-auto-speed');
    const modeBtns = box.querySelectorAll('.sw-mode-btn');

    slider.addEventListener('input', () => {
      pan = Number(slider.value);
      value.textContent = pan === 0 ? 'MID'
        : (pan < 0 ? `L ${Math.abs(Math.round(pan))}` : `R ${Math.round(pan)}`);
      if (auto) { auto = false; stopAuto(); autoBtn.classList.remove('active'); autoBtn.innerHTML = 'SWEEP <em>OFF</em>'; }
      applyPan();
    });

    autoBtn.addEventListener('click', () => {
      auto = !auto;
      autoBtn.classList.toggle('active', auto);
      autoBtn.innerHTML = auto ? 'SWEEP <em>ON</em>' : 'SWEEP <em>OFF</em>';
      auto ? startAuto() : stopAuto();
    });

    speedSel.addEventListener('change', () => {
      speed = Number(speedSel.value);
      if (auto) startAuto();
    });

    modeBtns.forEach(btn => btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyMode(btn.dataset.mode);
    }));

    applyPan();
    applyMode('voice');   // start in VOICE preset
    return true;
  }

  const observer = new MutationObserver(() => { if (mount()) observer.disconnect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  mount();
  setInterval(() => { if (!document.getElementById('sw-stereo-pan-box')) mount(); }, 1500);
})();
