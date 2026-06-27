# Browser Drag-and-Drop Tracker

## Status

- Branch: `browser-drag-and-drop`
- Base: `7333ad9 Add effect reorder drag preview`
- Push policy: commit and push each completed phase after simplify and validators.
- Samples/files: keep existing native `DataTransfer` flow unchanged in this pass.

## Goal

Implement pointer-driven Browser device drag-and-drop for:

1. Audio effects to an existing track, a new track area, or an existing effect chain at an insertion index.
2. MIDI effect `Arpeggiator` to an instrument track or a new instrument track.
3. MIDI instrument `Synth` to an instrument track or a new instrument track.

## Reference Findings

### Current repo

- `src/hooks/useDrag.ts`: use the existing pointer lifecycle, pointer capture, global move/up/cancel listeners, and cleanup.
- `src/hooks/useTimelineDragDrop.ts`: reuse `yToLaneIndex(clientY, scrollElement)` and timeline bounds checks for track/new-track targeting.
- `src/components/timeline/create-effect-card-reorder-drag.ts`: reuse the ghost/insertion-preview approach and card-rect scanning ideas.
- `src/hooks/useTimelineBrowserController.ts`: resolve Browser item IDs into drag payloads here. Do not leak item IDs into drag sessions.
- `src/components/timeline/create-effects-panel-audio-effects-state.ts`: add a small `addByKind(effect)` dispatcher near existing per-kind add methods.
- `src/components/timeline/create-effects-panel-controller.ts`: publish device drop actions from the effects panel to `Timeline`. `Timeline` does not directly own `audioEffects`.

### Local references

- `/Users/juan/Documents/monorepo-new/apps/web/src/hooks/use-drag.ts`: borrow centralized pointer lifecycle and cleanup, reject broad generic drag framework.
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/inspector/effects.tsx`: borrow explicit ordered effect updates.
- `/Users/juan/Documents/dialkit/src/solid/components/Slider.tsx`: borrow local transient drag state, pointer capture, movement threshold, and cancel cleanup. Reject animation complexity.

### Web references

- MDN Pointer Events: `setPointerCapture()` keeps later pointer events routed to the source; `pointercancel` requires cleanup.
- MDN HTML Drag and Drop: keep native `DataTransfer` for files/samples, avoid it for rich app-internal device drag previews.

## Architecture

Use two drag systems:

1. Native DnD for samples and files through existing `useTimelineDragDrop` and `useTimelineClipImport`.
2. Pointer DnD for Browser devices, with custom ghost, target preview, compatibility checks, and explicit drop actions.

## Shared Types

Add `src/components/timeline/browser/browser-drag-types.ts`:

```ts
import type { AudioEffectKind } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";

export type BrowserDragPayload =
  | { kind: "audio-effect"; effect: AudioEffectKind; label: string }
  | { kind: "midi-effect"; effect: "arpeggiator"; label: string }
  | { kind: "midi-instrument"; instrument: "synth"; label: string };

export type BrowserDropTarget =
  | { kind: "track"; trackId: Track["id"] }
  | { kind: "new-track" }
  | { kind: "effect-chain"; targetId: Track["id"] | "master"; index: number }
  | { kind: "none" };

export type BrowserDragSession = {
  payload: BrowserDragPayload;
  pointer: { x: number; y: number };
  target: BrowserDropTarget;
  ghostOffset: { x: number; y: number };
  ghostSize: { width: number; height: number };
  didStartDragging: boolean;
};
```

Rules:

- No `itemId` in `BrowserDragPayload`.
- Use `new-track`, not `empty-timeline`.
- `ghostOffset` and `ghostSize` are captured at drag start. Overlay computes `left/top`.

## Phase 1: Browser Device Drag Foundation

### Goal

Dragging Browser effects/instruments shows a floating ghost after a 4px movement threshold. No drop mutation yet. Click-to-add remains working.

### Files

- Add `src/components/timeline/browser/browser-drag-types.ts`.
- Add `src/components/timeline/browser/create-browser-device-drag.ts`.
- Add `src/components/timeline/browser/browser-drag-overlay.tsx`.
- Modify `src/components/timeline/browser/browser-types.ts`.
- Modify `src/components/timeline/browser/timeline-left-browser.tsx`.
- Modify `src/hooks/useTimelineBrowserController.ts`.
- Modify `src/components/Timeline.tsx`.

### Browser model

```ts
export type BrowserDevicesModel = {
  effectSections: Accessor<BrowserSection[]>;
  instrumentSections: Accessor<BrowserSection[]>;
  onAddEffect: (itemId: string) => void;
  onAddInstrument: (itemId: string) => void;
  onDevicePointerDown: (event: PointerEvent, itemId: string) => void;
};
```

### Row wiring

```tsx
<BrowserItemRow
  item={item}
  onClick={() => visibleDeviceTree().onAdd(item.id)}
  onPointerDown={(event) => props.browser.devices.onDevicePointerDown(event, item.id)}
