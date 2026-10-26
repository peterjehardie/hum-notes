// Sings with a measured voice profile (docs/voice-lab-contract.md, sections 2 and 3), no neural nets.
// Two engines: 'envelope' feeds per-frame spectral envelopes from the profile to renderVoice
// (voicesynth.js); 'formant' is a Klatt-style formant synthesizer with an LF glottal source.
// closeness() scores how near a synthetic recording is to a real one (0..100).
// Pure number crunching, returns Float32Arrays. Load after dsp.js and voicesynth.js.

const PS_DEF_F = [500, 1500, 2500, 3500, 4500], PS_DEF_BW = [80, 100, 150, 200, 250];
const PS_BANDS = [500, 1500, 3000, 6000];          // aperiodicity band edges (Hz)
const PS_G = 0.15;                                  // harmonic amplitude at the envelope peak for amp 1 (as voicesynth)
const PS_REF_SR = 48000;                            // pole radii are blended at this rate
const psClamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const psGridHz = b => VS_LO * Math.pow(2, b / VS_PER_OCT);
const psLerp = (a, b, t) => a + (b - a) * t;

// ---------- profile entries ----------

// An entry in a fixed internal shape: numeric loudness, Float32Array envelope, defaults filled.
function psNormEntry(e) {
  const loud = e.loud === 'soft' ? 0 : e.loud === 'loud' ? 1 : isFinite(e.loud) ? +e.loud : 0.5;
  const midi = isFinite(e.midi) ? +e.midi : e.f0 > 0 ? hzToMidi(e.f0) : 50;
  const src = e.source || {};
  return {
    midi, loud,
    levelDb: isFinite(e.levelDb) ? e.levelDb : null,
    formants: (e.formants || []).filter(f => f && f.f > 0).map(f => ({ f: +f.f, bw: f.bw > 0 ? +f.bw : 100 })),
    antiformants: (e.antiformants || []).filter(f => f && f.f > 0).map(f => ({ f: +f.f, bw: f.bw > 0 ? +f.bw : 150 })),
    env: e.env && e.env.length >= VS_BINS ? Float32Array.from(e.env.slice(0, VS_BINS)) : null,
    // raw = measured on the recording itself (tract included), which is what this engine expects
    source: {
      tilt: src.raw && isFinite(src.raw.tilt) ? src.raw.tilt : isFinite(src.tilt) ? src.tilt : null,
      h1h2: src.raw && isFinite(src.raw.h1h2) ? src.raw.h1h2 : isFinite(src.h1h2) ? src.h1h2 : null,
      oq: isFinite(src.oq) ? src.oq : null,
    },
    aperiodicity: e.aperiodicity && e.aperiodicity.length >= 5 ? Array.from(e.aperiodicity.slice(0, 5), v => psClamp(+v || 0, 0, 0.98)) : null,
    jitter: isFinite(e.jitter) ? e.jitter : null,
    shimmer: isFinite(e.shimmer) ? e.shimmer : null,
    vibrato: e.vibrato || null,
    frication: isFinite(e.frication) ? e.frication : 0,
    trajectory: e.trajectory || null,
  };
}

const psEntryCache = new WeakMap();
function psEntriesOf(snd) {
  let list = psEntryCache.get(snd);
  if (!list) { list = (snd.entries || []).map(psNormEntry); psEntryCache.set(snd, list); }
  return list;
}

// Weighted blend of entries ([{ e, w }]): envelopes in dB, formant frequencies and bandwidths in
// log, source values linearly. Antiformants blend their pole radius, so an entry without one
// counts as radius 0 (no notch) and nasality fades in smoothly.
function psBlend(list) {
  list = list.filter(x => x.w > 1e-9);
  if (list.length === 1) return list[0].e;
  const lin = get => {
    let s = 0, w = 0;
    for (const { e, w: wt } of list) { const v = get(e); if (v != null && isFinite(v)) { s += wt * v; w += wt; } }
    return w ? s / w : null;
  };
  const nF = Math.max(...list.map(x => x.e.formants.length));
  const formants = [];
  for (let i = 0; i < nF; i++) {
    let lf = 0, lb = 0, w = 0;
    for (const { e, w: wt } of list) { const f = e.formants[i]; if (f) { lf += wt * Math.log(f.f); lb += wt * Math.log(f.bw); w += wt; } }
    formants.push({ f: Math.exp(lf / w), bw: Math.exp(lb / w) });
  }
  const nA = Math.max(...list.map(x => x.e.antiformants.length));
  const antiformants = [];
  for (let i = 0; i < nA; i++) {
    let lf = 0, w = 0, r = 0;
    for (const { e, w: wt } of list) {
      const a = e.antiformants[i];
      if (a) { lf += wt * Math.log(a.f); w += wt; r += wt * Math.exp(-Math.PI * a.bw / PS_REF_SR); }
    }
    antiformants.push({ f: Math.exp(lf / w), bw: r > 1e-6 ? -Math.log(r) * PS_REF_SR / Math.PI : Infinity });
  }
  let env = null;
  const withEnv = list.filter(x => x.e.env);
  if (withEnv.length) {
    env = new Float32Array(VS_BINS);
    const ws = withEnv.reduce((s, x) => s + x.w, 0);
    for (const { e, w } of withEnv) for (let b = 0; b < VS_BINS; b++) env[b] += e.env[b] * w / ws;
  }
  let ap = null;
  if (list.some(x => x.e.aperiodicity)) ap = [0, 1, 2, 3, 4].map(b => lin(e => e.aperiodicity ? e.aperiodicity[b] : null));
  const top = list.reduce((a, x) => x.w > a.w ? x : a);
  return {
    midi: lin(e => e.midi), loud: lin(e => e.loud), levelDb: lin(e => e.levelDb),
    formants, antiformants, env,
    source: { tilt: lin(e => e.source.tilt), h1h2: lin(e => e.source.h1h2), oq: lin(e => e.source.oq) },
    aperiodicity: ap, jitter: lin(e => e.jitter), shimmer: lin(e => e.shimmer),
    vibrato: top.e.vibrato, frication: lin(e => e.frication) || 0, trajectory: top.e.trajectory,
  };
}

// Bilinear weights over one sound's entries: loudness groups bracketing `loud`, then within each
// group the measured pitches bracketing `midi`. Outside the measured range the edge is held.
function psEntryAt(snd, midi, loud) {
  const all = psEntriesOf(snd);
  if (!all.length) throw new Error('profile sound has no entries');
  const louds = [...new Set(all.map(e => e.loud))].sort((a, b) => a - b);
  const bracket = (vals, v) => {
    if (v <= vals[0]) return [[vals[0], 1]];
    const last = vals[vals.length - 1];
    if (v >= last) return [[last, 1]];
    let i = 0;
    while (vals[i + 1] < v) i++;
    const t = (v - vals[i]) / (vals[i + 1] - vals[i]);
    return [[vals[i], 1 - t], [vals[i + 1], t]];
  };
  const list = [];
  for (const [lv, wl] of bracket(louds, loud)) {
    const group = all.filter(e => e.loud === lv);
    const mids = [...new Set(group.map(e => e.midi))].sort((a, b) => a - b);
    for (const [mv, wm] of bracket(mids, midi)) {
      const same = group.filter(e => e.midi === mv);
      for (const e of same) list.push({ e, w: wl * wm / same.length });
    }
  }
  return psBlend(list);
}

// Envelope moved along log-frequency so its peaks at `from` (Hz) land at `to` (Hz): a piecewise
// linear warp between those anchors, fixed at both ends of the grid.
function psWarpEnv(env, from, to) {
  const tx = [0], sx = [0], top = VS_BINS - 1;
  for (let i = 0; i < Math.min(from.length, to.length); i++) {
    const t = vsPos(to[i]), s = vsPos(from[i]);
    if (t > tx[tx.length - 1] + 0.5 && s > sx[sx.length - 1] + 0.5 && t < top - 0.5 && s < top - 0.5) { tx.push(t); sx.push(s); }
  }
  tx.push(top); sx.push(top);
  const out = new Float32Array(VS_BINS);
  let j = 0;
  for (let b = 0; b < VS_BINS; b++) {
    while (j < tx.length - 2 && tx[j + 1] < b) j++;
    const u = (b - tx[j]) / (tx[j + 1] - tx[j]);
    out[b] = vsEnvAt(env, sx[j] + u * (sx[j + 1] - sx[j]));
  }
  return out;
}

