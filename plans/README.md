# Synthesizer Modernization Plans

Generated on 2026-07-16 from commit `468b7b0`. These plans use the current
repository, the local reference codebases listed in `AGENTS.md`, and current
Web Audio documentation as their source of truth.

Execute one plan at a time in the order below. Do not combine them into one
large change. The repository currently has unrelated user changes in
`src/components/dashboard/account-view.tsx`; every executor must preserve them.

## Recommended direction

Keep the next synthesizer on native Web Audio nodes. Native `OscillatorNode`,
`GainNode`, `BiquadFilterNode`, and `StereoPannerNode` are enough for the
high-value upgrade: oscillator mixing and tuning, ADSR envelopes, filtering,
LFO modulation, bounded polyphony, automation, and live/offline parity.

Do not move the synth into an `AudioWorklet` in this project. Reconsider a
worklet only after the product requires oscillator phase reset, pulse-width
modulation, hard sync, audio-rate cross modulation, or a nonlinear filter.
Those features need custom band-limited oscillators and a fixed voice pool;
moving now would add real-time-thread risk without improving the planned v2
feature set.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | Establish a safe synth baseline | P1 | M | none | TODO |
| 002 | Introduce the versioned synth v2 contract | P1 | L | 001 | TODO |
| 003 | Build the shared polyphonic synth voice graph | P1 | L | 002 | TODO |
| 004 | Add instance-scoped synth automation | P2 | L | 003 | TODO |
| 005 | Replace the synth editor with a responsive sound-design UI | P2 | L | 002, 003, 004 | TODO |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED`, `REJECTED`.

## Dependency notes

- Plan 001 adds characterization tests and fixes normalization and envelope
  correctness before the parameter model and engine are expanded.
- Plan 002 owns the persisted contract and migration. No engine or UI work
  should invent parameter shapes independently.
- Plan 003 owns the allocator, preview API, and all sound generation. Live
  playback, MIDI preview, and offline export must call the same voice-building
  primitives.
- Plan 004 depends on stable v2 node bindings from plan 003.
- Plan 005 lands last so every visible control has a working, persisted,
  export-safe, and automatable backend.

## Research summary

Current synth limitations are visible in:

- `packages/shared/src/effects-params.ts:1334-1370`: only two waveforms, gain,
  attack, and release, with no state version.
- `packages/audio-engine/src/synth-runtime.ts:43-290`: unbounded native-node
  voices and immediate parameter writes.
- `packages/audio-engine/src/synth-voice.ts:54-109`: short notes are extended
  to the attack endpoint and can schedule conflicting events.
- `src/hooks/useTimelineMidiOverlay.ts:215-246`: MIDI preview duplicates a
  separate two-oscillator synth that ignores the instrument envelope and any
  future filter or modulation.
- `packages/shared/src/automation-parameters.ts:64-75` and
  `src/hooks/useTimelineAutomationController.ts:392-400`: synth instruments
  are excluded from the existing instrument automation system.
- `src/components/effects/Synth.tsx`: the expanded UI is still a waveform
  selector plus three knobs.

Reusable project capabilities:

- Sampler ADSR, filtering, LFO routing, and polyphony:
  `packages/audio-engine/src/sampler-core.ts` and `sampler-runtime.ts`.
- Instance-scoped instrument automation:
  `packages/shared/src/sampler-automation.ts` and
  `packages/audio-engine/src/automation.ts`.
- Context-agnostic live/offline construction:
  `packages/audio-engine/src/synth-voice.ts` and `export-mixdown.ts`.
- Existing downstream production DSP: Auto Filter, EQ, saturation, chorus,
  ensemble, delay, reverb, dynamics, and spectral processors.

## Authoritative references

- Web Audio API 1.1 editor draft:
  https://webaudio.github.io/web-audio-api/
- MDN AudioParam:
  https://developer.mozilla.org/en-US/docs/Web/API/AudioParam
- MDN OscillatorNode:
  https://developer.mozilla.org/en-US/docs/Web/API/OscillatorNode
- MDN BiquadFilterNode:
  https://developer.mozilla.org/en-US/docs/Web/API/BiquadFilterNode
- MDN AudioWorklet guide:
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Using_AudioWorklet
- Web Audio scheduling:
  https://web.dev/articles/audio-scheduling
- JUCE synthesizer voice allocation reference:
  https://docs.juce.com/master/classjuce_1_1Synthesiser.html

## Findings considered and rejected

- **Immediate AudioWorklet rewrite**: rejected for v2. Native nodes already
  provide browser-optimized, band-limited built-in oscillators and
  sample-accurate `AudioParam` automation. A worklet becomes justified only
  for custom oscillator phase/PWM/sync or nonlinear filter DSP.
- **General graph-wide oversampling**: rejected. Web Audio has no graph-wide
  control, and the v2 graph is linear. Oversampling should be localized to a
  future nonlinear or discontinuous custom processor.
- **Copying the sampler runtime wholesale**: rejected. Reuse or extract small
  source-independent planning helpers, but keep oscillator-specific voice
  construction in synth modules.
- **Generic modulation matrix in v2**: deferred. One typed LFO with explicit
  destinations covers the immediate product need without introducing a
  route compiler, dynamic persistence schema, and per-sample worklet cost.
