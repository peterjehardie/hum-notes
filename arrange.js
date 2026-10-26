// Arranged accompaniment: the tune is split into phrases with an energy curve, and three parts
// are written against it like a composer would: three inner lines that voice-lead from chord to
// chord (with passing notes, neighbour notes and suspensions as the energy rises), a melodic bass
// (roots on strong beats, inversions for a smooth line, walking notes towards far-away roots) and
// a counter-melody that answers the tune. Needs dsp.js first (SCALES, pcOf, QUALITY).
//
// Pure: no DOM, no audio. Deterministic: the same input gives the same notes (opts.seed changes them).
// Positions and lengths are in beats from the score's tempo origin (score note qs / res).
//
// arrange(melody, key, meter, segs, opts) -> {
//   bass: [ev], inner: [[ev] low, [ev] middle, [ev] high], counter: [ev],
//   phrases: [{ start, end, energy }], energyAt: beat -> 0..1 }
// with ev = { midi, start, len, vel } (vel 0..1).
//   melody: [{ midi, start, end }] in beats, sorted, one note at a time
//   key:    { root: 0..11, mode: 'major' | 'minor' }
//   meter:  { beats, offset }  (bar 1 starts at beat `offset`)
//   segs:   [{ start, end, chord: { root, quality, pcs, tones } }] from harmonize()
//   opts:   { energy: 'flat' | 'build' | 'arc', density: 0..1, register: {...}, motif: [scale steps], seed,
//             form (from analyseForm in form.js) }
// With opts.form the phrases are the form's (and carry label, sameAs, role, cadence); repeated
// phrases play the same parts again (moved by the repeat's scale steps, the cadence bar of the
// last or a varied repeat written afresh); the counter-melody answers in the melody's rests and
// echoes the last notes of a phrase; bass and inner voices move less under a busy melody and
// more in its gaps; loudness swells into each phrase's high point and eases after it.

const AR_REGISTER = { bassLow: 33, bassHigh: 52, innerLow: 50, innerHigh: 67, counterLow: 60, counterHigh: 79 };
const AR_EPS = 1e-6;

// Small seedable random numbers (mulberry32).
function arRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const arClamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const arSmooth = u => u * u * (3 - 2 * u);

