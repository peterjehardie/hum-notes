// Pure analysis and synthesis: note splitting, expression, tempo, auto-tune, file export.
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const INTERVALS = ['Root', 'm2', 'M2', 'm3', 'M3', '4th', 'Tritone', '5th', 'm6', 'M6', 'm7', 'M7'];
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };

const hzToMidi = f => 69 + 12 * Math.log2(f / 440);
const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
const pcOf = m => ((m % 12) + 12) % 12;
const noteName = m => NAMES[pcOf(m)] + (Math.floor(m / 12) - 1);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

function snapTo(m, mode, root) {
  const r = Math.round(m);
  if (mode === 'chrom') return r;
  const sc = SCALES[mode];
  let best = r, bd = 99;
  for (let k = r - 2; k <= r + 2; k++) {
    if (!sc.includes(pcOf(k - root))) continue;
    const dd = Math.abs(k - m);
    if (dd < bd) { bd = dd; best = k; }
  }
  return best;
}

// ---------- note splitting ----------
// A new note starts after 60 ms of steady change or 35 ms of silence; notes under 80 ms are dropped.
class Segmenter {
  constructor(snap, onNote) {
    this.snap = snap; this.onNote = onNote;
    this.notes = []; this.cur = null; this.dev = null; this.silence = null; this.hist = [];
  }
  push(t, m) {
    if (isNaN(m)) {
      this.hist.length = 0;
      if (this.cur) {
        if (this.silence == null) this.silence = t;
        else if (t - this.silence > 0.035) this.close(this.silence);
      }
      return;
    }
    this.silence = null;
    this.hist.push(m); if (this.hist.length > 5) this.hist.shift();
    const ms = median(this.hist);
    if (!this.cur) { this.cur = { start: t, end: t, ms: [ms] }; this.dev = null; return; }
    const ref = this.snap(median(this.cur.ms.slice(-40)));
    if (Math.abs(ms - ref) > 0.65) {
      if (!this.dev) this.dev = { start: t, ms: [] };
      this.dev.ms.push(ms);
      if (t - this.dev.start > 0.06) {
        const d = this.dev;
        this.close(d.start);
        this.cur = { start: d.start, end: t, ms: d.ms };
      }
    } else {
      if (this.dev) { this.cur.ms.push(...this.dev.ms); this.dev = null; }
      this.cur.ms.push(ms); this.cur.end = t;
    }
  }
  close(t) {
    const c = this.cur; this.cur = null; this.dev = null;
    if (!c) return;
    c.end = t;
    if (c.end - c.start < 0.08) return;
    this.notes.push({ start: c.start, end: c.end, midi: this.snap(median(c.ms)) });
    this.onNote && this.onNote();
  }
  live() {
    if (!this.cur) return null;
    return { start: this.cur.start, end: this.cur.end, midi: this.snap(median(this.cur.ms.slice(-40))) };
  }
}

// Mean pitch over +-half seconds around each voiced point.
function slowPitch(pts, half) {
  const out = new Array(pts.length);
  let a = 0, b = 0, sum = 0, n = 0;
  for (let i = 0; i < pts.length; i++) {
    while (b < pts.length && pts[b].t <= pts[i].t + half) { if (!isNaN(pts[b].m)) { sum += pts[b].m; n++; } b++; }
    while (pts[a].t < pts[i].t - half) { if (!isNaN(pts[a].m)) { sum -= pts[a].m; n--; } a++; }
    out[i] = n ? sum / n : NaN;
  }
  return out;
}

const glideThreshold = detail => 2 - 1.6 * detail;

// Fold very short notes (under minDur) into a touching neighbour within a semitone: these are
// flickers between two notes when the voice sits near the line between them, not notes sung.
// Same-pitch pieces split only by a pitch wobble (no real gap) become one note again.
function mergeFragments(notes, minDur = 0.15) {
  const out = notes.map(n => ({ ...n }));
  const touches = (a, b) => b.start - a.end < 0.06;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const n = out[i];
      if (n.end - n.start >= minDur) continue;
      const prev = out[i - 1], next = out[i + 1];
      const okPrev = prev && Math.abs(prev.midi - n.midi) <= 1 && touches(prev, n);
      const okNext = next && Math.abs(next.midi - n.midi) <= 1 && touches(n, next);
      const tgt = okPrev && okNext ? (prev.end - prev.start >= next.end - next.start ? prev : next) : okPrev ? prev : okNext ? next : null;
      if (!tgt) continue;
      tgt.start = Math.min(tgt.start, n.start); tgt.end = Math.max(tgt.end, n.end);
      out.splice(i, 1); changed = true;
      break;
    }
  }
  for (let i = out.length - 1; i > 0; i--)
    if (out[i].midi === out[i - 1].midi && out[i].start - out[i - 1].end < 0.02) { out[i - 1].end = out[i].end; out.splice(i, 1); }
  return out;
}

// Voiced pitch values inside a note.
function contourOf(n, pts) {
  const c = [];
  for (const p of pts) if (p.t >= n.start && p.t <= n.end && !isNaN(p.m)) c.push(p.m);
  return c;
}

// The splitter cuts a slide into stepping pieces. With detail on, touching notes that
// keep moving one way are joined back into one note that bends from where it started.
function mergeGlides(notes, pts, detail) {
  if (detail <= 0 || notes.length < 2) return notes;
  const info = notes.map(n => {
    const c = contourOf(n, pts), e = Math.max(2, Math.round(c.length * 0.25));
    return c.length < 4 ? { move: 0 } : { move: median(c.slice(-e)) - median(c.slice(0, e)) };
  });
  const out = [];
  for (let i = 0; i < notes.length;) {
    let j = i;
    const dir = Math.sign(notes[i + 1] ? notes[i + 1].midi - notes[i].midi : 0);
    while (j + 1 < notes.length && notes[j + 1].start - notes[j].end < 0.04
      && Math.sign(notes[j + 1].midi - notes[j].midi) === dir
      && (Math.abs(info[j].move) > 0.5 || Math.abs(info[j + 1].move) > 0.5)) j++;
    if (j > i && Math.abs(notes[j].midi - notes[i].midi) >= glideThreshold(detail)) {
      out.push({ start: notes[i].start, end: notes[j].end, midi: notes[i].midi, joined: true });
    } else for (let k = i; k <= j; k++) out.push(notes[k]);
    i = j + 1;
  }
  return out;
}

