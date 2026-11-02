// Genre: what kind of music a hummed melody suggests, and a full backing recipe for each kind.
// Pure, no DOM, no audio.
//
// The fingerprint is read from the melody alone: its scale (five-note, modal turns, blue notes,
// notes outside the key), its meter, swing and triplets, how often notes start off the beat and
// push across it, dotted rhythms, repeated notes, long and short notes, steps and leaps, its range
// and its tempo. Each genre lists the traits melodies in it tend to have; the genres whose traits
// the melody shows most come first, with the traits named. A melody can fit several genres, so
// this is a suggestion to start from, not a verdict.

// ---------- what each genre's backing is made of ----------
// Every field is a backing setting in app.js: harmony (chord colour), chordRate, writing +
// chordStyle (how the chords are played), sound, spacing, register, feel (drums), bassStyle,
// swing, energy, intro, ending; drone and counter switch those parts on or off; inst gives a
// part its own instrument; busy is how much the moving parts do.
const GENRES = {
  pop: { name: 'Pop', about: 'IV–V–vi chords on a pulsing piano, backbeat, bass with the kick',
    harmony: 'pop', chordRate: '1', writing: 'blocks', chordStyle: 'pulse', sound: 'keys', spacing: 'close', register: 'mid', feel: 'backbeat', bassStyle: 'kick', swing: 'straight', energy: 'build', drone: false, counter: true, busy: 0.5, intro: '1', ending: 'ring' },
  rock: { name: 'Rock', about: 'power chords in eighths, ♭VII chords, a driving bass and rock beat',
    harmony: 'rock', chordRate: '1', writing: 'blocks', chordStyle: 'eighths', sound: 'pluck', spacing: 'open', register: 'mid', feel: 'rock', bassStyle: 'eighths', swing: 'straight', energy: 'build', drone: false, counter: false, busy: 0.6, intro: '1', ending: 'stop' },
  blues: { name: 'Blues', about: 'I7–IV7–V7, shuffle, walking bass, piano stabs',
    harmony: 'blues', chordRate: '1', writing: 'blocks', chordStyle: 'stabs', sound: 'keys', spacing: 'close', register: 'mid', feel: 'shuffle', bassStyle: 'walking', swing: 'swung', energy: 'arc', drone: false, counter: true, busy: 0.5, intro: '1', ending: 'ring' },
  jazz: { name: 'Jazz / swing', about: 'sevenths, ii–V approach chords, ride cymbal, walking bass',
    harmony: 'jazz', chordRate: '2', writing: 'blocks', chordStyle: 'stabs', sound: 'keys', spacing: 'close', register: 'mid', feel: 'jazz', bassStyle: 'walking', swing: 'swung', energy: 'arc', drone: false, counter: false, busy: 0.5, intro: '1', ending: 'ring' },
  lofi: { name: 'Lo-fi hip-hop', about: 'soft seventh chords on keys, lazy swung boom-bap, bass with the kick',
    harmony: 'rich', chordRate: '1', writing: 'blocks', chordStyle: 'pad', sound: 'keys', spacing: 'close', register: 'mid', feel: 'boombap', bassStyle: 'kick', swing: 'swung', energy: 'flat', drone: false, counter: false, busy: 0.4, intro: '1', ending: 'ring' },
  folk: { name: 'Folk', about: 'strummed open chords, two-beat bass, a drone and a light lilt',
    harmony: 'plain', chordRate: '1', writing: 'blocks', chordStyle: 'strum', sound: 'pluck', spacing: 'open', register: 'mid', feel: 'lilt', bassStyle: 'twobeat', swing: 'auto', energy: 'arc', drone: true, counter: true, busy: 0.5, intro: '1', ending: 'ring' },
  celtic: { name: 'Celtic', about: 'modal chords, drone, strummed with a driving beat and a flute answering',
    harmony: 'modal', chordRate: '1', writing: 'blocks', chordStyle: 'strum', sound: 'pluck', spacing: 'open', register: 'mid', feel: 'drive', bassStyle: 'twobeat', swing: 'auto', energy: 'build', drone: true, counter: true, inst: { counter: 'flute' }, busy: 0.6, intro: '1', ending: 'stop' },
  country: { name: 'Country', about: 'boom-chick guitar, two-beat bass, train beat on the snare',
    harmony: 'plain', chordRate: '1', writing: 'blocks', chordStyle: 'boomchick', sound: 'pluck', spacing: 'close', register: 'mid', feel: 'train', bassStyle: 'twobeat', swing: 'straight', energy: 'arc', drone: false, counter: false, busy: 0.5, intro: '1', ending: 'ring' },
  latin: { name: 'Latin / bossa', about: 'seventh chords in bossa stabs, bossa drums, bass on the bossa kick',
    harmony: 'rich', chordRate: '1', writing: 'blocks', chordStyle: 'stabs', sound: 'pluck', spacing: 'close', register: 'mid', feel: 'bossa', bassStyle: 'kick', swing: 'straight', energy: 'flat', drone: false, counter: false, busy: 0.5, intro: '1', ending: 'ring' },
  reggae: { name: 'Reggae', about: 'off-beat skank chords, one-drop drums, a roomy bass',
    harmony: 'plain', chordRate: '1', writing: 'blocks', chordStyle: 'skank', sound: 'keys', spacing: 'close', register: 'mid', feel: 'onedrop', bassStyle: 'feel', swing: 'auto', energy: 'flat', drone: false, counter: false, busy: 0.5, intro: '1', ending: 'ring' },
  waltz: { name: 'Waltz', about: 'oom-pah-pah: bass on one, chords on two and three',
    harmony: 'plain', chordRate: '1', writing: 'blocks', chordStyle: 'boomchick', sound: 'strings', spacing: 'close', register: 'mid', feel: 'waltz', bassStyle: 'twobeat', swing: 'straight', energy: 'arc', drone: false, counter: true, busy: 0.5, intro: '1', ending: 'ring' },
  ballad: { name: 'Ballad', about: 'arpeggiated piano, half-time drums, strings answering, building up',
    harmony: 'pop', chordRate: '1', writing: 'blocks', chordStyle: 'arp', sound: 'keys', spacing: 'open', register: 'mid', feel: 'halftime', bassStyle: 'feel', swing: 'straight', energy: 'build', drone: false, counter: true, inst: { counter: 'violins' }, busy: 0.4, intro: '1', ending: 'ring' },
  anthem: { name: 'Anthem / march', about: 'orchestra in moving voices, the ♭VI–♭VII–I lift, march drums',
    harmony: 'lift', chordRate: '1', writing: 'arranged', chordStyle: 'pulse', sound: 'orchestra', spacing: 'wide', register: 'mid', feel: 'march', bassStyle: 'feel', swing: 'straight', energy: 'build', drone: true, counter: true, busy: 0.6, intro: '1', ending: 'ring' },
  cinematic: { name: 'Cinematic', about: 'dark chords over a low string riff, driving drums, building',
    harmony: 'dark', chordRate: '2', writing: 'blocks', chordStyle: 'ostinato', sound: 'orchestra', spacing: 'wide', register: 'mid', feel: 'drive', bassStyle: 'feel', swing: 'straight', energy: 'build', drone: false, counter: true, busy: 0.6, intro: '2', ending: 'ring' },
  classical: { name: 'Classical', about: 'orchestra in moving voices with a counter-melody, no drums',
    harmony: 'plain', chordRate: '1', writing: 'arranged', chordStyle: 'pad', sound: 'orchestra', spacing: 'open', register: 'mid', feel: 'none', bassStyle: 'feel', swing: 'straight', energy: 'arc', drone: false, counter: true, busy: 0.5, intro: '0', ending: 'ring' },
  children: { name: 'Children’s song', about: 'plucked boom-chick chords, simple bass, light drums',
    harmony: 'plain', chordRate: '1', writing: 'blocks', chordStyle: 'boomchick', sound: 'pluck', spacing: 'close', register: 'high', feel: 'sparse', bassStyle: 'twobeat', swing: 'straight', energy: 'flat', drone: false, counter: false, busy: 0.3, intro: '1', ending: 'stop' },
  electronic: { name: 'Electronic / dance', about: 'four-on-the-floor kick, off-beat synth stabs, driving bass',
    harmony: 'pop', chordRate: '1', writing: 'blocks', chordStyle: 'skank', sound: 'synth', spacing: 'close', register: 'mid', feel: 'four', bassStyle: 'eighths', swing: 'straight', energy: 'build', drone: false, counter: false, busy: 0.6, intro: '2', ending: 'stop' },
};
// names used before the genres (saved settings and sections): what they are now
const GENRE_ALIASES = { heroic: 'anthem', dramatic: 'cinematic', light: 'children', sad: 'ballad' };

