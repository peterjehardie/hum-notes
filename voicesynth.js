// Singing-voice resynthesis without neural nets, WORLD-style, rendered offline into a buffer.
// Each 10 ms frame gets a smooth spectral envelope built from the measured harmonics; glottal
// pulses are placed by integrating f0, each one a minimum-phase impulse response of the envelope
// at that instant; envelope-shaped breath noise is mixed in on top.
// Pure number crunching, returns Float32Arrays. Load after dsp.js (uses fft, HMAX, midiToHz).

// Envelope grid: 1/12 octave from 50 Hz to ~12 kHz, dB with the peak at 0.
const VS_LO = 50, VS_PER_OCT = 12, VS_BINS = 96;
const vsPos = hz => VS_PER_OCT * Math.log2(hz / VS_LO);

// Envelope value (dB) at a fractional grid position: 12 dB/oct roll-off below 50 Hz and above
// the top of the grid, never below -80 dB (a deeper notch makes the pulse ring for too long).
function vsEnvAt(env, x) {
  if (!(x > -24)) x = -24;
  if (x <= 0) return Math.max(-80, env[0] + x);
  const top = VS_BINS - 1;
  if (x >= top) return Math.max(-80, env[top] - (x - top));
  const i = Math.floor(x), f = x - i;
  return env[i] + (env[i + 1] - env[i]) * f;
}

// One analysis frame's harmonics as an envelope on the grid (dB, peak 0), with a per-bin
// confidence: 1 between the lowest and highest harmonic, 0.5 where held or extrapolated.
// Between harmonics: straight lines in dB over log-frequency; above the top one: -12 dB/oct,
// plus a drop over the first half octave down to the level of the top three harmonics, so one
// loud top harmonic does not brighten everything above it.
function vsFrameEnv(fr) {
  const px = [], py = [];
  for (let k = 0; k < HMAX; k++) {
    if (!isFinite(fr.h[k]) || !(fr.hf[k] > 0)) continue;
    const x = vsPos(fr.hf[k]);
    if (px.length && x <= px[px.length - 1]) continue;
    px.push(x); py.push(fr.h[k]);
  }
  if (px.length < 2) return null;
  const top = Math.max(...py), last = px.length - 1;
  let p3 = 0;
  for (let i = Math.max(0, last - 2); i <= last; i++) p3 += Math.pow(10, py[i] / 10);
  const extra = Math.max(0, py[last] - 10 * Math.log10(p3 / Math.min(3, last + 1)));
  const env = new Float32Array(VS_BINS), conf = new Float32Array(VS_BINS);
  let j = 0;
  for (let b = 0; b < VS_BINS; b++) {
    let v, c = 1;
    if (b <= px[0]) { v = py[0]; c = 0.5; }
    else if (b >= px[last]) { const d = b - px[last]; v = py[last] - d - Math.min(1, d / 6) * extra; c = 0.5; }
    else {
      while (px[j + 1] < b) j++;
      v = py[j] + (py[j + 1] - py[j]) * (b - px[j]) / (px[j + 1] - px[j]);
    }
    env[b] = v - top; conf[b] = c;
  }
  return { env, conf, n: px.length };
}

// Rough breathiness of one frame (0..1): noise peaks among the upper harmonics, and
// harmonics that should be there but were not found.
function vsBreathiness(fr) {
  let hiH = 0, hiO = 0, found = 0, expected = 0;
  for (let k = 0; k < HMAX; k++) {
    if ((k + 1) * fr.f0 > 6000) break;
    expected++;
    if (!isFinite(fr.h[k])) continue;
    found++;
    if (fr.hf[k] > 1000) hiH += Math.pow(10, fr.h[k] / 10);
  }
  for (const p of fr.other || []) if (p.f > 1000 && p.f > 1.5 * fr.f0) hiO += Math.pow(10, p.level / 10);
  const nf = hiO + hiH > 0 ? hiO / (hiO + hiH) : 0;
  const miss = expected ? 1 - found / expected : 0;
  return Math.max(0, Math.min(1, 0.1 + 0.5 * nf + 0.4 * miss));
}

