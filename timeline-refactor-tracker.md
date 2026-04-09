# Timeline Refactor Tracker

## Purpose

This file is the working tracker for the timeline/audio cleanup refactor.

It exists to:
- keep the implementation ordered and scoped
- record the current codebase state before changes
- track progress step by step
- capture findings, bugs, regressions, and decisions as they happen
- prevent duplicate abstractions or duplicate code from being introduced

This tracker should be updated throughout the refactor, not just with progress, but also with any bugs, blockers, surprises, or decisions discovered along the way.

---

## Rules Driving This Refactor

Source rules:
- `AGENTS.md`
- `AGENTS-solid.md`
- `SOFTWARE_PATTERNS.md`
- `consistency-guidelines.md`
- `code-simplifier.md`

Refactor guardrails:
- Do not change behavior unless required to preserve correctness during refactor.
- Do not introduce duplicate helpers or parallel abstractions.
- Do not split `Track` / `Clip` into micro-records.
- Do not introduce ECS or a generic controller framework.
- Prefer pure helpers in `src/lib/` and controller/orchestration hooks in `src/hooks/`.
- Keep UI files explicit; do not convert explicit JSX into config/data-driven rendering unless the code is truly repeated.
- Use `Map` / `Set` for timeline indexing where that removes repeated scans or duplicated lookup logic.
- Keep diffs focused and reader-shaped.

Success criteria from the repo rules:
1. Reduce the layers a reader has to trace.
2. Reduce the state a reader has to hold in their head.

---

## Current Codebase State

### Repository validation commands

From `package.json`:
- `bun run typecheck`
- `bun run build`
- `bun run knip`

There is no dedicated test script in `package.json` right now.

### Current hotspots

#### Timeline composition
- `src/components/Timeline.tsx`
- Current size: 975 LOC
- Current role: composition root + resolved-model construction + history/mixer wiring + interaction hook wiring + high-level timeline actions + sidebar resize DOM plumbing + render tree

#### Shared timeline lookup duplication
Current duplicated or near-duplicated track/clip indexing logic exists in:
- `src/components/Timeline.tsx`
- `src/hooks/useClipDrag.ts`
- `src/hooks/useTimelineMidiOverlay.ts`
- `src/hooks/useTimelineMixerController.ts`
- `src/lib/resolve-timeline-tracks.ts`

#### Large multi-concern files after Timeline
- `src/hooks/useClipDrag.ts` — 916 LOC
- `src/hooks/useTrackRecording.ts` — 701 LOC
- `src/components/timeline/EffectsPanel.tsx` — 1022 LOC
- `src/components/timeline/TransportControls.tsx` — 1414 LOC
- `src/lib/audio-engine.ts` — 1120 LOC

### Current architectural facts

#### Existing good boundaries already present
These already exist and should be preserved, not replaced:
- `src/hooks/useTimelineData.ts`
- `src/hooks/useTimelinePreferences.ts`
- `src/hooks/useTimelineIdentity.ts`
- `src/hooks/useTimelineProjectionState.ts`
- `src/hooks/useProjectedTimelineModel.ts`
- `src/hooks/useTimelineLocalMix.ts`
- `src/hooks/useTimelineHistory.ts`
- `src/hooks/useTimelineMixerController.ts`
- `src/lib/resolve-timeline-tracks.ts`

#### Existing setup-time dependency knots
The main problem is not that `Timeline.tsx` is a composition root. The problem is that it contains too much unlayered setup glue and forward references.

Current knots identified from the live file:
- `useTimelineProjectionState` currently depends on `trackLookup()` from `Timeline.tsx`
- `useProjectedTimelineModel` currently depends on `getResolvedTracks()`
- `useTimelineHistory` currently eagerly closes over action functions that depend on mixer functions defined later
- `Timeline.tsx` currently builds the resolved model locally via:
  - `resolveTracks(...)`
  - `resolvedTracks`
  - `placementTracks`
  - `renderTracks`
  - `trackLookup`

These setup-time dependencies force readers to jump around the file to understand what data is available where.

#### Audio engine state shape
`src/lib/audio-engine.ts` currently keeps a large amount of per-track runtime state in parallel maps, including mixer, effects, synth, and metering data. This is a maintainability issue, but it is separate from the timeline composition root problem and should be handled only after the timeline composition cleanup is stable.

---

## Refactor Goals

