# Marquee Selection Refactor Tracker

## Goal

Implement Ableton-style Arrangement selection in the timeline. A user should be able to drag a time range across one or more tracks, see that range persistently highlighted as selected columns, and run duplicate, copy, paste, and delete against the exact selected section, including clips and track automation.

This tracker combines the initial Ableton-style arrangement selection plan with Opus's review concerns: narrow the first implementation to reliable range selection and section edits, avoid over-generalizing the selection model, make undo grouping a first-class requirement, keep local/shared write boundaries explicit, and phase risky clip-splitting and clipboard work behind tested pure helpers.

## Branch

- Branch name: `marquee-selection-refactor`
- Created from clean `master`.

## Reference Material

### Ableton references

Fresh references are saved in:

```txt
/private/tmp/ableton-ui-reference/arrangement-selection/
```

Use these first when designing visuals and interaction:

- `ableton-live12-arrangement-time-selection-cut-time.png`
  - Shows highlighted Arrangement time selection across multiple lanes.
- `ableton-live12-automation-transform-rectangle.png`
  - Shows automation and clip material selected as a rectangular time-domain region.
- `ableton-live12-automation-arranger-envelope.png`
  - Shows automation lanes as part of Arrangement editing.
- `ableton-live12-arrangement-selection-split.png`
  - Useful for boundary editing and split-like behavior.
- `ableton-live12-arrangement-loop-selection.png`
  - Useful for bar/loop region visual proportions.

### Local reference codebases

- `/Users/juan/Documents/monorepo-new`
  - Pattern to reuse: active selection is a first-class editing context, edits run as one history transaction, new content becomes selected.
  - Relevant file: `apps/web/src/components/engine/api/clipboard.ts`.
- `/Users/juan/Documents/dialkit`
  - Pattern to reuse: Solid controller APIs should expose small accessor-based surfaces, not scattered state plumbing.
  - Relevant file: `src/solid/createDialKit.ts`.
- `/Users/juan/Documents/solid-primitives`
  - Pattern to reuse: explicit range helpers with `start`, `to`, and `step` semantics. Do not bury range math inside component event handlers.
  - Relevant file: `packages/range/src/mapRange.ts`.
- `/Users/juan/Documents/opencode`
  - Pattern to reuse: keep sync/history boundaries explicit. Do not hide remote/local write behavior behind magic UI helpers.

## Current Repo Context

Important files:

- `src/hooks/useTimelineSelection.ts`
  - Current drag selection is transient and uses fixed `LANE_HEIGHT` hit testing.
- `src/hooks/useTimelineSelectionState.ts`
  - Current selection state tracks selected track, selected clip, selected clip ids, and FX target.
- `src/lib/timeline-selection.ts`
  - Centralizes clip/track/master selection helpers.
- `src/hooks/useTimelineClipActions.ts`
  - `duplicateSelectedClips()` and `deleteSelectedClips()` are clip-ID based.
  - Duplicate uses non-overlap placement, which is correct for clip duplication but wrong for exact time-range duplication.
- `src/hooks/useTimelineKeyboard.ts`
  - Owns global timeline shortcuts.
- `src/components/timeline/timeline-workspace.tsx`
  - Computes track layout with automation lane heights, but that layout is not shared with selection hit testing.
- `src/components/timeline/timeline-overlays.tsx`
  - Renders transient marquee and should render persistent range selection.
- `src/hooks/useTimelineAutomationController.ts`
  - Owns automation envelopes and exposes preview/commit/cancel.
- `src/components/timeline/create-persisted-automation-state.ts`
  - Owns persisted automation draft/commit behavior.
- `src/lib/local-automation.ts`
  - Local-first automation persistence.
- `packages/shared/src/shared-timeline-operations.ts`
  - Shared operation kinds include `automation.setEnvelope` and `automation.deleteEnvelope`.
- `src/lib/timeline-clip-write-adapter.ts`
  - Existing durable local/shared clip writes for delete, move, audio warp, and gain.
- `src/lib/undo/*`
  - Existing history model and persistence. Section edits need one grouped undo entry.

## Product Behavior

### Persistent range selection

- Dragging across timeline lanes creates a persistent `TimelineRangeSelection`.
- The selected time columns remain highlighted after pointer up.
- Selection spans one or more tracks, including visible automation lane height.
- Clicking a clip clears the range selection and restores existing clip selection behavior.
- Selecting a range clears selected clip ids.
- Track/sidebar selection behavior remains unchanged when no range is active.

