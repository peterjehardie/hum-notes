const $ = id => document.getElementById(id);

const S = {
  ctx: null, mic: null, node: null,
  listening: false, recording: false,
  points: [],            // live pitch track {t, m (NaN if unvoiced), c, r}
  take: null,            // {start, end, points, voice, grid, tempoScale, notes, tempo}
  seg: null, chunks: null,
  drone: null, droneOn: false,
  play: null,
  view: { center: 60, span: 26, mode: 'live' },
  playMode: 'voice', voicing: 'root', snap: 'chrom', rhythm: 'free', timbre: 'voice', partials: 'on', layer: 'score', lineEngine: 'natural', recKind: 'hum', grooveHum: false, colours: 'degree', hear: 'score', loop: false, chordStyle: 'pad', chordRate: '1',
  harmony: 'plain', sound: 'synth', spacing: 'close', register: 'mid', feel: 'backbeat', motifUse: 'ostinato', writing: 'arranged', energy: 'arc', formAware: 'on',
  acc: { melody: true, harmonics: false, drone: true, chords: true, bass: true, rhythm: true, motif: false, counter: true },
};

// ---------- settings (survive reloads) ----------
const FIELDS = ['micSel', 'outSel', 'root', 'oct', 'wave', 'dvol', 'bpm', 'beats', 'mvol', 'detail', 'res', 'tune', 'speed', 'gate', 'flourish', 'prange', 'style', 'keySel', 'tuningSel', 'transpose', 'sres', 'meterSel', 'bvol', 'moodSel', 'melSound', 'lineSmooth', 'lineTune', 'lineVib', 'lineEven', 'lineGlide', 'sdetail', 'voiceSound', 'polishAmt'];
const SEGS = ['lineEngine', 'recKind', 'colours', 'hear', 'playMode', 'voicing', 'snap', 'rhythm', 'timbre', 'partials', 'layer', 'chordStyle', 'chordRate', 'harmony', 'sound', 'spacing', 'register', 'feel', 'motifUse', 'writing', 'energy', 'formAware'];
for (const mode of ['major', 'minor']) for (let r = 0; r < 12; r++)
  $('keySel').add(new Option(keyName({ root: r, mode }), r + ':' + mode));
function showValues() {
  for (const id of ['tune', 'detail', 'flourish', 'style']) $(id + 'V').textContent = Math.round($(id).value * 100) + '%';
  $('prangeV').textContent = $('prange').value + ' dB';
}
document.addEventListener('input', showValues);
for (let i = 0; i < 12; i++) $('root').add(new Option(NAMES[i], i));
$('root').value = '2';

function saveSettings() {
  const o = { v: 4, theme: document.documentElement.dataset.theme };
  for (const f of FIELDS) o[f] = $(f).value;
  for (const k of SEGS) o[k] = S[k];
  o.acc = S.acc; o.loop = S.loop;
  try { localStorage.setItem('hum-settings', JSON.stringify(o)); } catch {}
}
function setSeg(key, v) {
  S[key] = v;
  const el = document.querySelector(`.seg[data-key="${key}"]`);
  for (const b of el.children) b.classList.toggle('on', b.dataset.v === v);
}
let colors = {};
function applyTheme(v) {
  document.documentElement.dataset.theme = v;
  for (const b of $('theme').children) b.classList.toggle('on', b.dataset.v === v);
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['text', 'muted', 'accent', 'rec', 'roll', 'panel', 'raise', 'line', 'lane-black', 'lane-root', 'lane-fifth', 'trace', 'note', 'note-edge', 'grid', 'bar', 'wave', 'bk-note', 'bk-edge', 'bk-low', 'bk-low-edge',
    'deg0', 'deg1', 'deg2', 'deg3', 'deg4', 'deg5', 'deg6', 'deg7', 'on-deg', 'layer1', 'layer2', 'layer3', 'layer4'])
    colors[k] = cs.getPropertyValue('--' + k).trim();
}
(function loadSettings() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem('hum-settings') || '{}'); } catch {}
  // older saves predate the everything-on defaults
  if (!o.v || o.v < 3) { delete o.partials; delete o.detail; delete o.gate; }
  if ((!o.v || o.v < 4) && o.acc) o.acc.harmonics = false;
  for (const f of FIELDS) if (o[f] != null) { $(f).dataset.want = o[f]; $(f).value = o[f]; }
  for (const k of SEGS) if (o[k]) setSeg(k, o[k]);
  if (o.acc) Object.assign(S.acc, o.acc);
  S.loop = !!o.loop; $('loopBtn').classList.toggle('on', S.loop);
  for (const b of $('accToggles').children) b.classList.toggle('on', !!S.acc[b.dataset.acc]);
  applyTheme(o.theme || 'light');
  showValues();
})();
$('theme').onclick = e => { if (e.target.dataset.v) { applyTheme(e.target.dataset.v); saveSettings(); } };
document.addEventListener('change', saveSettings);
document.addEventListener('input', saveSettings);

const segHandlers = {};
for (const el of document.querySelectorAll('.seg[data-key]')) {
  el.onclick = e => {
    const v = e.target.dataset.v; if (!v) return;
    setSeg(el.dataset.key, v); saveSettings(); sendParams();
    segHandlers[el.dataset.key] && segHandlers[el.dataset.key]();
  };
}

const rootPc = () => +$('root').value;

// ---------- scale-degree colours ----------
// Each note coloured by its place in the key: 1 home, 3 and 5 the stable notes, 2 4 6 the
// in-between ones, 7 the pull back home; notes outside the key are grey. The tonic is the
// take's detected key, or the drone's root before anything is recorded.
const DEGREE_NAMES = ['tonic', 'supertonic', 'mediant', 'subdominant', 'dominant', 'submediant', 'leading note'];
function tonicKey() {
  const k = S.take && S.take.score && S.take.score.key;
  if (k) return { root: pcOf(k.root + transpose()), mode: k.mode };
  return { root: rootPc(), mode: S.snap === 'minor' ? 'minor' : 'major' };
}
function degreeOf12(midi, key = tonicKey()) {
  const i = SCALES[key.mode].indexOf(pcOf(Math.round(midi) - key.root));
  return i + 1;   // 0 = outside the key
}
const degColour = midi => colors['deg' + degreeOf12(midi)];
const degreesOn = () => S.colours === 'degree';
function renderLegend() {
  const box = $('degLegend');
  box.innerHTML = '';
  if (!degreesOn()) return;
  const key = tonicKey();
  SCALES[key.mode].forEach((st, i) => {
    const el = document.createElement('i');
    el.textContent = i + 1; el.style.background = colors['deg' + (i + 1)]; el.style.color = colors['on-deg'];
    el.title = `${i + 1} · ${DEGREE_NAMES[i]} · ${(usesFlats(key) ? FLAT_NAMES : NAMES)[pcOf(key.root + st)]}`;
    box.appendChild(el);
  });
}
const snap = m => snapTo(m, S.snap, rootPc());
const res = () => +$('res').value;
const sres = () => +$('sres').value;

// ---------- audio ----------
async function ensureCtx() {
  if (!S.ctx) {
    S.ctx = new AudioContext({ latencyHint: 'interactive' });
    await S.ctx.audioWorklet.addModule('pitch-worklet.js?v=' + Date.now());
    await applyOutput();
  }
  if (S.ctx.state !== 'running') await S.ctx.resume();
  return S.ctx;
}

async function startMic() {
  const ctx = await ensureCtx();
  const dev = $('micSel').value || $('micSel').dataset.want || '';
  S.mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, ...(dev ? { deviceId: { exact: dev } } : {}) },
  });
  listDevices();
  attachInput(ctx.createMediaStreamSource(S.mic));
  const lat = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
  const name = S.mic.getAudioTracks()[0]?.label || 'mic';
  $('status').textContent = `Listening on ${name} · out ${lat.toFixed(0)} ms`;
  $('listen').textContent = 'Mic off';
}

// ---------- devices ----------
// Names only appear once the browser has mic permission, so the lists refresh after the mic starts.
async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, first) => {
    const keep = sel.value || sel.dataset.want || '';
    sel.innerHTML = '';
    sel.add(new Option(first, ''));
    for (const d of devs) if (d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
      sel.add(new Option(d.label || (kind === 'audioinput' ? 'Microphone' : 'Speaker') + ' ' + (sel.length), d.deviceId));
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
  };
  fill($('micSel'), 'audioinput', 'Default mic');
  fill($('outSel'), 'audiooutput', 'Default output');
  if (!AudioContext.prototype.setSinkId) $('outSel').hidden = true;
}
async function applyOutput() {
  if (S.ctx && S.ctx.setSinkId) { try { await S.ctx.setSinkId($('outSel').value || ''); } catch {} }
}
$('micSel').addEventListener('change', async () => {
  if (S.recording || !S.listening) return;
  stopMic();
  try { await startMic(); } catch (err) { $('status').textContent = 'Mic unavailable: ' + err.message; }
});
$('outSel').addEventListener('change', applyOutput);
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);

