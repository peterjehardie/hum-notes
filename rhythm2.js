// Rhythm v2: note starts, a beat tracker that follows tempo drift, tap-along beats and a
// rhythm quantizer on a variable-tempo beat map. Pure functions, no DOM, no audio.
// Needs dsp.js first (Segmenter, mergeFragments, estimateTuning, median, fft).
// A beat map is { beats: [t...] seconds, bpm, drift, meter: { beats, offset }, pickup, confidence };
// beat b (a float) sits between beats[floor(b)] and beats[floor(b) + 1].

const R2_HOP = 0.005;          // loudness envelope frame step (s)
const R2_FPS = 100;            // beat tracker frames per second

// ---------- small helpers ----------
const r2Clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2Db = v => 20 * Math.log10(Math.max(v, 1e-5));

// Moving average over 2k+1 values.
function r2Smooth(a, k) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(a.length - 1, i + k); j++) { s += a[j]; n++; }
    out[i] = s / n;
  }
  return out;
}

// ---------- loudness envelope ----------
// Level in dB every 5 ms. From the raw recording when given (12 ms windows: sharper attacks,
// plus spectral flux for timing), otherwise from the pitch track's rms.
function r2Envelope(points, voice) {
  const t0 = points.length ? points[0].t : 0, t1 = points.length ? points[points.length - 1].t : 0;
  const n = Math.max(1, Math.floor((t1 - t0) / R2_HOP) + 1);
  const db = new Float32Array(n);
  let flux = null;
  if (voice && voice.data && voice.data.length) {
    const x = voice.data, sr = voice.sr, half = Math.round(0.006 * sr);
    for (let i = 0; i < n; i++) {
      const c = Math.round((t0 + i * R2_HOP - voice.t0) * sr);
      let s = 0, cnt = 0;
      for (let j = Math.max(0, c - half); j < Math.min(x.length, c + half); j++) { s += x[j] * x[j]; cnt++; }
      db[i] = r2Db(cnt ? Math.sqrt(s / cnt) : 0);
    }
    flux = r2Flux(voice, t0, n);
  } else {
    let k = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * R2_HOP;
      while (k + 1 < points.length && Math.abs(points[k + 1].t - t) <= Math.abs(points[k].t - t)) k++;
      db[i] = r2Db(points[k].r || 0);
    }
  }
  return { t0, db: r2Smooth(db, 1), flux };
}

// Spectral flux (rise in log magnitude, summed over bins) on the same 5 ms grid.
function r2Flux(voice, t0, n) {
  const x = voice.data, sr = voice.sr;
  let win = 1;
  while (win < 0.023 * sr) win <<= 1;
  const re = new Float64Array(win), im = new Float64Array(win), prev = new Float64Array(win / 2), out = new Float32Array(n);
  const hann = new Float64Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win);
  const kMax = Math.min(win / 2, Math.round(4000 / (sr / win)));
  for (let f = 0; f < n; f++) {
    const c = Math.round((t0 + f * R2_HOP - voice.t0) * sr) - win / 2;
    for (let i = 0; i < win; i++) { const j = c + i; re[i] = j >= 0 && j < x.length ? x[j] * hann[i] : 0; im[i] = 0; }
    fft(re, im);
    let s = 0;
    for (let k = 1; k < kMax; k++) {
      const m = Math.log(1 + 1000 * Math.hypot(re[k], im[k]));
      if (f && m > prev[k]) s += m - prev[k];
      prev[k] = m;
    }
    out[f] = s;
  }
  return out;
}

