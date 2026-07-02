# Left Sidebar Refactor Tracker

## Status

- Branch: `left-sidebar-refactor`
- Base: `f711646 Consolidate invariant checks with shared assert helper`
- Push policy: commit and push the tracker first, then commit and push completed implementation phases after validation.
- Validation: run `bun run typecheck`, `bun test`, and focused UI/code review before final handoff.

## Goal

Refactor the left Browser/sidebar into a more DAW-like library surface:

1. Replace the text `Browser` toolbar button with an icon that reflects open/closed sidebar state.
2. Add user-created folders for assets/samples, where files live in one folder unless explicitly copied.
3. Add reusable effect chain presets, for example `Vocal Chain` containing EQ, compressor, saturator, and another EQ.
4. Add reusable instrument presets containing an instrument plus MIDI/audio effects, draggable to a panel, track, or new track.

## Codebase Findings

- Main Browser UI: `src/components/timeline/browser/timeline-left-browser.tsx`
- Browser controller/model: `src/hooks/useTimelineBrowserController.ts`
- Browser types: `src/components/timeline/browser/browser-types.ts`
- Device drag/drop types: `src/components/timeline/browser/browser-drag-types.ts`
- Device pointer drag: `src/components/timeline/browser/create-browser-device-drag.ts`
- Drop handling: `src/components/Timeline.tsx`
- Toolbar toggle: `src/components/timeline/TransportControls.tsx`
- Icon registry: `src/components/ui/Icon.tsx`
- Local project DB: `src/lib/local-project-db.ts`
- Local samples/assets: `src/lib/local-assets.ts`
- Local effects: `src/lib/local-effects.ts`
- Cloud schema/functions: `convex/schema.ts`, `convex/samples.ts`, `convex/effects.ts`

## Important Constraint

The current effect model is keyed by effect kind per target:

- Local rows use IDs like `${targetId}:${effect}` in `src/lib/local-effects.ts`.
- Drag/add checks use `canAddAudioEffectToTarget`.
- Reorder state is represented as `AudioEffectKind[]`.

True chains such as `EQ -> Compressor -> Saturator -> EQ` require effect instance IDs. Implementing reusable chains correctly therefore requires changing actual inserted effects from kind-keyed rows to instance-keyed rows before final chain preset support.

## Phase 1: Sidebar Toggle Icon

- Add sidebar open/closed icons to `src/components/ui/Icon.tsx`.
- Replace text `Browser` in `TransportControls.tsx` with the correct icon for current state.
- Preserve current `aria-label`, `aria-pressed`, focus styles, and active styling.

## Phase 2: Browser Tree Scaffold

- Extend Browser row types to support folders and leaf rows without changing persistence semantics yet.
- Keep existing tab split: `assets`, `effects`, `midi-instruments`.
- Preserve current flat Project/Default/Builtin sections as tree roots.
- Add local expansion state to `timeline-left-browser-preferences.ts`.
- Keep search behavior predictable: matching children should reveal their folder path.

## Phase 3: Asset Folders

- Add project-scoped asset folder records for local and cloud projects.
- Add optional `folderId` metadata to project samples.
- Provide create, rename, delete-empty, and move-sample actions.
- Keep folder semantics strict: one sample belongs to one folder. Multi-folder appearance requires future copy/duplicate behavior.

## Phase 4: Effect Instance IDs

- Introduce stable effect instance IDs for actual inserted audio effects.
- Migrate local/cloud effect reads to support existing kind-keyed rows and new instance-keyed rows.
- Update add, remove, reorder, automation targeting, and effects panel state to work with instances.
- Preserve compatibility for existing projects.

## Phase 5: Effect Chain Presets

- Add reusable effect chain preset records with name, optional folder, ordered effects, and params.
- Extend `BrowserDragPayload` with an audio effect chain payload.
- Dragging a chain onto an effect panel inserts all contained effects at the drop index.
- Dragging a chain onto a track or new track applies the chain to that target.

## Phase 6: Instrument Presets

- Add reusable instrument preset records with instrument params plus optional MIDI/audio effects.
- Extend `BrowserDragPayload` with an instrument preset payload.
- Dragging onto an existing track sets the instrument and applies effects.
- Dragging onto the new-track area creates an instrument track, sets the instrument, and applies effects.

## Final Review Passes

- Run validators.
- Run a simplify/scale pass to remove unnecessary abstractions and keep APIs consumer-shaped.
- Run a Solid UI consistency review against `AGENTS-solid.md`, `solid-ui-guidelines.md`, and `consistency-guidelines.md`.