// any source node can feed the tracker (the mic, or a test signal)
function attachInput(src) {
  const ctx = S.ctx;
  S.node = new AudioWorkletNode(ctx, 'pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  S.monGain = ctx.createGain(); S.monGain.gain.value = 0;
  src.connect(S.node).connect(S.monGain).connect(ctx.destination);
  setMonitor(S.monitorOn);
  S.analyser = ctx.createAnalyser();
  S.analyser.fftSize = 8192; S.analyser.smoothingTimeConstant = 0.3;
  S.fbuf = new Float32Array(S.analyser.frequencyBinCount);
  src.connect(S.analyser);
  S.node.port.onmessage = e => onWorklet(e.data);
  S.listening = true;
}

function stopMic() {
  if (S.recording) toggleRecord();
  S.mic && S.mic.getTracks().forEach(t => t.stop());
  S.node && S.node.disconnect();
  S.mic = S.node = null; S.listening = false;
  $('status').textContent = 'Mic off';
  $('listen').textContent = 'Mic on';
}

$('listen').onclick = async () => {
  try { S.listening ? stopMic() : await startMic(); }
  catch (err) { $('status').textContent = 'Mic unavailable: ' + err.message; }
};

const smooth = [];
function onWorklet(d) {
  if (d.audio) { S.chunks && S.chunks.push(d); return; }
  if (d.recDone) { finishTake(); return; }
  const { t, f, clarity, rms } = d;
  const voiced = d.v;
  S.peakRms = Math.max(S.peakRms || 0, rms);
  let m = NaN;
  if (voiced) {
    smooth.push(hzToMidi(f)); if (smooth.length > 3) smooth.shift();
    m = median(smooth);
  } else smooth.length = 0;
  S.points.push({ t, m, c: clarity, r: rms, s: d.s });
  if (S.points.length > 15000 && !S.recording) S.points.splice(0, 5000);
  if (S.recording) S.seg.push(t, m);
  S.lastLevel = { rms, voiced };
  S.lastPitch = voiced ? { m, f } : null;
  if (voiced && Math.abs(m - Math.round(m)) < 0.35) {
    S.livePcs = S.livePcs || [];
    S.livePcs.push({ t, pc: pcOf(Math.round(m)) });
  }
}

// ---------- live auto-tune ----------
// The tracker worklet also shifts the mic toward the target note; this sends it the settings.
function sendParams() {
  if (!S.node) return;
  S.node.port.postMessage({ params: {
    gate: +$('gate').value, amount: +$('tune').value, speed: +$('speed').value,
    root: rootPc(), scale: SCALES[S.snap] || null, monitor: !!S.monitorOn,
  } });
}
document.addEventListener('input', sendParams);
document.addEventListener('change', sendParams);

function setMonitor(on) {
  S.monitorOn = on;
  $('monitor').classList.toggle('on', on);
  if (S.monGain) S.monGain.gain.setTargetAtTime(on ? Math.pow(+$('mon').value, 2) : 0, S.ctx.currentTime, 0.02);
  // shifter delay (~20 ms grain) plus the device's own output latency
  $('monLat').textContent = on && S.ctx ? `~${Math.round(32 + ((S.ctx.baseLatency || 0) + (S.ctx.outputLatency || 0)) * 1000)} ms` : '';
  sendParams();
}
$('monitor').onclick = () => setMonitor(!S.monitorOn);
$('mon').addEventListener('input', () => S.monitorOn && setMonitor(true));

// ---------- recording ----------
// Hum takes are recorded in one of four record modes (Beat records a groove instead):
//   new   – a fresh take; the old one stays in the history for Undo take
//   next  – the last bar plays as a lead-in, then the new singing is added after the take as its next section
//   layer – the take plays while you sing a second part; it becomes a layer that plays along with it
//   punch – one bar before the start marker plays, then the new notes replace the score from the marker
// For next, layer and punch the take stays in S.take and on screen; the new recording goes to S.recTake,
// and S.recArm maps its clock onto the take's (take time = recording time + shift).
S.recMode = 'new';
S.history = [];
const armed = () => S.recording && !!S.recArm;

function recModeOk(mode) {
  const tk = S.take, has = !!(tk && tk.points && tk.points.length);
  if (mode === 'next' || mode === 'layer') return has;
  if (mode === 'punch') return has && !!(tk.score && tk.score.tempo);
  return true;
}
const REC_LABELS = { new: 'Record', next: 'Record next part', layer: 'Record layer', punch: 'Redo from marker' };
function updateRecButton() {
  const rec = S.recording, beat = S.recKind === 'beat';
  if (!recModeOk(S.recMode)) setSeg('recMode', 'new');
  for (const b of $('recMode').children) b.disabled = rec || beat || !recModeOk(b.dataset.v);
  $('recLabel').textContent = rec ? 'Stop' : beat ? 'Record beat' : REC_LABELS[S.recMode];
  $('record').classList.toggle('on', rec);
}
const REC_HINTS = {
  new: '',
  next: 'Next part: press Record. The last bar plays as a lead-in; sing what comes next and it is added as a new section',
  layer: 'Layer: press Record. The take plays (from the start marker, if set) and you sing a second part over it',
  punch: 'Redo from marker: click the roll where the new singing should start, then press Record',
};
segHandlers.recMode = () => {
  updateRecButton();
  if (REC_HINTS[S.recMode]) $('status').textContent = REC_HINTS[S.recMode] + (S.recMode === 'punch' ? '' : ' · wear headphones so the mic hears only you');
};
segHandlers.recKind = updateRecButton;

function toggleRecord() {
  if (!S.recording) {
    if (S.play) stopPlay();
    const arm = S.recArm;
    S.seg = new Segmenter(snap, arm ? undefined : renderNotes);
    S.chunks = [];
    const rec = {
      start: S.ctx.currentTime, end: null, notes: S.seg.notes, points: null, voice: null, tempoScale: 1, kind: arm ? arm.kind : S.recKind,
      grid: metro.on ? { bpm: metro.bpm, t0: metro.t0, beats: metro.beats } : null,
    };
    if (arm || S.recKind === 'beat') S.recTake = rec;
    else {
      pushHistory('the previous take');
      S.take = rec; S.cursor = null; S.view.zoom = null;
      ED.sel.clear(); ED.undo.length = 0; ED.redo.length = 0;
    }
    if (!arm && S.recKind === 'hum' && S.grooveHum && S.groove) {
      const t0 = S.ctx.currentTime + 0.05;
      grooveClock.start(S.ctx, S.ctx.destination, t0);
      // the groove's bars become the take's beat grid (one groove step = 1/steps of a beat)
      rec.grid = { bpm: S.groove.bpm, t0, beats: S.groove.beats };
    }
    S.recording = true;
    S.view.mode = arm ? 'take' : 'live';
    S.node.port.postMessage({ rec: true });
    S.peakRms = 0;
    $('status').textContent = arm ? arm.msg : 'Recording… press Stop (or Space) when done';
    renderNotes();
  } else {
    (S.recTake || S.take).end = S.ctx.currentTime;
    S.recording = false;
    grooveClock.stop();
    stopCue();
    S.node.port.postMessage({ rec: false });
  }
  updateButtons();
}
// the playback heard while recording over a take
function stopCue() {
  if (!S.cue) return;
  clearTimeout(S.cue.timer);
  const b = S.cue.bus;
  b.gain.setTargetAtTime(0, S.ctx.currentTime, 0.05); setTimeout(() => b.disconnect(), 400);
  S.cue = null;
}
// One button: starts the mic if needed and records in the chosen mode; stopping shows the full analysis.
$('record').onclick = async () => {
  try {
    if (!S.listening) await startMic();
    if (S.recording) { toggleRecord(); return; }
    const mode = S.recKind === 'beat' ? 'new' : S.recMode;
    if (mode === 'new') toggleRecord(); else await recordOver(mode);
  } catch (err) { $('status').textContent = 'Mic unavailable: ' + err.message; }
};

function finishTake() {
  const tk = S.recTake || S.take, chunks = S.chunks;
  S.chunks = null;
  if (!tk || !chunks) return;
  let n = 0;
  for (const c of chunks) n += c.audio.length;
  const data = new Float32Array(n);
  n = 0;
  for (const c of chunks) { data.set(c.audio, n); n += c.audio.length; }
  tk.voice = chunks.length ? { t0: chunks[0].t, sr: S.ctx.sampleRate, data } : null;
  S.recTake = null;
  if (tk.kind === 'beat') { finishBeat(tk); return; }
  tk.points = S.points.filter(p => p.t >= tk.start && p.t <= tk.end).sort((a, b) => a.t - b.t);
  if (S.recArm) { finishArm(tk); return; }
  trimTake(tk);
  S.view.mode = 'take';
  retranscribe();
  saveTake();
  followTonic(tk);
  updateRecButton(); renderParts();
  const nn = tk.notes.length, nh = tk.pt ? tk.pt.tracks.filter(t => t.k > 1).length : 0;
  $('status').textContent = nn
    ? `${nn} notes · ${nh} harmonics transcribed` + (tk.tempo ? ` · about ${Math.round(tk.tempo.bpm)} bpm` : '')
      + (tk.trimmed > 0.3 ? ` · ${tk.trimmed.toFixed(1)} s of silence trimmed` : '') + ' · next: Play, or record the Next part or a Layer'
    : `No clear pitch heard (loudest input ${Math.round(20 * Math.log10((S.peakRms || 1e-9)))} dB) — try singing closer to the mic`;
  if (!HOSTED) saveToDisk(tk);
}

$('clear').onclick = () => {
  if (S.recording) toggleRecord();
  if (S.play) stopPlay();
  pushHistory('the cleared take');
  S.take = null; S.seg = null; S.cursor = null; S.view.zoom = null;
  S.view.mode = 'live';
  renderNotes(); renderPartials(); updateScoreInfo(); renderEditBar(); updateButtons(); updateTempo(); renderParts();
  saveTake();
  $('status').textContent = 'Take cleared · Undo take brings it back';
};

// ---------- take history: Undo take ----------
// A copy of the take is kept before every recording that changes it (new take, next part, layer,
// redo from marker) and before Clear, so a recording that went wrong can be thrown away.
function pushHistory(label) {
  const tk = S.take;
  if (!tk || !tk.points) return;
  const copy = o => o == null ? o : JSON.parse(JSON.stringify(o));
  S.history.push({ label, take: {
    ...tk, edited: copy(tk.edited), sections: copy(tk.sections), chordEdits: copy(tk.chordEdits), chordPicks: copy(tk.chordPicks),
    taps: tk.taps && tk.taps.slice(), layers: tk.layers && tk.layers.map(L => ({ ...L })), muted: tk.muted && new Set(tk.muted), score: null,
  } });
  if (S.history.length > 8) S.history.shift();
}
function undoTake() {
  const h = S.history.pop();
  if (!h || S.recording) return;
  if (S.play) stopPlay();
  S.take = h.take; S.cursor = null; S.view.zoom = null;
  ED.sel.clear(); ED.undo.length = 0; ED.redo.length = 0;
  S.view.mode = 'take';
  retranscribe(); renderParts(); renderEditBar(); saveTake(); updateButtons();
  $('status').textContent = 'Back to ' + h.label + (S.history.length ? ` · ${S.history.length} more step${S.history.length > 1 ? 's' : ''} back` : '');
}
$('undoRec').onclick = undoTake;

// ---------- recording over a take: next part, layer, redo from marker ----------
// Take time <-> beats on the score's grid (follows the tracked beat when the tempo drifts).
const beatAt = t => { const sc = S.take.score; return sc.beatMap ? beatOf(sc.beatMap, t) : (t - sc.tempo.t0) / (60 / sc.tempo.bpm); };
async function prepareSounds() {
  const inst = v => !['voice', 'plain', 'profile'].includes(v);
  const tk = S.take;
  const secOrch = (tk && tk.sections || []).some(s => MOODS[s.mood] && MOODS[s.mood].sound === 'orchestra');
  const layerInst = (tk && tk.layers || []).some(L => !L.muted && inst(L.sound));
  if (S.hear !== 'voice' && (S.sound === 'orchestra' || secOrch || inst($('melSound').value) || layerInst)) await ensureOrchestra();
}
// Schedules the cue (a count-in, then the take or a lead-in into the new part), arms the recorder
// with the clock mapping and starts recording.
async function recordOver(mode) {
  const A = S.take;
  if (!recModeOk(mode)) return;
  const ctx = await ensureCtx();
  if (S.play) stopPlay();
  if (mode === 'punch' && S.cursor == null) { $('status').textContent = REC_HINTS.punch; return; }
  await prepareSounds();
  const sc = A.score, plan = sc && sc.tempo ? backingPlan() : null;
  const beats = plan ? plan.meter.beats : 4, bt = plan ? b => beatTime(b) : null;
  let from, marker, until;
  if (mode === 'layer') {
    const r = playRegion();
    marker = r.a; until = r.b;
    from = plan ? bt(beatAt(marker) - beats) : marker - 0.8;
  } else if (mode === 'next') {
    if (plan) {
      // the new part starts on the first bar line after the last note
      const lastEnd = Math.max(...sc.notes.map(n => sEnd(n)), plan.segs.length ? beatTime(plan.segs[plan.segs.length - 1].start) : -Infinity);
      const first = plan.segs.length ? plan.segs[0].start : plan.meter.offset;
      const bar = Math.ceil((beatAt(lastEnd) - first) / beats - 0.02);
      marker = bt(first + bar * beats); from = bt(first + (bar - 1) * beats);
    } else { marker = A.end + 0.25; from = Math.max(A.start, A.end - 3); }
    until = marker + 600;
  } else {
    marker = S.cursor; from = plan ? bt(beatAt(marker) - beats) : marker - 2; until = marker + 600;
  }
  const at = ctx.currentTime + 0.25, tmap = t => at + (t - from);
  const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  const bus = ctx.createGain(); bus.connect(ctx.destination);
  // count-in clicks over the lead-in bar
  if (plan) for (let k = 0; k < beats; k++) click(tmap(bt(beatAt(from) + k)), k === 0, bus);
  if (mode === 'layer') scheduleRegion(ctx, bus, tmap(marker), marker, until);
  else {
    scheduleRegion(ctx, bus, tmap(from), from, marker);
    if (plan) {
      // under the new singing: the backing without the melody (the rest of it when redoing), and the beat
      // going on past the end in the last section's mood; or a quiet click when nothing keeps time
      const keepsTime = (S.hear === 'score' || S.hear === 'both') && S.acc.rhythm;
      const span = backingSpan(), endT = span ? span.to : marker, tailTo = Math.max(endT, marker) + 32 * beats * spb();
      const mel = S.acc.melody;
      S.acc.melody = false;
      try {
        if (S.hear === 'score' || S.hear === 'both') {
          if (marker < endT - 1e-3) scheduleBacking(ctx, bus, tmap, marker, endT);
          const secs = sectionsOf(), li = secs ? secs.length - 1 : null, a = Math.max(marker, endT);
          const tail = withSection(secs && secs[li], () => backingEvents(a, tailTo));
          tail.forEach(e => { e.sec = li; });
          scheduleBacking(ctx, bus, tmap, a, tailTo, tail);
        }
      } finally { S.acc.melody = mel; }
      if (!keepsTime) for (let k = 0; k < 32 * beats; k++) click(tmap(bt(beatAt(marker) + k)), k % beats === 0, bus, 0.55);
    }
  }
  const hp = ' · headphones keep the playback out of the mic';
  const msg = { next: 'Lead-in… sing the next part after the count, Stop when done', layer: 'Count-in… sing your layer along with the take', punch: 'Lead-in… sing from the marker, Stop when done' }[mode] + hp;
  S.recArm = { kind: mode, from, marker, until, at, lat, shift: from - at - lat, msg };
  const timer = mode === 'layer' ? setTimeout(() => { if (S.recording && S.recArm && S.recArm.at === at) toggleRecord(); }, (tmap(until) - ctx.currentTime + 0.8) * 1000) : 0;
  S.cue = { bus, timer };
  toggleRecord();
  updateRecButton();
}
// where the recording is, on the take's clock (what is being heard right now)
const armHead = now => S.recArm.from + (now - S.recArm.at) - S.recArm.lat;

// The new recording, moved onto the take's clock, goes where its mode says.
function finishArm(B) {
  const arm = S.recArm, A = S.take;
  S.recArm = null;
  updateRecButton();
  if (!A || !arm) return;
  const pts = B.points.map(p => ({ ...p, t: p.t + arm.shift })).filter(p => p.t >= arm.marker - 0.15);
  const voiced = pts.filter(p => !isNaN(p.m));
  if (voiced.length < 15) {
    $('status').textContent = (arm.kind === 'layer' ? 'Nothing sung over the take' : 'Nothing sung after the lead-in') + ' — try again';
    renderNotes(); updateButtons(); return;
  }
  const s = Math.max(arm.marker - 0.15, voiced[0].t - 0.25), e = voiced[voiced.length - 1].t + 0.35;
  const part = {
    points: pts.filter(p => p.t >= s && p.t <= e), start: s, end: e,
    voice: B.voice ? { t0: B.voice.t0 + arm.shift, sr: B.voice.sr, data: B.voice.data } : null,
  };
  if (arm.kind === 'layer') addLayer(A, part);
  else if (arm.kind === 'next') appendPart(A, part, arm.marker);
  else replaceFromMarker(A, part, arm.marker);
  updateButtons(); updateRecButton(); renderParts();
}

// Drop caches that were worked out from the take's recording.
function freshAudio(tk) {
  for (const k of ['frames', 'env', 'pt', 'rendered', 'tune', 'playBuf', 'playBufSrc', 'line', 'lineRender', 'harm']) tk[k] = null;
}
function resample(x, from, to) {
  const n = Math.round(x.length * to / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) { const p = i * r, k = Math.floor(p), f = p - k; y[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f; }
  return y;
}
// The take's recording with [from, to) replaced by another recording (both on the take's clock),
// short crossfades at the joins, long enough to hold both.
function spliceVoice(A, B, from, to) {
  if (!B) return A;
  if (!A) return B;
  const sr = A.sr, bd = B.sr === sr ? B.data : resample(B.data, B.sr, sr);
  const aEnd = A.t0 + A.data.length / sr, bEnd = B.t0 + bd.length / sr, open = to === Infinity;
  const t0 = Math.min(A.t0, Math.max(B.t0, from));
  const t1 = open ? Math.max(aEnd, bEnd) : Math.max(aEnd, Math.min(bEnd, to));
  const out = new Float32Array(Math.max(1, Math.round((t1 - t0) * sr)));
  const ia = Math.round((A.t0 - t0) * sr);
  out.set(A.data.subarray(0, Math.max(0, Math.min(A.data.length, out.length - ia))), ia);
  const i0 = Math.max(0, Math.round((from - t0) * sr)), i1 = Math.min(out.length, open ? out.length : Math.round((to - t0) * sr));
  const ib = Math.round((t0 - B.t0) * sr), fade = Math.max(1, Math.round(0.012 * sr));
  for (let i = i0; i < i1; i++) {
    const j = i + ib, b = j >= 0 && j < bd.length ? bd[j] : 0;
    const w = Math.min(1, (i - i0) / fade, open ? 1 : (i1 - i) / fade);
    out[i] = out[i] * (1 - w) + b * w;
  }
  return { t0, sr, data: out };
}
// Notes for singing that joins the score: transcribed in the score's key, on the score's beat grid.
function notesOnScoreGrid(points, end, sc) {
  const res = (sc && sc.res) || sres();
  const grid = sc && sc.tempo && !sc.beatMap ? { bpm: sc.tempo.bpm, t0: sc.tempo.t0, beats: sc.tempo.beats || 4 } : null;
  const b = buildScore(points, {
    tuning: $('tuningSel').value, key: sc && sc.key ? `${sc.key.root}:${sc.key.mode}` : 'auto', end, res, grid, tempoScale: 1, detail: +$('sdetail').value,
  });
  if (sc && sc.beatMap) quantizeRhythm(b.notes, sc.beatMap, { res });
  return b.notes;
}

// Next part: the new singing continues the take (recording and pitch line joined), the take is read
// again as a whole, and the new part gets its own section so it can have its own mood.
function appendPart(A, part, marker) {
  pushHistory('the take before the next part');
  const cut = Math.min(marker, part.start);
  A.points = A.points.filter(p => p.t < cut).concat(part.points);
  A.voice = spliceVoice(A.voice, part.voice, cut, Infinity);
  A.end = part.end;
  freshAudio(A);
  if (A.edited && A.score && A.score.key) {
    // your edits stay; the new notes join them on the same grid
    const res = A.score.res || sres(), m0 = edStep(marker) - Math.round(res / 2);
    const fresh = notesOnScoreGrid(part.points, part.end, A.score).filter(n => n.qs >= m0);
    for (const n of fresh) n.src = { start: n.start, end: n.end };
    A.edited = { ...A.edited, notes: [...A.edited.notes, ...fresh] };
  }
  S.view.mode = 'take';
  retranscribe();
  const sec = addSectionAt(marker);
  saveTake();
  const added = A.score ? A.score.notes.filter(n => sStart(n) >= marker - 0.2).length : 0;
  $('status').textContent = `Next part added: ${added} notes` + (sec ? ` · section ${sec.name} starts at bar ${sec.bar + 1} (click it below to give it a mood)` : '') + ' · Undo take removes it';
}
function addSectionAt(t) {
  const plan = backingPlan(), sc = S.take.score;
  if (!plan || !plan.segs.length || !sc.tempo) return null;
  const beats = plan.meter.beats, first = plan.segs[0].start;
  const bar = Math.round((beatAt(t) - first) / beats);
  if (bar <= 0) return null;
  const list = (S.take.sections || []).map(x => ({ ...x }));
  if (!list.length) list.push({ id: 1, name: 'A', bar: 0, mood: '', fill: true });
  if (!list.some(x => x.bar === bar)) list.push({ id: Date.now(), name: nextSectionName(list), bar, mood: '', fill: true });
  S.take.sections = list;
  renderSections();
  return list.find(x => x.bar === bar);
}

// Redo from marker: the new notes replace the score from the marker to where the singing stopped;
// the recording and pitch line are replaced over the same stretch.
function replaceFromMarker(A, part, marker) {
  const sc = A.score, res = sc.res || 2;
  const fresh = notesOnScoreGrid(part.points, part.end, sc).filter(n => n.qs >= edStep(marker) - Math.round(res / 2));
  if (!fresh.length) { $('status').textContent = 'Nothing sung after the marker — try again'; renderNotes(); return; }
  pushHistory('the take before the redo');
  const cut = Math.min(marker, part.start), stop = part.end;
  A.points = A.points.filter(p => p.t < cut || p.t > stop).concat(part.points).sort((a, b) => a.t - b.t);
  A.voice = spliceVoice(A.voice, part.voice, cut, stop);
  if (part.end > A.end) A.end = part.end;
  freshAudio(A);
  const q0 = Math.max(edStep(marker), Math.min(...fresh.map(n => n.qs))), q1 = Math.max(...fresh.map(n => n.qe));
  beginEdit();
  const kept = sc.notes.filter(n => n.qe <= q0 || n.qs >= q1), replaced = sc.notes.length - kept.length;
  for (const n of fresh) { if (n.qs < q0) n.qs = q0; n.src = { start: n.start, end: n.end }; }
  sc.notes = [...kept, ...fresh];
  ED.sel = new Set(fresh);
  S.view.mode = 'take';
  commitEdit();
  retranscribe();
  $('status').textContent = `Redone from the marker: ${fresh.length} new notes${replaced ? `, replacing ${replaced}` : ''} · Ctrl+Z undoes the notes, Undo take the recording too`;
}

// ---------- layers: parts sung on top of the take ----------
// Each layer keeps its own recording and pitch line on the take's clock, and its notes on the
// score's grid; it plays along (its voice, or its notes on its own sound) and can be muted.
const LAYER_SOUNDS = [['voice', 'My voice synth'], ['plain', 'Plain tone'], ['flute', 'Flute'], ['clarinet', 'Clarinet'], ['oboe', 'Oboe'],
  ['violins', 'Violins'], ['cellos', 'Cellos'], ['horn', 'Horn'], ['trumpet', 'Trumpet'], ['piano', 'Piano']];
const soundName = v => (LAYER_SOUNDS.find(x => x[0] === v) || [v, v === 'profile' ? 'My voice profile' : v])[1];
function transcribeLayer(tk, L) {
  if (L.voice && !L.frames) L.frames = analyseSpectrum(L.voice, L.points);
  L.notes = notesOnScoreGrid(L.points, L.end, tk.score);
  if (L.frames) for (const n of L.notes) n.env = voiceEnvelope(L.frames, n.start, n.end);
}
function addLayer(A, part) {
  pushHistory('the take before the layer');
  const layers = A.layers || [], used = new Set(layers.map(L => L.colour));
  const colour = [1, 2, 3, 4].find(c => !used.has(c)) || layers.length % 4 + 1;
  let k = layers.length + 1;
  while (layers.some(L => L.name === 'Layer ' + k)) k++;
  const L = { id: Date.now(), name: 'Layer ' + k, colour, ...part, gain: 1, muted: false, sound: 'voice' };
  transcribeLayer(A, L);
  A.layers = [...layers, L];
  saveTake();
  const key = scoreKey();
  $('status').textContent = `${L.name}: ${L.notes.length} notes` + (key && L.notes.length ? ` (${L.notes.slice(0, 5).map(n => spell(n.midi + transpose(), key)).join(' ')}${L.notes.length > 5 ? '…' : ''})` : '')
    + ' · it plays along; click it under Parts to change its sound or mute it';
}
function layerBuffer(ctx, L) {
  if (!L.playBuf) {
    const d = L.voice.data;
    let pk = 0;
    for (const v of d) pk = Math.max(pk, Math.abs(v));
    const g = pk > 1e-6 ? Math.min(0.9 / pk, 60) : 1, buf = ctx.createBuffer(1, d.length, L.voice.sr), x = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) x[i] = d[i] * g;
    buf.copyToChannel(x, 0);
    L.playBuf = buf;
  }
  return L.playBuf;
}
// Layers for take time [a, b), started at audio time `at`: their voices (My voice, Sung line, Both)
// and their notes (Score, Both).
function scheduleLayers(ctx, bus, at, a, b) {
  const hear = S.hear;
  for (const L of S.take.layers || []) {
    if (L.muted) continue;
    const g = ctx.createGain(); g.gain.value = L.gain; g.connect(bus);
    if (hear !== 'score' && L.voice) {
      const src = ctx.createBufferSource(), lg = ctx.createGain();
      src.buffer = layerBuffer(ctx, L); lg.gain.value = hear === 'both' ? 0.7 : 0.9;
      src.connect(lg).connect(g);
      const off = a - L.voice.t0;
      if (b - a + Math.min(0, off) > 0.01) off >= 0 ? src.start(at, off, b - a) : src.start(at - off, 0, b - a + off);
    }
    if (hear === 'score' || hear === 'both') for (const n of L.notes || []) {
      const s = sStart(n), e = sEnd(n);
      if (s >= a - 1e-6 && s < b) playScoreNote(ctx, n, at + (s - a), g, { s, e: Math.min(e, b) }, L.sound);
    }
  }
}

// The Parts line under the roll: the main take and each layer.
function renderParts() {
  const box = $('parts');
  box.innerHTML = '';
  const tk = S.take;
  if (!tk || !tk.points) return;
  const chip = (cls, colour, name, sub, title, onclick) => {
    const el = document.createElement('div');
    el.className = 'chip part' + cls; el.style.setProperty('--partc', colour);
    el.innerHTML = `<i class="sw"></i><b>${name}</b><span>${sub}</span>`;
    el.title = title; el.onclick = () => onclick(el);
    box.appendChild(el);
  };
  const mainNotes = tk.score ? tk.score.notes.length : tk.notes.length;
  chip(S.acc.melody ? '' : ' off', 'var(--accent)', 'Main', `${soundName($('melSound').value)} · ${mainNotes}`, 'The take: click to choose what plays its melody', el => openMainMenu(el));
  for (const L of tk.layers || []) {
    chip(L.muted ? ' off' : '', `var(--layer${L.colour})`, L.name, `${soundName(L.sound)} · ${(L.notes || []).length}${L.gain !== 1 ? ' · ' + Math.round(L.gain * 100) + '%' : ''}`,
      'Click to change its sound, level, mute or delete it', el => openLayerMenu(L.id, el));
  }
  const add = (text, mode, title) => {
    const b = document.createElement('button');
    b.className = 'small'; b.textContent = text; b.title = title;
    b.onclick = () => { setSeg('recMode', mode); segHandlers.recMode(); };
    box.appendChild(b);
  };
  add('+ Layer', 'layer', 'Record a part on top of the take');
  add('+ Next part', 'next', 'Record what comes after the take');
}
function openMainMenu(anchor) {
  openPopover(anchor, pop => {
    const again = () => { renderParts(); openMainMenu(anchor); };
    popRow(pop, 'Played by', [...LAYER_SOUNDS, ['profile', 'My voice profile']].map(([v, text]) => ({ text, on: $('melSound').value === v,
      disabled: v === 'profile' && !S.profile, do: () => { $('melSound').value = v; $('melSound').dispatchEvent(new Event('change', { bubbles: true })); again(); } })));
    popRow(pop, 'In Score', [{ text: S.acc.melody ? '✓ plays' : 'silent', on: S.acc.melody, title: 'The melody in Score playback (also under Backing → What plays)',
      do: () => { document.querySelector('#accToggles [data-acc="melody"]').click(); again(); } }]);
  });
}
function openLayerMenu(id, anchor) {
  const tk = S.take, L = tk && (tk.layers || []).find(x => x.id === id);
  if (!L) return;
  const change = f => { f(); saveTake(); renderParts(); openLayerMenu(id, anchor); };
  openPopover(anchor, pop => {
    popRow(pop, 'Played by', LAYER_SOUNDS.map(([v, text]) => ({ text, on: L.sound === v, do: () => change(() => { L.sound = v; if (!['voice', 'plain'].includes(v)) ensureOrchestra(); }) })));
    popRow(pop, 'Level', [
      { text: '−', do: () => change(() => { L.gain = Math.max(0, Math.round((L.gain - 0.1) * 10) / 10); }) },
      { text: Math.round(L.gain * 100) + '%', disabled: true },
      { text: '+', do: () => change(() => { L.gain = Math.min(1.5, Math.round((L.gain + 0.1) * 10) / 10); }) },
    ]);
    popRow(pop, '', [
      { text: L.muted ? 'Unmute' : 'Mute', on: L.muted, do: () => change(() => { L.muted = !L.muted; }) },
      { text: 'Delete layer', title: 'Undo take brings it back', do: () => {
        pushHistory('the take before deleting ' + L.name);
        tk.layers = tk.layers.filter(x => x !== L); saveTake(); renderParts(); closePopover(); updateButtons();
        $('status').textContent = L.name + ' deleted · Undo take brings it back';
      } },
    ]);
  });
}

// ---------- groove: a drum pattern from beatboxing, tapping or clapping (rhythm.js) ----------
const clonePattern = p => JSON.parse(JSON.stringify(p));
function loadGroove() {
  try { const g = JSON.parse(localStorage.getItem('hum-groove') || 'null'); if (g && g.lanes) return g; } catch {}
  return clonePattern(PATTERN_PRESETS.rock);
}
function saveGroove() { try { localStorage.setItem('hum-groove', JSON.stringify(S.groove)); } catch {} renderGrooveCtl(); }
S.groove = loadGroove();
for (const name of Object.keys(PATTERN_PRESETS)) $('presetSel').add(new Option(name[0].toUpperCase() + name.slice(1), name));

// A beat take becomes the groove; the melody take stays as it was.
function finishBeat(tk) {
  const g = tk.voice && rhythmGrid(classifyHits(detectHits(tk.voice.data, tk.voice.sr)));
  renderNotes(); updateButtons(); updateScoreInfo();
  if (!g) { $('status').textContent = 'No clear rhythm heard — try louder, separate hits'; return; }
  S.groove = clonePattern(g.loop || g);
  delete S.groove.loop;
  S.groove.t0 = 0;
  saveGroove();
  setSeg('layer', 'groove'); segHandlers.layer();
  const n = Object.values(S.groove.lanes).reduce((s, l) => s + l.length, 0);
  $('status').textContent = `Groove: ${Math.round(S.groove.bpm)} bpm · ${S.groove.beats}/4 · ${S.groove.bars} bar${S.groove.bars > 1 ? 's' : ''} · ${n} hits`
    + (S.groove.swing > 0.55 ? ' · swung' : '');
  if (tk.voice) fetch(`save/beat-${stamp()}.wav`, { method: 'POST', body: encodeWav(tk.voice.data, tk.voice.sr) }).catch(() => {});
}
function renderGrooveCtl() {
  const g = S.groove;
  $('grooveCtl').hidden = S.layer !== 'groove';
  if (!g) return;
  $('gBpm').value = Math.round(g.bpm);
  $('gSwing').value = g.swing;
  $('gInfo').textContent = `${g.beats}/4 · ${g.bars} bar${g.bars > 1 ? 's' : ''}`;
  $('gHum').classList.toggle('on', S.grooveHum);
}
$('presetSel').onchange = () => { const p = PATTERN_PRESETS[$('presetSel').value]; if (p) { S.groove = clonePattern(p); saveGroove(); } $('presetSel').value = ''; };
$('gBpm').onchange = () => { S.groove.bpm = Math.max(50, Math.min(220, +$('gBpm').value || 96)); saveGroove(); };
$('gSwing').oninput = () => { S.groove = varySwing(S.groove, +$('gSwing').value); saveGroove(); };
for (const b of document.querySelectorAll('[data-vary]')) b.onclick = () => {
  const g = S.groove, v = b.dataset.vary;
  S.groove = v === 'busier' ? varyBusier(g) : v === 'simpler' ? varySimpler(g) : v === 'half' ? varyHalfTime(g)
    : v === 'double' ? varyDoubleTime(g) : v === 'fill' ? varyFill(g) : v === 'humanize' ? varyHumanize(g, Date.now() % 1000)
    : { ...clonePattern(g), lanes: { kick: [], snare: [], hat: [] } };
  saveGroove();
};
$('gHum').onclick = () => { S.grooveHum = !S.grooveHum; renderGrooveCtl(); };
$('gUse').onclick = () => { setSeg('feel', 'mine'); $('moodSel').value = 'custom'; saveSettings(); $('status').textContent = 'The backing now uses your groove (Rhythm: Mine)'; };

// Plays the groove on a lookahead clock (for humming over it and for the Groove view).
const grooveClock = {
  timer: 0, step: 0, t0: 0,
  start(ctx, out, t0) {
    this.stop();
    this.t0 = t0; this.step = 0; this.ctx = ctx; this.out = out;
    const tick = () => {
      const g = S.groove;
      if (!g || !g.length) return;
      const loopLen = stepTime(g, g.length);
      while (true) {
        const loops = Math.floor(this.step / g.length), local = this.step - loops * g.length;
        const at = this.t0 + loops * loopLen + stepTime(g, local);
        if (at > ctx.currentTime + 0.15) break;
        for (const e of patternEvents(g, local, local + 1)) {
          const lvl = e.kind === 'kick' ? 0.55 : e.kind === 'snare' ? 0.3 : 0.15;
          drum(ctx, this.out, e.kind, at + (e.nudge || 0) / 1000, lvl * (e.vel ?? 0.8));
        }
        this.step++;
      }
    };
    tick();
    this.timer = setInterval(tick, 25);
  },
  stop() { clearInterval(this.timer); this.timer = 0; },
  // where the groove is now, in steps (for the playhead)
  now() {
    const g = S.groove;
    if (!this.timer || !g || !this.ctx) return null;
    const el = this.ctx.currentTime - this.t0, loopLen = stepTime(g, g.length);
    if (el < 0) return null;
    const inLoop = el % loopLen;
    let s = 0;
    while (s < g.length - 1 && stepTime(g, s + 1) <= inLoop) s++;
    return s;
  },
};

// The Groove view: a step grid, one row per drum; click a cell to add or remove a hit
// (shift-click for a soft one).
const G_LANES = ['hat', 'snare', 'kick'], G_NAMES = { hat: 'Shaker / hat', snare: 'Snare', kick: 'Kick' };
function drawGroove() {
  const W = cv.clientWidth, H = cv.clientHeight, g = S.groove;
  g2.clearRect(0, 0, W, H);
  if (!g) return;
  const gut = 96, top = 30, rowH = Math.min(70, (H - top - 20) / G_LANES.length), cw = (W - gut - 10) / g.length;
  S.lastGrid = { gut, top, rowH, cw };
  const playing = grooveClock.now();
  g2.font = '12px "Space Grotesk", sans-serif'; g2.textBaseline = 'middle';
  for (let s = 0; s <= g.length; s++) {
    const x = gut + s * cw;
    g2.fillStyle = s % (g.steps * g.beats) === 0 ? colors.bar : s % g.steps === 0 ? colors.muted : colors.grid;
    g2.globalAlpha = s % g.steps === 0 ? 0.6 : 1;
    g2.fillRect(x, top, s % g.steps === 0 ? 1.5 : 1, rowH * G_LANES.length);
    g2.globalAlpha = 1;
    if (s < g.length && s % g.steps === 0) { g2.fillStyle = colors.muted; g2.fillText(String(Math.floor(s / g.steps) % g.beats + 1), x + 4, top - 12); }
  }
  if (playing != null) { g2.fillStyle = colors.lane_root || colors['lane-root']; g2.fillRect(gut + playing * cw, top, cw, rowH * G_LANES.length); }
  G_LANES.forEach((lane, r) => {
    const y = top + r * rowH;
    g2.fillStyle = colors.grid; g2.fillRect(gut, y + rowH - 1, W - gut - 10, 1);
    g2.fillStyle = colors.text; g2.fillText(G_NAMES[lane], 8, y + rowH / 2);
    const col = lane === 'kick' ? colors['bk-low-edge'] : lane === 'snare' ? colors['note-edge'] : colors.accent;
    for (const e of g.lanes[lane] || []) {
      const x = gut + e.step * cw;
      g2.fillStyle = col; g2.globalAlpha = 0.3 + 0.7 * (e.vel ?? 0.8);
      g2.beginPath(); g2.roundRect(x + 2, y + 6, Math.max(4, cw - 4), rowH - 12, 5); g2.fill();
      g2.globalAlpha = 1;
    }
  });
}
function grooveClick(e) {
  const v = S.lastGrid, g = S.groove;
  if (!v || !g) return;
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const step = Math.floor((x - v.gut) / v.cw), row = Math.floor((y - v.top) / v.rowH);
  if (step < 0 || step >= g.length || row < 0 || row >= G_LANES.length) return;
  const lane = g.lanes[G_LANES[row]] || (g.lanes[G_LANES[row]] = []);
  const i = lane.findIndex(h => h.step === step);
  if (i >= 0) lane.splice(i, 1); else { lane.push({ step, vel: e.shiftKey ? 0.45 : 0.85 }); lane.sort((a, b) => a.step - b.step); }
  saveGroove();
}

// After a take, the drone moves to the take's home note (as sung, before any transpose),
// so the next take has the right home to sing against.
function followTonic(tk) {
  const k = tk.score && tk.score.key;
  if (!k || +$('root').value === k.root) return;
  $('root').value = String(k.root);
  if (S.droneOn) setDrone(true);
  saveSettings();
}

// Cut the silence before the first and after the last sung note (a little room kept), so a
// take starts where the singing starts. The recording itself stays whole.
function trimTake(tk) {
  const voiced = tk.points.filter(p => !isNaN(p.m));
  if (!voiced.length) return;
  const s = Math.max(tk.start, voiced[0].t - 0.25), e = Math.min(tk.end, voiced[voiced.length - 1].t + 0.35);
  tk.trimmed = (s - tk.start) + (tk.end - e);
  tk.start = s; tk.end = e;
  tk.points = tk.points.filter(p => p.t >= s && p.t <= e);
}

// Rebuild notes, expression and rhythm from the stored take with the current settings.
function retranscribe() {
  const tk = S.take;
  if (!tk || !tk.points || S.recording) return;
  const seg = new Segmenter(snap);
  for (const p of tk.points) seg.push(p.t, p.m);
  seg.close(tk.end);
  tk.notes = mergeGlides(mergeFragments(seg.notes), tk.points, +$('detail').value);
  describeNotes(tk.notes, tk.points, +$('detail').value);
  tk.ampMax = tk.points.reduce((a, p) => isNaN(p.m) ? a : Math.max(a, p.r), 1e-4);
  if (tk.voice) {
    const sum = new Float32Array(24);
    let cnt = 0;
    for (const n of tk.notes) {
      n.harm = harmonicProfile(tk.voice.data, tk.voice.sr, tk.voice.t0, tk.points, n);
      if (n.harm) { n.harm.forEach((v, i) => sum[i] += v); cnt++; }
    }
    tk.harm = cnt ? sum.map(v => v / cnt) : null;
  }
  tk.tune = null;
  tk.tempo = tk.grid ? { ...tk.grid, source: 'click' } : inferTempo(tk.notes);
  if (tk.tempo) {
    tk.tempo.bpm *= tk.tempoScale;
    tk.unit = quantize(tk.notes, tk.tempo, res());
  }
  tk.rendered = null;
  if (tk.voice && !tk.frames) tk.frames = analyseSpectrum(tk.voice, tk.points);
  tk.env = tk.frames ? voiceEnvelope(tk.frames) : null;
  tk.score = buildScore(tk.points, {
    tuning: $('tuningSel').value, key: $('keySel').value, end: tk.end, res: sres(), grid: tk.grid, tempoScale: tk.tempoScale,
    detail: +$('sdetail').value,
  });
  tk.score.res = sres();
  if (!tk.edited && !tk.grid && typeof trackBeats === 'function') applyRhythm2(tk);
  if (tk.edited) Object.assign(tk.score, { notes: tk.edited.notes, tempo: tk.edited.tempo, unit: tk.edited.unit, res: tk.edited.res, key: tk.edited.key, beatMap: tk.edited.beatMap || null, meterFixed: tk.edited.meterFixed || null });
  if (tk.frames) for (const n of tk.score.notes) if (!n.env) n.env = voiceEnvelope(tk.frames, n.src ? n.src.start : n.start, n.src ? n.src.end : n.end);
  if (tk.layers) for (const L of tk.layers) transcribeLayer(tk, L);
  updatePartials();
  renderNotes(); updateTempo(); updateButtons(); updateScoreInfo(); renderParts();
  if (typeof renderEditBar === 'function') renderEditBar();
}

// ---------- rhythm v2 (rhythm2.js): beats that follow your tempo ----------
// Note starts from pitch changes and loudness re-attacks (two "dum"s on one pitch are two notes),
// a beat tracker that follows tempo drift (or your taps), and the simplest notation that fits.
function applyRhythm2(tk) {
  const sc = tk.score, res = sc.res;
  try {
    const on = noteOnsets(tk.points, tk.voice);
    const notes = splitNotesAtOnsets(sc.notes, on);
    const map = tk.taps && tk.taps.length >= 4 ? beatsFromTaps(tk.taps, on, { notes, end: tk.end }) : trackBeats(on, { notes, end: tk.end });
    if (!map) return;
    quantizeRhythm(notes, map, { res });
    const d = sc.detail ?? 0.5;
    notes.forEach((n, i) => {
      const next = notes[i + 1];
      n.grace = false; n.slur = false;
      if (!next) return;
      if (d >= 0.55 && n.end - n.start < 0.13 && next.end - next.start > 2 * (n.end - n.start)) n.grace = true;
      if (next.start - n.end < 0.04) n.slur = true;
    });
    sc.notes = notes;
    sc.beatMap = map;
    sc.meterFixed = map.meter;
    sc.tempo = { bpm: map.bpm, t0: beatTimeOf(map, 0), beats: map.meter.beats, source: map.source === 'taps' ? 'your taps' : 'tracked', drift: map.drift, confidence: map.confidence };
    sc.unit = 60 / map.bpm / res;
  } catch (err) { console.warn('rhythm v2 skipped:', err); }
}

// ---------- score layer: clean notes for composing ----------
const scoreView = () => S.layer === 'score' && S.take && S.take.score && (!S.recording || armed());
const transpose = () => Math.round(+$('transpose').value || 0);
const scoreKey = () => { const k = S.take && S.take.score && S.take.score.key; return k && { ...k, root: pcOf(k.root + transpose()) }; };
const stepTimeOf = step => { const sc = S.take.score; return sc.beatMap ? beatTimeOf(sc.beatMap, step / sc.res) : sc.tempo.t0 + step * sc.unit; };
const sStart = n => { const sc = S.take.score; return sc.tempo ? stepTimeOf(n.qs) : n.start; };
const sEnd = n => { const sc = S.take.score; return sc.tempo ? stepTimeOf(n.qe) : n.end; };
const scoreLen = n => S.take.score.tempo ? valueName(n.qe - n.qs, S.take.score.res || sres()) : (n.end - n.start).toFixed(2) + 's';
function updateScoreInfo() {
  const sc = S.take && S.take.score;
  if (!sc) { $('scoreInfo').textContent = ''; $('backingOff').hidden = false; $('backing').hidden = true; renderLegend(); renderGrooveCtl(); renderSections(); renderChords(); return; }
  const parts = [];
  if (sc.key) parts.push(keyName(scoreKey()));
  if (sc.tempo) parts.push(Math.round(sc.tempo.bpm) + ' bpm' + (sc.tempo.source === 'your taps' ? ' (your taps)' : sc.beatMap && sc.tempo.drift > 0.25 ? ' (follows your tempo)' : ''));
  parts.push(sc.tuning.used ? `your A = ${(440 * Math.pow(2, sc.tuning.offset / 12)).toFixed(0)} Hz` : 'A = 440 Hz');
  const plan = S.acc.motif && backingPlan();
  if (plan && plan.motif) parts.push('motif ' + plan.motif.notes.map(n => spell(n.midi + transpose(), scoreKey())).join(' ') + (plan.motif.fallback ? ' (opening)' : ` ×${plan.motif.occurrences.length}`));
  $('scoreInfo').textContent = parts.join(' · ');
  const T = transpose();
  if ($('keySel').value !== 'auto') {
    const b = document.createElement('button');
    b.className = 'small'; b.textContent = 'auto key'; b.title = 'Let the key be found from the take again';
    b.onclick = () => { $('keySel').value = 'auto'; saveSettings(); retranscribe(); };
    $('scoreInfo').appendChild(b);
  } else if (sc.key && sc.key.runnerUp && sc.key.margin < 0.1) {
    // a close second (often the relative major/minor): one click to switch
    const r = sc.key.runnerUp, b = document.createElement('button');
    b.className = 'small'; b.textContent = `or ${keyName({ ...r, root: pcOf(r.root + T) })}?`;
    b.title = 'This key fits almost as well — click to use it';
    b.onclick = () => { $('keySel').value = `${r.root}:${r.mode}`; saveSettings(); retranscribe(); };
    $('scoreInfo').appendChild(b);
  }
  renderLegend();
  const show = S.layer === 'score';
  $('backing').hidden = !show; $('backingOff').hidden = show; $('chords').hidden = !show;
  renderGrooveCtl();
  renderChords();
  renderSections();
}
// how the note was sung, for the chip tooltip
function perfText(p) {
  const bits = [];
  if (p.scoop) bits.push(`scoop ${p.scoop > 0 ? 'from above' : 'from below'} ${Math.abs(Math.round(p.scoop * 100))}¢`);
  if (p.fall) bits.push(`fall ${p.fall > 0 ? 'up' : 'off'} ${Math.abs(Math.round(p.fall * 100))}¢`);
  if (p.end - p.start >= 0.4 && Math.abs(p.drift) > 20) bits.push(`drift ${Math.round(p.drift)}¢/s`);
  if (p.vib) bits.push(`vibrato ${p.vib.rate.toFixed(1)} Hz ±${Math.round(p.vib.depth / 2)}¢`);
  return bits.join(' · ') || 'steady';
}
function renderScore() {
  const box = $('notes'), sc = S.take.score, T = transpose(), key = scoreKey();
  for (const n of sc.notes) {
    const el = document.createElement('div');
    el.className = 'chip' + (n.chromatic ? ' chromatic' : '') + (n.grace ? ' grace' : '') + (n.slur ? ' slur' : '');
    if (degreesOn()) { el.dataset.deg = degreeOf12(n.midi + T); el.style.setProperty('--degc', degColour(n.midi + T)); }
    el.innerHTML = `<b>${spell(n.midi + T, key)}</b><span>${n.grace ? 'grace' : scoreLen(n)}</span>`;
    el.title = (n.chromatic ? 'sung outside the key · ' : '') + perfText(n.perf);
    el.onclick = async () => { const ctx = await ensureCtx(); playScoreNote(ctx, n, ctx.currentTime + 0.02, ctx.destination); };
    box.appendChild(el);
  }
}
// One score note: clean at Style 0; Style blends in the sung timing, pitch curve and loudness.
function playScoreNote(ctx, n, at, out, timing, sound) {
  const st = +$('style').value, p = n.perf, T = transpose();
  const s = timing ? timing.s : n.start, e = timing ? timing.e : n.end;
  const mel = sound || $('melSound').value;
  if (mel === 'profile' && profileReady()) {
    try {
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = profileNoteBuffer(ctx, n.midi + T, Math.max(0.15, e - s)); g.gain.value = 1;
      src.connect(g).connect(out); src.start(at);
      return;
    } catch {}
  }
  if (!['voice', 'plain', 'profile'].includes(mel) && orchestraReady) {
    const g = ctx.createGain(); g.gain.value = 4; g.connect(out);   // samples sit far below the synth voices
    playSample(ctx, g, mel, n.midi + T, at, e - s, 0.85);
    return;
  }
  const note = { midi: n.midi + T, offset: 0, curve: p.curve, amp: p.amp, bend: null, start: p.start, end: p.end, env: n.env };
  tone(ctx, note, at, (e - s) / Math.max(1e-3, p.end - p.start), out, st, mel);
}
segHandlers.layer = () => { renderNotes(); renderPartials(); updateScoreInfo(); renderGrooveCtl(); renderEditBar(); };
segHandlers.colours = () => { renderNotes(); renderLegend(); };

// ---------- backing: rhythm, drone, chords and bass worked out from the score ----------
// Plan (meter, bars, groove, chords) is cached on the score; chord picks the player made are kept by bar position.
function backingPlan() {
  const sc = S.take && S.take.score;
  if (!sc || !sc.tempo || !sc.key || !sc.notes.length) return null;
  const r = sc.res || sres(), per = +S.chordRate, msel = $('meterSel').value;
  const sig = [r, per, msel, sc.notes.length, S.harmony, S.formAware, JSON.stringify(S.take.chordEdits || {})].join('|');
  if (sc.plan && sc.plan.sig === sig) return sc.plan;
  let meter = sc.meterFixed ? { ...sc.meterFixed } : detectMeter(sc.notes, r);
  if (msel !== 'auto' && +msel !== meter.beats) {
    const fixed = +msel;
    meter = { beats: fixed, offset: 0 };
    let best = -1;
    for (let off = 0; off < fixed; off++) {
      const on = sc.notes.reduce((s, n) => s + (((n.qs / r - off) % fixed + fixed) % fixed < 1e-6 ? (n.qe - n.qs) / r + 0.5 : 0), 0);
      if (on > best) { best = on; meter.offset = off; }
    }
  }
  // Composed: phrases, cadences and repeats shape the chords (form.js); else one decision per bar
  let form = null, segs;
  if (S.formAware !== 'off' && typeof harmonizeForm === 'function') {
    try { form = analyseForm(sc.notes, sc.key, meter, r); segs = harmonizeForm(sc.notes, sc.key, meter, r, { colour: S.harmony, form, rate: per }); }
    catch (err) { console.warn('form-aware harmony skipped:', err); form = null; }
  }
  if (!segs) segs = harmonize(sc.notes, sc.key, meter, r, per, S.harmony);
  const picks = S.take.chordPicks || (S.take.chordPicks = {});
  for (const sg of segs) { const p = picks[sg.start.toFixed(3)]; if (p != null) sg.pick = p % sg.alts.length; }
  // your chord edits: bars split in two, then chosen chords (or no chord) per segment
  const ce = S.take.chordEdits || {}, splits = new Set(ce.splits || []), chosen = ce.set || {};
  const split = [];
  for (const sg of segs) {
    if (splits.has(sg.start.toFixed(3)) && sg.end - sg.start >= 2) {
      const mid = (sg.start + sg.end) / 2;
      split.push({ ...sg, end: mid }, { ...sg, start: mid, pick: 0 });
    } else split.push(sg);
  }
  segs.length = 0; segs.push(...split);
  for (const sg of segs) {
    const c = chosen[sg.start.toFixed(3)];
    if (c === null) sg.override = null;
    else if (c) sg.override = makeChord(c.root, c.q, c.x, sc.key);
  }
  sc.plan = { sig, meter, form, groove: groovePattern(sc.notes, meter, r), segs, motif: findMotif(sc.notes, r, sc.key) };
  return sc.plan;
}
const spb = () => 60 / S.take.score.tempo.bpm;
const beatTime = b => { const sc = S.take.score; return sc.beatMap ? beatTimeOf(sc.beatMap, b) : sc.tempo.t0 + b * spb(); };
// the chord a segment plays: your choice if you set one (null = no chord), else the pick from the fitting ones
const segChord = sg => sg.override !== undefined ? sg.override : sg.alts[sg.pick || 0];
// last real chord at or before a segment (for bars left without a chord)
function chordFor(plan, sg) {
  const i = plan.segs.indexOf(sg);
  for (let j = i; j >= 0; j--) { const c = segChord(plan.segs[j]); if (c) return c; }
  for (let j = i + 1; j < plan.segs.length; j++) { const c = segChord(plan.segs[j]); if (c) return c; }
  return null;
}

// Any chord: root (pitch class, as sung), a quality and an optional colour on top.
const CHORD_Q = { '': [0, 4, 7], m: [0, 3, 7], '°': [0, 3, 6], '+': [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7] };
const CHORD_X = { '': [], 7: [10], maj7: [11], 6: [9], add9: [14] };
function makeChord(root, q, x = '', key) {
  const base = CHORD_Q[q], ext = CHORD_X[x] || [];
  const deg = key ? pcOf(root - key.root) : 0, sc = key ? SCALES[key.mode] : [];
  const i = sc.indexOf(deg), numerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  let roman = i >= 0 ? numerals[i] : '♭' + numerals[sc.findIndex(s => s > deg)] || '?';
  if (q === 'm' || q === '°') roman = roman.toLowerCase();
  const label = q === 'm' ? (x === 'maj7' ? 'm(maj7)' : 'm' + x) : q === '°' ? '°' + (x === '7' ? '7' : '') : q === '+' ? '+' + x
    : q.startsWith('sus') ? (x === '7' ? '7' : '') + q : x === '' ? '' : x;
  return { root, quality: label, q, x, roman: roman + (q === '°' ? '°' : ''), pcs: base.map(p => (root + p) % 12), tones: [...base, ...ext] };
}

function renderChords() {
  const box = $('chords');
  box.innerHTML = '';
  const plan = scoreView() && backingPlan();
  if (!plan) return;
  const key = scoreKey(), T = transpose();
  plan.segs.forEach(sg => {
    const c = segChord(sg), el = document.createElement('div');
    const set = sg.override !== undefined;
    el.className = 'chip chord' + (sg.pick ? ' picked' : '') + (set ? ' set' : '') + (c ? '' : ' none');
    el.innerHTML = c ? `<b>${chordName({ ...c, root: pcOf(c.root + T) }, key)}</b><span>${c.roman}</span>` : '<b>–</b><span>no chord</span>';
    el.title = 'Click to choose the chord for this ' + (sg.end - sg.start < plan.meter.beats ? 'half bar' : 'bar');
    el.onclick = () => openChordMenu(sg, el);
    box.appendChild(el);
  });
}

// ---------- small menus ----------
let popEl = null;
function closePopover() { if (popEl) { popEl.remove(); popEl = null; } }
function openPopover(anchor, build) {
  closePopover();
  popEl = document.createElement('div');
  popEl.className = 'popover';
  build(popEl);
  document.body.appendChild(popEl);
  const r = anchor.getBoundingClientRect(), pr = popEl.getBoundingClientRect();
  popEl.style.left = Math.max(8, Math.min(innerWidth - pr.width - 8, r.left)) + 'px';
  popEl.style.top = (r.top - pr.height - 6 > 8 ? r.top - pr.height - 6 : r.bottom + 6) + 'px';
}
addEventListener('mousedown', e => { if (popEl && !popEl.contains(e.target) && !e.target.closest('.chip')) closePopover(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closePopover(); });
function popRow(pop, label, items) {
  const row = document.createElement('div'); row.className = 'row';
  if (label) { const l = document.createElement('span'); l.className = 'label'; l.textContent = label; row.appendChild(l); }
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.text; if (it.title) b.title = it.title; if (it.on) b.classList.add('on'); if (it.disabled) b.disabled = true;
    b.onclick = it.do; row.appendChild(b);
  }
  pop.appendChild(row);
}

// The chord menu for one bar (or half bar): suggestions that fit, the key's chords, borrowed
// chords, colours on top of the current chord, split / join, no chord, back to automatic.
function chordEdits() { return S.take.chordEdits || (S.take.chordEdits = { set: {}, splits: [] }); }
function setChord(sg, c) {
  const ce = chordEdits(), k = sg.start.toFixed(3);
  if (c === undefined) delete ce.set[k]; else ce.set[k] = c && { root: c.root, q: c.q ?? (c.quality === 'm' ? 'm' : c.quality === '°' ? '°' : ''), x: c.x || '' };
  S.take.score.plan = null; saveTake();
  renderChords();
  const plan = backingPlan(), now = plan && plan.segs.find(x => Math.abs(x.start - sg.start) < 1e-6);
  if (now && !S.play) playChordAt(now);
}
function openChordMenu(sg, anchor) {
  const sc = S.take.score, key = sc.key, T = transpose(), cur = segChord(sg);
  const show = c => chordName({ ...c, root: pcOf(c.root + T) }, scoreKey());
  const asPlain = c => ({ root: c.root, q: c.q ?? (c.quality === 'm' ? 'm' : c.quality === '°' ? '°' : ''), x: c.x || '' });
  const same = (a, b) => a && b && a.root === b.root && (a.q ?? '') === (b.q ?? '') && (a.x || '') === (b.x || '');
  openPopover(anchor, pop => {
    const rebuild = () => openChordMenu(backingPlan().segs.find(x => Math.abs(x.start - sg.start) < 1e-6) || sg, anchor);
    popRow(pop, 'Fits best', sg.alts.slice(0, 4).map(c => ({ text: show(c), on: same(asPlain(c), cur && asPlain(cur)), do: () => { setChord(sg, asPlain(c)); rebuild(); } })));
    popRow(pop, 'In the key', chordsOf(key, 'plain').map(c => ({ text: show(c), title: c.roman, on: same(asPlain(c), cur && asPlain(cur)), do: () => { setChord(sg, asPlain(c)); rebuild(); } })));
    const borrowed = [];
    for (const col of ['modal', 'dark', 'lift']) for (const c of chordsOf(key, col)) if (c.pull && !borrowed.some(b => b.root === c.root && b.quality === c.quality)) borrowed.push(c);
    popRow(pop, 'Borrowed', borrowed.map(c => ({ text: show(c), title: c.roman, do: () => { setChord(sg, asPlain(c)); rebuild(); } })));
    if (cur) {
      const base = asPlain(cur);
      popRow(pop, 'Colour', [['', 'plain'], ['7', '7'], ['maj7', 'maj7'], ['6', '6'], ['add9', 'add9'], ['sus2', 'sus2'], ['sus4', 'sus4']].map(([v, text]) => {
        const isSus = v.startsWith('sus');
        const c = isSus ? { ...base, q: v, x: '' } : { ...base, q: base.q.startsWith('sus') ? '' : base.q, x: v };
        return { text, on: isSus ? base.q === v : base.x === v && !base.q.startsWith('sus'), do: () => { setChord(sg, c); rebuild(); } };
      }));
    }
    const plan = backingPlan(), ce = chordEdits(), k = sg.start.toFixed(3);
    const half = sg.end - sg.start < plan.meter.beats - 1e-6;
    const barStart = half && (sg.start - plan.meter.offset) % plan.meter.beats > 1e-6 ? sg.start - (sg.end - sg.start) : sg.start;
    popRow(pop, '', [
      half ? { text: 'Join halves', do: () => { ce.splits = ce.splits.filter(s => s !== barStart.toFixed(3)); delete ce.set[k]; setChord(sg, undefined); closePopover(); } }
        : { text: 'Split bar in two', disabled: sg.end - sg.start < 2, do: () => { ce.splits.push(k); setChord(sg, undefined); closePopover(); } },
      { text: 'No chord', on: cur === null, do: () => { setChord(sg, null); rebuild(); } },
      { text: 'Automatic', title: 'Back to the chord the app picked', do: () => { setChord(sg, undefined); rebuild(); } },
    ]);
  });
}
for (const b of $('accToggles').children) b.onclick = () => {
  S.acc[b.dataset.acc] = !S.acc[b.dataset.acc];
  b.classList.toggle('on', S.acc[b.dataset.acc]);
  saveSettings();
  if (b.dataset.acc === 'harmonics') renderPartials();
  if (b.dataset.acc === 'motif') updateScoreInfo();
};
segHandlers.chordRate = () => renderChords();
$('meterSel').addEventListener('change', () => renderChords());

// ----- backing sounds -----
let noiseBuf = null;
function noise(ctx) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; return src;
}
function env(ctx, g, at, peak, a, hold, rel) {
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + a);
  g.gain.setValueAtTime(peak, at + a + hold);
  g.gain.linearRampToValueAtTime(0, at + a + hold + rel);
}
// One backing note. Sounds: synth (soft saw pad), strings (slow detuned saws with vibrato),
// brass (saw with an opening filter), pluck (guitar-like), keys (electric-piano-like), plus
// drone and bass.
function synthNote(ctx, out, midi, at, dur, kind, level) {
  const g = ctx.createGain(), lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const oscs = [], hz = midiToHz(midi), long = dur > 0.6;
  const osc = (type, det = 0, mult = 1) => { const o = ctx.createOscillator(); o.type = type; o.detune.value = det; o.frequency.value = hz * mult; oscs.push(o); return o; };
  if (kind === 'synth') {
    lp.frequency.value = 1400;
    osc('sawtooth', -7); osc('sawtooth', 7);
    env(ctx, g, at, level, 0.12, Math.max(0, dur - 0.2), 0.35);
  } else if (kind === 'strings') {
    lp.frequency.value = 2200;
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 5.2; lg.gain.value = 9; lfo.connect(lg);
    for (const det of [-9, 0, 9]) { const o = osc('sawtooth', det); lg.connect(o.detune); }
    lfo.start(at); lfo.stop(at + dur + 0.8);
    env(ctx, g, at, level * 0.8, long ? 0.28 : 0.04, Math.max(0, dur - (long ? 0.35 : 0.08)), long ? 0.45 : 0.1);
  } else if (kind === 'brass') {
    osc('sawtooth', -4); osc('sawtooth', 4);
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(500, at); lp.frequency.linearRampToValueAtTime(Math.min(4000, hz * 8), at + 0.08);
    lp.frequency.setTargetAtTime(Math.min(2200, hz * 5), at + 0.1, 0.2);
    env(ctx, g, at, level, 0.05, Math.max(0, dur - 0.12), 0.15);
  } else if (kind === 'pluck') {
    lp.frequency.setValueAtTime(3200, at); lp.frequency.setTargetAtTime(900, at, 0.25);
    osc('sawtooth'); osc('triangle', 3);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(level, at + 0.004); g.gain.setTargetAtTime(0, at + 0.01, Math.min(0.5, dur * 0.7));
  } else if (kind === 'keys') {
    lp.frequency.value = 3000;
    osc('sine'); osc('triangle', 0, 2);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(level, at + 0.006); g.gain.setTargetAtTime(0, at + 0.02, Math.min(0.9, dur * 0.8 + 0.1));
  } else { // drone and bass
    lp.frequency.value = kind === 'drone' ? 500 : 900;
    osc(kind === 'drone' ? 'sawtooth' : 'triangle');
    if (kind === 'bass') osc('sine');
    env(ctx, g, at, level, kind === 'drone' ? 0.4 : 0.01, Math.max(0, dur - (kind === 'drone' ? 0.8 : 0.1)), kind === 'drone' ? 0.4 : 0.12);
  }
  for (const o of oscs) { o.connect(lp); o.start(at); o.stop(at + dur + 0.8); }
  lp.connect(g).connect(out);
}
function drum(ctx, out, kind, at, level) {
  const g = ctx.createGain();
  g.connect(out);
  if (kind === 'kick') {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(130, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.14);
    g.gain.setValueAtTime(level, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
    o.connect(g); o.start(at); o.stop(at + 0.32);
  } else {
    const n = noise(ctx), f = ctx.createBiquadFilter();
    f.type = kind === 'snare' ? 'bandpass' : 'highpass';
    f.frequency.value = kind === 'snare' ? 1800 : kind === 'crash' ? 4500 : 7000;
    const len = kind === 'snare' ? 0.16 : kind === 'crash' ? 1.4 : 0.04;
    g.gain.setValueAtTime(level, at); g.gain.exponentialRampToValueAtTime(0.001, at + len);
    n.connect(f).connect(g); n.start(at); n.stop(at + len + 0.02);
  }
}

// ----- shape of the backing -----
const REGISTER = { low: -12, mid: 0, high: 12 };
// Chord voicing. close: all tones within an octave around G3–F4, moving as little as possible;
// open: root low, the other tones spread over about two octaves; wide: root doubled in octaves,
// fifth and third high above — the big orchestral spread. Register moves the whole voicing.
function voice(c, T, prev) {
  const tones = c.tones || QUALITY[c.quality], root = pcOf(c.root + T), shift = REGISTER[S.register] || 0;
  const near = (pc, lo, hi, target) => {
    let best = null;
    for (let m = lo; m <= hi; m++) if (pcOf(m) === pc && (best == null || Math.abs(m - target) < Math.abs(best - target))) best = m;
    return best;
  };
  let v;
  if (S.spacing === 'close') {
    const pcs = tones.map(t => pcOf(root + t));
    let best = null;
    for (let base = 52; base <= 60; base++) {
      const cand = pcs.map(p => base + pcOf(p - base)).sort((a, b) => a - b);
      const cost = prev ? cand.reduce((s, m, i) => s + Math.abs(m - shift - (prev[i] ?? m)), 0) : Math.abs(cand[0] - 55);
      if (!best || cost < best.cost) best = { cand, cost };
    }
    v = best.cand;
  } else if (S.spacing === 'open') {
    const r0 = near(root, 45, 56, prev ? prev[0] - shift : 50);
    v = [r0, ...tones.filter(t => t).map(t => r0 + (t === 7 ? 7 : t < 12 ? t + 12 : t))];
  } else {
    const r0 = near(root, 40, 51, prev ? prev[0] - shift : 45);
    v = [r0, r0 + 12, r0 + 19, ...tones.filter(t => t && t !== 7).map(t => r0 + 24 + pcOf(t))];
  }
  return v.map(m => m + shift).filter(m => m >= 28 && m <= 88).sort((a, b) => a - b);
}
function playChordAt(sg) {
  const c = segChord(sg);
  if (!c) return;
  ensureCtx().then(ctx => voice(c, transpose()).forEach(m => orchestraOn()
    ? playSample(ctx, ctx.destination, m < 50 ? 'cellos' : m < 60 ? 'violas' : 'violins', m, ctx.currentTime + 0.02, 1, 0.6)
    : synthNote(ctx, ctx.destination, m, ctx.currentTime + 0.02, 0.8, S.sound, 0.05)));
}

// Hits within a bar (in beats) for the strum texture.
const STRUM = { 4: [0, 1, 1.5, 2.5, 3, 3.5], 3: [0, 1, 1.5, 2], 2: [0, 1, 1.5] };
// Drum and bass patterns per rhythm feel, in beats within a bar, by beats per bar.
const FEELS = {
  backbeat: { kick: { 4: [0, 2], 3: [0], 2: [0] }, snare: { 4: [1, 3], 3: [1, 2], 2: [1] }, hat: 'groove', bass: { 4: [0, 2], 3: [0], 2: [0] } },
  march: { kick: { 4: [0, 1, 2, 3], 3: [0, 1, 2], 2: [0, 1] }, snare: { 4: [1, 3, 3.5, 3.75], 3: [1, 2, 2.5], 2: [1, 1.5] }, hat: null, bass: 'alternate' },
  drive: { kick: { 4: [0, 1.5, 2], 3: [0, 1.5], 2: [0, 1.5] }, snare: { 4: [1, 3], 3: [2], 2: [1] }, hat: 'eighths', bass: 'eighths' },
  lilt: { kick: { 4: [0, 2], 3: [0], 2: [0] }, snare: { 4: [2], 3: [], 2: [] }, hat: 'swing', bass: { 4: [0, 2], 3: [0], 2: [0] } },
  mine: { kick: { 4: [], 3: [], 2: [] }, snare: { 4: [], 3: [], 2: [] }, hat: null, bass: { 4: [0, 2], 3: [0], 2: [0] } },
  sparse: { kick: { 4: [0], 3: [0], 2: [0] }, snare: { 4: [], 3: [], 2: [] }, hat: 'groove', bass: 'hold' },
  none: { kick: { 4: [], 3: [], 2: [] }, snare: { 4: [], 3: [], 2: [] }, hat: null, bass: 'hold' },
};

// The arranger's parts (arrange.js) for the current score, chords and transpose, cached on the
// plan. Registers follow the sung melody: bass under it, inner voices and counter-melody above.
function arrangement(plan, T) {
  const sc = S.take.score, r = sres();
  const sig = [T, S.energy, S.acc.motif, plan.sig, plan.segs.map(sg => sg.pick || 0).join('')].join('|');
  if (plan.arr && plan.arrSig === sig) return plan.arr;
  const melody = sc.notes.map(n => ({ midi: n.midi + T, start: n.qs / r, end: n.qe / r }));
  const lowest = Math.min(...melody.map(n => n.midi));
  const key = { ...sc.key, root: pcOf(sc.key.root + T) };
  const segs = plan.segs.map(sg => {
    const c = chordFor(plan, sg);
    return { start: sg.start, end: sg.end, chord: { ...c, root: pcOf(c.root + T), pcs: c.pcs.map(p => pcOf(p + T)) } };
  });
  const register = {
    bassLow: Math.max(28, lowest - 19), bassHigh: Math.max(40, lowest - 3),
    innerLow: Math.max(48, lowest + 5), innerHigh: Math.max(64, lowest + 22),
    counterLow: Math.max(57, lowest + 12), counterHigh: Math.max(76, lowest + 31),
  };
  plan.arr = arrange(melody, key, plan.meter, segs, {
    energy: S.energy, density: 0.5, register, motif: S.acc.motif && plan.motif ? plan.motif.intervals : undefined, form: plan.form || undefined,
  });
  plan.arrSig = sig;
  return plan.arr;
}

// Everything the backing plays between take times [from, to), as plain events: the same list
// is scheduled for sound and drawn on the roll, so what you see is what plays.
function backingEvents(from, to) {
  const plan = backingPlan();
  if (!plan) return [];
  const sc = S.take.score, key = sc.key, T = transpose(), r = sres(), b = spb();
  const { meter, groove } = plan, beats = meter.beats, feel = FEELS[S.feel] || FEELS.backbeat;
  const ev = [];
  const arr = S.writing === 'arranged' ? arrangement(plan, T) : null;
  const energyAt = t => arr ? arr.energyAt((t - sc.tempo.t0) / b) : 0.7;
  const inSpan = t => t >= from - 1e-6 && t < to - 1e-6;
  // bass and drone sit below the lowest sung note (at least a fourth under it, not below E1)
  const lowest = Math.min(...sc.notes.map(n => n.midi + T));
  const below = pc => { let m = lowest - 5; while (pcOf(m) !== pc) m--; return Math.max(m, 28 + pcOf(pc - 28)); };
  const barOf = beat => beat - ((((beat - meter.offset) % beats) + beats) % beats);
  if (S.acc.harmonics && sc.harm) for (const tr of sc.harm) {
    if (S.take.muted && S.take.muted.has(tr.k)) continue;
    for (const n of tr.notes) {
      const s = sStart(n), e = sEnd(n);
      if (inSpan(s)) ev.push({ kind: 'harm', k: tr.k, midi: n.midi + T, offset: n.offset, level: n.level, t: s, dur: Math.min(e, to) - s });
    }
  }
  if (S.acc.melody) for (const n of sc.notes) {
    const s = sStart(n), e = sEnd(n);
    if (inSpan(s)) ev.push({ kind: 'melody', n, t: s, dur: Math.min(e, to) - s, midi: n.midi + T });
  }
  if (S.acc.motif && plan.motif) {
    // the melody's motif reused as a line in the backing (motif.js works in grid steps)
    const m = plan.motif, unit = sc.unit, step = t => Math.round((t - sc.tempo.t0) / unit);
    const f = step(from), t2 = step(to), lowReg = Math.max(43, lowest - 3);
    const line = S.motifUse === 'echo' ? motifImitation(m, sc.notes, key, beats * r, -7).filter(e => e.qs >= f && e.qs < t2)
      : S.motifUse === 'sequence' ? motifSequence(m, key, f, t2, 1, 55)
      : S.motifUse === 'slow' ? motifAugment(m, key, f, t2, 2, lowReg)
      : S.motifUse === 'mirror' ? motifInvert(m, key, f, t2, 57)
      : motifOstinato(m, key, f, t2, lowReg);
    for (const e of line) {
      const t = sc.tempo.t0 + e.qs * unit;
      if (inSpan(t)) ev.push({ kind: 'motif', midi: e.midi + T, t, dur: (Math.min(e.qe, t2) - e.qs) * unit * 0.95, low: e.midi + T < 48 });
    }
  }
  if (S.acc.drone) {
    const tonic = below(pcOf(key.root + T));
    for (const m of [tonic, tonic + 7]) ev.push({ kind: 'drone', low: true, midi: m, t: from, dur: to - from });
  }
  let prev = null;
  for (const sg of plan.segs) {
    const s = beatTime(sg.start), e = beatTime(sg.end);
    if (e <= from + 1e-6 || s >= to - 1e-6) continue;
    const c = segChord(sg);
    if (!c) continue;
    const v = voice(c, T, prev);
    prev = v;
    const chordNote = (midi, t, dur, extra = {}) => { if (inSpan(t)) ev.push({ kind: 'chord', midi, t, dur, ...extra }); };
    if (S.acc.chords && v.length && !arr) {
      const tex = S.chordStyle;
      if (tex === 'pad') for (const m of v) chordNote(m, s, e - s);
      else if (tex === 'pulse') for (let p = sg.start; p < sg.end - 1e-6; p += 1) for (const m of v) chordNote(m, beatTime(p), b * 0.5);
      else if (tex === 'arp') {
        const seq = [...v, ...v.slice(1, -1).reverse()];
        let i = 0;
        for (let p = sg.start; p < sg.end - 1e-6; p += 0.5, i++) chordNote(seq[i % seq.length], beatTime(p), b * 0.48);
      } else if (tex === 'strum') {
        const hits = STRUM[beats] || STRUM[4];
        const ps = [];
        for (let p = sg.start; p < sg.end - 1e-6; p += 0.5) if (hits.some(h => Math.abs(p - barOf(p) - h) < 1e-6)) ps.push(p);
        ps.forEach((p, i) => {
          const len = beatTime(ps[i + 1] ?? sg.end) - beatTime(p), up = Math.abs((p - barOf(p)) % 1 - 0.5) < 1e-6;
          (up ? [...v].reverse() : v).forEach((m, j) => chordNote(m, beatTime(p) + j * 0.018, len * 0.95, { soft: up }));
        });
      } else if (tex === 'ostinato') {
        // a low repeating figure (root, octave, fifth, octave) under a quiet held chord
        const r0 = below(pcOf(c.root + T)) + 12, figure = [r0, r0 + 12, r0 + 7, r0 + 12];
        let i = 0;
        for (let p = sg.start; p < sg.end - 1e-6; p += 0.5, i++) chordNote(figure[i % 4], beatTime(p), b * 0.45, { low: true, figure: true });
        for (const m of v) chordNote(m, s, e - s, { soft: true });
      }
    }
    if (S.acc.bass && !arr) {
      const root = below(pcOf(c.root + T)), fifth = root + 7;
      const bass = (midi, p, len) => { const t = beatTime(p); if (inSpan(t) && p < sg.end - 1e-6) ev.push({ kind: 'bass', low: true, midi, t, dur: len }); };
      if (feel.bass === 'hold') bass(root, sg.start, e - s);
      else if (feel.bass === 'alternate') { let i = 0; for (let p = sg.start; p < sg.end - 1e-6; p += 1, i++) bass(i % 2 ? fifth : root, p, b * 0.8); }
      else if (feel.bass === 'eighths') for (let p = sg.start; p < sg.end - 1e-6; p += 0.5) bass(root, p, b * 0.42);
      else for (let p = sg.start; p < sg.end - 1e-6; p += 1) if ((feel.bass[beats] || [0]).includes(p - barOf(p))) bass(root, p, b * (beats === 4 ? 1.8 : beats * 0.9));
    }
  }
  if (arr) {
    // arranged writing: independent inner voices, a melodic bass and a counter-melody
    const put = (kind, e, extra = {}) => { const t = beatTime(e.start); if (inSpan(t)) ev.push({ kind, midi: e.midi, t, dur: Math.min(e.len * b, to - t), vel: e.vel, ...extra }); };
    if (S.acc.chords) for (const line of arr.inner) for (const e of line) put('chord', e);
    if (S.acc.bass) for (const e of arr.bass) put('bass', e, { low: true });
    if (S.acc.counter) for (const e of arr.counter) put('counter', e);
  }
  if (S.acc.rhythm && S.feel === 'mine' && S.groove && S.groove.length) {
    // your groove, laid on the score's bars at the score's tempo
    const g = S.groove, firstBar = plan.segs.length ? plan.segs[0].start : meter.offset;
    const lastBeat = (to - sc.tempo.t0) / b;
    const total = Math.ceil((lastBeat - firstBar) * g.steps) + 1;
    for (const e of patternEvents(g, 0, Math.max(0, total))) {
      const t = beatTime(firstBar + stepTime(g, e.step) * g.bpm / 60) + (e.nudge || 0) / 1000;
      if (inSpan(t)) ev.push({ kind: e.kind, t, soft: (e.vel ?? 0.8) < 0.6, vel: e.vel });
    }
  } else if (S.acc.rhythm) {
    const firstBar = plan.segs.length ? plan.segs[0].start : meter.offset;
    for (let bar = firstBar; beatTime(bar) < to - 1e-6; bar += beats) {
      const en = energyAt(beatTime(bar));
      for (const k of feel.kick[beats] || []) if (inSpan(beatTime(bar + k))) ev.push({ kind: 'kick', t: beatTime(bar + k), soft: S.feel === 'sparse' || en < 0.45 });
      if (en >= 0.3) for (const k of feel.snare[beats] || []) if (inSpan(beatTime(bar + k))) ev.push({ kind: 'snare', t: beatTime(bar + k), soft: k % 1 !== 0 || beats === 3 || S.feel === 'lilt' || en < 0.6 });
      if (en < 0.4) continue;
      const hats = feel.hat === 'groove' ? groove.hits.map(h => h / r)
        : feel.hat === 'eighths' ? [...Array(beats * 2).keys()].map(i => i / 2)
        : feel.hat === 'swing' ? [...Array(beats).keys()].flatMap(i => [i, i + 2 / 3]) : [];
      for (const h of hats) if (inSpan(beatTime(bar + h))) ev.push({ kind: 'hat', t: beatTime(bar + h), soft: S.feel === 'sparse' });
    }
  }
  return ev;
}

// ----- orchestra (sampler.js, VSCO 2 CE samples) -----
let orchestraReady = false, orchestraLoading = null;
function ensureOrchestra() {
  if (orchestraReady || typeof loadInstruments !== 'function') return Promise.resolve();
  if (!orchestraLoading) orchestraLoading = ensureCtx()
    .then(ctx => loadInstruments(ctx, [], (d, t) => { $('status').textContent = `Loading orchestra… ${d} of ${t} samples`; }))
    .then(() => { orchestraReady = true; $('status').textContent = 'Orchestra ready'; });
  return orchestraLoading;
}
const orchestraOn = () => S.sound === 'orchestra' && orchestraReady;
// Which instrument plays each backing part. Returns true when the part was played here.
function orchestral(ctx, out, e, at) {
  const v = Math.max(0.15, Math.min(1, e.vel ?? (e.soft ? 0.5 : 0.75)));
  const play = (name, midi, dur, vel = v) => playSample(ctx, out, name, midi, at, dur, vel);
  const march = S.feel === 'march', big = march || S.feel === 'drive';
  switch (e.kind) {
    case 'chord': {
      const tex = S.writing === 'arranged' ? 'voices' : S.chordStyle;
      if (tex === 'arp' || tex === 'strum') play('harp', e.midi, e.dur);
      else if (tex === 'pulse') march ? play(e.midi < 65 ? 'horn' : 'trumpet', e.midi, e.dur) : play(e.midi < 55 ? 'cellosPizz' : 'violinsPizz', e.midi, e.dur);
      else if (march && e.midi >= 41 && e.midi <= 70) play('horn', e.midi, e.dur, v * 0.85);
      else play(e.midi < 50 ? 'cellos' : e.midi < 60 ? 'violas' : 'violins', e.midi, e.dur, v * (e.soft ? 0.6 : 0.85));
      return true;
    }
    case 'counter': {
      const name = S.harmony === 'dark' ? 'oboe' : S.harmony === 'modal' ? 'clarinet' : 'flute';
      play(e.midi < 60 && name === 'flute' ? 'clarinet' : name, e.midi, e.dur);
      return true;
    }
    case 'bass':
      if (S.feel === 'lilt' || S.feel === 'sparse') play('cellosPizz', e.midi, e.dur);
      else play(e.midi <= 43 ? 'contrabass' : 'cellos', e.midi, e.dur);
      if (big && e.midi - 12 >= 28) play('contrabass', e.midi - 12, e.dur, v * 0.7);
      return true;
    case 'drone': play('contrabass', e.midi, e.dur, 0.45); play('cellos', e.midi + 12, e.dur, 0.35); return true;
    case 'motif': play(e.midi < 41 ? 'tuba' : 'horn', e.midi, e.dur); return true;
    case 'kick': {
      if (!big) return false;
      // timpani on the key's home note, in the drums' range
      let m = 41 + pcOf(S.take.score.key.root + transpose() - 41);
      play(e.soft ? 'timpani' : 'timpani', m, 0.8, e.soft ? 0.5 : 0.8);
      return true;
    }
  }
  return false;
}

// ---------- sections: bars grouped (A, B, …), each with its own mood and an optional fill at its end ----------
// A section's mood changes texture, sound, spacing, register, rhythm feel and drone for its bars;
// harmony colour and writing stay as set for the whole piece.
const SECTION_FIELDS = ['chordStyle', 'sound', 'spacing', 'register', 'feel'];
function sectionsOf() {
  const plan = backingPlan(), secs = S.take && S.take.sections;
  if (!plan || !secs || !secs.length || !plan.segs.length) return null;
  const beats = plan.meter.beats, first = plan.segs[0].start, endBeat = plan.segs[plan.segs.length - 1].end;
  const list = secs.slice().sort((a, b) => a.bar - b.bar);
  return list.map((s, i) => ({ ...s, from: first + s.bar * beats, to: i + 1 < list.length ? first + list[i + 1].bar * beats : endBeat }));
}
function withSection(sec, fn) {
  const m = sec && MOODS[sec.mood];
  if (!m) return fn();
  const saved = {}, drone = S.acc.drone;
  for (const k of SECTION_FIELDS) { saved[k] = S[k]; S[k] = m[k]; }
  S.acc.drone = m.drone;
  try { return fn(); } finally { Object.assign(S, saved); S.acc.drone = drone; }
}
// All backing events, section by section, with fills into the next section and a cymbal on its first beat.
function allEvents(from, to) {
  const secs = sectionsOf();
  if (!secs) return backingEvents(from, to);
  const out = [], b = spb();
  secs.forEach((sec, i) => {
    const a = Math.max(from, beatTime(sec.from)), z = Math.min(to, beatTime(sec.to));
    if (z > a) {
      let ev = withSection(sec, () => backingEvents(a, z));
      if (sec.fill && i < secs.length - 1 && S.acc.rhythm) {
        const fillAt = beatTime(sec.to - 1);
        if (fillAt >= a && fillAt < z) {
          ev = ev.filter(e => !(['kick', 'snare', 'hat'].includes(e.kind) && e.t >= fillAt - 1e-6));
          for (let k = 0; k < 4; k++) ev.push({ kind: 'snare', t: fillAt + k * b / 4, vel: 0.35 + 0.2 * k, soft: k < 2 });
          ev.push({ kind: 'kick', t: fillAt, soft: true });
        }
      }
      ev.forEach(e => { e.sec = i; });
      out.push(...ev);
    }
    const t = beatTime(sec.from);
    if (i > 0 && S.acc.rhythm && t >= from && t < to) out.push({ kind: 'crash', t, sec: i });
  });
  return out;
}
function nextSectionName(secs) {
  const used = new Set(secs.map(s => s.name));
  for (const c of 'ABCDEFGHIJKLMNOP') if (!used.has(c)) return c;
  return 'S' + (secs.length + 1);
}
function renderSections() {
  const box = $('sections');
  box.innerHTML = '';
  const plan = scoreView() && backingPlan();
  if (!plan) return;
  const secs = sectionsOf() || [];
  const beats = plan.meter.beats;
  secs.forEach((sec, i) => {
    const el = document.createElement('div');
    el.className = 'chip section';
    const bars = Math.round((sec.to - sec.from) / beats);
    el.innerHTML = `<b>${sec.name}</b><span>bar ${sec.bar + 1}${bars > 1 ? '–' + (sec.bar + bars) : ''} · ${sec.mood && MOODS[sec.mood] ? sec.mood : 'main mood'}${sec.fill && i < secs.length - 1 ? ' · fill' : ''}</span>`;
    el.onclick = () => openSectionMenu(sec.id, el);
    box.appendChild(el);
  });
  const add = document.createElement('button');
  add.className = 'small'; add.textContent = '+ Section at marker';
  add.title = 'Start a new section at the bar where the start marker is (click the roll to set it)';
  add.onclick = () => {
    if (S.cursor == null) { $('status').textContent = 'Click the roll where the new section should start, then + Section at marker'; return; }
    const first = plan.segs[0].start, bar = Math.max(0, Math.floor((beatAt(S.cursor) - first) / beats + 1e-6));
    const list = S.take.sections || (S.take.sections = []);
    if (!list.length) list.push({ id: 1, name: 'A', bar: 0, mood: '', fill: true });
    if (list.some(s => s.bar === bar)) return;
    list.push({ id: Date.now(), name: nextSectionName(list), bar, mood: '', fill: true });
    saveTake(); renderSections();
  };
  box.appendChild(add);
}
function openSectionMenu(id, anchor) {
  const list = S.take.sections, sec = list.find(s => s.id === id);
  if (!sec) return;
  const change = f => { f(); saveTake(); renderSections(); openSectionMenu(id, anchor); };
  openPopover(anchor, pop => {
    popRow(pop, 'Name', 'ABCDEFG'.split('').map(n => ({ text: n, on: sec.name === n, do: () => change(() => { sec.name = n; }) })));
    popRow(pop, 'Mood', [{ text: 'main', on: !sec.mood, title: 'Follow the main mood', do: () => change(() => { sec.mood = ''; }) }]
      .concat(Object.keys(MOODS).map(m => ({ text: m, on: sec.mood === m, do: () => change(() => { sec.mood = m; }) }))));
    popRow(pop, 'End', [{ text: sec.fill ? '✓ fill into next' : 'fill into next', on: sec.fill, do: () => change(() => { sec.fill = !sec.fill; }) }]);
    popRow(pop, '', [{ text: 'Remove section', disabled: sec.bar === 0 && list.length > 1, do: () => { S.take.sections = list.filter(s => s !== sec); if (S.take.sections.length === 1) S.take.sections = []; saveTake(); renderSections(); closePopover(); } }]);
  });
}

// Schedule backing (and the melody) for take time [from, to); tAt maps take time to audio time.
function scheduleBacking(ctx, out, tAt, from, to, events) {
  const lvl = Math.pow(+$('bvol').value, 1.5);
  let orch = null;
  if (orchestraReady) { orch = ctx.createGain(); orch.gain.value = 1.2 * lvl; orch.connect(out); }
  const secs = sectionsOf();
  for (const e of events || allEvents(from, to)) withSection(secs && e.sec != null ? secs[e.sec] : null, () => scheduleOne(e));
  function scheduleOne(e) {
    const at = tAt(e.t);
    if (orch && S.sound === 'orchestra' && orchestral(ctx, orch, e, at)) return;
    // orchestra samples not loaded (yet): strings stand in
    if (S.sound === 'orchestra') { S.sound = 'strings'; try { scheduleOne(e); } finally { S.sound = 'orchestra'; } return; }
    const chordLevel = { synth: 0.035, strings: 0.03, brass: 0.03, pluck: 0.07, keys: 0.06 }[S.sound] || 0.04;
    switch (e.kind) {
      case 'melody': playScoreNote(ctx, e.n, at, out, { s: e.t, e: e.t + e.dur }); break;
      case 'drone': synthNote(ctx, out, e.midi, at, e.dur, 'drone', 0.05 * lvl); break;
      case 'chord': synthNote(ctx, out, e.midi, at, e.dur, e.figure ? (S.sound === 'brass' ? 'brass' : 'strings') : S.sound,
        chordLevel * lvl * (e.soft ? 0.55 : 1) * (e.figure ? 2 : 1) * (e.vel != null ? 0.4 + 0.9 * e.vel : 1)); break;
      case 'bass': synthNote(ctx, out, e.midi, at, e.dur, 'bass', 0.16 * lvl * (e.vel != null ? 0.5 + 0.7 * e.vel : 1)); break;
      case 'counter': synthNote(ctx, out, e.midi, at, e.dur, S.sound === 'pluck' || S.sound === 'keys' ? 'keys' : 'strings', 0.075 * lvl * (0.5 + 0.7 * e.vel)); break;
      case 'motif': synthNote(ctx, out, e.midi, at, e.dur, e.low ? (S.sound === 'brass' ? 'brass' : 'strings') : (S.sound === 'synth' ? 'keys' : S.sound), 0.07 * lvl); break;
      case 'harm': {
        const o = ctx.createOscillator(), g = ctx.createGain(), peak = 0.2 * Math.pow(10, e.level / 20);
        o.frequency.value = midiToHz(e.midi + e.offset);
        env(ctx, g, at, peak, 0.02, Math.max(0, e.dur - 0.06), 0.04);
        o.connect(g).connect(out); o.start(at); o.stop(at + e.dur + 0.1);
        break;
      }
      case 'kick': drum(ctx, out, 'kick', at, (e.soft ? 0.3 : 0.5) * lvl); break;
      case 'snare': drum(ctx, out, 'snare', at, (e.soft ? 0.1 : 0.22) * lvl); break;
      case 'hat': drum(ctx, out, 'hat', at, (e.soft ? 0.07 : 0.12) * lvl); break;
      case 'crash': drum(ctx, out, 'crash', at, 0.12 * lvl); break;
    }
  }
}

// ----- moods: saved combinations of the shape controls, a starting point to adjust from -----
const MOODS = {
  lofi: { harmony: 'plain', chordRate: '1', chordStyle: 'pad', sound: 'synth', spacing: 'close', register: 'mid', feel: 'backbeat', drone: true, writing: 'blocks', energy: 'flat' },
  heroic: { harmony: 'lift', chordRate: '1', chordStyle: 'pulse', sound: 'orchestra', spacing: 'wide', register: 'mid', feel: 'march', drone: true, writing: 'arranged', energy: 'build' },
  dramatic: { harmony: 'dark', chordRate: '2', chordStyle: 'ostinato', sound: 'orchestra', spacing: 'wide', register: 'mid', feel: 'drive', drone: false, writing: 'arranged', energy: 'arc' },
  folk: { harmony: 'modal', chordRate: '0.5', chordStyle: 'strum', sound: 'orchestra', spacing: 'open', register: 'mid', feel: 'lilt', drone: true, writing: 'arranged', energy: 'arc' },
  light: { harmony: 'rich', chordRate: '1', chordStyle: 'arp', sound: 'orchestra', spacing: 'close', register: 'high', feel: 'sparse', drone: false, writing: 'arranged', energy: 'flat' },
  sad: { harmony: 'dark', chordRate: '0.5', chordStyle: 'pad', sound: 'orchestra', spacing: 'open', register: 'mid', feel: 'none', drone: false, writing: 'arranged', energy: 'arc' },
};
const SHAPE_SEGS = ['harmony', 'chordRate', 'chordStyle', 'sound', 'spacing', 'register', 'feel', 'writing', 'energy', 'formAware'];
let applyingMood = false;
function applyMood(name) {
  const m = MOODS[name];
  if (!m) return;
  applyingMood = true;
  for (const k of SHAPE_SEGS) setSeg(k, m[k]);
  S.acc.drone = m.drone;
  for (const b of $('accToggles').children) b.classList.toggle('on', !!S.acc[b.dataset.acc]);
  applyingMood = false;
  $('moodSel').value = name;
  saveSettings(); renderChords();
  if (S.sound === 'orchestra') ensureOrchestra();
}
$('moodSel').addEventListener('change', () => applyMood($('moodSel').value));
for (const k of SHAPE_SEGS) {
  const prevHandler = segHandlers[k];
  segHandlers[k] = () => {
    if (!applyingMood) $('moodSel').value = 'custom';
    if (S.sound === 'orchestra') ensureOrchestra();
    prevHandler && prevHandler();
    renderChords();
  };
}

// Whole bars covering the score: the span the backing plays and the Jam loop repeats.
function backingSpan() {
  const plan = backingPlan();
  if (!plan || !plan.segs.length) return null;
  return { from: beatTime(plan.segs[0].start), to: beatTime(plan.segs[plan.segs.length - 1].end) };
}

// ---------- your voice profile (from the Voice lab: takes/voice-profile.json) ----------
// Sounds the profile does not have are greyed out; without a profile the profile options say so.
async function loadProfile() {
  try {
    const r = HOSTED ? null : await fetch('takes/voice-profile.json', { cache: 'no-store' });
    S.profile = r && r.ok ? await r.json() : null;
  } catch { S.profile = null; }
  const has = S.profile && S.profile.sounds ? Object.keys(S.profile.sounds) : [];
  for (const o of $('voiceSound').options) o.disabled = S.profile ? !has.includes(o.value) : false;
  if (S.profile && !has.includes($('voiceSound').value) && has.length) $('voiceSound').value = has.find(s => !s.includes('>')) || has[0];
  const tip = S.profile ? '' : 'Record a session in the Voice lab first';
  document.querySelector('[data-key="lineEngine"] [data-v="profile"]').title = tip || 'Your measured voice from the Voice lab';
  $('melSound').querySelector('option[value="profile"]').disabled = !S.profile;
}
loadProfile();
addEventListener('focus', loadProfile);
const profileReady = () => !!(S.profile && typeof renderVowel === 'function' && S.profile.sounds && S.profile.sounds[$('voiceSound').value]);
$('voiceSound').addEventListener('change', () => { if (S.take) S.take.lineRender = null; profileNotes.clear(); });
// one score note in the profile voice, rendered once and cached
const profileNotes = new Map();
function profileNoteBuffer(ctx, midi, dur) {
  const key = [$('voiceSound').value, Math.round(midi * 4) / 4, Math.round(dur * 20) / 20].join('|');
  if (!profileNotes.has(key)) {
    const x = renderVowel(S.profile, { sound: $('voiceSound').value, midi, dur, loud: 0.6, vibrato: 0.4, engine: 'envelope', sr: ctx.sampleRate, seed: 1 });
    let pk = 0;
    for (const v of x) pk = Math.max(pk, Math.abs(v));
    if (pk > 1e-6) for (let i = 0; i < x.length; i++) x[i] *= 0.3 / pk;   // every note at a steady level
    const buf = ctx.createBuffer(1, x.length, ctx.sampleRate);
    buf.copyToChannel(x, 0);
    profileNotes.set(key, buf);
  }
  return profileNotes.get(key);
}

// ---------- sung line: your own pitch curve playing the voice synth, shaped by five knobs ----------
// Smooth evens out wobble, Tune pulls the line onto the transcribed notes, Vibrato adds an even
// singer's vibrato to held notes, Even loudness irons out volume bumps, Glide bridges short breaks.
const lineOpts = () => ({
  smooth: +$('lineSmooth').value, tune: +$('lineTune').value, vib: +$('lineVib').value,
  even: +$('lineEven').value, glide: +$('lineGlide').value,
});
function sungLine() {
  const tk = S.take, o = lineOpts(), T = transpose();
  if (!tk || !tk.points || !tk.points.length) return null;
  const sig = JSON.stringify(o) + '|' + T + '|' + tk.notes.length + '|' + tk.start + '|' + (tk.score ? tk.score.notes.length + ':' + (tk.score.tempo && tk.score.tempo.bpm) : '');
  if (tk.line && tk.lineSig === sig) return tk.line;
  const hop = 0.01, t0 = tk.start, n = Math.max(2, Math.ceil((tk.end - t0) / hop) + 1), pts = tk.points;
  const m = new Float32Array(n).fill(NaN), a = new Float32Array(n), mx = tk.ampMax || 0.05;
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * hop;
    while (j + 1 < pts.length && pts[j + 1].t <= t) j++;
    const p = pts[j];
    if (!p || Math.abs(p.t - t) > 0.02) continue;
    m[k] = p.m; a[k] = isNaN(p.m) ? 0 : Math.min(1.5, p.r / mx);
  }
  // Glide: bridge breaks up to ~0.25 s by sliding from one note to the next
  const maxGap = Math.round(o.glide * 0.25 / hop);
  for (let k = 0; k < n; k++) {
    if (!isNaN(m[k]) || k === 0 || isNaN(m[k - 1])) continue;
    let e = k;
    while (e < n && isNaN(m[e])) e++;
    if (e < n && e - k <= maxGap) {
      for (let i = k; i < e; i++) {
        const f = (i - k + 1) / (e - k + 1);
        m[i] = m[k - 1] + (m[e] - m[k - 1]) * f; a[i] = Math.min(a[k - 1], a[e]) * 0.7;
      }
    }
    k = e;
  }
  // Toward score, pitch: pull towards the score's note under each moment (or the as-sung note
  // when there is no score); slides between notes are left alone
  const target = tk.score && tk.score.notes.length ? tk.score.notes : tk.notes;
  if (o.tune > 0 && target.length) {
    let ni = 0, cs = 0;
    const alpha = 1 - Math.exp(-hop / (0.02 + (1 - o.tune) * 0.15));
    for (let k = 0; k < n; k++) {
      const t = t0 + k * hop;
      while (ni < target.length && target[ni].end < t) ni++;
      const note = target[ni] && target[ni].start <= t ? target[ni] : null;
      const c = note && !isNaN(m[k]) && !note.glide ? note.midi - m[k] : 0;
      cs += (c - cs) * alpha;
      if (!isNaN(m[k])) m[k] += o.tune * cs;
    }
  }
  // the continuous sung phrases
  const runs = [];
  for (let k = 0; k < n; k++) {
    if (isNaN(m[k])) continue;
    let e = k;
    while (e + 1 < n && !isNaN(m[e + 1])) e++;
    if (e - k >= 3) runs.push([k, e]);
    k = e;
  }
  // Smooth: zero-phase smoothing of the pitch inside each phrase
  if (o.smooth > 0) {
    const al = 1 - Math.exp(-hop / (o.smooth * 0.2));
    for (const [s, e] of runs) {
      for (let k = s + 1; k <= e; k++) m[k] = m[k - 1] + (m[k] - m[k - 1]) * al;
      for (let k = e - 1; k >= s; k--) m[k] = m[k + 1] + (m[k] - m[k + 1]) * al;
    }
  }
  // Vibrato: on notes held longer than 0.4 s, eased in after 0.2 s
  if (o.vib > 0) for (const note of tk.notes) {
    if (note.end - note.start < 0.4) continue;
    const k0 = Math.round((note.start - t0) / hop), k1 = Math.round((note.end - t0) / hop);
    for (let k = Math.max(0, k0); k <= Math.min(n - 1, k1); k++) {
      if (isNaN(m[k])) continue;
      const tt = (k - k0) * hop, ease = Math.max(0, Math.min(1, (tt - 0.2) / 0.3));
      m[k] += ease * o.vib * 0.5 * Math.sin(2 * Math.PI * 5.4 * tt);
    }
  }
  // Even loudness: compress, then soften the edges
  for (let k = 0; k < n; k++) a[k] = Math.pow(a[k], 1 - 0.75 * o.even);
  const aal = 1 - Math.exp(-hop / 0.03);
  for (let k = 1; k < n; k++) a[k] = a[k - 1] + (a[k] - a[k - 1]) * aal;
  for (let k = 0; k < n; k++) if (!isNaN(m[k])) m[k] += T;
  // Toward score, timing: slide each moment towards where the score puts it (note starts move
  // onto their beats, everything between follows), then lay the line back on an even 10 ms grid
  const sc = tk.score;
  if (o.tune > 0 && sc && sc.tempo && sc.notes.length > 1) {
    const anchors = sc.notes.map(nt => [nt.start, sStart(nt)]);
    const warp = t => {
      if (t <= anchors[0][0]) return t + (anchors[0][1] - anchors[0][0]);
      for (let i = 1; i < anchors.length; i++) if (t <= anchors[i][0]) {
        const [a0, b0] = anchors[i - 1], [a1, b1] = anchors[i];
        return b0 + (b1 - b0) * (t - a0) / Math.max(1e-6, a1 - a0);
      }
      const [aL, bL] = anchors[anchors.length - 1];
      return t + (bL - aL);
    };
    const u = new Float64Array(n);
    for (let k = 0; k < n; k++) { const t = t0 + k * hop; u[k] = t + o.tune * (warp(t) - t); }
    for (let k = 1; k < n; k++) if (u[k] < u[k - 1]) u[k] = u[k - 1];
    const u0 = u[0], n2 = Math.max(2, Math.ceil((u[n - 1] - u0) / hop) + 1);
    const m2 = new Float32Array(n2).fill(NaN), a2 = new Float32Array(n2);
    let j = 0;
    for (let q = 0; q < n2; q++) {
      const uq = u0 + q * hop;
      while (j + 1 < n && u[j + 1] < uq) j++;
      const j2 = Math.min(n - 1, j + 1), f = u[j2] > u[j] ? (uq - u[j]) / (u[j2] - u[j]) : 0;
      if (isNaN(m[j]) || isNaN(m[j2])) { m2[q] = f < 0.5 ? m[j] : m[j2]; a2[q] = f < 0.5 ? a[j] : a[j2]; }
      else { m2[q] = m[j] + (m[j2] - m[j]) * f; a2[q] = a[j] + (a[j2] - a[j]) * f; }
    }
    const runs2 = [];
    for (let q = 0; q < n2; q++) {
      if (isNaN(m2[q])) continue;
      let e = q;
      while (e + 1 < n2 && !isNaN(m2[e + 1])) e++;
      if (e - q >= 3) runs2.push([q, e]);
      q = e;
    }
    tk.line = { t0: u0, hop, m: m2, a: a2, runs: runs2 };
    tk.lineSig = sig;
    return tk.line;
  }
  tk.line = { t0, hop, m, a, runs };
  tk.lineSig = sig;
  return tk.line;
}
// Natural voice: the whole line rendered by voicesynth.js (source-filter, your vowel colour
// every 10 ms, glottal pulses, breath), cached until the line or the take changes.
function renderedLine(ctx) {
  const tk = S.take, L = sungLine();
  if (!L) return null;
  if (S.lineEngine === 'profile' && profileReady()) {
    const key = 'profile|' + $('voiceSound').value;
    if (!tk.lineRender || tk.lineRender.L !== L || tk.lineRender.key !== key) {
      try {
        const { samples, sr } = renderLineWithProfile(L, S.profile, { sound: $('voiceSound').value, engine: 'envelope', sr: ctx.sampleRate });
        const buf = ctx.createBuffer(1, samples.length, sr);
        buf.copyToChannel(samples, 0);
        tk.lineRender = { L, buf, key };
      } catch (err) { $('status').textContent = 'Profile voice failed: ' + err.message; return null; }
    }
    return { buf: tk.lineRender.buf, t0: L.t0 };
  }
  if (!tk.frames || typeof renderLine !== 'function') return null;
  if (!tk.lineRender || tk.lineRender.L !== L || tk.lineRender.key) {
    const { samples, sr } = renderLine(L, tk.frames, tk.voice.sr, { breath: 0.3 });
    const buf = ctx.createBuffer(1, samples.length, sr);
    buf.copyToChannel(samples, 0);
    tk.lineRender = { L, buf };
  }
  return { buf: tk.lineRender.buf, t0: L.t0 };
}
function scheduleSungLine(ctx, out, at, from, to) {
  if (S.lineEngine === 'natural' || S.lineEngine === 'profile') {
    const r = renderedLine(ctx);
    if (r) {
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = r.buf; g.gain.value = 1.6;
      src.connect(g).connect(out);
      const off = from - r.t0;
      off >= 0 ? src.start(at, off, to - from) : src.start(at - off, 0, to - from + off);
      return;
    }
  }
  const L = sungLine(), env = S.take.env;
  if (!L) return;
  for (const [s, e] of L.runs) {
    const ts = L.t0 + s * L.hop, te = L.t0 + e * L.hop;
    if (te <= from || ts >= to) continue;
    const k0 = Math.max(s, Math.ceil((from - L.t0) / L.hop)), k1 = Math.min(e, Math.floor((to - L.t0) / L.hop));
    if (k1 - k0 < 3) continue;
    const freqs = new Float32Array(k1 - k0 + 1), gains = new Float32Array(k1 - k0 + 1);
    for (let k = k0; k <= k1; k++) { freqs[k - k0] = midiToHz(L.m[k]); gains[k - k0] = 0.3 * L.a[k]; }
    gains[0] = 0; gains[gains.length - 1] = 0;
    const start = at + (L.t0 + k0 * L.hop - from), dur = (k1 - k0) * L.hop;
    const mid = median(Array.from(L.m.slice(k0, k1 + 1)));
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    if (env) o.setPeriodicWave(waveFor(ctx, voiceHarm(env, mid))); else o.type = 'triangle';
    lp.type = 'lowpass'; lp.frequency.value = 9000;
    o.frequency.setValueCurveAtTime(freqs, start, dur);
    g.gain.setValueAtTime(0, start); g.gain.setValueCurveAtTime(gains, start, dur);
    o.connect(lp).connect(g).connect(out); o.start(start); o.stop(start + dur + 0.05);
    // breath under the line
    const br = noise(ctx), bp = ctx.createBiquadFilter(), bg = ctx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = Math.min(3000, midiToHz(mid) * 6); bp.Q.value = 0.8;
    bg.gain.setValueAtTime(0, start); bg.gain.setValueCurveAtTime(gains.map(v => v * 0.12), start, dur);
    br.connect(bp).connect(bg).connect(out); br.start(start); br.stop(start + dur + 0.05);
  }
}