// ---------- 1. note onsets ----------
// Loudness re-attacks: a rise of 6 dB or more out of a dip (a "d" between two "dum"s, or a
// start after silence). The onset is where the rise gets going; flux nudges it when present.
function r2LoudOnsets(env) {
  const db = env.db, n = db.length, out = [];
  if (n < 10) return out;
  let top = -Infinity;
  for (const v of db) top = Math.max(top, v);
  const floor = top - 45;
  const w = f => Math.round(f / R2_HOP);
  for (let i = 2; i < n - 2; i++) {
    const d = db[i + 2] - db[i - 2];
    if (d < 2 || d < db[i + 1] - db[i - 3] || d < db[i + 3] - db[i - 1]) continue;
    let jd = i, dip = db[i];
    for (let j = i; j >= Math.max(0, i - w(0.12)); j--) if (db[j] < dip) { dip = db[j]; jd = j; }
    let post = -Infinity;
    for (let j = i; j <= Math.min(n - 1, i + w(0.04)); j++) post = Math.max(post, db[j]);
    let pre = -Infinity;
    for (let j = Math.max(0, jd - w(0.15)); j <= jd; j++) pre = Math.max(pre, db[j]);
    const depth = post - Math.max(dip, floor);
    if (depth < 6 || post < floor + 10) continue;
    // time it from the last low point before this rise (not an earlier breath or click)
    let k = i;
    while (k > jd && db[k - 1] <= db[k]) k--;
    const low = db[k];
    while (k < i + 2 && db[k] < low + 0.25 * (post - low)) k++;
    let t = env.t0 + k * R2_HOP;
    if (env.flux) {
      let best = -1, bf = 0;
      for (let j = Math.max(0, k - w(0.02)); j <= Math.min(n - 1, k + w(0.02)); j++) if (env.flux[j] > bf) { bf = env.flux[j]; best = j; }
      if (best >= 0) t = (t + env.t0 + best * R2_HOP) / 2;
    }
    const afterSilence = pre - dip < 3 || dip <= floor + 3;
    const o = { t, strength: r2Clamp((depth - 3) / 15, 0.1, 1), depth, dip: Math.min(pre, post) - dip, afterSilence };
    const last = out[out.length - 1];
    if (last && t - last.t < 0.07) { if (o.depth > last.depth) out[out.length - 1] = o; } else out.push(o);
  }
  return out;
}

// Pitch onsets: starts of steady new pitches (the app's segmenter, flickers folded away).
function r2PitchOnsets(points) {
  const tun = estimateTuning(points), off = tun.used ? tun.offset : 0;
  const seg = new Segmenter(Math.round);
  for (const p of points) seg.push(p.t, p.m - off);
  seg.close(points.length ? points[points.length - 1].t : 0);
  const notes = mergeFragments(seg.notes, 0.155), out = [];
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    if (prev && n.start - prev.end < 0.05) {
      if (n.midi !== prev.midi) {
        // the change happens where the raw pitch first crosses halfway between the two notes
        const mid = (n.midi + prev.midi) / 2 + off, up = n.midi > prev.midi;
        let t = n.start;
        for (const p of points) {
          if (p.t < n.start - 0.1) continue;
          if (p.t > n.start) break;
          if (!isNaN(p.m) && (up ? p.m > mid : p.m < mid)) { t = p.t; break; }
        }
        out.push({ t, strength: Math.min(1, 0.35 + 0.08 * Math.abs(n.midi - prev.midi)) });
      }
    } else out.push({ t: n.start, strength: 0.6 });
  });
  return out;
}

// Note starts from pitch changes, loudness re-attacks and voicing after silence, merged when
// closer than 50 ms. `voice` = { t0, sr, data } (the raw recording) sharpens the timing.
function noteOnsets(points, voice) {
  if (!points || points.length < 4) return [];
  // a loudness onset counts only when voiced sound follows it (breaths and clicks don't)
  const voicedAfter = t => {
    let run = 0, last = null;
    for (const p of points) {
      if (p.t < t - 0.02) continue;
      if (p.t > t + 0.12) break;
      if (!isNaN(p.m)) { if (last != null && p.t - last < 0.02) run += p.t - last; last = p.t; if (run >= 0.06) return true; }
      else last = null;
    }
    return false;
  };
  const loud = r2LoudOnsets(r2Envelope(points, voice)).filter(o => voicedAfter(o.t)), pitch = r2PitchOnsets(points);
  const all = [...loud.map(o => ({ t: o.t, strength: o.strength, kind: 'loudness', dip: Math.round(o.dip * 10) / 10 })),
    ...pitch.map(o => ({ t: o.t, strength: o.strength, kind: 'pitch' }))].sort((a, b) => a.t - b.t);
  const out = [];
  for (const o of all) {
    const last = out[out.length - 1];
    if (last && o.t - last.t < 0.05 && last.kind !== o.kind && last.kind !== 'both') {
      const lt = last.kind === 'loudness' ? last.t : o.t;
      last.t = lt; last.kind = 'both'; last.dip = last.dip ?? o.dip;
      last.strength = Math.min(1, Math.max(last.strength, o.strength) + 0.2);
    } else if (last && o.t - last.t < 0.03) last.strength = Math.max(last.strength, o.strength);
    else out.push({ ...o });
  }
  return out;
}