// ---------- expression ----------
// detail 0: plain semitone notes. Higher detail keeps microtones, glides and vibrato
// with smaller and smaller thresholds; at full detail every note keeps its sung contour.
function describeNotes(notes, pts, detail) {
  let k = 0;
  for (const n of notes) {
    n.offset = 0; n.glide = 0; n.vib = null; n.bend = null;
    noteCurves(n, pts);
    while (k < pts.length && pts[k].t < n.start) k++;
    const c = [];
    for (let j = k; j < pts.length && pts[j].t <= n.end; j++) if (!isNaN(pts[j].m)) c.push(pts[j]);
    if (c.length < 6) continue;
    const ms = c.map(p => p.m);
    const a = Math.floor(ms.length * 0.2), b = Math.max(a + 1, Math.ceil(ms.length * 0.8));
    const center = median(ms.slice(a, b));
    const edge = Math.max(2, Math.round(ms.length * 0.2));
    const glide = median(ms.slice(-edge)) - median(ms.slice(0, edge));
    const slow = slowPitch(c, 0.12);
    let zc = 0, ss = 0, prev = 0;
    for (let i = 0; i < ms.length; i++) {
      const r = ms[i] - slow[i];
      ss += r * r;
      if (i && Math.sign(r) !== Math.sign(prev)) zc++;
      prev = r;
    }
    const dur = c[c.length - 1].t - c[0].t;
    const rate = zc / 2 / Math.max(dur, 1e-3);
    const extent = 2 * Math.SQRT2 * Math.sqrt(ss / ms.length) * 100;
    const cents = (center - n.midi) * 100;
    n.center = center;
    if (detail <= 0) continue;

    const microT = 45 - 33 * detail, vibT = 100 - 75 * detail;
    if (n.joined || Math.abs(glide) > glideThreshold(detail)) n.glide = glide;
    else if (Math.abs(cents) > microT && Math.abs(cents) <= 50) n.offset = Math.round(cents / 5) * 0.05;
    if (dur > 0.25 && rate > 3.5 && rate < 9 && extent > vibT) n.vib = { rate, extent };
    if (n.glide || n.vib || detail >= 0.97) n.bend = n.curve;
  }
}

// Sung pitch (semitones from the note) and loudness, sampled every 20 ms.
function noteCurves(n, pts) {
  n.curve = []; n.amp = [];
  const c = pts.filter(p => p.t >= n.start && p.t <= n.end);
  let lastT = -1;
  for (let i = 0; i < c.length; i++) {
    if (c[i].t - lastT < 0.02 && i < c.length - 1) continue;
    lastT = c[i].t;
    n.amp.push([c[i].t, c[i].r]);
    const near = c.slice(Math.max(0, i - 1), i + 2).map(p => p.m).filter(m => !isNaN(m));
    if (near.length) n.curve.push([c[i].t, median(near) - n.midi]);
  }
}

// Strength of harmonics 1..K in the middle of a note, measured on the recording
// with a 6-period Hann window at k * f0. Normalised so the strongest is 1.
function harmonicProfile(x, sr, x0, pts, n, K = 24) {
  const len = n.end - n.start;
  const mid = pts.filter(p => p.t >= n.start + len * 0.2 && p.t <= n.end - len * 0.2 && !isNaN(p.m));
  if (!mid.length) return null;
  const acc = new Float32Array(K);
  const step = Math.max(1, Math.floor(mid.length / 6));
  for (let j = 0; j < mid.length; j += step) {
    const p = mid[j], f = midiToHz(p.m);
    const L = Math.min(4096, Math.round(sr / f * 6));
    const s = Math.round((p.t - x0) * sr) - (L >> 1);
    if (s < 0 || s + L > x.length) continue;
    for (let k = 1; k <= K && k * f < sr * 0.45; k++) {
      const w = 2 * Math.PI * k * f / sr, cw = Math.cos(w), sw = Math.sin(w);
      let re = 0, im = 0, c = 1, si = 0;
      for (let i = 0; i < L; i++) {
        const v = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / L));
        re += v * c; im -= v * si;
        const nc = c * cw - si * sw; si = si * cw + c * sw; c = nc;
      }
      acc[k - 1] += Math.hypot(re, im) / L;
    }
  }
  let mx = 0;
  for (const v of acc) mx = Math.max(mx, v);
  return mx ? acc.map(v => v / mx) : null;
}

// ---------- score: clean notes for composing, with the performance kept per note ----------
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const KEY_PROFILES = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};
// keys written with flats: F, B♭, E♭, A♭, D♭, G♭ major and their relative minors
const usesFlats = key => !!key && (key.mode === 'major' ? [5, 10, 3, 8, 1, 6] : [2, 7, 0, 5, 10, 3]).includes(key.root);
const spell = (m, key) => (usesFlats(key) ? FLAT_NAMES : NAMES)[pcOf(m)] + (Math.floor(m / 12) - 1);
const keyName = key => key ? (usesFlats(key) ? FLAT_NAMES : NAMES)[key.root] + (key.mode === 'major' ? ' major' : ' minor') : '';