// ---------- main transport: Play (with Loop) plays what Hear says, from the start marker ----------
// Score view plays whole bars of the score; the start marker (click the roll) moves the start.
function playRegion() {
  const tk = S.take, span = scoreView() && backingSpan();
  let a = span ? span.from : tk.start;
  let b = span ? span.to : tk.end;
  for (const L of tk.layers || []) if (!L.muted) b = Math.max(b, L.end);
  if (S.cursor != null && S.cursor > a && S.cursor < b - 0.2) a = S.cursor;
  return { a, b };
}
function scheduleRegion(ctx, bus, at, a, b) {
  const tk = S.take, hear = S.hear;
  if ((hear === 'voice' || hear === 'both') && tk.voice) {
    if (!tk.playBuf || tk.playBufSrc !== tk.rendered) {
      const data = playableVoice();
      tk.playBuf = ctx.createBuffer(1, data.length, tk.voice.sr); tk.playBuf.copyToChannel(data, 0); tk.playBufSrc = tk.rendered;
    }
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = tk.playBuf; g.gain.value = hear === 'both' ? 0.8 : 1;
    src.connect(g).connect(bus);
    const off = a - tk.voice.t0;
    off >= 0 ? src.start(at, off, b - a) : src.start(at - off, 0, b - a + off);
  }
  if (hear === 'line') scheduleSungLine(ctx, bus, at, a, b);
  if (hear === 'score' || hear === 'both') {
    if (scoreView()) scheduleBacking(ctx, bus, t => at + (t - a), a, b);
    else for (const n of tk.notes) if (n.start >= a && n.start < b) tone(ctx, n, at + (n.start - a), 1, bus);
  }
  scheduleLayers(ctx, bus, at, a, b);
}
async function startMain(btn) {
  const ctx = await ensureCtx();
  if (S.layer === 'groove') {
    const bus = ctx.createGain(); bus.connect(ctx.destination);
    S.play = { t0: ctx.currentTime + 0.05, bus, btn, groove: true };
    grooveClock.start(ctx, bus, S.play.t0);
    if (!S.loop) S.play.timer = setTimeout(stopPlay, stepTime(S.groove, S.groove.length) * 2000 + 300);
    btn.dataset.label = btn.textContent;
    btn.textContent = '■ Stop'; btn.classList.add('on');
    return;
  }
  await prepareSounds();
  const { a, b } = playRegion(), len = Math.max(0.2, b - a);
  // looping the score keeps the mic on, so you can hum along and see how you sit on the chords
  if (S.loop && S.hear !== 'voice' && scoreView() && !S.listening) { try { await startMic(); } catch {} }
  const bus = ctx.createGain(); bus.connect(ctx.destination);
  const play = { t0: ctx.currentTime + 0.1, bus, btn, region: { from: a, len }, loop: S.loop };
  S.play = play;
  const iterate = at => {
    if (S.play !== play) return;
    scheduleRegion(ctx, bus, at, a, b);
    play.timer = play.loop
      ? setTimeout(() => iterate(at + len), Math.max(0, (at + len - ctx.currentTime - 0.35) * 1000))
      : setTimeout(stopPlay, Math.max(0, (at + len - ctx.currentTime + 0.6) * 1000));
  };
  btn.dataset.label = btn.textContent;
  btn.textContent = '■ Stop'; btn.classList.add('on');
  S.view.mode = 'take';
  iterate(play.t0);
}
$('playMain').onclick = () => {
  const same = S.play && S.play.btn === $('playMain');
  if (S.play) stopPlay();
  if (!same) startMain($('playMain'));
};
$('loopBtn').onclick = () => {
  S.loop = !S.loop; $('loopBtn').classList.toggle('on', S.loop); saveSettings();
  if (S.play && S.play.btn === $('playMain')) { stopPlay(); startMain($('playMain')); }
};
$('melSound').addEventListener('change', () => { if (!['voice', 'plain', 'profile'].includes($('melSound').value)) ensureOrchestra(); });
for (const id of ['keySel', 'tuningSel', 'sres', 'sdetail']) $(id).addEventListener('change', () => retranscribeSoon());
function setTranspose(v) {
  $('transpose').value = Math.max(-36, Math.min(36, v));
  saveSettings(); renderNotes(); updateScoreInfo();
}
$('transpose').addEventListener('change', () => setTranspose(transpose()));
$('tUp').onclick = () => setTranspose(transpose() + 1);
$('tDown').onclick = () => setTranspose(transpose() - 1);
$('tUp8').onclick = () => setTranspose(transpose() + 12);
$('tDown8').onclick = () => setTranspose(transpose() - 12);