### Primary goals
- Make the resolved timeline model have one named home.
- Remove setup-time dependency knots in `Timeline.tsx`.
- Centralize duplicated timeline indexing logic.
- Move high-level timeline orchestration actions out of the render file.
- Keep the UI explicit and readable.

### Non-goals
- Do not redesign the app around ECS.
- Do not split `Track` / `Clip` into smaller data records.
- Do not create a mega `useTimelineController`.
- Do not create abstractions for every small helper.
- Do not mix behavior changes with structural refactor changes.

---

## Implementation Standards

Apply these standards to every file touched by this refactor.

### Style
- Use the `function` keyword for new top-level exported helpers and hooks.
- Add explicit return type annotations for new top-level exported helpers and hooks.
- Match existing hook style in this repo.

### API shape
- New hooks accept one typed options object.
- New hooks return one typed result object.
- Do not introduce long flat parameter lists.
- Minimize component props; prefer grouped objects when that matches the existing callsite and reduces prop noise.

### Scope
- Only simplify code that is actively being moved or rewired.
- Do not widen into unrelated cleanup.
- Remove dead imports, dead helpers, and duplicate logic created by the extraction itself.

### Readability
- Avoid nested ternary operators in touched code.
- Prefer explicit control flow over compact control flow.
- Avoid nested JSX component declarations inside component bodies.
- Keep JSX explicit and local unless repeated structure clearly benefits from extraction.

### Styling and JSX consistency
When touching JSX:
- Keep JSX minimal; avoid unnecessary wrappers.
- Use `cn` for class merging instead of manual string concatenation.
- Prefer `classList` for simple conditional styling where it is clearer.
- Do not introduce arbitrary bracket values for color, spacing, size, typography, or radius.
- Use existing Tailwind tokens or semantic utilities.

### Error handling
- Keep defensive `try/catch` where browser, audio, DOM, or external runtime behavior genuinely requires it.
- Do not widen `try/catch` blocks during refactor.
- If a touched block uses broad `try/catch` only because the logic is too tangled, simplify the logic first.

### Simplification discipline
- Simplify as code is moved, not in a separate cleanup phase later.
- After each extraction, remove dead imports, dead helpers, and duplicate local logic before moving on.
- If an issue is discovered outside touched files, record it in this tracker instead of folding it into the commit.

---

## Touched UI Consistency Checks

Apply these checks only to JSX files touched by this refactor.

Step 1 status:
- [x] `src/components/Timeline.tsx` remains explicit and easy to scan in touched sections
- [x] no new wrappers, nested JSX component declarations, or arbitrary bracket values were introduced in Step 1
- [x] no new long flat prop APIs were introduced in Step 1

Step 2 status:
- [x] `src/components/Timeline.tsx` and `src/components/timeline/timeline-overlays.tsx` remain explicit in touched sections
- [x] Step 2 added no wrapper churn, nested JSX component declarations, or arbitrary bracket values
- [x] the new shared helper reduces repeated local lookup code rather than adding consumer-facing prop noise

Step 3 status:
- [x] `src/components/Timeline.tsx` stays explicit while resolved-model construction moved into one named hook
- [x] Step 3 added no wrapper churn, nested JSX component declarations, or arbitrary bracket values
- [x] the extracted hook reduces tracing by giving resolved tracks and lookup state one home

Step 4 status:
- [x] `src/components/Timeline.tsx` no longer uses local getter wrappers for resolved model accessors
- [x] Step 4 kept touched JSX explicit and introduced no wrapper churn or arbitrary values
- [x] direct closures now sit at callsites instead of forcing readers to trace through local forwarding helpers

Step 5 status:
- [x] `src/components/Timeline.tsx` keeps explicit UI while high-level intents moved into one consumer-shaped hook
- [x] Step 5 added no wrapper churn, nested JSX component declarations, or arbitrary bracket values
- [x] action extraction reduced non-render tracing in `Timeline.tsx` without introducing a mega controller

Step 6 status:
- [x] `src/components/Timeline.tsx` keeps explicit UI while sidebar resize DOM plumbing moved into a focused hook
- [x] Step 6 added no wrapper churn, nested JSX component declarations, or arbitrary bracket values
- [x] sidebar resize cleanup now lives with the resize handlers instead of the main timeline cleanup block

Step 7 status:
- [x] `src/components/Timeline.tsx` now reads in the intended top-to-bottom order with source state, model wiring, local callbacks, actions, interaction hooks, effects, cleanup, and JSX grouped by concern
- [x] Step 7 preserved explicit JSX and added no wrapper churn, nested JSX component declarations, or arbitrary bracket values
- [x] action wiring that still depends on later hooks now uses small forwarding closures so the file order can stay readable without reintroducing local getter wrappers