// The singer's own reference pitch: circular mean of where steady pitch sits between the
// semitones. Returns an offset in semitones (+0.35 = 35 cents sharp of A440) and how
// consistent it is (0..1). Inconsistent takes keep A440.
function estimateTuning(pts) {
  let re = 0, im = 0, n = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1].m, b = pts[i].m, c = pts[i + 1].m;
    if (isNaN(a) || isNaN(b) || isNaN(c) || Math.abs(b - a) > 0.03 || Math.abs(c - b) > 0.03) continue;
    re += Math.cos(2 * Math.PI * b); im += Math.sin(2 * Math.PI * b); n++;
  }
  if (n < 40) return { offset: 0, consistency: 0, used: false };
  const offset = Math.atan2(im, re) / (2 * Math.PI), consistency = Math.hypot(re, im) / n;
  return { offset, consistency, used: consistency >= 0.2 };
}

// Krumhansl–Schmuckler: correlate a pitch-class histogram with every key's profile.
// Returns all 24 keys, best first.
function keysFromHistogram(h) {
  if (!h.some(v => v > 0)) return [];
  const corr = (x, y) => {
    const mx = x.reduce((a, b) => a + b) / 12, my = y.reduce((a, b) => a + b) / 12;
    let sxy = 0, sx = 0, sy = 0;
    for (let i = 0; i < 12; i++) { sxy += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
    return sxy / Math.sqrt(sx * sy || 1);
  };
  const out = [];
  for (const mode of ['major', 'minor']) for (let root = 0; root < 12; root++) {
    const prof = KEY_PROFILES[mode].map((_, i) => KEY_PROFILES[mode][(i - root + 12) % 12]);
    out.push({ root, mode, fit: corr(h, prof) });
  }
  return out.sort((a, b) => b.fit - a.fit);
}

// The key of a melody. Ears hear "home" where a phrase comes to rest, so besides how long each
// note lasts, a note that ends a phrase (a gap after it, or held long) counts double, the very
// last note three times, the first note a little extra. Also returns the runner-up key and the
// margin between them (under ~0.1 the two are close; relative major/minor is the usual pair).
function detectKey(notes) {
  const h = new Array(12).fill(0);
  notes.forEach((n, i) => {
    const next = notes[i + 1], dur = Math.min(2, n.end - n.start);
    let w = 1;
    if (!next || next.start - n.end > 0.3 || n.end - n.start > 0.8) w *= 2;
    if (!next) w *= 1.5;
    if (i === 0) w *= 1.3;
    h[pcOf(n.midi)] += dur * w;
  });
  const ranked = keysFromHistogram(h);
  if (!ranked.length) return null;
  return { ...ranked[0], runnerUp: ranked[1], margin: ranked[0].fit - ranked[1].fit };
}

// How one note was sung: centre, steady stretch, drift, scoop in, fall off, vibrato, loudness,
// and the pitch curve relative to the centre. `c` holds the note's voiced points (tuning removed).
function noteBlob(c) {
  const ms = c.map(p => p.m), t0 = c[0].t, t1 = c[c.length - 1].t, dur = t1 - t0;
  const a = Math.floor(ms.length * 0.2), b = Math.max(a + 1, Math.ceil(ms.length * 0.8));
  const center = median(ms.slice(a, b));
  let plateau = 0, runStart = null;
  for (const p of c) {
    if (Math.abs(p.m - center) < 0.35) { if (runStart == null) runStart = p.t; plateau = Math.max(plateau, p.t - runStart); }
    else runStart = null;
  }
  const mid = c.slice(a, b);
  let drift = 0;
  if (mid.length > 4) {
    const mt = mid.reduce((s, p) => s + p.t, 0) / mid.length, mm = mid.reduce((s, p) => s + p.m, 0) / mid.length;
    let num = 0, den = 0;
    for (const p of mid) { num += (p.t - mt) * (p.m - mm); den += (p.t - mt) ** 2; }
    drift = den ? num / den * 100 : 0;   // cents per second
  }
  const edge = (from, to) => { const v = c.filter(p => p.t >= from && p.t <= to).map(p => p.m); return v.length ? median(v) - center : 0; };
  const scoop = edge(t0, t0 + 0.06), fall = edge(t1 - 0.06, t1);
  const slow = slowPitch(c, 0.12), res = ms.map((m, i) => m - slow[i]);
  let maxAbs = 0;
  for (const r of res) maxAbs = Math.max(maxAbs, Math.abs(r));
  let zc = 0, ss = 0, prev = 0, peakT = null;
  res.forEach((r, i) => {
    ss += r * r;
    if (i && Math.sign(r) !== Math.sign(prev)) zc++;
    if (peakT == null && Math.abs(r) > maxAbs * 0.5) peakT = c[i].t;
    prev = r;
  });
  const rate = zc / 2 / Math.max(dur, 1e-3), depth = 2 * Math.SQRT2 * Math.sqrt(ss / ms.length) * 100;
  const vib = dur > 0.3 && rate > 3.5 && rate < 9 && depth > 25 ? { rate, depth, delay: (peakT ?? t0) - t0 } : null;
  const curve = [];
  let lastT = -1;
  c.forEach((p, i) => { if (p.t - lastT >= 0.02 || i === c.length - 1) { curve.push([p.t, p.m - center]); lastT = p.t; } });
  const amp = [];
  lastT = -1;
  c.forEach(p => { if (p.t - lastT >= 0.02) { amp.push([p.t, p.r]); lastT = p.t; } });
  return {
    center, plateau, drift, vib, curve, amp, start: t0, end: t1,
    scoop: Math.abs(scoop) > 0.15 ? scoop : 0, fall: Math.abs(fall) > 0.15 ? fall : 0,
  };
}

// Hummed take -> clean score. Find the singer's tuning, split into notes, describe how each
// was sung, hand glide pieces to the notes they connect, find the key, keep notes clearly sung
// outside it and snap the rest into it, then put the notes on a beat grid.
function buildScore(pts, opt) {
  const tuning = opt.tuning === 'auto' ? estimateTuning(pts) : { offset: 0, consistency: 0, used: false };
  const off = tuning.used ? tuning.offset : 0;
  const sp = pts.map(p => ({ ...p, m: p.m - off }));
  const seg = new Segmenter(Math.round);
  for (const p of sp) seg.push(p.t, p.m);
  seg.close(opt.end);
  const notes = [];
  let k = 0;
  // detail 0..1 blends every clean-up threshold: low = a plain, singable score; high = keeps
  // grace notes, small passing notes and notes sung just outside the key
  const d = opt.detail ?? 0.5;
  for (const n of mergeFragments(seg.notes, 0.25 - 0.19 * d)) {
    while (k < sp.length && sp[k].t < n.start) k++;
    const c = [];
    for (let j = k; j < sp.length && sp[j].t <= n.end; j++) if (!isNaN(sp[j].m)) c.push(sp[j]);
    if (c.length < 4) continue;
    const perf = noteBlob(c);
    notes.push({ start: n.start, end: n.end, midi: Math.round(perf.center), perf });
  }
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.perf.plateau >= Math.min(0.16 - 0.1 * d, (n.end - n.start) * 0.5)) continue;
    const prev = notes[i - 1], next = notes[i + 1];
    const tp = prev && n.start - prev.end < 0.06, tn = next && next.start - n.end < 0.06;
    if (!tp && !tn) continue;
    if (tp && tn) { const midT = (n.start + n.end) / 2; prev.end = midT; next.start = midT; }
    else if (tp) prev.end = n.end; else next.start = n.start;
    notes.splice(i--, 1);
  }
  const key = opt.key && opt.key !== 'auto'
    ? { root: +opt.key.split(':')[0], mode: opt.key.split(':')[1], fit: null } : detectKey(notes);
  if (key) {
    const sc = SCALES[key.mode];
    for (const n of notes) {
      if (sc.includes(pcOf(n.midi - key.root))) continue;
      if (n.end - n.start >= 0.45 - 0.3 * d && Math.abs(n.perf.center - n.midi) <= 0.15 + 0.2 * d) { n.chromatic = true; continue; }
      n.midi = snapTo(n.perf.center, key.mode, key.root);
    }
  }
  for (let i = notes.length - 1; i > 0; i--)
    if (notes[i].midi === notes[i - 1].midi && notes[i].start - notes[i - 1].end < 0.03) {
      notes[i - 1].end = notes[i].end; notes.splice(i, 1);
    }
  const tempo = opt.grid ? { ...opt.grid, source: 'click' } : inferTempo(notes);
  let unit = null;
  if (tempo) { tempo.bpm *= opt.tempoScale || 1; unit = quantize(notes, tempo, opt.res); }
  // grace notes (a quick note leaning into a longer one) and slurs (notes joined with no break)
  notes.forEach((n, i) => {
    const next = notes[i + 1];
    if (!next) return;
    if (d >= 0.55 && n.end - n.start < 0.13 && next.end - next.start > 2 * (n.end - n.start)) n.grace = true;
    if (next.start - n.end < 0.04) n.slur = true;
  });
  return { tuning, key, tempo, unit, notes, detail: d };
}

