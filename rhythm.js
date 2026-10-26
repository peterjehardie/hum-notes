// Rhythm from the mic: beatbox, taps or claps -> hits -> drum kinds -> a step pattern you can loop and vary.
// Pure functions, no DOM, no audio. Needs dsp.js first (fft, inferTempo, median).
// Times are in seconds; a pattern is { bpm, t0, beats, steps, bars, swing, lanes, length, loop }.

const RH_KINDS = ['kick', 'snare', 'hat'];

// ---------- hits ----------
// 1 ms-ish smoothed absolute envelope (one-pole follower with instant attack).
function rhEnvelope(x, sr, ms) {
  const e = new Float32Array(x.length), k = Math.exp(-1 / (sr * ms / 1000));
  let v = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); v = a > v ? a : a + (v - a) * k; e[i] = v; }
  return e;
}

// Ratio of level after / before sample i over n samples, best of plain and first-difference (bright) signal.
function rhRise(x, i, n) {
  let a = 0, b = 0, da = 0, db = 0;
  for (let k = 1; k <= n; k++) {
    const p = i + k, q = i - k;
    if (p < x.length) { a += x[p] * x[p]; const d = x[p] - x[p - 1]; da += d * d; }
    if (q > 0) { b += x[q] * x[q]; const d = x[q] - x[q - 1]; db += d * d; }
  }
  return Math.sqrt(Math.max(a / (b + 1e-12), da / (db + 1e-12)));
}

// Band shares, centroid and flatness of the first ~60 ms after an onset.
function rhSpectrum(x, sr, i0) {
  const len = Math.min(Math.round(0.06 * sr), x.length - i0);
  let n = 1;
  while (n < Math.round(0.06 * sr)) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < len; i++) re[i] = x[i0 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / len));
  fft(re, im);
  const binHz = sr / n;
  let low = 0, mid = 0, high = 0, sum = 0, cen = 0, lsum = 0, cnt = 0;
  for (let k = 1; k < n / 2; k++) {
    const f = k * binHz, p = re[k] * re[k] + im[k] * im[k];
    if (f < 200) low += p; else if (f < 2000) mid += p; else high += p;
    sum += p; cen += p * f;
    if (f >= 60 && f <= 16000) { lsum += Math.log(p + 1e-20); cnt++; }
  }
  let band = 0;
  for (let k = 1; k < n / 2; k++) { const f = k * binHz; if (f >= 60 && f <= 16000) band += re[k] * re[k] + im[k] * im[k]; }
  const tot = sum || 1;
  return {
    low: low / tot, mid: mid / tot, high: high / tot,
    centroid: sum ? cen / sum : 0,
    noisiness: cnt && band ? Math.exp(lsum / cnt) / (band / cnt) : 0,
  };
}