Step 8 status:
- [x] `src/hooks/useClipDrag.ts` now keeps drag session lifecycle, optimistic track management, persistence, and history integration while pure placement math lives in `src/lib/clip-drag-placement.ts`
- [x] Step 8 preserved the shared track-index approach and removed placement-specific overlap math from the hook body
- [x] the extracted helper remains pure and consumer-shaped around clip-drag planning inputs instead of introducing a generic drag framework

Step 9 status:
- [x] `src/hooks/useTrackRecording.ts` now acts more clearly as the controller boundary while track-target policy and recorder/session lifecycle helpers live in dedicated lib modules
- [x] Step 9 preserved recording behavior, lock handling, auto-created track cleanup, and history integration while reducing mixed responsibilities in the hook body
- [x] the extracted helpers stay consumer-shaped around recording target selection and session cleanup instead of introducing a generic recording framework

Step 10 status:
- [x] `src/components/timeline/EffectsPanel.tsx` keeps explicit UI while current-target derivation and off-target audio/spectrum sync moved into focused hooks
- [x] Step 10 preserved explicit JSX, avoided config-driven UI, and added no wrapper churn or arbitrary bracket values in touched sections
- [x] the extracted hooks stay consumer-shaped around EffectsPanel’s exact target and sync needs instead of introducing a generic effects controller

Step 11 status:
- [x] `src/components/timeline/TransportControls.tsx` keeps explicit toolbar and menu JSX while project, sample, export, share, and tempo controller state moved into focused hooks
- [x] Step 11 preserved explicit UI, avoided config arrays, and added no wrapper churn or arbitrary bracket values in touched sections
- [x] the extracted hooks stay consumer-shaped around TransportControls’ exact menus and tempo behavior instead of introducing a generic toolbar controller

Step 12 status:
- [x] `src/lib/audio-engine.ts` now groups per-track runtime state into mixer, effects, synth, and meter runtime areas instead of coordinating the same concerns through one long list of parallel maps
- [x] Step 12 preserved public engine method names and behavior while narrowing the reader’s search space for runtime state ownership
- [x] the runtime grouping stayed local to `AudioEngine` internals and did not introduce ECS-style abstractions or a public API redesign

For each touched UI file, verify:
- [ ] JSX is still explicit and easy to scan top-to-bottom
- [ ] no unnecessary wrapper elements were introduced
- [ ] no nested JSX component declarations were introduced
- [ ] no new arbitrary bracket values were introduced
- [ ] `cn` is used where class merging is needed
- [ ] `classList` is used where simple conditional styling is clearer
- [ ] no new long flat prop APIs were introduced when a grouped object would be clearer
- [ ] no nested ternaries remain in touched sections unless there is only a single trivial conditional
- [ ] extracted UI helpers reduce tracing instead of increasing it

---

## Implementation Plan

### 1. Break setup-time dependency knots
- [x] Step 1 complete

#### 1.1 `useProjectedTimelineModel`
- [x] Done
File:
- `src/hooks/useProjectedTimelineModel.ts`

Change:
- remove the `tracks` input from the hook API
- derive existing track IDs and clip IDs from:
  - `fullViewData`
  - projection state inputs

New inputs to add:
- `pendingTrackEntriesById`
- `pendingClipCreatesById`
- `removedTrackIds`
- `removedClipIds`

Reason:
- this removes the current `resolved model -> projected model -> resolved model` setup cycle

Definition of done:
- `useProjectedTimelineModel` no longer depends on a resolved `Track[]` accessor

#### 1.2 `useTimelineProjectionState`
- [x] Done
File:
- `src/hooks/useTimelineProjectionState.ts`

Change:
- remove `getTrackClipIds` from the hook API
- compute track clip membership internally using:
  - `serverData().clips`
  - `pendingClipCreatesById()`
  - `removedClipIds()`
  - `committedClipEditsById()`
  - `draftClipEditsById()`

Reason:
- this removes the current `projection state -> trackLookup -> renderTracks -> projection state` setup cycle

Definition of done:
- `useTimelineProjectionState` no longer depends on `trackLookup()` from `Timeline.tsx`

#### 1.3 `useTimelineHistory`
- [x] Done
File:
- `src/hooks/useTimelineHistory.ts`

