# Live notes E2E

Real useTimelinePlayback and useTimelineMidiOverlay, the real portable controller and the real WASM core on a real AudioContext in Chromium, with the transport stopped.
Each note is an audition of 0.6 s. Output is a pass-through worklet tap on the context destination; a block is sound above 0.0001 and silent at or below 0.000001.
Each case checks that the output was silent before the note, sounds while the note is held, and is silent from 1.2 s after the release. A Drum Rack pad plays a 0.15 s one-shot (pads 36 and 37), so its check is that the sound ends on its own inside the audition.
The first note of a cold case follows the mount at once, and the engine has no audio context yet: its first audio builds one. A prepared case opens the instrument panel first, which builds the context and the paused session.

Latency is note-on call to the first non-zero output block, as render ms / wall ms. **Provisional**: measured while other work may have been using the CPU.

| Instrument | Cold: first note | Cold: second note | Prepared: first note | Prepared: second note |
| --- | --- | --- | --- | --- |
| synth | 53.3 / 58.6 | 0.0 / 5.3 | 0.0 / 2.3 | 2.7 / 5.5 |
| sampler | 42.7 / 48.3 | 2.7 / 5.6 | 0.0 / 2.8 | 2.7 / 5.5 |
| drum-rack | 42.7 / 48.1 | 2.7 / 5.5 | 0.0 / 4.1 | 0.0 / 5.4 |
| granular | 37.3 / 42.8 | 16.0 / 21.4 | 0.0 / 2.6 | 64.0 / 69.3 |

Cold: nothing prepared, the note carries the transport and waits for the session. Prepared: the instrument panel opened first and the paused session was ready before the note.

Checks: 40 of 40 passed.