// Onsets by spectral flux (short FFT, adaptive threshold), refined to the attack in the samples.
// Returns [{ t, strength, feat: { low, mid, high, centroid, noisiness, decay } }].
function detectHits(samples, sr) {
  const x = samples;
  let win = 1;
  while (win < 0.0213 * sr) win <<= 1;                     // 1024 at 48 kHz
  const hop = win >> 2;
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  if (frames < 3) return [];
  const hann = new Float64Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / win);
  const half = win / 2, re = new Float64Array(win), im = new Float64Array(win);
  let prev = new Float64Array(half), cur = new Float64Array(half);
  const flux = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < win; i++) { re[i] = x[o + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    let s = 0;
    for (let k = 1; k < half; k++) {
      cur[k] = Math.log1p(200 * Math.hypot(re[k], im[k]) / win);   // compressed magnitude
      if (f && cur[k] > prev[k]) s += cur[k] - prev[k];
    }
    flux[f] = s;
    const t = prev; prev = cur; cur = t;
  }
  // adaptive threshold: local median over ~0.2 s plus a margin
  let fmax = 0;
  for (const v of flux) fmax = Math.max(fmax, v);
  if (fmax <= 0) return [];
  const globalMed = median(Array.from(flux));
  const margin = Math.max(0.06 * fmax, 2 * globalMed);
  const W = Math.max(2, Math.round(0.1 * sr / hop)), gap = 0.06 * sr;
  const env = rhEnvelope(x, sr, 1);
  const onsets = [];
  for (let f = 1; f < frames - 1; f++) {
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    let ok = true;
    for (let j = Math.max(0, f - 3); j <= Math.min(frames - 1, f + 3); j++) if (flux[j] > flux[f]) ok = false;
    if (!ok) continue;
    const loc = median(Array.from(flux.subarray(Math.max(0, f - W), Math.min(frames, f + W + 1))));
    if (flux[f] < loc + margin) continue;
    // attack: steepest 5 ms rise of the envelope inside this frame, then its peak, then the half-peak point before it
    const d = Math.round(0.005 * sr), a0 = Math.max(d, f * hop), a1 = Math.min(x.length - 1, f * hop + win);
    let iRise = a0, best = -Infinity;
    for (let i = a0; i <= a1; i++) { const r = env[i] - env[i - d]; if (r > best) { best = r; iRise = i; } }
    let iPk = iRise;
    for (let i = iRise, e = Math.min(x.length, iRise + Math.round(0.012 * sr)); i < e; i++) if (env[i] > env[iPk]) iPk = i;
    const floor = Math.max(env[Math.max(0, iRise - d)], 0.5 * env[iPk]);
    let i0 = Math.max(0, iRise - d);
    while (i0 < iPk && env[i0] < floor) i0++;
    // new energy, not a wobble in a decaying tail: louder than the 10 ms before, plain or brightened
    if (rhRise(x, i0, Math.round(0.01 * sr)) < 1.6) continue;
    const last = onsets[onsets.length - 1];
    if (last && i0 - last.i < gap) {
      if (env[iPk] > last.peak) { last.i = i0; last.peak = env[iPk]; last.iPk = iPk; }
      continue;
    }
    onsets.push({ i: i0, iPk, peak: env[iPk] });
  }
  let pmax = 0;
  for (const o of onsets) pmax = Math.max(pmax, o.peak);
  const slow = rhEnvelope(x, sr, 5);
  return onsets.map((o, n) => {
    const end = Math.min(x.length, n + 1 < onsets.length ? onsets[n + 1].i : x.length, o.i + Math.round(0.5 * sr));
    let pk = o.iPk;
    for (let i = o.i, e = Math.min(end, o.i + Math.round(0.02 * sr)); i < e; i++) if (slow[i] > slow[pk]) pk = i;
    let j = pk;
    while (j < end && slow[j] > 0.1 * slow[pk]) j++;
    const feat = rhSpectrum(x, sr, o.i);
    feat.decay = (j - pk) / sr;
    return { t: o.i / sr, strength: pmax ? o.peak / pmax : 0, feat };
  });
}

// ---------- kinds ----------
// Feature point for clustering: shares 0..1, centroid as octaves / 2, flatness 0..1.
const rhPoint = f => [f.low, f.high, Math.log2(Math.max(50, f.centroid) / 50) / 2, f.noisiness];
const rhDist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

function rhKmeans(pts, k) {
  // two repeatable starts (centroid-order quantiles, farthest points); keep the tighter result
  const order = pts.map((p, i) => i).sort((a, b) => pts[a][2] - pts[b][2]);
  const quant = Array.from({ length: k }, (_, j) => pts[order[Math.min(order.length - 1, Math.floor((j + 0.5) * order.length / k))]].slice());
  const far = [pts[order[0]].slice()];
  while (far.length < k) {
    let bi = 0, bd = -1;
    pts.forEach((p, i) => { const d = Math.min(...far.map(c => rhDist(p, c))); if (d > bd) { bd = d; bi = i; } });
    far.push(pts[bi].slice());
  }
  let best = null;
  for (let cen of [quant, far]) {
    let lab = [];
    for (let it = 0; it < 30; it++) {
      lab = pts.map(p => { let b = 0; for (let j = 1; j < k; j++) if (rhDist(p, cen[j]) < rhDist(p, cen[b])) b = j; return b; });
      cen = cen.map((c, j) => {
        const m = pts.filter((p, i) => lab[i] === j);
        return m.length ? c.map((v, d) => m.reduce((s, p) => s + p[d], 0) / m.length) : c;
      });
    }
    const inertia = pts.reduce((s, p, i) => s + rhDist(p, cen[lab[i]]) ** 2, 0);
    if (!best || inertia < best.inertia) best = { lab, cen, inertia };
  }
  return best;
}