/>
```

### Drag threshold and click suppression

- Use a 4px dead zone before changing from pending to dragging.
- If threshold was crossed, suppress the trailing `click` so drop does not also click-add.
- Clear session on pointerup, pointercancel, and owner cleanup.

### Overlay

```tsx
<div
  class="pointer-events-none fixed z-50 opacity-70 shadow-2xl"
  style={{
    left: `${session().pointer.x - session().ghostOffset.x}px`,
    top: `${session().pointer.y - session().ghostOffset.y}px`,
    width: `${session().ghostSize.width}px`,
    height: `${session().ghostSize.height}px`,
  }}
>
  <div class="border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100">
    {session().payload.label}
  </div>
</div>
```

### Phase 1 gate

- Ghost appears only after 4px movement.
- Click-to-add still works.
- Samples still use native drag.
- Session cleanup is deterministic.
- Run simplify pass.
- Run `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- Commit: `Add browser device drag foundation`.
- Push branch.

## Phase 2: Drop Target Resolution and Visual Preview

### Goal

Resolve and preview existing track, new track area, effect-chain insertion index, and no-drop. No mutations yet.

### Track/new-track detection

Use `yToLaneIndex` with timeline bounds:

```ts
const resolveTimelineTrackTarget = (
  pointer: { x: number; y: number },
  scrollElement: HTMLDivElement | undefined,
  tracks: Track[],
): BrowserDropTarget => {
  if (!scrollElement) return { kind: "none" };
  const bounds = scrollElement.getBoundingClientRect();
  const insideTimeline =
    pointer.x >= bounds.left &&
    pointer.x <= bounds.right &&
    pointer.y >= bounds.top &&
    pointer.y <= bounds.bottom;
  if (!insideTimeline) return { kind: "none" };
  const laneIndex = yToLaneIndex(pointer.y, scrollElement);
  if (laneIndex >= 0 && laneIndex < tracks.length) return { kind: "track", trackId: tracks[laneIndex].id };
  if (laneIndex >= tracks.length) return { kind: "new-track" };
  return { kind: "none" };
};
```

### Effect-chain detection

- Only detect if effects panel is open and pointer is inside chain bounds.
- Use bounds plus `[data-effect-kind]` card rects.
- Do not use `elementFromPoint`.

```ts
const resolveEffectChainTarget = (
  pointer: { x: number; y: number },
  chainElement: HTMLElement | undefined,
  currentTargetId: Track["id"] | "master",
): BrowserDropTarget => {
  if (!chainElement) return { kind: "none" };
  const chainRect = chainElement.getBoundingClientRect();
  const inside =
    pointer.x >= chainRect.left &&
    pointer.x <= chainRect.right &&
    pointer.y >= chainRect.top &&
    pointer.y <= chainRect.bottom;
  if (!inside) return { kind: "none" };
  const cards = Array.from(chainElement.querySelectorAll<HTMLElement>("[data-effect-kind]"));
  for (let index = 0; index < cards.length; index += 1) {
    const rect = cards[index].getBoundingClientRect();
    if (pointer.x < rect.left + rect.width / 2) return { kind: "effect-chain", targetId: currentTargetId, index };
  }
  return { kind: "effect-chain", targetId: currentTargetId, index: cards.length };
};
```

### Compatibility

- Audio effects: track, new-track, effect-chain.
- MIDI effects: instrument track or new-track.
- MIDI instruments: instrument track or new-track.
- Audio tracks are no-drop for MIDI effect/instrument.

### Phase 2 gate