function arShuffle(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// The note sounding at beat t in a part ({ start, len }) or the melody ({ start, end }).
function arSounding(line, t) {
  for (const n of line) {
    const end = n.end != null ? n.end : n.start + n.len;
    if (n.start <= t + AR_EPS && t < end - AR_EPS) return n;
  }
  return null;
}

// Two voices moving the same way from a perfect fifth or octave into the same interval again.
function arParallel(a0, a1, b0, b1) {
  if (a0 === a1 || b0 === b1 || Math.sign(a1 - a0) !== Math.sign(b1 - b0)) return false;
  const i0 = Math.abs(a0 - b0) % 12, i1 = Math.abs(a1 - b1) % 12;
  return (i0 === 7 && i1 === 7) || (i0 === 0 && i1 === 0);
}

// Next note of a pitch-class set above (dir 1) or below (dir -1) m.
function arStep(m, scale, dir) {
  for (let k = m + dir; Math.abs(k - m) <= 3; k += dir) if (scale.includes(pcOf(k))) return k;
  return m + 2 * dir;
}

// A note moved by t scale steps (a note outside the key keeps its distance above the key note under it).
function arShiftDeg(m, t, key) {
  if (!t) return m;
  const sc = SCALES[key.mode], rel = m - key.root, oct = Math.floor(rel / 12), pc = pcOf(rel);
  let i = sc.indexOf(pc), extra = 0;
  if (i < 0) { i = 0; for (let k = 0; k < sc.length; k++) if (sc[k] < pc) i = k; extra = pc - sc[i]; }
  const d = oct * 7 + i + t, o2 = Math.floor(d / 7), i2 = ((d % 7) + 7) % 7;
  return key.root + 12 * o2 + sc[i2] + extra;
}

// Notes of a pitch-class set strictly between a and b, in order from a.
function arBetween(a, b, scale) {
  const out = [], dir = Math.sign(b - a);
  if (!dir) return out;
  for (let k = a + dir; k !== b; k += dir) if (scale.includes(pcOf(k))) out.push(k);
  return out;
}

// Scale degree counted from the key's home note; notes outside the key sit at x.5.
function arDegree(m, key) {
  const sc = SCALES[key.mode], rel = m - key.root, oct = Math.floor(rel / 12), pc = pcOf(rel);
  const i = sc.indexOf(pc);
  if (i >= 0) return oct * 7 + i;
  let lo = 0;
  for (let k = 0; k < sc.length; k++) if (sc[k] < pc) lo = k;
  return oct * 7 + lo + 0.5;
}

// How strong a beat position is: downbeat 1, middle of a 4/4 bar 0.75, other beats 0.5, off-beats 0.2.
function arStrength(t, meter) {
  const rel = t - meter.offset;
  if (Math.abs(rel - Math.round(rel)) > AR_EPS) return 0.2;
  const inBar = ((Math.round(rel) % meter.beats) + meter.beats) % meter.beats;
  if (inBar === 0) return 1;
  if (meter.beats === 4 && inBar === 2) return 0.75;
  return 0.5;
}

// What a chord offers: its tones (with colour extensions), the triad, its third and seventh,
// and the scale to move in under it (the key's notes, with any chord note from outside the
// key replacing the key note a semitone away, e.g. G♯ for G under E major in A minor).
function arChordInfo(chord, key) {
  const tones = chord.tones && chord.tones.length ? chord.tones : (QUALITY[chord.quality] || [0, 4, 7]);
  const pcs = [...new Set(tones.map(t => (chord.root + t) % 12))];
  const triad = chord.pcs && chord.pcs.length ? chord.pcs : pcs.slice(0, 3);
  const has = i => tones.some(t => t % 12 === i);
  const third = has(3) ? (chord.root + 3) % 12 : has(4) ? (chord.root + 4) % 12 : null;
  const seventh = has(10) ? (chord.root + 10) % 12 : has(11) ? (chord.root + 11) % 12 : null;
  const all = [...new Set([...pcs, ...triad])];
  const keySc = SCALES[key.mode].map(i => (key.root + i) % 12);
  const outside = all.filter(p => !keySc.includes(p));
  const scale = [...new Set([...keySc.filter(p => !outside.some(c => Math.abs(pcOf(c - p + 6) - 6) === 1)), ...all])];
  return { root: chord.root, quality: chord.quality, pcs, triad, third, seventh, all, scale };
}

// ---------- phrases and energy ----------
// Phrases end at a rest of a beat or more, or at a long note (2+ beats) that ends a bar.
// Phrase spans sit on bar lines; phrases shorter than two bars join their shorter neighbour.
// With a form (form.js) its phrases are used as they are.
function arPhrases(mel, meter, S0, S1, mode, form) {
  const B = meter.beats;
  const barFloor = t => Math.floor((t - meter.offset) / B + AR_EPS) * B + meter.offset;
  const ph = form ? arFormPhrases(mel, S0, S1, form) : arSplitPhrases(mel, meter, S0, S1, barFloor);
  return arEnergy(ph, S0, S1, mode);
}

function arFormPhrases(mel, S0, S1, form) {
  const ph = [];
  form.phrases.forEach((p, idx) => {
    const start = Math.max(S0, p.start), end = Math.min(S1, p.end);
    if (end - start < AR_EPS) return;
    ph.push({ start, end, notes: [], idx, label: p.label, sameAs: p.sameAs, shift: p.shift || 0, role: p.role, cadence: p.cadence, peak: p.peak });
  });
  if (!ph.length) ph.push({ start: S0, end: S1, notes: [], idx: -1, sameAs: -1, shift: 0 });
  ph[0].start = S0;
  ph.forEach((p, i) => { p.end = i + 1 < ph.length ? ph[i + 1].start : S1; });
  for (const n of mel) {
    let k = 0;
    while (k + 1 < ph.length && n.start >= ph[k + 1].start - AR_EPS) k++;
    ph[k].notes.push(n);
  }
  return ph;
}

function arSplitPhrases(mel, meter, S0, S1, barFloor) {
  const B = meter.beats;
  const groups = [];
  let cur = [];
  mel.forEach((n, i) => {
    cur.push(n);
    const next = mel[i + 1];
    if (!next) return;
    const r = (((n.end - meter.offset) % B) + B) % B;
    const endsBar = r < AR_EPS || r > B - 1 - AR_EPS;
    if (next.start - n.end >= 1 - AR_EPS || (n.end - n.start >= 2 - AR_EPS && endsBar)) { groups.push(cur); cur = []; }
  });
  if (cur.length) groups.push(cur);
  const ph = [];
  groups.forEach((g, i) => {
    if (!ph.length) { ph.push({ start: S0, notes: g.slice() }); return; }
    const prev = ph[ph.length - 1], lastStart = prev.notes[prev.notes.length - 1].start;
    // a pickup in the last beat of a bar belongs to the bar after it
    const b = barFloor(g[0].start + 1);
    if (b <= prev.start + AR_EPS || b <= lastStart + AR_EPS || b >= S1 - AR_EPS) prev.notes.push(...g);
    else ph.push({ start: b, notes: g.slice() });
  });
  if (!ph.length) ph.push({ start: S0, notes: [] });
  ph.forEach((p, i) => { p.end = i + 1 < ph.length ? ph[i + 1].start : S1; });
  for (;;) {
    const i = ph.findIndex(p => p.end - p.start < 2 * B - AR_EPS);
    if (i < 0 || ph.length < 2) break;
    const size = k => ph[k].end - ph[k].start;
    const j = i === 0 ? 1 : i === ph.length - 1 ? i - 1 : size(i - 1) <= size(i + 1) ? i - 1 : i + 1;
    const a = Math.min(i, j);
    ph.splice(a, 2, { start: ph[a].start, end: ph[a + 1].end, notes: [...ph[a].notes, ...ph[a + 1].notes] });
  }
  return ph;
}

function arEnergy(ph, S0, S1, mode) {
  // Energy per phrase. flat: 0.6. build: 0.3 rising to 1 at the last phrase. arc: rising to 1 at
  // the phrase with the highest note (the climax), falling after it.
  const n = ph.length;
  let top = -Infinity, ci = 0, tc = S0;
  ph.forEach((p, i) => p.notes.forEach(nt => { if (nt.midi > top) { top = nt.midi; ci = i; tc = nt.start; } }));
  let anchors = [];
  if (mode === 'flat') ph.forEach(p => { p.energy = 0.6; });
  else if (n === 1) {
    // one phrase: the curve happens inside it
    anchors = mode === 'build' ? [[S0, 0.35], [S1, 1]] : [[S0, 0.45], [arClamp(tc, S0, S1), 1], [S1, 0.55]];
    anchors = anchors.filter((a, i) => i === 0 || a[0] - anchors[i - 1][0] >= 1);
  } else {
    ph.forEach((p, i) => {
      p.energy = mode === 'build' ? 0.3 + 0.7 * i / (n - 1)
        : i <= ci ? (ci === 0 ? 1 : 0.3 + 0.7 * i / ci) : 1 - 0.5 * (i - ci) / (n - 1 - ci);
    });
    anchors = ph.map((p, i) => [mode === 'arc' && i === ci ? arClamp(tc, p.start, p.end) : (p.start + p.end) / 2, p.energy]);
  }
  const curve = t => {
    if (t <= anchors[0][0]) return anchors[0][1];
    for (let i = 1; i < anchors.length; i++) {
      const [ta, va] = anchors[i - 1], [tb, vb] = anchors[i];
      if (t <= tb) return va + (vb - va) * arSmooth((t - ta) / Math.max(AR_EPS, tb - ta));
    }
    return anchors[anchors.length - 1][1];
  };
  const energyAt = t => {
    if (mode === 'flat') return 0.6;
    let v = curve(t);
    if (n > 1) {
      // each phrase breathes: a little lift in its middle
      const p = ph.find(q => t >= q.start - AR_EPS && t < q.end) || ph[n - 1];
      v += 0.05 * Math.sin(Math.PI * arClamp((t - p.start) / (p.end - p.start)));
    }
    return arClamp(v);
  };
  if (mode !== 'flat' && n === 1) {
    let s = 0, k = 0;
    for (let t = S0; t < S1; t += 0.5, k++) s += energyAt(t);
    ph[0].energy = k ? s / k : 0.6;
  }
  ph.forEach(p => { p.energy = Math.round(p.energy * 100) / 100; });
  return { phrases: ph, energyAt };
}

// ---------- bass ----------
// A smooth line through the chords: the bass note of each chord (root, or the third / fifth when
// that makes the line move by step) picked by a best-path search, then filled in by energy: one
// note a bar when quiet, two when moderate, one a beat when strong, walking by scale steps towards
// a root a third or more away (a chromatic step between roots a whole tone apart), and a step
// leading into each new phrase once the energy is up.
function arBass(c) {
  const { segs, info, reg, meter, mel, energyAt, dens, phrases, keySc, vel } = c;
  const B = meter.beats, n = segs.length, centre = (reg.bassLow + reg.bassHigh) / 2;
  const phraseStart = t => phrases.some((p, i) => i > 0 && Math.abs(p.start - t) < AR_EPS);
  const cands = info.map(ci => {
    const out = [];
    for (let m = reg.bassLow; m <= reg.bassHigh; m++) { const k = ci.triad.indexOf(pcOf(m)); if (k >= 0) out.push({ m, inv: k }); }
    return out;
  });
  const unary = (s, x) => {
    const seg = segs[s], e = energyAt(seg.start), dim = info[s].quality === '°';
    let v = x.inv === 0 ? (dim ? 1.2 : 0) : x.inv === 1 ? (dim ? 0 : 1.6) : 3.5;
    if ((s === 0 || s === n - 1) && x.inv !== 0) v += 6;
    if (phraseStart(seg.start) && x.inv !== 0) v += 1.5;
    v += 0.05 * Math.abs(x.m - (centre - 4 * (e - 0.5)));   // more energy, deeper and wider
    const mn = arSounding(mel, seg.start);
    if (mn && x.inv !== 0 && pcOf(mn.midi) === pcOf(x.m)) v += 1.5;
    return v;
  };
  const move = (a, b, same) => {
    const d = Math.abs(a - b);
    return d === 0 ? (same ? 0.2 : 1.2) : d <= 2 ? 0 : d <= 4 ? 0.5 : d === 5 ? 0.9 : d === 6 ? 3 : d === 7 ? 1.3 : d === 12 ? 2.5 : 1.5 + 0.4 * (d - 7);
  };
  let score = cands[0].map(x => unary(0, x));
  const back = [];
  for (let s = 1; s < n; s++) {
    const same = segs[s].chord.root === segs[s - 1].chord.root && segs[s].chord.quality === segs[s - 1].chord.quality;
    const row = [], bk = [];
    for (const x of cands[s]) {
      let bv = Infinity, bi = 0;
      cands[s - 1].forEach((y, i) => { const v = score[i] + move(y.m, x.m, same); if (v < bv) { bv = v; bi = i; } });
      row.push(bv + unary(s, x)); bk.push(bi);
    }
    score = row; back.push(bk);
  }
  let j = score.indexOf(Math.min(...score));
  const skel = new Array(n);
  for (let s = n - 1; s >= 0; s--) { skel[s] = cands[s][j]; if (s) j = back[s - 1][j]; }

  const chordTones = s => {
    const out = [];
    for (let m = reg.bassLow; m <= reg.bassHigh; m++) if (info[s].triad.includes(pcOf(m))) out.push(m);
    return out;
  };
  // chord tones for the free slots: the fifth for one, out and back for more
  const fill = (count, S, s, N) => {
    if (count <= 0) return [];
    const tones = chordTones(s);
    if (count === 1) {
      // over an inversion the root, over the root the fifth
      const r = info[s].triad[0], target = pcOf(S) === r ? info[s].triad[2] : r;
      const opts = tones.filter(m => pcOf(m) === target && m !== S).sort((a, b) => Math.abs(a - S - 5) - Math.abs(b - S - 5));
      if (opts.length) return [opts[0]];
    }
    // out and back, or straight up the chord when the next chord starts on the same note
    const i0 = tones.indexOf(S), dir = S > centre ? -1 : 1, up = N === S ? count : Math.ceil(count / 2), out = [];
    for (let k = 1; out.length < count; k++) {
      const idx = i0 + dir * (k <= up ? k : 2 * up - k);
      out.push(tones[Math.max(0, Math.min(tones.length - 1, idx))]);
    }
    return out;
  };
  const inReg = m => m >= reg.bassLow && m <= reg.bassHigh;

  const bass = [];
  for (let s = 0; s < n; s++) {
    const seg = segs[s], L = seg.end - seg.start, d = dens(seg.start, L), e = energyAt(seg.start);
    const step = s === n - 1 ? L : d < 0.4 ? B : d < 0.7 ? Math.ceil(B / 2) : 1;
    const pos = [];
    for (let p = 0; p < L - AR_EPS; p += step) pos.push(p);
    const S = skel[s].m, notes = [S], free = pos.length - 1;
    if (free > 0) {
      const N = skel[s + 1].m, D = N - S;
      let tail = [];
      if (Math.abs(D) >= 3) tail = arBetween(S, N, info[s].scale).slice(-free);
      else if (Math.abs(D) === 2 && skel[s].inv === 0 && skel[s + 1].inv === 0) tail = free >= 2 ? [S, S + Math.sign(D)] : [S + Math.sign(D)];
      else if (D !== 0) {
        const far = arStep(N, info[s].scale, Math.sign(D));
        if (inReg(far)) tail = [far];
      }
      notes.push(...fill(free - tail.length, S, s, N), ...tail);
    }
    pos.forEach((p, k) => {
      const len = (k + 1 < pos.length ? pos[k + 1] : L) - p;
      const kind = k === 0 ? 'root' : keySc.includes(pcOf(notes[k])) || info[s].all.includes(pcOf(notes[k])) ? 'walk' : 'chromatic';
      bass.push({ midi: notes[k], start: seg.start + p, len, vel: vel(0.38 + 0.42 * e + (k === 0 ? 0.07 : 0), seg.start + p), kind });
    });
    // lead into the next phrase's first chord by a key step
    if (s + 1 < n && phraseStart(segs[s + 1].start) && energyAt(segs[s + 1].start) >= 0.6) {
      const ev = bass[bass.length - 1], N = skel[s + 1].m, a = energyAt(segs[s + 1].start) >= 0.8 ? 0.5 : 1;
      const from = ev.len > a + AR_EPS ? ev.midi : (bass[bass.length - 2] || ev).midi;
      let A = arStep(N, keySc, from <= N ? -1 : 1);
      if (!inReg(A) || A === from) A = arStep(N, keySc, from <= N ? 1 : -1);
      if (inReg(A) && A !== N) {
        if (ev.len > a + AR_EPS && ev.kind !== 'chromatic') {
          ev.len -= a;
          bass.push({ midi: A, start: seg.end - a, len: a, vel: vel(0.36 + 0.42 * e, seg.end - a), kind: 'approach' });
        } else if (ev.kind !== 'root') { ev.midi = A; ev.kind = 'approach'; }
      }
    }
  }
  return bass;
}

// ---------- inner voices ----------
// Three lines voice-led through the chord tones by a best-path search: small total movement,
// the third (and seventh) present, no crossing, nothing below the bass, no parallel fifths or
// octaves between any two parts, spread wider as the energy rises. Then, by energy: neighbour
// notes in long chords, suspensions over chord changes (resolving down a step), passing notes
// into the next chord, and a re-struck lower voice when strong. Quiet stretches hold and tie.
function arInner(c, bass) {
  const { segs, info, reg, energyAt, rnd, keySc, vel, act } = c;
  const n = segs.length;
  const bassIn = s => bass.filter(ev => ev.start < segs[s].end - AR_EPS && ev.start + ev.len > segs[s].start + AR_EPS);
  const cands = info.map((ci, s) => {
    const notes = [];
    for (let m = reg.innerLow; m <= reg.innerHigh; m++) if (ci.pcs.includes(pcOf(m))) notes.push(m);
    const bassTop = Math.max(-Infinity, ...bassIn(s).map(ev => ev.midi));
    const e = energyAt(segs[s].start);
    for (const [gap, floor] of [[e > 0.7 ? 12 : 9, bassTop], [24, bassTop], [24, -Infinity]]) {
      const out = [];
      for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) for (let k = j + 1; k < notes.length; k++) {
        const v = [notes[i], notes[j], notes[k]];
        if (v[0] > floor && v[1] - v[0] <= gap && v[2] - v[1] <= gap) out.push(v);
      }
      if (out.length) return out;
    }
    return [[reg.innerLow, reg.innerLow + 4, reg.innerLow + 7]];
  });
  const mid = (reg.innerLow + reg.innerHigh) / 2;
  const unary = (s, v) => {
    const ci = info[s], e = energyAt(segs[s].start), pcs = v.map(pcOf);
    const b = arSounding(bass, segs[s].start);
    let cost = 0;
    if (ci.third != null && !pcs.includes(ci.third)) cost += 5;
    if (ci.seventh != null && !pcs.includes(ci.seventh)) cost += 2;
    cost += 2 * (3 - new Set(pcs).size);
    if (b && pcOf(b.midi) !== ci.root && !pcs.includes(ci.root)) cost += 1;
    if (b && pcOf(b.midi) === ci.third && ci.third != null) cost += 1.5 * pcs.filter(p => p === ci.third).length;
    if (b && v[0] - b.midi < 3) cost += 1;
    cost += 0.15 * Math.abs(v[2] - v[0] - (7 + 7 * e));
    if (s === 0) cost += 0.2 * Math.abs((v[0] + v[2]) / 2 - mid);
    return cost;
  };
  const trans = (s, u, v) => {
    const T = segs[s].start, b0 = arSounding(bass, T - 0.01), b1 = arSounding(bass, T);
    let cost = 0;
    for (let k = 0; k < 3; k++) { const d = Math.abs(v[k] - u[k]); cost += d + (d > 5 ? 2 * (d - 5) : 0); }
    const lines = [[u[0], v[0]], [u[1], v[1]], [u[2], v[2]]];
    if (b0 && b1) lines.push([b0.midi, b1.midi]);
    for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++)
      if (arParallel(lines[a][0], lines[a][1], lines[b][0], lines[b][1])) cost += 40;
    return cost;
  };
  let score = cands[0].map(v => unary(0, v));
  const back = [];
  for (let s = 1; s < n; s++) {
    const row = [], bk = [];
    for (const v of cands[s]) {
      let bv = Infinity, bi = 0;
      cands[s - 1].forEach((u, i) => { const x = score[i] + trans(s, u, v); if (x < bv) { bv = x; bi = i; } });
      row.push(bv + unary(s, v)); bk.push(bi);
    }
    score = row; back.push(bk);
  }
  let j = score.indexOf(Math.min(...score));
  const voicing = new Array(n);
  for (let s = n - 1; s >= 0; s--) { voicing[s] = cands[s][j]; if (s) j = back[s - 1][j]; }

  // V[voice][segment] = that voice's notes in that chord
  const V = [0, 1, 2].map(k => segs.map((seg, s) => [{
    midi: voicing[s][k], start: seg.start, len: seg.end - seg.start,
    vel: vel(0.3 + 0.4 * energyAt(seg.start), seg.start), kind: 'chord',
  }]));
  const lines = () => [bass, V[0].flat(), V[1].flat(), V[2].flat()];
  // crossings and parallels at the given moments
  const faults = times => {
    const L = lines();
    let f = 0;
    for (const T of times) {
      const now = L.map(l => arSounding(l, T)), was = L.map(l => arSounding(l, T - 0.01));
      let low = -Infinity;
      for (const x of now) if (x) { if (x.midi <= low) f++; low = x.midi; }
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++)
        if (now[a] && now[b] && was[a] && was[b] && arParallel(was[a].midi, now[a].midi, was[b].midi, now[b].midi)) f++;
    }
    return f;
  };
  const tryEdit = (times, apply, undo) => {
    const before = faults(times);
    apply();
    if (faults(times) <= before) return true;
    undo();
    return false;
  };

  for (let s = 0; s < n; s++) {
    const seg = segs[s], L = seg.end - seg.start, e = energyAt(seg.start), sc = info[s].scale, a = act(seg.start, L);
    // neighbour note in the middle of a long chord
    if (L >= 2 && rnd() < arClamp((a - 0.5) * 1.2)) {
      for (const v of arShuffle([0, 1, 2], rnd)) {
        if (V[v][s].length !== 1) continue;
        const ev = V[v][s][0], nl = e > 0.75 ? 0.5 : 1, at = seg.start + Math.floor(L / 2);
        if (at - ev.start < 0.5 || at + nl > seg.end - 0.5 + AR_EPS) continue;
        const nb = arStep(ev.midi, sc, rnd() < 0.5 ? 1 : -1), save = V[v][s];
        if (nb < reg.innerLow || nb > reg.innerHigh) continue;
        const ok = tryEdit([at, at + nl], () => {
          V[v][s] = [{ ...ev, len: at - ev.start },
            { midi: nb, start: at, len: nl, vel: vel(ev.vel - 0.06), kind: 'neighbour' },
            { midi: ev.midi, start: at + nl, len: seg.end - at - nl, vel: vel(ev.vel - 0.08), kind: 'chord' }];
        }, () => { V[v][s] = save; });
        if (ok) break;
      }
    }
    // a strong chord: the lowest voice strikes again halfway
    if (L >= 2 && a >= 0.8 && V[0][s].length === 1 && V[0][s][0].len >= 2) {
      const ev = V[0][s][0], half = Math.floor(ev.len / 2);
      V[0][s] = [{ ...ev, len: half }, { ...ev, start: ev.start + half, len: ev.len - half, vel: vel(ev.vel - 0.06) }];
    }
    if (s === n - 1) continue;
    const T = seg.end, L2 = segs[s + 1].end - segs[s + 1].start, used = new Set();
    const aT = c.form ? act(T - 1, 2) : e;   // around the chord change
    // suspension: hold a note over the chord change, then fall a step to the new chord tone
    if (rnd() < arClamp((aT - 0.45) * 1.4)) {
      for (const v of arShuffle([0, 1, 2], rnd)) {
        const a = V[v][s][V[v][s].length - 1], b = V[v][s + 1][0], d = L2 >= 2 ? 1 : 0.5;
        if (!(a.midi - b.midi === 1 || a.midi - b.midi === 2)) continue;
        if (info[s + 1].all.includes(pcOf(a.midi)) || !keySc.includes(pcOf(a.midi)) || b.len - d < 0.5 - AR_EPS) continue;
        const ok = tryEdit([T, T + d], () => { a.len += d; b.start += d; b.len -= d; b.kind = 'resolution'; },
          () => { a.len -= d; b.start -= d; b.len += d; b.kind = 'chord'; });
        if (ok) { used.add(v); break; }
      }
    }
    // passing notes: fill a third (or fourth) between this chord's note and the next one by step
    if (rnd() < arClamp((aT - 0.3) * 1.5)) {
      let count = aT >= 0.75 ? 2 : 1;
      for (const v of arShuffle([0, 1, 2], rnd)) {
        if (!count || used.has(v)) continue;
        const list = V[v][s], a = list[list.length - 1], b = V[v][s + 1][0];
        if (Math.abs(b.start - T) > AR_EPS || Math.abs(b.midi - a.midi) > 5) continue;
        const path = arBetween(a.midi, b.midi, sc);
        if (!path.length || path.length > 2) continue;
        const p = e > 0.75 || path.length === 2 ? 0.5 : 1, total = p * path.length;
        if (a.len - total < 0.5 - AR_EPS) continue;
        const notes = path.map((m, k) => ({ midi: m, start: T - total + k * p, len: p, vel: vel(a.vel - 0.05), kind: 'passing' }));
        const ok = tryEdit([...notes.map(x => x.start), T], () => { a.len -= total; list.push(...notes); },
          () => { list.splice(list.length - notes.length); a.len += total; });
        if (ok) { used.add(v); count--; }
      }
    }
  }

  // quiet stretches: the same note over the same chord is held, not struck again
  return V.map(voice => {
    const out = [];
    for (const ev of voice.flat()) {
      const prev = out[out.length - 1];
      if (prev && prev.midi === ev.midi && prev.kind === 'chord' && ev.kind === 'chord'
        && Math.abs(prev.start + prev.len - ev.start) < AR_EPS && energyAt(ev.start) < 0.45) prev.len += ev.len;
      else out.push({ ...ev });
    }
    return out;
  });
}

