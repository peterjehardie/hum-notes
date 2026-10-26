// Musical form of a sung tune, and chords that follow it. Classic music theory, no learning:
// the tune is cut into phrases (rests, long notes, notes of rest), phrases are compared by shape
// (scale steps and rhythm, so a phrase sung a step higher still counts as a repeat) and labelled
// A, A2 (a varied repeat), B..., each phrase ending is heard as open (a question: it stops on
// the 2nd, 5th or 7th of the key) or closed (an answer: it comes home to the 1st, or the 3rd on a
// strong beat). Chords then change where the melody moves rather than on a fixed clock, cadences
// land where the phrases end (V-I or IV-I when closed, V when open), and repeated phrases get
// the same chords again. Needs dsp.js first (SCALES, pcOf, chordsOf, FUNC, median).
//
// analyseForm(notes, key, meter, res) -> {
//   phrases: [{ start, end (beats, bar-aligned, contiguous), label, sameAs, shift (scale steps
//     of a transposed repeat), sim, role, cadence, peak, noteStart, noteEnd, first, last (note
//     indices) }],
//   density: beat -> notes per beat nearby, contour: beat -> 0..1 height of the tune,
//   start, end (the whole span in beats) }
// harmonizeForm(notes, key, meter, res, opts) -> segs like harmonize():
//   [{ start, end, chord, alts, phrase }], opts = { colour, form, rate: 'auto' | 0.5 | 1 | 2 }.
//   notes: score notes { midi, qs, qe } (grid steps, res steps per beat), meter { beats, offset }.

const FM_EPS = 1e-6;

// Scale degree counted from the key's home note; notes outside the key sit at x.5.
function fmDegree(m, key) {
  const sc = SCALES[key.mode], rel = m - key.root, oct = Math.floor(rel / 12), pc = pcOf(rel);
  const i = sc.indexOf(pc);
  if (i >= 0) return oct * 7 + i;
  let lo = 0;
  for (let k = 0; k < sc.length; k++) if (sc[k] < pc) lo = k;
  return oct * 7 + lo + 0.5;
}
const fmDeg7 = (m, key) => ((Math.floor(fmDegree(m, key)) % 7) + 7) % 7;

// Beat strength: downbeat 1, middle of a 4/4 bar 0.75, other beats 0.5, off-beats 0.2.
function fmStrength(t, meter) {
  const rel = t - meter.offset;
  if (Math.abs(rel - Math.round(rel)) > FM_EPS) return 0.2;
  const inBar = ((Math.round(rel) % meter.beats) + meter.beats) % meter.beats;
  if (inBar === 0) return 1;
  if (meter.beats === 4 && inBar === 2) return 0.75;
  return 0.5;
}

// Score notes -> { midi, start, end } in beats, sorted, one at a time.
function fmMelody(notes, res) {
  return (notes || []).filter(n => n.qe > n.qs)
    .map(n => ({ midi: n.midi, start: n.qs / res, end: n.qe / res }))
    .sort((a, b) => a.start - b.start);
}

// How alike two phrases are: 0..1, plus the scale-step shift that matches them best. The notes
// are aligned by edit distance; a matched pair costs by how far apart its scale steps (after
// the shift) and its rhythm are, a note sung in one and not the other costs 0.8.
function fmSimilarity(P, Q) {
  if (!P.length || !Q.length) return { sim: 0, shift: 0 };
  let best = { sim: -Infinity, shift: 0 };
  const shifts = new Set([0]);
  for (const p of P) for (const q of Q) { const s = Math.round(q.deg - p.deg); if (Math.abs(s) <= 7) shifts.add(s); }
  for (const s of shifts) {
    const D = [];
    for (let i = 0; i <= P.length; i++) { D.push(new Array(Q.length + 1).fill(0)); D[i][0] = 0.8 * i; }
    for (let j = 0; j <= Q.length; j++) D[0][j] = 0.8 * j;
    for (let i = 1; i <= P.length; i++) for (let j = 1; j <= Q.length; j++) {
      const p = P[i - 1], q = Q[j - 1], dd = Math.abs(q.deg - p.deg - s);
      const pc = dd < FM_EPS ? 0 : dd <= 1 ? 0.55 : 1;
      const rc = Math.min(1, Math.abs(q.on - p.on)) * 0.5 + (Math.abs(q.dur - p.dur) > 0.5 + FM_EPS ? 0.15 : 0);
      D[i][j] = Math.min(D[i - 1][j - 1] + Math.min(1.2, pc * 0.75 + rc), D[i - 1][j] + 0.8, D[i][j - 1] + 0.8);
    }
    const sim = 1 - D[P.length][Q.length] / Math.max(P.length, Q.length) - 0.01 * Math.abs(s);
    if (sim > best.sim) best = { sim, shift: s };
  }
  return best;
}

