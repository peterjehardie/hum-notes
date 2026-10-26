// Motifs: the short tune shapes a melody keeps coming back to, and lines built from them.
// Needs dsp.js first (SCALES, pcOf, detectMeter).
//
// A motif is a run of 3 to 6 notes whose shape repeats somewhere else in the melody. Shape
// means the steps between the notes counted in the key's scale (so the same figure sung a
// step higher still counts) and the rhythm (gaps between the note starts, the same or all
// exactly twice or half as long). The most important motif repeats most often, is longest,
// and tends to start on a strong beat.
//
// Every line is a list of { midi, qs, qe } in grid steps on the score's timeline, kept in
// the key, inside MIDI 28-84, and inside the requested span [fromStep, toStep):
// - motifOstinato: the motif over and over as a low line, starting on the key's home note.
// - motifImitation: each place the melody sings the motif is echoed a little later,
//   moved by some scale steps (-7 = an octave below).
// - motifSequence: the motif repeated, each time a few scale steps higher (or lower),
//   folding back down so it stays within about an octave and a half.
// - motifAugment: the motif slowed down (factor 2 = twice as slow), low, repeated.
// - motifInvert: the motif upside down (steps up become steps down), repeated.

const MOTIF_MIN = 28, MOTIF_MAX = 84;

// Scale degree of a MIDI note counted from the key's home note (C4 major: C4 = 35).
// Notes outside the key sit halfway between their neighbours (x.5).
function degreeOf(m, key) {
  const sc = SCALES[key.mode], rel = m - key.root, oct = Math.floor(rel / 12), pc = pcOf(rel);
  const i = sc.indexOf(pc);
  if (i >= 0) return oct * 7 + i;
  let lo = 0;
  for (let k = 0; k < sc.length; k++) if (sc[k] < pc) lo = k;
  return oct * 7 + lo + 0.5;
}

// MIDI note of a scale degree (rounded down onto the scale when it falls between).
function midiOfDegree(d, key) {
  const sc = SCALES[key.mode], di = Math.floor(d), oct = Math.floor(di / 7), i = ((di % 7) + 7) % 7;
  return key.root + 12 * oct + sc[i];
}

// Rhythm of a run: gaps between note starts, plus how long the last note lasts.
const gapsOf = run => run.slice(1).map((n, i) => n.qs - run[i].qs);

// How alike two rhythms are: 1 when all gaps are equal (or all exactly doubled or halved),
// 0.8 when each gap is within one grid step of that (hummed repeats are never exact), else 0.
function sameRhythm(a, b) {
  for (const f of [1, 2, 0.5]) if (a.every((x, i) => x === b[i] * f)) return 1;
  for (const f of [1, 2, 0.5]) if (a.every((x, i) => Math.abs(x - b[i] * f) <= 1)) return 0.8;
  return 0;
}

// Best repeating motif in a melody, or the opening notes (fallback) when nothing repeats.
function findMotif(notes, res, key) {
  if (!notes || notes.length < 2) return null;
  res = res || 2;
  key = key || detectKey(notes) || { root: 0, mode: 'major' };
  const meter = typeof detectMeter === 'function' ? detectMeter(notes, res) : { beats: 4, offset: 0 };
  const deg = notes.map(n => degreeOf(n.midi, key));
  const beatWeight = qs => {
    const b = qs / res - meter.offset, inBar = ((b % meter.beats) + meter.beats) % meter.beats;
    if (Math.abs(inBar) < 1e-6) return 1;          // downbeat
    if (Math.abs(b - Math.round(b)) < 1e-6) return 0.5;  // on a beat
    return 0;
  };
  let best = null;
  for (let len = 3; len <= 6; len++) {
    for (let i = 0; i + len <= notes.length; i++) {
      const iv = [];
      for (let k = 1; k < len; k++) iv.push(deg[i + k] - deg[i + k - 1]);
      if (iv.every(x => x === 0)) continue;  // one note repeated is not a motif
      const gaps = gapsOf(notes.slice(i, i + len));
      if (gaps.some(g => g <= 0)) continue;
      const occ = [i];
      let fit = 0;
      for (let j = i + len; j + len <= notes.length; j++) {
        let ok = true;
        for (let k = 1; k < len && ok; k++) if (deg[j + k] - deg[j + k - 1] !== iv[k - 1]) ok = false;
        const alike = ok ? sameRhythm(gapsOf(notes.slice(j, j + len)), gaps) : 0;
        if (!alike) continue;
        occ.push(j); fit += alike; j += len - 1;  // occurrences never overlap
      }
      if (occ.length < 2) continue;
      const strong = occ.reduce((s, o) => s + beatWeight(notes[o].qs), 0) / occ.length;
      const moves = new Set(iv).size > 1 ? 1 : 0.9;  // a little credit for a shape that changes direction or size
      const score = (1 + fit) * len * (1 + 0.3 * strong) * moves;
      if (!best || score > best.score + 1e-9) best = { i, len, occ, iv, score };
    }
  }
  const pack = (i, len, occ, iv, strength, fallback) => {
    const run = notes.slice(i, i + len), q0 = run[0].qs;
    const out = {
      notes: run.map((n, k) => ({ midi: n.midi, qs: n.qs - q0, qe: n.qe - q0, deg: deg[i + k] - deg[i] })),
      occurrences: occ, intervals: iv, semitones: run.slice(1).map((n, k) => n.midi - run[k].midi),
      durations: run.map(n => n.qe - n.qs), strength, key, res,
    };
    if (fallback) out.fallback = true;
    return out;
  };
  if (best) return pack(best.i, best.len, best.occ, best.iv, Math.round(best.score * 100) / 100, false);
  const len = Math.min(4, notes.length), iv = [];
  for (let k = 1; k < len; k++) iv.push(deg[k] - deg[k - 1]);
  return pack(0, len, [0], iv, 0, true);
}