- Preview works for all valid/invalid targets.
- No mutations on pointerup.
- Run simplify pass.
- Run `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- Commit: `Add browser drag drop target previews`.
- Push branch.

## Phase 3: Device Drop Action Plumbing

### Goal

Publish effects-panel-owned drop actions up to `Timeline`.

### Files

- Add or modify a device drop action type near `src/components/timeline/timeline-device-insert-actions.ts`.
- Modify `src/components/timeline/create-effects-panel-audio-effects-state.ts`.
- Modify `src/components/timeline/create-effects-panel-controller.ts`.
- Modify `src/components/timeline/EffectsPanel.tsx`.
- Modify `src/components/timeline/timeline-panels.tsx`.
- Modify `src/components/Timeline.tsx`.

### Preferred action type

Prefer target-aware actions to avoid selected-target races:

```ts
export type TimelineDeviceDropActions = {
  addAudioEffectToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => void;
  addArpeggiatorToTarget: (targetId: Track["id"]) => void;
  addMidiClipToTarget: (targetId: Track["id"]) => Promise<void>;
  openSynthForTarget: (targetId: Track["id"]) => void;
  canWrite: boolean;
};
```

If target-aware methods become much larger than current-target methods, use current-target actions, but explicitly verify Solid signal timing and never use timers.

### Audio dispatcher

Add to audio effects state:

```ts
const addByKind = (effect: AudioEffectKind) => {
  if (effect === "eq") return addEq();
  if (effect === "saturator") return addSaturator();
  if (effect === "delay") return addDelay();
  addReverb();
};
```

### Indexed audio add

```ts
const addAudioEffectToCurrentTarget = (effect: AudioEffectKind, index?: number) => {
  audioEffects.addByKind(effect);
  if (index === undefined) return;
  const order = audioEffects.orderedEffects();
  if (!order.includes(effect)) return;
  audioEffects.reorder(effect, index);
};
```

If `orderedEffects()` does not include the new effect synchronously, fix at the effect state boundary. Do not add `setTimeout` or `requestAnimationFrame`.

### Phase 3 gate

- Action plumbing compiles.
- Click insert still works.
- Run simplify pass.
- Run `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- Commit: `Add browser device drop actions`.
- Push branch.

## Phase 4: Audio Effect Drop Commits

### Goal

Dropping audio effects commits to the target.

### Behavior

- Effect chain: select/open target, add effect, reorder to index.
- Existing track: select/open track FX target, add effect.
- New track: create audio track, select/open, add effect.

```ts
if (payload.kind === "audio-effect" && target.kind === "effect-chain") {
  selection.setSelectedFXTarget(target.targetId);
  bottomPanel.setMode("effects");
  bottomPanel.setOpen(true);
  deviceDropActions()?.addAudioEffectToTarget(target.targetId, payload.effect, target.index);
}
```

```ts
if (payload.kind === "audio-effect" && target.kind === "new-track") {
  const track = await createTimelineTrack();
  if (!track) return;
  selection.setSelectedFXTarget(track.id);
  bottomPanel.setMode("effects");
  bottomPanel.setOpen(true);
  deviceDropActions()?.addAudioEffectToTarget(track.id, payload.effect);
}
```

### Phase 4 gate

- EQ/Saturator/Delay/Reverb drop onto track.
- EQ/Saturator/Delay/Reverb drop onto new track.
- EQ/Saturator/Delay/Reverb drop into effect chain at correct index.
- Existing effect reorder still works.
- Audio chain order persists.
- Run simplify pass.
- Run `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- Commit: `Support browser audio effect drops`.
- Push branch.

## Phase 5: MIDI Effect and Instrument Drop Commits

### Goal

Support Arpeggiator and Synth drops.

### Behavior

- Arpeggiator to instrument track: select/open/add arpeggiator.
- Arpeggiator to new-track: create instrument track/select/open/add arpeggiator.
- Synth to instrument track: select/open/add MIDI clip, matching current click behavior.
- Synth to new-track: create instrument track/select/open/add MIDI clip.
- Audio tracks are no-drop for both.

### Phase 5 gate

- Arpeggiator works for instrument track and new-track.
- Synth works for instrument track and new-track.
- Both are no-drop on audio tracks.
- Click-to-add still works.
- Run simplify pass.
- Run `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- Commit: `Support browser instrument and MIDI effect drops`.
- Push branch.

