# Plan 005: Replace the synth editor with a responsive sound-design UI

> **Executor instructions**: Complete plans 002 through 004 first so every
> control has a stable parameter, engine behavior, persistence path, and
> automation descriptor. Match the existing DAW visual language. Do not turn
> static sections into configuration arrays.
>
> **Drift check**:
> `git diff --stat 468b7b0..HEAD -- src/components/effects/Synth.tsx src/components/effects/SynthCard.tsx src/components/effects/synth-card-bounds.ts src/components/ui/knob.tsx src/components/timeline/EffectsPanel.tsx src/components/timeline/create-effects-panel-state.ts public/landing-page-synth.png`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans 002, 003, and 004
- **Category**: UI, UX
- **Planned at**: commit `468b7b0`, 2026-07-16

## Why this matters

The repository image `public/landing-page-synth.png` shows the original compact
surface: four waveform buttons and Gain, Attack, Release knobs. The current
expanded component adds two waveform previews and an envelope preview, but it
still exposes only the original five parameters. The v2 engine needs a dense,
legible instrument editor that preserves fast access in the device chain and
does not become a generic settings form.

## UI structure

Keep two intentional surfaces.

### Compact device

- Header: Synth, expand, reset.
- Two oscillator rows: wave glyph, level, coarse octave, detune.
- Filter row: cutoff and resonance.
- Amp row: attack and release.
- No large previews.

This surface must remain readable in the existing effects panel width.

### Expanded editor

Use explicit JSX sections, top to bottom:

1. **Oscillators**: two side-by-side oscillator modules.
2. **Filter**: mode buttons, response visualization, cutoff/Q/key tracking/env.
3. **Envelopes**: amp ADSR and filter ADSR with editable previews.
4. **LFO**: waveform, rate, and destination depths.
5. **Voice/Output**: polyphony, retrigger, gain, pan.

Do not build:

```ts
const sections = [...]
sections.map(...)
```

Instead extract small repeated shells such as `SynthSection` and
`OscillatorPanel`, then write the section order explicitly in JSX, following
the repository's static UI rules.

## Interaction requirements

- Knobs use logarithmic mapping for cutoff, Q where useful, LFO rate, and
  envelope times.
- Shift-drag remains fine adjustment through the existing stepped-control hook.
- Every knob has a meaningful reset value from `createDefaultSynthParams()`.
- Automated knobs use existing automation range and selection props.
- Discrete buttons are keyboard reachable, have pressed state, and expose
  accessible labels.
- Numeric values use existing formatting conventions (`Hz`, `kHz`, `ms`, `s`,
  cents, percentages).
- Parameter updates remain local-first and use the existing debounced
  instrument-state persistence.
- Avoid continuous animation. Visualizations recompute only from parameter
  changes.

## Visualizations

### Oscillator preview

Show the selected mathematical waveform, level, and relative tuning. It is a
parameter preview, not an analyzer. Rename or style it so users do not mistake
it for live output.

### Filter response

Use `BiquadFilterNode.getFrequencyResponse()` only if an existing audio context
is available without starting audio. Otherwise calculate or omit the preview.
Do not create a hidden polling loop. A static logarithmic cutoff/Q curve is
acceptable if documented as an approximation.

### Envelope preview

Use the same pure ADSR plan or curve semantics as `synth-voice.ts`. Do not keep
a second attack/release-only curve model in `Synth.tsx`.

## Responsive card requirements

Fix the current card lifecycle and viewport issues:

- remove `pointermove`, `pointerup`, and `pointercancel` listeners through one
  teardown function;
- terminate interaction on close and Solid cleanup;
- handle `pointercancel`;
- handle `lostpointercapture` and window blur;
- reclamp bounds when viewport dimensions change;
- permit widths below 360 px when the viewport is narrower;
- permit heights below 320 px when required;
- keep the header and close button visible;
- use internal scrolling when content cannot fit;
- preserve touch-action behavior for knobs and resize handles.

Suggested bounds logic:

```ts
const availableW = Math.max(240, viewportWidth - 12)
const availableH = Math.max(220, viewportHeight - 24)
const minW = Math.min(520, availableW)
const minH = Math.min(420, availableH)
```

Choose final minimums after checking the actual compact breakpoint. The key
invariant is `w <= availableW` and `h <= availableH`.

## Scope

**In scope**

- `src/components/effects/Synth.tsx`
- New synth-only child components under `src/components/effects/` when they
  each own a clear section.
- `src/components/effects/SynthCard.tsx`
- `src/components/effects/synth-card-bounds.ts`
- Focused UI/bounds tests.
- `src/components/timeline/EffectsPanel.tsx`
- `src/components/timeline/create-effects-panel-state.ts`
- `src/lib/instrument-presets.ts` only for preset-selection display if needed.
- `public/landing-page-synth.png` only after visual validation and only if the
  product uses it as an intentional current screenshot.