function rhSilhouette(pts, lab, k) {
  let s = 0;
  pts.forEach((p, i) => {
    const mean = j => {
      let sum = 0, n = 0;
      pts.forEach((q, m) => { if (lab[m] === j && m !== i) { sum += rhDist(p, q); n++; } });
      return n ? sum / n : null;
    };
    const a = mean(lab[i]);
    let b = Infinity;
    for (let j = 0; j < k; j++) if (j !== lab[i]) { const v = mean(j); if (v !== null) b = Math.min(b, v); }
    if (a === null || !isFinite(b)) return;
    s += (b - a) / Math.max(a, b);
  });
  return s / pts.length;
}

// Label each hit kick / snare / hat by clustering this recording's hits, then naming clusters by brightness.
// Adds kind and vel (0..1). Returns new hit objects.
function classifyHits(hits) {
  if (!hits.length) return [];
  const pts = hits.map(h => rhPoint(h.feat));
  let pick = { k: 1, lab: pts.map(() => 0) };
  let bestSil = 0.5;
  for (let k = 2; k <= 3 && k <= pts.length; k++) {
    const { lab, cen } = rhKmeans(pts, k);
    const sizes = cen.map((c, j) => lab.filter(l => l === j).length);
    if (Math.min(...sizes) < Math.max(2, 0.04 * pts.length)) continue;
    let sep = Infinity;
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) sep = Math.min(sep, rhDist(cen[a], cen[b]));
    if (sep < 0.3) continue;
    const sil = rhSilhouette(pts, lab, k) + (k === 3 ? 0.03 : 0);   // three kinds is the usual beatbox case
    if (sil > bestSil) { bestSil = sil; pick = { k, lab }; }
  }
  // name clusters: darkest kick, brightest hat, middle snare; two clusters look at absolute brightness
  const stats = Array.from({ length: pick.k }, (_, j) => {
    const m = hits.filter((h, i) => pick.lab[i] === j);
    return { j, centroid: m.reduce((s, h) => s + Math.log(Math.max(50, h.feat.centroid)), 0) / m.length,
      low: m.reduce((s, h) => s + h.feat.low, 0) / m.length };
  }).sort((a, b) => a.centroid - b.centroid);
  const name = {};
  if (pick.k === 1) name[stats[0].j] = 'snare';
  else if (pick.k === 3) { name[stats[0].j] = 'kick'; name[stats[1].j] = 'snare'; name[stats[2].j] = 'hat'; }
  else {
    const [lo, hi] = stats;
    const loKick = lo.low > 0.35 || Math.exp(lo.centroid) < 500;
    name[lo.j] = loKick ? 'kick' : 'snare';
    name[hi.j] = !loKick || Math.exp(hi.centroid) > 4000 ? 'hat' : 'snare';
  }
  return hits.map((h, i) => ({ ...h, kind: name[pick.lab[i]], vel: Math.min(1, Math.max(0.15, Math.sqrt(h.strength))) }));
}

// ---------- grid ----------
// Swing warps the beat: the off-beat 8th moves from 0.5 to `swing`, the 16ths in between follow.
const rhWarp = (p, s) => p <= 0.5 ? p * 2 * s : s + (p - 0.5) * 2 * (1 - s);
const rhUnwarp = (q, s) => q <= s ? q / (2 * s) : 0.5 + (q - s) / (2 * (1 - s));

// Seconds from pattern start to a step, with swing.
function stepTime(p, step) {
  const beat = Math.floor(step / p.steps), j = step - beat * p.steps;
  return (beat + rhWarp(j / p.steps, p.swing)) * 60 / p.bpm;
}