### Duplicate

When `Ctrl/Cmd + D` runs with a range selection:

- Copy the exact selected section to the immediate next equal-length range.
- Preserve selected range length.
- Preserve each copied clip's offset within the range.
- Preserve automation values/points within the range.
- Do not insert global time.
- Do not shift later clips or automation.
- Do not use non-overlap nudging for range duplication.
- Select the destination range after duplication.

Example:

```txt
Selected range: bars 1-4
Destination:    bars 5-8
Result:         copied material keeps exact offsets inside the 4-bar section
```

### Delete

When Delete/Backspace runs with a range selection:

- Delete material inside the selected time range.
- Preserve timeline time, meaning later content does not shift left.
- Fully contained clips are removed.
- Boundary-overlapping clips are trimmed.
- Clips spanning the whole range are split into left and right pieces.
- Automation points inside the range are removed and boundary values are preserved.

### Copy and paste

Copy/paste is a second phase after duplicate/delete are stable:

- `Ctrl/Cmd + C` stores a timeline section clipboard.
- `Ctrl/Cmd + V` pastes at the active range start, or the playhead when no range is active.
- Clipboard should remain in app memory first. Do not introduce external clipboard serialization until the in-memory behavior is correct.

## Opus Review Adjustments Incorporated

- Do not implement a broad generic "selection system" abstraction. Add only the range selection shape needed by this feature.
- Treat grouped undo as required for quality. Avoid one undo step per clip/envelope.
- Keep clip-only duplicate/delete as fallback behavior when no range is selected.
- Keep exact range duplication separate from existing non-overlap clip duplication.
- Build and test pure section-edit helpers before UI wiring.
- Make automation boundary behavior explicit and tested before using it in actions.
- Keep local/shared persistence paths explicit through write adapters.
- Defer external/system clipboard support. Start with an in-memory section clipboard only.
- Avoid assumptions about time signatures. Use 4/4 bar snapping for the first implementation, isolated behind helper functions so time signature support can replace it later.
- Avoid "all tracks" magic. Range selection should explicitly carry selected track ids.
- Avoid tying final persistent selection to the transient marquee rectangle. The marquee remains drag feedback, the range selection is selection state.

## Phase 1: Pure Range and Layout Foundations

### New file: `src/lib/timeline-range-selection.ts`

Add range types and time snapping helpers:

```ts
import type { Track } from "@daw-browser/timeline-core/types";

export type TimelineTimeRange = {
  startSec: number;
  endSec: number;
};

export type TimelineRangeSelection = TimelineTimeRange & {
  trackIds: Track["id"][];
  primaryTrackId: Track["id"] | null;
};

export type TimelineRangeSelectionDraft = {
  anchorSec: number;
  currentSec: number;
  anchorTrackIndex: number;
  currentTrackIndex: number;
};

export const normalizeTimelineRangeSelection = (
  input: TimelineRangeSelection,
): TimelineRangeSelection | null => {
  const startSec = Math.min(input.startSec, input.endSec);
  const endSec = Math.max(input.startSec, input.endSec);
  if (endSec - startSec <= 1e-6) return null;
  if (input.trackIds.length === 0) return null;

  return {
    startSec,
    endSec,
    trackIds: input.trackIds,
    primaryTrackId: input.primaryTrackId,
  };
};

export const beatsToSeconds = (beats: number, bpm: number) => (
  beats * 60 / Math.max(1e-6, bpm)
);

export const barDurationSec = (bpm: number) => beatsToSeconds(4, bpm);

export const floorSecToBar = (timeSec: number, bpm: number) => {
  const bar = barDurationSec(bpm);
  return Math.floor(timeSec / bar) * bar;
};

export const ceilSecToBar = (timeSec: number, bpm: number) => {
  const bar = barDurationSec(bpm);
  return Math.ceil(timeSec / bar) * bar;
};
```

### New file: `src/lib/timeline-track-layout.ts`

Share track hit testing between workspace, selection, and overlays:

```ts
import type { Track } from "@daw-browser/timeline-core/types";

export type TimelineTrackLayoutRow = {
  trackId: Track["id"];
  topPx: number;
  heightPx: number;
  clipLaneHeightPx: number;
  automationHeightPx: number;
};

export const trackIndexAtY = (
  rows: readonly TimelineTrackLayoutRow[],
  y: number,
) => rows.findIndex((row) => y >= row.topPx && y < row.topPx + row.heightPx);

export const trackIdsInYRange = (
  rows: readonly TimelineTrackLayoutRow[],
  startY: number,
  endY: number,
) => {
  const top = Math.min(startY, endY);
  const bottom = Math.max(startY, endY);

  return rows
    .filter((row) => row.topPx < bottom && row.topPx + row.heightPx > top)
    .map((row) => row.trackId);
};
```