function analyseForm(notes, key, meter, res) {
  res = res || 2;
  meter = meter || { beats: 4, offset: 0 };
  const mel = fmMelody(notes, res), B = meter.beats, off = meter.offset;
  const barFloor = t => Math.floor((t - off) / B + FM_EPS) * B + off;
  const barCeil = t => Math.ceil((t - off) / B - FM_EPS) * B + off;
  if (!mel.length || !key) return { phrases: [], density: () => 0, contour: () => 0.5, start: 0, end: 0 };
  const n = mel.length;
  const S0 = barFloor(mel[0].start), S1 = Math.max(S0 + B, barCeil(mel[n - 1].end));
  const md = median(mel.map(x => x.end - x.start));

  // how strongly the tune breathes after each note
  const brk = mel.map((x, i) => {
    const nx = mel[i + 1];
    if (!nx) return 0;
    const rest = nx.start - x.end, d = x.end - x.start;
    let s = 0;
    if (rest >= 1 - FM_EPS) s += 2 + 0.5 * Math.min(rest, 2);
    else if (rest >= 0.5 - FM_EPS) s += 0.7;
    if (d >= 2 - FM_EPS && d >= 1.5 * md) s += 1.4;
    else if (d >= 1.5 - FM_EPS && d >= 1.5 * md) s += 0.7;
    if (d >= 1 - FM_EPS && d > 1.5 * (nx.end - nx.start)) s += 0.2;
    const deg = fmDeg7(x.midi, key);
    s += deg === 0 || deg === 4 ? 0.3 : deg === 2 || deg === 1 ? 0.15 : 0;
    const ph = (((nx.start - off) % B) + B) % B;
    if (ph < FM_EPS || ph >= B - 1 - FM_EPS) s += 0.3;
    return s;
  });
  // phrase lengths: two or four bars sound natural, under a bar or over four less so
  const lenCost = x => (x < 0.75 ? 4 : 0) + (x < 1.5 ? 0.8 : 0)
    + (x <= 4.5 ? 0.5 * Math.min(Math.abs(x - 2), Math.abs(x - 4)) : 1 + 0.6 * (x - 4.5));
  const best = [0], from = [0];
  for (let j = 1; j <= n; j++) {
    best.push(Infinity); from.push(0);
    for (let i = 0; i < j; i++) {
      const until = j < n ? mel[j].start : S1;
      const v = best[i] + lenCost((until - mel[i].start) / B) + 1 - (j < n ? brk[j - 1] : 0);
      if (v < best[j]) { best[j] = v; from[j] = i; }
    }
  }
  const cuts = [];
  for (let j = n; j > 0; j = from[j]) cuts.unshift([from[j], j - 1]);

  // bar-aligned spans; a pickup in the last beat of a bar belongs to the bar after it
  const ph = [];
  for (const [i0, i1] of cuts) {
    if (!ph.length) { ph.push({ start: S0, first: i0, last: i1 }); continue; }
    const prev = ph[ph.length - 1], b = barFloor(mel[i0].start + 1);
    if (b <= prev.start + FM_EPS || b <= mel[prev.last].start + FM_EPS || b >= S1 - FM_EPS) prev.last = i1;
    else ph.push({ start: b, first: i0, last: i1 });
  }
  ph.forEach((p, i) => { p.end = i + 1 < ph.length ? ph[i + 1].start : S1; });

  // shapes for comparing: scale step, onset from the phrase's first note, length
  const shapes = ph.map(p => mel.slice(p.first, p.last + 1).map(x => ({
    deg: fmDegree(x.midi, key), on: x.start - mel[p.first].start, dur: Math.min(4, x.end - x.start),
  })));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let nextLetter = 0;
  const variants = {};
  ph.forEach((p, i) => {
    const notesIn = mel.slice(p.first, p.last + 1), lastN = notesIn[notesIn.length - 1];
    p.noteStart = notesIn[0].start; p.noteEnd = lastN.end;
    let top = notesIn[0];
    for (const x of notesIn) if (x.midi > top.midi) top = x;
    p.peak = top.start;
    // how the phrase ends
    const deg = fmDeg7(lastN.midi, key), strong = fmStrength(lastN.start, meter) >= 0.75 || lastN.end - lastN.start >= 1.5 - FM_EPS;
    const isLast = i === ph.length - 1;
    p.cadence = deg === 0 ? 'closed' : deg === 2 ? (strong ? 'closed' : 'open') : deg === 1 || deg === 4 || deg === 6 ? 'open'
      : lastN.end - lastN.start >= 1.5 - FM_EPS ? 'open' : null;
    if (isLast && deg === 0) p.cadence = 'closed';
    p.role = p.cadence === 'open' ? 'question' : p.cadence === 'closed' && i > 0 && ph[i - 1].cadence === 'open' ? 'answer' : 'statement';
    // repeats: the most alike earlier phrase of a similar length
    let bestJ = -1, bs = { sim: 0, shift: 0 };
    for (let j = 0; j < i; j++) {
      const r = fmSimilarity(shapes[j], shapes[i]);
      const lenRatio = Math.min(p.end - p.start, ph[j].end - ph[j].start) / Math.max(p.end - p.start, ph[j].end - ph[j].start);
      const sim = r.sim * (lenRatio >= 0.74 ? 1 : 0.8) * (Math.min(shapes[i].length, shapes[j].length) < 3 ? 0.85 : 1);
      if (sim > bs.sim + FM_EPS) { bs = { sim, shift: r.shift }; bestJ = j; }
    }
    p.sim = Math.round(bs.sim * 100) / 100;
    if (bestJ >= 0 && bs.sim >= 0.6) {
      const root = ph[bestJ].sameAs >= 0 ? ph[bestJ].sameAs : bestJ;
      p.sameAs = root;
      p.shift = bs.shift + (ph[bestJ].sameAs >= 0 ? ph[bestJ].shift : 0);
      const base = ph[root].label;
      if (bs.sim >= 0.85) p.label = base;
      else { variants[base] = (variants[base] || 1) + 1; p.label = base + variants[base]; }
    } else {
      p.sameAs = -1; p.shift = 0;
      p.label = letters[nextLetter % 26] + (nextLetter >= 26 ? Math.floor(nextLetter / 26) : '');
      nextLetter++;
    }
  });

  // notes per beat around a moment (each onset spread over a beat either side)
  const density = t => {
    let s = 0;
    for (const x of mel) { const d = Math.abs(x.start - t); if (d < 1) s += 1 - d; }
    return s;
  };
  // height of the tune, 0 (lowest note) .. 1 (highest), joining note middles in straight lines
  const lo = Math.min(...mel.map(x => x.midi)), hi = Math.max(...mel.map(x => x.midi));
  const pts = mel.map(x => [(x.start + x.end) / 2, hi > lo ? (x.midi - lo) / (hi - lo) : 0.5]);
  const contour = t => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) {
      const [ta, va] = pts[i - 1], [tb, vb] = pts[i];
      return tb - ta < FM_EPS ? vb : va + (vb - va) * (t - ta) / (tb - ta);
    }
    return pts[pts.length - 1][1];
  };
  return {
    phrases: ph.map(p => ({
      start: p.start, end: p.end, label: p.label, sameAs: p.sameAs, shift: p.shift, sim: p.sim, role: p.role,
      cadence: p.cadence, peak: p.peak, noteStart: p.noteStart, noteEnd: p.noteEnd, first: p.first, last: p.last,
    })),
    density, contour, start: S0, end: S1,
  };
}

