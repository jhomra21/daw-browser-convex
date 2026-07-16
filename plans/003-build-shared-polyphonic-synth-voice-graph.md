# Plan 003: Build the shared polyphonic synth voice graph

> **Executor instructions**: Complete plans 001 and 002 first. This plan owns
> the audio graph and voice lifecycle. Live playback, live MIDI preview, and
> offline export must not implement separate synth graphs.
>
> **Drift check**:
> `git diff --stat 468b7b0..HEAD -- packages/audio-engine/src/synth-voice.ts packages/audio-engine/src/synth-runtime.ts packages/audio-engine/src/instrument-runtime.ts packages/audio-engine/src/audio-engine.ts packages/audio-engine/src/export-mixdown.ts packages/audio-engine/src/sampler-core.ts packages/audio-engine/src/sampler-runtime.ts`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/002-introduce-versioned-synth-v2-contract.md`
- **Category**: engine, performance
- **Planned at**: commit `468b7b0`, 2026-07-16

## Why this matters

The upgraded parameter model is useful only if every playback path produces
the same sound and remains bounded under dense MIDI. The current runtime has
unbounded scheduled nodes, only attack/release, and duplicated preview logic.
This plan introduces ADSR, per-oscillator tuning/mix, filtering, LFO, panning,
and deterministic voice stealing while preserving native Web Audio
optimization.

## Architecture

Keep `synth-voice.ts` context-agnostic by accepting `BaseAudioContext` and
returning a voice handle. Split pure planning from node construction.

Suggested types:

```ts
type SynthVoicePlan = {
  frequencyHz: number
  oscillatorFrequenciesHz: readonly [number, number]
  oscillatorDetunesCents: readonly [number, number]
  oscillatorLevels: readonly [number, number]
  velocityGain: number
  ampEnvelope: EnvelopePlan
  filterEnvelope: EnvelopePlan
  filterBaseHz: number
  filterPeakHz: number
  endTime: number
}

type SynthVoiceHandle = {
  id: number
  noteInstanceId: number
  pitch: number
  clipId?: string
  stage: 'attack' | 'decay' | 'sustain' | 'release'
  startedAt: number
  scheduledStartTime: number
  releaseTime: number
  effectiveEndTime: number
  releaseStartedAt?: number
  sources: OscillatorNode[]
  amplitude: GainNode
  filter: BiquadFilterNode
  output: GainNode
  nodes: AudioNode[]
  stop: (when: number) => void
}
```

Graph:

```text
oscillator 1 -> level gain --\
                              -> filter -> amp envelope -> pan -> voice output
oscillator 2 -> level gain --/