// ---------- partials: the separate tones inside the voice ----------
const partialsOn = () => S.partials === 'on';
function updatePartials() {
  const tk = S.take;
  if (!tk || !tk.frames) return;
  tk.pt = partialTracks(tk.frames, +$('prange').value);
  if (tk.tempo) for (const tr of tk.pt.tracks) quantize(tr.notes, tk.tempo, res());
  tk.muted = tk.muted || new Set();
  if (tk.score) tk.score.harm = scoreHarmonics(tk);
  renderPartials();
}

// Harmonics written against the clean score: for each kept harmonic, a note under every score
// note it sounds in, at the score pitch plus the harmonic's interval (its natural tuning shown
// as cents, e.g. H5 is 14 cents flat of an equal-tempered third), with its measured level.
function scoreHarmonics(tk) {
  const sc = tk.score, range = +$('prange').value;
  if (!sc || !tk.pt || !tk.frames) return [];
  return tk.pt.tracks.filter(tr => tr.k > 1).map(tr => {
    const semis = 12 * Math.log2(tr.k), up = Math.round(semis), notes = [];
    for (const n of sc.notes) {
      if (n.added) continue;
      const a = n.src ? n.src.start : n.start, b = n.src ? n.src.end : n.end;
      const fs = tk.frames.filter(f => f.f0 && f.t >= a && f.t <= b);
      const on = fs.filter(f => f.h[tr.k - 1] >= f.top - range);
      if (!fs.length || on.length < fs.length * 0.4) continue;
      const level = 10 * Math.log10(on.reduce((s, f) => s + Math.pow(10, f.h[tr.k - 1] / 10), 0) / on.length) - tk.pt.top;
      notes.push({ start: n.start, end: n.end, qs: n.qs, qe: n.qe, midi: n.midi + up, offset: semis - up, level });
    }
    return { k: tr.k, level: tr.level, notes };
  }).filter(tr => tr.notes.length);
}
const centsText = n => Math.abs(n.offset) >= 0.03 ? (n.offset > 0 ? '+' : '') + Math.round(n.offset * 100) + '¢' : '';
// One row per kept harmonic: its label (click to mute), then its own transcribed notes.
S.harmOpen = (() => { try { return localStorage.getItem('hum-harm') === '1'; } catch { return false; } })();
function renderPartials() {
  const box = $('ptracks');
  box.innerHTML = '';
  fillPartials(box);
  // the rows are many and specialised: folded behind one button
  const row = $('harmRow'), n = box.children.length;
  row.innerHTML = '';
  box.hidden = !S.harmOpen;
  if (!n) return;
  const b = document.createElement('button');
  b.className = 'small led' + (S.harmOpen ? ' on' : ''); b.textContent = `Harmonics (${n})`;
  b.title = 'Show or hide the harmonic lines: the separate tones inside your voice, each written out as notes';
  b.onclick = () => { S.harmOpen = !S.harmOpen; try { localStorage.setItem('hum-harm', S.harmOpen ? '1' : '0'); } catch {} renderPartials(); };
  row.appendChild(b);
}
function fillPartials(box) {
  const tk = S.take;
  if (scoreView()) { renderScoreHarmonics(box); return; }
  if (!partialsOn() || !tk || !tk.pt) return;
  for (const tr of tk.pt.tracks) {
    if (tr.k === 1) continue;
    const row = document.createElement('div');
    row.className = 'prow' + (tk.muted.has(tr.k) ? ' muted' : '');
    const head = document.createElement('div');
    head.className = 'chip partial';
    head.innerHTML = `<b>H${tr.k}</b><em>${harmonicLabel(tr.k)}</em><span>${tr.level.toFixed(0)} dB</span>`;
    head.onclick = () => { tk.muted.has(tr.k) ? tk.muted.delete(tr.k) : tk.muted.add(tr.k); renderPartials(); };
    row.appendChild(head);
    for (const n of tr.notes) {
      const el = document.createElement('div');
      el.className = 'chip';
      el.innerHTML = `<b>${noteName(n.midi)}</b>${centsText(n) ? `<em>${centsText(n)}</em>` : ''}<span>${lengthText(n)}</span>`;
      el.title = n.level.toFixed(0) + ' dB';
      el.onclick = async () => { const ctx = await ensureCtx(); tone(ctx, { ...n, curve: null, amp: null, harm: null }, ctx.currentTime + 0.02, 1, ctx.destination); };
      row.appendChild(el);
    }
    box.appendChild(row);
  }
}
function renderScoreHarmonics(box) {
  const tk = S.take, rows = tk.score.harm || [], T = transpose(), key = scoreKey();
  for (const tr of rows) {
    const row = document.createElement('div');
    row.className = 'prow' + (tk.muted.has(tr.k) ? ' muted' : '');
    const head = document.createElement('div');
    head.className = 'chip partial';
    head.innerHTML = `<b>H${tr.k}</b><em>${harmonicLabel(tr.k)}</em><span>${tr.level.toFixed(0)} dB</span>`;
    head.title = 'Click to mute or unmute this harmonic';
    head.onclick = () => { tk.muted.has(tr.k) ? tk.muted.delete(tr.k) : tk.muted.add(tr.k); renderPartials(); };
    row.appendChild(head);
    for (const n of tr.notes) {
      const el = document.createElement('div');
      el.className = 'chip';
      el.innerHTML = `<b>${spell(n.midi + T, key)}</b>${centsText(n) ? `<em>${centsText(n)}</em>` : ''}<span>${scoreLen(n)}</span>`;
      el.title = n.level.toFixed(0) + ' dB';
      el.onclick = async () => { const ctx = await ensureCtx(); tone(ctx, { ...n, midi: n.midi + T, curve: null, amp: null, harm: null }, ctx.currentTime + 0.02, 1, ctx.destination); };
      row.appendChild(el);
    }
    box.appendChild(row);
  }
}
const liveTracks = () => S.take && S.take.pt ? S.take.pt.tracks.filter(tr => !S.take.muted.has(tr.k)) : [];
let ptTimer = 0;
$('prange').addEventListener('input', () => { clearTimeout(ptTimer); ptTimer = setTimeout(updatePartials, 60); });
segHandlers.partials = renderPartials;
let reTimer = 0;
const retranscribeSoon = () => { clearTimeout(reTimer); reTimer = setTimeout(retranscribe, 60); };
segHandlers.snap = retranscribeSoon;
segHandlers.rhythm = () => { renderNotes(); renderPartials(); };
$('detail').oninput = retranscribeSoon;
$('res').onchange = retranscribeSoon;
$('root').addEventListener('change', () => S.snap !== 'chrom' && retranscribeSoon());
$('half').onclick = () => { if (S.take && S.take.tempo) { S.take.tempoScale /= 2; retranscribe(); saveTake(); } };
$('dbl').onclick = () => { if (S.take && S.take.tempo) { S.take.tempoScale *= 2; retranscribe(); saveTake(); } };
$('tune').oninput = $('speed').oninput = () => { if (S.take) S.take.rendered = S.take.tune = null; };