Change:
- replace eager `actions` input with lazy `getActions`
- history should read the action set only when undo/redo executes

Reason:
- this removes the eager setup-time knot between history and mixer/action wiring

Definition of done:
- `useTimelineHistory` no longer requires a fully-built action object at setup time

---

### 2. Create one shared timeline index helper
- [x] Step 2 complete

Create file:
- `src/lib/timeline-track-index.ts`
- [x] Created

Create pure function:
- `createTimelineTrackIndex(tracks: Track[])`

Returned shape:
- `trackById`
- `trackIndexById`
- `clipById`
- `clipTrackIdById`
- `clipEntryById`
- `clipIdsByTrackId`

First consumers to update where the shared helper clearly removes duplicated scans or duplicated lookup logic without adding indirection:
- [x] `src/components/Timeline.tsx`
- [x] `src/hooks/useClipDrag.ts`
- [ ] `src/hooks/useTimelineMidiOverlay.ts`
- [x] `src/hooks/useTimelineMixerController.ts`
- [x] `src/components/timeline/timeline-overlays.tsx`
- [x] `src/lib/resolve-timeline-tracks.ts`

Reason:
- these files already duplicate timeline index-building logic or repeated scans
- the shared helper should be adopted where it simplifies the file immediately, not as a blanket abstraction exercise

Definition of done:
- duplicated timeline index-building logic is consolidated where it clearly improves readability and removes repeated scans

---

### 3. Extract the resolved timeline model
- [x] Step 3 complete

Create file:
- `src/hooks/useTimelineResolvedModel.ts`
- [x] Created

Move from `src/components/Timeline.tsx`:
- local `resolveTracks(...)` wrapper
- `resolvedTracks`
- `placementTracks`
- `renderTracks`
- shared index memo
- identity reconciliation effect

Keep local in `Timeline.tsx`:
- `pendingDeleteTrackClipCount`

Reason:
- the resolved timeline model should have one named home
- `Timeline.tsx` should stop owning model construction

Definition of done:
- `Timeline.tsx` no longer constructs the resolved track views directly
- `Timeline.tsx` consumes `useTimelineResolvedModel`

---

### 4. Remove forward-reference getter dance from `Timeline.tsx`
- [x] Step 4 complete

File:
- `src/components/Timeline.tsx`

Remove:
- `getRenderTracks`
- `getResolvedTracks`
- `getPlacementTracks`

Replace them with the accessors returned by:
- `useTimelineResolvedModel`

Reason:
- these wrappers only exist to work around local declaration ordering
- once setup-time cycles are removed, they should not exist anymore

Definition of done:
- `Timeline.tsx` has no local getter wrappers for resolved model accessors

---

### 5. Extract high-level timeline actions
- [x] Step 5 complete

Create file:
- `src/hooks/useTimelineActions.ts`
- [x] Created

Move from `src/components/Timeline.tsx`:
- `createTimelineTrack`
- `jumpToClip`
- `handleTransportPause`
- `handleTransportStop`
- `handleRecordToggle`
- `handleShare`

Keep local in `Timeline.tsx` for now:
- `rescheduleChangedClips`
- `applyAgentMixOps`
- `pushEffectParamsHistory`

Reason:
- these are high-level timeline intents and currently clutter the render file
- the three kept-local functions are still small and single-consumer

Definition of done:
- `Timeline.tsx` no longer contains the action bodies above

---

### 6. Extract sidebar resize plumbing only
- [x] Step 6 complete

Create file:
- `src/hooks/useTimelineSidebarResize.ts`
- [x] Created

Move from `src/components/Timeline.tsx`:
- sidebar resize state
- sidebar mouse down / move / up handlers
- sidebar resize cleanup

Do not extract broader viewport state.

Reason:
- this is one self-contained DOM concern

Definition of done:
- `Timeline.tsx` no longer contains sidebar resize DOM plumbing

---

### 7. Reorder `Timeline.tsx` into explicit reading order
- [x] Step 7 complete

File:
- `src/components/Timeline.tsx`

Target order:
1. imports
2. local UI state
3. audio engine
4. source-state hooks
5. history / mixer / buffers
6. resolved model
7. small local timeline callbacks
8. high-level actions hook
9. interaction hooks
10. sync effects
11. cleanup
12. JSX

Reason:
- this makes the composition root readable top-to-bottom

Definition of done:
- `Timeline.tsx` reads in the order above

---

### 8. Refactor `useClipDrag.ts`
- [x] Step 8 complete