// ---------- counter-melody ----------
// A second tune that answers the melody, chosen on a half-beat grid by a beam search. Scored:
// chord tones and consonance with the melody (3rds, 6ths, 10ths; fifths and octaves sparingly,
// never in parallel) on strong beats, scale passing notes between; contrary or oblique motion;
// mostly steps, leaps of a sixth at most and turned back by a step; moving while the melody holds
// or rests and holding while it moves fast; each phrase entered a beat after the melody and ended
// on a note of the cadence chord. Silent in phrases with energy under 0.35. With opts.motif (scale
// steps) the opening notes of each phrase lean towards that shape. With a form it prefers to
// speak in the melody's rests, keeps quieter under busy singing, and echoes the phrase's last
// three or four notes (an octave away) in the gap after it when they fit.
function arCounter(c, motif) {
  const { phrases, mel, reg, meter, energyAt, segAt, info, key, keySc, vel, form, busy } = c;
  const G = 0.5, BEAM = 64, centre = (reg.counterLow + reg.counterHigh) / 2;
  const strongGap = meter.beats === 4 ? 2 : meter.beats;
  const out = [];
  let carry = null;   // last strong-beat pair from the previous phrase, for the parallels rule
  for (const ph of phrases) {
    if (ph.energy < 0.35 || !ph.notes.length) continue;
    const start = Math.ceil((ph.notes[0].start + 1) / G - AR_EPS) * G, K = Math.round((ph.end - start) / G);
    if (K < 4) continue;
    const pitches = ph.notes.map(nt => nt.midi).sort((a, b) => a - b);
    const above = pitches[pitches.length >> 1] <= centre - 2;
    const cad = info[segAt(ph.end - G)];
    const echo = form ? arEcho(ph, mel, start, reg, G) : new Map();
    const steps = [];
    for (let k = 0; k < K; k++) {
      const t = start + k * G, ci = info[segAt(t)], m = arSounding(mel, t), mp = arSounding(mel, t - G);
      const cands = [];
      for (let p = reg.counterLow; p <= reg.counterHigh; p++) if (ci.scale.includes(pcOf(p))) cands.push(p);
      const ec = echo.get(Math.round(t / G));
      steps.push({ t, e: energyAt(t), st: arStrength(t, meter), ci, m, mOn: m && Math.abs(m.start - t) < AR_EPS, mPrev: mp ? mp.midi : null, cands,
        busy: form ? busy(t, G) : 0, echoOn: ec && ec.on ? ec.midi : null, echoIn: !!ec });
    }
    // cost of having pitch q sounding at this step
    const soundCost = (q, x) => {
      const pc = pcOf(q);
      let v = 0;
      if (!x.ci.all.includes(pc)) v += (x.st >= 0.5 ? 5 * x.st : 0.8) + (keySc.includes(pc) ? 0 : 10);
      if (x.m) {
        const ad = Math.abs(q - x.m.midi), ic = ad % 12;
        if (ad === 0) v += 4;
        else if (ic === 3 || ic === 4 || ic === 8 || ic === 9) v -= 0.3 * x.st;
        else if (ic === 0 || ic === 7) v += 0.6 * x.st;
        else if (ic === 5) v += 1.5 * x.st;
        else v += x.st >= 0.5 ? 6 * x.st : 1;
        if (above ? q < x.m.midi : q > x.m.midi) v += 1.5;
        if (ad < 3) v += 0.5;
      }
      return v + 0.02 * Math.abs(q - centre);
    };
    let beam = [{ cost: 0, cur: null, last: null, prev2: null, back: false, pint: 0, nct: false, held: 0, onsets: 0, strong: carry, parent: null, act: null }];
    for (let k = 0; k < K; k++) {
      const x = steps[k], quiet = x.e < 0.35, next = new Map();
      const fastMel = x.mOn && x.m.end - x.m.start <= 0.5 + AR_EPS;
      const melHolds = !x.m || (!x.mOn && x.t - x.m.start >= 1 - AR_EPS);
      for (const nd of beam) {
        const acts = [];
        if (quiet) acts.push(null);
        else {
          if (k > 0) acts.push(nd.cur != null ? 'hold' : null, null);
          for (const p of x.cands) acts.push(p);
        }
        for (const act of new Set(acts)) {
          let cost = nd.cost, cur = nd.cur, last = nd.last, prev2 = nd.prev2, back = nd.back, pint = nd.pint, nct = nd.nct, held = nd.held + G, onsets = nd.onsets;
          if (act === null) {
            cost += quiet ? 0 : nd.cur != null ? 1 : 0.35 + 0.4 * x.e - (fastMel ? 0.3 : 0);
            if (x.echoIn) cost += 0.6;
            if (nd.cur != null) held = G;
            cur = null;
          } else if (act === 'hold') {
            if (held > 3) cost += 0.3;
            if (melHolds && x.e >= 0.5) cost += 0.2;
            if (x.echoIn && x.echoOn == null) cost -= 0.3;
          } else {
            const p = act;
            cost += 0.3;
            if (form) {
              // answer in the rests, stay out of the way of busy singing, echo the phrase's ending
              if (!x.m) cost -= 0.3;
              else if (x.mOn && x.busy > 0.7) cost += 0.4;
              if (x.echoOn != null) cost += p === x.echoOn ? -1.6 : 0.4;
            }
            if (x.st < 0.3) cost += 0.2 + 1.4 * (1 - x.e);
            if (melHolds) cost -= 0.5 + 0.4 * x.e;
            else if (fastMel) cost += 1;
            else if (x.mOn && x.m.end - x.m.start <= 1 + AR_EPS) cost += 0.4;
            const ct = x.ci.all.includes(pcOf(p));
            if (last != null) {
              const d = p - last, ad = Math.abs(d);
              cost += ad === 0 ? 2 : ad <= 2 ? 0 : ad <= 4 ? 0.6 : ad === 5 ? 1.4 : ad === 6 ? 4 : ad === 7 ? 1.8 : ad <= 9 ? 3 : 50;
              if (Math.abs(pint) >= 5 && (Math.sign(d) === Math.sign(pint) || ad > 2)) cost += 2.5;
              if (nct && ad > 2) cost += 3;
              if (!ct && ad > 2) cost += 2;
              if (x.m && x.mPrev != null) {
                const mm = Math.sign(x.m.midi - x.mPrev);
                cost += mm === 0 ? -0.15 : Math.sign(d) === -mm ? -0.4 : Math.sign(d) === mm ? 0.4 : 0;
              }
              if (motif && onsets >= 1 && onsets <= motif.length)
                cost += arDegree(p, key) - arDegree(last, key) === motif[onsets - 1] ? -0.8 : 0.3;
              if (x.mOn && x.mPrev != null && nd.cur != null && arParallel(nd.cur, p, x.mPrev, x.m.midi)) cost += 8;
              pint = d;
            } else if (!ct) cost += 2;
            // a neighbour figure once is fine; see-sawing between two notes is not
            const ret = p === nd.prev2;
            if (ret) cost += nd.back ? 1.5 : 0.3;
            back = ret; prev2 = last;
            cur = p; last = p; nct = !ct; held = G; onsets++;
          }
          let strong = nd.strong;
          if (cur != null) cost += soundCost(cur, x);
          if (x.st >= 0.75) {
            if (cur != null && x.m) {
              if (strong && Math.abs(x.t - strong.t - strongGap) < AR_EPS && arParallel(strong.c, cur, strong.m, x.m.midi)) cost += 30;
              strong = { c: cur, m: x.m.midi, t: x.t };
            } else strong = null;
          }
          if (k === K - 1) {
            // end on a held note of the cadence chord
            if (cur == null && !quiet) cost += 3;
            if (last != null && !cad.all.includes(pcOf(last))) cost += 8;
            if (last != null && (pcOf(last) === cad.root || pcOf(last) === cad.third)) cost -= 0.5;
            if (cur != null && held < 1) cost += 1.5;
          }
          const keyS = [cur, last, prev2, back, Math.abs(pint) >= 5 ? Math.sign(pint) : 0, nct, Math.min(onsets, (motif ? motif.length : 0) + 1),
            strong ? strong.c : '', held > 3 ? 1 : 0].join('|');
          const old = next.get(keyS);
          if (!old || cost < old.cost) next.set(keyS, { cost, cur, last, prev2, back, pint, nct, held, onsets, strong, parent: nd, act });
        }
      }
      beam = [...next.values()].sort((a, b) => a.cost - b.cost).slice(0, BEAM);
    }
    const best = beam[0];
    carry = best.strong;
    const acts = [];
    for (let nd = best; nd.parent; nd = nd.parent) acts.unshift(nd.act);
    let open = null;
    acts.forEach((act, k) => {
      const x = steps[k];
      if (act === 'hold' && open) open.len += G;
      else if (act === null) open = null;
      else if (act !== 'hold') {
        open = { midi: act, start: x.t, len: G, vel: vel(0.3 + 0.42 * x.e + 0.06 * x.st, x.t) };
        out.push(open);
      }
    });
  }
  return out;
}

