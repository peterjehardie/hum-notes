// Sampled orchestra: VSCO 2 Community Edition (CC0) notes in samples/, played with Web Audio.
// Load first with loadInstruments(), then call playSample() for each note.

// Instruments the arranger can pick from: family and a comfortable sounding MIDI range.
const INSTRUMENTS = [
  { name: 'violins', family: 'strings', range: [55, 89], articulation: 'section sustain, vibrato' },
  { name: 'violas', family: 'strings', range: [48, 81], articulation: 'section sustain, vibrato' },
  { name: 'cellos', family: 'strings', range: [36, 72], articulation: 'section sustain, vibrato' },
  { name: 'contrabass', family: 'strings', range: [28, 55], articulation: 'solo sustain, no vibrato' },
  { name: 'violinsPizz', family: 'strings', range: [55, 88], articulation: 'section pizzicato' },
  { name: 'cellosPizz', family: 'strings', range: [36, 67], articulation: 'section pizzicato' },
  { name: 'harp', family: 'strings', range: [31, 96], articulation: 'plucked' },
  { name: 'flute', family: 'woodwinds', range: [60, 93], articulation: 'sustain, no vibrato' },
  { name: 'oboe', family: 'woodwinds', range: [58, 89], articulation: 'sustain' },
  { name: 'clarinet', family: 'woodwinds', range: [50, 89], articulation: 'sustain' },
  { name: 'bassoon', family: 'woodwinds', range: [34, 72], articulation: 'sustain' },
  { name: 'horn', family: 'brass', range: [41, 77], articulation: 'sustain' },
  { name: 'trumpet', family: 'brass', range: [55, 82], articulation: 'sustain' },
  { name: 'trombone', family: 'brass', range: [40, 68], articulation: 'tenor trombone sustain' },
  { name: 'tuba', family: 'brass', range: [28, 58], articulation: 'sustain' },
  { name: 'timpani', family: 'percussion', range: [38, 58], articulation: 'hits' },
  { name: 'timpaniRoll', family: 'percussion', range: [38, 58], articulation: 'rolls' },
  { name: 'piano', family: 'keys', range: [21, 108], articulation: 'upright piano' },
  { name: 'glockenspiel', family: 'keys', range: [79, 108], articulation: 'struck, stands in for celesta' },
];

// Where samples/ lives: next to this script, wherever the page is.
const SAMPLER_BASE = (() => {
  const src = document.currentScript && document.currentScript.src;
  return src ? new URL('samples/', src).href : 'samples/';
})();

// Decoded buffers are shared by every AudioContext (an AudioBuffer is not tied to one).
const samplerState = {
  manifest: null,     // promise of manifest.json
  files: new Map(),   // file -> promise of AudioBuffer (or null if it failed)
  ready: new Map(),   // name -> { spec, notes: [{ midi, vel, buffer, loopStart, loopEnd }] }
};

function samplerManifest() {
  if (!samplerState.manifest) {
    samplerState.manifest = fetch(SAMPLER_BASE + 'manifest.json')
      .then((r) => { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); })
      .catch((e) => { samplerState.manifest = null; throw e; });
  }
  return samplerState.manifest;
}

function samplerDecode(ctx, file) {
  if (!samplerState.files.has(file)) {
    // the local server sometimes drops a connection under load, so try a few times
    const get = (tries) => fetch(SAMPLER_BASE + file)
      .then((r) => { if (!r.ok) throw new Error(file + ' ' + r.status); return r.arrayBuffer(); })
      .catch((e) => {
        if (tries <= 1) throw e;
        return new Promise((ok) => setTimeout(ok, 250)).then(() => get(tries - 1));
      });
    const p = get(4)
      .then((data) => ctx.decodeAudioData(data))
      .catch((e) => { console.warn('sampler: could not load', file, e); return null; });
    samplerState.files.set(file, p);
  }
  return samplerState.files.get(file);
}