// ---------- 2. split notes at re-attacks ----------
// Cut a note where a strong loudness re-attack falls inside it ("dum dum" on one pitch).
// Each piece keeps the note's fields; perf curves are cut by time.
function splitNotesAtOnsets(notes, onsets, opts = {}) {
  const minStrength = opts.minStrength ?? 0.3, minDur = opts.minDur ?? 0.1, minDip = opts.minDip ?? 7;
  const out = [];
  notes = notes.map((n, i) => {
    // a scoop into a note is part of it: start the note where the voice came in
    if (opts.pullStarts === false) return n;
    const prevEnd = i ? notes[i - 1].end : -Infinity;
    const o = onsets.find(o => o.kind !== 'pitch' && o.strength >= minStrength && o.t >= n.start - 0.35 && o.t < n.start - 0.03 && o.t > prevEnd - 0.02);
    return o ? { ...n, start: o.t, sungStart: n.start } : n;
  });
  for (const n of notes) {
    const cuts = onsets.filter(o => o.kind !== 'pitch' && o.strength >= minStrength && (o.dip ?? 99) >= minDip
      && o.t > n.start + minDur && o.t < n.end - minDur).map(o => o.t);
    const keep = [];
    for (const t of cuts) if (!keep.length || t - keep[keep.length - 1] >= minDur) keep.push(t);
    if (!keep.length) { out.push(n); continue; }
    const edges = [n.start, ...keep, n.end];
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i], b = edges[i + 1], piece = { ...n, start: a, end: b };
      if (n.perf) {
        const cut = arr => Array.isArray(arr) ? arr.filter(p => p[0] >= a && p[0] < b + (i === edges.length - 2 ? 1e-9 : 0)) : arr;
        piece.perf = { ...n.perf, start: Math.max(a, n.perf.start ?? a), end: Math.min(b, n.perf.end ?? b), curve: cut(n.perf.curve), amp: cut(n.perf.amp) };
        if (i > 0) piece.perf.scoop = 0;
        if (i < edges.length - 2) piece.perf.fall = 0;
        if (n.perf.vib && b - a < 0.3) piece.perf.vib = null;
      }
      if (i < edges.length - 2) delete piece.slur;
      if (i > 0) { piece.reattack = true; delete piece.grace; }
      delete piece.qs; delete piece.qe;
      out.push(piece);
    }
  }
  return out;
}

// ---------- beat map lookups ----------
// Beats (float, beat-map index) -> seconds, straight lines between beats, extrapolated at the ends.
function beatTimeOf(map, b) {
  const B = map.beats, n = B.length;
  if (n === 1) return B[0] + b * 60 / (map.bpm || 100);
  const i = r2Clamp(Math.floor(b), 0, n - 2);
  return B[i] + (b - i) * (B[i + 1] - B[i]);
}

// Seconds -> beats (float).
function beatOf(map, t) {
  const B = map.beats, n = B.length;
  if (n === 1) return (t - B[0]) * (map.bpm || 100) / 60;
  let lo = 0, hi = n - 2;
  if (t >= B[n - 1]) lo = n - 2;
  else if (t > B[0]) {
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (B[m] <= t) lo = m; else hi = m - 1; }
  }
  return lo + (t - B[lo]) / (B[lo + 1] - B[lo]);
}

// ---------- 3. beat tracking ----------
// Onset weight: strength, more for notes held longer (long notes tend to sit on beats).
function r2Weights(onsets, notes) {
  return onsets.map((o, i) => {
    let len = null;
    if (notes) {
      const n = notes.find(m => Math.abs(m.start - o.t) < 0.06);
      if (n) len = n.end - n.start;
    }
    if (len == null) len = onsets[i + 1] ? onsets[i + 1].t - o.t : 0.5;
    return o.strength * r2Clamp(Math.sqrt(len / 0.35), 0.6, 1.6);
  });
}

// Onset envelope at 100 fps: a 20 ms bump per onset.
function r2OnsetEnv(onsets, w, from, T) {
  const O = new Float32Array(T);
  onsets.forEach((o, i) => {
    const c = (o.t - from) * R2_FPS;
    for (let f = Math.max(0, Math.floor(c - 9)); f <= Math.min(T - 1, Math.ceil(c + 9)); f++)
      O[f] += w[i] * Math.exp(-0.5 * ((f - c) / 3) ** 2);
  });
  return O;
}