// The echo of a phrase's ending: its last 4 (or 3) notes, an octave or two away so they sit in
// the counter's register, starting on the half-beat after the melody stops and ending before it
// starts again (twice as fast when only that fits). Map of grid index ->
// { midi, on } (on: the echo note starts there; otherwise it is held).
function arEcho(ph, mel, from, reg, G) {
  const out = new Map(), notes = ph.notes;
  if (notes.length < 3) return out;
  const last = notes[notes.length - 1];
  const after = mel.find(n => n.start > last.start + AR_EPS);
  const es = Math.ceil(last.end / G - AR_EPS) * G, gapEnd = Math.min(ph.end, after ? after.start : ph.end);
  if (es < from - AR_EPS || gapEnd - es < 1.5 - AR_EPS) return out;
  const centre = (reg.counterLow + reg.counterHigh) / 2;
  for (const cnt of [4, 3]) for (const speed of [1, 0.5]) {
    if (notes.length < cnt) continue;
    const src = notes.slice(-cnt), t0 = src[0].start;
    const on = src.map(n => Math.round((n.start - t0) * speed / G) * G);
    if (on.some((o, i) => i && o <= on[i - 1] + AR_EPS)) continue;
    const lastLen = Math.max(G, Math.min(1, Math.round((last.end - last.start) * speed / G) * G));
    if (es + on[cnt - 1] + lastLen > gapEnd + AR_EPS) continue;
    const avg = src.reduce((a, n) => a + n.midi, 0) / cnt;
    let sh = 12 * Math.round((centre - avg) / 12);
    while (Math.max(...src.map(n => n.midi)) + sh > reg.counterHigh) sh -= 12;
    while (Math.min(...src.map(n => n.midi)) + sh < reg.counterLow) sh += 12;
    if (src.some(n => n.midi + sh > reg.counterHigh)) continue;
    src.forEach((n, i) => {
      const a = es + on[i], b = i + 1 < cnt ? es + on[i + 1] : es + on[i] + lastLen;
      for (let t = a; t < b - AR_EPS; t += G) out.set(Math.round(t / G), { midi: n.midi + sh, on: Math.abs(t - a) < AR_EPS });
    });
    return out;
  }
  return out;
}