function updateTempo() {
  const t = S.take && S.take.tempo;
  $('tempo').innerHTML = t ? `${Math.round(t.bpm)} bpm <small>${t.source}</small>` : '';
  $('half').disabled = $('dbl').disabled = !t;
}

function updateButtons() {
  const has = !!(S.take && S.take.notes && S.take.notes.length && !S.recording);
  $('play').disabled = !(S.take && S.take.points && !S.recording);
  $('playMain').disabled = !(S.layer === 'groove' ? S.groove : S.take && S.take.points) || S.recording;
  $('copy').disabled = !has; $('midi').disabled = !has;
  $('wav').disabled = !(S.take && S.take.voice && !S.recording);
  $('clear').disabled = !S.take;
  $('save').disabled = !(S.take && S.take.voice && !S.recording);
  $('save').textContent = S.take && S.take.savedAs ? '✓ Saved' : 'Save';
  $('undoRec').disabled = !S.history.length || S.recording;
  $('undoRec').title = S.history.length ? 'Back to ' + S.history[S.history.length - 1].label : 'Nothing to undo yet';
  updateRecButton();
}

const gridOn = () => S.rhythm === 'grid' && S.take && S.take.tempo && (!S.recording || armed());
const qTime = (n, which) => S.take.tempo.t0 + (which === 'e' ? n.qe : n.qs) * S.take.unit;
const noteStart = n => gridOn() ? qTime(n, 's') : n.start;
const noteEnd = n => gridOn() ? qTime(n, 'e') : n.end;

function tags(n) {
  let s = '';
  if (n.offset) s += (n.offset > 0 ? '+' : '') + Math.round(n.offset * 100) + '¢';
  if (n.glide) s += n.glide > 0 ? '↗' : '↘';
  if (n.vib) s += '∿';
  if (!n.offset && !n.glide && !n.vib && n.bend) s += '≈';
  return s;
}
const lengthText = n => gridOn() ? valueName(n.qe - n.qs, res()) : (n.end - n.start).toFixed(2) + 's';

function renderNotes() {
  const box = $('notes');
  box.innerHTML = '';
  if (!S.take) return;
  if (scoreView()) { renderScore(); return; }
  for (const n of S.take.notes) {
    const el = document.createElement('div');
    el.className = 'chip';
    const tg = tags(n);
    el.innerHTML = `<b>${noteName(n.midi)}</b>${tg ? `<em>${tg}</em>` : ''}<span>${lengthText(n)}</span>`;
    if (n.center != null) el.title = 'sung ' + ((n.center - n.midi) * 100 >= 0 ? '+' : '') + Math.round((n.center - n.midi) * 100) + '¢';
    el.onclick = async () => { S.harmShow = { n, until: performance.now() + 3000 }; const ctx = await ensureCtx(); tone(ctx, n, ctx.currentTime + 0.02, 1, ctx.destination); };
    box.appendChild(el);
  }
}

// ---------- playback ----------
// The synth note: your voice's harmonic mix (or a plain triangle), and the sung pitch
// curve and loudness blended in by Flourish. Detected flourishes always play in full.
const waves = new WeakMap();
function waveFor(ctx, harm) {
  if (!waves.has(harm)) {
    const imag = new Float32Array(harm.length + 1);
    imag.set(harm, 1);
    waves.set(harm, ctx.createPeriodicWave(new Float32Array(harm.length + 1), imag));
  }
  return waves.get(harm);
}
const voiceWaves = new WeakMap();
// Harmonic mix for a note played through a voice envelope, cached per envelope and semitone.
function voiceHarm(env, midi) {
  if (!voiceWaves.has(env)) voiceWaves.set(env, new Map());
  const cache = voiceWaves.get(env), key = Math.round(midi);
  if (!cache.has(key)) cache.set(key, Float32Array.from(voiceHarmonics(env, midiToHz(key))));
  return cache.get(key);
}
function tone(ctx, n, t, stretch, out, expr, sound) {
  const dur = (n.end - n.start) * stretch, fl = expr ?? +$('flourish').value;
  const o = ctx.createOscillator(), g = ctx.createGain(), dyn = ctx.createGain(), lp = ctx.createBiquadFilter();
  const mel = sound || $('melSound').value, env = mel === 'voice' && (n.env || (S.take && S.take.env));
  const harm = env ? voiceHarm(env, n.midi + (n.offset || 0)) : mel === 'plain' ? null : S.timbre === 'voice' && (n.harm || (S.take && S.take.harm));
  if (harm) o.setPeriodicWave(waveFor(ctx, harm)); else o.type = 'triangle';
  const off = n.offset || 0, k = n.bend ? 1 : fl;
  const curve = n.curve && n.curve.length ? n.curve : [[n.start, off]];
  const pitch = semis => midiToHz(n.midi + off + k * (semis - off));
  o.frequency.setValueAtTime(pitch(curve[0][1]), t);
  for (const [bt, s] of curve.slice(1)) o.frequency.linearRampToValueAtTime(pitch(s), t + (bt - n.start) * stretch);
  if (n.amp && n.amp.length && fl > 0) {
    const mx = (S.take && S.take.ampMax) || 1;
    const lvl = r => 1 - fl + fl * Math.min(1.5, Math.sqrt(r / mx) * 1.2);
    dyn.gain.setValueAtTime(lvl(n.amp[0][1]), t);
    for (const [at, r] of n.amp.slice(1)) dyn.gain.linearRampToValueAtTime(lvl(r), t + (at - n.start) * stretch);
  }
  lp.type = 'lowpass'; lp.frequency.value = harm ? 9000 : 2400;
  if (env) {
    // a living voice: slow pitch drift and a little breath noise under the harmonics
    const drift = ctx.createOscillator(), dg = ctx.createGain();
    drift.frequency.value = 0.3 + Math.random() * 0.3; dg.gain.value = 5;
    drift.connect(dg).connect(o.detune); drift.start(t); drift.stop(t + dur + 0.4);
    const br = noise(ctx), bp = ctx.createBiquadFilter(), bg = ctx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = Math.min(3000, midiToHz(n.midi) * 6); bp.Q.value = 0.8; bg.gain.value = 0.05;
    br.connect(bp).connect(bg).connect(dyn); br.start(t); br.stop(t + dur + 0.3);
  }
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.28, t + 0.015);
  g.gain.setTargetAtTime(0.2, t + 0.02, 0.15);
  g.gain.setTargetAtTime(0, t + Math.max(0.03, dur - 0.02), 0.04);
  o.connect(lp).connect(dyn).connect(g).connect(out);
  o.start(t); o.stop(t + dur + 0.3);
}