const psAnchors = (fs, n) => fs.slice(0, n).map(f => f.f);

// Morph between two entries (m = 0 -> a, 1 -> b): formants glide in log-frequency and each
// envelope is warped so its formant peaks travel with them, then blended in dB.
function psMorph(a, b, m) {
  if (m <= 0) return a;
  if (m >= 1) return b;
  const mix = psBlend([{ e: a, w: 1 - m }, { e: b, w: m }]);
  const n = Math.min(4, a.formants.length, b.formants.length);
  if (a.env && b.env && n) {
    const mid = psAnchors(mix.formants, n);
    const wa = psWarpEnv(a.env, psAnchors(a.formants, n), mid), wb = psWarpEnv(b.env, psAnchors(b.formants, n), mid);
    const env = new Float32Array(VS_BINS);
    for (let i = 0; i < VS_BINS; i++) env[i] = (1 - m) * wa[i] + m * wb[i];
    mix.env = env;
  }
  return mix;
}

// A measured glide's path at position m (0..1). Assumed shape, either on the glide sound or on
// its entries: trajectory = [{ pos: 0..1 (or t in seconds), formants: [{ f, bw }], env?: [96] }].
function psTrajAt(tr, m) {
  const n = tr.length;
  const t0 = tr[0].t, t1 = tr[n - 1].t;
  const pos = tr.map((p, i) => isFinite(p.pos) ? p.pos : isFinite(p.t) && t1 > t0 ? (p.t - t0) / (t1 - t0) : n > 1 ? i / (n - 1) : 0);
  let i = 0;
  while (i < n - 2 && pos[i + 1] < m) i++;
  const j = Math.min(n - 1, i + 1), u = j > i ? psClamp((m - pos[i]) / (pos[j] - pos[i] || 1), 0, 1) : 0;
  const A = tr[i], B = tr[j];
  const formants = [];
  for (let k = 0; k < Math.max(A.formants.length, B.formants.length); k++) {
    const fa = A.formants[k] || B.formants[k], fb = B.formants[k] || A.formants[k];
    formants.push({ f: Math.exp(psLerp(Math.log(fa.f), Math.log(fb.f), u)), bw: Math.exp(psLerp(Math.log(fa.bw || 100), Math.log(fb.bw || 100), u)) });
  }
  let env = null;
  if (A.env && B.env) { env = new Float32Array(VS_BINS); for (let b = 0; b < VS_BINS; b++) env[b] = psLerp(A.env[b], B.env[b], u); }
  return { formants, env };
}

// One sound at a pitch and loudness: a plain sound ('ah'), or a morph 'a>b' at position `morph`
// (the measured glide's trajectory when the profile has one, else a morph of a and b).
function psSoundAt(profile, name, midi, loud, morph) {
  const sounds = profile.sounds || {};
  if (name.indexOf('>') < 0) {
    if (!sounds[name]) throw new Error('profile has no sound "' + name + '"');
    return psEntryAt(sounds[name], midi, loud);
  }
  const [na, nb] = name.split('>'), m = psClamp(morph == null ? 0.5 : morph, 0, 1);
  let base = sounds[na] && sounds[nb] ? psMorph(psEntryAt(sounds[na], midi, loud), psEntryAt(sounds[nb], midi, loud), m) : null;
  if (sounds[name]) {
    const g = psEntryAt(sounds[name], midi, loud), tr = g.trajectory || sounds[name].trajectory;
    if (!base) base = g;
    if (tr && tr.length) {
      const p = psTrajAt(tr, m), out = Object.assign({}, base);
      out.formants = p.formants.map((f, i) => f || base.formants[i]);
      for (let i = p.formants.length; i < base.formants.length; i++) out.formants.push(base.formants[i]);
      const n = Math.min(4, base.formants.length, out.formants.length);
      out.env = p.env ? p.env : base.env && n ? psWarpEnv(base.env, psAnchors(base.formants, n), psAnchors(out.formants, n)) : base.env;
      return out;
    }
  }
  if (!base) throw new Error('profile has no sound "' + name + '" (nor both of its ends)');
  return base;
}

// Loudest measured level in the profile (dB), the reference for renderVowel's gain.
function psTopLevel(profile) {
  let top = -Infinity;
  for (const k in profile.sounds || {}) for (const e of psEntriesOf(profile.sounds[k])) if (e.levelDb != null && e.levelDb > top) top = e.levelDb;
  return top;
}

// ---------- shared filter maths ----------

// Two-pole resonator with unity gain at DC: y = a x + b y1 + c y2.
function psResCoef(f, bw, sr) {
  if (!(f > 0) || f >= 0.48 * sr || !isFinite(bw)) return [1, 0, 0];
  const r = Math.exp(-Math.PI * bw / sr), b = 2 * r * Math.cos(2 * Math.PI * f / sr), c = -r * r;
  return [1 - b - c, b, c];
}

// Gain (dB) at f of a resonator given as its coefficients.
function psResDb(a, b, c, w) {
  const re = 1 - b * Math.cos(w) - c * Math.cos(2 * w), im = b * Math.sin(w) + c * Math.sin(2 * w);
  return 20 * Math.log10(a / Math.sqrt(re * re + im * im + 1e-30));
}

// The vocal tract model's gain at f (dB): cascade formants, antiformants and lip radiation.
function psTractDb(ent, f, sr, noRad) {
  const w = 2 * Math.PI * f / sr;
  let db = noRad ? 0 : 20 * Math.log10(2 * Math.sin(w / 2) + 1e-12);
  for (let i = 0; i < 5; i++) {
    const fm = ent.formants[i];
    const [a, b, c] = psResCoef(fm ? fm.f : PS_DEF_F[i], fm ? fm.bw : PS_DEF_BW[i], sr);
    db += psResDb(a, b, c, w);
  }
  for (const af of ent.antiformants.slice(0, 2)) {
    const [a, b, c] = psResCoef(af.f, af.bw, sr);
    db -= psResDb(a, b, c, w);
  }
  return db;
}

// Envelope implied by the formants alone (used when a profile entry has no measured envelope).
function psModelEnv(ent) {
  const env = new Float32Array(VS_BINS);
  let top = -Infinity;
  for (let b = 0; b < VS_BINS; b++) {
    const f = psGridHz(b);
    env[b] = psTractDb(ent, f, PS_REF_SR) - 12 * Math.log2(Math.max(f, 100) / 100);
    if (env[b] > top) top = env[b];
  }
  for (let b = 0; b < VS_BINS; b++) env[b] -= top;
  return env;
}

// ---------- engine 1: envelope -> renderVoice ----------

// Noise-to-harmonic level for renderVoice from the profile's aperiodicity bands. renderVoice
// shapes its noise as (0.03 + 0.6 * hiW(f)) relative to the harmonics; pick the scalar that best
// matches the measured bands (log least squares, mid bands weighted most).
const PS_BAND_MID = [300, 870, 2120, 4240, 8500];
const PS_BAND_W = [0.5, 1, 1.5, 1.5, 0.7];
const PS_ENV_NOISE_CAL = 1.0;    // measured: renderVoice output reads this much noisier than set
function psBreathLevel(ap) {
  if (!ap) return 0.2;
  let s = 0, w = 0;
  for (let b = 0; b < 5; b++) {
    const a = psClamp(ap[b], 1e-4, 0.95), nhr = a / (1 - a);
    const shape = 0.03 + 0.6 / (1 + Math.pow(3000 / PS_BAND_MID[b], 3));
    s += PS_BAND_W[b] * Math.log(nhr / shape); w += PS_BAND_W[b];
  }
  return PS_ENV_NOISE_CAL * Math.exp(s / w);
}

