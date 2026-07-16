# Plan 004: Add instance-scoped synth automation

> **Executor instructions**: Complete plan 003 first. Reuse the existing
> instrument automation key, descriptor, evaluation, scheduling, persistence,
> undo, and UI-selection patterns. Do not invent a synth-only automation store.
>
> **Drift check**:
> `git diff --stat 468b7b0..HEAD -- packages/shared/src/automation-parameters.ts packages/shared/src/sampler-automation.ts packages/audio-engine/src/automation.ts packages/audio-engine/src/synth-runtime.ts packages/audio-engine/src/export-mixdown.ts src/hooks/useTimelineAutomationController.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/003-build-shared-polyphonic-synth-voice-graph.md`
- **Category**: feature, engine
- **Planned at**: commit `468b7b0`, 2026-07-16

## Why this matters

The project already supports instance-scoped sampler and granular automation,
but excludes synth instruments. Adding synth automation now is disproportionately
cheap because the timeline, persistence, undo, interpolation, manual override,
and offline scheduling infrastructure already exists.

## Parameter policy

Automate continuous sound parameters only.

**Direct, sample-accurate AudioParam automation**

- `output.gain`
- `output.pan`
- `osc1.level`, `osc2.level`
- `osc1.detune`, `osc2.detune`
- `filter.frequency`
- `filter.q`
- `lfo.rate`
- `lfo.pitchDepth`
- `lfo.filterDepth`
- `lfo.ampDepth`
- `lfo.panDepth`

**Evaluated at note-on**

- `amp.attack`
- `amp.decay`
- `amp.sustain`
- `amp.release`
- `filter.envAmount`
- filter envelope attack/decay/sustain/release

**Not automatable in v2**

- oscillator waveform;
- oscillator octave/semitone;
- filter mode or enabled state;
- LFO waveform/enabled state;
- polyphony;
- retrigger.

Discrete automation is intentionally deferred because transitions require
defined event semantics or graph crossfades.

## Scope

**In scope**

- `packages/shared/src/synth-automation.ts` (new)
- `packages/shared/src/synth-automation.test.ts` (new)
- `packages/shared/src/index.ts`
- `packages/shared/src/automation-parameters.ts`
- `packages/shared/src/automation-parameters.test.ts` if present, otherwise the
  nearest relevant test file.
- `packages/audio-engine/src/synth-voice.ts`
- `packages/audio-engine/src/synth-runtime.ts`
- `packages/audio-engine/src/export-mixdown.ts`
- Their focused tests.
- `packages/audio-engine/src/instrument-runtime.ts`
- `src/hooks/useTimelineAutomationController.ts`
- `convex/automation.ts`
- `convex/tracks.ts`
- `src/lib/undo/history-persistence.ts`
- Relevant ownership, rebasing, persistence, and undo tests.
- Synth props/wiring needed to select and display automation.

**Out of scope**

- New automation persistence tables.
- Automation for discrete parameters.
- Generic modulation matrix.
- Changing sampler or granular automation keys.

## Steps

### Step 1: Define synth automation descriptors

Model `synth-automation.ts` after `sampler-automation.ts`, but use a synth-specific
key prefix and parser so owners cannot collide.

Use a durable namespace distinct from sampler and granular keys:

```ts
synth-instrument:${trackId}:${instanceId}:${parameterId}
```

Add tests proving synth and sampler keys with identical parameter suffixes
cannot parse as each other.

```ts
export type SynthAutomationParameterId =
  | 'output.gain'
  | 'output.pan'
  | 'osc1.level'
  | 'osc1.detune'
  | 'osc2.level'
  | 'osc2.detune'
  | 'amp.attack'
  | 'amp.decay'
  | 'amp.sustain'
  | 'amp.release'
  | 'filter.frequency'
  | 'filter.q'
  | 'filter.envAmount'
  | 'filter.attack'
  | 'filter.decay'
  | 'filter.sustain'
  | 'filter.release'
  | 'lfo.rate'
  | 'lfo.pitchDepth'
  | 'lfo.filterDepth'
  | 'lfo.ampDepth'
  | 'lfo.panDepth'
```

Descriptors must reuse the exact ranges and units from `synth-params.ts`.
Use log scale for frequency and time UI mapping where the existing descriptor
type supports it.

### Step 2: Include synth instances in automation discovery

Extend:

- `AutomationInstrumentInstance` with `'synth'`;
- `getAutomationParameterOptionsForTarget`;
- `getAutomationParameterDescriptor`;
- ownership checks;
- `useTimelineAutomationController` instrument collection.

Use the durable `instanceId`. Never key automation by track and parameter alone.

### Step 3: Apply track, per-note, and per-voice automation in live synthesis

At trigger time, filter envelopes for the track and synth instance once.
Evaluate note-on parameters at `timelineStartSec` using
`valueAtAutomationTime`.

Schedule persistent track output gain and pan once on the synth track output
nodes. Do not repeat output automation on every voice.

For per-voice direct bindings, call `scheduleAutomationEnvelope` with the voice
bindings returned by plan 003. Convert units only at the binding:

- filter envelope/LFO octave modulation becomes cents applied to
  `filter.detune`;
- amp LFO normalized depth becomes the voice-relative gain depth;
- seconds remain seconds;
- cents remain cents.

Keep base value, automation value, modulation sum, unit conversion, and final
clamp conceptually separate.

### Step 4: Mirror automation in offline export

Pass instance-scoped envelopes into the shared synth voice scheduler. Offline
rendering must use the same note-on evaluation and direct binding map.

Test automation points:

- immediately before a note;
- exactly at note-on;
- during sustain;
- during release;
- on common 128-frame boundaries and one sample to either side.

Do not assume render quantum size in implementation code.

### Step 5: Wire manual override and automation UI state

Follow Auto Filter and Sampler control patterns:

- touching a knob selects the parameter;
- manual changes create the existing temporary override;
- knobs show automated state and range;
- resetting a patch does not delete automation envelopes.

Waveform buttons and other discrete controls must not show automation affordance.

## Verification

```sh
bun test packages/shared/src/synth-automation.test.ts \
  packages/audio-engine/src/synth-voice.test.ts \
  packages/audio-engine/src/synth-runtime.test.ts \
  packages/audio-engine/src/export-mixdown.test.ts
bun test
bun run typecheck
bun run lint
bun run knip
```

## Done criteria

- [ ] Synth appears as an instance-scoped automation device.
- [ ] Every listed continuous parameter has one descriptor and unit.
- [ ] Synth and sampler automation keys cannot collide.
- [ ] Track output automation is scheduled once on persistent output nodes.
- [ ] Per-note parameters evaluate at note-on.
- [ ] Direct parameters schedule through shared automation helpers.
- [ ] Live and export automation match.
- [ ] Manual override and knob range indicators work.
- [ ] Discrete parameters remain unavailable.
- [ ] Full validators pass.

## STOP conditions

- The existing automation key format cannot distinguish synth from sampler
  without breaking persisted keys.
- A parameter's automation semantics differ between live and offline paths.
- A direct binding needs nonlinear conversion that cannot be expressed by the
  current binding API without changing unrelated effects.
- UI wiring requires broad EffectsPanel refactoring outside the synth surface.

## Maintenance notes

If discrete automation is added later, define transition semantics first.
Waveform and filter-mode changes may need crossfaded parallel nodes rather than
instant property changes.