// ---------- repeated phrases ----------
// Faults the arranger must never write, counted over the whole arrangement: a note out of its
// register, overlapping its own part, outside both key and chord (a bass passing chromatically
// between two roots excepted), voices crossing, parallel fifths/octaves among bass and inner
// voices, and against the melody on strong beats the counter's dissonances and parallels.
function arFaults(c, bass, inner, counter, where) {
  const { reg, mel, meter, keySc, info, segAt } = c;
  const lines = [bass, ...inner];
  const ranges = [[reg.bassLow, reg.bassHigh], [reg.innerLow, reg.innerHigh], [reg.innerLow, reg.innerHigh], [reg.innerLow, reg.innerHigh], [reg.counterLow, reg.counterHigh]];
  let f = 0;
  [...lines, counter].forEach((line, li) => line.forEach((n, i) => {
    if (n.midi < ranges[li][0] || n.midi > ranges[li][1]) f += 3;
    if (li < 4 && i && n.start < line[i - 1].start + line[i - 1].len - AR_EPS) f += 3;
    const pc = pcOf(n.midi);
    if (!keySc.includes(pc) && !info[segAt(n.start)].all.includes(pc)) {
      const p = line[i - 1], q = line[i + 1];
      if (!(li === 0 && p && q && Math.abs(p.midi - n.midi) === 1 && Math.abs(q.midi - n.midi) === 1 && p.midi !== q.midi)) f += 3;
    }
  }));
  const times = [...new Set(lines.flat().map(n => n.start))];
  for (const t of times) {
    const now = lines.map(l => arSounding(l, t)), was = lines.map(l => arSounding(l, t - 0.01));
    let low = -Infinity;
    const f0 = f;
    for (const x of now) if (x) { if (x.midi <= low) f += 3; low = x.midi; }
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++)
      if (now[a] && now[b] && was[a] && was[b] && arParallel(was[a].midi, now[a].midi, was[b].midi, now[b].midi)) f += 3;
    if (where && f > f0) where.push(t);
  }
  if (counter.length) {
    const S0 = c.segs[0].start, S1 = c.segs[c.segs.length - 1].end, gap = meter.beats === 4 ? 2 : meter.beats;
    let prev = null;
    for (let t = Math.ceil(S0); t < S1 - AR_EPS; t += 1) {
      if (arStrength(t, meter) < 0.75) continue;
      const k = arSounding(counter, t), m = arSounding(mel, t);
      if (k && m && ![0, 3, 4, 7, 8, 9].includes(Math.abs(k.midi - m.midi) % 12)) f += 1;
      if (k && m && prev && Math.abs(t - prev.t - gap) < AR_EPS && arParallel(prev.k, k.midi, prev.m, m.midi)) f += 3;
      prev = k && m ? { t, k: k.midi, m: m.midi } : null;
    }
  }
  return f;
}