// Nearest grid point for a time: { b (beat), j (step in beat), g (beats, warped) }.
function rhSnap(t, t0, P, S, s) {
  const u = (t - t0) / P;
  let b = Math.floor(u), j = Math.round(rhUnwarp(u - b, s) * S);
  if (j === S) { b++; j = 0; }
  return { b, j, g: b + rhWarp(j / S, s) };
}

// Fit beat length and phase to the hits for one tempo and swing; score = misfit + how busy the grid reading is.
function rhFit(hits, bpm, t0, S, s) {
  let P = 60 / bpm;
  for (let it = 0; it < 4; it++) {
    let n = 0, sg = 0, st = 0, sgg = 0, sgt = 0;
    for (const h of hits) { const { g } = rhSnap(h.t, t0, P, S, s); n++; sg += g; st += h.t; sgg += g * g; sgt += g * h.t; }
    const den = n * sgg - sg * sg;
    if (den <= 1e-9) break;
    const P2 = (n * sgt - sg * st) / den;
    if (!(Math.abs(P2 / P - 1) < 0.04)) break;
    P = P2; t0 = (st - P * sg) / n;
  }
  let cost = 0;
  const strong = { kick: 1.5, snare: 1.5, hat: 1 };
  for (const h of hits) {
    const { j, g } = rhSnap(h.t, t0, P, S, s), r = h.t - (t0 + P * g);
    const busy = j === 0 ? 0 : (2 * j) % S === 0 ? 0.5 : 1.2;
    cost += Math.min(Math.pow(r / 0.018, 2), 6) + 0.6 * busy * (strong[h.kind] || 1);
  }
  cost = cost / hits.length + 2 * (s - 0.5) + 0.8 * Math.pow(Math.log2(60 / P / 110), 2);
  return { bpm: 60 / P, t0, swing: s, cost };
}

// Similarity of two bars of (kind, step) hits; kicks and snares count more than hats.
function rhBarSim(a, b) {
  const w = { kick: 1, snare: 1, hat: 0.3 };
  const ka = new Map(a.map(h => [h.kind + h.s, w[h.kind]])), kb = new Set(b.map(h => h.kind + h.s));
  let inter = 0, uni = 0;
  for (const [k, v] of ka) { uni += v; if (kb.has(k)) inter += v; }
  for (const h of b) if (!ka.has(h.kind + h.s)) uni += w[h.kind];
  return uni ? inter / uni : 1;
}

function rhLanes(list) {
  const lanes = { kick: [], snare: [], hat: [] };
  for (const h of list) {
    const lane = lanes[h.kind] || (lanes[h.kind] = []);
    const old = lane.find(e => e.step === h.step);
    if (old) old.vel = Math.max(old.vel, h.vel);
    else lane.push({ step: h.step, vel: Math.round(h.vel * 100) / 100, ...(h.nudge !== undefined ? { nudge: h.nudge } : {}) });
  }
  for (const k in lanes) lanes[k].sort((a, b) => a.step - b.step);
  return lanes;
}