// Auto-tune pitch shift per 5 ms frame, also drawn on the roll; cached until a setting changes.
function tuneCurve() {
  const tk = S.take, v = tk.voice;
  const amount = +$('tune').value;
  if (!v || amount <= 0) return null;
  if (tk.tune) return tk.tune;
  const hop = 0.005, frames = Math.ceil(v.data.length / v.sr / hop) + 1;
  const f0 = new Float32Array(frames), m = new Float32Array(frames).fill(NaN);
  const pts = tk.points, slowAll = slowPitch(pts, 0.12), slow = new Float32Array(frames);
  let j = 0;
  for (let k = 0; k < frames; k++) {
    const t = v.t0 + k * hop;
    while (j + 1 < pts.length && Math.abs(pts[j + 1].t - t) <= Math.abs(pts[j].t - t)) j++;
    const p = pts[j];
    if (p && !isNaN(p.m) && Math.abs(p.t - t) < 0.012) { m[k] = p.m; f0[k] = midiToHz(p.m); slow[k] = slowAll[j]; }
  }
  const tau = +$('speed').value * 0.3;
  const alpha = tau <= 0 ? 1 : 1 - Math.exp(-hop / tau);
  const shift = new Float32Array(frames);
  let cs = 0, ni = 0;
  const notes = tk.notes;
  for (let k = 0; k < frames; k++) {
    const t = v.t0 + k * hop;
    while (ni < notes.length && notes[ni].end < t) ni++;
    const n = notes[ni] && notes[ni].start <= t ? notes[ni] : null;
    let c = 0;
    // glides and full-contour notes are kept as sung; vibrato keeps its wobble
    if (!isNaN(m[k]) && n && !n.glide && !(n.bend && !n.vib)) c = n.midi + n.offset - (n.vib ? slow[k] : m[k]);
    cs += (c - cs) * alpha;
    shift[k] = amount * cs;
  }
  tk.tune = { hop, t0: v.t0, f0, m, shift };
  return tk.tune;
}

// Playback copy of the voice at a comfortable level, however quiet the mic was.
function playableVoice() {
  const d = renderedVoice();
  let pk = 0;
  for (const v of d) pk = Math.max(pk, Math.abs(v));
  if (pk < 1e-6) return d;
  const g = Math.min(0.9 / pk, 60), out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = d[i] * g;
  return out;
}

// Voice with auto-tune applied.
function renderedVoice() {
  const tk = S.take, tc = tuneCurve();
  if (!tc) return tk.voice && tk.voice.data;
  if (!tk.rendered) tk.rendered = psola(tk.voice.data, tk.voice.sr, tc.f0, tc.shift, tc.hop);
  return tk.rendered;
}

// mode: 'voice' | 'notes' | 'both' | 'partials' | 'transcription'
async function startPlay(mode, btn) {
  const ctx = await ensureCtx();
  if (S.sound === 'orchestra' && mode === 'transcription') await ensureOrchestra();
  const tk = S.take;
  const t0 = ctx.currentTime + 0.1;
  const bus = ctx.createGain(); bus.connect(ctx.destination);
  const nodes = [];
  let len = tk.end - tk.start;
  const voice = (mode === 'voice' || mode === 'both') && tk.voice;
  if (voice) {
    const data = playableVoice();
    const buf = ctx.createBuffer(1, data.length, tk.voice.sr);
    buf.copyToChannel(data, 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(bus);
    const off = tk.voice.t0 - tk.start;
    off >= 0 ? src.start(t0 + off) : src.start(t0, -off);
    nodes.push(src);
  }
  if (mode === 'transcription' && scoreView()) {
    const span = backingSpan();
    if (span) {
      scheduleBacking(ctx, bus, t => t0 + (t - tk.start), span.from, span.to);
      len = Math.max(len, span.to - tk.start);
    } else {
      const st = +$('style').value;
      for (const n of tk.score.notes) {
        const s = sStart(n) + (n.start - sStart(n)) * st, e = sEnd(n) + (n.end - sEnd(n)) * st;
        playScoreNote(ctx, n, t0 + (s - tk.start), bus, { s, e });
        len = Math.max(len, e - tk.start);
      }
    }
  } else if (mode === 'transcription') {
    // the written-down result: every transcribed note of every kept harmonic as a pure tone at its level
    const grid = gridOn();
    const lines = tk.pt ? liveTracks() : [{ k: 1, notes: tk.notes.map(n => ({ ...n, level: 0 })) }];
    for (const tr of lines) for (const n of tr.notes) {
      const s = grid && n.qs != null ? qTime(n, 's') : n.start, e = grid && n.qe != null ? qTime(n, 'e') : n.end;
      const at = t0 + (s - tk.start), dur = Math.max(0.05, e - s);
      const o = ctx.createOscillator(), g = ctx.createGain(), peak = 0.22 * Math.pow(10, (n.level || 0) / 20);
      o.frequency.value = midiToHz(n.midi + (n.offset || 0));
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.02);
      g.gain.setValueAtTime(peak, at + dur - 0.04);
      g.gain.linearRampToValueAtTime(0, at + dur);
      o.connect(g).connect(bus); o.start(at); o.stop(at + dur + 0.05);
      len = Math.max(len, e - tk.start);
    }
  } else if (mode === 'partials' && tk.frames) {
    // rebuild the voice from only the kept tones: one sine per harmonic, following its measured pitch and level
    const range = +$('prange').value, top = tk.pt.top, scale = 0.25 / Math.pow(10, top / 20);
    for (const tr of liveTracks()) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      g.gain.value = 0;
      let lastF = 0;
      for (const f of tk.frames) {
        const at = t0 + (f.t - tk.start);
        if (at < t0) continue;
        const lv = f.h[tr.k - 1], on = f.f0 && lv >= f.top - range;
        if (on) { lastF = f.hf[tr.k - 1]; o.frequency.setValueAtTime(lastF, at); }
        g.gain.linearRampToValueAtTime(on ? Math.pow(10, lv / 20) * scale : 0, at);
      }
      o.connect(g).connect(bus); o.start(t0); o.stop(t0 + len + 0.2);
    }
  } else if (mode !== 'voice' || !voice) {
    const nbus = ctx.createGain(); nbus.gain.value = voice ? 0.6 : 1; nbus.connect(bus);
    const grid = gridOn() && !voice;
    for (const n of tk.notes) {
      const s = grid ? qTime(n, 's') : n.start, e = grid ? qTime(n, 'e') : n.end;
      tone(ctx, n, t0 + (s - tk.start), (e - s) / Math.max(1e-3, n.end - n.start), nbus);
      len = Math.max(len, e - tk.start);
    }
  }
  S.play = { t0, bus, nodes, btn, timer: setTimeout(stopPlay, (len + 0.5) * 1000) };
  btn.dataset.label = btn.textContent;
  btn.textContent = '■ Stop'; btn.classList.add('on');
  S.view.mode = 'take';
}
function stopPlay() {
  if (!S.play) return;
  if (S.play.groove) grooveClock.stop();
  clearTimeout(S.play.timer);
  const b = S.play.bus;
  b.gain.setTargetAtTime(0, S.ctx.currentTime, 0.02);
  setTimeout(() => b.disconnect(), 200);
  const btn = S.play.btn;
  btn.textContent = btn.dataset.label; btn.classList.remove('on');
  S.play = null;
}
function playButton(btn, mode) {
  btn.onclick = () => {
    const same = S.play && S.play.btn === btn;
    if (S.play) stopPlay();
    if (!same) startPlay(mode(), btn);
  };
}
playButton($('play'), () => S.playMode);


// ---------- drone ----------
function droneFreqs() {
  const m = 12 * (+$('oct').value + 1) + rootPc();
  const list = [m];
  if (S.voicing !== 'root') list.push(m + 7);
  if (S.voicing === 'oct') list.push(m + 12);
  return list.map(midiToHz);
}
function buildDrone() {
  const ctx = S.ctx;
  const out = ctx.createGain(); out.gain.value = 0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
  const wave = $('wave').value;
  lp.frequency.value = wave === 'sawtooth' ? 1400 : 5000; lp.Q.value = 0.3;
  lp.connect(out).connect(ctx.destination);
  const oscs = droneFreqs().map((f, i) => [-3, 3].map(det => {
    const o = ctx.createOscillator(); o.type = wave; o.frequency.value = f; o.detune.value = det;
    const g = ctx.createGain(); g.gain.value = (i === 0 ? 0.5 : 0.3) / 2;
    o.connect(g).connect(lp); o.start();
    return o;
  })).flat();
  return { out, oscs };
}
const droneLevel = () => Math.pow(+$('dvol').value, 2) * 0.6;
async function setDrone(on) {
  await ensureCtx();
  const now = S.ctx.currentTime;
  if (S.drone) {
    const old = S.drone;
    old.out.gain.setTargetAtTime(0, now, 0.05);
    setTimeout(() => old.oscs.forEach(o => o.stop()), 400);
    S.drone = null;
  }
  S.droneOn = on;
  if (on) { S.drone = buildDrone(); S.drone.out.gain.setTargetAtTime(droneLevel(), now, 0.08); }
  $('drone').textContent = on ? 'On' : 'Off';
  $('drone').classList.toggle('on', on);
}
$('drone').onclick = () => setDrone(!S.droneOn);
const rebuild = () => S.droneOn && setDrone(true);
$('root').addEventListener('change', rebuild); $('oct').onchange = rebuild; $('wave').onchange = rebuild;
segHandlers.voicing = rebuild;
$('dvol').addEventListener('input', () => S.drone && S.drone.out.gain.setTargetAtTime(droneLevel(), S.ctx.currentTime, 0.03));