// Light smoothing over ±1/6 octave, then peak back to 0 dB.
function vsSmooth(src) {
  const out = new Float32Array(VS_BINS), k = [1, 2, 3, 2, 1];
  let top = -Infinity;
  for (let b = 0; b < VS_BINS; b++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += k[d + 2] * src[Math.min(VS_BINS - 1, Math.max(0, b + d))];
    out[b] = s / 9;
    if (out[b] > top) top = out[b];
  }
  for (let b = 0; b < VS_BINS; b++) out[b] -= top;
  return out;
}

// Per output frame k (time t0 + k * hop, n frames): the voice's spectral envelope on the grid,
// from the analysis frames within ±30 ms, leaning on the whole-take average where those are
// unvoiced or sparse. Also a breathiness estimate per frame (0..1).
// Returns { env: [Float32Array(VS_BINS)], breath: Float32Array(n), avg: Float32Array(VS_BINS) }.
function frameEnvelopes(frames, t0, hop, n) {
  const fe = frames.map(f => f.f0 > 0 ? vsFrameEnv(f) : null);
  const fb = frames.map((f, i) => fe[i] ? vsBreathiness(f) : 0);

  // whole-take average shape (falls back to a plain hum-like slope when nothing is voiced)
  const sum = new Float64Array(VS_BINS), wsum = new Float64Array(VS_BINS);
  let bSum = 0, bCnt = 0;
  fe.forEach((e, i) => {
    if (!e) return;
    for (let b = 0; b < VS_BINS; b++) { sum[b] += e.conf[b] * e.env[b]; wsum[b] += e.conf[b]; }
    bSum += fb[i]; bCnt++;
  });
  const raw = new Float32Array(VS_BINS), knee = vsPos(400);
  for (let b = 0; b < VS_BINS; b++) raw[b] = wsum[b] ? sum[b] / wsum[b] : -Math.max(0, b - knee);
  const avg = vsSmooth(raw), avgB = bCnt ? bSum / bCnt : 0.3;

  const R = 0.03, W0 = 0.15, env = [], breath = new Float32Array(n);
  const acc = new Float64Array(VS_BINS), wt = new Float64Array(VS_BINS), tmp = new Float32Array(VS_BINS);
  let a = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * hop;
    while (a < frames.length && frames[a].t < t - R) a++;
    acc.fill(0); wt.fill(0);
    let bs = 0, bw = 0;
    for (let i = a; i < frames.length && frames[i].t <= t + R; i++) {
      const e = fe[i];
      if (!e) continue;
      const w = (1 - Math.abs(frames[i].t - t) / (R + 0.01)) * Math.min(1, e.n / 4);
      for (let b = 0; b < VS_BINS; b++) { const c = w * e.conf[b]; acc[b] += c * e.env[b]; wt[b] += c; }
      bs += w * fb[i]; bw += w;
    }
    if (!bw) { env.push(avg); breath[k] = avgB; continue; }
    for (let b = 0; b < VS_BINS; b++) tmp[b] = (acc[b] + W0 * avg[b]) / (wt[b] + W0);
    env.push(vsSmooth(tmp));
    breath[k] = (bs + W0 * avgB) / (bw + W0);
  }
  return { env, breath, avg };
}

// Small seeded random source with Gaussian draws.
function vsRandom(seed) {
  let s = (seed >>> 0) || 1;
  const u = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, gauss };
}