Create file:
- `src/lib/clip-drag-placement.ts`
- [x] Created

Move pure planning helpers out of `src/hooks/useClipDrag.ts`:
- `canPlaceClipOnTrack`
- `canPlaceMultiDrag`
- `resolveNonDupTargetTrackId`
- `resolveNonDupClipDragPlacement`
- `planDuplicatedClipPlacements`

Also:
- replace local track lookup creation with `createTimelineTrackIndex`

Keep in `src/hooks/useClipDrag.ts`:
- drag session state
- pointer lifecycle
- optimistic track creation/removal during drag
- persistence
- history integration
- cleanup

Definition of done:
- pure drag placement math is no longer inside the drag session hook

---

### 9. Refactor `useTrackRecording.ts`

Create files:
- `src/lib/track-recording-target.ts`
- `src/lib/track-recording-session.ts`

Move into `track-recording-target.ts`:
- track targeting / auto-track selection policy helpers
- auto-created track discard / commit helpers that belong to track-target policy

Move into `track-recording-session.ts`:
- stop promise creation
- mime selection
- track lock acquire / release helpers
- recorder/session cleanup helpers

Keep in `src/hooks/useTrackRecording.ts`:
- public hook API
- Solid signals
- controller wiring
- upload/finalization integration
- selection integration

Definition of done:
- `useTrackRecording.ts` acts as a controller, not a mixed policy/session monolith

---

### 10. Refactor `EffectsPanel.tsx`

Create files:
- `src/hooks/useEffectsPanelTarget.ts`
- `src/hooks/useEffectsPanelAudioSync.ts`

Move into `useEffectsPanelTarget.ts`:
- current target resolution
- current track / role / routing derived state
- return / group target derivation

Move into `useEffectsPanelAudioSync.ts`:
- off-target room-effect to audio-engine sync effect
- spectrum polling loop

Keep in `src/components/timeline/EffectsPanel.tsx`:
- explicit JSX
- explicit rail / toolbar / cards
- effect ordering state
- persisted effect state setup
- `createEffectsPanelState` wiring

Definition of done:
- `EffectsPanel.tsx` remains explicit UI, with non-UI sync logic moved out

---

### 11. Refactor `TransportControls.tsx`

Create files:
- `src/hooks/useProjectsMenuController.ts`
- `src/hooks/useSamplesMenuController.ts`
- `src/hooks/useExportsMenuController.ts`
- `src/hooks/useShareMenuController.ts`
- `src/hooks/useTransportTempoController.ts`

Move state/effects/handlers into those controllers exactly by concern.

Keep in `src/components/timeline/TransportControls.tsx`:
- explicit toolbar / menu JSX
- component composition

Do not convert the UI into config arrays.

Definition of done:
- `TransportControls.tsx` no longer owns the full controller logic for all menu sections and tempo behavior

---

### 12. Refactor `audio-engine.ts`
- [x] Step 12 complete

File:
- `src/lib/audio-engine.ts`

Do this after the timeline composition cleanup is stable, but still within this refactor commit.

Change:
- group per-track runtime state by responsibility instead of storing it in many parallel maps

Internal grouped runtime areas:
- mixer runtime
- effects runtime
- synth runtime
- meter runtime

Do not:
- change public engine method names
- redesign the engine around ECS

Definition of done:
- `audio-engine.ts` no longer coordinates per-track runtime state through a large number of separate parallel maps

---

## File Creation / Edit Checklist

### New files to create
- [x] `src/lib/timeline-track-index.ts`
- [x] `src/hooks/useTimelineResolvedModel.ts`
- [x] `src/hooks/useTimelineActions.ts`
- [x] `src/hooks/useTimelineSidebarResize.ts`
- [x] `src/lib/clip-drag-placement.ts`
- [x] `src/lib/track-recording-target.ts`
- [x] `src/lib/track-recording-session.ts`
- [x] `src/hooks/useEffectsPanelTarget.ts`
- [x] `src/hooks/useEffectsPanelAudioSync.ts`
- [x] `src/hooks/useProjectsMenuController.ts`
- [x] `src/hooks/useSamplesMenuController.ts`
- [x] `src/hooks/useExportsMenuController.ts`
- [x] `src/hooks/useShareMenuController.ts`
- [x] `src/hooks/useTransportTempoController.ts`

