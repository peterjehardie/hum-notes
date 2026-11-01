// Voice lab: a guided, timed recording session so the voice can be measured part by part.
// Setup (devices, range check) → prompt list (count-in with a reference tone, hold, rest) →
// per-unit checks → save as takes/lab-<stamp>.wav + .json (docs/voice-lab-contract.md §1) →
// optional analysis with voiceprofile.js / profilesynth.js when those exist.
// ?fake=1 swaps the mic for a synthesized voice that follows the prompts (fake=bad adds faults),
// ?bpm=N overrides the tempo (handy for quick tests).

(() => {
const $ = id => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const FAKE = Q.get('fake');

const SOUNDS = ['mm', 'oo', 'oh', 'ah', 'ee'];
const GLIDES = ['oo>ah', 'ah>ee', 'mm>ah'];
const KIND = { mm: 'nasal', oo: 'vowel', oh: 'vowel', ah: 'vowel', ee: 'vowel' };
// rough formants (Hz) for the fake voice, F1 and F2
const FORMANTS = { mm: [250, 1100], oo: [310, 870], oh: [470, 820], ah: [730, 1100], ee: [280, 2250] };
const COUNT = 4, HOLD = 3, REST = 1, BEATS = COUNT + HOLD + REST;

const L = {
  ctx: null, node: null, src: null, stream: null, fake: null,
  plan: [], targets: [], range: { low: 40, high: 57 },
  chunks: [], pending: [], recOn: false, running: false, pauseReq: false,
  cur: null, sel: -1, rms: 0, peak: -100, pitchHook: null,
  sr: 48000, lat: 0, mic: null,
  loaded: null, profile: null, engine: 'envelope', scores: {},
};
window.LAB = L;   // for devtools and tests
document.getElementById('toneHold').onclick = e => { L.toneHold = !L.toneHold; e.target.classList.toggle('on', L.toneHold); };
document.getElementById('toneNow').onclick = async () => {
  await ensureCtx();
  const u = L.cur ? L.plan[L.cur.i] : L.plan.find(p => !p.take) || L.plan[0];
  if (u) { L.toneTarget = u.midi; refTone(u.midi, L.ctx.currentTime + 0.02, L.ctx.currentTime + 1.6); }
};

// ---------- settings: share mic/output/theme with the main app without touching its other fields ----------
function readSettings() { try { return JSON.parse(localStorage.getItem('hum-settings') || '{}'); } catch { return {}; } }
function writeSettings(patch) {
  try { localStorage.setItem('hum-settings', JSON.stringify(Object.assign(readSettings(), patch))); } catch {}
}
function applyTheme(v) {
  HumThemes.apply(readSettings().look || 'classic', v);   // the style is picked in the main app
  for (const b of $('theme').children) b.classList.toggle('on', b.dataset.v === v);
  if (L.profile) drawMap(L.profile);
}
$('theme').onclick = e => { if (e.target.dataset.v) { applyTheme(e.target.dataset.v); writeSettings({ theme: e.target.dataset.v }); } };
{
  const o = readSettings();
  applyTheme(o.theme || 'light');
  for (const f of ['micSel', 'outSel']) if (o[f]) $(f).dataset.want = o[f];
  let lab = {};
  try { lab = JSON.parse(localStorage.getItem('hum-lab') || '{}'); } catch {}
  if (lab.low) $('lowIn').value = lab.low;
  if (lab.high) $('highIn').value = lab.high;
  if (lab.bpm) $('bpmIn').value = lab.bpm;
  L.off = new Set(lab.off || []);
  if (Q.get('bpm')) $('bpmIn').value = Q.get('bpm');
}
function readLab() { try { return JSON.parse(localStorage.getItem('hum-lab') || '{}'); } catch { return {}; } }
function saveLab() {
  try { localStorage.setItem('hum-lab', JSON.stringify({ low: +$('lowIn').value, high: +$('highIn').value, bpm: Q.get('bpm') ? readLab().bpm : +$('bpmIn').value, off: [...L.off] })); } catch {}
}
if (FAKE) $('fakeChip').hidden = false;

// ---------- audio ----------
async function ensureCtx() {
  if (!L.ctx) {
    L.ctx = new AudioContext({ latencyHint: 'interactive' });
    await L.ctx.audioWorklet.addModule('pitch-worklet.js');
    L.sr = L.ctx.sampleRate;
    await applyOutput();
  }
  if (L.ctx.state !== 'running') await L.ctx.resume();
  return L.ctx;
}
async function applyOutput() {
  if (L.ctx && L.ctx.setSinkId) { try { await L.ctx.setSinkId($('outSel').value || ''); } catch {} }
}

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, first) => {
    const keep = sel.value || sel.dataset.want || '';
    sel.innerHTML = '';
    sel.add(new Option(first, ''));
    for (const d of devs) if (d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
      sel.add(new Option(d.label || (kind === 'audioinput' ? 'Microphone' : 'Speaker') + ' ' + sel.length, d.deviceId));
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
  };
  fill($('micSel'), 'audioinput', 'Default mic');
  fill($('outSel'), 'audiooutput', 'Default output');
  const sel = $('outSel').value, d = devs.find(x => x.kind === 'audiooutput' && x.deviceId === (sel || 'default'));
  $('outName').textContent = d && d.label ? 'Sound out: ' + d.label.replace(/^Default - /, '') : '';
  if (!AudioContext.prototype.setSinkId) $('outSel').hidden = true;
}
listDevices();
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
$('micSel').onchange = async () => {
  writeSettings({ micSel: $('micSel').value });
  if (L.node && !L.running) { stopMic(); try { await startMic(); } catch (err) { status('Mic unavailable: ' + err.message); } }
};
$('outSel').onchange = () => { writeSettings({ outSel: $('outSel').value }); applyOutput(); listDevices(); };
$('outTest').onclick = async () => { await ensureCtx(); await applyOutput(); refTone(57, L.ctx.currentTime + 0.02, L.ctx.currentTime + 1.2); };

async function startMic() {
  const ctx = await ensureCtx();
  L.node = new AudioWorkletNode(ctx, 'pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = ctx.createGain(); sink.gain.value = 0;
  L.node.connect(sink).connect(ctx.destination);
  L.node.port.onmessage = e => onWorklet(e.data);
  if (FAKE) {
    L.fake = makeFakeVoice(ctx);
    L.fake.out.connect(L.node);
    L.mic = 'fake voice';
    L.lat = 0;
  } else {
    const dev = $('micSel').value || $('micSel').dataset.want || '';
    L.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, ...(dev ? { deviceId: { exact: dev } } : {}) },
    });
    L.src = ctx.createMediaStreamSource(L.stream);
    L.src.connect(L.node);
    L.mic = L.stream.getAudioTracks()[0]?.label || 'mic';
    // the singer hears the clicks this late, so the voice lands this late on the timeline
    L.lat = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    listDevices();
  }
  $('micBtn').textContent = 'Mic off';
  status(`${L.mic} · ${L.sr} Hz`);
}
function stopMic() {
  L.stream && L.stream.getTracks().forEach(t => t.stop());
  L.src && L.src.disconnect();
  L.fake && L.fake.stop();
  L.node && L.node.disconnect();
  L.node = L.src = L.stream = L.fake = null;
  $('micBtn').textContent = 'Mic on';
}
$('micBtn').onclick = async () => {
  if (L.running) return;
  try { L.node ? stopMic() : await startMic(); } catch (err) { status('Mic unavailable: ' + err.message); }
};
async function needMic() { if (!L.node) await startMic(); }

