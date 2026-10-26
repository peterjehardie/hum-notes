// Voice profile: measures a lab session's sustained sounds part by part (pitch, jitter, shimmer,
// vibrato, formants, nasal antiformants, spectral envelope, glottal source, breath noise), so a
// synth can be built from the numbers. Classical DSP only, pure functions, no DOM, no Web Audio.
// Load after dsp.js (uses fft, median, hzToMidi, midiToHz). Formats: docs/voice-lab-contract.md.
//
// How it works, per unit:
//  1. YIN pitch every 5 ms on a copy decimated to ~11-12 kHz.
//  2. Glottal cycles marked by matching each cycle's waveform against the next (normalised
//     cross-correlation, sub-sample peak) -> periods and peak-to-peak amplitudes -> jitter, shimmer.
//  3. The steady part is time-warped so the pitch is exactly constant (vibrato and drift removed,
//     jitter kept). Every harmonic then sits exactly on k * f0, so long windows give clean
//     harmonic levels and clean gaps between harmonics (for the noise measure).
//  4. Formants: discrete all-pole modelling (DAP, El-Jaroudi & Makhoul 1991) fitted to the
//     harmonic levels below 5.4 kHz. Plain LPC at a low hummed pitch locks onto single
//     harmonics; DAP fits the model only at the frequencies where the spectrum is known, which
//     removes that bias. The model runs at 16 kHz so it is free above the data (an 11 kHz model
//     cannot follow the steep fall past F5 and bends F1/F2 to compensate). Before the fit the
//     harmonics are divided by a Rosenberg glottal pulse spectrum; its open quotient is the one
//     that leaves the most all-pole remainder. Without this the pulse's own low hump pulls F1
//     8-10 % low at 98-131 Hz. Nasals: a zero (antiformant) is searched the same way.
//  5. Source: open quotient from that fit, formant-corrected H1-H2, and the tilt of the
//     harmonics with the formants divided out.

const VP_LO = 50, VP_PER_OCT = 12, VP_BINS = 96;   // the profile's envelope grid (same as voicesynth.js)
const VP_MODEL_SR = 16000, VP_DATA_MAX = 5400, VP_ORDER = 14;   // formant model: rate, data limit, order
const VP_BANDS = [0, 500, 1500, 3000, 6000, Infinity];
const VP_SLOTS = [[180, 1100], [550, 3000], [1400, 3900], [2400, 4900], [3200, 5450]];
const VP_TYPICAL = [[500, 80], [1500, 100], [2500, 150], [3500, 250], [4500, 300]];

// ---------- small helpers ----------

const vpDb = p => 10 * Math.log10(p > 1e-30 ? p : 1e-30);
const vpMedian = a => (a.length ? median(a) : NaN);
const vpMean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);

// Decimate by an integer factor D after a windowed-sinc low-pass (Blackman, cutoff 0.9 x new Nyquist).
function vpDecimate(x, D) {
  if (D <= 1) return Float32Array.from(x);
  const M = 32 * D, h = new Float64Array(M + 1), fc = 0.45 / D;
  let hs = 0;
  for (let n = 0; n <= M; n++) {
    const u = n - M / 2, s = u === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * u) / (Math.PI * u);
    h[n] = s * (0.42 - 0.5 * Math.cos(2 * Math.PI * n / M) + 0.08 * Math.cos(4 * Math.PI * n / M));
    hs += h[n];
  }
  const n = Math.floor(x.length / D), y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * D - M / 2;
    let s = 0;
    const a = Math.max(0, -c), b = Math.min(M, x.length - 1 - c);
    for (let k = a; k <= b; k++) s += h[k] * x[c + k];
    y[i] = s / hs;
  }
  return y;
}

// YIN pitch track. Returns { t (s, relative to x[0]), f0 (Hz, 0 = unvoiced), rms }.
function vpYin(x, sr, hopS = 0.005, fmin = 55, fmax = 1000) {
  const W = Math.round(0.025 * sr), tmin = Math.max(2, Math.floor(sr / fmax)), tmax = Math.ceil(sr / fmin);
  const hop = Math.max(1, Math.round(hopS * sr)), d = new Float64Array(tmax + 2), cm = new Float64Array(tmax + 2);
  const t = [], f0 = [], rms = [];
  for (let s = 0; s + W + tmax + 1 < x.length; s += hop) {
    let e = 0;
    for (let j = 0; j < W; j++) e += x[s + j] * x[s + j];
    for (let tau = 1; tau <= tmax + 1; tau++) {
      let v = 0;
      for (let j = 0; j < W; j++) { const q = x[s + j] - x[s + j + tau]; v += q * q; }
      d[tau] = v;
    }
    let run = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= tmax + 1; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let k = tmin; k <= tmax; k++) {
      if (cm[k] < 0.15) { while (k + 1 <= tmax && cm[k + 1] < cm[k]) k++; tau = k; break; }
    }
    if (tau < 0) { let b = tmin; for (let k = tmin; k <= tmax; k++) if (cm[k] < cm[b]) b = k; tau = b; }
    let tf = tau;
    if (tau > 1 && tau < tmax + 1) {
      const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a - 2 * b + c;
      if (den > 0) tf = tau + 0.5 * (a - c) / den;
    }
    t.push((s + (W + tf) / 2) / sr);
    rms.push(Math.sqrt(e / W));
    f0.push(cm[tau] < 0.35 ? sr / tf : 0);
  }
  // quiet frames are unvoiced (40 dB under the loudest)
  const top = Math.max(0, ...rms);
  for (let i = 0; i < f0.length; i++) if (rms[i] < top * 0.01) f0[i] = 0;
  return { t: Float64Array.from(t), f0: Float64Array.from(f0), rms: Float64Array.from(rms) };
}

// Linear interpolation in a track { t, v } (held at the ends, skipping zeros).
function vpTrackAt(tt, vv, t) {
  let lo = 0, hi = tt.length - 1;
  if (hi < 0) return 0;
  if (t <= tt[0]) return vv[0];
  if (t >= tt[hi]) return vv[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tt[m] <= t) lo = m; else hi = m; }
  const f = (t - tt[lo]) / (tt[hi] - tt[lo]);
  return vv[lo] + (vv[hi] - vv[lo]) * f;
}