// The step pattern of classified hits: tempo, swing, meter, bar start, lanes and the most repeated 1- or 2-bar loop.
function rhythmGrid(hits, opts = {}) {
  const S = opts.steps || 4;
  const hs = hits.filter(h => h.kind).slice().sort((a, b) => a.t - b.t);
  const tr = hs.length >= 4 && inferTempo(hs.map(h => ({ start: h.t })));
  if (!tr) return null;
  // tempo candidates around the heard 8th grid, folded into 70..160
  const cands = [];
  for (const r of [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75, 3, 1 / 3]) {
    let b = tr.bpm * r;
    while (b < 70) b *= 2;
    while (b > 160) b /= 2;
    if (!cands.some(c => Math.abs(c / b - 1) < 0.01)) cands.push(b);
  }
  if (opts.bpm) cands.splice(0, cands.length, opts.bpm);
  let fit = null;
  for (const bpm of cands) {
    const P = 60 / bpm;
    for (let s = 0.5; s <= 0.701; s += 0.02) {
      for (let k = 0; k < 2 * S; k++) {
        const f = rhFit(hs, bpm, hs[0].t - k * P / (2 * S), S, s);
        if (!fit || f.cost < fit.cost) fit = f;
      }
    }
  }
  const P = 60 / fit.bpm, sw = fit.swing;
  const snapped = hs.map(h => { const { b, j } = rhSnap(h.t, fit.t0, P, S, sw); return { ...h, beat: b, j }; });
  const b0 = Math.min(...snapped.map(h => h.beat));
  // meter and bar start: bars that repeat, and strong hits on the first beat
  const weight = { kick: 1, snare: 0.5, hat: 0.2 };
  let best = null;
  for (const M of opts.beats ? [opts.beats] : [4, 3]) {
    for (let o = 0; o < M; o++) {
      const start = b0 - ((b0 - o) % M + M) % M;          // first bar start at or before the first hit
      const bars = [];
      for (const h of snapped) {
        const rel = h.beat - start, bar = Math.floor(rel / M);
        (bars[bar] = bars[bar] || []).push({ kind: h.kind, s: (rel - bar * M) * S + h.j, vel: h.vel });
      }
      for (let i = 0; i < bars.length; i++) bars[i] = bars[i] || [];
      let rep = 0, nr = 0;
      for (let i = 0; i + 1 < bars.length; i++) {
        rep += Math.max(rhBarSim(bars[i], bars[i + 1]), i + 2 < bars.length ? rhBarSim(bars[i], bars[i + 2]) : 0); nr++;
      }
      rep = nr ? rep / nr : 0;
      let down = 0, other = 0;
      for (const bar of bars) for (const h of bar) {
        const v = weight[h.kind] * h.vel;
        if (h.s === 0) down += v; else if (h.s % S === 0) other += v;
      }
      const dScore = down / bars.length - other / bars.length / (M - 1);
      const firstStrong = snapped.find(h => h.kind !== 'hat') || snapped[0];
      const first = firstStrong.beat === start && firstStrong.j === 0 ? 0.15 : 0;
      const score = rep + 0.3 * dScore + first + (M === 4 ? 0.02 : 0);
      if (!best || score > best.score) best = { score, M, start, nbars: bars.length };
    }
  }
  const M = best.M, barSteps = M * S;
  const list = snapped.map(h => ({ kind: h.kind, step: (h.beat - best.start) * S + h.j, vel: h.vel }));
  const pattern = {
    bpm: Math.round(fit.bpm * 10) / 10, t0: fit.t0 + best.start * P, beats: M, steps: S, bars: best.nbars,
    swing: Math.round(sw * 100) / 100, lanes: rhLanes(list), length: best.nbars * barSteps,
  };
  pattern.loop = rhLoop(pattern);
  return pattern;
}

// Most repeated 1- or 2-bar stretch; velocities averaged over its repeats.
function rhLoop(p) {
  const barSteps = p.beats * p.steps, all = [];
  for (const kind in p.lanes) for (const e of p.lanes[kind]) all.push({ kind, step: e.step, vel: e.vel });
  const chunk = (from, n) => all.filter(e => e.step >= from * barSteps && e.step < (from + n) * barSteps)
    .map(e => ({ ...e, s: e.step - from * barSteps }));
  const pickFor = n => {
    const cs = [];
    for (let i = 0; i + n <= p.bars; i += n) cs.push(chunk(i, n));
    if (!cs.length) return null;
    let top = null;
    cs.forEach((c, i) => {
      const like = cs.filter(d => rhBarSim(c, d) >= 0.8);
      const sc = like.length + cs.reduce((s, d) => s + rhBarSim(c, d), 0) * 0.01;
      if (!top || sc > top.sc) top = { sc, i, like, frac: like.length / cs.length };
    });
    return top;
  };
  const one = pickFor(1), two = p.bars >= 2 ? pickFor(2) : null;
  const n = one && (!two || one.frac >= 0.6 || two.like.length < 2) ? 1 : 2;
  const top = n === 1 ? one : two;
  const base = top.like.length ? top.like : [chunk(top.i * n, n)];
  const sum = new Map(), cnt = new Map();
  const core = chunk(top.i * n, n);
  for (const e of core) { sum.set(e.kind + ':' + e.s, 0); cnt.set(e.kind + ':' + e.s, 0); }
  for (const c of base) for (const e of c) {
    const key = e.kind + ':' + e.s;
    if (sum.has(key)) { sum.set(key, sum.get(key) + e.vel); cnt.set(key, cnt.get(key) + 1); }
  }
  const list = core.map(e => ({ kind: e.kind, step: e.s, vel: sum.get(e.kind + ':' + e.s) / cnt.get(e.kind + ':' + e.s) }));
  return { bpm: p.bpm, t0: p.t0 + stepTime(p, top.i * n * barSteps), beats: p.beats, steps: p.steps, bars: n,
    swing: p.swing, lanes: rhLanes(list), length: n * barSteps };
}