// ---------- accompaniment: meter, groove and chords from the score ----------
// Positions are in beats from the score's tempo origin (note.qs / res).

// Meter and where bar 1 starts: the beats-per-bar and offset that put the most weight
// (long notes count more) on downbeats, relative to chance. 4/4 gets a slight preference.
function detectMeter(notes, res) {
  if (!notes.length) return { beats: 4, offset: 0 };
  let best = null;
  for (const [beats, prior] of [[4, 1.1], [3, 1.0], [2, 0.85]]) {
    for (let off = 0; off < beats; off++) {
      let on = 0, all = 0;
      for (const n of notes) {
        const pos = n.qs / res, w = (n.qe - n.qs) / res + 0.5;
        all += w;
        if (Math.abs(pos - off - Math.round((pos - off) / beats) * beats) < 1e-6) on += w;
      }
      const s = (on / all) * beats * prior;
      if (!best || s > best.s) best = { beats, offset: off, s };
    }
  }
  return { beats: best.beats, offset: best.offset };
}

// The melody's most common rhythm within a bar (onset positions in grid steps), used for the shaker.
function groovePattern(notes, meter, res) {
  const steps = meter.beats * res, counts = new Map();
  const bars = new Map();
  for (const n of notes) {
    const rel = n.qs - meter.offset * res, bar = Math.floor(rel / steps), pos = ((rel % steps) + steps) % steps;
    if (!bars.has(bar)) bars.set(bar, new Set());
    bars.get(bar).add(pos);
  }
  for (const set of bars.values()) { const key = [...set].sort((a, b) => a - b).join(','); counts.set(key, (counts.get(key) || 0) + 1); }
  let best = '0', bc = 0;
  for (const [k, c] of counts) if (c > bc || (c === bc && k.split(',').length > best.split(',').length)) { best = k; bc = c; }
  return { steps, hits: best.split(',').map(Number) };
}