// renderVoice's own pulse jitter and shimmer (measured as mean absolute period / amplitude
// differences); the profile's extra beyond these is added through the pitch and level curves.
const PS_RV_JITTER = 0.0044, PS_RV_SHIMMER = 0.0215;

function psRenderEnvelope(c, sr, seed, breathScale) {
  const n = c.n, rng = vsRandom(((seed >>> 0) ^ 0x2545f491) >>> 0 || 7);
  const f0 = new Float32Array(n), amp = new Float32Array(n), lvl = new Float32Array(n), env = [];
  for (let k = 0; k < n; k++) {
    const e = c.ent[k];
    const jx = Math.sqrt(Math.max(0, Math.pow(e.jitter != null ? e.jitter : PS_RV_JITTER, 2) - PS_RV_JITTER * PS_RV_JITTER)) / 1.128;
    const sx = Math.sqrt(Math.max(0, Math.pow(e.shimmer != null ? e.shimmer : PS_RV_SHIMMER, 2) - PS_RV_SHIMMER * PS_RV_SHIMMER)) / 1.128;
    f0[k] = c.f0[k] > 0 ? c.f0[k] * (1 + jx * rng.gauss()) : 0;
    amp[k] = Math.max(0, c.amp[k] * (1 + sx * rng.gauss()));
    // renderVoice brightens loud frames by up to 1.5 dB/oct around 400 Hz; take that back out
    // so the output follows the measured envelope
    const src = e.env || psModelEnv(e), out = new Float32Array(VS_BINS);
    const tilt = psClamp((amp[k] - 0.5) * 3, -1.5, 1.5);
    for (let b = 0; b < VS_BINS; b++) out[b] = src[b] - psClamp(tilt * Math.log2(psGridHz(b) / 400), -9, 9);
    env.push(out);
    lvl[k] = breathScale * psBreathLevel(e.aperiodicity);
  }
  // renderVoice's noise level is breath * (0.5 + breathiness) * (1 + 0.8 * (1 - amp)):
  // a shared breath low enough that every frame's level is reachable, the rest per frame
  let B = Infinity;
  for (let k = 0; k < n; k++) if (c.f0[k] > 0) B = Math.min(B, lvl[k] / (0.5 * (1 + 0.8 * Math.max(0, 1 - amp[k]))));
  if (!isFinite(B)) B = 0.1;
  B = Math.max(1e-5, Math.min(1, B));
  const bth = new Float32Array(n);
  for (let k = 0; k < n; k++) bth[k] = Math.max(0, lvl[k] / (B * (1 + 0.8 * Math.max(0, 1 - amp[k]))) - 0.5);
  return renderVoice({ sr, hop: c.hop, f0, amp, env, breath: B, breathiness: bth, seed });
}

// ---------- engine 2: Klatt-style formant synthesis with an LF source ----------

// LF glottal pulse for one period (T0 = 1, negative peak of the flow derivative Ee = 1), from
// Fant's Rd (pulse shape: 0.3 pressed .. 2.7 breathy) and a return phase Ta = ra.
// Returns the parameters of the closed-form flow U(tau), which starts and ends each period at 0.
function psLfSolve(rd, ra) {
  rd = psClamp(rd, 0.3, 2.7);
  const rk = (22.4 + 11.8 * rd) / 100, rap = (-1 + 4.8 * rd) / 100;
  const rg = 0.25 * rk / (0.11 * rd / (0.5 + 1.2 * rk) - rap);
  const tp = 1 / (2 * rg), te = tp * (1 + rk), tb = 1 - te;
  const ta = psClamp(ra, 0.001, 0.7 * tb);
  let eps = 1 / ta;
  for (let i = 0; i < 50; i++) {
    const ex = Math.exp(-eps * tb), g = eps * ta - 1 + ex, d = ta - tb * ex;
    const next = eps - g / d;
    if (!(next > 0)) break;
    if (Math.abs(next - eps) < 1e-10 * eps) { eps = next; break; }
    eps = next;
  }
  const ebt = Math.exp(-eps * tb);
  const uRet = -(1 / (eps * ta)) * ((1 - ebt) / eps - tb * ebt);
  const w = Math.PI / tp, s = Math.sin(w * te), co = Math.cos(w * te);
  const uOpen = al => -((al * s - w * co) + w * Math.exp(-al * te)) / (s * (al * al + w * w));
  let lo = -60, hi = 150;
  for (let i = 0; i < 70; i++) { const mid = 0.5 * (lo + hi); if (uOpen(mid) + uRet > 0) lo = mid; else hi = mid; }
  const al = 0.5 * (lo + hi);
  return { tp, te, ta, tb, eps, ebt, w, al, e0: -1 / (Math.exp(al * te) * s), ute: uOpen(al), k2: 1 / (al * al + w * w) };
}

// Glottal flow at tau (0..1 of a period).
function psLfFlow(p, tau) {
  if (tau <= p.te) return p.e0 * (Math.exp(p.al * tau) * (p.al * Math.sin(p.w * tau) - p.w * Math.cos(p.w * tau)) + p.w) * p.k2;
  const d = tau - p.te;
  return p.ute - ((1 - Math.exp(-p.eps * d)) / p.eps - d * p.ebt) / (p.eps * p.ta);
}

// Table over (Rd, Ta) of the pulse's harmonic levels (dB, k = 1..64), with running sums for a
// weighted (1/k) regression of level on log2 k, so the source slope over any K harmonics is O(1).
const PS_LF_RD = 25, PS_LF_RA = 14, PS_LF_K = 64;
const psLfRa = j => 0.003 * Math.pow(0.15 / 0.003, j / (PS_LF_RA - 1));
let psLfTab = null;
function psLfTable() {
  if (psLfTab) return psLfTab;
  const M = 1024, re = new Float64Array(M), im = new Float64Array(M);
  const nodes = [];
  for (let i = 0; i < PS_LF_RD; i++) for (let j = 0; j < PS_LF_RA; j++) {
    const p = psLfSolve(0.3 + 0.1 * i, psLfRa(j));
    for (let s = 0; s < M; s++) { re[s] = psLfFlow(p, s / M); im[s] = 0; }
    fft(re, im);
    const db = new Float32Array(PS_LF_K + 1);
    for (let k = 1; k <= PS_LF_K; k++) db[k] = 10 * Math.log10(4 * (re[k] * re[k] + im[k] * im[k]) / (M * M) + 1e-30);
    const sw = new Float64Array(PS_LF_K + 1), sx = new Float64Array(PS_LF_K + 1), sy = new Float64Array(PS_LF_K + 1);
    const sxx = new Float64Array(PS_LF_K + 1), sxy = new Float64Array(PS_LF_K + 1);
    for (let k = 1; k <= PS_LF_K; k++) {
      const w = 1 / k, x = Math.log2(k), y = db[k];
      sw[k] = sw[k - 1] + w; sx[k] = sx[k - 1] + w * x; sy[k] = sy[k - 1] + w * y;
      sxx[k] = sxx[k - 1] + w * x * x; sxy[k] = sxy[k - 1] + w * x * y;
    }
    nodes.push({ db, sw, sx, sy, sxx, sxy, te: p.te });
  }
  psLfTab = nodes;
  return nodes;
}
const psSlopeOf = (n, K) => {
  const d = n.sw[K] * n.sxx[K] - n.sx[K] * n.sx[K];
  return d > 0 ? (n.sw[K] * n.sxy[K] - n.sx[K] * n.sy[K]) / d : 0;
};

