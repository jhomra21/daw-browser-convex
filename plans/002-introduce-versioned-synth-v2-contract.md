# Plan 002: Introduce the versioned synth v2 contract

> **Executor instructions**: Complete plan 001 first. This plan owns the
> canonical parameter names, ranges, defaults, migration, serialization, agent
> command contract, and Convex validators. Engine and UI code must consume this
> contract rather than define competing ranges.
>
> **Drift check**:
> `git diff --stat 468b7b0..HEAD -- packages/shared/src/effects-params.ts packages/shared/src/instrument-params.ts packages/shared/src/shared-timeline-operations.ts packages/shared/src/agent-commands.ts convex/effects.ts src/lib/instrument-presets.ts`

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/001-establish-safe-synth-baseline.md`
- **Category**: architecture, migration
- **Planned at**: commit `468b7b0`, 2026-07-16

## Why this matters

The current unversioned five-field shape cannot safely grow across local
storage, Convex, undo/history operations, built-in presets, agent commands,
live playback, and export. A versioned normalized contract gives every layer
one source of truth and allows existing projects to upgrade without a data
backfill.

## Architecture decision

Create `packages/shared/src/synth-params.ts`. Move synth-specific types,
defaults, normalization, and serialization out of the 1,400-line
`effects-params.ts`. Re-export the new module from `packages/shared/src/index.ts`
so external imports from `@daw-browser/shared` remain stable.

Use nested domain groups:

```ts
export const SYNTH_STATE_VERSION = 2

export type SynthOscillatorParams = {
  wave: SynthWave
  octave: number
  semitone: number
  detuneCents: number
  level: number
}

export type SynthEnvelopeParams = {
  attackSec: number
  decaySec: number
  sustain: number
  releaseSec: number
}

export type SynthFilterParams = {
  enabled: boolean
  mode: SynthFilterMode
  frequencyHz: number
  q: number
  keyTracking: number
  envelopeAmountOctaves: number
  envelope: SynthEnvelopeParams
}

export type SynthLfoParams = {
  enabled: boolean
  wave: SynthWave
  frequencyHz: number
  pitchCents: number
  filterOctaves: number
  amp: number
  pan: number
}

export type SynthParams = {
  version: typeof SYNTH_STATE_VERSION
  oscillators: readonly [SynthOscillatorParams, SynthOscillatorParams]
  ampEnvelope: SynthEnvelopeParams
  filter: SynthFilterParams
  lfo: SynthLfoParams
  gain: number
  pan: number
  polyphony: number
  retrigger: boolean
}
```

Do not add unison, PWM, sync, FM, noise, or a generic modulation matrix in v2.
Those features require a different oscillator architecture or more product
design.

## Canonical defaults and ranges

| Parameter | Default | Range | Scale |
|---|---:|---:|---|
| oscillator wave | sawtooth | four built-in waves | discrete |
| osc 1 level | 0.7 | 0..1 | linear |
| osc 2 level | 0.45 | 0..1 | linear |
| octave | 0 | -3..3 | integer |
| semitone | 0 | -12..12 | integer |
| detune | osc1 -7, osc2 +7 | -100..100 cents | linear |
| amp attack | 0.005 s | 0..60 s | log UI |
| amp decay | 0.1 s | 0..60 s | log UI |
| amp sustain | 0.8 | 0..1 | linear |
| amp release | 0.12 s | 0..60 s | log UI |
| filter enabled | true | boolean | discrete |
| filter mode | lowpass | lowpass/highpass/bandpass/notch | discrete |
| cutoff | 12 kHz | 20..20,000 Hz | log |
| Q | 0.7 | 0.0001..30 | log UI |
| key tracking | 0 | 0..1 | linear |
| filter env amount | 0 | -6..6 octaves | bipolar |
| filter ADSR | 5 ms, 150 ms, 0, 150 ms | envelope ranges above | mixed |
| LFO rate | 5 Hz | 0.01..100 Hz | log |
| LFO pitch | 0 | -1200..1200 cents | bipolar |
| LFO filter | 0 | -6..6 octaves | bipolar |
| LFO amp | 0 | 0..1 | linear |
| LFO pan | 0 | 0..1 | linear |
| output gain | 0.8 | 0..1.5 | linear |
| output pan | 0 | -1..1 | bipolar |
| polyphony | 32 | 1..128 | integer |
| retrigger | true | boolean | discrete |

At runtime clamp cutoff to `min(20_000, sampleRate * 0.45)`. Persistence cannot
know the active context sample rate, so persisted normalization remains
20..20,000 Hz.

## Scope

**In scope**

- `packages/shared/src/synth-params.ts` (new)
- `packages/shared/src/synth-params.test.ts` (new)
- `packages/shared/src/index.ts`
- `packages/shared/src/effects-params.ts`
- `packages/shared/src/instrument-params.ts`
- `packages/shared/src/instrument-params.test.ts`
- `packages/shared/src/shared-timeline-operations.ts`
- `packages/shared/src/shared-timeline-operations.test.ts`
- `packages/shared/src/agent-commands.ts`
- `packages/shared/src/clip-create-payload.ts`
- `convex/effects.ts`
- Relevant Convex effect contract tests.
- `api/agent-actions.ts`
- `api/routes/agent.ts`
- `src/lib/local-effects.ts`
- `src/lib/instrument-presets.ts`
- Direct compile errors caused by the contract change.

**Out of scope**

- Sound generation changes beyond temporary adapters needed to compile.
- UI redesign.
- Automation descriptors.
- Data backfill or destructive migration.

## Steps

### Step 1: Implement the v2 normalizer

Accept `unknown` nested values safely. Use finite-number checks for every
numeric field, enum guards for every discrete field, and immutable fresh
objects for defaults.

Separate unknown full-state parsing from typed deep updates:

```ts
export type SynthParamsInput = unknown