// ---------- playback ----------
// Events { kind, step, vel } for steps from..to (end exclusive), repeating the pattern.
function patternEvents(p, fromStep, toStep) {
  const out = [], L = p.length;
  if (!L) return out;
  const firstLoop = Math.floor(fromStep / L);
  for (let k = firstLoop; k * L < toStep; k++) {
    for (const kind in p.lanes) for (const e of p.lanes[kind]) {
      const step = k * L + e.step;
      if (step >= fromStep && step < toStep) out.push({ kind, step, vel: e.vel, ...(e.nudge !== undefined ? { nudge: e.nudge } : {}) });
    }
  }
  return out.sort((a, b) => a.step - b.step || RH_KINDS.indexOf(a.kind) - RH_KINDS.indexOf(b.kind));
}

// ---------- variations (each returns a new pattern) ----------
function rhCopy(p, lanes) {
  const q = { ...p, lanes: {} };
  delete q.loop;
  const src = lanes || p.lanes;
  for (const k in src) q.lanes[k] = src[k].filter(e => e.step >= 0 && e.step < p.length).map(e => ({ ...e })).sort((a, b) => a.step - b.step);
  for (const k of RH_KINDS) q.lanes[k] = q.lanes[k] || [];
  return q;
}
const rhHas = (lane, step) => lane.some(e => e.step === step);

// Ghost hats on empty 16ths and a ghost snare just before each backbeat.
function varyBusier(p) {
  const q = rhCopy(p), S = p.steps;
  for (let st = 0; st < p.length; st++) if (!rhHas(q.lanes.hat, st)) q.lanes.hat.push({ step: st, vel: 0.25 });
  for (const e of p.lanes.snare || []) {
    const inBar = e.step % (p.beats * S);
    if (inBar === 0 || e.step % S || e.vel < 0.4) continue;
    const g = e.step - 1;
    if (g >= 0 && !rhHas(q.lanes.snare, g)) q.lanes.snare.push({ step: g, vel: 0.25 });
  }
  return rhCopy(q);
}

// Strong positions only: kicks and snares on 8ths, hats on beats, quiet ghosts dropped.
function varySimpler(p) {
  const S = p.steps, eighth = Math.max(1, S / 2), lanes = {};
  for (const k in p.lanes) lanes[k] = p.lanes[k].filter(e => e.vel >= 0.35 && (k === 'hat' ? e.step % S === 0 : e.step % eighth === 0));
  return rhCopy(p, lanes);
}

// Half time: the first half of each bar stretched over the whole bar (snare moves to the middle).
function varyHalfTime(p) {
  const bar = p.beats * p.steps, lanes = {};
  for (const k in p.lanes) lanes[k] = p.lanes[k].filter(e => e.step % bar < bar / 2)
    .map(e => ({ ...e, step: Math.floor(e.step / bar) * bar + Math.round((e.step % bar) * 2) }));
  return rhCopy(p, lanes);
}