// One part's notes in [w0, w1) replaced by the notes of [w0 - d, w1 - d) moved by t scale steps.
function arCopySpan(line, w0, w1, d, t, key) {
  const out = [];
  for (const ev of line) {
    const e = ev.start + ev.len;
    if (e <= w0 + AR_EPS || ev.start >= w1 - AR_EPS) { out.push(ev); continue; }
    if (ev.start < w0 - AR_EPS) out.push({ ...ev, len: w0 - ev.start });
    if (e > w1 + AR_EPS) out.push({ ...ev, start: w1, len: e - w1 });
  }
  for (const ev of line) {
    const a = Math.max(ev.start, w0 - d), b = Math.min(ev.start + ev.len, w1 - d);
    if (b - a < AR_EPS) continue;
    out.push({ ...ev, midi: arShiftDeg(ev.midi, t, key), start: a + d, len: b - a });
  }
  return out.sort((x, y) => x.start - y.start);
}

// A phrase that repeats an earlier one plays the earlier one's parts again (as far as the chords
// are the same, moved by the repeat's scale steps), except the cadence bar of a varied repeat
// and of the last repeat, which keep their freshly written endings. Bass and inner voices are
// copied together (mended where the copy meets its new surroundings badly), the counter-melody
// on its own; a copy that would still add a fault is not made.
function arRepeats(c, bass, inner, counter) {
  const { phrases, segs, key, meter, mel } = c;
  const B = meter.beats, barFloor = t => Math.floor((t - meter.offset) / B + AR_EPS) * B + meter.offset;
  const lastOf = new Map();
  phrases.forEach((p, i) => { if (p.sameAs >= 0) lastOf.set(p.sameAs, i); });
  const moved = (ch, t) => {
    if (!t) return ch.root;
    const sc = SCALES[key.mode], d = sc.indexOf(pcOf(ch.root - key.root));
    return d < 0 ? null : (key.root + sc[(((d + t) % 7) + 7) % 7]) % 12;
  };
  let faults = arFaults(c, bass, inner, counter);
  phrases.forEach((q, qi) => {
    if (!(q.sameAs >= 0)) return;
    const o = phrases.find(p => p.idx === q.sameAs);
    if (!o || o === q) return;
    const d = q.start - o.start, t = q.shift || 0;
    // how far the chords match
    let L = 0;
    for (const s of segs) {
      if (s.start < q.start - AR_EPS || s.start >= q.end - AR_EPS) continue;
      const so = segs.find(x => Math.abs(x.start + d - s.start) < AR_EPS);
      if (!so || Math.abs(so.end + d - s.end) > AR_EPS || so.end > o.end + AR_EPS
        || moved(so.chord, t) !== s.chord.root || so.chord.quality !== s.chord.quality) break;
      L = s.end - q.start;
    }
    L = Math.min(L, o.end - o.start);
    if (lastOf.get(q.sameAs) === qi || q.label !== o.label) {
      const lastNote = [...mel].reverse().find(n => n.start >= q.start - AR_EPS && n.start < q.end - AR_EPS);
      if (lastNote) L = Math.min(L, barFloor(lastNote.start) - q.start);
    }
    if (L < B - AR_EPS) return;
    const w0 = q.start, w1 = q.start + L;
    let nb = arCopySpan(bass, w0, w1, d, t, key), ni = inner.map(v => arCopySpan(v, w0, w1, d, t, key));
    let f = arFaults(c, nb, ni, counter);
    // a copy that meets the next chord badly may still be mended
    if (f > faults) { ({ bass: nb, inner: ni } = arRepair(c, nb, ni, counter)); f = arFaults(c, nb, ni, counter); }
    if (f <= faults) { bass = nb; inner = ni; faults = f; }
    const nc = arCopySpan(counter, w0, w1, d, t, key);
    f = arFaults(c, bass, inner, nc);
    if (f <= faults) { counter = nc; faults = f; }
  });
  return { bass, inner, counter };
}