LFO -> pitch depth gains -> oscillator.detune
LFO -> filter depth gain -> filter.frequency
LFO -> amp depth gain -> amp envelope gain
LFO -> pan depth gain -> pan.pan
```

The per-track output gain remains outside voices. Smooth live changes to track
gain with `setTargetAtTime`, never direct `.value` assignment.

## Voice semantics

- Voice identity is a monotonically increasing note-instance ID, not pitch.
- When `retrigger` is true, overlapping same-pitch note-ons create independent
  voices and restart their envelopes.
- When `retrigger` is false, use one documented legato policy: reuse the
  currently sounding same-pitch voice and do not restart its envelope. If no
  same-pitch voice sounds at the new note's start time, create a voice.
- Voice release begins at MIDI note-off and ends after amp release.
- A stale note-off must not stop a newer same-pitch voice.
- Polyphony counts voices sounding at each note's scheduled start time, not all
  handles created in the rolling 30-second scheduling horizon.
- Allocation order: idle capacity, quietest release voice, oldest release
  voice, then oldest active voice. Since native AudioParams do not expose
  current computed values reliably, calculate estimated amplitude from the
  pure envelope plan.
- Forced stealing uses the same 6 ms fade as sampler termination.
- A future note may steal only a voice whose sounding interval overlaps that
  future note's start time. Schedule the victim fade and oscillator stops at
  that future time, never immediately while constructing the graph.

## Scope

**In scope**

- `packages/audio-engine/src/synth-voice.ts`
- `packages/audio-engine/src/synth-voice.test.ts`
- `packages/audio-engine/src/synth-runtime.ts`
- `packages/audio-engine/src/synth-runtime.test.ts`
- `packages/audio-engine/src/instrument-runtime.ts`
- `packages/audio-engine/src/audio-engine.ts`
- `packages/audio-engine/src/export-mixdown.ts`
- `packages/audio-engine/src/export-mixdown.test.ts`
- `packages/audio-engine/src/browser-characterization.ts`
- `packages/audio-engine/src/browser-characterization.test.ts`
- `src/hooks/useTimelineMidiOverlay.ts` only if plan 001 left adapter cleanup.

**Out of scope**

- AudioWorklet synth.
- PWM, hard sync, FM, noise, user wavetables, nonlinear filters.
- Generic modulation matrix.
- UI changes.
- Automation timeline support, except stable AudioParam bindings for plan 004.
- Refactoring the sampler unless a tiny pure envelope helper can be extracted
  without changing sampler behavior.

## Steps

### Step 1: Implement pure pitch and envelope planning

Use:

```ts
const midiPitchFrequency = (pitch: number) =>
  440 * 2 ** ((pitch - 69) / 12)

const transposeFrequency = (
  baseHz: number,
  octave: number,
  semitone: number,
  detuneCents: number,
) => baseHz * 2 ** ((octave * 12 + semitone + detuneCents / 100) / 12)
```

Create an ADSR planner that supports note-off during attack or decay and can
estimate amplitude at any context time. Store times in seconds. Do not use the
UI's curve drawing as DSP logic.

Use exponential-style segments with a positive floor and an explicit final
zero. Document whether each parameter is a duration. Do not use
`setTargetAtTime` as if its time constant were a segment duration.

### Step 2: Build one context-agnostic voice

Create both oscillators even when waveforms match because v2 gives each
independent tune and level. Skip an oscillator only when its normalized level
is exactly zero.

Apply:

- per-oscillator frequency and detune;
- per-oscillator level gain;
- velocity to the amp peak;
- amp ADSR;
- filter type, cutoff, Q, key tracking, and filter ADSR;
- output pan;
- LFO routes only when enabled and depth is non-zero.

Clamp final cutoff to `[20, min(20_000, sampleRate * 0.45)]`.
Schedule base cutoff in hertz on `filter.frequency`. Convert filter envelope
and LFO octave offsets to cents and route them to `filter.detune`:

```ts
const detuneCents = octaveOffset * 1200
```

Do not connect octave-valued signals directly to a hertz-valued AudioParam.

Return direct bindings for continuous parameters:

```ts
type SynthVoiceBindings = {
  oscillatorLevels: readonly [AudioParam, AudioParam]
  oscillatorDetunes: readonly [AudioParam, AudioParam]
  filterFrequency: AudioParam
  filterDetune: AudioParam
  filterQ: AudioParam
  outputGain: AudioParam
  outputPan: AudioParam
  lfoRate?: AudioParam
  lfoDepths: Partial<Record<SynthLfoDestination, AudioParam>>
}
```

### Step 3: Implement the track voice allocator

Keep one `TrackSynthRuntimeState` per track:

```ts
type TrackSynthRuntimeState = {
  instanceId: string
  params: SynthParams
  output: GainNode
  voices: SynthVoiceHandle[]
  nextVoiceId: number
  previewVoicesByPitch: Map<number, SynthVoiceHandle[]>
}
```

Avoid scanning unrelated tracks. Selection may scan at most the bounded
per-track voice list, which is acceptable at 128 voices.

Parameter updates:

- waveform changes apply to active oscillators if supported safely;
- output gain and pan ramp over 10 to 20 ms;
- oscillator level, detune, cutoff, Q, LFO rate, and LFO depths ramp over a
  short smoothing interval;
- ADSR and polyphony changes affect new notes only;
- reducing polyphony terminates lowest-priority excess voices;
- discrete filter-mode changes affect active filters immediately, with the
  accepted limitation that type switching itself is not crossfaded.

### Step 4: Use one trigger API for playback and preview

Expose runtime operations around note instances:

```ts
triggerNote({
  trackId,
  pitch,
  velocity,
  when,
  durationSec,
  clipId,
  timelineStartSec,
}): number | undefined