// Glottal cycle marks between samples i0 and i1, following the pitch f0At(sample index).
// Each cycle (a window from just before its main peak, 0.8 period long, so it holds this cycle's
// excitation and not the last one's tail) is matched against the next by normalised
// cross-correlation with a sub-sample peak.
// Returns [{ pos, T (samples), A (peak-to-peak), ok, chain }].
function vpCycles(x, sr, f0At, i0, i1) {
  const out = [];
  let chain = 0, sf = -1;
  const startAt = s => {
    const P = sr / f0At(s);
    let pk = s, pv = -1;
    for (let i = s; i < Math.min(i1, s + P); i++) if (Math.abs(x[i]) > pv) { pv = Math.abs(x[i]); pk = i; }
    chain++;
    return Math.max(i0, pk - 0.15 * P);
  };
  sf = f0At(i0) > 0 ? startAt(i0) : i0;
  let guard = 0;
  while (guard++ < 100000) {
    const s = Math.round(sf), f = f0At(s);
    if (!(f > 0)) { sf += 0.01 * sr; if (sf >= i1) break; if (f0At(Math.round(sf)) > 0) sf = startAt(Math.round(sf)); continue; }
    const P = sr / f, L = Math.round(0.8 * P), lo = Math.floor(0.8 * P), hi = Math.ceil(1.2 * P);
    if (s + hi + L + 1 >= i1) break;
    let e0 = 0;
    for (let j = 0; j < L; j++) e0 += x[s + j] * x[s + j];
    let eT = 0;
    for (let j = 0; j < L; j++) eT += x[s + lo + j] * x[s + lo + j];
    const nc = new Float64Array(hi - lo + 1);
    for (let T = lo; T <= hi; T++) {
      if (T > lo) { const a = x[s + T - 1], b = x[s + T + L - 1]; eT += b * b - a * a; }
      let c = 0;
      for (let j = 0; j < L; j++) c += x[s + j] * x[s + T + j];
      nc[T - lo] = e0 > 0 && eT > 0 ? c / Math.sqrt(e0 * eT) : 0;
    }
    let b = 0;
    for (let k = 1; k < nc.length; k++) if (nc[k] > nc[b]) b = k;
    let Tf = lo + b;
    if (b > 0 && b < nc.length - 1) {
      const a = nc[b - 1], v = nc[b], c = nc[b + 1], den = a - 2 * v + c;
      if (den < 0) Tf += 0.5 * (a - c) / den;
    }
    const ok = nc[b] > 0.6 && b > 0 && b < nc.length - 1;
    if (!ok) { out.push({ pos: s, T: P, A: 0, ok: false, chain }); sf = startAt(Math.round(sf + P)); continue; }
    let mx = -Infinity, mn = Infinity;
    const e = Math.min(x.length, s + Math.round(Tf));
    for (let i = s; i < e; i++) { if (x[i] > mx) mx = x[i]; if (x[i] < mn) mn = x[i]; }
    out.push({ pos: s, T: Tf, A: mx - mn, ok: true, chain });
    sf = s + Tf;
  }
  return out;
}

// Local perturbation of a cycle series (jitter for periods, shimmer for amplitudes): mean absolute
// cycle-to-cycle difference over the mean, after removing slow movement (vibrato, swells) with a
// 9-cycle moving average. Only neighbouring good cycles in the same chain count.
function vpPerturb(cyc, key) {
  const runs = [];
  let run = [];
  for (let i = 0; i < cyc.length; i++) {
    const c = cyc[i];
    if (c.ok && run.length && run[run.length - 1].chain === c.chain && c.pos - run[run.length - 1].pos < 1.5 * c.T + 2) run.push(c);
    else { if (run.length) runs.push(run); run = c.ok ? [c] : []; }
  }
  if (run.length) runs.push(run);
  let sd = 0, nd = 0, sv = 0, nv = 0;
  for (const r of runs) {
    if (r.length < 5) continue;
    const v = r.map(c => c[key]), dt = v.map((_, i) => {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - 4); j <= Math.min(v.length - 1, i + 4); j++) { s += v[j]; n++; }
      return v[i] - s / n;
    });
    for (let i = 1; i < v.length; i++) { sd += Math.abs(dt[i] - dt[i - 1]); nd++; }
    for (const q of v) { sv += q; nv++; }
  }
  return nd && sv > 0 ? (sd / nd) / (sv / nv) : 0;
}

// Vibrato from a pitch track (times s, Hz): the strongest 3-9 Hz sinusoid in the cents curve.
// depth = its amplitude in cents (peak deviation, half the peak-to-peak swing); rate in Hz.
function vpVibrato(t, f) {
  const n = t.length;
  if (n < 20) return { rate: 0, depth: 0 };
  const mid = vpMedian(Array.from(f)), c = Array.from(f, v => 1200 * Math.log2(v / mid));
  const dur = t[n - 1] - t[0];
  // remove a straight line (drift)
  const mt = vpMean(Array.from(t)), mc = vpMean(c);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (t[i] - mt) * (c[i] - mc); sxx += (t[i] - mt) * (t[i] - mt); }
  const sl = sxx ? sxy / sxx : 0;
  for (let i = 0; i < n; i++) c[i] -= mc + sl * (t[i] - mt);
  let varc = 0;
  for (const v of c) varc += v * v;
  varc /= n;
  let best = { rate: 0, amp: 0 };
  for (let r = 3; r <= 9.001; r += 0.05) {
    let sr = 0, si = 0;
    for (let i = 0; i < n; i++) { const p = 2 * Math.PI * r * t[i]; sr += c[i] * Math.cos(p); si += c[i] * Math.sin(p); }
    const amp = 2 * Math.hypot(sr, si) / n;
    if (amp > best.amp) best = { rate: r, amp };
  }
  const explained = varc > 0 ? (best.amp * best.amp / 2) / varc : 0;
  if (best.amp < 8 || explained < 0.4 || dur < 2 / Math.max(3, best.rate)) return { rate: 0, depth: 0 };
  return { rate: +best.rate.toFixed(2), depth: +best.amp.toFixed(1) };
}