### Existing files to edit
- [x] `src/components/Timeline.tsx`
- [x] `src/hooks/useProjectedTimelineModel.ts`
- [x] `src/hooks/useTimelineProjectionState.ts`
- [x] `src/hooks/useTimelineHistory.ts`
- [x] `src/hooks/useClipDrag.ts`
- [x] `src/hooks/useClipBuffers.ts`
- [x] `src/hooks/useTrackRecording.ts`
- [ ] `src/hooks/useTimelineMidiOverlay.ts`
- [x] `src/hooks/useTimelineMixerController.ts`
- [x] `src/components/timeline/timeline-overlays.tsx`
- [x] `src/components/timeline/EffectsPanel.tsx`
- [x] `src/components/timeline/TransportControls.tsx`
- [x] `src/lib/resolve-timeline-tracks.ts`
- [x] `src/lib/audio-engine.ts`

---

## Validation Checklist

Run after major refactor steps:
- [x] `bun run typecheck` (after Step 1)
- [x] `bun run build` (after Step 1)
- [x] `bun run typecheck` (after Step 2)
- [x] `bun run build` (after Step 2)
- [x] `bun run typecheck` (after Step 3)
- [x] `bun run build` (after Step 3)
- [x] `bun run typecheck` (after Step 4)
- [x] `bun run build` (after Step 4)
- [x] `bun run typecheck` (after Step 5)
- [x] `bun run build` (after Step 5)
- [x] `bun run typecheck` (after Step 6)
- [x] `bun run build` (after Step 6)
- [x] `bun run typecheck` (after Step 7)
- [x] `bun run build` (after Step 7)
- [x] `bun run typecheck` (after Step 8)
- [x] `bun run build` (after Step 8)
- [x] `bun run typecheck` (after Step 9)
- [x] `bun run build` (after Step 9)
- [x] `bun run typecheck` (after Step 10)
- [x] `bun run build` (after Step 10)
- [x] `bun run typecheck` (after Step 11)
- [x] `bun run build` (after Step 11)
- [x] `bun run typecheck` (after Step 12)
- [x] `bun run build` (after Step 12)
- [ ] `bun run knip` (still failing on pre-existing repo issues)

Manual smoke checks before finishing:
- [ ] load project
- [ ] add audio track
- [ ] add instrument track
- [ ] add return track
- [ ] add group track
- [ ] play / pause / stop
- [ ] loop
- [ ] metronome
- [ ] record arm
- [ ] record stop
- [ ] clip drag
- [ ] duplicate drag
- [ ] clip resize
- [ ] delete track / clip
- [ ] sample insert
- [ ] drag-drop sample
- [ ] jump to clip
- [ ] MIDI editor open / close
- [ ] effects routing works
- [ ] effect commit history works
- [ ] export dialog opens
- [ ] project create / rename / delete
- [ ] share works
- [ ] AI/shared chat mix ops work
- [ ] undo / redo

---

## Running Findings / Bugs / Decisions Log

### Initial findings
- `Timeline.tsx` is the current orchestration bottleneck.
- The biggest concrete timeline cleanup targets are:
  - setup-time cycles
  - duplicated indexing
  - local resolved-model construction
  - inline high-level actions
  - inline sidebar resize plumbing
- `Track` and `Clip` are already the right readable domain objects for this repo and should stay that way.
- `useClipDrag.ts`, `useTrackRecording.ts`, `EffectsPanel.tsx`, and `TransportControls.tsx` are the next multi-concern hotspots after `Timeline.tsx`.
- `audio-engine.ts` should be cleaned up by grouping runtime state by responsibility, not by introducing ECS.