// Source features at fractional table coordinates (i over Rd, j over Ta), bilinear.
function psLfAt(i, j, K) {
  const T = psLfTable();
  const i0 = Math.min(PS_LF_RD - 2, Math.floor(i)), j0 = Math.min(PS_LF_RA - 2, Math.floor(j)), u = i - i0, v = j - j0;
  const c = [[T[i0 * PS_LF_RA + j0], (1 - u) * (1 - v)], [T[(i0 + 1) * PS_LF_RA + j0], u * (1 - v)],
    [T[i0 * PS_LF_RA + j0 + 1], (1 - u) * v], [T[(i0 + 1) * PS_LF_RA + j0 + 1], u * v]];
  let h12 = 0, slope = 0, te = 0;
  for (const [n, w] of c) { h12 += w * (n.db[1] - n.db[2]); slope += w * psSlopeOf(n, K); te += w * n.te; }
  return { h12, slope, te, c };
}
// Pulse harmonic level k (dB) from the corners psLfAt returned; -12 dB/oct beyond the table.
function psLfHarm(c, k) {
  const kk = Math.min(k, PS_LF_K);
  let v = 0;
  for (const [n, w] of c) v += w * n.db[kk];
  return k > PS_LF_K ? v - 12 * Math.log2(k / PS_LF_K) : v;
}

// Fit the LF shape to an entry: output H1-H2 and output slope (as closeness measures them on a
// recording) minus what the vocal tract adds give the source's; the open quotient pulls too.
function psFitSource(ent, f0, sr, tract) {
  const K = psClamp(Math.floor(5000 / f0), 2, PS_LF_K);
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let k = 1; k <= K; k++) {
    const w = 1 / k, x = Math.log2(k), y = tract[k];
    sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
  }
  const tSlope = (sw * sxy - sx * sy) / (sw * sxx - sx * sx);
  const s = ent.source;
  const h12 = s.h1h2 != null ? s.h1h2 - (tract[1] - tract[2]) : null;
  const sl = s.tilt != null ? s.tilt - tSlope : null;
  const oq = s.oq != null ? psClamp(s.oq, 0.3, 0.9) : null;
  if (h12 == null && sl == null && oq == null) return { i: 7, j: 7 };
  const err = q => (h12 != null ? (q.h12 - h12) * (q.h12 - h12) : 0) + (sl != null ? 4 * (q.slope - sl) * (q.slope - sl) : 0) +
    (oq != null ? 400 * (q.te - oq) * (q.te - oq) : 0);
  let best = { i: 7, j: 7, e: Infinity };
  for (let i = 0; i < PS_LF_RD; i += 1) for (let j = 0; j < PS_LF_RA; j += 1) {
    const e = err(psLfAt(i, j, K));
    if (e < best.e) best = { i, j, e };
  }
  for (const step of [0.5, 0.25, 0.125]) {
    const c = best;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const i = psClamp(c.i + di * step, 0, PS_LF_RD - 1), j = psClamp(c.j + dj * step, 0, PS_LF_RA - 1);
      const e = err(psLfAt(i, j, K));
      if (e < best.e) best = { i, j, e };
    }
  }
  return best;
}

// Aspiration noise for the whole render, made in 1024-sample overlap-added FFT blocks: its
// power density follows the pulse's own harmonic spectrum (power per Hz, from the LF table)
// times ap / (1 - ap) of the band it falls in (smoothly interpolated between band centres), so
// each band's noise-to-harmonic ratio is what the profile measured.
function psAspiration(len, sr, hop, n, f0, SI, SJ, RB, scale, rng, at) {
  const M = 1024, MH = M / 2, out = new Float32Array(len);
  const re = new Float64Array(M), im = new Float64Array(M), win = new Float64Array(M);
  for (let j = 0; j < M; j++) win[j] = Math.sin(Math.PI * (j + 0.5) / M);
  const bx = PS_BAND_MID.map(Math.log2), lr = new Float64Array(5);
  for (let s = -MH; s < len; s += MH) {
    const x = Math.max(0, (s + MH) / sr / hop), fz = at(f0, x, 1, 0);
    const lf = psLfAt(at(SI, x, 1, 0), at(SJ, x, 1, 0), 2);
    for (let b = 0; b < 5; b++) lr[b] = Math.log(Math.max(1e-12, at(RB, x, 5, b)));
    re.fill(0); im.fill(0);
    for (let k = 1; k < MH; k++) {
      const f = k * sr / M, h = f / fz;
      let db;
      if (h <= 1) db = psLfHarm(lf.c, 1);
      else { const h0 = Math.floor(h), a = psLfHarm(lf.c, h0); db = a + (psLfHarm(lf.c, h0 + 1) - a) * (h - h0); }
      const lx = Math.log2(f);
      let r;
      if (lx <= bx[0]) r = lr[0];
      else if (lx >= bx[4]) r = lr[4];
      else { let b = 0; while (lx > bx[b + 1]) b++; r = lr[b] + (lr[b + 1] - lr[b]) * (lx - bx[b]) / (bx[b + 1] - bx[b]); }
      const dens = Math.exp(r) * Math.pow(10, db / 10) / 2 / fz;   // wanted noise power per Hz
      const sd = scale * Math.sqrt(dens * M * sr / 4);              // per real/imag part
      const a = sd * rng.gauss(), c = sd * rng.gauss();
      re[k] = a; im[k] = c; re[M - k] = a; im[M - k] = -c;
    }
    fft(re, im);
    for (let j = 0; j < M; j++) { const i = s + j; if (i >= 0 && i < len) out[i] += re[j] / M * win[j]; }
  }
  return out;
}