releasePreviewNote(trackId, noteInstanceId, when): void
```

MIDI preview should retain the returned note-instance ID. Do not key only by
pitch when multiple keyboard inputs can overlap.
Replace both one-shot audition and held-keyboard synth paths in
`useTimelineMidiOverlay.ts`; neither may construct oscillators directly.

### Step 5: Reuse voice construction in offline export

Extract `scheduleSynthVoice` so it accepts `BaseAudioContext` and destination.
Both live runtime and `renderOfflineSynthEvents` call it.

Offline rendering must apply the same:

- oscillator tuning and levels;
- ADSR;
- filter and filter envelope;
- LFO;
- pan;
- velocity;
- voice count and deterministic stealing policy.

Do not create an offline-only approximation.
Simulate allocation in chronological note-start order. Every voice handle must
record scheduled start time, release time, and effective end time so overlap is
computed at the event time rather than from the number of allocated handles.

### Step 6: Add focused and browser-backed tests

Pure tests:

- MIDI pitch and transposition;
- ADSR interruption in every stage;
- filter cutoff clamping at 44.1, 48, 96, and 192 kHz;
- voice allocation/stealing;
- dense future-scheduled chords do not steal currently sounding notes before
  the future chord starts;
- same-pitch note-instance correctness;
- normalized graph omits zero-depth LFO routes.

Runtime fake-node tests:

- active updates use scheduled ramps;
- cleanup removes every source and node;
- stop clip scopes by clip;
- preview and scheduled notes share allocator budget.

Offline/browser characterization:

- no non-finite samples;
- no significant DC offset;
- attack, decay, sustain, and release timing within tolerance;
- low-pass patch reduces high-frequency energy;
- oscillator transpose changes fundamental as expected;
- max-polyphony stress completes at 44.1, 48, and 96 kHz.

Use numeric/spectral tolerances, not bit-exact buffers.

## Verification

```sh
bun test packages/audio-engine/src/synth-voice.test.ts \
  packages/audio-engine/src/synth-runtime.test.ts \
  packages/audio-engine/src/export-mixdown.test.ts \
  packages/audio-engine/src/browser-characterization.test.ts
bun test
bun run typecheck
bun run lint
bun run knip
```

## Done criteria

- [ ] Live, preview, and export use one voice builder.
- [ ] ADSR, oscillator mix/tune, filter, LFO, pan, and gain are audible.
- [ ] Per-track polyphony is enforced deterministically.
- [ ] Same-pitch note instances cannot release each other incorrectly.
- [ ] Continuous active-voice changes are smoothed.
- [ ] Every voice and modulation node cleans up.
- [ ] Offline characterization passes at multiple sample rates.
- [ ] Full validators pass.

## STOP conditions

- Native-node scheduling cannot express the agreed envelope retrigger behavior.
- A requested feature requires oscillator phase reset, PWM, sync, or nonlinear
  feedback. Stop and propose a separate AudioWorklet design.
- Offline and live paths require different parameter semantics.
- Performance characterization shows native-node v2 cannot sustain 32 voices
  at 48 kHz on the project's supported baseline device.

## Maintenance notes

The Web Audio spec currently uses 128-frame render quanta, but code must not
embed that size as an invariant. If a future worklet is introduced, preallocate
all voice state and handle both one-value and block-length AudioParam arrays.
