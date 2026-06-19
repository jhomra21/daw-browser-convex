# Ableton EQ/Reverb UI Tracker

> Created: 2026-06-19
> Branch: `ableton-eq-reverb-ui-plan`
> Base branch: `master`
> Scope: refactor the EQ and Reverb device UIs to more closely resemble Ableton Live's EQ Eight and Reverb devices while preserving current audio behavior.
>
> This tracker is the implementation handoff for a sub-agent. Keep it updated with implementation notes, review findings, simplification notes, validation output, commits, and pushed branches.

## Purpose

The current EQ and Reverb devices are functional, but their visual hierarchy is much simpler than Ableton's device views. This branch should make the two effects feel closer to Ableton's device design without changing DSP, persistence, shared params, or effect panel contracts.

The work should remain UI-only unless this tracker is explicitly amended.

---

## References

### Ableton Reference Images

Reference images were added to:

- `/private/tmp/ableton-ui-reference/eq-eight-main.png`
- `/private/tmp/ableton-ui-reference/eq-eight-expanded.png`
- `/private/tmp/ableton-ui-reference/reverb-main.png`
- `/private/tmp/ableton-ui-reference/reverb-input-filter.png`
- `/private/tmp/ableton-ui-reference/reverb-early-reflections.png`
- `/private/tmp/ableton-ui-reference/reverb-diffusion-network.png`
- `/private/tmp/ableton-ui-reference/reverb-chorus.png`
- `/private/tmp/ableton-ui-reference/reverb-global-settings.png`
- `/private/tmp/ableton-ui-reference/reverb-output.png`

### Current DAW Source Truth

- `src/components/effects/Eq.tsx`
- `src/components/effects/Reverb.tsx`
- `src/components/ui/knob.tsx`
- `src/components/timeline/EffectsPanel.tsx`
- `packages/shared/src/effects-params.ts`
- `packages/audio-engine/src/effects/dsp.ts`

### Reference Codebases

- DialKit UI/control patterns:
  - `/Users/juan/Documents/dialkit/src/solid/components/Slider.tsx`
  - `/Users/juan/Documents/dialkit/src/solid/components/SegmentedControl.tsx`
  - `/Users/juan/Documents/dialkit/src/solid/components/ButtonGroup.tsx`
  - `/Users/juan/Documents/dialkit/src/solid/components/Panel.tsx`
- Monorepo-new editor/inspector patterns:
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/ui/control-group.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/ui/panel-section.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/ui/slider-input.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/inspector/effects.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/inspector/effects-inspector.tsx`

---

## Non-Negotiable Scope

Do:

- Keep this as a visual/UI refactor.
- Preserve `EqProps` and `ReverbProps`.
- Preserve `EqParams`, `EqBandParams`, and `ReverbParams`.
- Preserve current persistence, undo, local/shared project behavior, and audio engine behavior.
- Keep current spectrum analyzer support in EQ.
- Keep device cards usable in the horizontal bottom `EffectsPanel`.
- Keep no-rounded-corners and no-visible-scrollbar policy.
- Run validators before each commit.

Do not:

- Add new dependencies.
- Add Adaptive Q, EQ scale, EQ output gain, Reverb freeze, diffusion, chorus, density, stereo width, or input filter as real controls.
- Modify Convex schemas or local DB schemas.
- Modify `packages/shared/src/effects-params.ts` or `packages/audio-engine/src/effects/dsp.ts` unless the tracker is intentionally re-scoped.
- Use unsafe casts.

---

## Design Principles From Reference Codebases

### DialKit Takeaways

DialKit's controls keep interaction state local and expose simple controlled APIs:

```tsx
<Slider
  label={control.label}
  value={value() as number}
  onChange={(v) => DialStore.updateValue(props.panel.id, control.path, v)}
  min={control.min}
  max={control.max}
  step={control.step}