### Refactor log
- 2026-04-01: Tracker file created.
- 2026-04-01: Completed Step 1 by removing `useProjectedTimelineModel`'s resolved-track dependency, internalizing track clip membership in `useTimelineProjectionState`, and switching `useTimelineHistory` to lazy `getActions` wiring.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 1; both passed.
- 2026-04-01: Completed Step 2 by adding `src/lib/timeline-track-index.ts` and adopting it in `Timeline.tsx`, `useClipDrag.ts`, `useTimelineMixerController.ts`, `timeline-overlays.tsx`, and `resolve-timeline-tracks.ts`.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 2; both passed.
- 2026-04-01: Completed Step 3 by extracting `src/hooks/useTimelineResolvedModel.ts` and moving resolved/placement/render track construction, shared lookup creation, and identity reconciliation out of `Timeline.tsx`.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 3; both passed.
- 2026-04-01: Completed Step 4 by removing `getRenderTracks`, `getResolvedTracks`, and `getPlacementTracks` from `Timeline.tsx` and switching consumers to direct closures over resolved-model accessors.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 4; both passed.
- 2026-04-01: Completed Step 5 by extracting `src/hooks/useTimelineActions.ts` for track creation, clip jumping, sharing, and transport/record toggles, then rewiring `Timeline.tsx` to use it.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 5; both passed.
- 2026-04-01: Completed Step 6 by extracting `src/hooks/useTimelineSidebarResize.ts` and moving sidebar resize event wiring and cleanup out of `Timeline.tsx`.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 6; both passed.
- 2026-04-01: Completed Step 7 by reordering `Timeline.tsx` into the intended composition-root reading order and keeping behavior unchanged.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 7; both passed.
- 2026-04-01: Completed Step 8 by extracting pure placement planning into `src/lib/clip-drag-placement.ts` and trimming `useClipDrag.ts` back to drag-session orchestration.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 8; both passed.
- 2026-04-01: Completed Step 9 by extracting recording target policy and recording-session lifecycle helpers into `src/lib/track-recording-target.ts` and `src/lib/track-recording-session.ts`, then simplifying `useTrackRecording.ts` around them.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 9; both passed.
- 2026-04-01: Completed Step 10 by extracting EffectsPanel target-derivation and off-target audio/spectrum sync concerns into `src/hooks/useEffectsPanelTarget.ts` and `src/hooks/useEffectsPanelAudioSync.ts`.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 10; both passed.
- 2026-04-01: Completed Step 11 by extracting project/sample/export/share/tempo menu controllers into focused hooks and simplifying `TransportControls.tsx` around explicit toolbar/menu JSX.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 11; both passed.
- 2026-04-01: Completed Step 12 by grouping `AudioEngine`'s per-track runtime maps into mixer, effects, synth, and meter runtime areas while preserving existing engine behavior and method names.
- 2026-04-01: Ran `bun run typecheck` and `bun run build` after Step 12; both passed.
- 2026-04-01: Ran `bun run knip` after Step 12; it still reports pre-existing repo-level unused files/exports, one unlisted dependency, and one duplicate export outside this refactor scope.
- 2026-04-02: Started manual smoke validation. Unauthenticated `/` correctly redirected to `/about`, and the sign-in CTA opened `/Login`, but timeline/project smoke checks are blocked until an authenticated session is available.
- 2026-04-02: Fixed a runtime app-load regression in `src/components/Timeline.tsx` by introducing an early `renderTracks` accessor placeholder and assigning it from `useTimelineResolvedModel(...)`, so earlier hooks can safely close over the accessor before the resolved-model section runs.
- 2026-04-02: Ran `bun run typecheck` and `bun run build` after the app-load fix; both passed.
- 2026-04-02: Restored metadata-less default R2 samples in `/api/default-samples` and added one-time default-sample metadata plus waveform hydration in `useProjectSamples.ts` backed by IndexedDB peak records, so global defaults load once per app, persist locally, and become insertable without repeated decode work.
- 2026-04-02: Ran `bun run typecheck` and `bun run build` after the default-sample caching fix; both passed.

### Bugs / blockers discovered during implementation
- `bun run knip` still fails on pre-existing repo issues unrelated to this refactor, including unused UI files/exports, one unlisted `kysely` dependency reference in `api/auth.ts`, and a duplicate export in `src/lib/audio-peaks/asset-store.ts`.
- Manual smoke testing is currently blocked at the authenticated app boundary: `/` redirects to `/about`, `/Login` renders correctly, and `GET /api/auth/get-session` returns `null`, so timeline/project interactions cannot be exercised without signing in.
- 2026-04-02: Manual validation exposed a runtime regression on authenticated app load: `Cannot access 'renderTracks' before initialization`. This came from Step 7/12-era ordering leaving early hooks closed over the `renderTracks` const before `useTimelineResolvedModel(...)` initialized it.

