# Effects DSP/UI Upgrade Tracker

> Created: 2026-06-19
> Branch target: create a follow-up branch after `eq-reverb-refactor` merges
> Scope: improve EQ/Reverb audio quality, shared effect params, persistence contracts, and device UI.

## Purpose

The Ableton EQ/Reverb refactor was intentionally UI-only. It preserved the current `EqParams`, `ReverbParams`, persistence, and audio engine behavior. This tracker scopes the next phase: fully fledged effect improvements that change both sound and controls.

## Current State

- EQ currently exposes eight bands with `frequency`, `gainDb`, `q`, `enabled`, and `type`.
- Reverb currently exposes only `enabled`, `wet`, `decaySec`, and `preDelayMs`.
- Reverb DSP is a generated noise impulse response feeding a `ConvolverNode`, with dry/wet and pre-delay in `packages/audio-engine/src/effects/chain.ts`.
- Impulse generation is deterministic and bucketed by decay in `packages/audio-engine/src/effects/dsp.ts`.
- Effect params flow through shared types, Convex mutations, local effect rows, shared timeline operations, agent commands, undo history, export mixdown, live mixer, and master FX runtime.

## Goals

- Improve Reverb from a basic convolver into a more controllable musical device.
- Improve EQ behavior and UI polish without breaking existing projects.
- Keep live playback, offline export, track FX, master FX, undo/redo, local projects, shared projects, and agent commands in sync.
- Keep knobs visually immediate during pointer interaction.

## Non-Goals

- Do not add new dependencies unless a measured quality gap requires it.
- Do not change persisted param shapes without migration/backward compatibility.
- Do not ship UI-only controls that do not affect DSP.

## Phase 0: Control Responsiveness

### Work

- Keep `Knob` controlled from parent state while using an optimistic local drag value for immediate arc/indicator/value display.
- Remove transition lag from knob position/fill during pointer movement.
- Validate all existing knob consumers: EQ, Reverb, Synth, Arpeggiator.

### Acceptance

- Dragging a knob updates the visible arc and pointer immediately.
- Parent-owned values still remain the source of truth after interaction.
- `bun run typecheck`, `bun test`, `bun run build`, and `bun run knip` pass.

## Phase 1: Reverb Param Model

### Candidate Params

- `dryWet` or current `wet` compatibility field.
- `decaySec`.
- `preDelayMs`.
- `size`.
- `diffusion`.
- `density`.
- `damping` or `highCutHz`.
- `lowCutHz`.
- `stereoWidth`.
- Optional later controls: `earlyReflections`, `freeze`, `modRate`, `modDepth`.

### Work

- Extend `ReverbParams` with backward-compatible defaults.
- Add normalization helpers so legacy rows missing new fields hydrate safely.
- Update serializers and equality signatures so audio nodes update only when relevant fields change.
- Update Convex effect mutations, server mutations, shared timeline operation readers, agent command schema, undo persistence, local persistence, and export paths.

### Acceptance

- Existing projects without new fields load with defaults.
- Shared and local effect changes preserve undo/redo and offline export parity.
- Agent commands can set the supported Reverb params safely.

## Phase 2: Reverb DSP

### Candidate Architecture

- Keep current convolver path as the compatible baseline.
- Generate richer deterministic stereo impulse responses using new `size`, `density`, `diffusion`, and damping params.
- Add input/output filters for low cut and high cut around the wet path.
- Add width control with stereo wet gain/mid-side shaping where browser support allows.
- Evaluate whether freeze/modulation should be real-time delay-network based rather than convolver-based before adding it.

### Work

- Update `packages/audio-engine/src/effects/dsp.ts` and `effects/chain.ts`.
- Keep offline export and live playback using the same DSP helpers.
- Cache impulse responses with signatures that include only impulse-affecting params.
- Avoid rebuilding expensive buffers for wet-only changes.

### Acceptance

- Live and exported renders use matching Reverb behavior.
- Wet and pre-delay changes remain responsive.
- Impulse regeneration is bounded and deterministic.

## Phase 3: Reverb UI

### Layout

- Keep Ableton-inspired sections:
  - Input Filter
  - Early Reflections
  - Diffusion Network
  - Chorus/Modulation, if implemented
  - Global
  - Output

### Work

- Promote current placeholder visual display into a parameter-aware reverb shape display.
- Add controls only after corresponding DSP fields exist.
- Keep the compact bottom effects panel usable without visible scrollbars.

### Acceptance

- Every visible Reverb control maps to a real persisted param and audible behavior.
- Controls remain usable in `EffectsPanel` for track and master targets.

## Phase 4: EQ Improvements

### Candidate Work

- Add output gain if a real gain node is wired into live and offline paths.
- Add analyzer/spectrum smoothing and more accurate response visualization.
- Add scale/adaptive-Q only if the audio engine semantics are implemented.
- Improve node dragging precision and modifier-key behavior after interaction testing.

### Acceptance

- EQ visual curve better matches actual Biquad behavior.
- New EQ controls have live and offline DSP support before UI exposure.

## Required Validation

Run before each checkpoint:

```bash
bun run typecheck
bun test
bun run knip
```

Run before final completion:

```bash
bun run typecheck
bun test
bun run build
bun run knip
git diff --check
```

## Review Gates

- Run a simplify/code-quality pass after each phase.
- Run a bug-focused review against the merge diff before final merge.
- Confirm no schema or persistence change lacks a backward-compatible reader.