/>
```

Apply this as:

- Keep EQ selected-band state in `Eq.tsx`.
- Keep canvas drag state in `Eq.tsx`.
- Keep Reverb visual-canvas state in `Reverb.tsx`.
- Keep helpers local until a second real consumer exists.

### Monorepo-new Takeaways

Monorepo-new uses small layout primitives like `ControlRow` and `PanelSection`:

```tsx
<ControlRow label="Amount">
  <SliderInput
    value={Math.round(clampUnit(effectValue()) * 100)}
    min={0}
    max={100}
    onChange={(v) => updateValue(clampUnit(v / 100))}
    format={(v) => `${v}%`}
  />
</ControlRow>
```

Apply this as local device-shaped primitives:

- `AbletonKnobControl`
- `EqBandStrip`
- `EqUtilityColumn`
- `ReverbSection`
- `ReverbKnobControl`
- `ReverbDecayDisplay`

Do not create generic app-wide primitives for one branch.

---

## Phase 1: EQ Ableton-Style Refactor

### Goal

Make `src/components/effects/Eq.tsx` closer to Ableton EQ Eight:

- left selected-band knob stack
- center spectrum/curve canvas
- right utility column
- bottom band strip with filter-shape icons and per-band enable states
- numbered canvas nodes

### Target Layout

```txt
┌──────────────────────────────────────────────────────────────┐
│ EQ header: title, enabled toggle, reset                      │
├──────────────┬──────────────────────────────┬────────────────┤
│ Freq         │                              │ Mode           │
│ [knob] value │     spectrum + EQ canvas     │ Stereo         │
│ Gain         │                              │ On/Off         │
│ [knob] value │                              │ Reset          │
│ Q            │                              │                │
│ [knob] value │                              │                │
├──────────────┴──────────────────────────────┴────────────────┤
│ Band strip: icon + enable + numbered band buttons            │
└──────────────────────────────────────────────────────────────┘
```

### Code Direction

Keep helpers local in `Eq.tsx`:

```tsx
function AbletonKnobControl(props: {
  label: string;
  valueLabel: string;
  children: JSX.Element;
}) {
  return (
    <div class="flex flex-col items-center gap-1 border-b border-neutral-800 px-1 py-2 last:border-b-0">
      <div class="text-[10px] leading-none text-neutral-400">{props.label}</div>
      {props.children}
      <div class="max-w-full truncate font-mono text-[10px] leading-none text-cyan-300">
        {props.valueLabel}
      </div>
    </div>
  );
}
```

Use explicit formatters:

```ts
const formatFrequency = (frequency: number) =>
  frequency >= 1000 ? `${(frequency / 1000).toFixed(2)} kHz` : `${Math.round(frequency)} Hz`;

const formatDb = (value: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(2)} dB`;

const formatQ = (value: number) => value.toFixed(2);
```

Add a local filter type cycle:

```ts
const FILTER_TYPE_SEQUENCE: EqBandType[] = [
  "lowpass",
  "highpass",
  "bandpass",
  "notch",
  "lowshelf",
  "highshelf",
  "peaking",
];

const nextFilterType = (type: EqBandType): EqBandType => {
  const index = FILTER_TYPE_SEQUENCE.indexOf(type);
  return FILTER_TYPE_SEQUENCE[(index + 1) % FILTER_TYPE_SEQUENCE.length] ?? "peaking";
};
```

Add local `EqFilterIcon`:

```tsx
function EqFilterIcon(props: { type: EqBandType; active: boolean }) {
  const stroke = () => props.active ? "#67e8f9" : "#737373";

  return (
    <svg viewBox="0 0 32 16" class="h-4 w-8" aria-hidden="true">
      <path
        d={
          props.type === "lowpass" ? "M2 4 H17 C22 4 22 12 30 12" :
          props.type === "highpass" ? "M2 12 C10 12 10 4 15 4 H30" :
          props.type === "bandpass" ? "M2 12 C8 12 9 4 16 4 C23 4 24 12 30 12" :
          props.type === "notch" ? "M2 4 H12 C14 4 14 12 16 12 C18 12 18 4 20 4 H30" :
          props.type === "lowshelf" ? "M2 10 H10 C15 10 15 5 20 5 H30" :
          props.type === "highshelf" ? "M2 5 H12 C17 5 17 10 22 10 H30" :
          "M2 10 C8 10 10 5 16 5 C22 5 24 10 30 10"
        }
        fill="none"
        stroke={stroke()}
        stroke-width="2"
      />
    </svg>
  );
}
```