// ---------- metronome ----------
const metro = { on: false, t0: 0, next: 0, n: 0, bpm: 90, beats: 4, timer: 0 };
function click(t, accent, out, level = 1) {
  const ctx = S.ctx, o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1760 : 1175;
  const lvl = Math.max(0.05, Math.pow(+$('mvol').value, 2)) * (accent ? 0.5 : 0.32) * level;
  g.gain.setValueAtTime(lvl, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  o.connect(g).connect(out || ctx.destination); o.start(t); o.stop(t + 0.05);
}
function metroTick() {
  const spb = 60 / metro.bpm;
  while (metro.next < S.ctx.currentTime + 0.12) {
    click(metro.next, metro.n % metro.beats === 0);
    metro.n++;
    metro.next = metro.t0 + metro.n * spb;
  }
}
async function setMetro(on) {
  await ensureCtx();
  clearInterval(metro.timer);
  metro.on = on;
  if (on) {
    metro.bpm = Math.max(40, Math.min(240, +$('bpm').value || 90));
    metro.beats = +$('beats').value;
    metro.t0 = metro.next = S.ctx.currentTime + 0.08; metro.n = 0;
    metroTick();
    metro.timer = setInterval(metroTick, 25);
  }
  $('metro').textContent = on ? 'On' : 'Off';
  $('metro').classList.toggle('on', on);
  $('beatdots').innerHTML = on ? '<i></i>'.repeat(metro.beats) : '';
}
$('metro').onclick = () => setMetro(!metro.on);
$('bpm').onchange = $('beats').onchange = () => metro.on && setMetro(true);

// ---------- export ----------
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('copy').onclick = () => {
  const tk = S.take;
  if (scoreView()) {
    const sc = tk.score, key = scoreKey(), T = transpose();
    const txt = [keyName(key), sc.tempo ? `♩=${Math.round(sc.tempo.bpm)}` : ''].filter(Boolean).join(' · ') + '\n'
      + sc.notes.map(n => spell(n.midi + T, key) + ' ' + scoreLen(n)).join('  ');
    navigator.clipboard.writeText(txt).then(() => { $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy', 1200); });
    return;
  }
  const head = gridOn() ? `♩=${Math.round(tk.tempo.bpm)}  ` : '';
  let txt = head + tk.notes.map(n => noteName(n.midi).replace('♯', '#') + tags(n) + ' ' + lengthText(n)).join('  ');
  if (partialsOn()) for (const tr of liveTracks()) if (tr.k > 1)
    txt += `
H${tr.k} (${harmonicLabel(tr.k)}): ` + tr.notes.map(n => noteName(n.midi).replace('♯', '#') + centsText(n) + ' ' + lengthText(n)).join('  ');
  navigator.clipboard.writeText(txt).then(() => { $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy', 1200); });
};
$('midi').onclick = () => {
  const tk = S.take;
  if (scoreView()) {
    const sc = tk.score, T = transpose();
    const tracks = [{ name: 'Melody', channel: 0, notes: sc.notes.map(n => ({ ...n, midi: n.midi + T, offset: 0, bend: null, vel: 90 })) }];
    let ch = 1;
    // each layer as its own track, on the same grid
    for (const L of tk.layers || []) if (!L.muted && L.notes && L.notes.length && ch < 9)
      tracks.push({ name: L.name, channel: ch++, notes: L.notes.map(n => ({ ...n, midi: n.midi + T, offset: 0, bend: null, vel: Math.round(80 * Math.min(1.4, L.gain)) })) });
    const span = sc.tempo && backingSpan();
    if (span) {
      // every backing part as its own track, timed on the score's beat grid; drums on the GM drum channel
      const DRUMS = { kick: 36, snare: 38, hat: 42, crash: 49 }, names = { chord: 'Chords', bass: 'Bass', drone: 'Drone', motif: 'Motif', harm: 'Harmonics', counter: 'Counter-melody' };
      const parts = new Map();
      for (const e of allEvents(span.from, span.to)) {
        if (e.kind === 'melody') continue;
        const drum = e.kind in DRUMS, part = drum ? 'Drums' : (names[e.kind] || e.kind[0].toUpperCase() + e.kind.slice(1));
        if (!parts.has(part)) parts.set(part, []);
        const qs = (e.t - sc.tempo.t0) / sc.unit, qe = qs + Math.max(drum ? 0.25 : e.dur / sc.unit, 0.25);
        parts.get(part).push({ start: e.t, end: e.t + (e.dur || 0.1), qs, qe, midi: drum ? DRUMS[e.kind] : Math.round(e.midi + (e.offset || 0)),
          offset: 0, bend: null, vel: Math.round(Math.max(20, Math.min(120, 100 * (e.vel ?? (e.soft ? 0.55 : 0.8))))) });
      }
      for (const [name, notes] of parts) {
        notes.sort((x, y) => x.qs - y.qs);
        const channel = name === 'Drums' ? 9 : (ch === 9 ? ++ch : ch);
        if (name !== 'Drums') ch++;
        if (channel <= 15) tracks.push({ name, channel, notes });
      }
    }
    download(new Blob([buildMidi(tracks, { grid: !!sc.tempo, tempo: sc.tempo, res: sc.res || sres(), base: tk.start })], { type: 'audio/midi' }), `hum-arrangement-${stamp()}.mid`);
    return;
  }
  const tracks = [{ name: 'Melody', channel: 0, notes: tk.notes }];
  if (partialsOn()) {
    let ch = 1;
    for (const tr of liveTracks()) {
      if (tr.k === 1 || ch > 15) continue;
      if (ch === 9) ch++;
      tracks.push({ name: 'H' + tr.k, channel: ch++, notes: tr.notes.map(n => ({ ...n, vel: Math.max(15, Math.min(127, Math.round(100 + n.level * 2))) })) });
    }
  }
  download(new Blob([buildMidi(tracks, { grid: gridOn(), tempo: tk.tempo, res: res(), base: tk.start })], { type: 'audio/midi' }), `hum-${stamp()}.mid`);
};
// The recording as a WAV; with layers, a mix of the take and every unmuted layer, each at an even level.
$('wav').onclick = () => {
  const tk = S.take, sr = tk.voice.sr, layers = (tk.layers || []).filter(L => !L.muted && L.voice);
  if (!layers.length) { download(encodeWav(renderedVoice(), sr), `hum-${stamp()}.wav`); return; }
  const even = d => { let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v)); return pk > 1e-6 ? Math.min(0.7 / pk, 60) : 1; };
  const parts = [{ d: renderedVoice(), t0: tk.voice.t0, g: 1 }, ...layers.map(L => ({ d: L.voice.sr === sr ? L.voice.data : resample(L.voice.data, L.voice.sr, sr), t0: L.voice.t0, g: L.gain }))];
  const t0 = Math.min(...parts.map(x => x.t0)), t1 = Math.max(...parts.map(x => x.t0 + x.d.length / sr));
  const out = new Float32Array(Math.ceil((t1 - t0) * sr) + 1);
  for (const x of parts) {
    const o = Math.round((x.t0 - t0) * sr), g = even(x.d) * x.g;
    for (let i = 0; i < x.d.length && o + i < out.length; i++) out[o + i] += x.d[i] * g;
  }
  let pk = 0; for (const v of out) pk = Math.max(pk, Math.abs(v));
  if (pk > 0.95) for (let i = 0; i < out.length; i++) out[i] *= 0.95 / pk;
  download(encodeWav(out, sr), `hum-mix-${stamp()}.wav`);
};

// ---------- takes on disk (takes/ next to the page, via serve.py) ----------
async function saveToDisk(tk) {
  if (!tk.voice) return;
  if (HOSTED) { $('status').textContent = 'Saving to disk is off on this shared copy — your takes stay in this browser; use WAV or MIDI to download'; return; }
  const name = 'take-' + stamp();
  const summary = {
    mic: S.mic ? S.mic.getAudioTracks()[0]?.label : null,
    sampleRate: tk.voice.sr, seconds: tk.voice.data.length / tk.voice.sr,
    tempo: tk.tempo, settings: JSON.parse(localStorage.getItem('hum-settings') || '{}'),
    notes: tk.notes.map(n => ({ start: +(n.start - tk.start).toFixed(3), end: +(n.end - tk.start).toFixed(3), note: noteName(n.midi), midi: n.midi, offset: n.offset, glide: n.glide, vib: n.vib })),
    harmonics: tk.pt ? tk.pt.tracks.map(tr => ({ k: tr.k, level: tr.level, notes: tr.notes.map(n => ({ start: +(n.start - tk.start).toFixed(3), end: +(n.end - tk.start).toFixed(3), note: noteName(n.midi), offset: n.offset, level: n.level })) })) : [],
    pitch: tk.points.map(p => [+(p.t - tk.start).toFixed(4), isNaN(p.m) ? null : +p.m.toFixed(3), +p.r.toFixed(5)]),
  };
  try {
    const r = await fetch(`save/${name}.wav`, { method: 'POST', body: encodeWav(tk.voice.data, tk.voice.sr) });
    await fetch(`save/${name}.json`, { method: 'POST', body: JSON.stringify(summary) });
    if (r.ok) { tk.savedAs = name; $('status').textContent += ` · saved ${name}`; }
    else if (r.status === 403) $('status').textContent += ' · saving to disk is off on this shared link (your takes stay in this browser)';
    else $('status').textContent += ' · could not save (restart the hum-notes server)';
  } catch { $('status').textContent += ' · could not save'; }
  updateButtons();
}
$('save').onclick = () => S.take && saveToDisk(S.take);

// Reopen a take saved in takes/ (its recording and pitch line), e.g. openSavedTake('take-2026-10-22-12-19-49').
async function openSavedTake(name) {
  const ctx = await ensureCtx();
  const [meta, wav] = await Promise.all([fetch(`takes/${name}.json`).then(r => r.json()), fetch(`takes/${name}.wav`).then(r => r.arrayBuffer())]);
  const buf = await ctx.decodeAudioData(wav);
  const points = meta.pitch.map(([t, m, r]) => ({ t, m: m == null ? NaN : m, r, c: 1 })).sort((a, b) => a.t - b.t);
  if (S.play) stopPlay();
  S.take = { start: 0, end: meta.seconds, points, voice: { t0: 0, sr: buf.sampleRate, data: buf.getChannelData(0).slice() }, grid: null, tempoScale: 1, notes: [], savedAs: name };
  trimTake(S.take);
  S.view.mode = 'take';
  retranscribe();
  updateButtons();
  return S.take;
}

// ---------- saved take (IndexedDB) ----------
function idb() {
  return new Promise((ok, no) => {
    const r = indexedDB.open('hum-notes', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
async function saveTake() {
  try {
    const db = await idb(), tk = S.take;
    const v = tk && tk.points ? { start: tk.start, end: tk.end, points: tk.points, voice: tk.voice, grid: tk.grid, tempoScale: tk.tempoScale, edited: tk.edited || null, taps: tk.taps || null, chordEdits: tk.chordEdits || null, sections: tk.sections || null, chordPicks: tk.chordPicks || null,
      layers: (tk.layers || []).map(L => ({ id: L.id, name: L.name, colour: L.colour, points: L.points, voice: L.voice, start: L.start, end: L.end, gain: L.gain, muted: L.muted, sound: L.sound })) } : null;
    await new Promise((ok, no) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, 'take'); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  } catch {}
}
async function loadTake() {
  try {
    const db = await idb();
    const v = await new Promise((ok, no) => { const r = db.transaction('kv').objectStore('kv').get('take'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    if (!v) return;
    S.take = { ...v, notes: [] };
    if (S.take.points) S.take.points.sort((a, b) => a.t - b.t);
    S.view.mode = 'take';
    retranscribe();
  } catch {}
}

// ---------- live reload ----------
// The watcher itself lives in index.html so it survives script errors; it asks before reloading.
window.reloadReady = async () => { if (S.recording || S.chunks) return false; await saveTake(); return true; };

// ---------- live tonic guess ----------
// From the last 12 seconds of steady humming: the key that fits best, offered for the drone.
let liveKeyAt = 0;
function updateLiveKey() {
  const box = $('liveKey');
  if (!S.listening || !S.ctx || performance.now() - liveKeyAt < 600) { if (!S.listening) box.innerHTML = ''; return; }
  liveKeyAt = performance.now();
  const now = S.ctx.currentTime;
  S.livePcs = (S.livePcs || []).filter(p => p.t > now - 12);
  if (S.livePcs.length < 400) { box.innerHTML = ''; return; }   // ~2 s of steady pitch
  const h = new Array(12).fill(0);
  for (const p of S.livePcs) h[p.pc]++;
  const k = keysFromHistogram(h)[0];
  const name = (usesFlats(k) ? FLAT_NAMES : NAMES)[k.root] + ' ' + k.mode;
  if (box.dataset.key === name + S.droneOn + $('root').value) return;
  box.dataset.key = name + S.droneOn + $('root').value;
  box.innerHTML = `<span>Sounds like <b>${name}</b></span>`;
  if (S.droneOn && +$('root').value === k.root) { box.insertAdjacentHTML('beforeend', '<span>✓ on the drone</span>'); return; }
  const b = document.createElement('button');
  b.className = 'small'; b.textContent = 'Drone on ' + (usesFlats(k) ? FLAT_NAMES : NAMES)[k.root];
  b.onclick = () => { $('root').value = String(k.root); saveSettings(); setDrone(true); box.dataset.key = ''; };
  box.appendChild(b);
}

// ---------- readout ----------
let lastShown = 0;
function showReadout(p) {
  updateLiveKey();
  const lvl = S.lastLevel, needle = $('needle');
  $('level').style.width = lvl && S.listening ? Math.max(0, Math.min(100, (20 * Math.log10(lvl.rms + 1e-9) + 60) / 60 * 100)) + '%' : '0';
  $('level').classList.toggle('voiced', !!(lvl && lvl.voiced));
  if (metro.on) {
    const b = Math.floor((S.ctx.currentTime - metro.t0) / (60 / metro.bpm));
    const dots = $('beatdots').children;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('hit', b >= 0 && b % metro.beats === i);
  }
  if (!p || !S.listening) {
    if (performance.now() - lastShown > 350) {
      $('big').innerHTML = '–'; $('hz').innerHTML = '&nbsp;'; $('interval').innerHTML = '&nbsp;';
      needle.style.left = '50%'; needle.classList.remove('good');
    }
    return;
  }
  lastShown = performance.now();
  const n = Math.round(p.m), cents = (p.m - n) * 100;
  $('big').innerHTML = NAMES[pcOf(n)] + '<sub>' + (Math.floor(n / 12) - 1) + '</sub>';
  $('big').style.setProperty('--degc', degreesOn() ? degColour(n) : 'transparent');
  $('hz').textContent = p.f.toFixed(1) + ' Hz · ' + (cents >= 0 ? '+' : '') + cents.toFixed(0) + '¢';
  needle.style.left = (50 + Math.max(-50, Math.min(50, cents))) + '%';
  needle.classList.toggle('good', Math.abs(cents) < 10);
  if (S.curChord && S.take && S.take.score) {
    const T = transpose(), c = S.curChord, root = pcOf(c.root + T);
    const fits = c.pcs.map(p => pcOf(p + T)).includes(pcOf(n));
    $('interval').textContent = `over ${chordName({ ...c, root }, scoreKey())}: ${INTERVALS[pcOf(n - root)]}${fits ? ' ✓ chord note' : ''}`;
  } else {
    const key = tonicKey(), d = degreeOf12(n, key);
    $('interval').textContent = `${d ? d + ' · ' + DEGREE_NAMES[d - 1] : 'outside the key'} of ${(usesFlats(key) ? FLAT_NAMES : NAMES)[key.root]} ${key.mode}`;
  }
}

// ---------- drawing ----------
const cv = $('cv'), g2 = cv.getContext('2d');
function resize() {
  const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(resize).observe(cv);
function setMarkerAt(x) {
  const v = S.lastView;
  if (x < v.gut) { S.cursor = null; return; }
  let t = v.t0 + (x - v.gut) / (v.W - v.gut) * (v.t1 - v.t0);
  if (scoreView() && S.take.score.tempo) t = beatTime(Math.round((t - S.take.score.tempo.t0) / spb()));
  S.cursor = t;
}
cv.onclick = e => {
  if (S.layer === 'groove') { grooveClick(e); return; }
  if (editable()) return;   // Score view: the editor handles mouse down/up
  const v = S.lastView;
  if (!v || !takeView()) { if (S.take && S.take.points && !S.recording) S.view.mode = 'take'; return; }
  setMarkerAt(e.clientX - cv.getBoundingClientRect().left);
};

// ---------- score editing ----------
// Click selects (shift adds), drag on empty space box-selects, drag a note to move it (time snaps to
// the grid, pitch to semitones), drag its right edge to resize, double-click empty space to add.
// Keys: Delete, arrows (shift = octave / beat), S split, J join, Ctrl+C/V/D/Z/Y/A, Esc.
// The first edit locks the score: later transcription settings leave your edits alone.
const ED = { sel: new Set(), undo: [], redo: [], drag: null, clip: null };
const editable = () => S.layer === 'score' && takeView() && scoreView() && S.take.score.tempo && !S.recording;
const scoreNotes = () => (S.take && S.take.score ? S.take.score.notes : []);
function edPos(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function noteAt(x, y) {
  const v = S.lastView, T = transpose();
  for (const n of [...scoreNotes()].reverse()) {
    const x0 = v.X(sStart(n)), x1 = Math.max(v.X(sEnd(n)) - 2, x0 + 3), top = v.Y(n.midi + T + 0.5);
    if (x >= x0 - 2 && x <= x1 + 4 && y >= top && y <= top + v.rowH) return { n, edge: x1 - x < 7 && x1 - x0 > 12 ? 'end' : 'body' };
  }
  return null;
}
const edTime = x => { const v = S.lastView; return v.t0 + (x - v.gut) / (v.W - v.gut) * (v.t1 - v.t0); };
const edMidi = y => { const v = S.lastView; return Math.round(v.lo + (v.PH - y) / v.PH * (v.hi - v.lo)) - transpose(); };
const edStep = t => { const sc = S.take.score; return sc.beatMap ? Math.floor(beatOf(sc.beatMap, t) * sc.res) : Math.floor((t - sc.tempo.t0) / sc.unit); };
const stepPx = () => { const v = S.lastView; return (v.W - v.gut) / (v.t1 - v.t0) * S.take.score.unit; };
function beginEdit() {
  ED.undo.push(JSON.stringify(scoreNotes()));
  if (ED.undo.length > 200) ED.undo.shift();
  ED.redo.length = 0;
}
function commitEdit() {
  const tk = S.take, sc = tk.score;
  sc.notes.sort((a, b) => a.qs - b.qs || a.midi - b.midi);
  for (const n of sc.notes) {
    if (!n.src && !n.added) n.src = { start: n.start, end: n.end };
    n.start = sStart(n); n.end = sEnd(n);
    if (n.perf) { n.perf = { ...n.perf }; }
  }
  tk.edited = { notes: sc.notes, tempo: sc.tempo, unit: sc.unit, res: sc.res, key: sc.key, beatMap: sc.beatMap || null, meterFixed: sc.meterFixed || null };
  sc.plan = null; tk.line = null; tk.lineRender = null;
  sc.harm = scoreHarmonics(tk);
  renderNotes(); renderPartials(); updateScoreInfo(); renderEditBar(); saveTake();
}
function restore(json) {
  const sc = S.take.score, keep = [...ED.sel].map(n => sc.notes.indexOf(n));
  sc.notes = JSON.parse(json);
  ED.sel = new Set(keep.map(i => sc.notes[i]).filter(Boolean));
  commitEdit();
}
function edUndo() { if (!ED.undo.length) return; ED.redo.push(JSON.stringify(scoreNotes())); restore(ED.undo.pop()); }
function edRedo() { if (!ED.redo.length) return; ED.undo.push(JSON.stringify(scoreNotes())); restore(ED.redo.pop()); }
function newNote(qs, qe, midi) {
  const sc = S.take.score, near = sc.notes.reduce((b, n) => !b || Math.abs(n.qs - qs) < Math.abs(b.qs - qs) ? n : b, null);
  const n = { qs, qe, midi, added: true };
  n.start = sStart(n); n.end = sEnd(n);
  n.perf = { center: midi, plateau: n.end - n.start, drift: 0, vib: null, scoop: 0, fall: 0, start: n.start, end: n.end,
    curve: [[n.start, 0]], amp: [[n.start, (S.take.ampMax || 0.05) * 0.6]] };
  if (near && near.env) n.env = near.env;
  return n;
}
function edDelete() { if (!ED.sel.size) return; beginEdit(); S.take.score.notes = scoreNotes().filter(n => !ED.sel.has(n)); ED.sel.clear(); commitEdit(); }
function edNudge(dq, dm) {
  if (!ED.sel.size) return;
  beginEdit();
  for (const n of ED.sel) { n.qs += dq; n.qe += dq; n.midi += dm; if (dm) n.userPitch = true; }
  commitEdit();
}
function edSplit() {
  if (!ED.sel.size) return;
  beginEdit();
  const add = [];
  for (const n of ED.sel) {
    if (n.qe - n.qs < 2) continue;
    const mid = n.qs + Math.floor((n.qe - n.qs) / 2), b = { ...n, qs: mid, src: n.src, perf: n.perf };
    n.qe = mid; add.push(b);
  }
  S.take.score.notes.push(...add);
  add.forEach(b => ED.sel.add(b));
  commitEdit();
}
function edJoin() {
  const sel = [...ED.sel].sort((a, b) => a.qs - b.qs);
  if (sel.length < 2) return;
  beginEdit();
  sel[0].qe = Math.max(...sel.map(n => n.qe));
  S.take.score.notes = scoreNotes().filter(n => n === sel[0] || !ED.sel.has(n));
  ED.sel = new Set([sel[0]]);
  commitEdit();
}
function edCopy() {
  const sel = [...ED.sel].sort((a, b) => a.qs - b.qs);
  if (!sel.length) return;
  const q0 = sel[0].qs;
  ED.clip = JSON.stringify(sel.map(n => ({ ...n, qs: n.qs - q0, qe: n.qe - q0 })));
}
function edPaste(at) {
  if (!ED.clip) return;
  beginEdit();
  const items = JSON.parse(ED.clip).map(n => ({ ...n, qs: n.qs + at, qe: n.qe + at, added: n.added || false }));
  S.take.score.notes.push(...items);
  ED.sel = new Set(items);
  commitEdit();
}
function edDuplicate() {
  const sel = [...ED.sel];
  if (!sel.length) return;
  edCopy();
  edPaste(Math.max(...sel.map(n => n.qe)));
}
// ---------- polish melody ----------
// For each note, nearby candidates (up to two semitones away) are scored on: how far they are from
// what you actually sang (sung centre, in semitones), being in the key, being a chord tone when the
// note is long and on a strong beat, and how singable the step from the previous note is (steps cheap,
// leaps dearer, tritones and very wide leaps dearest). The best path through all notes wins.
// Strength weighs the musical rules against what you sang; notes you added yourself stay put.
function polishMelody(strength) {
  const sc = S.take.score, notes = sc.notes.slice().sort((a, b) => a.qs - b.qs), plan = backingPlan();
  if (!notes.length || !plan) return [];
  const key = sc.key, scale = SCALES[key.mode], res = sc.res || 2, beats = plan.meter.beats;
  const inKey = m => { const d = pcOf(m - key.root); return scale.includes(d) ? 0 : key.mode === 'minor' && d === 11 ? 0.25 : 1; };
  const chordAt = n => {
    const b = n.qs / res, sg = plan.segs.find(x => b >= x.start - 1e-6 && b < x.end - 1e-6);
    return sg ? chordFor(plan, sg) : null;
  };
  const leap = (a, b) => {
    const d = Math.abs(a - b);
    return d === 0 ? 0.1 : d <= 2 ? 0 : d <= 4 ? 0.25 : d === 5 ? 0.45 : d === 6 ? 1.6 : d === 7 ? 0.5 : d <= 12 ? 0.8 + (d - 8) * 0.12 : 2.2;
  };
  const cands = notes.map(n => {
    const mine = n.added || n.userPitch, c0 = n.midi, center = !mine && n.perf && isFinite(n.perf.center) ? n.perf.center : c0;
    const beatPos = n.qs / res, onBeat = Math.abs(beatPos - Math.round(beatPos)) < 1e-6;
    const down = onBeat && ((Math.round(beatPos) - plan.meter.offset) % beats + beats) % beats === 0;
    const durBeats = (n.qe - n.qs) / res, weight = Math.min(1, 0.35 + durBeats * 0.5) * (down ? 1 : onBeat ? 0.75 : 0.45);
    const chord = chordAt(n), keep = mine ? 3 : 1;
    const musicOf = m => inKey(m) * 1.4 + (chord ? (chord.pcs.includes(pcOf(m)) ? -0.25 * weight : weight >= 0.6 ? 0.7 * weight : 0) : 0);
    const here = musicOf(c0);
    // only moves that fit the music at least as well: never out of the key, never onto a worse clash;
    // and any move pays a small price, so notes that already sit well stay
    return [-2, -1, 0, 1, 2].map(k => c0 + k).filter(m => m === c0 || (inKey(m) <= inKey(c0) && musicOf(m) <= here + 1e-9)).map(m => {
      // strength trades what you sang against the rules: at full strength the sung pitch counts a fifth
      const evidence = (Math.abs(m - center) * 2 * keep + (m === c0 ? 0 : 0.35)) * (1 - 0.8 * strength);
      return { m, cost: evidence + strength * musicOf(m) };
    });
  });
  // Viterbi over the notes (leap cost between consecutive notes)
  const score = [cands[0].map(c => c.cost)], back = [];
  for (let i = 1; i < notes.length; i++) {
    const gapBeats = (notes[i].qs - notes[i - 1].qe) / res, link = gapBeats > 2 ? 0.3 : 1;   // after a rest, leaps matter less
    score.push([]); back.push([]);
    cands[i].forEach(c => {
      let best = Infinity, bi = 0;
      cands[i - 1].forEach((p, j) => { const v = score[i - 1][j] + strength * link * leap(p.m, c.m); if (v < best) { best = v; bi = j; } });
      score[i].push(best + c.cost); back[i - 1].push(bi);
    });
  }
  let j = score[score.length - 1].indexOf(Math.min(...score[score.length - 1]));
  const pick = [j];
  for (let i = notes.length - 2; i >= 0; i--) { j = back[i][j]; pick.unshift(j); }
  const changed = [];
  notes.forEach((n, i) => { const m = cands[i][pick[i]].m; if (m !== n.midi) changed.push({ n, from: n.midi, to: m }); });
  return changed;
}
$('polishBtn').onclick = () => {
  if (!editable()) return;
  const changed = polishMelody(+$('polishAmt').value);
  if (!changed.length) { $('status').textContent = 'Polish: every note already sits well'; return; }
  beginEdit();
  const key = S.take.score.key, T = transpose();
  for (const c of changed) { c.n.midi = c.to; c.n.chromatic = !SCALES[key.mode].includes(pcOf(c.to - key.root)); }
  ED.sel = new Set(changed.map(c => c.n));
  commitEdit();
  const k = scoreKey();
  $('status').textContent = `Polished ${changed.length} note${changed.length > 1 ? 's' : ''}: ` + changed.slice(0, 6).map(c => `${spell(c.from + T, k)}→${spell(c.to + T, k)}`).join(', ') + (changed.length > 6 ? '…' : '') + ' · Ctrl+Z to undo';
};

// ---------- tap the beat ----------
// Your recording plays; tap the beat on the spacebar (or T). The taps become the score's beat.
const TAP = { on: false, taps: [], t0: 0, timer: 0, bus: null };
async function startTapping() {
  const tk = S.take;
  if (!tk || !tk.voice) return;
  if (tk.edited) { $('status').textContent = 'Your edits are tied to the current beat — Re-transcribe first, then tap'; return; }
  if (S.play) stopPlay();
  const ctx = await ensureCtx();
  const data = playableVoice(), buf = ctx.createBuffer(1, data.length, tk.voice.sr);
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource(), bus = ctx.createGain();
  src.buffer = buf; src.connect(bus).connect(ctx.destination);
  const at = ctx.currentTime + 0.6, off = Math.max(0, tk.start - tk.voice.t0);
  src.start(at, off);
  Object.assign(TAP, { on: true, taps: [], t0: at, bus, start: tk.start, out: (ctx.outputLatency || 0) + (ctx.baseLatency || 0) });
  TAP.timer = setTimeout(stopTapping, (tk.end - tk.start + 1.2) * 1000);
  $('tapBtn').textContent = '■ Done tapping'; $('tapBtn').classList.add('on');
  $('status').textContent = 'Tap the beat on the spacebar while it plays…';
}
function tap() {
  if (!TAP.on) return;
  // what you hear left the speakers a little after it was scheduled; tap times are moved back by that
  TAP.taps.push(TAP.start + (S.ctx.currentTime - TAP.t0) - TAP.out);
  $('status').textContent = `${TAP.taps.length} taps…`;
}
function stopTapping() {
  if (!TAP.on) return;
  clearTimeout(TAP.timer);
  TAP.on = false;
  const b = TAP.bus; b.gain.setTargetAtTime(0, S.ctx.currentTime, 0.05); setTimeout(() => b.disconnect(), 300);
  $('tapBtn').textContent = 'Tap the beat'; $('tapBtn').classList.remove('on');
  if (TAP.taps.length < 4) { $('status').textContent = 'Need at least 4 taps — try again'; return; }
  S.take.taps = TAP.taps.slice();
  retranscribe(); saveTake();
  $('status').textContent = `Beat from your ${TAP.taps.length} taps: ${Math.round(S.take.score.tempo.bpm)} bpm`;
}
$('tapBtn').onclick = () => (TAP.on ? stopTapping() : startTapping());
$('tapClear').onclick = () => { S.take.taps = null; retranscribe(); saveTake(); $('status').textContent = 'Beat found from the humming again'; };

function renderEditBar() {
  const on = S.layer === 'score' && S.take && S.take.score && S.take.score.tempo;
  $('editBar').hidden = !on;
  if (!on) return;
  $('edUndo').disabled = !ED.undo.length; $('edRedo').disabled = !ED.redo.length;
  for (const id of ['edDel', 'edSplit', 'edDup']) $(id).disabled = !ED.sel.size;
  $('tapClear').hidden = !S.take.taps;
  $('tapBtn').disabled = !S.take.voice;
  $('edJoin').disabled = ED.sel.size < 2;
  $('edReset').hidden = !S.take.edited;
  $('edInfo').textContent = (S.take.edited ? 'edited · ' : '') + (ED.sel.size ? `${ED.sel.size} selected` : 'click a note to select, double-click to add');
}
$('edUndo').onclick = edUndo; $('edRedo').onclick = edRedo; $('edDel').onclick = edDelete;
$('edSplit').onclick = edSplit; $('edJoin').onclick = edJoin; $('edDup').onclick = edDuplicate;
$('edReset').onclick = () => { S.take.edited = null; ED.sel.clear(); ED.undo.length = 0; ED.redo.length = 0; retranscribe(); renderEditBar(); saveTake(); };

cv.addEventListener('mousedown', e => {
  if (!editable() || e.button !== 0) return;
  const { x, y } = edPos(e), hit = noteAt(x, y);
  if (hit) {
    if (e.shiftKey) { ED.sel.has(hit.n) ? ED.sel.delete(hit.n) : ED.sel.add(hit.n); }
    else if (!ED.sel.has(hit.n)) ED.sel = new Set([hit.n]);
    ED.drag = { mode: hit.edge === 'end' ? 'resize' : 'move', x0: x, y0: y, moved: false, began: false, rowH: S.lastView.rowH, step: stepPx(),
      orig: [...ED.sel].map(n => ({ n, qs: n.qs, qe: n.qe, midi: n.midi })) };
    if (hit.n.midi != null) previewNote(hit.n);
  } else {
    if (!e.shiftKey) ED.sel.clear();
    ED.drag = { mode: 'box', x0: x, y0: y, x1: x, y1: y, moved: false, base: new Set(ED.sel) };
  }
  renderEditBar();
});
addEventListener('mousemove', e => {
  const d = ED.drag;
  if (!d) return;
  const { x, y } = edPos(e);
  if (Math.abs(x - d.x0) + Math.abs(y - d.y0) > 3) d.moved = true;
  if (!d.moved) return;
  if (d.mode === 'box') {
    d.x1 = x; d.y1 = y;
    const ta = edTime(Math.min(d.x0, x)), tb = edTime(Math.max(d.x0, x)), ma = edMidi(Math.max(d.y0, y)), mb = edMidi(Math.min(d.y0, y));
    ED.sel = new Set(d.base);
    for (const n of scoreNotes()) if (sEnd(n) > ta && sStart(n) < tb && n.midi >= ma && n.midi <= mb) ED.sel.add(n);
    renderEditBar();
    return;
  }
  if (!d.began) { beginEdit(); d.began = true; }
  const dq = Math.round((x - d.x0) / d.step), dm = Math.round(-(y - d.y0) / d.rowH);
  for (const o of d.orig) {
    if (d.mode === 'move') { o.n.qs = o.qs + dq; o.n.qe = o.qe + dq; o.n.midi = o.midi + dm; if (dm) o.n.userPitch = true; }
    else o.n.qe = Math.max(o.qs + 1, o.qe + dq);
  }
});
addEventListener('mouseup', e => {
  const d = ED.drag;
  if (!d) return;
  ED.drag = null;
  if (d.mode === 'box' && !d.moved) { setMarkerAt(d.x0); renderEditBar(); return; }
  if (d.began) {
    const changed = d.orig.some(o => o.n.qs !== o.qs || o.n.qe !== o.qe || o.n.midi !== o.midi);
    if (changed) { commitEdit(); if (d.orig.length === 1) previewNote(d.orig[0].n); }
    else ED.undo.pop();
  }
  renderEditBar();
});
cv.ondblclick = e => {
  if (!editable()) { S.cursor = null; return; }
  const { x, y } = edPos(e);
  if (noteAt(x, y)) return;
  const sc = S.take.score, qs = edStep(edTime(x)), m = edMidi(y);
  beginEdit();
  const n = newNote(qs, qs + (sc.res || 2), m);
  sc.notes.push(n);
  ED.sel = new Set([n]);
  commitEdit();
  previewNote(n);
};
// a short blip of the note under the mouse, so you hear what you picked
function previewNote(n) {
  ensureCtx().then(ctx => tone(ctx, { midi: n.midi + transpose(), offset: 0, start: 0, end: 0.35, curve: null, amp: null, env: n.env }, ctx.currentTime + 0.01, 1, ctx.destination, 0));
}
function editKeys(e) {
  if (!editable() || ['SELECT', 'INPUT'].includes(e.target.tagName)) return false;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey, res = S.take.score.res || 2;
  if (k === 'Delete' || k === 'Backspace') edDelete();
  else if (k === 'ArrowUp' || k === 'ArrowDown') { if (!ED.sel.size) return false; edNudge(0, (k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1)); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') { if (!ED.sel.size) return false; edNudge((k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? res : 1), 0); }
  else if (ctrl && (k === 'z' || k === 'Z')) e.shiftKey ? edRedo() : edUndo();
  else if (ctrl && (k === 'y' || k === 'Y')) edRedo();
  else if (ctrl && k === 'a') { ED.sel = new Set(scoreNotes()); renderEditBar(); }
  else if (ctrl && k === 'c') edCopy();
  else if (ctrl && k === 'v') edPaste(S.cursor != null ? edStep(S.cursor) : Math.max(0, ...scoreNotes().map(n => n.qe)));
  else if (ctrl && k === 'd') edDuplicate();
  else if (!ctrl && (k === 's' || k === 'S')) edSplit();
  else if (!ctrl && (k === 'j' || k === 'J')) edJoin();
  else if (k === 'Escape') { ED.sel.clear(); S.cursor = null; renderEditBar(); }
  else return false;
  e.preventDefault();
  return true;
}

const takeView = () => S.view.mode === 'take' && S.take && S.take.points && (!S.recording || armed());
// The whole take (and its layers), in take time.
function fullRange(now) {
  const tk = S.take;
  let a = tk.start, b = tk.end;
  if (gridOn()) for (const n of tk.notes) b = Math.max(b, noteEnd(n));
  if (scoreView()) for (const n of tk.score.notes) b = Math.max(b, sEnd(n));
  for (const L of tk.layers || []) { a = Math.min(a, L.start); b = Math.max(b, L.end); }
  if (armed() && now != null) { a = Math.min(a, S.recArm.from); b = Math.max(b, armHead(now) + 3); }
  return [a - 0.2, Math.max(b, a + 1) + 0.2];
}
// Zoomed in, the view is a window S.view.zoom seconds wide from S.view.left, turning the page
// when the playhead (or the recording) runs off its right edge.
function viewRange(now) {
  if (takeView()) {
    const [a, b] = fullRange(now), z = S.view.zoom;
    if (!z || z >= b - a) { S.view.left = a; return [a, b]; }
    const head = headAt(now);
    if (head != null && !ED.drag && (head > S.view.left + z * 0.92 || head < S.view.left)) S.view.left = head - z * 0.08;
    S.view.left = Math.max(a, Math.min(b - z, S.view.left ?? a));
    return [S.view.left, S.view.left + z];
  }
  return [now - 8, now + 0.3];
}
// Where playback (or a recording over the take) is, in take time; null when nothing is running.
function headAt(now) {
  if (armed()) return armHead(now);
  const P = S.play;
  if (!P || P.groove || !S.take) return null;
  if (P.region) { const el = now - P.t0, L = P.region.len; return P.region.from + (P.loop ? ((el % L) + L) % L : el); }
  return S.take.start + (now - P.t0);
}
function zoomBy(f, atX) {
  if (!takeView()) return;
  const now = S.ctx ? S.ctx.currentTime : 0, [a, b] = fullRange(now), full = b - a;
  const cur = S.view.zoom && S.view.zoom < full ? S.view.zoom : full, next = Math.max(1.5, Math.min(full, cur / f));
  const v = S.lastView, left = S.view.left ?? a;
  const anchor = atX != null && v ? v.t0 + (atX - v.gut) / (v.W - v.gut) * (v.t1 - v.t0) : left + cur / 2;
  S.view.left = anchor - (anchor - left) / cur * next;
  S.view.zoom = next >= full - 1e-3 ? null : next;
}
$('zoomIn').onclick = () => zoomBy(1.6);
$('zoomOut').onclick = () => zoomBy(1 / 1.6);
$('zoomFit').onclick = () => { S.view.zoom = null; };
cv.addEventListener('wheel', e => {
  if (S.layer === 'groove' || !takeView()) return;
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.004), e.clientX - cv.getBoundingClientRect().left); return; }
  if (!S.view.zoom || !S.lastView) return;
  e.preventDefault();
  const v = S.lastView, d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  S.view.left += d / (v.W - v.gut) * (v.t1 - v.t0);
}, { passive: false });

function follow(pts, notes, t0, t1) {
  if (typeof ED !== 'undefined' && ED.drag) return;   // hold the view still while editing
  const ms = [];
  for (let i = pts.length - 1; i >= 0 && pts[i].t > t0; i--) if (pts[i].t < t1 && !isNaN(pts[i].m)) ms.push(pts[i].m);
  for (const n of notes) if (n.end > t0) ms.push(n.midi);
  if (partialsOn() && !(takeView() && scoreView())) {
    for (const tr of liveTracks()) for (const n of tr.notes) if (n.end > t0) ms.push(n.midi);
    if (S.view.mode !== 'take') for (const fr of S.livePeaks || []) for (const [m] of fr.pk) ms.push(m);
  }
  if (!ms.length) return;
  const lo = Math.min(...ms), hi = Math.max(...ms);
  const span = Math.max(26, hi - lo + 8);
  const rate = S.view.mode === 'take' && !S.recording ? 0.25 : 0.05;
  S.view.center += ((lo + hi) / 2 - S.view.center) * rate;
  S.view.span += (span - S.view.span) * rate;
}

function draw() {
  if (S.layer === 'groove') {
    $('emptyMsg').hidden = true;
    drawGroove();
    showReadout(S.lastPitch);
    requestAnimationFrame(draw);
    return;
  }
  const W = cv.clientWidth, H = cv.clientHeight;
  const now = S.ctx ? S.ctx.currentTime : 0;
  const tv = takeView();
  const [t0, t1] = viewRange(now);
  const sv = tv && scoreView();
  const pts = sv ? [] : tv ? S.take.points : S.points;
  const notes = S.take ? S.take.notes : [];
  const plan = sv ? backingPlan() : null, span = plan && backingSpan();
  const bev = span ? allEvents(span.from, span.to) : [];
  const layerNotes = tv ? (S.take.layers || []).flatMap(L => (L.notes || []).map(n => ({ midi: n.midi + (sv ? transpose() : 0), end: sv ? sEnd(n) : n.end }))) : [];
  follow(pts, sv ? [...S.take.score.notes.map(n => ({ midi: n.midi + transpose(), end: sEnd(n) })),
    ...bev.filter(e => e.midi != null && e.kind !== 'melody').map(e => ({ midi: e.midi, end: e.t + e.dur })), ...layerNotes] : [...notes, ...layerNotes], t0, t1);
  const lo = S.view.center - S.view.span / 2, hi = S.view.center + S.view.span / 2;
  const drumH = sv && bev.some(e => e.kind === 'kick' || e.kind === 'hat') ? 30 : 0;
  const gut = 44, waveH = tv && S.take.voice ? 28 : 0, PH = H - waveH - drumH;
  const X = t => gut + (t - t0) / (t1 - t0) * (W - gut);
  S.lastView = { t0, t1, gut, W };
  const Y = m => PH - (m - lo) / (hi - lo) * PH;
  const rowH = PH / (hi - lo);
  Object.assign(S.lastView, { X, Y, rowH, lo, hi, PH });

  g2.clearRect(0, 0, W, H);
  const root = sv && scoreKey() ? scoreKey().root : rootPc(), fifth = (root + 7) % 12;
  g2.font = '11px "Space Grotesk", sans-serif'; g2.textBaseline = 'middle';
  for (let m = Math.floor(lo) - 1; m <= Math.ceil(hi) + 1; m++) {
    const pc = pcOf(m), y = Y(m + 0.5);
    const fill = pc === root ? colors['lane-root'] : pc === fifth ? colors['lane-fifth'] : [1, 3, 6, 8, 10].includes(pc) ? colors['lane-black'] : null;
    if (fill) { g2.fillStyle = fill; g2.fillRect(0, y, W, rowH); }
    if (pc === 0 || pc === root) { g2.fillStyle = pc === root ? colors.accent : colors.muted; g2.fillText(noteName(m), 8, Y(m)); }
    if (pc === 0) { g2.fillStyle = colors.grid; g2.fillRect(gut, Y(m - 0.5), W, 1); }
  }

  // time grid: beats and bars when a tempo is known, else seconds
  const tempo = sv ? (plan ? { ...S.take.score.tempo, beats: plan.meter.beats, t0: beatTime(plan.meter.offset) } : S.take.score.tempo) : tv ? S.take.tempo : (metro.on ? metro : (S.recording && S.take.grid) || null);
  if (tempo) {
    const spb = 60 / tempo.bpm, beats = tempo.beats || 4;
    for (let b = Math.ceil((t0 - tempo.t0) / spb); tempo.t0 + b * spb < t1; b++) {
      g2.fillStyle = b % beats === 0 ? colors.bar : colors.grid;
      g2.fillRect(X(tempo.t0 + b * spb), 0, 1, PH);
    }
  } else {
    g2.fillStyle = colors.grid;
    for (let s = Math.ceil(t0); s < t1; s++) g2.fillRect(X(s), 0, 1, PH);
  }
  g2.fillStyle = colors.grid; g2.fillRect(gut, 0, 1, H);

  // voice loudness strip
  if (waveH) {
    g2.fillStyle = colors.wave;
    const mid = PH + drumH + waveH / 2;
    for (const p of S.take.points) {
      const a = Math.min(1, Math.sqrt(p.r) * 2.6) * (waveH / 2 - 2);
      g2.fillRect(X(p.t), mid - a, 1, a * 2);
    }
  }

  if (sv) {
    // chords: their tones lightly banded behind the notes, names along the top
    const key = scoreKey(), T = transpose();
    if (plan) for (const sg of plan.segs) {
      const c = segChord(sg), xs = X(beatTime(sg.start)), xe = X(beatTime(sg.end));
      if (xe < gut || xs > W || !c) continue;
      g2.fillStyle = colors['lane-fifth'];
      for (let m = Math.floor(lo); m <= Math.ceil(hi); m++) if (c.pcs.includes(pcOf(m - T))) g2.fillRect(xs, Y(m + 0.5), xe - xs, rowH);
      g2.fillStyle = colors.accent;
      g2.fillText(chordName({ ...c, root: pcOf(c.root + T) }, key), xs + 4, 10);
    }
    // the backing itself: drone and bass darker, chord notes lighter, melody drawn on top
    for (const e of bev) {
      if (e.midi == null || e.kind === 'melody' || e.t + e.dur < t0 || e.t > t1) continue;
      if (e.kind === 'harm') {
        const range = +$('prange').value;
        g2.globalAlpha = 0.3 + 0.7 * Math.max(0, 1 + e.level / range);
        g2.fillStyle = colors.note; g2.strokeStyle = colors['note-edge']; g2.lineWidth = 1;
        g2.beginPath(); g2.roundRect(X(e.t), Y(e.midi + e.offset + 0.28), Math.max(3, X(e.t + e.dur) - X(e.t) - 2), rowH * 0.56, 3); g2.fill(); g2.stroke();
        g2.globalAlpha = 1;
        continue;
      }
      const low = e.low;
      const x0 = X(e.t), x1 = Math.max(X(e.t + e.dur) - 1, x0 + 2), y = Y(e.midi + 0.5);
      g2.fillStyle = colors[low ? 'bk-low' : 'bk-note'];
      g2.strokeStyle = e.kind === 'motif' ? colors.accent : e.kind === 'counter' ? colors['note-edge'] : colors[low ? 'bk-low-edge' : 'bk-edge'];
      g2.lineWidth = e.kind === 'motif' || e.kind === 'counter' ? 1.5 : 1;
      const h = e.kind === 'drone' ? rowH * 0.5 : rowH - 2, yy = e.kind === 'drone' ? Y(e.midi) - h / 2 : y + 1;
      g2.beginPath(); g2.roundRect(x0, yy, x1 - x0, h, Math.min(4, rowH / 3)); g2.fill(); g2.stroke();
    }
    // drum strip under the roll: shaker, snare, kick
    if (drumH) {
      const lanes = { hat: 0, snare: 1, kick: 2 }, lh = drumH / 3;
      g2.fillStyle = colors.grid; g2.fillRect(gut, PH, W - gut, 1);
      g2.font = '9px "Space Grotesk", sans-serif'; g2.fillStyle = colors.muted;
      g2.fillText('shk', 8, PH + lh * 0.5); g2.fillText('snr', 8, PH + lh * 1.5); g2.fillText('kick', 8, PH + lh * 2.5);
      g2.font = '11px "Space Grotesk", sans-serif';
      for (const e of bev) {
        if (!(e.kind in lanes) || e.t < t0 || e.t > t1) continue;
        g2.fillStyle = e.kind === 'kick' ? colors['bk-low-edge'] : e.kind === 'snare' ? colors['note-edge'] : colors['bk-edge'];
        const cy = PH + lh * (lanes[e.kind] + 0.5), r = e.kind === 'hat' ? 2 : 3.5;
        g2.beginPath(); g2.arc(X(e.t), cy, r, 0, Math.PI * 2); g2.fill();
      }
    }
    // phrases found in the melody: a light bracket under the chord names
    if (plan && plan.form) for (const ph of plan.form.phrases) {
      const xa = X(beatTime(ph.start)), xb = X(beatTime(ph.end));
      if (xb < gut || xa > W) continue;
      g2.strokeStyle = colors.muted; g2.lineWidth = 1;
      g2.beginPath(); g2.moveTo(xa + 2, 44); g2.lineTo(xa + 2, 40); g2.lineTo(xb - 2, 40); g2.lineTo(xb - 2, 44); g2.stroke();
      g2.fillStyle = colors.muted;
      g2.fillText(ph.label + (ph.role === 'question' ? ' ?' : ph.cadence === 'closed' ? ' .' : ''), xa + 6, 32);
    }
    // section borders and names
    for (const sec of sectionsOf() || []) {
      const x = X(beatTime(sec.from));
      if (x < gut - 1 || x > W) continue;
      g2.fillStyle = colors.text; g2.globalAlpha = 0.55; g2.fillRect(x - 1, 0, 2, PH); g2.globalAlpha = 1;
      g2.font = '600 12px "Space Grotesk", sans-serif'; g2.fillText(sec.name + (sec.mood && MOODS[sec.mood] ? ' · ' + sec.mood : ''), x + 5, 24);
      g2.font = '11px "Space Grotesk", sans-serif';
    }
    // the clean score: one block per note on the beat grid
    for (const n of S.take.score.notes) {
      const s = sStart(n), e = sEnd(n);
      if (e < t0 || s > t1) continue;
      const m = n.midi + T, x0 = X(s), x1 = n.grace ? x0 + Math.max(6, (X(e) - x0) * 0.5) : Math.max(X(e) - 2, x0 + 3), y = Y(m + 0.5) + (n.grace ? rowH * 0.2 : 0);
      g2.fillStyle = colors.note; g2.strokeStyle = colors['note-edge']; g2.lineWidth = 1.25;
      if (degreesOn()) { g2.fillStyle = degColour(m); g2.strokeStyle = degColour(m); g2.globalAlpha = 0.85; }
      g2.beginPath(); g2.roundRect(x0, y + 1, x1 - x0, rowH - 2, Math.min(5, rowH / 3)); g2.fill(); g2.stroke();
      g2.globalAlpha = 1;
      if (ED.sel.has(n)) {
        g2.strokeStyle = colors.text; g2.lineWidth = 2.5;
        g2.beginPath(); g2.roundRect(x0 - 1, y, x1 - x0 + 2, rowH, Math.min(5, rowH / 3)); g2.stroke();
        g2.fillStyle = colors.text; g2.fillRect(x1 - 3, y + rowH * 0.25, 2, rowH * 0.5);
      }
      const next = S.take.score.notes[S.take.score.notes.indexOf(n) + 1];
      if (n.slur && next && S.take.score.detail >= 0.3) {
        const xa = (x0 + x1) / 2, xb = (X(sStart(next)) + Math.max(X(sEnd(next)) - 2, X(sStart(next)) + 3)) / 2;
        const ya = Y(m + 0.5) - 3, yb = Y(next.midi + T + 0.5) - 3, lift = Math.min(18, (xb - xa) * 0.25 + 6);
        g2.strokeStyle = colors.muted; g2.lineWidth = 1.2; g2.beginPath();
        g2.moveTo(xa, ya); g2.quadraticCurveTo((xa + xb) / 2, Math.min(ya, yb) - lift, xb, yb); g2.stroke();
      }
      if (x1 - x0 > 22 && rowH > 10) { g2.fillStyle = degreesOn() ? colors['on-deg'] : n.chromatic ? colors.accent : colors.text; g2.fillText(spell(m, key), x0 + 5, Y(m)); }
    }
    // layers: outlined in their own colour, over the melody so a part sung in unison still shows
    for (const L of S.take.layers || []) {
      const c = colors['layer' + L.colour];
      g2.globalAlpha = L.muted ? 0.3 : 1;
      for (const n of L.notes || []) {
        const s = sStart(n), e = sEnd(n);
        if (e < t0 || s > t1) continue;
        const m = n.midi + T, x0 = X(s), x1 = Math.max(X(e) - 2, x0 + 3), y = Y(m + 0.5);
        g2.fillStyle = c; g2.globalAlpha = L.muted ? 0.06 : 0.16;
        g2.beginPath(); g2.roundRect(x0 - 1.5, y - 0.5, x1 - x0 + 3, rowH + 1, Math.min(6, rowH / 3)); g2.fill();
        g2.globalAlpha = L.muted ? 0.3 : 1; g2.strokeStyle = c; g2.lineWidth = 2; g2.setLineDash([5, 3]); g2.stroke(); g2.setLineDash([]);
      }
      g2.globalAlpha = 1;
    }
  } else {
  // notes
  const list = notes.slice();
  const live = S.recording && !armed() && S.seg && S.seg.live();
  if (live) list.push({ ...live, live: true });
  for (const n of list) {
    const s = n.live ? n.start : noteStart(n), e = n.live ? n.end : noteEnd(n);
    if (e < t0 || s > t1) continue;
    const x0 = X(s), x1 = Math.max(X(e), x0 + 3), base = n.midi + (n.offset || 0), y = Y(base + 0.5);
    g2.fillStyle = colors.note; g2.strokeStyle = colors['note-edge']; g2.lineWidth = 1;
    g2.beginPath(); g2.roundRect(x0, y + 1, x1 - x0, rowH - 2, Math.min(5, rowH / 3)); g2.fill();
    if (!n.live) g2.stroke();
    if (n.bend) {
      const k = (e - s) / Math.max(1e-3, n.end - n.start);
      g2.strokeStyle = colors['note-edge']; g2.lineWidth = 2.5; g2.beginPath();
      n.bend.forEach(([bt, semis], i) => { const x = X(s + (bt - n.start) * k), yy = Y(n.midi + semis); i ? g2.lineTo(x, yy) : g2.moveTo(x, yy); });
      g2.stroke();
    }
    if (x1 - x0 > 28 && rowH > 11) { g2.fillStyle = colors.text; g2.fillText(noteName(n.midi) + (n.live ? '' : tags(n)), x0 + 5, Y(base)); }
  }

  // partials: each kept harmonic as its own line, with its notes; live, the loudest peaks as dots
  if (partialsOn()) {
    const range = +$('prange').value;
    if (tv && S.take.frames) {
      for (const tr of liveTracks()) {
        if (tr.k === 1) continue;
        g2.strokeStyle = colors['note-edge'];
        for (const n of tr.notes) {
          const s = noteStart(n), e = noteEnd(n);
          if (e < t0 || s > t1) continue;
          g2.globalAlpha = 0.25 + 0.75 * Math.max(0, 1 + n.level / range);
          g2.lineWidth = 1; g2.fillStyle = colors.note;
          g2.beginPath(); g2.roundRect(X(s), Y(n.midi + n.offset + 0.3), Math.max(3, X(e) - X(s)), rowH * 0.6, 3); g2.fill(); g2.stroke();
        }
        if (!gridOn()) {
          g2.lineWidth = 1.25; g2.beginPath();
          let on = false, lastM = 0;
          for (const f of S.take.frames) {
            const lv = f.h[tr.k - 1];
            if (!f.f0 || lv < f.top - range || f.t < t0 || f.t > t1) { on = false; continue; }
            const m = hzToMidi(f.hf[tr.k - 1]), x = X(f.t), y = Y(m);
            on && Math.abs(m - lastM) < 2 ? g2.lineTo(x, y) : g2.moveTo(x, y);
            on = true; lastM = m;
          }
          g2.globalAlpha = 0.6; g2.stroke();
        }
        const first = tr.notes.find(n => noteEnd(n) > t0);
        if (first && rowH > 7) {
          g2.globalAlpha = 1; g2.fillStyle = colors.muted;
          g2.fillText('H' + tr.k, Math.max(gut + 2, X(noteStart(first)) - 22), Y(first.midi + first.offset));
        }
      }
      g2.globalAlpha = 1;
    } else if (!tv && S.livePeaks) {
      g2.fillStyle = colors['note-edge'];
      for (const fr of S.livePeaks) {
        if (fr.t < t0) continue;
        for (const [m, rel] of fr.pk) { g2.globalAlpha = 0.15 + 0.6 * Math.max(0, 1 + rel / range); g2.fillRect(X(fr.t) - 1, Y(m) - 1, 3, 3); }
      }
      g2.globalAlpha = 1;
    }
  }

  // auto-tuned pitch, drawn over the sung trace
  const tc = tv && !gridOn() && tuneCurve();
  if (tc) {
    g2.strokeStyle = colors.text; g2.lineWidth = 2; g2.lineJoin = 'round'; g2.beginPath();
    let on = false;
    for (let k = 0; k < tc.m.length; k++) {
      const t = tc.t0 + k * tc.hop;
      if (isNaN(tc.m[k]) || t < t0 || t > t1) { on = false; continue; }
      const x = X(t), y = Y(tc.m[k] + tc.shift[k]);
      on ? g2.lineTo(x, y) : g2.moveTo(x, y);
      on = true;
    }
    g2.stroke();
  }
  // live: what you hear in the headphones
  const liveTune = !tv && S.monitorOn && +$('tune').value > 0;
  if (liveTune) {
    g2.strokeStyle = colors.text; g2.lineWidth = 2; g2.lineJoin = 'round'; g2.beginPath();
    let on = false;
    for (const p of pts) {
      if (p.t < t0 - 0.1 || isNaN(p.m)) { on = false; continue; }
      const x = X(p.t), y = Y(p.m + (p.s || 0));
      on ? g2.lineTo(x, y) : g2.moveTo(x, y);
      on = true;
    }
    g2.stroke();
  }

  // layers: their own sung pitch lines, in their colours
  if (tv) for (const L of S.take.layers || []) {
    g2.strokeStyle = colors['layer' + L.colour]; g2.lineWidth = 2; g2.lineJoin = 'round'; g2.globalAlpha = L.muted ? 0.3 : 0.9;
    let lp = null;
    g2.beginPath();
    for (const p of L.points) {
      if (p.t < t0 - 0.1 || p.t > t1 + 0.1 || isNaN(p.m)) { lp = null; continue; }
      if (lp && Math.abs(p.m - lp.m) <= 3) g2.lineTo(X(p.t), Y(p.m)); else g2.moveTo(X(p.t), Y(p.m));
      lp = p;
    }
    g2.stroke(); g2.globalAlpha = 1;
  }
  // sung pitch trace (thin and faint when the grid or auto-tune line takes over)
  const faint = (tv && (gridOn() || tc)) || liveTune;
  g2.strokeStyle = colors.trace; g2.lineWidth = faint ? 1.25 : 2; g2.lineJoin = 'round';
  g2.globalAlpha = faint ? 0.45 : 1;
  let prev = null;
  const tKey = tonicKey(), coloured = degreesOn() && !faint;
  for (const p of pts) {
    if (p.t < t0 - 0.1) continue;
    if (p.t > t1) break;
    if (isNaN(p.m)) { prev = null; continue; }
    if (prev && Math.abs(p.m - prev.m) <= 3) {
      g2.strokeStyle = coloured ? colors['deg' + degreeOf12(p.m, tKey)] : colors.trace;
      g2.beginPath(); g2.moveTo(X(prev.t), Y(prev.m)); g2.lineTo(X(p.t), Y(p.m)); g2.stroke();
    }
    prev = p;
  }
  g2.globalAlpha = 1;

  }

  // the shaped sung line, when that is what Play plays
  if (tv && S.hear === 'line') {
    const L = sungLine();
    if (L) {
      g2.strokeStyle = colors.text; g2.lineWidth = 2; g2.lineJoin = 'round';
      for (const [s, e] of L.runs) {
        g2.beginPath();
        for (let k = s; k <= e; k++) { const x = X(L.t0 + k * L.hop), y = Y(L.m[k]); k === s ? g2.moveTo(x, y) : g2.lineTo(x, y); }
        g2.stroke();
      }
    }
  }

  if (ED.drag && ED.drag.mode === 'box' && ED.drag.moved) {
    const d = ED.drag;
    g2.strokeStyle = colors.accent; g2.lineWidth = 1; g2.setLineDash([4, 3]);
    g2.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    g2.setLineDash([]);
  }

  // start marker (click the roll to set, double-click to clear)
  if (tv && S.cursor != null && S.cursor >= t0 && S.cursor <= t1) {
    g2.strokeStyle = colors.accent; g2.lineWidth = 1.5; g2.setLineDash([4, 4]);
    g2.beginPath(); g2.moveTo(X(S.cursor), 0); g2.lineTo(X(S.cursor), H); g2.stroke(); g2.setLineDash([]);
    g2.fillStyle = colors.accent; g2.beginPath();
    g2.moveTo(X(S.cursor) - 6, 0); g2.lineTo(X(S.cursor) + 6, 0); g2.lineTo(X(S.cursor), 9); g2.fill();
  }

  // recording over the take: the lead-in shaded, the new singing drawn live in the record colour
  if (armed() && tv && S.recTake) {
    const A = S.recArm, xa = Math.max(gut, X(A.from)), xm = X(A.marker);
    g2.fillStyle = colors.rec; g2.globalAlpha = 0.07; g2.fillRect(xa, 0, Math.max(0, xm - xa), PH); g2.globalAlpha = 1;
    g2.fillRect(xm - 1, 0, 2, PH);
    g2.font = '600 11px "JetBrains Mono", monospace'; const tag = A.kind === 'layer' ? 'REC LAYER' : A.kind === 'next' ? 'REC NEXT PART' : 'REC REDO', tw = g2.measureText(tag).width;
    g2.fillText(tag, xm + 6 + tw < W - 4 ? xm + 6 : xm - 6 - tw, PH - 10);
    g2.font = '11px "Space Grotesk", sans-serif';
    g2.strokeStyle = colors.rec; g2.lineWidth = 2.5; g2.lineJoin = 'round'; g2.beginPath();
    let lp = null;
    for (let i = S.points.length - 1; i >= 0 && S.points[i].t >= S.recTake.start; i--) {
      const p = S.points[i], t = p.t + A.shift;
      if (t < A.marker - 0.15 || isNaN(p.m)) { lp = null; continue; }
      if (lp && Math.abs(p.m - lp.m) <= 3) g2.lineTo(X(t), Y(p.m)); else g2.moveTo(X(t), Y(p.m));
      lp = p;
    }
    g2.stroke();
  }

  // cursor / playhead
  let head = headAt(now);
  // the chord under the playhead while looping, for the readout
  S.curChord = null;
  if (S.play && S.play.loop && plan && head != null) {
    const sg = plan.segs.find(x => head >= beatTime(x.start) && head < beatTime(x.end));
    if (sg) S.curChord = chordFor(plan, sg);
  }
  if (head == null && !tv && S.listening) head = now;
  if (head != null && head >= t0 && head <= t1) {
    g2.fillStyle = armed() ? colors.rec : colors.accent; g2.fillRect(X(head) - 1, 0, 2, H);
    if (S.lastPitch && !S.play && S.listening) { g2.beginPath(); g2.arc(X(head), Y(S.lastPitch.m), 5, 0, Math.PI * 2); g2.fill(); }
  }
  // zoomed in: where the window sits in the whole take
  if (tv && S.view.zoom) {
    const [fa, fb] = fullRange(now), k = (W - gut) / (fb - fa);
    g2.fillStyle = colors.grid; g2.fillRect(gut, H - 4, W - gut, 4);
    g2.fillStyle = colors.muted; g2.fillRect(gut + (t0 - fa) * k, H - 4, Math.max(6, (t1 - t0) * k), 4);
  }
  const em = $('emptyMsg'), empty = !S.take && !S.recording && !S.listening;
  if (em.hidden === empty) em.hidden = !empty;

  showReadout(S.lastPitch);
  drawSpectrum(head);
  requestAnimationFrame(draw);
}

// Spectrum on a log-frequency axis with the voice's harmonics marked: live from the mic,
// or the measured harmonic mix of the note being played back or clicked.
const sc = $('spec'), sg = sc.getContext('2d');
function drawSpectrum(head) {
  const dpr = devicePixelRatio || 1, W = sc.clientWidth, H = sc.clientHeight;
  if (sc.width !== Math.round(W * dpr)) { sc.width = Math.round(W * dpr); sc.height = Math.round(H * dpr); }
  sg.setTransform(dpr, 0, 0, dpr, 0, 0);
  sg.clearRect(0, 0, W, H);
  const fLo = 50, fHi = 6000, PH = H - 14;
  const X = f => Math.log(f / fLo) / Math.log(fHi / fLo) * W;
  const Yd = db => PH - Math.max(0, Math.min(1, (db + 100) / 75)) * PH;
  sg.font = '10px "Space Grotesk", sans-serif'; sg.textBaseline = 'top'; sg.fillStyle = colors.muted;
  for (const [f, s] of [[100, '100'], [1000, '1k'], [4000, '4k']]) { sg.fillRect(X(f), PH, 1, 3); sg.fillText(s, X(f) - 6, PH + 3); }

  let f0 = null, levels = null;
  if (S.listening && S.analyser) {
    S.analyser.getFloatFrequencyData(S.fbuf);
    const binHz = S.ctx.sampleRate / S.analyser.fftSize;
    sg.strokeStyle = colors.muted; sg.globalAlpha = 0.6; sg.lineWidth = 1; sg.beginPath();
    for (let x = 0; x < W; x++) {
      const f = fLo * Math.pow(fHi / fLo, x / W), b = Math.round(f / binHz);
      x ? sg.lineTo(x, Yd(S.fbuf[b])) : sg.moveTo(x, Yd(S.fbuf[b]));
    }
    sg.stroke(); sg.globalAlpha = 1;
    if (partialsOn()) {
      const pk = spectralPeaks(S.fbuf, binHz, 6000, -95).slice(0, 12), range = +$('prange').value;
      const t = S.ctx.currentTime;
      S.livePeaks = (S.livePeaks || []).filter(f => f.t > t - 9);
      if (pk.length) S.livePeaks.push({ t, pk: pk.filter(p => p.level >= pk[0].level - range).map(p => [hzToMidi(p.f), p.level - pk[0].level]) });
    }
    if (S.lastPitch) {
      f0 = S.lastPitch.f; levels = [];
      for (let k = 1; k * f0 < fHi && k <= 24; k++) {
        const b = Math.round(k * f0 / binHz);
        let pk = -200;
        for (let i = b - 2; i <= b + 2; i++) pk = Math.max(pk, S.fbuf[i] ?? -200);
        levels.push(Yd(pk));
      }
    }
  } else {
    let n = null;
    if (S.play && S.take && head != null) n = S.take.notes.find(x => noteStart(x) <= head && noteEnd(x) >= head);
    if (!n && S.harmShow && performance.now() < S.harmShow.until) n = S.harmShow.n;
    if (n && n.harm) {
      f0 = midiToHz(n.midi + (n.offset || 0));
      levels = Array.from(n.harm, h => Yd(20 * Math.log10(Math.max(h, 1e-5)) - 25));
    }
  }
  if (!levels) return;
  sg.fillStyle = sg.strokeStyle = colors.accent; sg.lineWidth = 2;
  levels.forEach((y, i) => {
    const x = X(f0 * (i + 1));
    if (x > W) return;
    sg.beginPath(); sg.moveTo(x, PH); sg.lineTo(x, y); sg.stroke();
    sg.beginPath(); sg.arc(x, y, 2.5, 0, Math.PI * 2); sg.fill();
    if (i < 4) { sg.fillStyle = colors.text; sg.fillText(String(i + 1), x + 3, Math.max(0, y - 2)); sg.fillStyle = colors.accent; }
  });
}
resize();
updateTempo();
loadTake();
listDevices();
requestAnimationFrame(draw);

// ---------- inspector tabs ----------
function showTab(name) {
  if (!document.querySelector(`.pane[data-pane="${name}"]`)) name = 'backing';
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
  try { localStorage.setItem('hum-tab', name); } catch {}
}
$('tabs').onclick = e => { const t = e.target.closest('[data-tab]'); if (t) showTab(t.dataset.tab); };
showTab((() => { try { return localStorage.getItem('hum-tab'); } catch { return null; } })() || 'backing');
$('keysBtn').onclick = () => $('keysDlg').showModal();
// a mouse click leaves no focus behind, so Space keeps meaning Record (keyboard focus still works as usual)
addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b && e.detail > 0 && !b.closest('dialog')) b.blur(); }, true);

addEventListener('keydown', e => {
  if (['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName) || $('keysDlg').open) return;
  if (TAP.on && (e.code === 'Space' || e.key === 't' || e.key === 'T')) { e.preventDefault(); if (!e.repeat) tap(); return; }
  if (e.target.tagName === 'BUTTON' && (e.code === 'Space' || e.key === 'Enter')) return;   // the focused button handles it
  if (editKeys(e)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const modes = { 1: 'new', 2: 'next', 3: 'layer', 4: 'punch' };
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) $('record').click(); }
  else if (e.key === 'p' || e.key === 'Enter') { if (!$('playMain').disabled) { e.preventDefault(); $('playMain').click(); } }
  else if (e.key === 'l') $('loopBtn').click();
  else if (modes[e.key] && !S.recording) { const b = $('recMode').querySelector(`[data-v="${modes[e.key]}"]`); if (!b.disabled) b.click(); }
  else if (e.key === '+' || e.key === '=') zoomBy(1.6);
  else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.6);
  else if (e.key === '0') S.view.zoom = null;
  else if (e.key === '?') $('keysDlg').showModal();
  else if (e.key === 'd') setDrone(!S.droneOn);
  else if (e.key === 'm') setMetro(!metro.on);
  else if (e.key === 'h') setMonitor(!S.monitorOn);
});
updateButtons(); renderParts();