const CHORD_SETS = {
  major: [[0, '', 'I'], [2, 'm', 'ii'], [4, 'm', 'iii'], [5, '', 'IV'], [7, '', 'V'], [9, 'm', 'vi'], [11, '°', 'vii°']],
  minor: [[0, 'm', 'i'], [2, '°', 'ii°'], [3, '', 'III'], [5, 'm', 'iv'], [7, '', 'V'], [8, '', 'VI'], [10, '', 'VII']],
};
// Harmony colours: chords borrowed from outside the key (each with a pull towards being chosen),
// and how chords are coloured when voiced (extra tones above the triad, in semitones).
//   plain: the key's own triads
//   modal: folk / old sound — the flat seventh chord, minor v, Dorian IV; open sus2 voicings
//   rich:  sevenths and ninths on every chord
//   dark:  minor-mode chords borrowed into major (iv, ♭VI, ♭VII, ♭III), the ♭II in minor
//   lift:  the heroic ♭VI – ♭VII – I climb, wide triads
const COLOURS = {
  plain: { major: [], minor: [] },
  modal: { major: [[10, '', '♭VII', 0.5], [7, 'm', 'v', 0.25]], minor: [[5, '', 'IV', 0.4], [7, 'm', 'v', 0.4]] },
  rich: { major: [], minor: [] },
  dark: { major: [[5, 'm', 'iv', 0.5], [8, '', '♭VI', 0.5], [10, '', '♭VII', 0.35], [3, '', '♭III', 0.25]], minor: [[1, '', '♭II', 0.3]] },
  lift: { major: [[8, '', '♭VI', 0.55], [10, '', '♭VII', 0.6]], minor: [[0, '', 'I', 0.2]] },
};
const QUALITY = { '': [0, 4, 7], m: [0, 3, 7], '°': [0, 3, 6] };
// harmonic function, for the progression preference: tonic, predominant, dominant
const FUNC = {
  I: 'T', i: 'T', vi: 'T', iii: 'T', III: 'T', VI: 'T', '♭III': 'T',
  ii: 'P', 'ii°': 'P', IV: 'P', iv: 'P', '♭VI': 'P', '♭II': 'P',
  V: 'D', v: 'D', 'vii°': 'D', VII: 'D', '♭VII': 'D',
};

// The chords a colour can use. `pcs` is the triad (used to judge fit); `tones` adds the
// colour's extensions (used for voicing); `pull` is how much the colour wants the chord.
function chordsOf(key, colour = 'plain') {
  const list = CHORD_SETS[key.mode].map(([deg, q, roman]) => [deg, q, roman, 0]).concat(COLOURS[colour][key.mode]);
  return list.map(([deg, q, roman, pull]) => {
    const root = (key.root + deg) % 12, pcs = QUALITY[q].map(i => (root + i) % 12);
    let ext = [];
    if (colour === 'rich') ext = q === '' ? [roman === 'V' || roman === 'VII' || roman === '♭VII' ? 10 : 11, 14] : q === 'm' ? [10, 14] : [10];
    if (colour === 'modal' && q !== '°') ext = [14];
    const tones = colour === 'modal' && q !== '°' ? [0, 7, 14] : [...QUALITY[q], ...ext];
    return { root, quality: q, roman, pcs, tones, pull };
  });
}
const chordName = (c, key) => (usesFlats(key) || c.roman.startsWith('♭') ? FLAT_NAMES : NAMES)[c.root] + c.quality;

// Chords for each segment (two bars, a bar or half a bar): how well each chord of the colour fits
// the melody notes sounding in it (chord tones good, a semitone against a chord tone bad, other
// key notes neutral, out-of-key bad; notes on the segment start count more), plus the colour's
// pull, then the best path through the segments, preferring tonic -> predominant -> dominant ->
// tonic motion and starting/ending on the tonic.
function harmonize(notes, key, meter, res, perBar, colour = 'plain') {
  if (!key || !notes.length) return [];
  const chords = chordsOf(key, colour), sc = SCALES[key.mode];
  const segLen = meter.beats / perBar;
  const first = Math.floor((notes[0].qs / res - meter.offset) / meter.beats) * meter.beats + meter.offset;
  const last = notes[notes.length - 1].qe / res;
  const segs = [];
  for (let b = first; b < last - 1e-6; b += segLen) segs.push({ start: b, end: b + segLen });
  const emit = segs.map(seg => chords.map(c => {
    let s = 0;
    for (const n of notes) {
      const a = Math.max(seg.start, n.qs / res), b = Math.min(seg.end, n.qe / res);
      if (b <= a) continue;
      const w = (b - a) * (Math.abs(n.qs / res - seg.start) < 1e-6 ? 1.5 : 1);
      const pc = pcOf(n.midi);
      const clash = c.pcs.some(p => Math.abs(pcOf(pc - p + 6) - 6) === 1);
      s += w * (c.pcs.includes(pc) ? 1 : clash ? -0.9 : sc.includes(pcOf(pc - key.root)) ? 0.1 : -0.4);
    }
    // diminished chords only when the melody really asks for them; colour chords get their pull
    return s - (c.quality === '°' ? 0.4 * segLen : 0) + c.pull * Math.min(segLen, 4) * 0.2;
  }));
  const trans = (a, b) => {
    if (a === b) return 0.15;
    const fa = FUNC[chords[a].roman], fb = FUNC[chords[b].roman];
    return (fa === 'T' && fb === 'P') || (fa === 'P' && fb === 'D') || (fa === 'D' && fb === 'T') ? 0.35
      : (fa === 'T' && fb === 'D') || (fa === 'P' && fb === 'T') ? 0.15 : 0;
  };
  const N = chords.length, score = [], back = [];
  score.push(emit[0].map((e, i) => e + (i === 0 ? 0.5 : 0)));
  for (let s = 1; s < segs.length; s++) {
    score.push([]); back.push([]);
    for (let j = 0; j < N; j++) {
      let bi = 0, bv = -Infinity;
      for (let i = 0; i < N; i++) { const v = score[s - 1][i] + trans(i, j); if (v > bv) { bv = v; bi = i; } }
      score[s].push(bv + emit[s][j]); back[s - 1].push(bi);
    }
  }
  const lastRow = score[score.length - 1].map((v, i) => v + (i === 0 ? 0.6 : chords[i].roman === 'V' ? 0.2 : 0));
  let j = lastRow.indexOf(Math.max(...lastRow));
  const path = [j];
  for (let s = segs.length - 2; s >= 0; s--) { j = back[s][j]; path.unshift(j); }
  return segs.map((seg, s) => {
    const alts = chords.map((c, i) => ({ c, v: emit[s][i] })).sort((a, b) => b.v - a.v).map(x => x.c);
    const pick = chords[path[s]];
    return { ...seg, chord: pick, alts: [pick, ...alts.filter(c => c !== pick)] };
  });
}