function onWorklet(d) {
  if (d.audio) { if (L.recOn) { L.chunks.push(d); drainPending(); } return; }
  if (d.recDone) { drainPending(true); return; }
  L.rms = d.rms;
  if (L.pitchHook) L.pitchHook(d);
  const t = performance.now() / 1000;
  L.live = (L.live || []).filter(p => p.t > t - 4);
  L.live.push({ t, m: d.v && d.clarity > 0.8 ? 69 + 12 * Math.log2(d.f / 440) : NaN });
}

// level meter (dBFS of the tracker's rms, with a short peak hold)
function meterLoop() {
  const db = L.node ? 20 * Math.log10(Math.max(L.rms, 1e-6)) : -100;
  L.peak = Math.max(L.peak - 0.6, db);
  const el = $('lvl').firstElementChild;
  el.style.width = Math.max(0, Math.min(100, (L.peak + 70) / 70 * 100)) + '%';
  el.className = L.peak > -6 ? 'hot' : L.peak > -45 ? 'voiced' : '';
  $('lvlTxt').textContent = L.node ? L.peak.toFixed(0) + ' dB' : '– dB';
  drawPrompt();
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

// ---------- fake voice: sawtooth through two formant bandpasses, driven by the prompt schedule ----------
function makeFakeVoice(ctx) {
  const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 110;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 5.5;
  const lfoG = ctx.createGain(); lfoG.gain.value = 0;
  lfo.connect(lfoG).connect(osc.detune);
  const vib = ctx.createGain(); vib.gain.value = 12;     // a little natural vibrato, cents
  lfo.connect(vib).connect(osc.detune);
  const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter();
  for (const f of [f1, f2]) { f.type = 'bandpass'; f.Q.value = 6; }
  f1.frequency.value = 700; f2.frequency.value = 1100;
  const g2 = ctx.createGain(); g2.gain.value = 0.5;
  const env = ctx.createGain(); env.gain.value = 0;
  osc.connect(f1).connect(env); osc.connect(f2).connect(g2).connect(env);
  // a quiet room hiss so the noise floor is something
  const n = ctx.createBufferSource(), nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.0006;
  n.buffer = nb; n.loop = true;
  const out = ctx.createGain();
  env.connect(out); n.connect(out);
  osc.start(); lfo.start(); n.start();
  return {
    osc, lfoG, f1, f2, env, out,
    stop() { osc.stop(); lfo.stop(); n.stop(); out.disconnect(); },
  };
}
// gain that gives roughly -20 dBFS peaks for "soft" and -8 for "loud" through the filters
const FAKE_GAIN = { soft: 0.35, loud: 1.4 };
function fakeSing(u, t, dur, fault) {
  const F = L.fake; if (!F) return;
  const late = 0.12, a = t + late, b = t + dur - 0.05;
  let m = u.midi + (fault === 'flat' ? -1 : 0);
  const hz = midiToHz(m);
  F.osc.frequency.setValueAtTime(hz * Math.pow(2, -0.4 / 12), a);   // a small scoop up to the note
  F.osc.frequency.exponentialRampToValueAtTime(hz, a + 0.12);
  const [s0, s1] = u.sound.split('>');
  const A = FORMANTS[s0], B = FORMANTS[s1 || s0];
  F.f1.frequency.setValueAtTime(A[0], a); F.f2.frequency.setValueAtTime(A[1], a);
  if (s1) { F.f1.frequency.linearRampToValueAtTime(B[0], b); F.f2.frequency.linearRampToValueAtTime(B[1], b); }
  let g = FAKE_GAIN[u.loud] || 0.5;
  if (fault === 'quiet') g *= 0.004;
  if (fault === 'clip') g *= 12;
  if (fault === 'silent') g = 0;
  F.env.gain.setValueAtTime(0, a);
  F.env.gain.linearRampToValueAtTime(g, a + 0.06);
  F.env.gain.setValueAtTime(g, b - 0.06);
  F.env.gain.linearRampToValueAtTime(0, b);
  F.lfoG.gain.setValueAtTime(fault === 'wobble' ? 90 : 0, a);
  F.lfoG.gain.setValueAtTime(0, b);
}
// fake=bad: a fixed set of faults on some units, so every check can be seen firing
const FAULTS = ['flat', 'quiet', 'clip', 'wobble', 'silent'];
function faultFor(i) { return L.noFault ? null : FAKE === 'bad' && i % 6 === 2 ? FAULTS[(i / 6 | 0) % FAULTS.length] : (L.forceFault || {})[i]; }

// ---------- range check ----------
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
$('rangeBtn').onclick = async () => {
  if (L.running) return;
  try { await needMic(); } catch (err) { status('Mic unavailable: ' + err.message); return; }
  const ctx = L.ctx, dur = 6.5, got = [];
  $('rangeBtn').disabled = true;
  if (L.fake) {
    const F = L.fake, t = ctx.currentTime + 0.1;
    F.f1.frequency.setValueAtTime(730, t); F.f2.frequency.setValueAtTime(1100, t);
    F.osc.frequency.setValueAtTime(midiToHz(38), t);
    F.osc.frequency.exponentialRampToValueAtTime(midiToHz(62), t + dur - 0.6);
    F.env.gain.setValueAtTime(0, t); F.env.gain.linearRampToValueAtTime(0.5, t + 0.1);
    F.env.gain.setValueAtTime(0.5, t + dur - 0.6); F.env.gain.linearRampToValueAtTime(0, t + dur - 0.5);
  }
  const t0 = ctx.currentTime;
  L.pitchHook = d => {
    if (d.v && d.clarity > 0.85) {
      const m = hzToMidi(d.f);
      got.push(m);
      $('rangeHint').textContent = `${noteName(Math.round(m))} · ${Math.max(0, dur - (ctx.currentTime - t0)).toFixed(1)} s`;
    }
  };
  await waitCtx(t0 + dur);
  L.pitchHook = null;
  $('rangeBtn').disabled = false;
  if (got.length < 40) { $('rangeHint').textContent = 'Too little voice heard; try again louder.'; return; }
  // robust ends: ignore stray octave jumps and the shaky first/last moments
  const low = Math.round(pct(got, 0.05)), high = Math.round(pct(got, 0.95));
  $('lowIn').value = low; $('highIn').value = Math.max(high, low + 2);
  $('rangeHint').textContent = `${noteName(low)} – ${noteName(high)}`;
  saveLab(); buildPlan();
};

// four targets spread inside the range, keeping off the outer 10% at each end
function pickTargets(low, high) {
  const span = high - low, a = low + 0.1 * span, b = high - 0.1 * span, out = [];
  for (let k = 0; k < 4; k++) {
    const m = Math.round(a + (b - a) * k / 3);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

// ---------- the plan ----------
function beatSec() { return 60 / Math.max(40, Math.min(300, +$('bpmIn').value || 88)); }
function buildPlan() {
  if (L.running) return;
  const low = +$('lowIn').value, high = +$('highIn').value;
  L.range = { low, high };
  $('lowName').textContent = noteName(low); $('highName').textContent = noteName(high);
  L.targets = pickTargets(low, high);
  $('targets').innerHTML = L.targets.map(m => `<span class="chip"><b>${noteName(m)}</b></span>`).join('');
  const plan = [];
  for (const s of SOUNDS) if (!L.off.has(s))
    for (const m of L.targets) for (const loud of ['soft', 'loud'])
      plan.push({ id: `${s}-${m}-${loud}`, sound: s, kind: KIND[s], midi: m, loud });
  if (!L.off.has('glides')) {
    const mid = L.targets[Math.floor((L.targets.length - 1) / 2)];
    for (const g of GLIDES) plan.push({ id: `${g}-${mid}-soft`, sound: g, kind: 'glide', midi: mid, loud: 'soft' });
  }
  // keep takes already made for units that are still in the plan
  const old = new Map(L.plan.map(u => [u.id, u]));
  L.plan = plan.map(u => old.get(u.id) || u);
  L.sel = -1;
  const sec = L.plan.length * BEATS * beatSec();
  $('planInfo').textContent = `${L.plan.length} units · ${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
  renderBlocks(); updateButtons();
}
function renderToggles() {
  $('soundToggles').innerHTML = [...SOUNDS, 'glides'].map(s => `<button class="chip${L.off.has(s) ? ' off' : ''}" data-s="${s}">${s}</button>`).join('');
}
$('soundToggles').onclick = e => {
  const s = e.target.dataset.s; if (!s || L.running) return;
  L.off.has(s) ? L.off.delete(s) : L.off.add(s);
  renderToggles(); saveLab(); buildPlan();
};
for (const id of ['lowIn', 'highIn', 'bpmIn']) $(id).onchange = () => { saveLab(); buildPlan(); };

const loudTag = l => l === 'loud' ? 'L' : 's';
function promptText(u) {
  const verb = u.kind === 'glide' ? 'glide' : 'hold';
  const s = u.kind === 'glide' ? u.sound.replace('>', ' → ') : u.sound;
  return `${verb} <b>${s}</b> <small>· ${noteName(u.midi)} · ${u.loud}</small>`;
}
function renderBlocks() {
  const groups = new Map();
  L.plan.forEach((u, i) => {
    const k = u.kind === 'glide' ? 'glides' : u.sound;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  let h = '';
  for (const [k, idx] of groups) {
    h += `<div class="block"><span class="label">${k}</span>`;
    for (const i of idx) {
      const u = L.plan[i], c = u.check;
      const cls = (c ? (c.ok ? ' ok' : ' fail') : '') + (L.cur && L.cur.i === i ? ' cur' : '') + (L.sel === i ? ' sel' : '');
      const mark = c ? (c.ok ? '✓' : '✕') : '';
      const name = u.kind === 'glide' ? u.sound.replace('>', '→') : noteName(u.midi);
      h += `<button class="chip${cls}" data-i="${i}" title="${c && !c.ok ? c.reason : ''}"><b>${name}</b><span>${u.kind === 'glide' ? noteName(u.midi) : loudTag(u.loud)}</span><i>${mark}</i></button>`;
    }
    h += '</div>';
  }
  $('blocks').innerHTML = h;
  renderDetail();
}
$('blocks').onclick = e => {
  const b = e.target.closest('[data-i]'); if (!b) return;
  L.sel = +b.dataset.i; renderBlocks();
};
function renderDetail() {
  const u = L.plan[L.sel];
  if (!u) { $('detail').innerHTML = ''; return; }
  const c = u.check;
  let h = `<b>${u.id}</b>`;
  if (c) {
    h += c.ok ? ' <span class="good">✓</span>' : ` <span class="bad">✕ ${c.reason}</span>`;
    h += ` <span>peak ${c.peakDb} dB</span><span>noise ${c.noiseDb} dB</span>`;
    h += ` <span>pitch ${c.pitchErrCents == null ? '–' : (c.pitchErrCents > 0 ? '+' : '') + c.pitchErrCents + '¢'}</span>`;
    h += ` <span>steady ${c.steadiness}</span><span>voiced ${Math.round(c.voiced * 100)}%</span>`;
    h += ` <button class="small" id="playSel">▶</button>`;
  }
  h += ` <button class="small" id="redoSel" ${L.running ? 'disabled' : ''}>${c ? 'Redo' : 'Record'}</button>`;
  $('detail').innerHTML = h;
  if ($('playSel')) $('playSel').onclick = () => playUnit(u);
  $('redoSel').onclick = () => runSession([L.sel]);
}

// ---------- session runner ----------
function status(s) { $('sessStatus').textContent = s; }
// waits until the audio clock reaches t (polls; survives background-tab timer throttling)
function waitCtx(t) {
  return new Promise(ok => {
    const tick = () => (L.ctx.currentTime >= t ? ok() : setTimeout(tick, Math.min(50, Math.max(5, (t - L.ctx.currentTime) * 1000))));
    tick();
  });
}

function click(t, accent) {
  const ctx = L.ctx, o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1500 : 1000;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.22, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0005, t + 0.06);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.08);
}
// the target pitch as a soft sine, during the count-in only
// The note to match: a soft reed-like tone (a pure sine is nearly inaudible at low notes,
// the overtones make the pitch clear). `level` lets it sit quietly under the singing.
function refTone(midi, a, b, level = 0.5) {
  level *= Math.pow(+document.getElementById('toneVol').value, 1.5) * 1.6;
  const ctx = L.ctx, g = ctx.createGain(), lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1600; lp.Q.value = 0.4;
  const oscs = [['sawtooth', 0, 0.6], ['triangle', 0, 0.8], ['sine', -1200, 0.5]].map(([type, det, gain]) => {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = type; o.frequency.value = midiToHz(midi); o.detune.value = det; og.gain.value = gain;
    o.connect(og).connect(lp); o.start(a); o.stop(b + 0.05);
    return o;
  });
  g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(level, a + 0.06);
  g.gain.setValueAtTime(level, b - 0.1); g.gain.linearRampToValueAtTime(0, b);
  lp.connect(g).connect(ctx.destination);
  return oscs;
}
L.toneHold = true;

function schedule(i, t0, beat) {
  const u = L.plan[i];
  for (let k = 0; k < COUNT; k++) click(t0 + k * beat, k === 0);
  const refMidi = u.kind === 'glide' ? u.midi : u.midi;
  refTone(refMidi, t0, t0 + COUNT * beat - 0.02);
  // quietly on while singing too (with headphones it stays out of the recording)
  if (L.toneHold) refTone(refMidi, t0 + COUNT * beat - 0.02, t0 + (COUNT + HOLD) * beat, 0.2);
  if (L.fake) fakeSing(u, t0 + COUNT * beat, HOLD * beat, faultFor(i));
}

async function runSession(queue) {
  if (L.running) return;
  try { await needMic(); } catch (err) { status('Mic unavailable: ' + err.message); return; }
  L.noFault = !!queue;
  if (!queue) queue = L.plan.map((u, i) => i).filter(i => !L.plan[i].take);
  if (!queue.length) { status('All units recorded.'); return; }
  const ctx = L.ctx, beat = beatSec();
  L.running = true; L.pauseReq = false; L.chunks = []; L.pending = [];
  L.loaded = null;
  L.recOn = true; L.node.port.postMessage({ rec: true });
  updateButtons();
  let t0 = ctx.currentTime + 0.5;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    if (t0 < ctx.currentTime + 0.05) t0 = ctx.currentTime + 0.15;   // fell behind (tab throttled): leave a gap
    schedule(i, t0, beat);
    L.cur = { i, t0, beat, next: queue[q + 1] };
    renderBlocks();
    await waitCtx(t0 + (COUNT + HOLD - 0.5) * beat);
    L.pending.push({ i, t0, beat });
    t0 += BEATS * beat;
    if (L.pauseReq) break;
  }
  await waitCtx(t0 + 0.05);
  L.recOn = false;
  L.node.port.postMessage({ rec: false });
  // the worklet's last chunk arrives with recDone; wait for the queue to empty
  const until = performance.now() + 3000;
  while (L.pending.length && performance.now() < until) await new Promise(r => setTimeout(r, 30));
  drainPending(true);
  L.cur = null; L.running = false;
  const left = L.plan.filter(u => !u.take).length;
  const bad = L.plan.filter(u => u.check && !u.check.ok).length;
  status(left ? `Paused · ${left} left` : bad ? `Done · ${bad} to redo` : 'Done · all good');
  renderBlocks(); updateButtons(); renderUnitRows();
}

// cut [a, b) in audio-clock seconds out of the recorded chunks
function cutChunks(a, b) {
  const sr = L.sr, n = Math.round((b - a) * sr), out = new Float32Array(n);
  for (const c of L.chunks) {
    const c0 = Math.round((c.t - a) * sr);
    const from = Math.max(0, -c0), to = Math.min(c.audio.length, n - c0);
    if (to > from) out.set(c.audio.subarray(from, to), c0 + from);
  }
  return out;
}
function chunksEnd() { const c = L.chunks[L.chunks.length - 1]; return c ? c.t + c.audio.length / L.sr : -1; }
function drainPending(force) {
  while (L.pending.length) {
    const p = L.pending[0], end = p.t0 + BEATS * p.beat;
    if (!force && chunksEnd() < end) return;
    L.pending.shift();
    const u = L.plan[p.i];
    // a unit's segment runs from the first click to the end of its rest beat
    u.take = cutChunks(p.t0, end);
    u.seg = { sing: COUNT * p.beat + L.lat, hold: HOLD * p.beat, beat: p.beat };
    u.check = checkUnit(u.take, L.sr, u.seg.sing, u.seg.sing + u.seg.hold, u.midi, u.seg.sing + u.seg.hold + 0.25 * p.beat, BEATS * p.beat);
    // drop audio nobody needs any more
    const keep = L.pending.length ? L.pending[0].t0 : end;
    while (L.chunks.length > 1 && L.chunks[0].t + L.chunks[0].audio.length / L.sr < keep - 0.5) L.chunks.shift();
    renderBlocks(); updateButtons();
  }
}

$('startBtn').onclick = () => runSession();
$('redoBadBtn').onclick = () => runSession(L.plan.map((u, i) => i).filter(i => L.plan[i].check && !L.plan[i].check.ok));
$('pauseBtn').onclick = () => { L.pauseReq = true; status('Pausing after this unit…'); };

function updateButtons() {
  const took = L.plan.filter(u => u.take).length;
  $('startBtn').disabled = L.running;
  $('startBtn').textContent = took && took < L.plan.length ? '● Resume' : '● Start';
  if (took === L.plan.length && took && !L.running) $('startBtn').disabled = true;
  $('pauseBtn').disabled = !L.running;
  const bad = L.plan.filter(u => u.check && !u.check.ok).length;
  $('redoBadBtn').hidden = !bad; $('redoBadBtn').disabled = L.running; $('redoBadBtn').textContent = `Redo ✕ ${bad}`;
  $('saveBtn').disabled = L.running || !took;
  $('analyseBtn').disabled = L.running || !(took || L.loaded);
  for (const id of ['rangeBtn', 'lowIn', 'highIn', 'bpmIn']) $(id).disabled = L.running;
}

// the karaoke card
// Pitch window: the target note as a line with a green on-pitch band (±25 cents), your pitch over
// the last 4 seconds, and where you are now in note name and cents.
function drawTuner() {
  const cv = document.getElementById('tuner'); if (!cv) return;
  const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const u = L.cur ? L.plan[L.cur.i] : L.toneTarget != null ? { midi: L.toneTarget } : L.plan.find(p => !p.take);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const txt = document.getElementById('tunerTxt');
  if (!u) { txt.textContent = ''; return; }
  const target = u.midi, span = 150;   // cents shown above and below the target
  const Y = c => H / 2 - (c / span) * (H / 2 - 6);
  g.fillStyle = css('--deg5') || '#788C5D'; g.globalAlpha = 0.22; g.fillRect(0, Y(25), W, Y(-25) - Y(25)); g.globalAlpha = 1;
  g.strokeStyle = css('--muted') || '#888'; g.lineWidth = 1;
  for (const c of [-100, 100]) { g.setLineDash([3, 4]); g.beginPath(); g.moveTo(0, Y(c)); g.lineTo(W, Y(c)); g.stroke(); }
  g.setLineDash([]); g.strokeStyle = css('--text') || '#141413'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke();
  g.font = '12px ' + (css('--ui') || 'sans-serif'); g.fillStyle = css('--muted') || '#888';
  g.fillText(`${noteName(target)} · ${midiToHz(target).toFixed(1)} Hz`, 8, Y(0) - 6);
  g.fillText('+1 semitone', 8, Y(100) - 4); g.fillText('−1 semitone', 8, Y(-100) + 12);
  const now = performance.now() / 1000, pts = L.live || [];
  g.strokeStyle = css('--accent') || '#D97757'; g.lineWidth = 2.5; g.beginPath();
  let pen = false, last = null;
  for (const p of pts) {
    if (isNaN(p.m)) { pen = false; continue; }
    const c = Math.max(-span, Math.min(span, (p.m - target) * 100)), x = W - (now - p.t) / 4 * W;
    pen ? g.lineTo(x, Y(c)) : g.moveTo(x, Y(c)); pen = true; last = p;
  }
  g.stroke();
  if (last && now - last.t < 0.25) {
    const c = (last.m - target) * 100, off = (last.m - target) * 100;
    g.fillStyle = Math.abs(c) <= 25 ? (css('--deg5') || '#788C5D') : (css('--accent') || '#D97757');
    g.beginPath(); g.arc(W - 6, Y(Math.max(-span, Math.min(span, c))), 6, 0, Math.PI * 2); g.fill();
    const n = Math.round(last.m), cents = Math.round((last.m - n) * 100);
    const hint = Math.abs(off) <= 25 ? '✓ on pitch' : off > 0 ? (off > 100 ? 'too high' : 'a bit high') : (off < -100 ? 'too low' : 'a bit low');
    txt.innerHTML = `target <b>${noteName(target)}</b> · you <b>${noteName(n)}</b> ${cents >= 0 ? '+' : ''}${cents}¢ · ${hint}`;
  } else txt.innerHTML = `target <b>${noteName(target)}</b> · ${midiToHz(target).toFixed(1)} Hz`;
}

function drawPrompt() {
  drawTuner();
  const ctx = L.ctx, c = L.cur;
  const done = L.plan.filter(u => u.take).length, n = L.plan.length;
  $('prog').style.width = (n ? done / n * 100 : 0) + '%';
  let left = 0;
  for (const u of L.plan) if (!u.take) left++;
  const sec = left * BEATS * beatSec();
  $('progTxt').textContent = `${done} / ${n} · ${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')} left`;
  if (!c || !ctx) {
    $('cursor').style.left = '0%';
    if (!L.running) {
      const nx = L.plan.find(u => !u.take);
      $('say').innerHTML = nx ? promptText(nx) : n ? 'all done' : 'ready';
      $('phase').className = 'phase';
      $('phase').textContent = nx ? 'Listen to the tone on the count-in, then hold the sound.' : '';
      $('next').innerHTML = '';
    }
    return;
  }
  const u = L.plan[c.i], b = (ctx.currentTime - c.t0) / c.beat;
  $('say').innerHTML = promptText(u);
  $('cursor').style.left = Math.max(0, Math.min(100, b / BEATS * 100)) + '%';
  const ph = $('phase');
  if (b < 0) { ph.className = 'phase'; ph.textContent = 'get ready'; }
  else if (b < COUNT) { ph.className = 'phase'; ph.textContent = `listen · ${Math.floor(b) + 1}`; }
  else if (b < COUNT + HOLD) { ph.className = 'phase sing'; ph.textContent = u.kind === 'glide' ? 'sing · glide slowly' : 'sing · hold it'; }
  else { ph.className = 'phase'; ph.textContent = 'rest · quiet'; }
  const nx = L.plan[c.next];
  $('next').innerHTML = nx ? `next<br><b>${nx.kind === 'glide' ? nx.sound.replace('>', '→') : nx.sound}</b> · ${noteName(nx.midi)} · ${nx.loud}` : 'last one';
}

// ---------- checks ----------
// YIN over the given span, 10 ms hop, input decimated to ~24 kHz. Returns frames {t, m, cl, rms}.
function yinTrack(x, sr, a, b) {
  const dec = sr >= 32000 ? 2 : 1, fs = sr / dec;
  const i0 = Math.max(0, Math.floor(a * sr)), i1 = Math.min(x.length, Math.ceil(b * sr));
  const n = Math.floor((i1 - i0) / dec), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < dec; k++) s += x[i0 + i * dec + k]; y[i] = s / dec; }
  const W = Math.round(0.025 * fs), maxTau = Math.ceil(fs / 60), minTau = Math.floor(fs / 1100), hop = Math.round(0.01 * fs);
  const d = new Float32Array(maxTau + 2), out = [];
  for (let s = 0; s + W + maxTau + 1 < n; s += hop) {
    let e = 0;
    for (let j = 0; j < W; j++) e += y[s + j] * y[s + j];
    const rms = Math.sqrt(e / W);
    let run = 0; d[0] = 1;
    for (let tau = 1; tau <= maxTau; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) { const v = y[s + j] - y[s + j + tau]; acc += v * v; }
      run += acc; d[tau] = run > 0 ? acc * tau / run : 1;
    }
    let tau = -1;
    for (let t = minTau; t < maxTau; t++) if (d[t] < 0.15) { while (t + 1 < maxTau && d[t + 1] < d[t]) t++; tau = t; break; }
    if (tau < 0) { let best = 9; for (let t = minTau; t < maxTau; t++) if (d[t] < best) { best = d[t]; tau = t; } }
    let ft = tau;
    if (tau > 1 && tau < maxTau) { const p = d[tau - 1], q = d[tau], r = d[tau + 1], den = p + r - 2 * q; if (den) ft = tau + (p - r) / (2 * den); }
    out.push({ t: a + (s + W / 2) / fs, m: hzToMidi(fs / ft), cl: 1 - d[tau], rms });
  }
  return out;
}
const dbOf = v => 20 * Math.log10(Math.max(v, 1e-9));
const r1 = v => Math.round(v * 10) / 10;
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

// Checks for one unit. x: the unit's audio, start/end: sung span (s, within x), rest: [restA, restB).
function checkUnit(x, sr, start, end, midi, restA, restB) {
  const i0 = Math.max(0, Math.floor(start * sr)), i1 = Math.min(x.length, Math.floor(end * sr));
  let pk = 0;
  for (let i = i0; i < i1; i++) pk = Math.max(pk, Math.abs(x[i]));
  // background level: the quietest 50 ms blocks of the rest beat (a short echo or speaker
  // delay at the start of the rest doesn't count)
  const blocks = [], bl = Math.round(0.05 * sr);
  for (let a = Math.floor(restA * sr); a + bl <= Math.min(x.length, Math.floor(restB * sr)); a += bl) {
    let e = 0;
    for (let i = a; i < a + bl; i++) e += x[i] * x[i];
    blocks.push(Math.sqrt(e / bl));
  }
  blocks.sort((p, q) => p - q);
  const noise = blocks.length ? blocks[Math.min(1, blocks.length - 1)] : 1e-5;
  // is the reference tone reaching the mic? (it sounds during the rest only through speakers' delay or bleed)
  const restFr = restB - restA > 0.2 ? yinTrack(x, sr, restA, restB) : [];
  const toneFr = restFr.filter(f => f.cl > 0.8 && f.rms > 10 ** (-55 / 20) && Math.abs(((f.m - midi) % 12 + 18) % 12 - 6) < 0.5);
  // the count-in is the clearest test: the tone plays loudly there while you are silent
  const cinFr = start > 0.6 ? yinTrack(x, sr, 0.3, start - 0.1) : [];
  const cinTone = cinFr.filter(f => f.cl > 0.8 && f.rms > 10 ** (-55 / 20) && Math.abs(((f.m - midi) % 12 + 18) % 12 - 6) < 0.5);
  const leak = (restFr.length && toneFr.length / restFr.length > 0.3) || (cinFr.length && cinTone.length / cinFr.length > 0.4);
  const peakDb = r1(dbOf(pk)), noiseDb = r1(dbOf(noise));
  const fr = yinTrack(x, sr, start, end);
  const gate = Math.max(noise * 3, 10 ** (-60 / 20));
  for (const f of fr) f.v = f.cl > 0.75 && f.rms > gate && f.m > 30 && f.m < 90;
  const voiced = fr.length ? fr.filter(f => f.v).length / fr.length : 0;
  const st = steadyStretch(fr);
  const res = { ok: true, peakDb, noiseDb, pitchErrCents: null, steadiness: 0, voiced: Math.round(voiced * 100) / 100 };
  let steadyStart = start + 0.25 * (end - start), steadyEnd = end - 0.25 * (end - start);
  const why = [];
  if (st) {
    steadyStart = st.a; steadyEnd = st.b;
    const ms = st.frames.map(f => f.m), mid = med(ms);
    res.pitchErrCents = Math.round((mid - midi) * 100);
    const sd = Math.sqrt(ms.reduce((s, m) => s + (m - mid) ** 2, 0) / ms.length) * 100;
    res.steadiness = Math.round(Math.max(0, Math.min(1, 1 - sd / 50)) * 100) / 100;
    if (Math.abs(res.pitchErrCents) > 60) why.push(`pitch ${res.pitchErrCents > 0 ? '+' : ''}${res.pitchErrCents}¢`);
    if (st.b - st.a < 0.6) why.push('steady < 0.6 s');
    if (res.steadiness < 0.3) why.push('unsteady');
  } else why.push(voiced < 0.1 ? 'no voice' : voiced > 0.5 ? 'unsteady' : 'no steady part');
  if (peakDb > -1) why.push('clipping');
  if (peakDb < -45) why.push('too quiet');
  if (st && voiced < 0.5) why.push(`voiced ${Math.round(voiced * 100)}%`);
  if (leak) why.push('tone heard in the mic — sound playing on speakers?');
  else if (peakDb - noiseDb < 14 && peakDb >= -45) why.push(`noisy (voice only ${Math.round(peakDb - noiseDb)} dB above the room)`);
  if (why.length) { res.ok = false; res.reason = why.join(', '); }
  res.steadyStart = steadyStart; res.steadyEnd = steadyEnd;
  return res;
}
// longest stable middle stretch: voiced frames close to their local median, short gaps bridged
function steadyStretch(fr) {
  const n = fr.length; if (!n) return null;
  const loc = fr.map((f, i) => {
    const w = []; for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) if (fr[k].v) w.push(fr[k].m);
    return w.length >= 3 ? med(w) : NaN;
  });
  const ok = fr.map((f, i) => f.v && Math.abs(f.m - loc[i]) < 0.3 &&
    !(Math.abs((loc[Math.min(n - 1, i + 3)] ?? NaN) - (loc[Math.max(0, i - 3)] ?? NaN)) > 0.4));
  let best = null, a = -1, gap = 0, last = -1;
  const close = () => { if (a >= 0 && (!best || last - a > best[1] - best[0])) best = [a, last]; };
  for (let i = 0; i < n; i++) {
    if (ok[i]) { if (a < 0) a = i; last = i; gap = 0; }
    else if (a >= 0 && ++gap > 3) { close(); a = -1; gap = 0; }
  }
  close();
  if (!best) return null;
  const frames = fr.slice(best[0], best[1] + 1).filter(f => f.v);
  if (frames.length < 5) return null;
  return { a: fr[best[0]].t - 0.0125, b: fr[best[1]].t + 0.0125, frames };
}