### Acceptance criteria

- Range normalization and bar snapping are tested.
- Track hit testing uses expanded automation lane heights.
- No UI behavior changes yet beyond shared layout extraction.

## Phase 2: Selection State and Persistent Highlight

### Modify `src/lib/timeline-selection.ts`

Extend `TimelineSelectionState`:

```ts
export type TimelineSelectionState = {
  selectedTrackId: Track["id"] | "";
  selectedClip: SelectedClip;
  selectedClipIds: Set<string>;
  selectedFXTarget: Track["id"] | "master";
  rangeSelection: TimelineRangeSelection | null;
};
```

Add selection helper:

```ts
export function selectTimeRange(
  setters: TimelineSelectionSetters,
  selection: TimelineRangeSelection,
) {
  batch(() => {
    setters.setRangeSelection(selection);
    setters.setSelectedClip(null);
    setters.setSelectedClipIds(new Set<string>());
    setters.setSelectedTrackId(selection.primaryTrackId ?? selection.trackIds[0] ?? "");
    setters.setSelectedFXTarget(selection.primaryTrackId ?? selection.trackIds[0] ?? "master");
  });
}
```

Update clip, track, and master selection helpers to clear `rangeSelection` where appropriate.

### Modify `src/hooks/useTimelineSelectionState.ts`

Expose:

```ts
rangeSelection: Accessor<TimelineRangeSelection | null>;
selectTimeRange: (selection: TimelineRangeSelection) => void;
clearTimeRange: () => void;
```

Reconcile range selections when tracks change:

- Drop missing track ids.
- Clear range selection if no selected track ids remain.
- Keep start/end times unchanged.

### Modify `src/hooks/useTimelineSelection.ts`

Inputs:

```ts
type TimelineSelectionOptions = {
  tracks: Accessor<Track[]>;
  trackLayout: Accessor<TimelineTrackLayoutRow[]>;
  selection: TimelineSelectionController;
  bpm: Accessor<number>;
  startScrub: (clientX: number, options?: { listen?: boolean }) => void;
  moveScrub: (clientX: number) => void;
  stopScrub: () => void;
};
```

Behavior:

- On lane pointer down, initialize a possible range selection.
- Preserve current "small movement scrubs" behavior until drag exceeds threshold.
- Once drag is active, compute bar-snapped time range and track ids from shared layout rows.
- Call `selection.selectTimeRange(next)` during drag.
- Keep `marqueeRect` as transient visual feedback only.

### Modify `src/components/timeline/timeline-overlays.tsx`

Add persistent selection rendering:

```tsx
<Show when={props.selection.range}>
  {(range) => (
    <For each={props.timeline.rowLayouts.filter((row) => range().trackIds.includes(row.trackId))}>
      {(row) => (
        <div
          class="absolute z-10 pointer-events-none bg-blue-400/12 border-x border-blue-300/30"
          style={{
            left: `${range().startSec * PPS}px`,
            top: `${row.topPx}px`,
            width: `${(range().endSec - range().startSec) * PPS}px`,
            height: `${row.heightPx}px`,
          }}
        />
      )}
    </For>
  )}
</Show>
```

Layering:

1. Timeline background
2. Grid
3. Persistent range highlight
4. Clips and automation
5. Transient marquee
6. Playhead

### Acceptance criteria

- Dragging bars creates persistent highlighted columns.
- Highlight covers visible automation lane height.
- Clicking clips clears range selection.
- Selecting range clears clip ids.
- Existing clip selection behavior remains intact.

## Phase 3: Pure Section Edit Helpers

### New file: `src/lib/timeline-section-edit.ts`

Core types:

```ts
import type { Clip, Track } from "@daw-browser/timeline-core/types";
import type { AutomationEnvelope, ClipCreateSnapshot } from "@daw-browser/shared";

export type TimelineSection = {
  range: TimelineTimeRange;
  trackIds: Track["id"][];
};

export type SectionClipFragment = {
  sourceClipId: string;
  sourceTrackId: Track["id"];
  targetTrackId: Track["id"];
  startOffsetSec: number;
  duration: number;
  clip: ClipCreateSnapshot;
  buffer: AudioBuffer | null;
};

export type SectionAutomationFragment = {
  sourceTargetKey: string;
  targetTrackId: Track["id"];
  parameterId: string;
  enabled: boolean;
  points: Array<{
    id: string;
    timeOffsetSec: number;
    value: number;
    interpolation: "linear" | "hold";
  }>;
};
```