// Time-warp x[i0..i1) so the pitch is constant: phase follows f0At(sample), output sample j sits
// where the phase reaches fbar * j / sr. fbar = the time-average pitch, so the length is kept.
// Returns { y, fbar, orig (original sample index of every 64th output sample) }.
function vpWarp(x, sr, f0At, i0, i1) {
  const n = i1 - i0, ph = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { ph[i] = acc; acc += f0At(i0 + i) / sr; }
  const fbar = ph[n - 1] / ((n - 1) / sr), y = new Float32Array(n), orig = [];
  let k = 0;
  const xs = i => x[Math.min(x.length - 1, Math.max(0, i))];
  for (let j = 0; j < n; j++) {
    const target = fbar * j / sr;
    while (k + 1 < n - 1 && ph[k + 1] <= target) k++;
    const fr = Math.min(1, Math.max(0, (target - ph[k]) / ((ph[k + 1] - ph[k]) || 1))), p = i0 + k;
    // 4-point cubic (Catmull-Rom)
    const a = xs(p - 1), b = xs(p), c = xs(p + 1), d = xs(p + 2);
    y[j] = b + 0.5 * fr * (c - a + fr * (2 * a - 5 * b + 4 * c - d + fr * (3 * (b - c) + d - a)));
    if ((j & 63) === 0) orig.push(p + fr);
  }
  return { y, fbar, orig };
}

// Harmonic analysis of a constant-pitch signal: Hann windows of nPer periods every hopPer periods.
// Per harmonic k (1-based; index k-1): H = power within +-rh*fbar of k*fbar, Nh = noise in that
// same span (density from the gaps between harmonics), C/Nc = the whole cell around k*fbar.
// mode 'mean' averages over frames; mode 'frames' returns every frame's H plus its centre sample.
function vpHarmonics(y, sr, fbar, nPer, hopPer, fmax, rh, mode) {
  const L = Math.round(nPer * sr / fbar), hop = Math.max(1, Math.round(hopPer * sr / fbar));
  let N = 1;
  while (N < 2 * L) N <<= 1;
  const K = Math.max(1, Math.floor(Math.min(fmax, 0.45 * sr) / fbar)), binHz = sr / N;
  const win = new Float64Array(L);
  for (let i = 0; i < L; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / L);
  const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2);
  const H = new Float64Array(K), Nh = new Float64Array(K), C = new Float64Array(K), Nc = new Float64Array(K);
  const frames = [];
  let nf = 0;
  for (let s = 0; s + L <= y.length; s += hop) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < L; i++) re[i] = y[s + i] * win[i];
    fft(re, im);
    for (let b = 0; b < N / 2; b++) P[b] = re[b] * re[b] + im[b] * im[b];
    const fh = mode === 'frames' ? new Float64Array(K) : null;
    for (let k = 1; k <= K; k++) {
      const fc = k * fbar, b0 = Math.max(1, Math.round((fc - 0.5 * fbar) / binHz)), b1 = Math.min(N / 2 - 1, Math.round((fc + 0.5 * fbar) / binHz));
      let h = 0, nh = 0, g = 0, ng = 0, all = 0, na = 0;
      for (let b = b0; b < b1; b++) {
        const dist = Math.abs(b * binHz - fc);
        all += P[b]; na++;
        if (dist <= rh * fbar) { h += P[b]; nh++; } else if (dist >= rh * fbar + 0.07 * fbar) { g += P[b]; ng++; }
      }
      const dens = ng ? g / ng : 0;
      if (fh) { fh[k - 1] = h; continue; }
      H[k - 1] += h; Nh[k - 1] += Math.min(h, dens * nh); C[k - 1] += all; Nc[k - 1] += Math.min(all, dens * na);
    }
    if (fh) frames.push({ c: s + L / 2, H: fh });
    nf++;
  }
  if (mode === 'frames') return { frames, K, L };
  for (let k = 0; k < K; k++) { H[k] /= nf || 1; Nh[k] /= nf || 1; C[k] /= nf || 1; Nc[k] /= nf || 1; }
  return { H, Nh, C, Nc, K, frames: nf, L };
}

// ---------- all-pole modelling ----------

// Levinson-Durbin: autocorrelation r[0..p] -> a[0..p] with a[0] = 1.
function vpLevinson(r, p) {
  const a = new Float64Array(p + 1), tmp = new Float64Array(p + 1);
  a[0] = 1;
  let e = r[0] * (1 + 1e-9) + 1e-30;
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    e *= 1 - k * k;
    if (e <= 0) break;
  }
  return a;
}

// Solves a small dense system M x = v (Gaussian elimination, partial pivoting).
function vpSolve(M, v, n) {
  const A = M.map(r => Float64Array.from(r)), b = Float64Array.from(v);
  for (let c = 0; c < n; c++) {
    let pr = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pr][c])) pr = r;
    [A[c], A[pr]] = [A[pr], A[c]]; [b[c], b[pr]] = [b[pr], b[c]];
    const d = A[c][c] || 1e-30;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / (A[r][r] || 1e-30);
  }
  return x;
}

// Discrete all-pole fit to powers pw at frequencies fr (Hz) in a model sampled at fs.
// Minimises the Itakura-Saito distance at those frequencies only. Returns { a, err }.
function vpDap(fr, pw, fs, p, iters = 20, lagBw = 0) {
  const lw = i => Math.exp(-0.5 * Math.pow(2 * Math.PI * lagBw * i / fs, 2));
  const M = fr.length, P1 = p + 1, cs = new Float64Array(M * P1), sn = new Float64Array(M * P1);
  for (let m = 0; m < M; m++) {
    const w = 2 * Math.PI * fr[m] / fs;
    for (let i = 0; i < P1; i++) { cs[m * P1 + i] = Math.cos(i * w); sn[m * P1 + i] = Math.sin(i * w); }
  }
  const R = new Float64Array(P1);
  for (let i = 0; i < P1; i++) { let s = 0; for (let m = 0; m < M; m++) s += pw[m] * cs[m * P1 + i]; R[i] = s / M * lw(i); }
  const Rm = [];
  for (let i = 0; i < P1; i++) { const row = new Float64Array(P1); for (let j = 0; j < P1; j++) row[j] = R[Math.abs(i - j)]; Rm.push(row); }
  const Ar = new Float64Array(M), Ai = new Float64Array(M);
  const evalA = a => {
    for (let m = 0; m < M; m++) {
      let r = 0, q = 0;
      for (let k = 0; k < P1; k++) { r += a[k] * cs[m * P1 + k]; q -= a[k] * sn[m * P1 + k]; }
      Ar[m] = r; Ai[m] = q;
    }
  };
  const isErr = () => {
    let g = 0;
    for (let m = 0; m < M; m++) g += pw[m] * (Ar[m] * Ar[m] + Ai[m] * Ai[m]);
    g /= M;
    let e = 0;
    for (let m = 0; m < M; m++) { const r = pw[m] * (Ar[m] * Ar[m] + Ai[m] * Ai[m]) / g; e += r - Math.log(r + 1e-300) - 1; }
    return e / M;
  };
  let a = vpLevinson(R, p);
  evalA(a);
  let best = { a, err: isErr() };
  const h = new Float64Array(P1);
  for (let it = 0; it < iters; it++) {
    // the model's impulse response as seen through the discrete frequencies, at lags 0..-p
    for (let i = 0; i < P1; i++) {
      let s = 0;
      for (let m = 0; m < M; m++) {
        const d = Ar[m] * Ar[m] + Ai[m] * Ai[m], hr = Ar[m] / d, hi = -Ai[m] / d;
        s += hr * cs[m * P1 + i] + hi * sn[m * P1 + i];
      }
      h[i] = s / M * lw(i);
    }
    const b = vpSolve(Rm, h, P1);
    if (!(Math.abs(b[0]) > 0)) break;
    a = b.map(v => v / b[0]);
    evalA(a);
    const err = isErr();
    if (!isFinite(err)) break;
    const gain = best.err - err;
    if (err < best.err) best = { a, err };
    if (Math.abs(gain) < 1e-5 * best.err) break;
  }
  return best;
}