// ---------- rhythm ----------
// Tempo from onsets: find the eighth-note grid the onsets line up with best
// (circular mean of onset phase), weighted towards moderate tempos.
function inferTempo(notes) {
  const on = notes.map(n => n.start);
  if (on.length < 4) return null;
  const score = bpm => {
    const q = 30 / bpm;
    let re = 0, im = 0;
    for (const t of on) { const a = 2 * Math.PI * (t - on[0]) / q; re += Math.cos(a); im += Math.sin(a); }
    const R = Math.hypot(re, im) / on.length;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 100) / 0.9, 2));
    return { bpm, R, s: R * prior, phase: Math.atan2(im, re) / (2 * Math.PI) * q };
  };
  let best = null;
  for (let bpm = 50; bpm <= 200; bpm += 0.5) { const r = score(bpm); if (!best || r.s > best.s) best = r; }
  const c = best.bpm;
  for (let bpm = c - 0.5; bpm <= c + 0.5; bpm += 0.05) { const r = score(bpm); if (r.s > best.s) best = r; }
  return { bpm: Math.round(best.bpm * 10) / 10, t0: on[0] + best.phase, beats: 4, fit: best.R, source: 'heard' };
}

// Snap starts and ends onto a grid of `res` steps per beat. Near-touching notes are made legato.
function quantize(notes, tempo, res) {
  const unit = 60 / tempo.bpm / res;
  let last = -Infinity;
  for (const n of notes) {
    let s = Math.round((n.start - tempo.t0) / unit);
    if (s <= last) s = last + 1;
    n.qs = s; last = s;
  }
  notes.forEach((n, i) => {
    const next = notes[i + 1];
    let e = Math.round((n.end - tempo.t0) / unit);
    if (next) {
      if (next.start - n.end < Math.max(0.12, 0.5 * unit)) e = next.qs;
      e = Math.min(e, next.qs);
    }
    n.qe = Math.max(n.qs + 1, e);
  });
  return unit;
}

const VALUES = [[4, '1'], [3, '1/2.'], [2, '1/2'], [1.5, '1/4.'], [1, '1/4'], [0.75, '1/8.'], [0.5, '1/8'],
  [0.25, '1/16'], [2 / 3, '1/4t'], [1 / 3, '1/8t'], [1 / 6, '1/16t']];
function valueName(units, res) {
  const beats = units / res;
  for (const [v, name] of VALUES) if (Math.abs(beats - v) < 1e-6) return name;
  // other lengths: tie the largest plain values that fit, e.g. 2.5 beats -> 1/2⁀1/8
  const parts = [];
  let left = beats;
  for (const [v, name] of [[4, '1'], [2, '1/2'], [1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [1 / 3, '1/8t'], [1 / 6, '1/16t']])
    while (left >= v - 1e-6) { parts.push(name); left -= v; }
  return parts.length ? parts.join('⁀') : +beats.toFixed(2) + ' b';
}

// ---------- auto-tune ----------
// TD-PSOLA: pitch-synchronous grains around glottal peaks, re-spaced at the
// shifted period. Unvoiced stretches pass through as plain overlap-add.
// f0[k] / shift[k] are per frame (Hz or 0, semitones) at `hop` seconds.
function psola(x, sr, f0, shift, hop) {
  const N = x.length;
  const frame = i => Math.min(f0.length - 1, Math.floor(i / sr / hop));
  const marks = [];
  let prev = -1;
  for (let i = 0; i < N;) {
    const f = f0[frame(i)];
    if (!f) { prev = -1; i += 64; continue; }
    const T = sr / f;
    let lo = prev < 0 ? i : Math.round(prev + T * 0.75);
    let hi = Math.min(N - 1, prev < 0 ? Math.round(i + T) : Math.round(prev + T * 1.25));
    if (lo >= N) break;
    let best = lo, bv = -Infinity;
    for (let j = lo; j <= hi; j++) if (x[j] > bv) { bv = x[j]; best = j; }
    marks.push(best); prev = best; i = best + 1;
  }

  const y = new Float32Array(N), w = new Float32Array(N);
  const grain = (ca, cs, H) => {
    for (let k = -H; k <= H; k++) {
      const a = ca + k, s = cs + k;
      if (a < 0 || a >= N || s < 0 || s >= N) continue;
      const win = 0.5 + 0.5 * Math.cos(Math.PI * k / H);
      y[s] += x[a] * win; w[s] += win;
    }
  };
  let ts = 0, mi = 0;
  while (ts < N) {
    const fi = frame(ts), f = f0[fi];
    const T = f ? sr / f : 0;
    if (f && marks.length) {
      while (mi + 1 < marks.length && Math.abs(marks[mi + 1] - ts) <= Math.abs(marks[mi] - ts)) mi++;
      if (Math.abs(marks[mi] - ts) < T * 1.5) {
        grain(marks[mi], Math.round(ts), Math.round(T));
        ts += T / Math.pow(2, shift[fi] / 12);
        continue;
      }
    }
    grain(Math.round(ts), Math.round(ts), 256);
    ts += 256;
  }
  for (let i = 0; i < N; i++) y[i] = w[i] > 1e-4 ? y[i] / w[i] : 0;
  return y;
}

// ---------- partials ----------
// Radix-2 in-place FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const k = i + j + half;
        const vr = re[k] * cr - im[k] * ci, vi = re[k] * ci + im[k] * cr;
        re[k] = re[i + j] - vr; im[k] = im[i + j] - vi;
        re[i + j] += vr; im[i + j] += vi;
        const nc = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nc;
      }
    }
  }
}