// Global beat period (frames). For every pair of onsets up to 3 s apart, how close their gap
// comes to a whole number of periods, minus what chance would give (so short periods don't win
// just by having more multiples). A log-Gaussian prior around 100 bpm and one around the typical
// gap between notes pick among periods when the take is sparse.
function r2Period(on, w, minBpm, maxBpm, ioi) {
  const lo = Math.floor(60 * R2_FPS / maxBpm), hi = Math.ceil(60 * R2_FPS / minBpm), sig = 0.035;
  const pairs = [];
  let norm = 0;
  for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length && on[j].t - on[i].t <= 3; j++) {
    if (on[j].t - on[i].t < 0.1) continue;
    pairs.push([on[j].t - on[i].t, w[i] * w[j]]); norm += w[i] * w[j];
  }
  let best = Math.round(60 * R2_FPS / 100), bs = -Infinity;
  for (let L = lo; L <= hi; L++) {
    const P = L / R2_FPS, chance = sig * Math.sqrt(2 * Math.PI) / P;
    let s = 0;
    for (const [d, ww] of pairs) {
      const k = Math.max(1, Math.round(d / P)), e = d - k * P;
      s += ww * (Math.exp(-0.5 * (e / sig) ** 2) - chance);
    }
    let prior = Math.exp(-0.5 * (Math.log2(60 / P / 100) / 0.8) ** 2);
    // the beat is usually about the typical gap between notes
    if (ioi) prior *= Math.exp(-0.5 * (Math.log2(P / ioi) / 1.0) ** 2);
    const v = (0.15 + Math.max(0, norm ? s / norm : 0)) * prior;
    if (v > bs) { bs = v; best = L; }
  }
  return best;
}

// Dynamic programming over (beat frame, period): each beat earns the onset envelope at its frame,
// pays for a period change from the beat before (so the tempo can drift slowly but not jump) and a
// little for straying far from the global tempo. Returns beat times in seconds.
function r2BeatDP(O, P0, from, opts) {
  const T = O.length;
  let mean = 0, sd = 0;
  for (const v of O) mean += v;
  mean /= T;
  for (const v of O) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / T) || 1;
  const on = Float32Array.from(O, v => (v - mean) / sd);
  const pMin = Math.max(Math.floor(P0 * 0.75), Math.floor(60 * R2_FPS / (opts.maxBpm || 180))),
    pMax = Math.min(Math.ceil(P0 * 1.33), Math.ceil(60 * R2_FPS / (opts.minBpm || 60)));
  const np = pMax - pMin + 1, lam = opts.tightness ?? 3000, mu = 2;
  const C = new Float32Array(T * np).fill(-Infinity), back = new Int32Array(T * np).fill(-1);
  for (let t = 0; t < T; t++) {
    for (let pi = 0; pi < np; pi++) {
      const p = pMin + pi, prevT = t - p;
      const base = on[t] - mu * Math.log(p / P0) ** 2;
      if (prevT < 0) { C[t * np + pi] = base; continue; }
      const d = Math.max(1, Math.round(0.06 * p));
      let best = 0, bk = -1;          // starting fresh here is worth 0 only near the start
      if (prevT >= pMax) best = -Infinity;
      for (let qi = Math.max(0, pi - d); qi <= Math.min(np - 1, pi + d); qi++) {
        const v = C[prevT * np + qi] - lam * Math.log(p / (pMin + qi)) ** 2;
        if (v > best) { best = v; bk = qi; }
      }
      C[t * np + pi] = base + best; back[t * np + pi] = bk;
    }
  }
  let bt = -1, bp = -1, bv = -Infinity;
  for (let t = Math.max(0, T - pMax); t < T; t++) for (let pi = 0; pi < np; pi++)
    if (C[t * np + pi] > bv) { bv = C[t * np + pi]; bt = t; bp = pi; }
  const frames = [];
  while (bt >= 0 && bp >= 0) {
    frames.push(bt);
    const q = back[bt * np + bp], pt = bt - (pMin + bp);
    if (q < 0) break;
    bt = pt; bp = q;
  }
  return frames.reverse().map(f => from + f / R2_FPS);
}

// Pull beats onto nearby onsets (the DP works on a 10 ms grid; onsets are sharper).
function r2SnapBeats(beats, onsets, pull) {
  return beats.map((b, i) => {
    const per = i + 1 < beats.length ? beats[i + 1] - b : b - beats[i - 1], tol = 0.08 * per;
    let best = null;
    for (const o of onsets) if (Math.abs(o.t - b) < tol && o.strength >= 0.25 && (!best || Math.abs(o.t - b) < Math.abs(best.t - b))) best = o;
    return best ? b + pull * (best.t - b) : b;
  });
}