// Roots of z^p + a1 z^(p-1) + ... + ap (Durand-Kerner). Returns [{ re, im }].
function vpRoots(a) {
  const n = a.length - 1, zr = new Float64Array(n), zi = new Float64Array(n);
  for (let i = 0; i < n; i++) { const ang = 2 * Math.PI * (i + 0.25) / n + 0.4; zr[i] = 0.9 * Math.cos(ang); zi[i] = 0.9 * Math.sin(ang); }
  for (let it = 0; it < 500; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let pr = 1, pi = 0;
      for (let k = 1; k <= n; k++) { const r = pr * zr[i] - pi * zi[i] + a[k], q = pr * zi[i] + pi * zr[i]; pr = r; pi = q; }
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const ur = zr[i] - zr[j], ui = zi[i] - zi[j], r = dr * ur - di * ui;
        di = dr * ui + di * ur; dr = r;
      }
      const dd = dr * dr + di * di || 1e-300, qr = (pr * dr + pi * di) / dd, qi = (pi * dr - pr * di) / dd;
      zr[i] -= qr; zi[i] -= qi;
      moved = Math.max(moved, Math.abs(qr) + Math.abs(qi));
    }
    if (moved < 1e-12) break;
  }
  return Array.from(zr, (r, i) => ({ re: r, im: zi[i] }));
}

// Resonances of an all-pole polynomial: [{ f, bw }] sorted by frequency (positive half only).
function vpPoles(a, fs) {
  return vpRoots(a).filter(z => z.im > 1e-9).map(z => ({
    f: Math.atan2(z.im, z.re) * fs / (2 * Math.PI),
    bw: -Math.log(Math.hypot(z.re, z.im)) * fs / Math.PI,
  })).filter(c => c.bw > 0 && c.f > 90 && c.f < fs / 2 - 100).sort((x, y) => x.f - y.f);
}

// Picks F1..F5 from candidate resonances: increasing order, each inside its slot's range,
// as many slots filled as possible, narrow resonances preferred. Missing slots are null.
// Bandwidths under 20 Hz are not vocal tract resonances: they are spare model poles parked
// between harmonics, where the data cannot see them.
function vpPickFormants(cands) {
  const c = cands.filter(q => q.bw >= 20 && q.bw < 700);
  let best = { score: -Infinity, pick: [] };
  const go = (slot, from, score, pick, last) => {
    if (slot === 5) { if (score > best.score) best = { score, pick: pick.slice() }; return; }
    go(slot + 1, from, score, pick.concat([null]), last);
    const [lo, hi] = VP_SLOTS[slot];
    for (let i = from; i < c.length; i++) {
      const q = c[i];
      if (q.f > hi) break;
      if (q.f < lo || q.f < last + 120) continue;
      go(slot + 1, i + 1, score + 1 - q.bw / 1500, pick.concat([q]), q.f);
    }
  };
  go(0, 0, 0, [], 0);
  return best.pick;
}

// Magnitude (dB) at f of the vocal tract made of the given formants and antiformants
// (analog two-pole resonators / zeros with unity gain at 0 Hz).
function vpTractDb(f, formants, anti) {
  const one = (F, B) => {
    const s1r = -Math.PI * B, s1i = 2 * Math.PI * F, w = 2 * Math.PI * f;
    return (s1r * s1r + s1i * s1i) / (Math.hypot(s1r, w - s1i) * Math.hypot(s1r, w + s1i));
  };
  let db = 0;
  for (const q of formants || []) if (q && q.f > 0) db += 20 * Math.log10(one(q.f, q.bw));
  for (const q of anti || []) if (q && q.f > 0) db -= 20 * Math.log10(one(q.f, q.bw));
  return db;
}

// |B|^2 of a digital zero pair (unity gain at 0 Hz) at frequency f (Hz) in a model at fs.
function vpZeroPow(F, BW, fs, f) {
  const r = Math.exp(-Math.PI * BW / fs), th = 2 * Math.PI * F / fs, w = 2 * Math.PI * f / fs;
  const b1 = -2 * r * Math.cos(th), b2 = r * r, g = 1 + b1 + b2;
  const re = 1 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), im = -b1 * Math.sin(w) - b2 * Math.sin(2 * w);
  return (re * re + im * im) / (g * g);
}

// Rosenberg glottal-flow-derivative power at harmonics 1..K for an open quotient (opening 65 %
// of the open phase). Depends only on the harmonic number, so it is cached per open quotient.
const vpSrcCache = new Map();
function vpSourcePow(oq, K) {
  const key = Math.round(oq * 100);
  let t = vpSrcCache.get(key);
  if (t && t.length >= K) return t;
  const n = 4096, q = key / 100, tp = 0.65 * q, tn = 0.35 * q, g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    g[i] = u < tp ? 0.5 * (1 - Math.cos(Math.PI * u / tp)) : u < tp + tn ? Math.cos(0.5 * Math.PI * (u - tp) / tn) : 0;
  }
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(g);
  fft(re, im);
  t = new Float64Array(Math.max(K, 256));
  for (let k = 1; k <= t.length; k++) t[k - 1] = k * k * (re[k] * re[k] + im[k] * im[k]) / (n * n);
  vpSrcCache.set(key, t);
  return t;
}