// ---------- chords that follow the form ----------
// A best-path search over (segment end, chord) where segments have varying lengths: a segment
// may start on a bar line, or on a beat where the melody sings a new note (the middle of a 4/4
// bar too when the chord rate asks for it), and may not cross a phrase start. Each segment pays
// for existing (so chords do not change too often), for being far from the chosen harmonic
// rhythm, for starting on a weak beat (less when the melody walks by step: a passing chord) and
// for syncopation; it earns the melody's fit (chord tones good, semitone clashes bad, the 7th
// over a dominant fine). Moves earn tonic -> predominant -> dominant -> tonic, falls of a fifth,
// and cadences: home (I) at a closed phrase end, best from V (or IV, plagal), and V at an open one.
// Phrases that repeat an earlier one get its chords (moved by the scale steps of the repeat);
// a varied repeat, or the cadence of the last repeat, may change a chord if it pays.
function harmonizeForm(notes, key, meter, res, opts) {
  opts = opts || {};
  res = res || 2;
  if (!key || !notes || !notes.length) return [];
  meter = meter || { beats: 4, offset: 0 };
  const mel = fmMelody(notes, res);
  if (!mel.length) return [];
  const form = opts.form && Array.isArray(opts.form.phrases) && opts.form.phrases.length ? opts.form : analyseForm(notes, key, meter, res);
  const colour = opts.colour || 'plain';
  const chords = chordsOf(key, colour), N = chords.length, sc = SCALES[key.mode];
  const B = meter.beats, off = meter.offset;
  const inBarOf = t => (((t - off) % B) + B) % B;
  const barFloor = t => Math.floor((t - off) / B + FM_EPS) * B + off;
  const barCeil = t => Math.ceil((t - off) / B - FM_EPS) * B + off;
  const S0 = barFloor(mel[0].start), S1 = Math.max(S0 + B, barCeil(mel[mel.length - 1].end));
  const rate = opts.rate == null || opts.rate === 'auto' ? null : +opts.rate;
  const target = rate > 0 ? B / rate : B <= 2 ? 2 * B : B;
  const maxLen = Math.max(2 * target, B);

  // phrases inside the span, as integer beats
  const phr = form.phrases.map((p, i) => ({ ...p, i, start: Math.round(Math.max(S0, Math.min(S1, p.start))), end: Math.round(Math.max(S0, Math.min(S1, p.end))) }))
    .filter(p => p.end > p.start);
  const mandatory = new Set([S0, S1, ...phr.map(p => p.start)]);
  const phraseOf = t => phr.find(p => t >= p.start - FM_EPS && t < p.end - FM_EPS) || null;

  const onsetAt = new Map();
  mel.forEach((x, k) => { if (Math.abs(x.start - Math.round(x.start)) < FM_EPS) onsetAt.set(Math.round(x.start), k); });
  const sounding = t => mel.find(x => x.start < t - FM_EPS && x.end > t + FM_EPS);
  // the melody walks by step through the note starting at t
  const walking = t => {
    const k = onsetAt.get(t);
    if (k == null || k === 0 || k === mel.length - 1) return false;
    const a = mel[k].midi - mel[k - 1].midi, b = mel[k + 1].midi - mel[k].midi;
    return a !== 0 && b !== 0 && Math.abs(a) <= 2 && Math.abs(b) <= 2 && Math.sign(a) === Math.sign(b);
  };
  const boundsWith = extra => {
    const out = [];
    for (let t = S0; t <= S1; t++) {
      const ib = inBarOf(t);
      if (ib < FM_EPS || onsetAt.has(t) || mandatory.has(t) || extra.has(t) || (B === 4 && Math.abs(ib - 2) < FM_EPS && target < B)) out.push(t);
    }
    return out;
  };
  // what starting a chord at beat t costs
  const startCost = t => {
    if (t === S0) return 0;
    const ib = inBarOf(t), on = onsetAt.has(t), held = !on && sounding(t);
    if (ib < FM_EPS) return held ? 0.25 : 0;
    let v = B === 4 && Math.abs(ib - 2) < FM_EPS ? 0.15 : 0.45;
    if (held) v += 0.35;
    else if (on && walking(t)) v -= 0.2;
    return v;
  };
  const segCost = (a, b) => {
    const L = b - a, ib = inBarOf(a);
    let v = 0.7 + 0.5 * Math.abs(Math.log2(L / target)) + startCost(a);
    if (ib > FM_EPS && b > a + (B - ib) + FM_EPS) v += 0.6;   // across a bar line from mid-bar
    if (L <= 1 + FM_EPS && fmStrength(a, meter) < 0.75 && !walking(a)) v += 0.6;
    return v;
  };

  // melody fit of a chord over [a, b) (the 7th over a dominant counts as half fitting)
  const dom = (key.root + 7) % 12;
  const fitRaw = (a, b, c) => {
    let s = 0;
    for (const x of mel) {
      const lo = Math.max(a, x.start), hi = Math.min(b, x.end);
      if (hi <= lo + FM_EPS) continue;
      let w = (hi - lo) * (Math.abs(x.start - a) < FM_EPS ? 1.5 : 1);
      if (x.start >= a - FM_EPS && fmStrength(x.start, meter) >= 0.75) w += 0.3 * Math.min(1, hi - lo);
      const pc = pcOf(x.midi), clash = c.pcs.some(p => Math.abs(pcOf(pc - p + 6) - 6) === 1);
      const sev = c.root === dom && c.quality === '' && pc === (c.root + 10) % 12;
      s += w * (c.pcs.includes(pc) ? 1 : sev ? 0.5 : clash ? -0.9 : sc.includes(pcOf(pc - key.root)) ? 0.1 : -0.4);
    }
    return s - (c.quality === '°' ? 0.4 * (b - a) : 0) + c.pull * Math.min(b - a, 4) * 0.2;
  };
  const memo = new Map();
  const fit = (a, b, j) => {
    const k = a + ',' + b + ',' + j;
    if (!memo.has(k)) memo.set(k, fitRaw(a, b, chords[j]));
    return memo.get(k);
  };

  // a chord moved by scale steps (diatonic chords keep their place in the key)
  const shiftChord = (j, t) => {
    if (!t) return j;
    const c = chords[j], d = sc.indexOf(pcOf(c.root - key.root));
    if (d < 0) return j;
    const root2 = (key.root + sc[(((d + t) % 7) + 7) % 7]) % 12;
    let k = chords.findIndex(x => x.root === root2 && x.quality === c.quality);
    if (k < 0) k = chords.findIndex(x => x.root === root2 && !x.pull);
    return k < 0 ? j : k;
  };

  // repeats that can copy their original: same span length, the tune starting at the same place
  const copies = phr.filter(q => q.sameAs >= 0).map(q => {
    const o = phr.find(p => p.i === q.sameAs);
    if (!o || o.end - o.start !== q.end - q.start || Math.abs((q.noteStart - q.start) - (o.noteStart - o.start)) >= 0.5) return null;
    return { q, o, d: q.start - o.start, shift: q.shift || 0 };
  }).filter(Boolean);
  const lastCopyOf = new Map();
  copies.forEach(cp => lastCopyOf.set(cp.o.i, cp));
  // a varied repeat, and the last repeat when its ending differs, write their cadence bar afresh
  for (const cp of copies) {
    const varied = cp.q.label !== cp.o.label, lastRep = lastCopyOf.get(cp.o.i) === cp;
    cp.varied = varied;
    const cadChange = lastRep && (cp.q.cadence !== cp.o.cadence || cp.q === phr[phr.length - 1]);
    const c = mel[cp.q.last] ? barFloor(mel[cp.q.last].start) : cp.q.end;
    cp.freeFrom = (varied || cadChange) && c > cp.q.start ? Math.min(cp.q.end, c) : cp.q.end;
  }
  // fit averaged over an original and its repeats, so the original's chords suit them all
  const pooled = (a, b, j) => {
    let v = fit(a, b, j), w = 1;
    const p = phraseOf(a);
    if (p) for (const cp of copies) if (cp.o === p && b + cp.d <= cp.freeFrom + FM_EPS) {
      const k = cp.varied ? 0.4 : 0.7;
      v += k * fit(a + cp.d, b + cp.d, shiftChord(j, cp.shift)); w += k;
    }
    return v / w;
  };

  // cadences: where each phrase ends and how
  const cads = phr.filter(p => p.cadence && p.last != null && mel[p.last]).map(p => ({ c: mel[p.last].start, type: p.cadence }));
  const isTonic = j => chords[j].root === key.root && FUNC[chords[j].roman] === 'T';
  const isDom = j => chords[j].root === dom || chords[j].roman === 'vii°';
  const isSub = j => chords[j].root === (key.root + 5) % 12;   // IV / iv: the plagal close
  const cadBonus = (i, j, a, b) => {
    let v = 0;
    for (const cd of cads) {
      if (cd.c < a - FM_EPS || cd.c >= b - FM_EPS) continue;
      if (cd.type === 'closed' && isTonic(j)) {
        if (a >= cd.c - B + FM_EPS && i !== j) {
          v += 1.2;
          if (i != null && isDom(i)) v += 1.4;
          else if (i != null && isSub(i)) v += 0.7;
        } else v += 0.4;
      } else if (cd.type === 'open' && chords[j].root === dom) {
        v += i === j ? 0.4 : 1.2;
        if (i != null && FUNC[chords[i].roman] !== 'D') v += 0.3;
      }
    }
    return v;
  };
  const trans = (i, j, t) => {
    if (i === j) return mandatory.has(t) ? -0.1 : -0.9;
    const fa = FUNC[chords[i].roman], fb = FUNC[chords[j].roman];
    let v = (fa === 'T' && fb === 'P') || (fa === 'P' && fb === 'D') || (fa === 'D' && fb === 'T') ? 0.35
      : (fa === 'T' && fb === 'D') || (fa === 'P' && fb === 'T') ? 0.15 : fa === 'D' && fb === 'P' ? -0.25 : 0;
    if (pcOf(chords[i].root - chords[j].root) === 7) v += 0.15;
    return v;
  };

  // forced: beat -> { b, opts: [[chord, penalty]...] } (a fixed segment with its allowed chords)
  const solve = (forced, emit) => {
    const extra = new Set();
    for (const [a, f] of forced) { extra.add(a); extra.add(f.b); }
    const bounds = boundsWith(extra), NB = bounds.length, idx = new Map(bounds.map((t, k) => [t, k]));
    const score = bounds.map(() => new Array(N).fill(-Infinity)), back = bounds.map(() => new Array(N).fill(null));
    for (let ia = 0; ia < NB - 1; ia++) {
      const a = bounds[ia];
      if (ia > 0 && !score[ia].some(v => v > -Infinity)) continue;
      const nexts = [];
      if (forced.has(a)) {
        const f = forced.get(a);
        nexts.push([idx.get(f.b), f.opts]);
      } else {
        for (let ib = ia + 1; ib < NB; ib++) {
          const b = bounds[ib];
          if (b - a > maxLen + FM_EPS) break;
          nexts.push([ib, null]);
          if (mandatory.has(b) || forced.has(b)) break;
        }
        // a phrase longer than the longest segment still needs a way through
        if (!nexts.length) nexts.push([ia + 1, null]);
      }
      for (const [ib, fo] of nexts) {
        const b = bounds[ib], base = -segCost(a, b);
        const list = fo || chords.map((c, j) => [j, 0]);
        for (const [j, pen] of list) {
          const e = emit(a, b, j) + base - pen;
          if (ia === 0) {
            const v = e + (isTonic(j) ? 0.5 : 0) + cadBonus(null, j, a, b);
            if (v > score[ib][j]) { score[ib][j] = v; back[ib][j] = [ia, -1]; }
            continue;
          }
          for (let i = 0; i < N; i++) {
            if (score[ia][i] === -Infinity) continue;
            const v = score[ia][i] + trans(i, j, a) + e + cadBonus(i, j, a, b);
            if (v > score[ib][j]) { score[ib][j] = v; back[ib][j] = [ia, i]; }
          }
        }
      }
    }
    const lastRow = score[NB - 1].map((v, j) => v + (isTonic(j) ? 0.6 : chords[j].root === dom ? 0.2 : 0));
    let j = lastRow.indexOf(Math.max(...lastRow)), ib = NB - 1;
    const out = [];
    while (ib > 0 && back[ib][j]) {
      const [ia, i] = back[ib][j];
      out.unshift({ start: bounds[ia], end: bounds[ib], j });
      ib = ia; j = i;
    }
    return out;
  };

  let path = solve(new Map(), pooled);
  if (copies.length) {
    // second pass: originals keep their chords, repeats copy them
    const forced = new Map();
    for (const cp of copies) {
      for (const s of path) if (s.start >= cp.o.start - FM_EPS && s.end <= cp.o.end + FM_EPS) forced.set(s.start, { b: s.end, opts: [[s.j, 0]] });
    }
    for (const cp of copies) {
      for (const s of path) {
        if (s.start < cp.o.start - FM_EPS || s.end > cp.o.end + FM_EPS || s.start + cp.d >= cp.freeFrom - FM_EPS) continue;
        const j = shiftChord(s.j, cp.shift);
        // a varied repeat may still change a chord where its notes ask for it
        const opts2 = cp.varied ? chords.map((c, i) => [i, i === j ? 0 : 1.0]) : [[j, 0]];
        forced.set(s.start + cp.d, { b: Math.min(s.end + cp.d, cp.freeFrom), opts: opts2 });
      }
    }
    path = solve(forced, (a, b, j) => fit(a, b, j));
  }

  return path.map(s => {
    const pick = chords[s.j];
    const alts = chords.map((c, i) => ({ c, v: fit(s.start, s.end, i) })).sort((x, y) => y.v - x.v).map(x => x.c);
    const p = phraseOf(s.start);
    return { start: s.start, end: s.end, chord: pick, alts: [pick, ...alts.filter(c => c !== pick)], phrase: p ? p.i : -1 };
  });
}