// ---------- assemble + save ----------
function stamp() {
  const d = new Date(), p = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
const r2 = v => Math.round(v * 100) / 100;
// one WAV of every recorded unit's segment in prompt order, and the manifest with times on it
function assemble() {
  const took = L.plan.filter(u => u.take);
  const total = took.reduce((s, u) => s + u.take.length, 0), audio = new Float32Array(total), sr = L.sr;
  const units = [];
  let o = 0;
  for (const u of took) {
    audio.set(u.take, o);
    const t = o / sr, c = u.check;
    const { steadyStart, steadyEnd, reason, voiced, ...check } = c;
    if (reason) check.reason = reason;
    check.voiced = voiced;
    units.push({
      id: u.id, sound: u.sound, kind: u.kind, midi: u.midi, loud: u.loud,
      start: r2(t + u.seg.sing), end: r2(t + u.seg.sing + u.seg.hold),
      steadyStart: r2(t + steadyStart), steadyEnd: r2(t + steadyEnd),
      check,
    });
    o += u.take.length;
  }
  const manifest = {
    version: 1, kind: 'lab-session', sr, seconds: r1(total / sr), mic: L.mic || null,
    range: { low: L.range.low, high: L.range.high }, units,
  };
  return { audio, manifest };
}
$('saveBtn').onclick = async () => {
  const { audio, manifest } = assemble(), name = 'lab-' + stamp();
  $('saveBtn').disabled = true;
  try {
    const r = await fetch(`save/${name}.wav`, { method: 'POST', body: encodeWav(audio, manifest.sr) });
    const j = await fetch(`save/${name}.json`, { method: 'POST', body: JSON.stringify(manifest, null, 1) });
    status(r.ok && j.ok ? `Saved ${name}` : 'Could not save (is serve.py running?)');
    if (r.ok && j.ok) { L.savedAs = name; listSessions(name); }
  } catch { status('Could not save'); }
  updateButtons();
};

// ---------- playback ----------
let playing = null;
async function playBuf(x, sr) {
  const ctx = await ensureCtx();
  if (playing) { try { playing.stop(); } catch {} }
  const b = ctx.createBuffer(1, x.length, sr); b.copyToChannel(x, 0);
  const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start();
  playing = s;
}
function playUnit(u) {
  if (!u.take) return;
  const sr = L.sr, a = Math.floor(u.seg.sing * sr), b = Math.floor((u.seg.sing + u.seg.hold) * sr);
  playBuf(u.take.subarray(a, b), sr);
}

// ---------- results: load sessions, analyse, synth, closeness ----------
// optional modules: the page works without them
function loadScript(src) {
  return new Promise(ok => { const s = document.createElement('script'); s.src = src; s.onload = () => ok(true); s.onerror = () => ok(false); document.head.appendChild(s); });
}
const modsReady = (async () => {
  await loadScript('voicesynth.js');
  await loadScript('voiceprofile.js');
  await loadScript('profilesynth.js');
})();
// the modules are classic scripts, so their functions are global bindings (maybe not on window)
const fns = () => ({
  buildProfile: typeof buildProfile === 'function' ? buildProfile : null,
  renderVowel: typeof renderVowel === 'function' ? renderVowel : null,
  closeness: typeof closeness === 'function' ? closeness : null,
});
const has = name => !!fns()[name];

async function listSessions(pick) {
  try {
    const html = await (await fetch('takes/')).text();
    const names = [...new Set([...html.matchAll(/href="(lab-[A-Za-z0-9_.-]+)\.json"/g)].map(m => m[1]))].sort().reverse();
    $('sessSel').innerHTML = '<option value="">Saved sessions…</option>' + names.map(n => `<option>${n}</option>`).join('');
    if (pick) $('sessSel').value = pick;
  } catch {}
}
listSessions();

async function decodeWav(buf) {
  const ctx = await ensureCtx();
  const ab = await ctx.decodeAudioData(buf);
  // decodeAudioData resamples to the context rate; that rate is what the samples now are
  return { samples: ab.getChannelData(0).slice(), sr: ab.sampleRate };
}
function useLoaded(manifest, wav, name) {
  // times in the manifest are at the file's rate; the decoded audio may be resampled, times stay valid
  L.loaded = { manifest, samples: wav.samples, sr: wav.sr, name };
  L.profile = null; L.scores = {};
  $('maps').hidden = true; $('unitRows').innerHTML = '';
  const bad = manifest.units.filter(u => u.check && !u.check.ok).length;
  $('resStatus').textContent = `${name} · ${manifest.units.length} units · ${r1(manifest.seconds)} s${bad ? ` · ${bad} flagged` : ''}`;
  updateButtons();
  renderUnitRows();
}
$('loadBtn').onclick = async () => {
  const name = $('sessSel').value; if (!name) return;
  try {
    const [m, w] = await Promise.all([fetch(`takes/${name}.json`).then(r => r.json()), fetch(`takes/${name}.wav`).then(r => r.arrayBuffer())]);
    useLoaded(m, await decodeWav(w), name);
  } catch (err) { $('resStatus').textContent = 'Could not load: ' + err.message; }
};
$('fileIn').onchange = async () => {
  const fs = [...$('fileIn').files], j = fs.find(f => f.name.endsWith('.json')), w = fs.find(f => f.name.endsWith('.wav'));
  if (!j || !w) { $('resStatus').textContent = 'Pick both the .json and the .wav'; return; }
  try { useLoaded(JSON.parse(await j.text()), await decodeWav(await w.arrayBuffer()), j.name.replace(/\.json$/, '')); }
  catch (err) { $('resStatus').textContent = 'Could not load: ' + err.message; }
};

// the session to analyse: a loaded one, else the one just recorded
function currentSession() {
  if (L.loaded) return L.loaded;
  const { audio, manifest } = assemble();
  return { manifest, samples: audio, sr: L.sr, name: L.savedAs || 'this session' };
}
// units for buildProfile: each unit's sung span cut out; t0 is the session time of samples[0],
// so the manifest's own times stay as they are
function unitAudio(sess, u, a = u.start, b = u.end) {
  const sr = sess.sr;
  return sess.samples.slice(Math.max(0, Math.floor(a * sr)), Math.min(sess.samples.length, Math.floor(b * sr)));
}
function profileUnits(sess) {
  return sess.manifest.units.filter(u => !u.check || u.check.ok).map(u => ({
    unit: u, samples: unitAudio(sess, u), sr: sess.sr, t0: Math.floor(u.start * sess.sr) / sess.sr,
  }));
}

$('analyseBtn').onclick = async () => {
  await modsReady;
  if (!has('buildProfile')) { $('resStatus').textContent = 'analysis not available yet'; renderUnitRows(); return; }
  const sess = currentSession();
  $('resStatus').textContent = 'Analysing…';
  await new Promise(r => setTimeout(r, 20));
  try {
    const p = await fns().buildProfile(profileUnits(sess), { sources: [sess.name], range: sess.manifest.range });
    p.sources = p.sources && p.sources.length ? p.sources : [sess.name];
    if (!p.range) p.range = sess.manifest.range;
    L.profile = p; L.scores = {};
    drawMap(p); renderTables(p); renderUnitRows();
    $('maps').hidden = false;
    const body = JSON.stringify(p, null, 1);
    const a = await fetch('save/voice-profile.json', { method: 'POST', body });
    await fetch(`save/voice-profile-${stamp()}.json`, { method: 'POST', body });
    $('resStatus').textContent = `${sess.name} · profile ${a.ok ? 'saved' : 'not saved'} · ${Object.keys(p.sounds || {}).length} sounds${has('renderVowel') ? '' : ' · synth not available yet'}`;
  } catch (err) { $('resStatus').textContent = 'Analysis failed: ' + err.message; console.error(err); }
};
$('engine').onclick = e => {
  const v = e.target.dataset.v; if (!v) return;
  L.engine = v;
  for (const b of $('engine').children) b.classList.toggle('on', b.dataset.v === v);
  L.scores = {}; renderUnitRows();
};

const SOUND_COLOR = { mm: '--deg4', oo: '--deg2', oh: '--deg6', ah: '--deg1', ee: '--deg5', nn: '--deg7', ng: '--deg3' };
const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const colorOf = s => cssVar(SOUND_COLOR[s] || '--deg0');

// vowel map: F2 left-to-right high→low, F1 top-to-bottom low→high (the usual vowel chart orientation)
function drawMap(p) {
  const W = 420, H = 300, pad = 34;
  const x = f2 => pad + (1 - (Math.log(f2) - Math.log(600)) / (Math.log(3000) - Math.log(600))) * (W - pad - 10);
  const y = f1 => 10 + (Math.log(f1) - Math.log(180)) / (Math.log(1100) - Math.log(180)) * (H - pad - 10);
  let g = '';
  for (const f of [800, 1000, 1500, 2000, 2500]) g += `<line x1="${x(f)}" x2="${x(f)}" y1="10" y2="${H - pad}" stroke="var(--grid)"/><text x="${x(f)}" y="${H - pad + 13}" text-anchor="middle">${f}</text>`;
  for (const f of [200, 300, 500, 700, 1000]) g += `<line x1="${pad}" x2="${W - 10}" y1="${y(f)}" y2="${y(f)}" stroke="var(--grid)"/><text x="${pad - 4}" y="${y(f) + 3}" text-anchor="end">${f}</text>`;
  g += `<text x="${(W + pad) / 2}" y="${H - 6}" text-anchor="middle">F2 Hz</text><text x="10" y="${(H - pad) / 2}" transform="rotate(-90 10 ${(H - pad) / 2})" text-anchor="middle">F1 Hz</text>`;
  let dots = '', legend = '';
  for (const [s, v] of Object.entries(p.sounds || {})) {
    if (s.includes('>') || v.kind === 'glide') continue;
    const c = colorOf(s);
    legend += `<span class="chip"><i class="dot" style="background:${c}"></i>${s}</span> `;
    for (const e of v.entries || []) {
      const F = e.formants || [];
      if (!(F[0] && F[1] && F[0].f > 0 && F[1].f > 0)) continue;
      const cx = Math.max(pad, Math.min(W - 10, x(F[1].f))), cy = Math.max(10, Math.min(H - pad, y(F[0].f)));
      dots += `<circle cx="${cx}" cy="${cy}" r="${e.loud === 'loud' ? 5.5 : 4}" fill="${c}" fill-opacity="${e.loud === 'loud' ? 0.9 : 0.55}" stroke="${c}"><title>${s} ${noteName(Math.round(e.midi))} ${e.loud}: F1 ${Math.round(F[0].f)}, F2 ${Math.round(F[1].f)}</title></circle>`;
    }
  }
  $('vmap').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}${dots}</svg><div class="row" style="padding:6px 8px">${legend}</div>`;
}
function renderTables(p) {
  const f = v => v == null || !isFinite(v) ? '–' : Math.round(v);
  const d1 = v => v == null || !isFinite(v) ? '–' : (+v).toFixed(1);
  const d3 = v => v == null || !isFinite(v) ? '–' : (+v).toFixed(3);
  let h = '';
  for (const [s, v] of Object.entries(p.sounds || {})) {
    h += `<table><caption><i class="dot" style="background:${colorOf(s)}"></i>${s} <span class="hint">${v.kind || ''}</span></caption>
      <tr><th>note</th><th>loud</th><th>f0</th><th>level</th><th>F1</th><th>F2</th><th>F3</th><th>tilt</th><th>H1–H2</th><th>OQ</th><th>jitter</th><th>shimmer</th></tr>`;
    for (const e of (v.entries || []).slice().sort((a, b) => a.midi - b.midi || (a.loud > b.loud ? 1 : -1))) {
      const F = e.formants || [], S = e.source || {};
      h += `<tr><td>${noteName(Math.round(e.midi))}</td><td>${e.loud}</td><td>${d1(e.f0)}</td><td>${d1(e.levelDb)}</td><td>${f(F[0]?.f)}</td><td>${f(F[1]?.f)}</td><td>${f(F[2]?.f)}</td><td>${d1(S.tilt)}</td><td>${d1(S.h1h2)}</td><td>${S.oq == null ? '–' : (+S.oq).toFixed(2)}</td><td>${d3(e.jitter)}</td><td>${d3(e.shimmer)}</td></tr>`;
    }
    h += '</table>';
  }
  $('tables').innerHTML = h;
}

function synthFor(u, sr) {
  return fns().renderVowel(L.profile, { sound: u.sound, midi: u.midi, dur: Math.max(0.3, u.end - u.start), loud: u.loud === 'loud' ? 0.9 : 0.4, vibrato: 0, engine: L.engine, sr, seed: 1 });
}
function renderUnitRows() {
  const sess = L.loaded || (L.plan.some(u => u.take) ? true : null);
  if (!sess) { $('unitRows').innerHTML = ''; return; }
  const units = L.loaded ? L.loaded.manifest.units : assemble().manifest.units;
  const synthOk = L.profile && has('renderVowel'), scoreOk = synthOk && has('closeness');
  $('scoreAllBtn').disabled = !scoreOk;
  let h = `<table><tr><th>unit</th><th>check</th><th></th><th></th><th>score</th><th>parts</th></tr>`;
  units.forEach((u, i) => {
    const c = u.check || {}, sc = L.scores[u.id];
    const parts = sc && sc.parts ? Object.entries(sc.parts).map(([k, v]) => `${k} ${typeof v === 'number' ? v.toFixed(1) : v}`).join(' · ') : '';
    h += `<tr><td>${u.id}</td><td>${c.ok === false ? `<span style="color:var(--bad)">✕ ${c.reason || ''}</span>` : '<span style="color:var(--good)">✓</span>'}</td>
      <td><button data-real="${i}">▶ Real</button></td>
      <td>${synthOk ? `<button data-synth="${i}">▶ Synth</button>` : ''}</td>
      <td class="score">${sc ? Math.round(sc.score) : scoreOk ? `<button data-score="${i}">score</button>` : ''}</td><td class="hint">${parts}</td></tr>`;
  });
  h += '</table>';
  if (!L.profile) h = `<div class="hint">${L.profile === null && !has('buildProfile') && modsChecked ? 'analysis not available yet' : ''}</div>` + h;
  $('unitRows').innerHTML = h;
}
let modsChecked = false;
modsReady.then(() => { modsChecked = true; if (!has('buildProfile')) $('resStatus').textContent ||= 'analysis not available yet'; renderUnitRows(); });

function sessionUnits() { const s = currentSession(); return { s, units: s.manifest.units }; }
$('unitRows').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  const { s, units } = sessionUnits();
  if (b.dataset.real != null) { const u = units[+b.dataset.real]; playBuf(unitAudio(s, u), s.sr); }
  if (b.dataset.synth != null) { const u = units[+b.dataset.synth]; playBuf(synthFor(u, s.sr), s.sr); }
  if (b.dataset.score != null) { await scoreUnit(s, units[+b.dataset.score]); renderUnitRows(); }
};
async function scoreUnit(s, u) {
  try {
    const real = unitAudio(s, u, u.steadyStart, u.steadyEnd);
    const synth = fns().renderVowel(L.profile, { sound: u.sound, midi: u.midi, dur: Math.max(0.3, u.steadyEnd - u.steadyStart), loud: u.loud === 'loud' ? 0.9 : 0.4, vibrato: 0, morph: 0.5, engine: L.engine, sr: s.sr, seed: 1 });
    L.scores[u.id] = await fns().closeness(real, synth, s.sr);
  } catch (err) { L.scores[u.id] = { score: NaN, parts: { error: err.message } }; }
}
$('scoreAllBtn').onclick = async () => {
  const { s, units } = sessionUnits();
  $('scoreAllBtn').disabled = true;
  let sum = 0, n = 0;
  for (const u of units) {
    if (u.check && !u.check.ok) continue;
    await scoreUnit(s, u);
    const v = L.scores[u.id].score; if (isFinite(v)) { sum += v; n++; }
    $('resStatus').textContent = `scoring ${n} / ${units.length}`;
    await new Promise(r => setTimeout(r, 0));
  }
  $('resStatus').textContent = `${L.engine} · mean score ${n ? Math.round(sum / n) : '–'} over ${n} units`;
  renderUnitRows();
};

renderToggles();
buildPlan();
})();