export type SynthParamsUpdate = {
  oscillators?: readonly [
    Partial<SynthOscillatorParams>?,
    Partial<SynthOscillatorParams>?,
  ]
  ampEnvelope?: Partial<SynthEnvelopeParams>
  filter?: Partial<Omit<SynthFilterParams, 'envelope'>> & {
    envelope?: Partial<SynthEnvelopeParams>
  }
  lfo?: Partial<SynthLfoParams>
  gain?: number
  pan?: number
  polyphony?: number
  retrigger?: boolean
}

normalizeSynthParams(input: unknown): SynthParams
mergeSynthParams(current: SynthParams, update: SynthParamsUpdate): SynthParams
```

Do not trust a claimed version. Detect legacy shape by the presence of top-level
`wave1`, `wave2`, `attackMs`, or `releaseMs`.
Never spread a nested patch over defaults; preserve every unspecified sibling.

### Step 2: Define the legacy migration

Preserve the old patch's audible intent:

```ts
const migrateLegacySynthParams = (legacy: LegacySynthParams): SynthParams => {
  const defaults = createDefaultSynthParams()
  return normalizeSynthParams({
    ...defaults,
    oscillators: [
      { ...defaults.oscillators[0], wave: legacy.wave1, detuneCents: 0, level: 0.5 },
      { ...defaults.oscillators[1], wave: legacy.wave2, detuneCents: 0, level: 0.5 },
    ],
    gain: legacy.gain,
    ampEnvelope: {
      ...defaults.ampEnvelope,
      attackSec: legacy.attackMs / 1000,
      decaySec: 0,
      sustain: 1,
      releaseSec: legacy.releaseMs / 1000,
    },
  })
}
```

Tune the oscillator levels only if an offline comparison shows this mapping is
materially louder or quieter than the old equal-sum graph. Record the chosen
mapping in a test. Do not silently change it later.

### Step 3: Update all persistence boundaries with compatibility reads

Replace handwritten five-field readers with `normalizeSynthParams` or a
strict shared reader derived from it:

- `normalizeTrackInstrumentParams`;
- shared timeline operation parsing;
- Convex `setSynthParams` and server mutation validators;
- local effects/history paths reached by compile errors.

Convex should validate the nested object structurally, then normalize it before
write. Existing stored legacy objects remain readable through normalization.
Do not write a database migration.

Old queued shared operations and clients calling either existing Convex synth
mutation must remain accepted during rollout. Parse both legacy five-field
payloads and v2 full-state payloads, then store normalized v2 state. Do not
silently reinterpret a patch operation as a full replacement.

Pass synth `instanceId` through `SetTrackInstrumentInput`, `instrument-runtime`,
and the synth runtime configuration. Plan 004 requires durable instance
identity for automation filtering.

### Step 4: Update the command and preset surfaces

Change `SetSynthParamsCommandSchema` to accept optional nested groups through
`SynthParamsUpdate`, while keeping legacy flat fields temporarily accepted.
Use `mergeSynthParams(current, update)` at the execution boundary.

Update built-in presets to demonstrate distinct useful patches:

- Bright Poly: detuned saw/square, medium filter, moderate release.
- Pluck Arp: fast amp decay, low sustain, positive filter envelope.

Preserve their current delay and reverb chains.

### Step 5: Add contract and migration tests

Required cases:

- default creation returns independent nested objects;
- every non-finite number falls back;
- all ranges clamp;
- octave, semitone, and polyphony round to integers;
- invalid enum values fall back;
- legacy five-field state migrates deterministically;
- serialized v2 round-trips;
- shared operation round-trips a complete v2 patch;
- old queued legacy operations still parse;
- nested updates preserve unspecified oscillator, envelope, filter, and LFO
  siblings;
- Convex mutation normalization is covered by the nearest existing test seam;
- existing instrument instance identity remains unchanged.

## Verification

Run after each shared-contract step:

```sh
bun test packages/shared/src/synth-params.test.ts \
  packages/shared/src/instrument-params.test.ts \
  packages/shared/src/shared-timeline-operations.test.ts
```

Final:

```sh
bun test
bun run typecheck
bun run lint
bun run knip
```

## Done criteria

- [ ] `SynthParams` is versioned and defined in `synth-params.ts`.
- [ ] Every numeric field rejects non-finite input.
- [ ] Legacy state upgrades without a database backfill.
- [ ] Legacy queued operations and mutation clients remain accepted.
- [ ] Deep patches preserve unspecified nested values.
- [ ] Local, shared-operation, Convex, preset, and agent surfaces accept v2.
- [ ] Existing instrument IDs are preserved.
- [ ] The engine receives the synth instance ID.
- [ ] All repository validators pass.

## STOP conditions

- The legacy loudness mapping cannot be matched within a small tolerance using
  oscillator levels and output gain.
- A persisted path bypasses the shared normalizer and requires an undocumented
  schema decision.
- Convex requires a destructive migration for legacy `params` objects.
- The agent command consumer cannot support nested updates without a separate
  compatibility design.

## Maintenance notes

Future synth versions should add fields through normalization defaults and
increment the state version only when migration logic is required. Keep
destination units explicit: pitch in cents, filter modulation in octaves,
gain in linear amplitude, and pan in normalized units.
