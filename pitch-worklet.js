// YIN pitch tracker. Input is decimated 2x (fine for voice and whistle),
// analysed every 128 decimated samples (~5 ms at 48 kHz).
// While recording it also streams the raw input back in chunks.
class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate / 2;
    this.N = 1024;
    this.W = 512;
    this.buf = new Float32Array(this.N);
    this.lin = new Float32Array(this.N);
    this.w = 0;
    this.count = 0;
    this.hop = 128;
    this.half = 0;
    this.hasHalf = false;
    this.minTau = Math.max(2, Math.floor(this.sr / 3200));
    this.maxTau = Math.min(this.N - this.W - 1, Math.ceil(this.sr / 60));
    this.d = new Float32Array(this.maxTau + 2);

    this.rec = false;
    this.recBuf = new Float32Array(8192);
    this.recN = 0;
    this.recT = 0;
    // live auto-tune: params from the page, a target note with hysteresis,
    // and a two-head delay-line pitch shifter on the output
    this.P = { gate: 0, amount: 0, speed: 0.3, root: 0, scale: null, monitor: false };
    this.tgt = null; this.cs = 0; this.shiftT = 0; this.sh = 0;
    this.R = new Float32Array(16384); this.rw = 0; this.ph = 0;
    this.G = 1024; this.Gt = 1024;

    this.port.onmessage = e => {
      if (e.data.rec === true) { this.rec = true; this.recN = 0; }
      if (e.data.rec === false) { this.flush(); this.rec = false; this.port.postMessage({ recDone: true }); }
      if (e.data.params) Object.assign(this.P, e.data.params);
    };
  }

  snap(m) {
    const r = Math.round(m), sc = this.P.scale;
    if (!sc) return r;
    let best = r, bd = 99;
    for (let k = r - 2; k <= r + 2; k++) {
      if (!sc.includes((((k - this.P.root) % 12) + 12) % 12)) continue;
      if (Math.abs(k - m) < bd) { bd = Math.abs(k - m); best = k; }
    }
    return best;
  }

  shiftBlock(x, y) {
    const R = this.R, M = R.length - 1, minD = 64;
    for (let i = 0; i < x.length; i++) {
      R[this.rw & M] = x[i];
      this.sh += (this.shiftT - this.sh) * 0.003;
      this.G += (this.Gt - this.G) * 0.0005;
      const r = Math.pow(2, this.sh / 12);
      this.ph += (1 - r) / this.G;
      this.ph -= Math.floor(this.ph);
      let out = 0;
      for (let h = 0; h < 2; h++) {
        const p = h ? (this.ph + 0.5) % 1 : this.ph;
        const pos = this.rw - minD - p * this.G, i0 = Math.floor(pos), fr = pos - i0;
        const v = R[i0 & M] + (R[(i0 + 1) & M] - R[i0 & M]) * fr;
        out += v * (0.5 - 0.5 * Math.cos(2 * Math.PI * p));
      }
      y[i] = out;
      this.rw++;
    }
  }

  flush() {
    if (!this.recN) return;
    const a = this.recBuf.slice(0, this.recN);
    this.port.postMessage({ audio: a, t: this.recT }, [a.buffer]);
    this.recN = 0;
  }

  process(inputs, outputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.P.monitor) this.shiftBlock(ch, outputs[0][0]);
    if (this.rec) {
      if (this.recN === 0) this.recT = currentTime;
      this.recBuf.set(ch, this.recN);
      this.recN += ch.length;
      if (this.recN + 128 > this.recBuf.length) this.flush();
    }
    for (let i = 0; i < ch.length; i++) {
      if (!this.hasHalf) { this.half = ch[i]; this.hasHalf = true; continue; }
      this.buf[this.w] = (this.half + ch[i]) * 0.5;
      this.w = (this.w + 1) % this.N;
      this.hasHalf = false;
      if (++this.count >= this.hop) { this.count = 0; this.analyse(currentTime + (i + 1) / sampleRate); }
    }
    return true;
  }

  analyse(tEnd) {
    const { N, W, maxTau, minTau, d } = this;
    const L = W + maxTau + 1;
    const x = this.lin;
    let r = (this.w - L + N) % N;
    for (let i = 0; i < L; i++) { x[i] = this.buf[r]; r = (r + 1) % N; }

    let e = 0;
    for (let i = L - W; i < L; i++) e += x[i] * x[i];
    const rms = Math.sqrt(e / W);

    d[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const v = x[j] - x[j + tau]; s += v * v; }
      run += s;
      d[tau] = run > 0 ? (s * tau) / run : 1;
    }

    let tau = -1;
    for (let t = minTau; t < maxTau; t++) {
      if (d[t] < 0.15) {
        while (t + 1 < maxTau && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = 1e9;
      for (let t = minTau; t < maxTau; t++) if (d[t] < best) { best = d[t]; tau = t; }
    }
    let ft = tau;
    if (tau > 1 && tau < maxTau) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const den = a + c - 2 * b;
      if (den !== 0) ft = tau + (a - c) / (2 * den);
    }
    // the estimate describes roughly the middle of the compared span; a fixed offset keeps
    // timestamps in order whatever the pitch
    const t = tEnd - (L - W / 2 - maxTau / 4) / this.sr;
    const f = this.sr / ft, clarity = 1 - d[tau];

    const P = this.P;
    // the gate follows the room's noise floor, so quiet mics still register
    // it starts from a quiet guess, creeps up slowly (about 1% a second, so minutes of
    // unbroken singing are never mistaken for noise) and never rises above -40 dBFS
    this.floor = Math.min(rms, (this.floor ?? 0.0005) * 1.00005);
    const gate = Math.max(0.0002, Math.min(this.floor * 4, 0.01), P.gate);
    const voiced = rms > gate && clarity > 0.8 && f > 55 && f < 3200;
    let c = 0;
    if (voiced) {
      const m = 69 + 12 * Math.log2(f / 440);
      if (this.tgt == null || Math.abs(m - this.tgt) > 0.6) this.tgt = this.snap(m);
      c = this.tgt - m;
      // grain = an even number of periods near 20 ms, so the two heads stay in phase
      const per = sampleRate / f;
      this.Gt = per * 2 * Math.max(1, Math.round(0.01 * sampleRate / per));
    } else this.tgt = null;
    const lag = P.speed * 0.3;
    this.cs += (c - this.cs) * (lag <= 0 ? 1 : 1 - Math.exp(-(this.hop / this.sr) / lag));
    this.shiftT = P.amount * this.cs;

    this.port.postMessage({ t, f, clarity, rms, v: voiced, gate, s: this.shiftT });
  }
}
registerProcessor('pitch', PitchProcessor);
