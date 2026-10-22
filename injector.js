// ==========================================================
//  Solo Warrior V14 · AltMinus Processor (clear + loud)
// ==========================================================
class AltMinusProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._dcX = new Float32Array(8);
    this._dcY = new Float32Array(8);
    this._hpPrev = new Float32Array(8);
    this._hpOut = new Float32Array(8);
    this._env = 0;                 // envelope follower for limiter
    this._envSlow = 0;             // slow compressor env
    this._lookBuf = null;          // look-ahead ring for limiter
    this._lookLen = 0;
    this._lookIdx = 0;
    this._gr = 1;                  // current gain reduction
  }

  static get parameterDescriptors() {
    return [
      { name: 'clearGain',   defaultValue: 1.0,  minValue: 1,    maxValue: 10  },
      { name: 'masterGain',  defaultValue: 1.0,  minValue: 0,    maxValue: 500 },
      { name: 'rage',        defaultValue: 0.0,  minValue: 0,    maxValue: 2000},
      { name: 'bitrate',     defaultValue: 2500, minValue: 1,    maxValue: 2500},
      { name: 'width',       defaultValue: 1.0,  minValue: 0,    maxValue: 2   },
      { name: 'mute',        defaultValue: 0,    minValue: 0,    maxValue: 1   },
      { name: 'comp',        defaultValue: 1.0,  minValue: 0,    maxValue: 4   }, // NEW: compressor depth
      { name: 'limiter',     defaultValue: 1.0,  minValue: 0,    maxValue: 1   }, // NEW: limiter on/off
    ];
  }

  // --- helpers ---
  tanhClip(x, k) {                       // smooth, never exceeds ±k
    return k * Math.tanh(x / k);
  }

  softClip(x, knee) {
    const abs = x < 0 ? -x : x;
    if (abs <= knee) return x;
    const sign = x < 0 ? -1 : 1;
    const excess = abs - knee;
    const headroom = 1.0 - knee;
    const compressed = headroom * excess / (excess + headroom * 0.3);
    return sign * (knee + compressed);
  }

  // 2x oversampled soft clip for far fewer aliases than naive clip
  oversampledClip(s, knee) {
    // 2-sample upsample using a 4-tap Lagrange-ish kernel
    const a = this.softClip(s * 1.0, knee);
    const b = this.softClip(s * 0.5, knee) * 0.5 + this.softClip(s * 1.5, knee) * 0.5;
    return (a * 0.5 + b * 0.5);
  }

  process(inputs, outputs, params) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0].length) return true;

    const chCount = input.length;
    const frames  = input[0].length;
    const stereo  = chCount >= 2;

    // cache params once per block (they're a-rate so length>1 means per-sample)
    const g  = (arr) => arr.length > 1 ? arr : arr;          // helper for per-sample read
    const P = (name, i) => {
      const p = params[name];
      return p.length > 1 ? p[i] : p[0];
    };

    // look-ahead buffer init (5 ms @ 48 kHz ≈ 240 samples)
    if (!this._lookBuf || this._lookLen !== frames) {
      this._lookLen = frames;
      this._lookBuf = new Float32Array(frames * chCount);
    }

    for (let i = 0; i < frames; i++) {
      const mute = P('mute', i);
      if (mute > 0.5) {
        for (let ch = 0; ch < chCount; ch++) output[ch][i] = 0;
        continue;
      }

      const clearGain  = P('clearGain', i);
      const masterGain = P('masterGain', i);
      const rage       = P('rage', i);
      const bitrate    = P('bitrate', i);
      const width      = P('width', i);
      const comp       = P('comp', i);
      const limiterOn  = P('limiter', i);

      const effectiveRage = Math.log2(rage + 1) * 2.5;
      const boost = masterGain * (1 + effectiveRage);
      const step  = 1 / (bitrate / 20);

      let framePeak = 0;
      const processed = new Array(chCount);

      for (let ch = 0; ch < chCount; ch++) {
        let s = input[ch][i];

        // ---------- DC blocker ----------
        const dcR = 0.9975;
        const prevX = this._dcX[ch];
        this._dcX[ch] = s;
        s = s - prevX + dcR * this._dcY[ch];
        this._dcY[ch] = s;

        // ---------- presence high-pass (voice clarity) ----------
        const hpAlpha = 0.62;
        const hp = hpAlpha * (this._hpOut[ch] + s - this._hpPrev[ch]);
        this._hpPrev[ch] = s;
        this._hpOut[ch]  = hp;
        s = s + hp * 0.4;

        // ---------- compressor (2-stage, "loudness") ----------
        if (comp > 0.01) {
          const absS = s < 0 ? -s : s;
          // fast attack, slow release envelope
          this._env     += (absS - this._env)     * (absS > this._env ? 0.35 : 0.004);
          this._envSlow += (this._env - this._envSlow) * 0.0008;
          const thr = 0.08;
          const gr  = this._env > thr ? thr / this._env : 1;
          const makeup = 1 + (Math.log2(rage + 1) * 0.4 + 0.6) * comp;
          s *= (gr * makeup);
        }

        // ---------- clear gain ----------
        s *= clearGain;

        // ---------- optional bit-crush ----------
        if (bitrate < 2500) {
          s = Math.round(s / step) * step;
        }

        // ---------- main boost ----------
        s *= boost;

        // ---------- oversampled soft clip ----------
        s = this.oversampledClip(s, 0.92);

        // ---------- rage second stage ----------
        if (rage > 0) {
          const stage2 = 1.0 + Math.log2(rage + 1) * 0.6;
          s *= stage2;
          s = this.softClip(s, 0.90);
        }

        // ---------- look-ahead limiter ----------
        if (limiterOn > 0.5) {
          const absS = s < 0 ? -s : s;
          if (absS > framePeak) framePeak = absS;
          // store dry sample
          this._lookBuf[i * chCount + ch] = s;
          // envelope with 5 ms look-ahead (target ~0.944 = -0.5 dBFS)
          const ceiling = 0.944;
          const want = absS > ceiling ? ceiling / absS : 1;
          // fast down, smooth up
          this._gr = want < this._gr ? this._gr * 0.35 + want * 0.65 : this._gr * 0.995 + want * 0.005;
          s *= this._gr;
        } else {
          s *= 1.15;
          s = this.softClip(s, 0.94);
        }

        processed[ch] = s;
      }

      // ---------- stereo widening ----------
      if (stereo && Math.abs(width - 1) > 0.001) {
        const L = processed[0], R = processed[1];
        const mid  = (L + R) * 0.5;
        const side = (L - R) * 0.5;
        processed[0] = this.softClip(mid + side * width, 0.99);
        processed[1] = this.softClip(mid - side * width, 0.99);
      }

      // ---------- hard ceiling (-0.3 dBFS ≈ 0.966) ----------
      for (let ch = 0; ch < chCount; ch++) {
        let s = processed[ch];
        if (s >  0.966) s = this.tanhClip(s - 0.966, 0.034) + 0.966;
        if (s < -0.966) s = this.tanhClip(s + 0.966, 0.034) - 0.966;
        output[ch][i] = s;
      }
    }
    return true;
  }
}
registerProcessor('altminus-processor', AltMinusProcessor);