// Where the bass and inner voices still cross or move in parallel (a moving bass meeting a
// voicing chosen for the chord as a whole), mend it: let a passing bass note go (the note before
// it holds on), or move an inner note to another tone of its chord. Each change must lower the
// fault count.
function arRepair(c, bass, inner, counter) {
  const { reg, info, segAt } = c;
  let f = arFaults(c, bass, inner, counter);
  for (let pass = 0; pass < 3 && f > 0; pass++) {
    const where = [];
    arFaults(c, bass, inner, counter, where);
    const near = ev => where.some(t => ev.start <= t + AR_EPS && ev.start + ev.len >= t - 0.01 - AR_EPS);
    for (let i = bass.length - 1; i > 0 && f > 0; i--) {
      const ev = bass[i], pv = bass[i - 1];
      if (ev.kind === 'root' || !near(ev) || Math.abs(pv.start + pv.len - ev.start) > AR_EPS) continue;
      const nb = bass.slice();
      nb[i - 1] = { ...pv, len: pv.len + ev.len };
      nb.splice(i, 1);
      const g = arFaults(c, nb, inner, counter);
      if (g < f) { bass = nb; f = g; }
    }
    for (let v = 0; v < 3 && f > 0; v++) for (let i = 0; i < inner[v].length && f > 0; i++) {
      const ev = inner[v][i];
      if (!near(ev)) continue;
      const pcs = info[segAt(ev.start)].pcs;
      let best = null;
      for (let m = reg.innerLow; m <= reg.innerHigh; m++) {
        if (m === ev.midi || !pcs.includes(pcOf(m)) || Math.abs(m - ev.midi) > 7) continue;
        const nv = inner[v].slice();
        nv[i] = { ...ev, midi: m };
        const ni = inner.slice();
        ni[v] = nv;
        const g = arFaults(c, bass, ni, counter);
        if (g < f && (!best || g < best.g)) best = { g, ni };
      }
      if (best) { inner = best.ni; f = best.g; }
    }
  }
  return { bass, inner, counter };
}