// Beats before the first onset and after the last carry no evidence: step them out with the
// period of the nearest four beats that do.
function r2Anchor(beats, first, last) {
  const b = beats.slice(), n = b.length;
  let i0 = b.findIndex(t => t >= first - 0.1), i1 = n - 1;
  while (i1 > 0 && b[i1] > last + 0.1) i1--;
  if (i0 < 0 || i1 - i0 < 4) return b;
  const pa = (b[i0 + 4] - b[i0]) / 4, pb = (b[i1] - b[i1 - 4]) / 4;
  for (let i = i0 - 1; i >= 0; i--) b[i] = b[i + 1] - pa;
  for (let i = i1 + 1; i < n; i++) b[i] = b[i - 1] + pb;
  return b;
}

// Trim / extend so the beats run from one beat before the first onset to one after the last
// sound, stepping with the local period at each end.
function r2Cover(beats, first, last) {
  const b = beats.slice();
  if (b.length < 2) return b;
  while (b.length > 2 && b[1] <= first - 0.02) b.shift();
  while (b[0] > first - 0.02) b.unshift(b[0] - (b[1] - b[0]));
  if (first - b[0] < 0.5 * (b[1] - b[0])) b.unshift(b[0] - (b[1] - b[0]));
  while (b.length > 2 && b[b.length - 2] >= last) b.pop();
  while (b[b.length - 1] < last) b.push(2 * b[b.length - 1] - b[b.length - 2]);
  b.push(2 * b[b.length - 1] - b[b.length - 2]);
  return b;
}

// Meter, downbeat and pickup from accents on beats: onset strength, longer for notes held
// long. Like detectMeter, scored relative to chance with 4 slightly preferred over 3, then 2.
function r2Meter(beats, onsets, notes, forced) {
  const map = { beats };
  const acc = new Float64Array(beats.length);
  const w = r2Weights(onsets, notes);
  let firstBeat = Infinity;
  onsets.forEach((o, i) => {
    const b = beatOf(map, o.t), k = Math.round(b);
    if (o.strength >= 0.25) firstBeat = Math.min(firstBeat, Math.floor(b + 0.2));
    if (Math.abs(b - k) > 0.15 || k < 0 || k >= beats.length) return;
    let len = 1;
    const n = notes && notes.find(m => Math.abs(m.start - o.t) < 0.06);
    if (n) len = beatOf(map, n.end) - b;
    else if (onsets[i + 1]) len = beatOf(map, onsets[i + 1].t) - b;
    acc[k] += w[i] * (1 + 0.6 * r2Clamp(len, 0, 4));
  });
  if (!isFinite(firstBeat)) firstBeat = 1;
  let best = null;
  const tries = forced ? [[forced, 1]] : [[4, 1.1], [3, 1.0], [2, 0.85]];
  let all = 0;
  for (const a of acc) all += a;
  for (const [M, prior] of tries) for (let ph = 0; ph < M; ph++) {
    let on = 0;
    for (let k = ph; k < acc.length; k += M) on += acc[k];
    const s = (all ? on / all : 0) * M * prior;
    if (!best || s > best.s) best = { M, ph, s };
  }
  let offset = best.ph;
  while (offset < firstBeat) offset += best.M;
  return { meter: { beats: best.M, offset }, pickup: offset - firstBeat };
}

// Tempo summary: median bpm and drift (spread of the local tempo, 0..1).
function r2Summary(beats, onsets) {
  const per = [];
  for (let i = 1; i < beats.length; i++) per.push(beats[i] - beats[i - 1]);
  const bpms = per.map(p => 60 / p).sort((a, b) => a - b);
  const bpm = median(bpms);
  const loc = [];
  for (let i = 0; i + 4 <= per.length; i++) loc.push(240 / per.slice(i, i + 4).reduce((a, b) => a + b, 0));
  loc.sort((a, b) => a - b);
  const q = f => loc.length ? loc[Math.min(loc.length - 1, Math.floor(f * loc.length))] : bpm;
  const drift = r2Clamp((q(0.95) - q(0.05)) / bpm / 0.3, 0, 1);
  // confidence: share of onset strength on the beat, half-beat or third-beat grid
  const map = { beats };
  let on = 0, all = 0;
  for (const o of onsets) {
    const b = beatOf(map, o.t);
    const e = Math.min(Math.abs(b - Math.round(b)), Math.abs(2 * b - Math.round(2 * b)) / 2 + 0.02, Math.abs(3 * b - Math.round(3 * b)) / 3 + 0.04);
    all += o.strength; if (e < 0.07) on += o.strength;
  }
  return { bpm: Math.round(bpm * 10) / 10, drift: Math.round(drift * 100) / 100, confidence: all ? Math.round(on / all * 100) / 100 : 0 };
}