function psRenderFormant(c, sr, seed, breathScale) {
  const n = c.n, hop = c.hop, NF = 5, NA = 2;
  const rng = vsRandom(((seed >>> 0) * 2654435761 + 97) >>> 0 || 3);
  const len = Math.ceil(n * hop * sr) + Math.round(0.05 * sr);
  const y = new Float32Array(len);
  if (!n) return y;

  // pitch held through gaps, voicing gain with 15 ms ramps (as renderVoice)
  const f0 = new Float32Array(n), gv = new Float32Array(n);
  let held = 0, first = -1;
  for (let k = 0; k < n; k++) { if (c.f0[k] > 0) { held = c.f0[k]; if (first < 0) first = k; } f0[k] = held; }
  if (first < 0) return y;
  for (let k = 0; k < first; k++) f0[k] = f0[first];
  const step = Math.min(1, hop / 0.015);
  for (let k = 0, g = 0; k < n; k++) { g += psClamp((c.f0[k] > 0 ? 1 : 0) - g, -step, step); gv[k] = g; }

  // per-frame controls
  const FF = new Float32Array(n * NF), FB = new Float32Array(n * NF), AF = new Float32Array(n * NA), AR = new Float32Array(n * NA);
  const SI = new Float32Array(n), SJ = new Float32Array(n), GN = new Float32Array(n), RB = new Float32Array(n * 5);
  const TE = new Float32Array(n), JIT = new Float32Array(n), SHI = new Float32Array(n), FR = new Float32Array(n), FRG = new Float32Array(n * 5);
  const tract = new Float64Array(PS_LF_K + 1);
  let anyFric = false;
  for (let k = 0; k < n; k++) {
    const e = c.ent[k], fz = f0[k];
    for (let i = 0; i < NF; i++) {
      const fm = e.formants[i];
      FF[k * NF + i] = fm ? fm.f : PS_DEF_F[i]; FB[k * NF + i] = fm ? fm.bw : PS_DEF_BW[i];
    }
    for (let i = 0; i < NA; i++) {
      const a = e.antiformants[i];
      AF[k * NA + i] = a ? a.f : 1000; AR[k * NA + i] = a && isFinite(a.bw) ? Math.exp(-Math.PI * a.bw / sr) : 0;
    }
    const K = Math.max(2, Math.min(Math.floor(0.45 * sr / fz), 400));
    for (let h = 1; h <= Math.min(K, PS_LF_K); h++) tract[h] = psTractDb(e, h * fz, sr);
    const fit = psFitSource(e, fz, sr, tract);
    SI[k] = fit.i; SJ[k] = fit.j;
    const lf = psLfAt(fit.i, fit.j, psClamp(Math.floor(5000 / fz), 2, PS_LF_K));
    TE[k] = lf.te;
    // level: match the harmonic power the envelope engine would give (target G at the env peak)
    const env = e.env || psModelEnv(e);
    let pt = 0, ps = 0;
    for (let h = 1; h <= K; h++) {
      const f = h * fz, src = psLfHarm(lf.c, h);
      if (f <= 5000) {
        const out = src + (h <= PS_LF_K ? tract[h] : psTractDb(e, f, sr));
        ps += Math.pow(10, out / 10);
        pt += PS_G * PS_G * Math.pow(10, vsEnvAt(env, vsPos(f)) / 10);
      }
    }
    GN[k] = gv[k] * c.amp[k] * (ps > 0 ? Math.sqrt(pt / ps) : 0);
    // aspiration per band: noise power = ap / (1 - ap) times the pulse's harmonic power there
    const ap = e.aperiodicity || [0.05, 0.08, 0.15, 0.3, 0.5];
    for (let b = 0; b < 5; b++) { const a = psClamp(ap[b], 1e-5, 0.95); RB[k * 5 + b] = a / (1 - a); }
    JIT[k] = (e.jitter != null ? e.jitter : 0.005) / 1.128;
    SHI[k] = (e.shimmer != null ? e.shimmer : 0.03) / 1.128;
    FR[k] = e.frication || 0;
    if (FR[k] > 0) {
      anyFric = true;
      for (let i = 1; i < NF; i++) FRG[k * 5 + i] = Math.pow(10, vsEnvAt(env, vsPos(FF[k * NF + i])) / 20);
      FRG[k * 5] = 0.3;
    }
  }
  const at = (arr, x, stride, off) => {
    if (x <= 0) return arr[off];
    const i = Math.floor(x);
    if (i >= n - 1) return arr[(n - 1) * stride + off];
    const a = arr[i * stride + off];
    return a + (arr[(i + 1) * stride + off] - a) * (x - i);
  };

  // slow drift: two slow sines each for pitch (cents) and level
  const ph = [rng.u(), rng.u(), rng.u(), rng.u()].map(v => 2 * Math.PI * v);
  const driftC = t => 4 * Math.sin(2 * Math.PI * 0.37 * t + ph[0]) + 2.5 * Math.sin(2 * Math.PI * 0.83 * t + ph[1]);
  const driftA = t => 1 + 0.03 * Math.sin(2 * Math.PI * 0.29 * t + ph[2]) + 0.02 * Math.sin(2 * Math.PI * 0.71 * t + ph[3]);

  // filter state: coefficients ramp linearly across each 1 ms block
  const blk = Math.max(8, Math.round(sr / 1000));
  const NS = NF + NA;
  const ca = new Float64Array(NS), cb = new Float64Array(NS), cc = new Float64Array(NS);
  const da = new Float64Array(NS), db = new Float64Array(NS), dc = new Float64Array(NS);
  const s1 = new Float64Array(NS), s2 = new Float64Array(NS);
  const targets = (x, out) => {
    for (let i = 0; i < NF; i++) {
      const r = psResCoef(at(FF, x, NF, i), at(FB, x, NF, i), sr);
      out.push(r);
    }
    for (let i = 0; i < NA; i++) {
      const f = at(AF, x, NA, i), r = at(AR, x, NA, i);
      const b = 2 * r * Math.cos(2 * Math.PI * Math.min(f, 0.48 * sr) / sr), cq = -r * r, a = 1 - b - cq;
      out.push([1 / a, -b / a, -cq / a]);            // antiresonator: FIR inverse of a resonator
    }
    return out;
  };
  let init = targets(0, []);
  for (let i = 0; i < NS; i++) { ca[i] = init[i][0]; cb[i] = init[i][1]; cc[i] = init[i][2]; }
  let gain = GN[0], dg = 0;

  const asp = psAspiration(len, sr, hop, n, f0, SI, SJ, RB, breathScale, rng, at);
  // parallel branch (frication through formants 2-5 and a bypass), silent unless entries ask
  const pc = [], pz = new Float64Array(NF * 2);

  let tStart = first * hop, tNext = tStart, T = 1 / f0[first], shape = psLfSolve(1, 0.02);
  let amp = 1, te = 0.6;
  let prev = 0;
  for (let s = 0; s < len; s++) {
    if (s % blk === 0) {
      const x = (s + blk) / sr / hop, tg = targets(x, []);
      for (let i = 0; i < NS; i++) { da[i] = (tg[i][0] - ca[i]) / blk; db[i] = (tg[i][1] - cb[i]) / blk; dc[i] = (tg[i][2] - cc[i]) / blk; }
      dg = (at(GN, x, 1, 0) * driftA((s + blk) / sr) - gain) / blk;
      if (anyFric) {
        pc.length = 0;
        for (let i = 1; i < NF; i++) {
          const f = at(FF, x, NF, i), bw = at(FB, x, NF, i), r = Math.exp(-Math.PI * bw / sr);
          pc.push([(1 - r) * at(FRG, x, 5, i), 2 * r * Math.cos(2 * Math.PI * Math.min(f, 0.48 * sr) / sr), -r * r]);
        }
        pc.push([at(FRG, x, 5, 0), at(FR, x, 1, 0)]);
      }
    }
    for (let i = 0; i < NS; i++) { ca[i] += da[i]; cb[i] += db[i]; cc[i] += dc[i]; }
    gain += dg;
    const t = s / sr;

    // a new glottal period: jittered length, shimmered amplitude, current pulse shape
    if (t >= tNext) {
      tStart = tNext;
      const x = tStart / hop;
      const f = at(f0, x, 1, 0) * Math.pow(2, driftC(tStart) / 1200);
      T = (1 / f) * (1 + psClamp(at(JIT, x, 1, 0) * rng.gauss(), -0.05, 0.05));
      tNext = tStart + T;
      amp = 1 + psClamp(at(SHI, x, 1, 0) * rng.gauss(), -0.3, 0.3);
      const i = at(SI, x, 1, 0), j = at(SJ, x, 1, 0);
      const p = psLfSolve(0.3 + 0.1 * i, 0.003 * Math.pow(0.15 / 0.003, j / (PS_LF_RA - 1)));
      if (isFinite(p.e0) && isFinite(p.ute) && isFinite(p.al)) shape = p;
      te = shape.te;
    }
    const tau = Math.min(1, (t - tStart) / T);
    const u = psLfFlow(shape, tau);

    // aspiration, louder while the glottis is open: a smooth one-harmonic swell (a hard gate
    // would smear the strong low-band noise up into the quiet high bands)
    const nz = asp[s] * (1 + 0.6 * Math.cos(2 * Math.PI * (tau - te / 2))) * 0.9206;

    // cascade: five formants, then antiformants (nasal zeros)
    let v = gain * (amp * u + nz);
    for (let i = 0; i < NF; i++) {
      const out = ca[i] * v + cb[i] * s1[i] + cc[i] * s2[i];
      s2[i] = s1[i]; s1[i] = out; v = out;
    }
    for (let i = NF; i < NS; i++) {
      const out = ca[i] * v + cb[i] * s1[i] + cc[i] * s2[i];
      s2[i] = s1[i]; s1[i] = v; v = out;
    }
    if (anyFric && pc.length) {
      const fw = rng.gauss() * gain * pc[pc.length - 1][1];
      let par = pc[pc.length - 1][0] * fw;
      for (let i = 0; i < pc.length - 1; i++) {
        const [a, b, cq] = pc[i], out = a * fw + b * pz[2 * i] + cq * pz[2 * i + 1];
        pz[2 * i + 1] = pz[2 * i]; pz[2 * i] = out; par += (i % 2 ? -1 : 1) * out;
      }
      v += par;
    }
    // lip radiation
    y[s] = v - prev; prev = v;
  }
  return psFinish(y, sr);
}

// No NaN, no DC (20 Hz high-pass), peak at most 0.97.
function psFinish(y, sr) {
  const hp = Math.exp(-2 * Math.PI * 20 / sr);
  let peak = 0, px = 0, py = 0;
  for (let i = 0; i < y.length; i++) {
    const v = isFinite(y[i]) ? y[i] : 0;
    py = hp * (py + v - px); px = v; y[i] = py;
    if (Math.abs(py) > peak) peak = Math.abs(py);
  }
  if (peak > 0.97) { const s = 0.97 / peak; for (let i = 0; i < y.length; i++) y[i] *= s; }
  return y;
}