// Renders a voice into a Float32Array at opts.sr.
// opts = { sr, hop (s), f0: Float32Array (Hz per frame, 0 = silent), amp: Float32Array (0..~1.5),
//   env: per-frame envelopes from frameEnvelopes (or one envelope for all), breath: 0..1,
//   breathiness: optional per-frame 0..1 from frameEnvelopes, seed }
// Frame k sits at k * hop seconds into the output.
function renderVoice(opts) {
  const sr = opts.sr, hop = opts.hop, n = opts.f0.length;
  const breath = opts.breath == null ? 0.3 : opts.breath;
  const rng = vsRandom(opts.seed == null ? 1 : opts.seed);
  const envs = Array.isArray(opts.env) ? opts.env : null;
  const envOf = k => envs ? envs[Math.min(envs.length - 1, Math.max(0, k))] : opts.env;
  const len = Math.ceil(n * hop * sr) + 2048;
  const y = new Float32Array(len);
  if (!n) return y;

  // pitch held through the gaps (so fades keep a pitch), loudness, voicing gain with 15 ms ramps
  const f0 = new Float32Array(n), amp = new Float32Array(n), g = new Float32Array(n), bth = new Float32Array(n);
  let held = 0, first = -1;
  for (let k = 0; k < n; k++) {
    const f = opts.f0[k];
    if (f > 0 && isFinite(f)) { held = f; if (first < 0) first = k; }
    f0[k] = held;
    const a = opts.amp[k];
    amp[k] = a > 0 && isFinite(a) ? a : 0;
    const b = opts.breathiness ? opts.breathiness[Math.min(k, opts.breathiness.length - 1)] : 0.3;
    bth[k] = isFinite(b) ? b : 0.3;
  }
  if (first < 0) return y;
  for (let k = 0; k < first; k++) f0[k] = f0[first];
  const step = Math.min(1, hop / 0.015);
  let gv = 0;
  for (let k = 0; k < n; k++) {
    const target = opts.f0[k] > 0 ? 1 : 0;
    gv += Math.max(-step, Math.min(step, target - gv));
    g[k] = gv;
  }
  const at = (arr, x) => {
    if (x <= 0) return arr[0];
    const i = Math.floor(x);
    if (i >= n - 1) return arr[n - 1];
    return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
  };
  const G = 0.15;                      // harmonic amplitude at the envelope peak for amp 1
  const LN = Math.LN10 / 20;

  // ---- periodic part: one minimum-phase pulse per glottal cycle ----
  const N = 2048, NH = N / 2;
  const re = new Float64Array(N), im = new Float64Array(N);
  const binX = new Float64Array(NH + 1), tiltX = new Float64Array(NH + 1);
  for (let b = 1; b <= NH; b++) { const hz = b * sr / N; binX[b] = vsPos(hz); tiltX[b] = Math.log2(hz / 400); }
  binX[0] = -Infinity;
  const taper = new Float64Array(N);
  for (let j = 0; j < N; j++) taper[j] = j < 1536 ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (j - 1536) / 512);

  // minimum-phase spectrum of frame k (real cepstrum folding), cached for the few frames in use
  const cache = new Map();
  const frameSpec = k => {
    k = Math.min(n - 1, Math.max(0, k));
    let s = cache.get(k);
    if (s) return s;
    const e = envOf(k);
    const tilt = Math.max(-1.5, Math.min(1.5, (amp[k] - 0.5) * 3));   // dB/oct, brighter when louder
    for (let b = 0; b <= NH; b++) {
      const db = vsEnvAt(e, binX[b]) + Math.max(-9, Math.min(9, tilt * tiltX[b]));
      re[b] = db * LN; im[b] = 0;
      if (b > 0 && b < NH) { re[N - b] = re[b]; im[N - b] = 0; }
    }
    fft(re, im);
    re[0] /= N; re[NH] /= N;
    for (let j = 1; j < NH; j++) re[j] *= 2 / N;
    for (let j = NH + 1; j < N; j++) re[j] = 0;
    im.fill(0);
    fft(re, im);
    s = { r: new Float32Array(NH + 1), i: new Float32Array(NH + 1) };
    for (let b = 0; b <= NH; b++) {
      const m = Math.exp(re[b]);
      s.r[b] = m * Math.cos(im[b]); s.i[b] = m * Math.sin(im[b]);
    }
    cache.set(k, s);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return s;
  };

  // glottal instants: phase follows f0 exactly; jitter nudges each pulse off its ideal instant
  // (smoothed, ~0.4 % of a period, not accumulated so the pitch never drifts)
  const AR = 0.6, AQ = Math.sqrt(1 - AR * AR);
  let jit = 0, shim = 0, t = first * hop;
  const end = n * hop;
  while (t < end) {
    const x = t / hop, f = at(f0, x);
    jit = AR * jit + AQ * 0.004 * rng.gauss();
    shim = AR * shim + AQ * 0.03 * rng.gauss();   // amplitude shimmer ~3 %
    const gain = at(g, x) * at(amp, x);
    if (gain > 1e-5) {
      const pos = Math.max(0, (t + jit / f) * sr), i0 = Math.floor(pos), frac = pos - i0;
      const k = Math.floor(x), fr = x - k, A = frameSpec(k), B = frameSpec(k + 1);
      const scale = G * gain * (1 + shim) * (sr / f) / 2;
      // fractional delay as a linear phase ramp
      const ph = -2 * Math.PI * frac / N, wr = Math.cos(ph), wi = Math.sin(ph);
      let cr = scale, ci = 0;
      for (let b = 0; b <= NH; b++) {
        const hr = A.r[b] + (B.r[b] - A.r[b]) * fr, hi = A.i[b] + (B.i[b] - A.i[b]) * fr;
        const vr = hr * cr - hi * ci, vi = hr * ci + hi * cr;
        re[b] = vr; im[b] = -vi;
        if (b > 0 && b < NH) { re[N - b] = vr; im[N - b] = vi; }
        const nc = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nc;
      }
      fft(re, im);
      const lim = Math.min(N, len - i0);
      for (let j = 0; j < lim; j++) y[i0 + j] += re[j] / N * taper[j];
    }
    const fm = at(f0, (t + 0.5 / f) / hop);
    t += 1 / fm;
  }

  // ---- aperiodic part: envelope-shaped noise, more of it up high and when soft ----
  const M = 1024, MH = M / 2;
  const nRe = new Float64Array(M), nIm = new Float64Array(M);
  const nX = new Float64Array(MH), hiW = new Float64Array(MH), sw = new Float64Array(M);
  for (let b = 1; b < MH; b++) { const hz = b * sr / M; nX[b] = vsPos(hz); hiW[b] = 1 / (1 + Math.pow(3000 / hz, 3)); }
  for (let j = 0; j < M; j++) sw[j] = Math.sin(Math.PI * (j + 0.5) / M);
  if (breath > 0) {
    for (let s = -MH; s < len; s += MH) {
      const x = (s + MH) / sr / hop;
      const gain = at(g, x) * at(amp, x);
      if (gain < 1e-5) continue;
      const k = Math.floor(Math.max(0, x)), fr = Math.max(0, x) - k, eA = envOf(k), eB = envOf(k + 1);
      const lvl = breath * (0.5 + at(bth, x)) * (1 + 0.8 * Math.max(0, 1 - at(amp, x)));
      const base = G * gain * Math.sqrt(M * sr / (4 * at(f0, x))) / Math.SQRT2;
      nRe.fill(0); nIm.fill(0);
      for (let b = 1; b < MH; b++) {
        const db = vsEnvAt(eA, nX[b]) + (vsEnvAt(eB, nX[b]) - vsEnvAt(eA, nX[b])) * fr;
        const mag = base * Math.exp(db * LN) * Math.sqrt(lvl * (0.03 + 0.6 * hiW[b]));
        const a = mag * rng.gauss(), c = mag * rng.gauss();
        nRe[b] = a; nIm[b] = c; nRe[M - b] = a; nIm[M - b] = -c;
      }
      fft(nRe, nIm);
      for (let j = 0; j < M; j++) { const i = s + j; if (i >= 0 && i < len) y[i] += nRe[j] / M * sw[j]; }
    }
  }

  // never NaN, no DC (one-pole high-pass at 20 Hz), peak at most 0.97
  const hp = Math.exp(-2 * Math.PI * 20 / sr);
  let peak = 0, px = 0, py = 0;
  for (let i = 0; i < len; i++) {
    const v = isFinite(y[i]) ? y[i] : 0;
    py = hp * (py + v - px); px = v; y[i] = py;
    if (Math.abs(py) > peak) peak = Math.abs(py);
  }
  if (peak > 0.97) { const s = 0.97 / peak; for (let i = 0; i < len; i++) y[i] *= s; }
  return y;
}

// The app's sung line -> audio. line = { t0, hop, m: Float32Array (MIDI, NaN = silent),
// a: Float32Array (0..~1.5) }; frames from analyseSpectrum. opts = { breath, seed, transpose }:
// transpose (semitones) moves only the pitch, so the vowel colour stays put.
// Returns { samples: Float32Array, sr }; samples[0] is at time line.t0.
function renderLine(line, frames, sr, opts = {}) {
  const n = line.m.length, tr = opts.transpose || 0;
  const f0 = new Float32Array(n), amp = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const m = line.m[k], a = line.a[k];
    f0[k] = isFinite(m) ? midiToHz(m + tr) : 0;
    amp[k] = isFinite(a) && a > 0 ? a : 0;
  }
  const fe = frameEnvelopes(frames, line.t0, line.hop, n);
  const samples = renderVoice({
    sr, hop: line.hop, f0, amp, env: fe.env, breathiness: fe.breath,
    breath: opts.breath == null ? 0.3 : opts.breath, seed: opts.seed == null ? 1 : opts.seed,
  });
  return { samples, sr };
}