// Beat map from onsets. opts: { notes (score notes, for held-note accents), end (s),
// minBpm 60, maxBpm 180, meter (force 2|3|4), tightness }.
function trackBeats(onsets, opts = {}) {
  const on = onsets.filter(o => o.strength > 0.05).sort((a, b) => a.t - b.t);
  if (on.length < 3) return null;
  const first = on[0].t;
  const lastSound = Math.max(on[on.length - 1].t, ...(opts.notes || []).map(n => n.end));
  const from = first - 1.5, T = Math.ceil((lastSound + 1.5 - from) * R2_FPS);
  const w = r2Weights(on, opts.notes);
  const O = r2OnsetEnv(on, w, from, T);
  const gaps = [];
  for (let i = 1; i < on.length; i++) if (on[i].strength >= 0.3 && on[i].t - on[i - 1].t >= 0.1) gaps.push(on[i].t - on[i - 1].t);
  const ioi = gaps.length >= 4 ? median(gaps) : null;
  const P0 = opts.bpm ? 60 * R2_FPS / opts.bpm : r2Period(on, w, opts.minBpm || 60, opts.maxBpm || 180, ioi);
  let beats = r2BeatDP(O, P0, from, opts);
  if (beats.length < 2) return null;
  beats = r2Anchor(r2SnapBeats(beats, on, 0.4), first, on[on.length - 1].t);
  beats = r2Cover(beats, first, lastSound);
  const m = r2Meter(beats, on, opts.notes, opts.meter);
  return { beats, ...r2Summary(beats, on), meter: m.meter, pickup: m.pickup, source: 'tracked' };
}

// ---------- 4. beats from taps ----------
// The user taps the beat while the take plays. Remove the tap latency (the shift that best lines
// taps up with onsets), mend skipped and doubled taps by tempo continuity, pull each beat gently
// onto a strong onset nearby, smooth the rest, and extend to cover the take.
function beatsFromTaps(taps, onsets, opts = {}) {
  let tp = taps.slice().sort((a, b) => a - b);
  if (tp.length < 3) return null;
  const on = onsets.filter(o => o.strength > 0.05);
  // latency: 0..250 ms, a mild preference for typical human delays
  let lat = 0, ls = -Infinity;
  for (let d = 0; d <= 0.25; d += 0.0025) {
    let s = 0;
    for (const t of tp) for (const o of on) { const e = t - d - o.t; if (Math.abs(e) < 0.12) s += o.strength * Math.exp(-0.5 * (e / 0.03) ** 2); }
    s *= 1 - 0.15 * Math.abs(d - 0.07) / 0.25;
    if (s > ls) { ls = s; lat = d; }
  }
  if (opts.latency != null) lat = opts.latency;
  tp = tp.map(t => t - lat);
  // typical period, then mend doubles and gaps against the local period
  const iois = [];
  for (let i = 1; i < tp.length; i++) iois.push(tp[i] - tp[i - 1]);
  let P = median(iois);
  const near = t => on.reduce((s, o) => s + o.strength * Math.exp(-0.5 * ((o.t - t) / 0.04) ** 2), 0);
  const clean = [tp[0]];
  for (let i = 1; i < tp.length; i++) {
    const t = tp[i], last = clean[clean.length - 1], gap = t - last;
    if (gap < 0.55 * P) {
      // a double: keep whichever sits better (onset nearby, and one period after the beat before)
      const before = clean[clean.length - 2] ?? last - P;
      const fit = x => near(x) - 4 * ((x - before - P) / P) ** 2;
      if (fit(t) > fit(last)) clean[clean.length - 1] = t;
      continue;
    }
    const k = Math.round(gap / P);
    for (let j = 1; j < k; j++) clean.push(last + gap * j / k);
    clean.push(t);
    if (clean.length >= 4) P = median(clean.slice(-5).map((v, j, a) => j ? v - a[j - 1] : NaN).filter(v => !isNaN(v)));
  }
  // pull onto strong onsets, then smooth beats that found none
  let beats = r2SnapBeats(clean, on, 0.8);
  const snapped = beats.map((b, i) => Math.abs(b - clean[i]) > 1e-9);
  for (let pass = 0; pass < 3; pass++) {
    beats = beats.map((b, i) => (snapped[i] || i === 0 || i === beats.length - 1) ? b : 0.5 * b + 0.25 * (beats[i - 1] + beats[i + 1]));
  }
  const first = on.length ? Math.min(on[0].t, beats[0]) : beats[0];
  const lastSound = Math.max(on.length ? on[on.length - 1].t : 0, ...(opts.notes || []).map(n => n.end), opts.end ? Math.min(opts.end, beats[beats.length - 1]) : 0);
  beats = r2Cover(beats, first, lastSound);
  const m = r2Meter(beats, on, opts.notes, opts.meter);
  return { beats, ...r2Summary(beats, on), meter: m.meter, pickup: m.pickup, latency: lat, source: 'taps' };
}