// Fetch and decode the named instruments (all of them if names is empty).
// onProgress(done, total) is called after each file. Resolves to { loaded: [...], failed: [...] }.
async function loadInstruments(ctx, names, onProgress) {
  const manifest = await samplerManifest();
  const want = (names && names.length ? names : Object.keys(manifest)).filter((n) => manifest[n]);
  const jobs = [];
  for (const n of want) for (const f of manifest[n].files) jobs.push({ name: n, entry: f });
  let done = 0;
  const total = jobs.length;
  if (onProgress) onProgress(0, total);
  const results = new Map(want.map((n) => [n, []]));
  // a few downloads at a time keeps the page responsive
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const buffer = await samplerDecode(ctx, job.entry.file);
      if (buffer) results.get(job.name).push({ ...job.entry, buffer });
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  const loaded = [];
  const failed = [];
  for (const n of want) {
    const notes = results.get(n).sort((a, b) => a.midi - b.midi);
    if (notes.length) {
      samplerState.ready.set(n, { spec: manifest[n], notes });
      loaded.push(n);
    } else {
      failed.push(n);
    }
  }
  for (const n of names || []) if (!manifest[n]) failed.push(n);
  return { loaded, failed };
}

// True once the instrument has at least one decoded sample.
function hasInstrument(name) {
  return samplerState.ready.has(name);
}

// Nearest sample in pitch, from the velocity layer closest to vel.
function samplerPick(notes, midi, vel) {
  let layer = null;
  for (const n of notes) {
    const v = n.vel == null ? 1 : n.vel;
    if (layer == null || Math.abs(v - vel) < Math.abs(layer - vel)) layer = v;
  }
  let best = null;
  for (const n of notes) {
    if ((n.vel == null ? 1 : n.vel) !== layer) continue;
    if (!best || Math.abs(n.midi - midi) < Math.abs(best.midi - midi)) best = n;
  }
  return best;
}

// Play one note: name, MIDI pitch (fractions allowed), start time, length in seconds, velocity 0..1.
function playSample(ctx, out, name, midi, at, dur, vel) {
  const inst = samplerState.ready.get(name);
  if (!inst || !out) return;
  vel = Math.max(0.05, Math.min(1, vel == null ? 0.8 : vel));
  at = Math.max(at || 0, ctx.currentTime);
  dur = Math.max(0.03, dur || 0.5);
  const spec = inst.spec;
  const s = samplerPick(inst.notes, midi, vel);
  if (!s) return;

  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.playbackRate.value = Math.pow(2, (midi - s.midi) / 12);

  // velocity: louder and brighter; soft notes get a gentle lowpass
  const amp = spec.gain * Math.pow(vel / 0.8, 1.5);
  const env = ctx.createGain();
  let head = src;
  if (vel < 0.8) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    lp.frequency.value = Math.min(20000, 800 * Math.pow(2, 5 * vel / 0.8));
    src.connect(lp);
    head = lp;
  }
  head.connect(env);
  env.connect(out);

  const attack = spec.attack || 0.005;
  const release = spec.release || 0.2;
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(amp, at + attack);

  if (spec.sustained) {
    // hold for dur; loop the steady part when the note outlasts the sample
    if (s.loopEnd && s.loopEnd > s.loopStart) {
      src.loop = true;
      src.loopStart = s.loopStart;
      src.loopEnd = s.loopEnd;
    }
    const off = Math.max(at + attack, at + dur);
    env.gain.setValueAtTime(amp, off);
    env.gain.linearRampToValueAtTime(0, off + release);
    src.start(at);
    src.stop(off + release + 0.05);
  } else {
    // plucked / struck: the sample rings on its own; a note shorter than the ring is damped at its end
    const ring = s.buffer.duration / src.playbackRate.value;
    const off = at + Math.max(dur, attack);
    if (off + release < at + ring) {
      env.gain.setValueAtTime(amp, off);
      env.gain.linearRampToValueAtTime(0, off + release);
      src.start(at);
      src.stop(off + release + 0.05);
    } else {
      src.start(at);
    }
  }
}