// Formants for a given open quotient: harmonic powers divided by the source pulse (which also
// carries the lip radiation) and by any zeros, then DAP at 16 kHz on the data below 5.4 kHz
// (the model is free above, so the steep fall past F5 costs nothing).
// Returns { formants: [5 x {f,bw}|null], err } or null with too few harmonics.
function vpFitAt(fr, pw, oq, anti, iters) {
  const keep = [];
  for (let i = 0; i < fr.length; i++) if (fr[i] < VP_DATA_MAX && pw[i] > 0) keep.push(i);
  if (keep.length < 8) return null;
  const src = vpSourcePow(oq, keep[keep.length - 1] + 1);
  const f = keep.map(i => fr[i]), p = keep.map(i => {
    let v = pw[i] / src[i];
    for (const z of anti || []) v /= vpZeroPow(z.f, z.bw, VP_MODEL_SR, fr[i]);
    return v;
  });
  const order = Math.max(6, Math.min(VP_ORDER, f.length - 4));
  // a real voice is not exactly pulse x all-pole; the spare poles then can park as needle-sharp
  // peaks between harmonics. Only then refit with a lag window (smooths the model by 30, then
  // 60 Hz), which a clean fit never needs and which would widen and shift its formants.
  let fit, poles;
  for (const lag of [0, 30, 60]) {
    fit = vpDap(f, p, VP_MODEL_SR, order, iters, lag);
    poles = vpPoles(fit.a, VP_MODEL_SR);
    if (!poles.some(q => q.bw < 20 && q.f < VP_DATA_MAX)) break;
  }
  return { formants: vpPickFormants(poles), err: fit.err };
}

// Formants from harmonic powers pw at harmonic frequencies fr (harmonic k at index k-1), with the
// open quotient chosen as the one whose source pulse leaves the most all-pole-like remainder
// (0.05 steps, then 0.01). oq given: use it. Returns { formants, err, oq } or null.
function vpFormantFit(fr, pw, anti, oq) {
  if (oq != null) { const r = vpFitAt(fr, pw, oq, anti, 25); return r && Object.assign(r, { oq }); }
  let best = null;
  for (let q = 0.3; q <= 0.951; q += 0.05) {
    const r = vpFitAt(fr, pw, q, anti, 15);
    if (r && (!best || r.err < best.err)) best = Object.assign(r, { oq: q });
  }
  if (!best) return null;
  const q0 = best.oq;
  for (let q = Math.max(0.25, q0 - 0.04); q <= Math.min(0.95, q0 + 0.04) + 1e-9; q += 0.01) {
    const r = vpFitAt(fr, pw, q, anti, 25);
    if (r && r.err < best.err) best = Object.assign(r, { oq: q });
  }
  best.oq = Math.round(best.oq * 100) / 100;
  return best;
}

// Nasal zero search at a given open quotient: the antiformant (400-4000 Hz) whose removal lets the
// all-pole model fit best. Returns [{ f, bw }] or [] when no zero improves the fit clearly.
function vpAntiformants(fr, pw, oq) {
  const base = vpFitAt(fr, pw, oq, null, 15);
  if (!base) return [];
  let best = { err: base.err, z: null };
  for (let F = 400; F <= 4000; F *= 1.025) {
    for (const BW of [60, 150, 350]) {
      const r = vpFitAt(fr, pw, oq, [{ f: F, bw: BW }], 8);
      if (r && r.err < best.err) best = { err: r.err, z: { f: F, bw: BW } };
    }
  }
  if (!best.z) return [];
  const z0 = best.z;
  for (let F = z0.f * 0.95; F <= z0.f * 1.05; F *= 1.004) {
    for (const BW of [30, 45, 60, 90, 130, 180, 250, 350, 500]) {
      const r = vpFitAt(fr, pw, oq, [{ f: F, bw: BW }], 15);
      if (r && r.err < best.err) best = { err: r.err, z: { f: F, bw: BW } };
    }
  }
  // a clear gain, and not at the edge of the search (a 500 Hz wide zero is a slope, not a dip)
  if (best.err > 0.7 * base.err || best.z.bw >= 500) return [];
  return [{ f: Math.round(best.z.f), bw: Math.round(best.z.bw) }];
}

// ---------- envelope, source ----------

// Harmonic levels (dB) at frequencies fr -> the 96-bin grid: straight lines in dB over log
// frequency, held below the first harmonic, -12 dB/oct above the last; loudest bin at 0 dB.
function vpEnvelope(fr, db) {
  const px = [], py = [];
  for (let i = 0; i < fr.length; i++) {
    if (!(fr[i] > 0) || !isFinite(db[i])) continue;
    const x = VP_PER_OCT * Math.log2(fr[i] / VP_LO);
    if (px.length && x <= px[px.length - 1]) continue;
    px.push(x); py.push(db[i]);
  }
  const env = new Array(VP_BINS).fill(0);
  if (px.length < 2) return env;
  const last = px.length - 1;
  let j = 0, top = -Infinity;
  for (let b = 0; b < VP_BINS; b++) {
    let v;
    if (b <= px[0]) v = py[0];
    else if (b >= px[last]) v = py[last] - (b - px[last]);
    else { while (px[j + 1] < b) j++; v = py[j] + (py[j + 1] - py[j]) * (b - px[j]) / (px[j + 1] - px[j]); }
    env[b] = v;
    if (v > top) top = v;
  }
  return env.map(v => +Math.max(-100, v - top).toFixed(2));
}

// H1-H2 of a Rosenberg glottal-flow-derivative pulse for open quotients 0.25..0.95
// (opening 65 % of the open phase), used to read the open quotient off a measured H1*-H2*.
const VP_OQ_TABLE = (() => {
  const out = [], n = 2048;
  for (let oq = 0.25; oq <= 0.951; oq += 0.01) {
    const tp = 0.65 * oq, tn = 0.35 * oq;
    let r1 = 0, i1 = 0, r2 = 0, i2 = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const g = u < tp ? 0.5 * (1 - Math.cos(Math.PI * u / tp)) : u < tp + tn ? Math.cos(0.5 * Math.PI * (u - tp) / tn) : 0;
      r1 += g * Math.cos(2 * Math.PI * u); i1 += g * Math.sin(2 * Math.PI * u);
      r2 += g * Math.cos(4 * Math.PI * u); i2 += g * Math.sin(4 * Math.PI * u);
    }
    // derivative: harmonic k scales by k
    out.push([oq, 20 * Math.log10(Math.hypot(r1, i1) / (2 * Math.hypot(r2, i2)))]);
  }
  return out;
})();