// Spectral peaks of a dB spectrum: local maxima with parabolic refinement, loudest first.
function spectralPeaks(db, binHz, fMax, floor) {
  const peaks = [], top = Math.min(db.length - 3, Math.floor(fMax / binHz));
  for (let b = 3; b < top; b++) {
    const v = db[b];
    if (v < floor || v < db[b - 1] || v <= db[b + 1] || v < db[b - 2] || v <= db[b + 2]) continue;
    const a = db[b - 1], c = db[b + 1], den = a - 2 * v + c;
    const d = den ? 0.5 * (a - c) / den : 0;
    peaks.push({ f: (b + d) * binHz, level: v - 0.25 * (a - c) * d });
  }
  return peaks.sort((x, y) => y.level - x.level);
}

const HMAX = 16;

// Every 10 ms: the tones present in the recording (spectral peaks), each matched to
// harmonic k of the sung pitch when it sits within 40 cents of k * f0.
function analyseSpectrum(v, pts) {
  const N = 4096, hop = 0.01, sr = v.sr, x = v.data;
  const win = new Float32Array(N);
  let ws = 0;
  for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); ws += win[i]; }
  const re = new Float32Array(N), im = new Float32Array(N), db = new Float32Array(N / 2);
  const binHz = sr / N, frames = [];
  let j = 0;
  for (let s = 0; s + N <= x.length; s += Math.round(hop * sr)) {
    const t = v.t0 + (s + N / 2) / sr;
    for (let i = 0; i < N; i++) re[i] = x[s + i] * win[i];
    im.fill(0);
    fft(re, im);
    for (let b = 0; b < N / 2; b++) db[b] = 10 * Math.log10((re[b] * re[b] + im[b] * im[b]) * 4 / (ws * ws) + 1e-14);
    const peaks = spectralPeaks(db, binHz, 6000, -75).slice(0, 24);
    while (j + 1 < pts.length && Math.abs(pts[j + 1].t - t) <= Math.abs(pts[j].t - t)) j++;
    const p = pts[j];
    const f0 = p && !isNaN(p.m) && Math.abs(p.t - t) < 0.02 ? midiToHz(p.m) : 0;
    const h = new Float32Array(HMAX).fill(-Infinity), hf = new Float32Array(HMAX), other = [];
    for (const pk of peaks) {
      const k = f0 ? Math.round(pk.f / f0) : 0;
      if (k >= 1 && k <= HMAX && Math.abs(1200 * Math.log2(pk.f / (k * f0))) < 40) {
        if (pk.level > h[k - 1]) { h[k - 1] = pk.level; hf[k - 1] = pk.f; }
      } else if (other.length < 6) other.push(pk);
    }
    frames.push({ t, f0, h, hf, other, top: peaks.length ? peaks[0].level : -Infinity });
  }
  return frames;
}

// Harmonic k as a musical interval above the sung note, e.g. 3 -> "8ve+5th +2¢".
function harmonicLabel(k) {
  if (k === 1) return 'sung note';
  const semis = 12 * Math.log2(k), r = Math.round(semis), oct = Math.floor(r / 12), iv = r % 12;
  const cents = Math.round((semis - r) * 100);
  const base = (oct > 1 ? oct + '×' : '') + '8ve' + (iv ? '+' + INTERVALS[iv] : '');
  return base + (Math.abs(cents) >= 2 ? ` ${cents > 0 ? '+' : ''}${cents}¢` : '');
}

// Keep the harmonics whose average level is within `range` dB of the strongest, and
// transcribe each one on its own: it is a note while it sounds (with 6 dB of hysteresis),
// split wherever it stops or moves to another pitch, just like the sung melody.
function partialTracks(frames, range) {
  const pow = new Float64Array(HMAX);
  let voiced = 0;
  for (const f of frames) if (f.f0) { voiced++; for (let k = 0; k < HMAX; k++) if (isFinite(f.h[k])) pow[k] += Math.pow(10, f.h[k] / 10); }
  const level = Array.from(pow, p => voiced && p ? 10 * Math.log10(p / voiced) : -Infinity);
  const top = Math.max(...level);
  const tracks = [];
  level.forEach((l, i) => { if (isFinite(l) && l >= top - range) tracks.push({ k: i + 1, level: l - top, notes: [] }); });
  const end = frames.length ? frames[frames.length - 1].t : 0;
  for (const tr of tracks) {
    const i = tr.k - 1, seg = new Segmenter(Math.round);
    let on = false;
    const sounding = f => f.f0 > 0 && isFinite(f.h[i]) && f.h[i] >= f.top - range - 6;
    for (const f of frames) {
      on = f.f0 > 0 && isFinite(f.h[i]) && f.h[i] >= f.top - range - (on ? 6 : 0);
      seg.push(f.t, on ? hzToMidi(f.hf[i]) : NaN);
    }
    seg.close(end);
    let a = 0;
    for (const n of mergeFragments(seg.notes)) {
      while (a < frames.length && frames[a].t < n.start) a++;
      const fs = [];
      for (let j = a; j < frames.length && frames[j].t <= n.end; j++) if (sounding(frames[j])) fs.push(frames[j]);
      if (!fs.length) continue;
      const m = median(fs.map(f => hzToMidi(f.hf[i])));
      const lv = 10 * Math.log10(fs.reduce((s, f) => s + Math.pow(10, f.h[i] / 10), 0) / fs.length) - top;
      tr.notes.push({ start: n.start, end: n.end, midi: Math.round(m), offset: m - Math.round(m), level: lv });
    }
  }
  return { tracks, top };
}