// ---------- building lines ----------

// The motif as { d (whole scale steps from its first note), qs, qe } from 0, and its length
// rounded up to whole beats so repeats land on the beat.
function motifShape(motif, res) {
  const shape = motif.notes.map(n => ({ d: Math.floor(n.deg), qs: n.qs, qe: Math.max(n.qs + 1, n.qe) }));
  const end = Math.max(...shape.map(n => n.qe)), r = res || motif.res || 2;
  return { shape, period: Math.max(r, Math.ceil(end / r) * r) };
}

// Home-note degree whose octave puts the shape's middle closest to `register`.
function homeNear(shape, key, register) {
  const mid = (Math.min(...shape.map(n => n.d)) + Math.max(...shape.map(n => n.d))) / 2;
  let best = 0, bd = Infinity;
  for (let o = -2; o <= 9; o++) {
    const dist = Math.abs(midiOfDegree(o * 7 + mid, key) - register);
    if (dist < bd) { bd = dist; best = o * 7; }
  }
  return best;
}

// Degree -> MIDI, folded by octaves into 28-84.
function placeDegree(d, key) {
  let m = midiOfDegree(d, key);
  while (m < MOTIF_MIN) m += 12;
  while (m > MOTIF_MAX) m -= 12;
  return m;
}

// Lay copies of a shape end to end over [from, to); `degAt(k)` moves copy k, `scale` stretches time.
function tile(shape, period, key, from, to, degAt, scale) {
  const out = [];
  for (let k = 0, at = from; at < to; k++, at += period * scale) {
    const base = degAt(k);
    for (const n of shape) {
      const qs = at + n.qs * scale, qe = Math.min(to, at + n.qe * scale);
      if (qs >= to || qe <= qs) continue;
      out.push({ midi: placeDegree(base + n.d, key), qs, qe });
    }
  }
  return out;
}

function motifOstinato(motif, key, fromStep, toStep, register) {
  if (!motif || !key || toStep <= fromStep) return [];
  const { shape, period } = motifShape(motif);
  const home = homeNear(shape, key, register || 40);
  return tile(shape, period, key, fromStep, toStep, () => home, 1);
}

// Echo each melody occurrence. Uses the melody's own notes at that place, so the echo
// follows how it was actually sung there.
function motifImitation(motif, melodyNotes, key, delaySteps, intervalSteps) {
  if (!motif || !key || !melodyNotes) return [];
  const len = motif.notes.length, out = [];
  for (const o of motif.occurrences) {
    for (let k = 0; k < len && o + k < melodyNotes.length; k++) {
      const n = melodyNotes[o + k], qs = n.qs + delaySteps, qe = Math.max(qs + 1, n.qe + delaySteps);
      out.push({ midi: placeDegree(Math.floor(degreeOf(n.midi, key)) + intervalSteps, key), qs, qe });
    }
  }
  out.sort((a, b) => a.qs - b.qs);
  for (let i = 0; i + 1 < out.length; i++) if (out[i].qe > out[i + 1].qs) out[i].qe = Math.max(out[i].qs + 1, out[i + 1].qs);
  return out.filter((n, i) => i + 1 >= out.length || n.qs < out[i + 1].qs);
}

function motifSequence(motif, key, fromStep, toStep, stepUp, register) {
  if (!motif || !key || toStep <= fromStep) return [];
  const { shape, period } = motifShape(motif);
  const lo = Math.min(...shape.map(n => n.d)), hi = Math.max(...shape.map(n => n.d));
  const room = Math.max(1, 11 - (hi - lo));  // offsets that keep it inside ~1.5 octaves
  const step = stepUp || 1;
  // Start low when climbing and high when falling, so the travel centres on `register`.
  const home = homeNear(shape, key, register || 52) - Math.sign(step) * Math.floor(room / 2);
  const off = k => {
    const v = (((k * Math.abs(step)) % room) + room) % room;
    return step > 0 ? v : -v;
  };
  return tile(shape, period, key, fromStep, toStep, k => home + off(k), 1);
}

function motifAugment(motif, key, fromStep, toStep, factor, register) {
  if (!motif || !key || toStep <= fromStep) return [];
  const f = factor > 0 ? factor : 2;
  const { shape, period } = motifShape(motif);
  const home = homeNear(shape, key, register || 38);
  return tile(shape, period, key, fromStep, toStep, () => home, f)
    .map(n => ({ midi: n.midi, qs: Math.round(n.qs), qe: Math.round(n.qe) }))
    .filter(n => n.qe > n.qs && n.qe <= toStep);
}

function motifInvert(motif, key, fromStep, toStep, register) {
  if (!motif || !key || toStep <= fromStep) return [];
  const { shape, period } = motifShape(motif);
  const flipped = shape.map(n => ({ ...n, d: -n.d }));
  const home = homeNear(flipped, key, register || 45);
  return tile(flipped, period, key, fromStep, toStep, () => home, 1);
}
