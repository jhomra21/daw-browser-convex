# Dialkit Learnings For DAW Browser

This note keeps the refactor plan aligned to the real goal: make our control/effects code feel structurally similar to Dialkit where it helps, while respecting the fact that this repo is a DAW app with Convex, an audio engine, and Tailwind.

## Goal

Aim for high structural parity with Dialkit in these areas:

1. Small public surfaces
2. Clear separation between model logic and UI rendering
3. A small set of reusable control primitives
4. Thin composition shells
5. Readable component internals
6. Minimal duplication

Do not aim for literal implementation parity where the product constraints differ.

## What We Should Copy From Dialkit

### 1. Layering

Dialkit effectively has these layers:

- public API
- model/store
- composition shell
- primitive controls
- shared visual language

The closest equivalent for our repo should be:

- `src/lib/effects/params.ts`
  Owns effect param types, defaults, normalization, lite shapes, and small shared helpers.

- `src/components/timeline/create-effects-panel-state.ts`
  Owns the effects panel state orchestration, hydration rules, sync suppression, persistence helpers, and target-specific effect state.

- `src/components/timeline/EffectsPanel.tsx`
  Becomes the composition shell that renders the active effect editors using prepared state and callbacks.

- `src/components/effects/*`
  Stay as effect editors.

- `src/components/ui/knob.tsx` and later small shared effect primitives
  Become our equivalent of Dialkit's primitive control layer.

### 2. Composition style

Dialkit builds richer editors from a few primitives.

Our parity target should be:

- `EffectsPanel` composes editors
- effect editors compose a few stable controls
- controls keep logic local and reusable
- orchestration does not leak into editor files

### 3. Internal component structure

Each effect editor and primitive should trend toward this order:

1. props/types
2. constants
3. pure helpers
4. refs/signals
5. derived values
6. handlers
7. effects/lifecycle
8. render

### 4. Small reusable shell components

Dialkit's shell components keep the main renderer readable.

Our parity target is not a large shared kit. It is one or two shell components that remove obvious repetition, such as:

- `EffectCard`
- `EffectCardHeader`

Only add these once they clearly replace duplicated code in at least two editors.

## What We Should Not Copy Literally

### 1. Do not copy the global singleton-store pattern

Dialkit is a UI control library. We are an app with Convex subscriptions, an audio engine, timeline state, and persistence. A global UI store would fight the current architecture.

### 2. Do not copy the metadata-renderer pattern for everything

Dialkit can drive many controls from one metadata renderer because its domain is generic panel controls. Our effects are richer and more specialized. `Eq` and `Synth` should stay explicit components.

### 3. Do not copy the styling approach directly

Dialkit uses a central CSS theme file. This repo is Tailwind-first. The parity target is consistency of visual primitives, not switching away from Tailwind.

### 4. Do not force generic editor abstractions early

Dialkit feels coherent because its primitives are coherent. We should match that by standardizing the primitive layer first, not by immediately forcing all effect editors into one generic prop interface.

## Validated Problems In Our Repo

1. `src/components/timeline/EffectsPanel.tsx` is doing too much.
2. Effect param shapes and defaults live in UI files.
3. `EqParamsLite`, `ReverbParamsLite`, and `supportsGain` are duplicated in `audio-engine.ts` and `export-mixdown.ts`.
4. Synth floating-card bounds logic is duplicated between `EffectsPanel.tsx` and `SynthCard.tsx`.
5. `Eq`, `Reverb`, `Synth`, and `Arpeggiator` repeat the same card shell and header structure.
6. The old `AudioRecorder` / `VisualEqualizer` pair was orphaned from the app and should not be treated as an active product surface.

## Parity-Focused Plan

### Step 1. Create one effect-domain entry point

Add:

- `src/lib/effects/params.ts`

Move into it:

- `EqParams`
- `ReverbParams`
- `SynthParams`
- `ArpeggiatorParams`
- `createDefaultEqParams`
- `createDefaultReverbParams`
- `createDefaultSynthParams`
- `createDefaultArpeggiatorParams`
- `EqParamsLite`
- `ReverbParamsLite`
- `supportsGain`

Why this improves parity:

- it gives us a single model/domain layer like Dialkit has
- it removes duplication without changing rendering
- it stops editor files from owning application-domain definitions

### Step 2. Extract one small state/orchestration helper

Add:

- `src/components/timeline/create-effects-panel-state.ts`

Move only the non-render state logic out of `EffectsPanel.tsx` first.

Why this improves parity:

- it makes `EffectsPanel.tsx` closer to Dialkit's `Panel` role as a composition shell
- it keeps orchestration separate from visual composition
- it avoids a large framework-style split too early

### Step 3. Extract one shared pure helper for synth bounds

Add a small helper for floating synth card bounds and use it in both:

- `src/components/timeline/EffectsPanel.tsx`
- `src/components/effects/SynthCard.tsx`

Why this improves parity:

- it removes real duplication
- it keeps specialized logic outside the render body

### Step 4. Extract one shared effect card shell if duplication still remains

If repeated shell/header code still dominates after steps 1 to 3, add:

- `src/components/effects/shared/EffectCard.tsx`

Keep it minimal. Do not build a large shared effect UI package.

Why this improves parity:

- it mirrors Dialkit's small shell-components approach
- it reduces repeated layout noise in editor files

### Step 5. Refine `Knob` for primitive parity

Only after the previous steps, clean up:

- `src/components/ui/knob.tsx`

Goals:

- clearer internal ordering
- more reusable primitive behavior
- less inline geometry noise
- keep current behavior intact

Do not rename its API repo-wide unless that becomes necessary during real migrations.

### Step 6. Revisit `Eq` carefully

Do not merge them.

Instead:

- share only helpers that are truly identical
- keep `Eq` as an effect editor
- keep recorder-specific experiments out of the main effect architecture unless they are wired into the app

## Simplest Execution Order

1. `src/lib/effects/params.ts`
2. shared synth bounds helper
3. `create-effects-panel-state.ts`
4. optional `EffectCard`
5. `knob.tsx`
6. editor-by-editor cleanup

## Non-Goals

1. Do not recreate Dialkit's global store.
2. Do not build a generic metadata renderer for the effects stack.
3. Do not move the repo away from Tailwind.
4. Do not force all effect editors into one generic prop contract immediately.
5. Do not preserve orphaned recording UI without an actual app entry point.
