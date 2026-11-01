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
