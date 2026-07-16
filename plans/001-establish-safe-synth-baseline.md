# Plan 001: Establish a safe synth baseline

> **Executor instructions**: Follow every step and verification gate. Preserve
> unrelated working-tree changes, especially
> `src/components/dashboard/account-view.tsx`. Do not start the v2 feature
> work in this plan.
>
> **Drift check**:
> `git diff --stat 468b7b0..HEAD -- packages/shared/src/effects-params.ts packages/shared/src/instrument-params.ts packages/audio-engine/src/synth-voice.ts packages/audio-engine/src/synth-runtime.ts packages/audio-engine/src/export-mixdown.ts src/hooks/useTimelineMidiOverlay.ts`
>
> If these files changed, compare the current code with the evidence below.
> Stop if the described bugs or integration seams no longer exist.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: correctness, tests
- **Planned at**: commit `468b7b0`, 2026-07-16

## Why this matters

The current synth has no focused tests, accepts non-finite persisted values,
extends notes shorter than their attack, has no voice limit, and implements
MIDI preview through a separate sound path. Expanding the synth before these
behaviors are characterized would make live/export parity and regressions hard
to reason about. The allocator and preview replacement belong to plan 003, so
this baseline must not introduce temporary APIs that will immediately be
discarded.

## Current state

- `packages/shared/src/effects-params.ts:1334-1370` normalizes synth numbers
  with `typeof value === "number"`, which accepts `NaN` and infinities.
- `packages/shared/src/instrument-params.ts:119-130` has the same issue while
  reading unknown persisted state.
- `packages/audio-engine/src/synth-voice.ts:54-75` forces `endTime` to occur no
  earlier than the full attack.
- `packages/audio-engine/src/synth-runtime.ts:225-290` creates unbounded
  oscillator/gain graphs.
- `src/hooks/useTimelineMidiOverlay.ts:215-246` creates two oscillators directly
  instead of asking the instrument runtime to preview a note.
- There is no `synth-voice.test.ts` or `synth-runtime.test.ts`.

Follow existing patterns:

- Finite normalization: `packages/shared/src/sampler-params.ts:60-61`.
- Pure timing plans: `packages/audio-engine/src/sampler-core.ts:46-128`.
- Faded forced termination:
  `packages/audio-engine/src/sampler-runtime.ts:211-240`.
- Bun tests: neighboring `*.test.ts` files using `bun:test`.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Shared tests | `bun test packages/shared/src/effects-params.test.ts packages/shared/src/instrument-params.test.ts` | exit 0 |
| Synth tests | `bun test packages/audio-engine/src/synth-voice.test.ts packages/audio-engine/src/synth-runtime.test.ts` | exit 0 |
| Full tests | `bun test` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |

## Scope

**In scope**

- `packages/shared/src/effects-params.ts`
- `packages/shared/src/effects-params.test.ts`
- `packages/shared/src/instrument-params.ts`
- `packages/shared/src/instrument-params.test.ts`
- `packages/audio-engine/src/synth-voice.ts`
- `packages/audio-engine/src/synth-voice.test.ts` (new)
- `packages/audio-engine/src/synth-runtime.test.ts` (new, characterization only)

**Out of scope**

- New synth parameters or UI controls.
- Automation support.
- AudioWorklet implementation.
- Convex schema changes.
- Any dashboard file or existing screenshot.

## Steps

### Step 1: Reject non-finite synth values

Use a finite reader at both unknown-state boundaries. Do not rely on `clamp`
to repair `NaN`.

Target shape:

```ts
const readFiniteNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
)
```

Use defaults when normalization receives `NaN`, `Infinity`, or `-Infinity`.
Add tests for gain, attack, and release.

**Verify**:
`bun test packages/shared/src/effects-params.test.ts packages/shared/src/instrument-params.test.ts`

### Step 2: Make the envelope plan explicit and correct for short notes

Extract or export a pure envelope-plan function from `synth-voice.ts`. Define
these semantics:

1. `noteOffTime = startTime + max(0, durationSec)`.
2. Attack may be interrupted by note-off.
3. Release starts at note-off, from the amplitude reached at note-off.
4. `endTime = noteOffTime + releaseSec`.
5. Zero-duration notes are ignored by callers.

Do not schedule a future attack peak after note-off. Prefer
`cancelAndHoldAtTime` where available when retargeting an active envelope; use a
computed current value fallback for compatibility.

Suggested pure result:

```ts
type SynthEnvelopePlan = {
  startTime: number
  attackEndTime: number
  noteOffTime: number
  releaseEndTime: number
  levelAtNoteOff: number
}
```

Tests must cover:

- note duration longer than attack;
- note duration shorter than attack;
- zero attack and zero release normalization;
- finite, ordered event times;
- no peak event after note-off for an interrupted attack.

**Verify**:
`bun test packages/audio-engine/src/synth-voice.test.ts`

### Step 3: Characterize current runtime cleanup and preview divergence

Add fake-node tests for the current runtime without changing its public API:

- sources and gain nodes are removed after oscillator end;
- stopping one clip does not stop another clip's notes;
- stopping all notes empties the active registries;
- parameter updates retarget the current envelope without non-finite events.

Add a focused characterization assertion documenting that
`useTimelineMidiOverlay.ts` currently constructs its own oscillator graph. This
may be a source-level test if that is the repository's existing pattern. The
test should make plan 003's removal deliberate, not preserve the duplication
as desired behavior.

**Verify**:
`bun test packages/audio-engine/src/synth-runtime.test.ts`

### Step 4: Add a live/offline planning parity seam

Refactor graph construction only enough that both `synth-runtime.ts` and
`export-mixdown.ts` consume the same envelope and oscillator helpers. Do not
change export behavior beyond the corrected envelope.

Add deterministic unit tests proving live and offline construction consume the
same envelope-plan result. Do not require browser-rendered peak/RMS assertions
from `bun test`; browser audio rendering remains a manual or separately hosted
characterization activity.

**Verify**:
`bun test packages/audio-engine/src/synth-voice.test.ts packages/audio-engine/src/export-mixdown.test.ts`

## Done criteria

- [ ] Non-finite persisted synth numbers normalize to defaults.
- [ ] Short notes release from their interrupted attack level.
- [ ] Current runtime cleanup and clip scoping are characterized.
- [ ] Preview divergence is captured as a known seam for plan 003.
- [ ] Focused synth tests exist and pass.
- [ ] `bun test`, `bun run typecheck`, and `bun run lint` pass.
- [ ] No unrelated file changes were overwritten.

## STOP conditions

- The Web Audio test doubles cannot represent scheduled parameter events
  without changing shared test infrastructure outside scope.
- Correct short-note behavior requires a product decision between hard and
  soft envelope retrigger.
- The source registry contract cannot support delayed removal after a fade.
- Existing uncommitted user work overlaps an in-scope file.

## Maintenance notes

Plan 003 owns bounded polyphony, time-aware stealing, preview routing, and the
shared live/offline graph. Keep this plan's helpers small enough to evolve
rather than creating a generic voice framework prematurely.