// ---------- the fingerprint ----------
// notes: [{ midi, beat, dur, tuplet? }] on the score's beats, sorted; key: { root, mode };
// meter: beats per bar; bpm; swing: 0.5 (straight) .. 0.72 (from the singing).
function genreFeatures(notes, key, meter, bpm, swing) {
  const deg = new Array(12).fill(0);
  let tot = 0;
  for (const n of notes) { const w = Math.max(0.25, n.dur); deg[((n.midi - key.root) % 12 + 12) % 12] += w; tot += w; }
  const frac = ds => ds.reduce((s, d) => s + deg[d], 0) / Math.max(1e-6, tot), major = key.mode === 'major';
  const ints = notes.slice(1).map((n, i) => n.midi - notes[i].midi), ni = Math.max(1, ints.length), N = Math.max(1, notes.length);
  const off = n => Math.abs(n.beat - Math.round(n.beat)) > 1e-3;
  const span = Math.max(1, notes[notes.length - 1].beat + notes[notes.length - 1].dur - notes[0].beat);
  const near = (x, v) => Math.abs(x - v) < 0.02;
  const inKey = major ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return {
    meter, mode: key.mode, bpm, swing,
    pent: frac(major ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10]),
    fourSeven: frac(major ? [5, 11] : [2, 8]),
    blue: major ? frac([3, 6, 10]) : frac([6]),
    modal: major ? frac([10]) : frac([9]),
    outside: 1 - frac(inKey),
    sync: notes.filter(off).length / N,
    anticip: notes.filter(n => off(n) && n.dur >= 1 - 1e-6).length / N,
    triplets: notes.filter(n => n.tuplet === 3 || near((n.beat % 1 + 1) % 1, 1 / 3) || near((n.beat % 1 + 1) % 1, 2 / 3)).length / N,
    dotted: notes.filter(n => near(n.dur, 1.5) || near(n.dur, 0.75) || near(n.dur, 3)).length / N,
    repeats: ints.filter(d => d === 0).length / ni,
    longNotes: notes.filter(n => n.dur >= 2 - 1e-6).length / N,
    shortNotes: notes.filter(n => n.dur <= 0.5 + 1e-6).length / N,
    density: notes.length / span,
    steps: ints.filter(d => Math.abs(d) >= 1 && Math.abs(d) <= 2).length / ni,
    leaps: ints.filter(d => Math.abs(d) >= 5).length / ni,
    range: Math.max(...notes.map(n => n.midi)) - Math.min(...notes.map(n => n.midi)),
  };
}
// Each genre's traits: [weight, does the melody show it, the trait in words]. The share of the
// weight the melody shows is the genre's score.
function genreTraits(f) {
  const major = f.mode === 'major', swung = f.swing >= 0.57;
  return {
    pop: [[0.3, f.anticip >= 0.08, 'notes that push ahead of the beat'], [0.2, f.bpm >= 80 && f.bpm <= 130, 'mid tempo'], [0.15, f.meter === 4, '4 beats a bar'],
      [0.15, f.repeats >= 0.15, 'repeated notes (a hook)'], [0.1, f.range <= 12, 'within an octave'], [0.1, !swung, 'straight'], [0.15, f.shortNotes < 0.5, 'singable note lengths']],
    rock: [[0.2, f.bpm >= 100, 'up-tempo'], [0.15, f.meter === 4, '4 beats a bar'], [0.2, f.pent >= 0.75, 'five-note scale'], [0.15, f.blue >= 0.04 || (!major && f.pent >= 0.8), 'bluesy or minor-pentatonic notes'],
      [0.1, major && f.modal >= 0.05, 'flat 7th in a major key'], [0.25, f.shortNotes >= 0.4 && f.repeats >= 0.1, 'a riff of short repeated notes'], [0.05, !swung, 'straight']],
    blues: [[0.4, f.blue >= 0.08, 'blue notes (flat 3rd, 5th or 7th)'], [0.3, swung || f.triplets >= 0.15, 'swung or in triplets'], [0.1, f.meter === 4, '4 beats a bar'],
      [0.1, f.anticip >= 0.05, 'pushed notes'], [0.1, f.pent >= 0.6, 'five-note scale']],
    jazz: [[0.3, swung, 'swung'], [0.25, f.outside >= 0.06, 'chromatic notes'], [0.15, f.anticip >= 0.12, 'syncopated'], [0.1, f.leaps >= 0.2, 'leaps'],
      [0.1, f.range >= 10, 'wide range'], [0.1, f.meter === 4, '4 beats a bar']],
    lofi: [[0.3, f.bpm >= 60 && f.bpm <= 95, 'laid-back tempo'], [0.25, swung, 'lazy swing'], [0.15, f.repeats >= 0.15, 'repeated notes'],
      [0.1, f.density <= 1.5, 'unhurried'], [0.1, f.range <= 9, 'small range'], [0.1, f.meter === 4, '4 beats a bar']],
    folk: [[0.35, f.pent >= 0.85, 'five-note (pentatonic) scale'], [0.15, f.fourSeven < 0.08, 'no 4th or 7th'], [0.15, f.sync < 0.2, 'plain rhythm'],
      [0.1, f.steps >= 0.45, 'mostly steps'], [0.1, f.dotted >= 0.1, 'dotted rhythms'], [0.15, major || f.modal >= 0.04, 'major or modal']],
    celtic: [[0.4, f.modal >= 0.06, f.mode === 'minor' ? 'minor with a raised 6th (Dorian)' : 'major with a flat 7th (Mixolydian)'], [0.2, f.dotted >= 0.15 || f.triplets >= 0.2, 'jig-like rhythm'],
      [0.2, f.density >= 1.5, 'lively runs'], [0.1, f.pent >= 0.6, 'folk scale'], [0.1, f.leaps >= 0.1, 'leaps']],
    country: [[0.2, major, 'major'], [0.2, f.pent >= 0.7, 'five-note scale'], [0.15, f.bpm >= 90 && f.bpm <= 140, 'easy tempo'], [0.1, f.steps >= 0.45, 'mostly steps'],
      [0.15, f.sync >= 0.05 && f.sync <= 0.3, 'a little syncopation'], [0.1, f.meter !== 3, 'two or four beats'], [0.1, f.dotted >= 0.08, 'dotted rhythms']],
    latin: [[0.35, f.anticip >= 0.15, 'lots of syncopation'], [0.2, f.bpm >= 105, 'quick'], [0.15, f.density >= 1.5, 'busy line'], [0.1, f.meter !== 3, 'even meter'],
      [0.1, f.shortNotes >= 0.3, 'short notes'], [0.1, !swung, 'straight']],
    reggae: [[0.3, f.sync >= 0.3, 'notes on the off-beat'], [0.25, f.bpm >= 60 && f.bpm <= 95, 'relaxed tempo'], [0.15, f.meter === 4, '4 beats a bar'],
      [0.15, f.repeats >= 0.15, 'chant-like repeats'], [0.15, f.pent >= 0.7, 'simple scale']],
    waltz: [[0.7, f.meter === 3, '3 beats a bar'], [0.15, f.density <= 1.5, 'one or two notes a beat'], [0.15, f.sync < 0.2, 'on the beat']],
    ballad: [[0.3, f.bpm < 85, 'slow'], [0.25, f.longNotes >= 0.15, 'long held notes'], [0.15, f.steps >= 0.45, 'smooth line'], [0.15, f.range >= 8, 'room to rise'],
      [0.15, !swung, 'straight']],
    anthem: [[0.2, major, 'major'], [0.2, f.leaps >= 0.15 && f.leaps <= 0.45, 'bold leaps'], [0.15, f.dotted >= 0.1, 'dotted rhythms'], [0.15, f.sync < 0.15, 'on the beat'],
      [0.15, f.meter !== 3 && f.bpm >= 85 && f.bpm <= 135, 'marching tempo'], [0.15, f.range >= 9, 'wide range']],
    cinematic: [[0.3, !major, 'minor'], [0.15, f.outside >= 0.05, 'notes outside the key'], [0.15, f.leaps >= 0.2, 'dramatic leaps'], [0.15, f.density >= 1.5, 'driving notes'],
      [0.15, f.range >= 10, 'wide range'], [0.1, f.bpm >= 110 || f.bpm < 75, 'very fast or very slow']],
    classical: [[0.2, f.range >= 12, 'wide range'], [0.2, f.density >= 1.5, 'quick runs'], [0.2, f.steps >= 0.55, 'scale-wise lines'], [0.15, f.sync < 0.15, 'on the beat'],
      [0.15, f.outside >= 0.02, 'chromatic touches'], [0.1, !swung, 'straight']],
    children: [[0.2, major, 'major'], [0.25, f.range <= 9, 'small range'], [0.2, f.steps >= 0.5 || f.repeats >= 0.25, 'steps and repeated notes'],
      [0.15, f.sync < 0.1, 'simple rhythm'], [0.1, f.longNotes < 0.2, 'short phrases'], [0.1, f.bpm >= 90, 'bright tempo']],
    electronic: [[0.3, f.bpm >= 115, 'fast'], [0.2, f.repeats >= 0.25, 'looping repeats'], [0.15, f.meter === 4, '4 beats a bar'], [0.15, f.shortNotes >= 0.4, 'short notes'],
      [0.1, f.range <= 9, 'narrow range'], [0.1, f.sync >= 0.15, 'off-beat accents']],
  };
}
// The genres best first: [{ id, name, about, score 0..1, why: [trait words] }].
function guessGenres(f) {
  const traits = genreTraits(f);
  return Object.entries(traits).map(([id, list]) => {
    let s = 0, max = 0;
    const why = [];
    for (const [w, ok, words] of list) { max += w; if (ok) { s += w; why.push(words); } }
    return { id, name: GENRES[id].name, about: GENRES[id].about, score: max ? s / max : 0, why };
  }).sort((a, b) => b.score - a.score);
}