// ---------- 5. quantize on the beat map ----------
// Cost of a note value (beats): plain values free, dotted dearer, triplets and tied values more.
function r2ValueCost(d) {
  const is = v => Math.abs(d - v) < 1e-6;
  if ([4, 2, 1, 0.5, 0.25].some(is)) return 0;
  if ([3, 1.5, 0.75].some(is)) return 0.5;
  if ([1 / 3, 2 / 3, 1 / 6].some(is)) return 0.4;
  return 1;
}

// Cost of a position inside the beat: on the beat free, off-beats a little, finer steps more.
function r2PosCost(q) {
  const f = q - Math.floor(q + 1e-9);
  if (f < 1e-6 || f > 1 - 1e-6) return 0;
  if (Math.abs(f - 0.5) < 1e-6) return 0.15;
  if (Math.abs(f - 0.25) < 1e-6 || Math.abs(f - 0.75) < 1e-6) return 0.4;
  if (Math.abs(f - 1 / 3) < 1e-6 || Math.abs(f - 2 / 3) < 1e-6) return 0.3;
  return 0.7;
}

// Beats that clearly hold a triplet: two or more onsets inside the beat that fit thirds much
// better than the duple grid (and the duple grid would crowd them).
function r2TripletBeats(xs, res) {
  const out = new Set(), byBeat = new Map();
  for (const x of xs) {
    const b = Math.floor(x + 0.12);
    if (!byBeat.has(b)) byBeat.set(b, []);
    byBeat.get(b).push(x - b);
  }
  for (const [b, fs] of byBeat) {
    if (fs.length < 2) continue;
    let dup = 0, tri = 0;
    const dupSlots = new Set(), triSlots = new Set();
    for (const f of fs) {
      const qd = Math.round(f * res) / res, qt = Math.round(f * 3) / 3;
      dup += (f - qd) ** 2; tri += (f - qt) ** 2;
      dupSlots.add(qd); triSlots.add(qt);
    }
    const hasThird = [...triSlots].some(q => Math.abs(q - 1 / 3) < 1e-6 || Math.abs(q - 2 / 3) < 1e-6);
    const crowded = dupSlots.size < fs.length;
    if (hasThird && triSlots.size === fs.length && tri < 0.35 * dup && (crowded || dup / fs.length > 0.06 ** 2 * 2.5)) out.add(b);
  }
  return out;
}