Update canvas node drawing to use numbered nodes:

```ts
for (let index = 0; index < props.bands.length; index++) {
  const band = props.bands[index];
  if (!band.enabled) continue;

  const x = freqToX(band.frequency);
  const y = gainToY(supportsGain(band.type) ? band.gainDb : 0);
  const selected = selectedId() === band.id;

  ctx.beginPath();
  ctx.arc(x, y, selected ? 8 : 7, 0, Math.PI * 2);
  ctx.fillStyle = selected ? "#facc15" : "#d97706";
  ctx.strokeStyle = "#0a0a0a";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#111827";
  ctx.font = "bold 9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(index + 1), x, y + 0.5);
}
```

### EQ Acceptance Criteria

- Existing EQ params still update correctly through knobs, canvas dragging, band toggles, and filter type changes.
- Canvas still redraws on band changes and spectrum updates.
- Band dots are numbered.
- Disabled bands visually dim and do not draw active nodes.
- Selected band remains readable and controllable.
- No visible scrollbars introduced.

### Phase 1 Gate

After Phase 1:

1. Run `bun run typecheck`.
2. Run `bun test`.
3. Run the `simplify` skill/review flow for the EQ-only diff.
4. Apply only high-confidence simplifications.
5. Re-run `bun run typecheck` and `bun test`.
6. Invoke the `commit-and-push` skill sub-agent for an EQ checkpoint commit.

Suggested commit message:

```txt
refactor: reshape eq device around ableton layout
- add numbered graph nodes and band strip controls
- keep eq params and audio behavior unchanged
```

---

## Phase 2: Reverb Ableton-Style Refactor

### Goal

Make `src/components/effects/Reverb.tsx` closer to Ableton Reverb's sectioned device layout while exposing only the three real current params:

- `wet`
- `decaySec`
- `preDelayMs`

### Target Layout

```txt
┌─────────────────────────────────────────────────────────────┐
│ Reverb header: title, enabled toggle, reset                 │
├─────────────────┬────────────────────┬────────────┬────────┤
│ Decay Display   │ Global             │ Space      │ Output │
│ curve canvas    │ Predelay knob      │ Decay knob │ Wet    │
└─────────────────┴────────────────────┴────────────┴────────┘
```

### Code Direction

Use local section and control helpers in `Reverb.tsx`:

```tsx
function ReverbSection(props: {
  title: string;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <div class={cn("flex min-w-0 flex-col border-r border-neutral-800 bg-neutral-950/30 last:border-r-0", props.class)}>
      <div class="border-b border-neutral-800 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
        {props.title}
      </div>
      <div class="flex min-h-0 flex-1 items-center justify-center p-2">
        {props.children}
      </div>
    </div>
  );
}
```

```tsx
function ReverbKnobControl(props: {
  label: string;
  valueLabel: string;
  children: JSX.Element;
}) {
  return (
    <div class="flex flex-col items-center gap-1">
      <div class="text-[10px] leading-none text-neutral-400">{props.label}</div>
      {props.children}
      <div class="font-mono text-[10px] leading-none text-cyan-300">{props.valueLabel}</div>
    </div>
  );
}
```

Add a visual-only decay display:

```tsx
function ReverbDecayDisplay(props: { decaySec: number; enabled: boolean }) {
  let canvasRef: HTMLCanvasElement | undefined;

  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;

    const width = 150;
    const height = 74;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 25) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += 18) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = props.enabled ? "#67e8f9" : "#525252";
    ctx.lineWidth = 2;
    ctx.beginPath();

    const normalizedDecay = clamp(props.decaySec / 10, 0.05, 1);
    for (let x = 0; x < width; x++) {
      const t = x / Math.max(1, width - 1);
      const amplitude = Math.exp(-t / normalizedDecay);
      const y = 8 + (1 - amplitude) * (height - 16);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();
  });

  return <canvas ref={(el) => (canvasRef = el)} class="h-[74px] w-[150px] border border-neutral-800" />;
}
```