// Controls -> audio with the chosen engine. c = { hop, n, f0 (Hz, 0 silent), amp, ent: [entry] }.
function psRender(c, engine, sr, seed, breath) {
  const b = breath == null ? 1 : breath;
  return engine === 'formant' ? psRenderFormant(c, sr, seed, b) : psRenderEnvelope(c, sr, seed, b);
}

// ---------- public: render ----------

// One sustained sound. opts = { sound: 'ah' | 'oo>ah', midi, dur (s), loud: 0..1, vibrato: 0..1,
//   morph: 0..1 (for 'a>b'; a number holds that blend, leave it out to glide a -> b across the
//   note, or give a Float32Array per 5 ms frame), engine: 'envelope' | 'formant', sr, seed, breath }.
// Gain follows the profile's measured level relative to its loudest entry.
function renderVowel(profile, opts = {}) {
  const sr = opts.sr || 48000, hop = 0.005, dur = opts.dur > 0 ? opts.dur : 1.5;
  const sound = opts.sound || 'ah', loud = psClamp(opts.loud == null ? 0.5 : opts.loud, 0, 1);
  const range = profile.range || {};
  const midi0 = isFinite(opts.midi) ? opts.midi : isFinite(range.low) && isFinite(range.high) ? (range.low + range.high) / 2 : 50;
  const n = Math.max(2, Math.round(dur / hop) + 1);
  const habits = profile.habits || {};
  const vib = psClamp(opts.vibrato || 0, 0, 1);
  const top = psTopLevel(profile);
  const f0 = new Float32Array(n), amp = new Float32Array(n), ent = [];
  const cache = new Map();
  const att = 0.06, rel = 0.12;
  for (let k = 0; k < n; k++) {
    const t = k * hop;
    const morph = sound.indexOf('>') < 0 ? 0 : opts.morph == null ? 0.5 - 0.5 * Math.cos(Math.PI * psClamp((t / dur - 0.2) / 0.6, 0, 1))
      : typeof opts.morph === 'number' ? opts.morph : opts.morph[Math.min(k, opts.morph.length - 1)];
    const key = sound + '|' + morph.toFixed(3);
    let e0 = cache.get(key + '|base');
    if (!e0) { e0 = psSoundAt(profile, sound, midi0, loud, morph); cache.set(key + '|base', e0); }
    // habit vibrato, eased in after ~0.25 s
    let cents = 0;
    if (vib > 0) {
      const v = e0.vibrato || {};
      const rate = habits.vibratoRate || v.rate || 5.5, depth = habits.vibratoDepthCents || v.depth || 30;
      const ease = psClamp((t - 0.25) / 0.4, 0, 1);
      cents = vib * depth * ease * ease * (3 - 2 * ease) * Math.sin(2 * Math.PI * rate * Math.max(0, t - 0.25));
    }
    const m = midi0 + cents / 100;
    const mk = key + '|' + m.toFixed(2);
    let e = cache.get(mk);
    if (!e) { e = psSoundAt(profile, sound, m, loud, morph); cache.set(mk, e); }
    ent.push(e);
    f0[k] = midiToHz(m);
    const env = t < att ? 0.5 - 0.5 * Math.cos(Math.PI * t / att) : t > dur - rel ? 0.5 + 0.5 * Math.cos(Math.PI * psClamp((t - dur + rel) / rel, 0, 1)) : 1;
    const lvl = e.levelDb != null && isFinite(top) ? Math.max(0.05, 0.9 * Math.pow(10, (e.levelDb - top) / 20)) : 0.4 + 0.5 * loud;
    amp[k] = env * lvl;
  }
  const y = psRender({ hop, n, f0, amp, ent }, opts.engine, sr, opts.seed == null ? 1 : opts.seed, opts.breath);
  return y.slice(0, Math.min(y.length, Math.ceil(dur * sr) + Math.round(0.03 * sr)));
}

// A sung line with the profile's voice. line = { t0, hop, m: Float32Array (MIDI, NaN = silent),
// a: Float32Array (0..1.5) }. opts = { sound, or vowelTrack: per-frame indices into opts.sounds
// (default ['mm', 'oo', 'oh', 'ah', 'ee']; fractional = morph between neighbours), engine, sr,
// transpose (semitones), breath (noise multiplier, 1 = as measured), loud (fixed 0..1 instead of
// following a), seed }. Returns { samples, sr }; samples[0] is at line.t0.
function renderLineWithProfile(line, profile, opts = {}) {
  const sr = opts.sr || 48000, hop = line.hop, n = line.m.length, tr = opts.transpose || 0;
  const sounds = opts.sounds || ['mm', 'oo', 'oh', 'ah', 'ee'];
  // vowel track softened over ~30 ms so changes glide instead of stepping
  let track = null;
  if (opts.vowelTrack) {
    const raw = opts.vowelTrack, half = Math.max(1, Math.round(0.015 / hop));
    track = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let s = 0, c = 0;
      for (let d = -half; d <= half; d++) {
        const v = raw[psClamp(k + d, 0, raw.length - 1)];
        if (isFinite(v)) { s += v; c++; }
      }
      track[k] = c ? psClamp(s / c, 0, sounds.length - 1) : 0;
    }
  }
  let held = NaN;
  for (let k = 0; k < n && !isFinite(held); k++) if (isFinite(line.m[k])) held = line.m[k] + tr;
  if (!isFinite(held)) held = 50;
  const f0 = new Float32Array(n), amp = new Float32Array(n), ent = [], cache = new Map();
  for (let k = 0; k < n; k++) {
    const m = line.m[k], a = line.a[k];
    if (isFinite(m)) held = m + tr;
    f0[k] = isFinite(m) ? midiToHz(m + tr) : 0;
    amp[k] = isFinite(a) && a > 0 ? a : 0;
    const loud = opts.loud != null ? psClamp(opts.loud, 0, 1) : psClamp(amp[k], 0, 1);
    const mq = Math.round(held * 50) / 50, lq = Math.round(loud * 50) / 50;
    let e;
    if (track) {
      const i0 = Math.min(sounds.length - 1, Math.floor(track[k])), fr = Math.round((track[k] - i0) * 50) / 50;
      const key = i0 + '|' + fr + '|' + mq + '|' + lq;
      e = cache.get(key);
      if (!e) {
        e = fr < 1e-3 || i0 >= sounds.length - 1 ? psSoundAt(profile, sounds[i0], mq, lq)
          : psMorph(psSoundAt(profile, sounds[i0], mq, lq), psSoundAt(profile, sounds[i0 + 1], mq, lq), fr);
        cache.set(key, e);
      }
    } else {
      const key = mq + '|' + lq;
      e = cache.get(key);
      if (!e) { e = psSoundAt(profile, opts.sound || 'ah', mq, lq, opts.morph); cache.set(key, e); }
    }
    ent.push(e);
  }
  const samples = psRender({ hop, n, f0, amp, ent }, opts.engine, sr, opts.seed == null ? 1 : opts.seed, opts.breath);
  return { samples, sr };
}

// ---------- analysis for closeness ----------

const psPow2 = v => { let p = 1; while (p < v) p <<= 1; return p; };

// Pitch track (YIN on an FFT autocorrelation), one estimate per frame: [{ t, f0, ok }].
function psPitchTrack(x, sr) {
  const W = psPow2(sr / 30), hopN = W >> 1, N = 2 * W;
  const re = new Float64Array(N), im = new Float64Array(N), cum = new Float64Array(W + 1), d = new Float64Array(W >> 1);
  const lagMin = Math.floor(sr / 1000), lagMax = Math.min((W >> 1) - 2, Math.ceil(sr / 55));
  const out = [];
  let maxE = 0;
  for (let s = 0; s + W <= x.length; s += hopN) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < W; i++) { re[i] = x[s + i]; cum[i + 1] = cum[i] + x[s + i] * x[s + i]; }
    fft(re, im);
    for (let i = 0; i < N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    fft(re, im);
    let run = 0, tau = -1;
    d[0] = 1;
    for (let l = 1; l <= lagMax; l++) {
      const dl = cum[W - l] + (cum[W] - cum[l]) - 2 * re[l] / N;
      run += dl;
      d[l] = run > 0 ? dl * l / run : 1;
    }
    for (let l = lagMin; l < lagMax; l++) {
      if (d[l] < 0.15) { while (l + 1 < lagMax && d[l + 1] < d[l]) l++; tau = l; break; }
    }
    if (tau < 0) { let b = lagMin; for (let l = lagMin; l < lagMax; l++) if (d[l] < d[b]) b = l; tau = b; }
    const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c;
    const lag = tau + (den > 0 ? 0.5 * (a - c) / den : 0);
    const e = cum[W] / W;
    if (e > maxE) maxE = e;
    out.push({ t: (s + W / 2) / sr, f0: sr / lag, q: b, e });
  }
  for (const p of out) p.ok = p.q < 0.35 && p.e > maxE * 1e-3;
  return out;
}

