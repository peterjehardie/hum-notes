Non-binding exploration log: a record of what was tried and dropped. Nothing here is a rule, and it is not read without a request.

## 2026-11-01 · UI redesign, Next part / Layer recording

- Editor column first laid out as a CSS grid with fixed row slots; hidden toolbars (edit bar, groove bar) shifted the rows and the roll collapsed to 180 px. Dropped for a flex column with the roll as the growing item.
- Status line and input meter sat in the same row as the transport buttons; at 1440 px the row wrapped untidily. Moved to a thin second row inside the transport.
- Harmonic lines (H2–H8) as always-open rows under the roll took about a third of the editor height. Folded behind one "Harmonics (n)" toggle in the Parts line.
- Layer notes drawn under the melody vanished when the layer was sung in unison (the fake-mic test does exactly that). Now drawn over the melody as dashed outlines.
- Big tuner note coloured by scale degree: yellow on the light theme was unreadable. The degree colour now shows as an underline.
- The old "Record from marker" button in the edit bar and its separate punch path (score-only, the new audio was kept aside and never played) replaced by the record-mode switch; redo-from-marker now splices the recording and pitch line too.
- First layer was named "Layer 2" (counting the main take as 1); renamed to start at "Layer 1" beside "Main".
- Fonts DM Sans and Source Serif 4 dropped in the move to Space Grotesk + JetBrains Mono.
- Test method used: Chromium with a fake microphone fed by a synthetic hummed WAV (D major, 100 bpm), driven by Playwright through the real buttons and keys.

## 2026-11-01 · Styles

- The Studio direction (electric blue, mono capital labels, lamp switches, bordered panels) read as too technical; wanted something classier and simpler. Not deleted: kept as one of six styles behind a style picker, so looks can be compared side by side. Classic (ink on paper, Instrument Serif headings, black main buttons) became the default.
- Colours per style were first written out by hand (40 tokens × 3 tones); replaced by themes.js working out the derived colours from six base colours per tone, with text pulled darker or lighter until it reaches 4.5:1 contrast.
- The saved look first used the settings key `style`, which the Score tab's Style slider already used; the slider overwrote it on every save. Saved as `look` instead.

## 2026-11-02 · Save as downloads

- Save used to post the take to a local helper server (takes/ folder), so on GitHub Pages it only showed a message. Now Save opens a download menu (MIDI, audio of what Play plays, the raw recording, or all in a zip); the takes-folder save stays as an extra row on localhost only.
- Audio is rendered offline (OfflineAudioContext) through the same scheduling code as Play; the voice-colour wave cache had to become one per audio context for that.

## 2026-11-02 · Play race, open file, backing clean-up

- Play waited (audio engine, samples, mic for Loop) before it counted as playing; a second press in that gap started a second playback and the button kept "Stop" as its label. Now the button changes at once, a press while starting cancels, and Stop fades every playback bus.
- "Try another" (a new arranger seed) was added and taken out again: the seed only moves small decorations and loudness, the bass and counter-melody come out the same, so it changed almost nothing.
- Busy first only reached the bass (and only below the middle); now it scales inner-voice decoration and the counter-melody's quiet-phrase threshold too.
- Writing (arranged / patterns) and Texture were two controls where Texture, Spacing and Register did nothing under Arranged; merged into one Accompaniment control, with the others hidden when they do not apply. Folk, Dramatic and Light moods switched to patterns so their named texture is heard.

## 2026-11-02 · Rhythm and backing round

- The pulse menu first read "Count-in + click / + drums"; with it the transport no longer fitted one row at 1440 px. Shortened to Count-in / Click / Drums (the tooltips say the count-in is included) and "Undo take" to "Undo".
- A test pressed Space right after typing the tempo: Space went into the tempo box, not to Record. That is how text boxes behave, so left as is.
- Drum fills only appear where the tune rests on the beat before a new phrase; the 10-note test tune has none, so fills were only checked by reading the code path, not heard.
- Not done this round: beatbox recorded as a layer over the take, drawing bar lines on the roll, a "Try another" with real variation (needs alternative choices inside the arranger), section repeat/reorder.

## 2026-11-02 · Genre fingerprint

- First built a song lookup ("query by humming"): steps and long-short ratios of the melody, three-step pieces looked up in an index of 31 public-domain tunes, then a note-by-note local alignment; it found the right tune in 124 of 124 simulated hums. Dropped before shipping: the aim was the genre of the melody, not which song it is. The tune data survives only as test melodies for the genre fingerprint (outside the repo).
- Genre fingerprint calibrated on 28 labelled melodies (folk tunes, hymns, classics, made-up blues/jazz/lo-fi/rock/bossa/reggae/dance/ballad/pop lines): an expected genre first in 23, in the top three in 27. A rock riff first came out as pop; a "short repeated riff notes" trait for rock (and "singable note lengths" for pop) fixed it.
- Moods were replaced by genres as the starting point: the old mood names still load as the genre they became (heroic → anthem, dramatic → cinematic, light → children's song, sad → ballad).

## 2026-11-02 · Epic / film theme round

- Asked how an epic, cinematic hum would come out: it was read as anthem or ballad, with pop chords, a piano-like tune, kit drums and a dry sound. Added an Epic / film theme genre (rising fifths and octaves, long notes, wide range, peak late, minor or modal), i–♭VI–♭III–♭VII chord colour, a horn on the tune with cellos an octave below, film drums (low booms with timpani on the key note, toms, swells), a choir in the singer's own voice colour, a Space control (dry / room / plate / hall) and Plays (the tune played 1–3 times, quieter first, the last time a whole step higher).
- First version of the film drums still borrowed the pop kit in three places: the intro (kick and hats), ghost snares in rests, and snare fills (phrase ends, quiet-phrase half-time, section changes). All moved to toms and booms.
- Ballad first won over epic on the test theme (both like long notes); a "few big leaps" trait for ballad separated them.
- Spelling: a C♯ leading note in D minor was shown as D♭ because D minor uses flats; the raised 6th and 7th of a minor key now keep sharps.
- Not done: the MIDI download holds one statement, not the repeats; the whole-step lift only applies to Score playback (a raw voice recording is not pitch-shifted); with no voice colour measured the choir falls back to a plain synth wave.