function vpOqFromH1H2(d) {
  const t = VP_OQ_TABLE;
  if (!isFinite(d)) return null;
  if (d <= t[0][1]) return t[0][0];
  for (let i = 1; i < t.length; i++) {
    if (d <= t[i][1]) return t[i - 1][0] + (t[i][0] - t[i - 1][0]) * (d - t[i - 1][1]) / (t[i][1] - t[i - 1][1]);
  }
  return t[t.length - 1][0];
}

// ---------- the plain LPC path (for unvoiced sounds) ----------

// Formants by autocorrelation LPC on a ~11 kHz copy: pre-emphasis, 25 ms Hamming frames,
// order sr/1000 + 4, median per slot over frames.
function vpLpcFormants(x, sr) {
  const D = Math.max(1, Math.round(sr / 11000)), y = vpDecimate(x, D), fs = sr / D;
  const L = Math.round(0.025 * fs), hop = Math.round(0.01 * fs), p = Math.round(fs / 1000) + 4;
  const slots = [[], [], [], [], []], fr = new Float64Array(L);
  for (let s = 1; s + L <= y.length; s += hop) {
    for (let i = 0; i < L; i++) fr[i] = (y[s + i] - 0.97 * y[s + i - 1]) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (L - 1)));
    const r = new Float64Array(p + 1);
    for (let k = 0; k <= p; k++) { let a = 0; for (let i = k; i < L; i++) a += fr[i] * fr[i - k]; r[k] = a; }
    if (!(r[0] > 1e-12)) continue;
    vpPickFormants(vpPoles(vpLevinson(r, p), fs)).forEach((q, i) => { if (q) slots[i].push(q); });
  }
  return slots.map(sl => sl.length ? { f: vpMedian(sl.map(q => q.f)), bw: vpMedian(sl.map(q => q.bw)) } : null);
}

// Missing formant slots get a typical value placed between their neighbours (flag guessed: true).
function vpFillFormants(fm) {
  return fm.map((q, i) => {
    if (q) return { f: Math.round(q.f), bw: Math.round(q.bw) };
    const prev = fm.slice(0, i).reverse().find(Boolean), next = fm.slice(i + 1).find(Boolean);
    let f = VP_TYPICAL[i][0];
    if (prev && f < prev.f + 300) f = prev.f + 600;
    if (next && f > next.f - 300) f = prev ? (prev.f + next.f) / 2 : next.f * 0.6;
    return { f: Math.round(f), bw: VP_TYPICAL[i][1], guessed: true };
  });
}

// ---------- one unit ----------