Clip helpers:

- `clipEndSec(clip)`
- `intersectsRange(item, range)`
- `buildTrimmedClipCreateSnapshot(clip, input)`
- `buildSectionClipFragments(input)`
- `buildClipRangeDeletePatch(input)`

Automation helpers:

- `buildAutomationFragment(envelope, range)`
- `pasteAutomationFragment(input)`
- `deleteAutomationRange(input)`

Clip delete patch shape:

```ts
export type ClipRangeDeletePatch = {
  deleteClipIds: string[];
  updateClips: Array<{
    clipId: string;
    timing: {
      startSec: number;
      duration: number;
      leftPadSec?: number;
      bufferOffsetSec?: number;
      midiOffsetBeats?: number;
    };
  }>;
  createClips: BatchClipCreateItem[];
};
```

Boundary cases:

```txt
Outside range: unchanged
Fully inside: delete
Left overlap: shorten duration
Right overlap: move start to range end and advance media offsets
Spans range: keep left segment, create right segment
```

Automation delete rules:

- Remove interior points.
- Insert range boundary values to preserve envelope continuity.
- Delete envelope only if no meaningful points remain after range removal.

### Important implementation notes

- Do not typecast.
- Verify audio trim behavior against `src/lib/audio-left-resize-timing.ts`.
- Verify MIDI offset semantics before changing MIDI clip offsets.
- Prefer deterministic pure functions with explicit inputs and outputs.
- Do not write to local/shared persistence inside pure helpers.

### Tests: `src/lib/timeline-section-edit.test.ts`

Required cases:

1. Select bars 1-4 and duplicate to bars 5-8.
2. Clip fully inside range is copied with same offset.
3. Clip starts before range and ends inside range is trimmed on copy.
4. Clip starts inside range and ends after range is trimmed on copy.
5. Clip spans whole range creates a copied segment only.
6. Delete fully contained clip removes it.
7. Delete left overlap shortens clip.
8. Delete right overlap moves start and adjusts offsets.
9. Delete middle range splits clip.
10. Automation fragment includes start boundary, interior points, and end boundary.
11. Automation paste replaces destination range points.
12. Automation delete removes interior points and preserves boundary values.

## Phase 4: Explicit Write Adapters

### Modify `src/lib/timeline-clip-write-adapter.ts`

Add clip timing update support for delete-range trimming/splitting:

```ts
updateClipTiming: async (input: {
  clipId: string;
  startSec: number;
  duration: number;
  leftPadSec?: number;
  bufferOffsetSec?: number;
  midiOffsetBeats?: number;
}) => {
  if (isLocalId("project", context.projectId)) {
    const row = await createLocalTimelineRepository(context.projectId).updateClip(input);
    return Boolean(row);
  }

  if (!context.userId) return false;

  return await persistClipTiming(convexClient, convexApi, input);
}
```

Implementation detail:

- The current adapter does not receive `convexClient`/`convexApi`.
- Prefer passing them into the adapter only if needed by the call site, or create a small timing-specific adapter shaped around the range-delete consumer.

### New file: `src/lib/timeline-automation-write-adapter.ts`

Keep local/shared automation writes explicit:

```ts
import { isLocalId, type AutomationEnvelope } from "@daw-browser/shared";
import { deleteLocalAutomationEnvelope, setLocalAutomationEnvelope } from "~/lib/local-automation";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";

export const createTimelineAutomationWriteAdapter = (context: {
  projectId: string;
  userId: string | undefined;
}) => ({
  setEnvelope: async (envelope: AutomationEnvelope) => {
    if (isLocalId("project", context.projectId)) {
      await setLocalAutomationEnvelope(context.projectId, envelope);
      return true;
    }

    if (!context.userId) return false;

    await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId: context.userId,
      operation: {
        kind: "automation.setEnvelope",
        payload: {
          targetKind: envelope.target.kind,
          trackId: envelope.target.kind === "track" ? envelope.target.trackId : undefined,
          parameterId: envelope.parameterId,
          enabled: envelope.enabled,
          points: envelope.points,
          updatedAt: envelope.updatedAt,
        },
      },
    });

    return true;
  },

  deleteEnvelope: async (envelope: AutomationEnvelope) => {
    if (isLocalId("project", context.projectId)) {
      await deleteLocalAutomationEnvelope(context.projectId, envelope.targetKey);
      return true;
    }

    if (!context.userId) return false;

    await publishDurableSharedTimelineOperation({
      projectId: context.projectId,
      userId: context.userId,
      operation: {
        kind: "automation.deleteEnvelope",
        payload: {
          targetKind: envelope.target.kind,
          trackId: envelope.target.kind === "track" ? envelope.target.trackId : undefined,
          parameterId: envelope.parameterId,
        },
      },
    });

    return true;
  },
});
```