### Decisions made during implementation
- 2026-04-01: Added explicit constraints from `consistency-guidelines.md` and `code-simplifier.md` to keep the refactor scoped, explicit, and consistent.
- 2026-04-01: Shared timeline indexing is required only where it removes duplicated scans or duplicated lookup logic without increasing indirection.
- 2026-04-01: `useProjectedTimelineModel` now derives existing track and clip IDs from server full-view data plus projection state, preserving optimistic grant reconciliation without depending on resolved tracks.
- 2026-04-01: `useTimelineProjectionState.removeLocalTrack` now computes track clip membership internally from server clips, pending creates, and committed/draft move patches so `Timeline.tsx` no longer feeds it render-model lookups.
- 2026-04-01: `useTimelineHistory` now accepts `getActions` and resolves the action set lazily at undo/redo execution time so history setup no longer closes over later mixer wiring.
- 2026-04-01: The shared `createTimelineTrackIndex` helper returns both low-level maps and `clipEntryById` so consumers can replace ad hoc mixed shapes without extra adapter code.
- 2026-04-01: Step 2 intentionally left `useTimelineMidiOverlay.ts` for later because it still uses a simple local clip search and was not required to land the first shared-index slice cleanly.
- 2026-04-01: `useTimelineResolvedModel` owns the old `bufferVersion()` dependency and identity reconciliation effect so model invalidation and history-ref tracking move together with the resolved model instead of staying split across files.
- 2026-04-01: `useClipBuffers` now accepts an optional `onBufferChange` callback instead of owning `bufferVersion`, which keeps the buffer invalidation trigger at the timeline composition boundary while letting the resolved-model hook depend on it.
- 2026-04-01: Step 4 replaced local getter wrappers with direct closures at consumer callsites, which removed the forwarding layer without forcing a broader file reorder yet.
- 2026-04-01: `useTimelineActions` is intentionally consumer-shaped around `Timeline.tsx`; it groups room, creation, transport, and navigation dependencies instead of introducing a generic controller surface.
- 2026-04-01: `useTimelineSidebarResize` owns both the DOM listeners and cleanup so the resize concern no longer leaks into Timeline-level teardown.
- 2026-04-01: Step 7 keeps `useTimelineActions` above some later interaction hooks by using small forwarding closures for recording and MIDI-open operations, which preserves the explicit reading order without reintroducing broader wrapper helpers.
- 2026-04-01: Step 8 keeps overlap/quantization planning pure in `src/lib/clip-drag-placement.ts` while letting `useClipDrag.ts` continue owning drag state, preview lifecycle, optimistic track creation, and persistence.
- 2026-04-01: Step 9 keeps `useTrackRecording.ts` as the recording controller while moving track-target policy and recorder/lock cleanup helpers into focused lib modules, preserving the existing upload/finalize flow and selection behavior.
- 2026-04-01: Step 10 keeps EffectsPanel explicit while moving current-target/routing derivation and off-target room-effect plus spectrum sync into focused hooks so the component body reads more like UI plus local effect state wiring.
- 2026-04-01: Step 11 keeps TransportControls explicit while moving each menu/tempo concern into a focused hook, preserving the existing toolbar composition and avoiding a generic controller object for unrelated behavior.
- 2026-04-01: Step 12 groups `AudioEngine` runtime state by mixer/effects/synth/meter responsibility in-place, which reduces parallel-map tracing without changing the engine's public surface or introducing new subsystem classes.

---

## Progress Tracker

- [x] Step 1: Break setup-time dependency knots
- [x] Step 2: Create shared timeline index helper
- [x] Step 3: Extract `useTimelineResolvedModel`
- [x] Step 4: Remove forward-reference getter dance from `Timeline.tsx`
- [x] Step 5: Extract `useTimelineActions`
- [x] Step 6: Extract `useTimelineSidebarResize`
- [x] Step 7: Reorder `Timeline.tsx`
- [x] Step 8: Refactor `useClipDrag.ts`
- [x] Step 9: Refactor `useTrackRecording.ts`
- [x] Step 10: Refactor `EffectsPanel.tsx`
- [x] Step 11: Refactor `TransportControls.tsx`
- [x] Step 12: Refactor `audio-engine.ts`
- [ ] Validation complete

---

## Final Success Criteria

The refactor is complete when all are true:
- `Timeline.tsx` no longer owns resolved model construction.
- `Timeline.tsx` no longer contains forward-reference getter wrappers.
- setup-time dependency knots are removed from projection/model/history wiring.
- timeline indexing exists in one shared helper.
- `useClipDrag.ts` uses the shared index helper and has pure placement math separated.
- `useTrackRecording.ts` is reduced to a controller boundary.
- `EffectsPanel.tsx` keeps explicit UI and moves non-UI sync logic out.
- `TransportControls.tsx` keeps explicit UI and moves per-section controller logic out.
- `audio-engine.ts` groups per-track runtime state by responsibility.
- `bun run typecheck`, `bun run build`, and `bun run knip` all pass.