// ---------- voice colour ----------
// The voice's spectral envelope: how loud its harmonics are by frequency (not by harmonic
// number), in 1/6-octave bins from 60 Hz to ~7.7 kHz, in dB relative to the loudest bin.
// Playing a note at any pitch through this envelope keeps the vowel colour of the voice,
// instead of sliding it up and down with the pitch.
const ENV_LO = 60, ENV_BINS = 42;
function voiceEnvelope(frames, from = -Infinity, to = Infinity) {
  const sum = new Float64Array(ENV_BINS), cnt = new Float64Array(ENV_BINS);
  for (const f of frames) {
    if (!f.f0 || f.t < from || f.t > to) continue;
    for (let k = 0; k < HMAX; k++) {
      const lv = f.h[k];
      if (!isFinite(lv)) continue;
      const bin = Math.round(6 * Math.log2(f.hf[k] / ENV_LO));
      if (bin < 0 || bin >= ENV_BINS) continue;
      sum[bin] += Math.pow(10, lv / 10); cnt[bin]++;
    }
  }
  const known = [];
  const db = Array.from(sum, (s, i) => { if (!cnt[i]) return NaN; known.push(i); return 10 * Math.log10(s / cnt[i]); });
  if (known.length < 2) return null;
  // fill the gaps between measured bins; above the highest, fall 12 dB per octave
  for (let i = 0; i < ENV_BINS; i++) {
    if (!isNaN(db[i])) continue;
    const lo = known.filter(k => k < i).pop(), hi = known.find(k => k > i);
    if (lo == null) db[i] = db[hi];
    else if (hi == null) db[i] = db[lo] - 2 * (i - lo);
    else db[i] = db[lo] + (db[hi] - db[lo]) * (i - lo) / (hi - lo);
  }
  const top = Math.max(...db);
  return db.map(v => v - top);
}
function envelopeAt(env, hz) {
  const x = 6 * Math.log2(hz / ENV_LO);
  if (x <= 0) return env[0];
  if (x >= ENV_BINS - 1) return env[ENV_BINS - 1] - 2 * (x - ENV_BINS + 1);
  const i = Math.floor(x), f = x - i;
  return env[i] + (env[i + 1] - env[i]) * f;
}
// Harmonic amplitudes for a note at f0 Hz sung through the envelope (strongest = 1).
function voiceHarmonics(env, f0) {
  const amps = [];
  for (let k = 1; k <= 40 && k * f0 < 9000; k++) amps.push(Math.pow(10, envelopeAt(env, k * f0) / 20));
  const mx = Math.max(...amps);
  return amps.map(a => a / mx);
}

// ---------- files ----------
// Format-1 MIDI: one track per line of notes, each on its own channel.
function buildMidi(tracks, opt) {
  const ppq = 480;
  const bpm = opt.grid ? opt.tempo.bpm : 120;
  const tick = opt.grid
    ? (n, t) => {
      const s = n.qs * ppq / opt.res, e = n.qe * ppq / opt.res;
      return t == null ? s : s + (t - n.start) / Math.max(1e-3, n.end - n.start) * (e - s);
    }
    : (n, t) => ((t == null ? n.start : t) - opt.base) * bpm / 60 * ppq;
  const bendMsg = (ch, semis) => { const v = Math.max(0, Math.min(16383, 8192 + Math.round(semis / 12 * 8191))); return [0xE0 | ch, v & 127, v >> 7]; };
  const vlq = v => { const o = [v & 127]; while ((v >>= 7)) o.unshift((v & 127) | 128); return o; };
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const us = Math.round(60e6 / bpm);
  const chunks = [];
  tracks.forEach((tr, ti) => {
    const ch = tr.channel, ev = [];
    for (const n of tr.notes) {
      const s = Math.max(0, Math.round(tick(n)));
      const e = Math.max(s + 1, Math.round(opt.grid ? n.qe * ppq / opt.res : tick(n, n.end)));
      const vel = n.vel || 90;
      ev.push({ t: s, p: 1, b: bendMsg(ch, n.bend ? n.bend[0][1] : n.offset || 0) });
      if (n.bend) for (const [bt, semis] of n.bend.slice(1)) ev.push({ t: Math.min(e - 1, Math.max(s, Math.round(tick(n, bt)))), p: 1, b: bendMsg(ch, semis) });
      ev.push({ t: s, p: 2, b: [0x90 | ch, n.midi, vel] });
      ev.push({ t: e, p: 0, b: [0x80 | ch, n.midi, 0] });
    }
    ev.sort((a, b) => a.t - b.t || a.p - b.p);
    const name = Array.from(tr.name || '', c => c.charCodeAt(0) & 127);
    // bend range +-12 semitones so glides fit
    const trk = [0, 0xFF, 0x03, name.length, ...name,
      0, 0xB0 | ch, 101, 0, 0, 0xB0 | ch, 100, 0, 0, 0xB0 | ch, 6, 12, 0, 0xB0 | ch, 38, 0];
    if (ti === 0) trk.push(0, 0xFF, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255);
    let last = 0;
    for (const e of ev) { trk.push(...vlq(e.t - last), ...e.b); last = e.t; }
    trk.push(0, 0xFF, 0x2F, 0);
    chunks.push(0x4D, 0x54, 0x72, 0x6B, ...u32(trk.length), ...trk);
  });
  return new Uint8Array([0x4D, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255, ...chunks]);
}

function encodeWav(x, sr) {
  const buf = new DataView(new ArrayBuffer(44 + x.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) buf.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); buf.setUint32(4, 36 + x.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, sr, true); buf.setUint32(28, sr * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}