Use the existing params in the layout:

```tsx
<ReverbSection title="Global">
  <ReverbKnobControl label="Pre" valueLabel={formatMilliseconds(props.params.preDelayMs)}>
    <Knob
      value={props.params.preDelayMs}
      min={0}
      max={200}
      step={1}
      size={32}
      disabled={!props.params.enabled}
      showValue={false}
      onValueChange={(value) => props.onChange({ preDelayMs: Math.round(clamp(value, 0, 200)) })}
    />
  </ReverbKnobControl>
</ReverbSection>
```

### Reverb Acceptance Criteria

- Wet, decay, and predelay all still update audio and persistence through current props.
- UI clearly reads as sectioned device UI.
- No fake controls that appear functional.
- Decay display updates reactively from `decaySec`.
- Disabled state dims or disables controls consistently.

### Phase 2 Gate

After Phase 2:

1. Run `bun run typecheck`.
2. Run `bun test`.
3. Run the `simplify` skill/review flow for the Reverb-only diff.
4. Apply only high-confidence simplifications.
5. Re-run `bun run typecheck` and `bun test`.
6. Invoke the `commit-and-push` skill sub-agent for a Reverb checkpoint commit.

Suggested commit message:

```txt
refactor: reshape reverb device into sectioned layout
- add ableton-inspired decay display and grouped controls
- keep reverb params and audio behavior unchanged
```

---

## Phase 3: Integration Review and Polish

### Goal

Review both devices together inside `EffectsPanel` and make small layout adjustments only if needed.

Check:

- card widths in the horizontal effects panel
- alignment with Synth and Arpeggiator cards
- bottom panel overflow behavior
- read-only opacity behavior from `EffectsPanelEffectCards`
- no visible scrollbars
- no rounded corners

If necessary, adjust only:

- `class="min-w-80"` on EQ call site
- `class="min-w-72"` on Reverb call site
- internal `min-w-*` classes in the two devices

### Phase 3 Gate

After Phase 3:

1. Run `bun run typecheck`.
2. Run `bun test`.
3. Run `bun run build`.
4. Run `review` or `defensive-code-review` if available for final bug-focused review.
5. Run `simplify` one final time for the full branch.
6. Apply only high-confidence fixes/simplifications.
7. Re-run `bun run typecheck`, `bun test`, and `bun run build`.
8. Invoke the `commit-and-push` skill sub-agent for the final polish commit.

Suggested commit message:

```txt
fix: polish ableton-style effect device layouts
- verify eq and reverb cards inside the effects panel
- keep validation green after review and simplify passes
```

---

## Commit and Push Instructions for Agent

The implementation agent should not batch the whole branch into one large final commit if a phase is complete and validators pass.

Use this rhythm:

1. Finish a self-contained phase.
2. Validate.
3. Run `simplify` for that phase.
4. Apply safe simplifications.
5. Validate again.
6. Use the `commit-and-push` skill sub-agent.
7. Continue to the next phase from the pushed branch.

Required checkpoint commits:

1. Tracker setup commit on `ableton-eq-reverb-ui-plan`.
2. EQ UI refactor checkpoint.
3. Reverb UI refactor checkpoint.
4. Final integration/polish checkpoint, if there are additional changes after Phase 2.

The `commit-and-push` skill must be used for commits and pushes. Do not hand-roll push commands unless explicitly overridden.

---

## Validation Commands

Run before every checkpoint commit:

```bash
bun run typecheck
bun test
```

Run before final completion:

```bash
bun run typecheck
bun test
bun run build
```

---

## Final Completion Criteria

- Branch is pushed.
- Tracker is updated with completed phases and commit hashes.
- EQ UI matches the planned Ableton-style structure.
- Reverb UI matches the planned sectioned structure.
- No DSP, schema, or persistence changes were introduced.
- Typecheck, tests, and build pass.
- Review/simplify findings are either fixed or recorded with rationale.