// Linear-prediction formants of a whole steady stretch: one long-term autocorrelation (frames
// summed) of the signal decimated to ~11-12 kHz, pre-emphasised; roots of the predictor.
function psLpcFormants(x, sr) {
  const D = Math.max(1, Math.floor(sr / 11000)), srd = sr / D;
  let z = x;
  if (D > 1) {
    const L = 16 * D + 1, h = new Float64Array(L), fc = 0.45 / D, mid = (L - 1) / 2;
    let hs = 0;
    for (let i = 0; i < L; i++) {
      const t = i - mid, sinc = t ? Math.sin(2 * Math.PI * fc * t) / (Math.PI * t) : 2 * fc;
      h[i] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (L - 1)));
      hs += h[i];
    }
    const m = Math.floor((x.length - L) / D);
    z = new Float64Array(Math.max(0, m));
    for (let j = 0; j < m; j++) { let s = 0; const o = j * D; for (let i = 0; i < L; i++) s += h[i] * x[o + i]; z[j] = s / hs; }
  }
  const p = psClamp(Math.round(srd / 1000), 10, 14), W = Math.round(0.03 * srd), H = Math.round(0.01 * srd);
  const R = new Float64Array(p + 1), fr = new Float64Array(W);
  for (let s = 1; s + W <= z.length; s += H) {
    for (let i = 0; i < W; i++) fr[i] = (z[s + i] - 0.97 * z[s + i - 1]) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (W - 1)));
    for (let l = 0; l <= p; l++) { let acc = 0; for (let i = l; i < W; i++) acc += fr[i] * fr[i - l]; R[l] += acc; }
  }
  if (!(R[0] > 0)) return [];
  for (let l = 1; l <= p; l++) R[l] *= Math.exp(-0.5 * Math.pow(2 * Math.PI * 40 * l / srd, 2));
  R[0] *= 1.0001;
  // Levinson-Durbin
  const a = new Float64Array(p + 1), tmp = new Float64Array(p + 1);
  a[0] = 1;
  let err = R[0];
  for (let i = 1; i <= p; i++) {
    let acc = R[i];
    for (let j = 1; j < i; j++) acc += a[j] * R[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
  }
  // roots of z^p + a1 z^(p-1) + ... + ap (Durand-Kerner)
  const zr = new Float64Array(p), zi = new Float64Array(p);
  for (let i = 0; i < p; i++) { const ang = 2 * Math.PI * (i + 0.25) / p + 0.4; zr[i] = 0.9 * Math.cos(ang); zi[i] = 0.9 * Math.sin(ang); }
  for (let it = 0; it < 400; it++) {
    let moved = 0;
    for (let i = 0; i < p; i++) {
      let pr = 1, pi = 0;
      for (let j = 1; j <= p; j++) { const r2 = pr * zr[i] - pi * zi[i] + a[j]; pi = pr * zi[i] + pi * zr[i]; pr = r2; }
      let qr = 1, qi = 0;
      for (let j = 0; j < p; j++) {
        if (j === i) continue;
        const dr = zr[i] - zr[j], di = zi[i] - zi[j], r2 = qr * dr - qi * di;
        qi = qr * di + qi * dr; qr = r2;
      }
      const m2 = qr * qr + qi * qi || 1e-30, cr = (pr * qr + pi * qi) / m2, ci = (pi * qr - pr * qi) / m2;
      zr[i] -= cr; zi[i] -= ci;
      moved = Math.max(moved, Math.abs(cr) + Math.abs(ci));
    }
    if (moved < 1e-12) break;
  }
  const out = [];
  for (let i = 0; i < p; i++) {
    if (zi[i] <= 0) continue;
    const f = Math.atan2(zi[i], zr[i]) * srd / (2 * Math.PI), bw = -Math.log(Math.hypot(zr[i], zi[i])) * srd / Math.PI;
    if (f > 90 && f < srd / 2 - 100 && bw > 0 && bw < 700) out.push({ f, bw });
  }
  return out.sort((u, v) => u.f - v.f);
}