// One profile entry from one unit. samples: Float32Array at sr; t0: the session time of
// samples[0] (default unit.start, i.e. samples hold just this unit; pass 0 with the whole
// recording). Measures on [steadyStart, steadyEnd] (falls back to the middle 80 %).
function analyseUnit(samples, sr, unit, t0) {
  unit = unit || {};
  if (t0 == null) t0 = unit.start != null ? unit.start : 0;
  const total = samples.length / sr;
  const uStart = Math.max(0, (unit.start != null ? unit.start : t0) - t0), uEnd = Math.min(total, (unit.end != null ? unit.end : t0 + total) - t0);
  let sS = unit.steadyStart != null ? unit.steadyStart - t0 : uStart + 0.1 * (uEnd - uStart);
  let sE = unit.steadyEnd != null ? unit.steadyEnd - t0 : uEnd - 0.1 * (uEnd - uStart);
  sS = Math.max(0, sS); sE = Math.min(total, sE);
  const glide = unit.kind === 'glide' || (unit.sound || '').includes('>');
  const nasal = unit.kind === 'nasal' || ['mm', 'nn', 'ng'].includes(unit.sound);
  const i0 = Math.round(sS * sr), i1 = Math.round(sE * sr);
  const entry = { id: unit.id, midi: unit.midi, loud: unit.loud };

  // level of the steady part
  let ss = 0;
  for (let i = i0; i < i1; i++) ss += samples[i] * samples[i];
  entry.levelDb = +vpDb(ss / Math.max(1, i1 - i0)).toFixed(1);

  // pitch over the whole unit (onset scoop needs the part before the steady one)
  const D = Math.max(1, Math.round(sr / 11000)), a0 = Math.round(uStart * sr), a1 = Math.round(uEnd * sr);
  const yin = vpYin(vpDecimate(samples.subarray(a0, a1), D), sr / D);
  const yt = Array.from(yin.t, t => t + uStart), yf = yin.f0;
  const steadyIdx = [];
  for (let i = 0; i < yt.length; i++) if (yt[i] >= sS && yt[i] <= sE) steadyIdx.push(i);
  const voiced = steadyIdx.filter(i => yf[i] > 0);
  const voicedFrac = steadyIdx.length ? voiced.length / steadyIdx.length : 0;

  if (voicedFrac < 0.4 || voiced.length < 10) return vpUnvoicedEntry(entry, samples.subarray(i0, i1), sr);

  const f0Med = vpMedian(voiced.map(i => yf[i]));
  // the pitch track, octave slips removed and gaps bridged
  const vt = [], vf = [];
  for (const i of voiced) if (Math.abs(1200 * Math.log2(yf[i] / f0Med)) < 300) { vt.push(yt[i]); vf.push(yf[i]); }
  const yinAt = s => vpTrackAt(vt, vf, s / sr);

  // cycles, jitter, shimmer
  const cyc = vpCycles(samples, sr, yinAt, i0, i1);
  entry.jitter = +vpPerturb(cyc, 'T').toFixed(5);
  entry.shimmer = +vpPerturb(cyc, 'A').toFixed(4);
  const good = cyc.filter(c => c.ok);
  entry.f0 = +(good.length > 10 ? vpMedian(good.map(c => sr / c.T)) : f0Med).toFixed(2);
  if (entry.midi == null) entry.midi = +hzToMidi(entry.f0).toFixed(2);
  entry.vibrato = vpVibrato(Float64Array.from(vt), Float64Array.from(vf));

  // a smooth pitch curve from the cycles (5-cycle average: vibrato kept, jitter left in the signal)
  let warpAt = yinAt;
  if (good.length > 20) {
    const ct = [], cf = [];
    for (let i = 0; i < good.length; i++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(good.length - 1, i + 2); j++) { s += good[j].T; n++; }
      ct.push((good[i].pos + good[i].T / 2) / sr); cf.push(sr * n / s);
    }
    warpAt = s => vpTrackAt(ct, cf, s / sr);
  }

  // onset: pitch at the start of the sound against the steady pitch
  entry.onset = vpOnset(yt, yf, uStart, sS, entry.f0);

  // steady part at constant pitch -> harmonic levels, noise between harmonics
  const w = vpWarp(samples, sr, warpAt, i0, i1);
  const fmax = Math.min(11000, 0.45 * sr);
  const nPer = Math.min(16, Math.max(6, Math.floor((i1 - i0) / sr * w.fbar / 2)));
  const hm = vpHarmonics(w.y, sr, w.fbar, nPer, nPer / 2, fmax, 0.25, 'mean');
  const fr = Array.from({ length: hm.K }, (_, k) => (k + 1) * w.fbar);

  // aperiodicity per band: noise share of each band's energy
  entry.aperiodicity = [];
  for (let b = 0; b < 5; b++) {
    let tot = 0, nz = 0;
    for (let k = 0; k < hm.K; k++) if (fr[k] >= VP_BANDS[b] && fr[k] < VP_BANDS[b + 1]) { tot += hm.C[k]; nz += hm.Nc[k]; }
    entry.aperiodicity.push(tot > 0 ? +Math.min(1, Math.max(0, nz / tot)).toFixed(4) : 1);
  }

  // formants, source open quotient (and the nasal zero) from the harmonic levels
  const H = Array.from(hm.H);
  let ff = vpFormantFit(fr, H, null);
  entry.antiformants = nasal && ff ? vpAntiformants(fr, H, ff.oq) : [];
  if (entry.antiformants.length) ff = vpFormantFit(fr, H, entry.antiformants);
  entry.formants = vpFillFormants(ff ? ff.formants : vpLpcFormants(samples.subarray(i0, i1), sr));

  // envelope
  entry.env = vpEnvelope(fr, Array.from(hm.H, vpDb));

  // source: formant-corrected H1-H2, tilt of the formant-free harmonics (each harmonic weighted
  // 1/k so every octave counts the same), open quotient from the source fit above
  const clean = Array.from(hm.H, (h, k) => Math.max(h - hm.Nh[k], 1e-3 * h));
  const corr = k => vpDb(clean[k]) - vpTractDb(fr[k], entry.formants, entry.antiformants);
  const h1h2 = hm.K >= 2 ? corr(0) - corr(1) : NaN;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let k = 0; k < hm.K && fr[k] <= 5000; k++) {
    if (hm.H[k] < 2 * hm.Nh[k]) continue;
    const x = Math.log2(fr[k]), y = corr(k), wk = 1 / (k + 1);
    sx += wk * x; sy += wk * y; sxx += wk * x * x; sxy += wk * x * y; n += wk;
  }
  const tilt = n > 0.5 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : NaN;
  entry.source = {
    tilt: isFinite(tilt) ? +tilt.toFixed(2) : null,
    h1h2: isFinite(h1h2) ? +h1h2.toFixed(2) : null,
    oq: ff ? ff.oq : isFinite(h1h2) ? +vpOqFromH1H2(h1h2).toFixed(2) : null,
    oqH1H2: isFinite(h1h2) ? +vpOqFromH1H2(h1h2).toFixed(2) : null,
  };

  // glides: formant trajectory over the voiced part of the whole unit
  if (glide) entry.trajectory = vpTrajectory(samples, sr, vt, vf, uStart, uEnd, t0, unit, ff ? ff.oq : 0.6);
  if (glide && entry.trajectory.length) {
    entry.formants = vpFillFormants([0, 1, 2, 3, 4].map(s => {
      const v = entry.trajectory.map(p => p.formants[s]).filter(q => q && !q.guessed);
      return v.length ? { f: vpMedian(v.map(q => q.f)), bw: vpMedian(v.map(q => q.bw)) } : null;
    }));
  }
  entry.quality = { voiced: +voicedFrac.toFixed(2), cycles: good.length, frames: hm.frames, fbar: +w.fbar.toFixed(2) };
  return entry;
}

// Onset scoop: pitch (cents vs the steady pitch) over the first 20 ms of voice, and how long until
// it settles within 25 cents. Null when the unit's samples do not include the voice onset.
function vpOnset(yt, yf, uStart, sS, f0) {
  let i = 0;
  while (i + 3 < yt.length && !(yf[i] > 0 && yf[i + 1] > 0 && yf[i + 2] > 0)) i++;
  if (i + 3 >= yt.length || yt[i] >= sS || yt[i] - uStart < 0.005) return null;
  const c = j => 1200 * Math.log2(yf[j] / f0);
  const first = [];
  for (let j = i; j < Math.min(yt.length, i + 4); j++) if (yf[j] > 0) first.push(c(j));
  let k = i;
  while (k + 2 < yt.length && !(yf[k] > 0 && Math.abs(c(k)) < 25 && Math.abs(c(k + 1)) < 25 && Math.abs(c(k + 2)) < 25)) k++;
  return { cents: Math.round(vpMedian(first)), ms: Math.round(1000 * (yt[k] - yt[i])) };
}