// Double time: each bar squeezed into its first half and played twice.
function varyDoubleTime(p) {
  const bar = p.beats * p.steps, half = Math.floor(bar / 2), lanes = {};
  for (const k in p.lanes) {
    lanes[k] = [];
    for (const e of p.lanes[k]) {
      const pos = e.step % bar;
      if (pos % 2) continue;
      const base = e.step - pos;
      for (const off of [0, half]) if (pos / 2 + off < bar) lanes[k].push({ ...e, step: base + pos / 2 + off });
    }
    lanes[k] = lanes[k].filter((e, i, a) => a.findIndex(f => f.step === e.step) === i);
  }
  return rhCopy(p, lanes);
}

// Set the swing of the off-beat 8th: 0.5 straight .. 0.67 triplet.
function varySwing(p, amount) {
  const q = rhCopy(p);
  q.swing = Math.min(0.75, Math.max(0.5, amount));
  return q;
}

// Fill: the last beat of the last bar becomes a run of snares getting louder.
function varyFill(p) {
  const S = p.steps, from = p.length - S, lanes = {};
  for (const k in p.lanes) lanes[k] = p.lanes[k].filter(e => e.step < from || (k === 'kick' && e.step === from));
  lanes.snare = lanes.snare || [];
  for (let j = 0; j < S; j++) lanes.snare.push({ step: from + j, vel: Math.round((0.5 + 0.5 * (j + 1) / S) * 100) / 100 });
  return rhCopy(p, lanes);
}

// Small velocity changes and a timing nudge in ms per hit; steps stay on the grid.
function varyHumanize(p, seed = 1) {
  let a = seed >>> 0 || 1;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const lanes = {};
  for (const k in p.lanes) lanes[k] = p.lanes[k].map(e => ({ ...e,
    vel: Math.round(Math.min(1, Math.max(0.05, e.vel * (1 + (rnd() - 0.5) * 0.24))) * 100) / 100,
    nudge: Math.round((rnd() - 0.5) * (k === 'hat' ? 16 : 10) * 10) / 10 }));
  return rhCopy(p, lanes);
}

// ---------- presets ----------
// Build a pattern from text lanes, one character per step: x = hit, o = soft hit, . = rest; '|' is ignored.
function rhythmFromText(bpm, beats, lanes, opts = {}) {
  const steps = opts.steps || 4, out = {};
  let length = 0;
  for (const k in lanes) {
    const s = lanes[k].replace(/\|/g, '');
    length = Math.max(length, s.length);
    out[k] = [];
    for (let i = 0; i < s.length; i++) if (s[i] !== '.') out[k].push({ step: i, vel: s[i] === 'x' ? 0.9 : s[i] === 'X' ? 1 : 0.45 });
  }
  const bar = beats * steps, bars = Math.max(1, Math.ceil(length / bar));
  const p = { bpm, t0: 0, beats, steps, bars, swing: opts.swing || 0.5, lanes: out, length: bars * bar };
  return rhCopy(p);
}

const PATTERN_PRESETS = {
  rock: rhythmFromText(96, 4, {
    kick: 'x.......x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }),
  halftime: rhythmFromText(80, 4, {
    kick: 'x.........x.....', snare: '........x.......', hat: 'x.x.x.x.x.x.x.x.' }),
  shuffle: rhythmFromText(110, 4, {
    kick: 'x.......x.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' }, { swing: 0.66 }),
  waltz: rhythmFromText(120, 3, {
    kick: 'x...........', snare: '....o...o...', hat: 'x.x.x.x.x.x.' }),
  march: rhythmFromText(112, 4, {
    kick: 'x.......x.......', snare: 'x..ox.o.x..ox.x.', hat: '................' }),
  bossa: rhythmFromText(130, 4, {
    kick: 'x..ox..ox..ox..o|x..ox..ox..ox..o', snare: 'o..o..o...o..o..|..o..o..o..o....', hat: 'xoxoxoxoxoxoxoxo|xoxoxoxoxoxoxoxo' }),
  four: rhythmFromText(124, 4, {
    kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.' }),
};