// Set qs/qe (steps of `res` per beat of the beat map) on each note: the simplest rhythm that
// fits the sung times. opts: { res: 2, triplets: true, motifs: true, sigma: 0.08 (beats) }.
// Triplet notes get qs/qe in thirds of a beat (fractional steps when res is not a multiple of 3)
// and tuplet: 3.
function quantizeRhythm(notes, beatMap, opts = {}) {
  const res = opts.res || 2, g = 1 / res, sig = opts.sigma || 0.08;
  if (!notes.length || !beatMap || beatMap.beats.length < 2) return notes;
  const xs = notes.map(n => beatOf(beatMap, n.start));
  const ys = notes.map(n => beatOf(beatMap, n.end));
  const trip = opts.triplets === false ? new Set() : r2TripletBeats(xs, res);
  const cands = xs.map(x => {
    const c = new Set();
    for (let k = Math.floor(x / g) - 2; k <= Math.ceil(x / g) + 2; k++) c.add(+(k * g).toFixed(9));
    for (const b of [Math.floor(x + 0.12), Math.floor(x + 0.12) - 1]) if (trip.has(b)) for (let k = 0; k < 3; k++) c.add(+(b + k / 3).toFixed(9));
    return [...c].filter(q => Math.abs(q - x) <= 2.01 * g || trip.has(Math.floor(q + 1e-9)));
  });
  const fit = (x, q) => ((x - q) / sig) ** 2;
  // a short break before the next note is articulation, not a written rest
  const legato = i => notes[i + 1] && (ys[i] > xs[i + 1] - Math.max(0.45, 0.3 * (xs[i + 1] - xs[i])) || notes[i + 1].start - notes[i].end < 0.12);
  const ioiCost = (i, d) => (legato(i) ? 1 : 0.3) * r2ValueCost(d);
  // DP over onsets
  let prev = cands[0].map(q => ({ q, cost: fit(xs[0], q) + r2PosCost(q), from: -1 }));
  const rows = [prev];
  for (let i = 1; i < notes.length; i++) {
    let row = cands[i].map(q => {
      let best = Infinity, from = -1;
      prev.forEach((p, j) => {
        if (q <= p.q + 1e-9) return;
        const v = p.cost + ioiCost(i - 1, q - p.q);
        if (v < best) { best = v; from = j; }
      });
      return { q, cost: best + fit(xs[i], q) + r2PosCost(q), from };
    }).filter(r => r.from >= 0);
    if (!row.length) {
      // crowded: put it one step after the best previous choice
      let j = 0;
      prev.forEach((p, k) => { if (p.cost < prev[j].cost) j = k; });
      row = [{ q: prev[j].q + g, cost: prev[j].cost + 5, from: j }];
    }
    rows.push(row); prev = row;
  }
  let j = 0;
  prev.forEach((p, k) => { if (p.cost < prev[j].cost) j = k; });
  const q = new Array(notes.length);
  for (let i = notes.length - 1; i >= 0; i--) { q[i] = rows[i][j].q; j = rows[i][j].from; }
  if (opts.motifs !== false) r2Motifs(notes, xs, q, sig);
  // ends: legato to the next onset, otherwise the plainest value near the sung end
  const qe = q.map((s, i) => {
    const nx = q[i + 1], isTrip = trip.has(Math.floor(s + 1e-9));
    if (nx != null && legato(i)) return nx;
    const step = isTrip ? 1 / 3 : g;
    let best = null;
    for (let k = 1; k <= 64; k++) {
      const e = +(s + k * step).toFixed(9);
      if (nx != null && e > nx + 1e-9) break;
      const rest = nx != null ? nx - e : 0;
      // detached notes are released a little early: aim slightly past the sung end
      const c = ((ys[i] + 0.12 * (ys[i] - s) - e) / 0.2) ** 2 + r2ValueCost(e - s) + (rest > 1e-9 ? 0.3 * r2ValueCost(rest) : 0);
      if (!best || c < best.c) best = { e, c };
      if (e > ys[i] + 2) break;
    }
    return best ? best.e : (nx ?? s + step);
  });
  const offGrid = v => Math.abs(v * res - Math.round(v * res)) > 1e-6;
  notes.forEach((n, i) => {
    n.qs = +(q[i] * res).toFixed(6); n.qe = +(qe[i] * res).toFixed(6);
    if (offGrid(q[i]) || offGrid(qe[i])) n.tuplet = 3; else delete n.tuplet;
  });
  return notes;
}

// Repeated motifs (same 3 intervals, similar sung timing) get one notated rhythm: the one that
// fits all repeats best. Onset positions inside each repeat are rewritten from its first note.
function r2Motifs(notes, xs, q, sig) {
  const L = 4, groups = new Map();
  for (let i = 0; i + L <= notes.length; i++) {
    const key = [];
    for (let k = 1; k < L; k++) key.push(notes[i + k].midi - notes[i + k - 1].midi);
    const k = key.join(',');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const iois = (arr, i) => { const v = []; for (let k = 1; k < L; k++) v.push(arr[i + k] - arr[i + k - 1]); return v; };
  for (const occ of groups.values()) {
    if (occ.length < 2) continue;
    // occurrences whose sung timing matches the first one's
    const raw0 = iois(xs, occ[0]);
    const same = occ.filter(i => iois(xs, i).every((v, k) => Math.abs(v - raw0[k]) < 0.3));
    if (same.length < 2) continue;
    const pats = same.map(i => iois(q, i));
    let best = null;
    for (const p of pats) {
      let c = 0;
      for (const i of same) iois(xs, i).forEach((v, k) => { c += ((v - p[k]) / sig) ** 2 / 2; });
      c += p.reduce((s, d) => s + r2ValueCost(d), 0) * same.length;
      if (!best || c < best.c) best = { p, c };
    }
    for (const i of same) {
      const nq = [q[i]];
      for (let k = 1; k < L; k++) nq.push(nq[k - 1] + best.p[k - 1]);
      const after = q[i + L];
      if (after != null && nq[L - 1] >= after - 1e-9) continue;
      for (let k = 1; k < L; k++) q[i + k] = +nq[k].toFixed(9);
    }
  }
}