**Out of scope**

- Changing engine semantics or parameter ranges.
- New generic design-system primitives unless a second real consumer exists.
- Animation added for decoration.
- User preset CRUD, preset cloud storage, or preset browsing redesign.
- Audio spectrum analyzer.

## Steps

### Step 1: Define component boundaries and props

Keep `Synth` consumer-shaped:

```ts
type SynthProps = {
  params: SynthParams
  onChange: (updates: SynthParamsUpdate) => void
  automationRangesByParameterId?: ReadonlyMap<string, {
    min: number
    max: number
  }>
  onAutomationParameterTouch?: (id: SynthAutomationParameterId) => void
  onManualAutomationOverride?: (id: SynthAutomationParameterId) => void
  onReset?: () => void
  onExpand?: () => void
  disabled?: boolean
  variant?: 'compact' | 'expanded'
}
```

Nested updates must preserve sibling fields at the state boundary. Prefer a
small synth-specific update helper over repeated object spreads in every knob.

### Step 2: Build compact controls

Replace large previews with a scannable two-oscillator layout and primary
filter/amp controls. Keep the full patch editable only in expanded mode.

Verify at the actual effects-panel width, with long values such as `19.9 kHz`
and `+100 ct`, and at browser zoom 200%.

### Step 3: Build expanded sections

Use the section order above. Keep oscillator 1 and oscillator 2 visually
parallel. Use consistent color only to distinguish signal roles, not every
control.

Suggested small wrappers:

```tsx
function SynthSection(props: { title: string; children: JSX.Element }) {
  return (
    <section class="border-b border-border/60 p-3">
      <h3 class="mb-2 text-xs font-semibold text-foreground">{props.title}</h3>
      {props.children}
    </section>
  )
}
```

Do not extract one-off class strings into constants.

### Step 4: Unify visualization semantics

Move pure waveform/envelope path generation into synth-local helpers with unit
tests if nontrivial. Envelope drawing must reflect attack, decay, sustain, and
release and use the same duration semantics as the engine.

Keep SVGs accessible as decorative (`aria-hidden`) when the same information is
already represented by controls.

### Step 5: Add automation affordances

For each automatable knob:

- pass `automationRange`;
- pass `automated`;
- select parameter on pointer down;
- mark manual override before changing the value.

Use the exact IDs from `synth-automation.ts`.

### Step 6: Harden the floating card

Implement shared pointer teardown, `pointercancel`, cleanup, viewport resize
reclamping, and scrollable body. Add pure tests for bounds with:

- desktop 1440x900;
- tablet 768x600;
- narrow 320x568;
- viewport shrinking while the card is at bottom-right;
- oversized persisted bounds.

### Step 7: Visually validate

Run the existing app only if the operator allows it; project instructions say
not to start the dev server without permission. Treat these as manual evidence,
not ordinary `bun test` gates. If a server is already available, validate:

- compact device at normal and narrow panel widths;
- expanded editor at desktop, tablet, and 320 px viewport;
- 200% zoom;
- keyboard navigation through waveform/filter buttons and knobs;
- pointer drag cancelled by window blur or pointer cancellation;
- automated and non-automated knob states;
- disabled state;
- no clipping of close/resize controls.

Capture a replacement landing-page screenshot only after approval that the new
surface is final.

## Verification

```sh
bun test src/components/effects \
  src/components/timeline/EffectsPanel.test.ts
bun test
bun run typecheck
bun run lint
bun run knip
```

Do not run `bun run dev` without explicit permission.

## Done criteria

- [ ] Compact UI stays concise and usable in the device chain.
- [ ] Expanded UI exposes all v2 parameters in five explicit sections.
- [ ] Every visible control persists and changes live sound and export.
- [ ] Automation affordances match existing effects.
- [ ] Envelope visualization matches engine semantics.
- [ ] Card remains visible and operable on narrow/resized viewports.
- [ ] Pointer listeners always clean up.
- [ ] Keyboard and 200% zoom checks pass.
- [ ] Full validators pass.

## STOP conditions

- A UI control has no implemented engine or persistence path.
- A requested visualization would require polling or a permanent analyzer node.
- Responsive behavior requires changing global layout outside the effects
  panel.
- The only available visual validation requires starting a dev server without
  operator permission.

## Maintenance notes

Keep the compact and expanded surfaces driven by the same `SynthParams`.
If user presets are added later, version and normalize them through
`synth-params.ts`; do not make component-local preset objects canonical state.