// Formant trajectory of a glide: frames of ~6 periods every 20 ms on the pitch-flattened voiced
// part, DAP per frame (source pulse at the unit's open quotient), then a 5-frame median per
// formant. t is seconds from unit.start.
function vpTrajectory(samples, sr, vt, vf, uStart, uEnd, t0, unit, oq) {
  if (vt.length < 10) return [];
  const a = Math.max(Math.round(uStart * sr), Math.round(vt[0] * sr)), b = Math.min(Math.round(uEnd * sr), Math.round(vt[vt.length - 1] * sr));
  if (b - a < 0.2 * sr) return [];
  const w = vpWarp(samples, sr, s => vpTrackAt(vt, vf, s / sr), a, b);
  const nPer = Math.max(6, Math.ceil(0.04 * w.fbar));
  const hf = vpHarmonics(w.y, sr, w.fbar, nPer, 0.02 * w.fbar, Math.min(6000, 0.45 * sr), 0.4, 'frames');
  const fr = Array.from({ length: hf.K }, (_, k) => (k + 1) * w.fbar);
  const raw = hf.frames.map(f => {
    const r = vpFitAt(fr, Array.from(f.H), oq, null, 15);
    const j = Math.min(w.orig.length - 1, Math.floor(f.c / 64)), o = w.orig[j] + (f.c - j * 64);
    return { t: o / sr + t0 - (unit.start != null ? unit.start : t0), formants: r ? r.formants : [null, null, null, null, null] };
  });
  return raw.map((p, i) => {
    const fm = [0, 1, 2, 3, 4].map(s => {
      const v = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(raw.length - 1, i + 2); j++) if (raw[j].formants[s]) v.push(raw[j].formants[s]);
      return v.length ? { f: vpMedian(v.map(q => q.f)), bw: vpMedian(v.map(q => q.bw)) } : null;
    });
    return { t: +p.t.toFixed(3), formants: vpFillFormants(fm) };
  });
}

// Entry for a sound without a usable pitch (whisper, fricative): LPC formants, envelope from the
// averaged spectrum, everything aperiodic.
function vpUnvoicedEntry(entry, x, sr) {
  const N = 4096, re = new Float64Array(N), im = new Float64Array(N), acc = new Float64Array(N / 2);
  let nf = 0;
  for (let s = 0; s + N <= x.length; s += N / 2) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < N / 2; b++) acc[b] += re[b] * re[b] + im[b] * im[b];
    nf++;
  }
  const fr = [], db = [];
  for (let b = 0; b < VP_BINS; b++) {
    const f = VP_LO * Math.pow(2, b / VP_PER_OCT), lo = Math.max(1, Math.floor(f * Math.pow(2, -1 / 24) * N / sr)), hi = Math.max(lo, Math.ceil(f * Math.pow(2, 1 / 24) * N / sr));
    if (hi >= N / 2) break;
    let s = 0;
    for (let k = lo; k <= hi; k++) s += acc[k];
    fr.push(f); db.push(vpDb(s / (hi - lo + 1) / Math.max(1, nf)));
  }
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  fr.forEach((f, i) => { if (f < 500 || f > 5000) return; const u = Math.log2(f); sx += u; sy += db[i]; sxx += u * u; sxy += u * db[i]; n++; });
  return Object.assign(entry, {
    voiced: false, f0: 0, jitter: 0, shimmer: 0, vibrato: { rate: 0, depth: 0 },
    formants: vpFillFormants(vpLpcFormants(x, sr)), antiformants: [],
    env: vpEnvelope(fr, db),
    source: { tilt: n > 3 ? +((n * sxy - sx * sy) / (n * sxx - sx * sx)).toFixed(2) : null, h1h2: null, oq: null },
    aperiodicity: [1, 1, 1, 1, 1], onset: null,
  });
}

// ---------- the profile ----------

// units: [{ unit (manifest entry), samples: Float32Array, sr, t0 }]. t0 is the session time of
// samples[0]: leave it out when samples hold just the unit (cut from unit.start), or pass 0 with
// the whole recording. opts = { sources: [names], range: { low, high }, made }.
function buildProfile(units, opts = {}) {
  const sounds = {}, all = [];
  for (const u of units || []) {
    const e = analyseUnit(u.samples, u.sr, u.unit, u.t0);
    // the synth (profilesynth.js) wants the source cues as heard on the recording, tract included;
    // store those next to the tract-free ones measured above
    if (typeof psAnalyse === 'function' && e.voiced !== false && e.source) {
      try {
        const t0 = u.t0 ?? u.unit.start;
        const a = psAnalyse(u.samples, u.sr, { range: [u.unit.steadyStart - t0, u.unit.steadyEnd - t0] });
        e.source.raw = { tilt: +a.tilt.toFixed(2), h1h2: +a.h1h2.toFixed(2) };
      } catch {}
    }
    const key = u.unit.sound;
    if (!sounds[key]) sounds[key] = { kind: u.unit.kind || 'vowel', entries: [] };
    sounds[key].entries.push(e);
    all.push(e);
  }
  for (const s of Object.values(sounds)) s.entries.sort((a, b) => (a.midi - b.midi) || (a.loud === 'soft' ? -1 : 1));
  const voicedE = all.filter(e => e.voiced !== false && e.f0 > 0);
  const vib = voicedE.filter(e => e.vibrato && e.vibrato.rate > 0), ons = voicedE.filter(e => e.onset);
  const mids = all.map(e => e.midi).filter(isFinite);
  const r = (a, d) => (a.length ? +vpMedian(a).toFixed(d) : 0);
  return {
    version: 1,
    kind: 'voice-profile',
    made: opts.made || new Date().toISOString(),
    sources: opts.sources || [],
    range: opts.range || (mids.length ? { low: Math.round(Math.min(...mids)), high: Math.round(Math.max(...mids)) } : null),
    sounds,
    habits: {
      vibratoRate: r(vib.map(e => e.vibrato.rate), 2),
      vibratoDepthCents: r(vib.map(e => e.vibrato.depth), 1),
      jitter: r(voicedE.map(e => e.jitter), 5),
      shimmer: r(voicedE.map(e => e.shimmer), 4),
      scoopCents: r(ons.map(e => e.onset.cents), 0),
      scoopMs: r(ons.map(e => e.onset.ms), 0),
    },
  };
}

// A whole lab session at once: manifest (contract section 1), its recording, the session name.
function profileFromSession(manifest, samples, name) {
  const sr = manifest.sr;
  const units = manifest.units.filter(u => !u.check || u.check.ok !== false).map(unit => ({ unit, samples, sr, t0: 0 }));
  return buildProfile(units, { sources: name ? [name] : [], range: manifest.range });
}

// Points for a vowel chart: [{ sound, midi, loud, f1, f2 }] (glides left out).
function vowelMap(profile) {
  const out = [];
  for (const [sound, s] of Object.entries((profile && profile.sounds) || {})) {
    if (s.kind === 'glide') continue;
    for (const e of s.entries) {
      if (!e.formants || !e.formants[0] || !e.formants[1]) continue;
      out.push({ sound, midi: e.midi, loud: e.loud, f1: e.formants[0].f, f2: e.formants[1].f });
    }
  }
  return out;
}