## Phase 6: Final Review and Validation

### Simplify pass

Review the full branch diff for:

- redundant target resolver code
- broad generic drag abstractions
- stale unused props/types
- duplicated action surfaces
- unnecessary optional fields
- lingering `itemId` in drag payload
- timers/polling
- target-aware/current-target race risks
- click suppression correctness

### Reviews

- Run defensive review.
- Run reference-guided review.
- Run thermo/code-quality review.

### Final validators

```sh
git diff --check
bun run typecheck
bun test
bun run knip
bun run build
```

Fix failures and rerun failed validators.

## Progress Log

- [x] Tracker created.
- [x] Phase 1 complete, simplified, validated, committed, pushed.
  - 2026-06-27: Implemented Phase 1 browser device drag foundation locally. Added device drag types, 4px pointer threshold, floating ghost overlay, click suppression after real drags, and deterministic cleanup.
  - 2026-06-27: Simplify pass adopted reuse/quality fixes: reused `useDrag` lifecycle, removed redundant `didStartDragging`, cleaned stale click suppressor cleanup, and centralized Browser device payload/capability resolution.
  - 2026-06-27: Validators passed: `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- [x] Phase 2 complete, simplified, validated, committed, pushed.
  - 2026-06-27: Implemented Phase 2 browser device target resolution and visual previews. Track/new-track detection uses `yToLaneIndex` with timeline bounds, effect-chain insertion uses effects panel bounds plus `[data-effect-kind]` card rects, and no `elementFromPoint` is used.
  - 2026-06-27: Compatibility is visual-only: audio effects preview tracks, new track, and effect chain; MIDI effects/instruments preview only instrument tracks or new track; audio tracks no-drop for MIDI effects/instruments.
  - 2026-06-27: Simplify pass fixed stale effect-chain indicators, avoided pre-threshold target resolution, removed redundant new-track compatibility checks, and carried lane index on track targets to avoid repeated scans.
  - 2026-06-27: Validators passed: `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- [x] Phase 3 complete, simplified, validated, committed, pushed.
  - 2026-06-27: Implemented Phase 3 action plumbing locally without browser pointerup drop mutations. Effects panel now publishes target-aware device drop actions to `Timeline`, audio effects expose target/index insertion helpers, and instrument actions expose target-aware Arpeggiator/Synth/MIDI clip helpers for later drop commits.
  - 2026-06-27: Chose target-aware actions because existing persisted effect state already supports target-scoped updates through `updateForTarget`/draft maps, so this avoids selected-target races without timers or broad rewrites.
  - 2026-06-27: Simplify pass removed unused action surface, reused target helpers, guarded target-aware MIDI writes, avoided duplicate target devices, and fixed remote non-current audio order reads.
  - 2026-06-27: Validators passed: `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- [x] Phase 4 complete, simplified, validated, committed, pushed.
  - 2026-06-27: Implemented Phase 4 audio-effect drop commits locally only. Browser pointerup now commits `audio-effect` payloads for effect-chain, existing track, and new-track targets through target-aware actions; no-drop and MIDI/instrument payloads remain non-mutating.
  - 2026-06-27: Simplify pass changed audio drops to open/select only after successful inserts, added target-aware can-add checks for preview/drop, preserved master selection semantics, and caught async drop failures.
  - 2026-06-27: Validators passed: `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- [x] Phase 5 complete, simplified, validated, committed, pushed.
  - 2026-06-27: Implemented Phase 5 MIDI effect/instrument drop commits locally. Browser pointerup now commits Arpeggiator and Synth payloads for existing instrument tracks and new instrument tracks through target-aware actions; audio tracks remain no-drop through target resolution.
  - 2026-06-27: Simplify pass added target-aware MIDI/instrument can-drop checks, prevented duplicate Arpeggiator resets, and opens/selects only after successful target mutations.
  - 2026-06-27: Validators passed: `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`.
- [x] Final reviews and validators complete.
  - 2026-06-27: Final simplify/reference/defensive/thermos reviews found and fixed effect-chain hit-area overreach, persisted insertion order for new audio effects dropped into an existing chain, redundant pre-compatibility checks, and current-target write gating that blocked valid cross-target drags.
  - 2026-06-27: Final validators passed after fixes: `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`, `bun run build`.