### Acceptance criteria

- Range actions use the same persistence semantics as existing local/shared timeline writes.
- Local-first behavior remains intact.
- Shared writes remain durable where existing automation writes are durable.

## Phase 5: Duplicate and Delete Actions

### Modify `src/hooks/useTimelineClipActions.ts`

Expose timeline-selection actions:

```ts
type TimelineClipActionsHandlers = {
  onClipPointerUp: (trackId: Track["id"], clipId: string, event: PointerEvent) => void;
  deleteSelectedClips: () => Promise<void>;
  duplicateSelectedClips: () => Promise<void>;
  duplicateTimelineSelection: () => Promise<void>;
  deleteTimelineSelection: () => Promise<void>;
  copyTimelineSelection: () => void;
  pasteTimelineSelection: () => Promise<void>;
  performDeleteTrack: (trackId: Track["id"]) => Promise<void>;
  requestDeleteTrack: (trackId: Track["id"]) => void;
  handleKeyboardAction: () => void;
};
```

Branching:

```ts
const duplicateTimelineSelection = async () => {
  const range = selection.rangeSelection();
  if (range) {
    await duplicateRangeSelection(range);
    return;
  }

  await duplicateSelectedClips();
};
```

Delete branching:

```ts
const deleteTimelineSelection = async () => {
  const range = selection.rangeSelection();
  if (range) {
    await deleteRangeSelection(range);
    return;
  }

  await deleteSelectedClips();
};
```

### Duplicate range algorithm

1. Read `range = selection.rangeSelection()`.
2. Build section snapshot from current tracks and automation envelopes.
3. Set `destinationStartSec = range.endSec`.
4. Create copied clips at `destinationStartSec + fragment.startOffsetSec`.
5. Paste automation fragments at destination range.
6. Push one grouped history entry.
7. Select destination range.

No overlap nudging is allowed in this path.

### Delete range algorithm

1. Build `ClipRangeDeletePatch`.
2. Apply clip deletes.
3. Apply timing updates for trimmed clips.
4. Create split right-side clips where needed.
5. Apply automation range deletion.
6. Push one grouped history entry.
7. Keep or reselect the same range.

### Acceptance criteria

- `Ctrl/Cmd + D` duplicates range when range exists, otherwise preserves existing clip duplicate behavior.
- Delete/Backspace deletes range when range exists, otherwise preserves existing clip/track delete behavior.
- Automation comes with duplicate/delete.
- Destination range becomes selected after duplicate.

## Phase 6: In-Memory Section Clipboard

### New file: `src/lib/timeline-section-clipboard.ts`

Start in-memory only:

```ts
export type TimelineSectionClipboard = {
  durationSec: number;
  trackIds: Track["id"][];
  clips: SectionClipFragment[];
  automation: SectionAutomationFragment[];
};

export function createTimelineSectionClipboard() {
  let value: TimelineSectionClipboard | null = null;
  return {
    read: () => value,
    write: (next: TimelineSectionClipboard) => {
      value = next;
    },
    clear: () => {
      value = null;
    },
  };
}
```

### Modify `src/hooks/useTimelineKeyboard.ts`

Add `Ctrl/Cmd + C` and `Ctrl/Cmd + V` only after duplicate/delete pass tests:

```ts
onCopy: () => void;
onPaste: () => void;
```

Do not intercept copy/paste in editable targets. Existing editable target checks must remain.

### Acceptance criteria

- Copy stores current range section.
- Paste writes at active range start or playhead.
- Paste selects pasted range.
- Existing browser/editor copy behavior is not broken for inputs or editable controls.

## Phase 7: Grouped History

### Add history entry

Add a grouped history entry:

```ts
export type TimelineSectionEditHistoryEntry = {
  type: "timeline-section-edit";
  projectId: string;
  data: {
    beforeClips: Array<{ trackRef: TrackRef; clip: HistoryClipSnapshot }>;
    afterClips: Array<{ trackRef: TrackRef; clip: HistoryClipSnapshot }>;
    beforeAutomation: AutomationEnvelope[];
    afterAutomation: AutomationEnvelope[];
  };
};
```

Update:

- `src/lib/undo/types.ts`
- `src/lib/undo/builders.ts`
- `src/lib/undo/exec.ts`
- `src/lib/undo/history-persistence.ts`
- `src/lib/undo/persisted-history.ts`
- `src/lib/undo/history-model.ts`

### Requirements

- One duplicate range action must require one undo.
- One delete range action must require one undo.
- Undo/redo must restore both clips and automation.
- Persisted history parsing must tolerate legacy entries and reject malformed section entries safely.

## Phase 8: Integration Points

### `src/components/Timeline.tsx`

- Pass `bpm` and `trackLayout` into `useTimelineSelection`.
- Use `duplicateTimelineSelection` in keyboard and transport props.
- Use `deleteTimelineSelection` in keyboard and transport props.
- Wire copy/paste only after Phase 6.

### `src/components/timeline/timeline-workspace.tsx`

- Extract computed track layout rows into shared `TimelineTrackLayoutRow[]`.
- Pass row layouts to overlays.
- Keep existing `TrackLane` rendering unchanged except for selection prop additions if needed.

### `src/components/timeline/timeline-overlays.tsx`

- Render persistent range highlight from `selection.range`.
- Keep transient marquee rendering separate.

### `src/components/timeline/TrackLane.tsx`

- Avoid pushing selection range logic into clip rendering unless absolutely necessary.
- Clips should remain selected by clip id. Range highlight is an overlay responsibility.

## File Checklist

### Add

- `src/lib/timeline-range-selection.ts`
- `src/lib/timeline-track-layout.ts`
- `src/lib/timeline-section-edit.ts`
- `src/lib/timeline-section-edit.test.ts`
- `src/lib/timeline-section-clipboard.ts`
- `src/lib/timeline-automation-write-adapter.ts`

### Modify

- `src/lib/timeline-selection.ts`
- `src/hooks/useTimelineSelectionState.ts`
- `src/hooks/useTimelineSelection.ts`
- `src/hooks/useTimelineClipActions.ts`
- `src/hooks/useTimelineKeyboard.ts`
- `src/components/Timeline.tsx`
- `src/components/timeline/timeline-workspace.tsx`
- `src/components/timeline/timeline-overlays.tsx`
- `src/lib/timeline-clip-write-adapter.ts`
- `src/lib/undo/types.ts`
- `src/lib/undo/builders.ts`
- `src/lib/undo/exec.ts`
- `src/lib/undo/history-persistence.ts`
- `src/lib/undo/persisted-history.ts`
- `src/lib/undo/history-model.ts`

## Validation Plan

Run after implementation:

```bash
bun run typecheck
bun test
git diff --check
bun run build
```

Manual checks:

- Drag bars 1-4 on one track, see persistent highlight.
- Drag bars 1-4 across multiple tracks, see per-track highlights.
- Open automation lanes, drag selection across clip and automation areas, see highlight cover full track height.
- Press `Ctrl/Cmd + D`, verify exact copied offsets and automation.
- Press Delete/Backspace, verify clips and automation are removed/trimmed without shifting later content.
- Click clip after range selection, verify range clears and clip selection works.
- Copy/paste range after Phase 6, verify paste location and selected destination range.

## Risks

- Clip trimming can corrupt audio/MIDI offsets if implemented without tests.
- Automation boundary values can produce audible jumps if deleted/pasted incorrectly.
- Existing non-overlap duplicate behavior must remain for clip-only selections.
- Shared project writes must remain durable and permission-aware.
- Undo must be grouped, or the UX will feel broken for multi-track section edits.
- Fixed `LANE_HEIGHT` hit testing must not survive in new range selection paths because automation-expanded tracks make it incorrect.

## Sub-Agent Handoff Summary

Implement this in phases. Start with `timeline-range-selection.ts`, `timeline-track-layout.ts`, and `timeline-section-edit.ts` plus tests. Then wire persistent selection visuals. Only after pure helpers and selection state are stable, wire duplicate/delete actions. Add copy/paste last. Preserve existing clip-only behavior when no range is selected. Validate with `bun run typecheck`, `bun test`, `git diff --check`, and `bun run build`.