// ---------- the whole arrangement ----------
function arrange(melody, key, meter, segs, opts) {
  opts = opts || {};
  const empty = { bass: [], inner: [[], [], []], counter: [], phrases: [], energyAt: () => 0.6 };
  if (!segs || !segs.length || !key || !meter) return empty;
  const reg = { ...AR_REGISTER, ...(opts.register || {}) };
  const rnd = arRng(opts.seed != null ? opts.seed : 7);
  const density = opts.density != null ? opts.density : 0.5;
  const S0 = segs[0].start, S1 = segs[segs.length - 1].end;
  const mel = (melody || []).filter(n => n.end > S0 + AR_EPS && n.start < S1 - AR_EPS)
    .map(n => ({ midi: n.midi, start: Math.max(S0, n.start), end: Math.min(S1, n.end) }))
    .sort((a, b) => a.start - b.start);
  const info = segs.map(s => arChordInfo(s.chord, key));
  const segAt = t => { for (let i = 0; i < segs.length; i++) if (t < segs[i].end - AR_EPS) return i; return segs.length - 1; };
  const form = opts.form && Array.isArray(opts.form.phrases) && opts.form.phrases.length ? opts.form : null;
  const { phrases, energyAt } = arPhrases(mel, meter, S0, S1, opts.energy || 'arc', form);
  // how busy the melody is over [t, t + len): 0 (resting) .. 1 (a note every half beat)
  const busy = (t, len) => {
    if (!form || typeof form.density !== 'function') return 0.5;
    let s = 0, k = 0;
    for (let x = t; x < t + Math.max(len || 1, 0.5) - AR_EPS; x += 0.5, k++) s += form.density(x + 0.25);
    return arClamp(s / Math.max(1, k) / 2);
  };
  // loudness: a swell into the phrase's high point and an easing after it, plus the tune's contour
  const swell = t => {
    const p = phrases.find(q => t >= q.start - AR_EPS && t < q.end) || phrases[phrases.length - 1];
    const pk = arClamp(p.peak != null ? p.peak : (p.start + p.end) / 2, p.start, p.end);
    const u = t <= pk ? arSmooth(arClamp((t - p.start) / Math.max(1, pk - p.start))) : 1 - 0.7 * arSmooth(arClamp((t - pk) / Math.max(1, p.end - pk)));
    const h = typeof form.contour === 'function' ? form.contour(t) : 0.5;
    return 0.1 * (u - 0.5) + 0.06 * (h - 0.5);
  };
  const c = {
    key, meter, segs, info, mel, reg, rnd, phrases, energyAt, segAt, form, busy,
    keySc: SCALES[key.mode].map(i => (key.root + i) % 12),
    // how much the bass moves; with a form, less under a busy melody and more in its gaps
    dens: form ? (t, len) => arClamp(energyAt(t) * (0.5 + density) * (1.25 - 0.6 * busy(t, len || meter.beats)))
      : t => arClamp(energyAt(t) * (0.5 + density)),
    // how much the inner voices decorate (neighbours, suspensions, passing notes)
    act: form ? (t, len) => arClamp(energyAt(t) + 0.15 - 0.35 * busy(t, len || meter.beats)) : t => energyAt(t),
    vel: (v, t) => Math.round(arClamp(v + (form && t != null ? swell(t) : 0) + (rnd() - 0.5) * 0.06, 0.05, 1) * 1000) / 1000,
  };
  const strip = ev => ({ midi: ev.midi, start: ev.start, len: ev.len, vel: ev.vel });
  let bass = arBass(c);
  let inner = arInner(c, bass);
  let counter = arCounter(c, Array.isArray(opts.motif) && opts.motif.length ? opts.motif : null);
  if (form) {
    ({ bass, inner, counter } = arRepeats(c, bass, inner, counter));
    ({ bass, inner } = arRepair(c, bass, inner, counter));
  }
  const phraseOut = p => {
    const o = { start: p.start, end: p.end, energy: p.energy };
    if (form) Object.assign(o, { label: p.label, sameAs: p.sameAs, shift: p.shift, role: p.role, cadence: p.cadence, peak: p.peak });
    return o;
  };
  return {
    bass: bass.map(strip), inner: inner.map(v => v.map(strip)), counter: counter.map(strip),
    phrases: phrases.map(phraseOut), energyAt,
  };
}