// Everything closeness compares, measured on the steady middle of one recording.
// opts = { range: [startSec, endSec], trim: fraction cut from each end when no range (0.2) }.
function psAnalyse(x, sr, opts = {}) {
  let s0, s1;
  if (opts.range) { s0 = Math.max(0, Math.round(opts.range[0] * sr)); s1 = Math.min(x.length, Math.round(opts.range[1] * sr)); }
  else { const tr = opts.trim == null ? 0.2 : opts.trim; s0 = Math.round(x.length * tr); s1 = Math.round(x.length * (1 - tr)); }
  const seg = x.subarray(s0, Math.max(s0 + 16, s1));
  const track = psPitchTrack(seg, sr), voiced = track.filter(p => p.ok);
  const f0med = voiced.length ? median(voiced.map(p => p.f0)) : track.length ? median(track.map(p => p.f0)) : 100;
  const f0At = t => {
    let best = null;
    for (const p of track) if (p.ok && Math.abs(Math.log2(p.f0 / f0med)) < 1 / 12 && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
    return best ? best.f0 : f0med;
  };

  // harmonic levels and aperiodicity bands from Blackman-windowed spectra ~14 periods long
  let N = psClamp(psPow2(14 * sr / f0med), 1024, 32768);
  while (N > 1024 && N > seg.length) N >>= 1;
  const win = new Float64Array(N);
  let ws = 0;
  for (let i = 0; i < N; i++) { win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (N - 1)); ws += win[i]; }
  const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2), binHz = sr / N;
  const fmax = Math.min(0.45 * sr, 8000), KH = Math.min(200, Math.floor(fmax / f0med));
  const hp = new Float64Array(KH + 1), hf = new Float64Array(KH + 1), hc = new Float64Array(KH + 1);
  const bTop = Math.min(0.45 * sr, 12000), edges = [0, ...PS_BANDS, bTop];
  const vSum = new Float64Array(5), vCnt = new Float64Array(5), tSum = new Float64Array(5), tCnt = new Float64Array(5);
  const hopN = N >> 2, frames = [];
  let maxE = 0;
  for (let s = 0; s + N <= seg.length; s += hopN) {
    let e = 0;
    for (let i = 0; i < N; i++) e += seg[s + i] * seg[s + i];
    frames.push({ s, e });
    if (e > maxE) maxE = e;
  }
  if (!frames.length) frames.push({ s: 0, e: 1 }), maxE = 1;
  let used = 0;
  for (const { s, e } of frames) {
    if (e < maxE * 1e-3) continue;
    used++;
    re.fill(0); im.fill(0);
    for (let i = 0; i < N && s + i < seg.length; i++) re[i] = seg[s + i] * win[i];
    fft(re, im);
    for (let b = 0; b < N / 2; b++) P[b] = (re[b] * re[b] + im[b] * im[b]) * 4 / (ws * ws);
    // local f0 refined from the first harmonics
    let f0 = f0At((s + N / 2) / sr), num = 0, den = 0;
    const peakNear = f => {
      const c = f / binHz, r = Math.max(3, 0.15 * f0 / binHz);
      let bi = -1;
      for (let b = Math.max(1, Math.floor(c - r)); b <= Math.min(N / 2 - 2, Math.ceil(c + r)); b++) if (bi < 0 || P[b] > P[bi]) bi = b;
      if (bi < 1) return null;
      const a = 10 * Math.log10(P[bi - 1] + 1e-30), v = 10 * Math.log10(P[bi] + 1e-30), cc = 10 * Math.log10(P[bi + 1] + 1e-30);
      const dd = a - 2 * v + cc, off = dd < 0 ? 0.5 * (a - cc) / dd : 0;
      return { f: (bi + off) * binHz, db: v - 0.25 * (a - cc) * off };
    };
    for (let k = 1; k <= 6; k++) { const pk = peakNear(k * f0); if (pk && Math.abs(pk.f / k - f0) < 0.03 * f0) { const w = Math.pow(10, pk.db / 20); num += w * pk.f; den += w * k; } }
    if (den > 0) f0 = num / den;
    for (let k = 1; k <= KH; k++) {
      if (k * f0 > fmax) break;
      const pk = peakNear(k * f0);
      if (!pk) continue;
      hp[k] += Math.pow(10, pk.db / 10); hf[k] += pk.f; hc[k]++;
    }
    // aperiodicity: mean power between harmonics vs mean power overall, per band
    for (let b = 1; b < N / 2; b++) {
      const f = b * binHz;
      if (f < 0.5 * f0 || f >= bTop) continue;
      let band = 0;
      while (band < 4 && f >= edges[band + 1]) band++;
      const h = f / f0, dist = Math.abs(h - Math.round(h));
      tSum[band] += P[b]; tCnt[band]++;
      if (dist > 0.3) { vSum[band] += P[b]; vCnt[band]++; }
    }
  }
  const harm = [];
  for (let k = 1; k <= KH; k++) if (hc[k] >= Math.max(1, used / 2)) harm.push({ k, f: hf[k] / hc[k], db: 10 * Math.log10(hp[k] / hc[k] + 1e-30) });
  const ap = [0, 1, 2, 3, 4].map(b => vCnt[b] && tSum[b] > 0 ? psClamp(vSum[b] / vCnt[b] * tCnt[b] / tSum[b], 1e-4, 1) : 1);

  // envelope on the shared grid: straight lines in dB between harmonics, held below, -12 dB/oct above
  const env = new Float32Array(VS_BINS);
  let lo = 0, hi = 0;
  if (harm.length >= 2) {
    const px = harm.map(h => vsPos(h.f)), py = harm.map(h => h.db), last = px.length - 1;
    let j = 0, top = -Infinity;
    for (let b = 0; b < VS_BINS; b++) {
      let v;
      if (b <= px[0]) v = py[0];
      else if (b >= px[last]) v = py[last] - (b - px[last]);
      else { while (px[j + 1] < b) j++; v = py[j] + (py[j + 1] - py[j]) * (b - px[j]) / (px[j + 1] - px[j]); }
      env[b] = v; if (v > top) top = v;
    }
    for (let b = 0; b < VS_BINS; b++) env[b] -= top;
    lo = px[0]; hi = px[last];
  }
  // source: H1-H2 and the slope of harmonic levels (dB per octave, 1/k weights, up to 5 kHz)
  const H = k => { const h = harm.find(q => q.k === k); return h ? h.db : NaN; };
  const h1h2 = H(1) - H(2);
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const h of harm) {
    if (h.f > 5000) break;
    const w = 1 / h.k, xx = Math.log2(h.f);
    sw += w; sx += w * xx; sy += w * h.db; sxx += w * xx * xx; sxy += w * xx * h.db;
  }
  const tilt = sw * sxx - sx * sx > 0 ? (sw * sxy - sx * sy) / (sw * sxx - sx * sx) : 0;
  let rms = 0;
  for (let i = 0; i < seg.length; i++) rms += seg[i] * seg[i];
  return {
    f0: f0med, harm, env, envLo: lo, envHi: hi, h1h2, tilt, ap,
    formants: psLpcFormants(seg, sr), levelDb: 10 * Math.log10(rms / seg.length + 1e-20),
  };
}

// Match the reference's first three formants to the nearest unused candidates (log-frequency).
function psMatchFormants(ref, cand) {
  const used = new Set(), pairs = [];
  for (let i = 0; i < Math.min(3, ref.length); i++) {
    let bj = -1;
    for (let j = 0; j < cand.length; j++) {
      if (used.has(j)) continue;
      if (bj < 0 || Math.abs(Math.log(cand[j].f / ref[i].f)) < Math.abs(Math.log(cand[bj].f / ref[i].f))) bj = j;
    }
    if (bj < 0) break;
    used.add(bj);
    pairs.push([ref[i].f, cand[bj].f]);
  }
  return pairs;
}

// How close a synthetic recording is to a real one of the same sustained unit (0..100).
// opts = { trim (0.2), realRange: [s, e], synthRange: [s, e] } (seconds; default: the middle).
// Parts: envelopeDb  rms dB difference of the harmonic envelopes (gain aligned) over the shared band up to 5 kHz
//        formantHz   mean |dF| over F1-F3 (LPC); the score uses the relative error (weights .4 .4 .2)
//        sourceDb    (|dH1-H2| + 2 * |d tilt per octave|) / 2
//        noiseDb     mean |d aperiodicity| per band in dB (floor -25 dB; outer bands weigh half)
//        pitchCents  |median f0 difference|
// Score: D = .35 env/3dB + .30 formant/6% + .15 source/3dB + .10 noise/4dB + .10 pitch/50c,
//        score = 100 * exp(-D / 1.5).  Identical input gives 100; the same analysis always gives the same score.
function closeness(real, synth, sr, opts = {}) {
  const A = psAnalyse(real, sr, { trim: opts.trim, range: opts.realRange });
  const B = psAnalyse(synth, sr, { trim: opts.trim, range: opts.synthRange });
  // envelope
  const lo = Math.max(A.envLo, B.envLo), hi = Math.min(A.envHi, B.envHi, vsPos(5000));
  const d = [];
  for (let b = Math.ceil(lo); b <= Math.floor(hi); b++) d.push(psClamp(A.env[b] - B.env[b], -25, 25));
  let envelopeDb = 0;
  if (d.length) {
    const mean = d.reduce((s, v) => s + v, 0) / d.length;
    envelopeDb = Math.sqrt(d.reduce((s, v) => s + (v - mean) * (v - mean), 0) / d.length);
  } else envelopeDb = 20;
  // formants
  const pairs = psMatchFormants(A.formants, B.formants), fw = [0.4, 0.4, 0.2];
  let formantHz = 0, formantPct = 0, wsum = 0;
  pairs.forEach(([fr, fs], i) => { formantHz += Math.abs(fs - fr) / pairs.length; formantPct += fw[i] * 100 * Math.abs(Math.log(fs / fr)); wsum += fw[i]; });
  formantPct = wsum ? formantPct / wsum : 100;
  if (!pairs.length) formantHz = 1000;
  // source
  const dh = isFinite(A.h1h2) && isFinite(B.h1h2) ? Math.abs(A.h1h2 - B.h1h2) : 10;
  const sourceDb = (dh + 2 * Math.abs(A.tilt - B.tilt)) / 2;
  // noise
  const bw = [0.5, 1, 1, 1, 0.5];
  let noiseDb = 0;
  for (let b = 0; b < 5; b++) noiseDb += bw[b] * Math.abs(10 * Math.log10(Math.max(A.ap[b], 0.003)) - 10 * Math.log10(Math.max(B.ap[b], 0.003))) / 4;
  // pitch
  const pitchCents = Math.abs(1200 * Math.log2(B.f0 / A.f0));
  const D = 0.35 * envelopeDb / 3 + 0.30 * formantPct / 6 + 0.15 * sourceDb / 3 + 0.10 * noiseDb / 4 + 0.10 * pitchCents / 50;
  const score = 100 * Math.exp(-D / 1.5);
  return {
    score: Math.round(score * 10) / 10,
    parts: { envelopeDb, formantHz, sourceDb, noiseDb, pitchCents },
    detail: { formantPct, real: A, synth: B },
  };
}
