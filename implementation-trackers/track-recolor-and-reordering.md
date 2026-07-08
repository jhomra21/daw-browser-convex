# Track Recolor and Reordering Tracker

## Goal

Implement track recoloring and Ableton-style compact track rows while preserving the existing local-first repository flow, Convex sync, shared operation contracts, undo model, and tree-aware track layout.

This tracker combines the original planning pass with the Opus plan review. The main correction from review is that collapsed row height must become a layout-wide concern. Any path that maps pointer Y coordinates to tracks must use `TimelineTrackLayoutRow`, not fixed `LANE_HEIGHT` math.

## Branch

`track-recolor-and-reordering`

## References

- Local Ableton reference images:
  - `/private/tmp/ableton-ui-reference/track-grouping/ableton-live12-adjusting-track-height.png`
  - `/private/tmp/ableton-ui-reference/track-grouping/ableton-live12-folded-group-track-arrangement.png`
  - `/private/tmp/ableton-ui-reference/track-grouping/ableton-live12-arrangement-view-track-controls.png`
  - `/private/tmp/ableton-ui-reference/track-grouping/ableton-live-12-track-groups.png`
- Local reference codebases inspected:
  - `/Users/juan/Documents/dialkit`
  - `/Users/juan/Documents/monorepo-new`
  - `/Users/juan/Documents/opencode`
  - `/Users/juan/Documents/solid-primitives`
  - `/Users/juan/Documents/daw-effect-research`
- Current docs consulted:
  - MDN `MouseEvent.metaKey`, `altKey`, pointer events, and pointer capture.
  - Solid docs for `createMemo`, effects, and event handling.

## Existing State

Already present:

- `Track.color` and `Track.collapsed` exist in:
  - `packages/timeline-core/src/types.ts`
  - `src/lib/timeline-repository/types.ts`
  - `convex/schema.ts`
  - `src/lib/resolve-timeline-tracks.ts`
- Track colors persist through:
  - local `updateTrack({ color })`
  - shared op `tracks.setColor`
  - Convex `tracks.serverSetColor`
  - undo history entry `track-color`
- Group color propagation exists as a manual path:
  - `planAssignGroupColor`
  - `assignGroupColorToContents`
  - currently updates descendants and descendant clips.
- Group collapse exists:
  - `flattenVisibleTracks` hides descendants when a group has `collapsed === true`.
  - `TrackLane` renders a group clip overview for collapsed groups.
- Core track reordering is now present:
  - `planTrackReorder`, `resolveTrackDropZone`, and `normalizeDragMoveSet` live in `src/lib/track-group-ops.ts`.
  - `TrackSidebar` starts a pointer-captured drag from empty sidebar row space, maps pointer Y through `TimelineTrackLayoutRow`, and calls `onReorderTracks`.
  - `useTimelineActions.reorderTracks` persists through local `reorderAndGroup` or shared `tracks.reorderAndGroup`, asserts shared results, updates local projection, and pushes reorder history.
  - `TimelineWorkspace` derives visible tracks from `trackLayout`, so sidebar rows and timeline lanes move together.
  - The master row is separate from `tracks`/`trackLayout`, so it is intentionally not reorderable.

Missing:

- Normal and return tracks do not collapse into slim rows.
- Sidebar and lane row heights still assume `LANE_HEIGHT` in places.
- Clip drag, browser device drag, and recording overlays still include fixed-height assumptions.
- Group recolor is manual, but the requested behavior is automatic cascading on group color change.
- No modifier-click collapse-all action exists.
- No visible per-track color picker exists, only clear color via context menu.
- Track reordering still needs explicit verification:
  - Reordering intentionally has no visible drag-handle icon. Empty sidebar row space should select the track on pointer-down and allow the same hold-drag to reorder it, not from buttons or form controls.
  - There is no component-level coverage for the sidebar drag gesture.
  - Multi-selection with hidden collapsed descendants needs an explicit audit.

## Track Reordering Status and Follow-up Plan

The original branch plan mentioned reordering through the requirement to preserve "drag-to-reorder through a stable compact-row drag target", but it did not include a standalone reordering phase. The implementation has since grown the core reorder path, so the remaining work is not a fresh architecture. It is verification and UX hardening.

### Current user behavior

- Users can click-hold empty sidebar row space to select that track and drag after a small pointer movement threshold.
- Dropping above or below another visible row changes track order.
- Dropping inside a group reparents the moved track or moved subtree into that group.
- Dragging a group moves its descendants with it.
- Multi-selected tracks can move together after `normalizeDragMoveSet` removes selected descendants of selected parents.
- Timeline rows move with sidebar rows because both are derived from `TimelineTrackLayoutRow`.
- Master cannot be moved because it is rendered as a separate master row, not as a normal track row.

### Reorder UX hardening plan

1. Audit the current `TrackSidebar` drag source:
   - `startTrackDrag`
   - `updateTrackDrag`
   - `finishTrackDrag`
   - row pointer bindings and interactive-control guards
2. Keep drag behavior handle-free:
   - Keep the existing pointer-capture drag state and 4px threshold.
   - Select an unselected track on pointer-down from empty row space, then allow that same pointer hold to become a reorder drag.
   - Preserve multi-track movement when the pointer-down starts on an already selected track.
   - Do not start drag from selects, color inputs, volume controls, automation controls, record/solo buttons, delete controls, or context menus.
   - Do not render a drag-handle icon.
   - Keep the empty-space row drag source usable in expanded and collapsed rows.
3. Audit hidden-selection behavior:
   - Build a visible track id set from `trackLayout`.
   - If hidden descendants can remain in `selectedTrackIds` after a group collapses, filter active drag selection to visible ids and always include the dragged track before calling `normalizeDragMoveSet`.
   - Stop and reassess if selection range semantics already guarantee hidden descendants are cleared.
4. Keep persistence and history contracts unchanged:
   - `onReorderTracks(trackIds, target)` remains the component boundary.
   - `tracks.reorderAndGroup` remains the shared operation.
   - Local `TimelineRepository.reorderAndGroup` remains the local persistence path.
   - `buildTrackReorderHistoryEntry` remains the undo model.
   - Expanding a collapsed group after an inside drop remains outside reorder history, matching existing collapse behavior.
5. Strengthen tests:
   - Add pure planner coverage for multi-root movement, below-group insertion after the full subtree, non-group inside rejection, return-track reorder intent, and moved-subtree target rejection where not already covered.
   - Add layout/order coverage showing reordered tracks produce matching visible row order and hidden collapsed descendants cannot be drop targets through row layout.
   - Add component-level sidebar drag coverage only if the current test setup can exercise pointer events without a broad new test harness.

### Manual reorder QA checklist

- Drag one normal track above another.
- Drag one normal track below another.
- Drag a group above/below another row and verify descendants move with it.
- Drag a normal track into an expanded group.
- Drag a normal track into a collapsed group and verify the group expands.
- Select multiple visible tracks and drag them together.
- Collapse a group, then verify hidden descendants cannot be targeted.
- Verify timeline lanes and clips move with the sidebar rows.
- Verify master cannot be dragged or targeted.
- Verify undo/redo restores the previous order.
- In a shared project, verify a rejected `tracks.reorderAndGroup` does not leave stale local projection.

### Reorder validation commands

```sh
bun test src/lib/track-group-ops.test.ts src/lib/timeline-track-layout.test.ts
bun run typecheck
bun test
bun run knip
git diff --check
bun run build
```

## Design Decisions

1. Do not add schema fields or migrations.
2. Reuse `Track.collapsed?: boolean`.
3. Interpret `collapsed === true` as:
   - normal or return track: slim row only.
   - group track: slim row plus hidden descendants.
4. Keep collapse out of undo history, matching current group collapse behavior.
5. Make `TimelineTrackLayoutRow` the single source of truth for vertical row positioning and height.
6. Make group recolor automatic through the same `setTrackColor` entrypoint used by individual track recolor.
7. Remove the redundant manual “Assign color to grouped tracks and clips” action once group recolor is automatic.
8. Keep clip color clearing unchanged. Clips require `color: string`, so clearing a group color should clear track colors but leave clip colors unchanged.

## Reference Lessons to Borrow

- From `dialkit`:
  - Use a simple native color input and validate committed hex values.
  - Keep collapse interaction local and explicit.
  - Centralize modifier detection instead of scattering `metaKey` and `altKey` checks.
- From `monorepo-new`:
  - Separate UI interaction from committed domain updates.
  - Treat bulk color changes as one logical history operation.
  - Keep row height as domain/layout state, not ad hoc styling.
- From `solid-primitives`:
  - Keep derived row maps and segments in `createMemo`.
  - Avoid effect-driven derived state.
- From current app patterns:
  - Use `runWithConcurrency` for bulk persistence.
  - Reuse `persistTrackPatch`, `applyTrackPatch`, and `section-edit` history.
  - Use `trackLayoutRowAtY` and binary-search row hit testing.

## Phase 1: Layout Constants and Rows

### Files

- `src/lib/timeline-utils.ts`
- `src/lib/timeline-track-layout.ts`
- `src/lib/timeline-track-layout.test.ts`

### Plan

Add an explicit collapsed height:

```ts
export const COLLAPSED_LANE_HEIGHT = 28
```

Centralize clip lane height selection in `timeline-track-layout.ts`:

```ts
const trackClipLaneHeight = (
  track: Pick<Track, 'collapsed'>,
) => track.collapsed === true ? COLLAPSED_LANE_HEIGHT : LANE_HEIGHT
```

Update `buildTimelineTrackLayoutRows`:

```ts
const clipLaneHeightPx = trackClipLaneHeight(track)
const automationHeightPx = track.collapsed === true
  ? 0
  : input.visibleByTrackId[track.id] === true
    ? (input.heightsByLaneOwnerKey[track.id] ?? DEFAULT_AUTOMATION_LANE_HEIGHT)
      * (input.visibleParameterIdsByTrackId[track.id]?.length || 1)
    : 0

const row = {
  trackId: track.id,
  topPx,
  heightPx: clipLaneHeightPx + automationHeightPx,
  clipLaneHeightPx,
  automationHeightPx,
  depth: input.depthByTrackId?.get(track.id) ?? 0,
  groupId: track.groupId,
}
```

Keep `flattenVisibleTracks` unchanged so collapsed groups still hide descendants.

### Tests

- Collapsed normal track uses `COLLAPSED_LANE_HEIGHT`.
- Collapsed track suppresses automation height.
- Expanded track still includes automation height.
- Collapsed group still hides descendants.
- Mixed expanded and collapsed rows remain binary-search hit-testable.

## Phase 2: Pointer Targeting and Drag Paths

### Files

- `src/lib/timeline-track-layout.ts`
- `src/lib/clip-drag-session.ts`
- `src/hooks/useClipDrag.ts`
- `src/components/timeline/browser/create-browser-device-drag.ts`
- `src/hooks/useTimelineBrowserController.ts`
- `src/components/Timeline.tsx`

### Plan

Add a row-layout-aware helper:

```ts
export const trackLayoutRowIndexAtClientY = (
  rows: readonly Pick<TimelineTrackLayoutRow, 'topPx' | 'heightPx'>[],
  clientY: number,
  scrollElement: HTMLDivElement,
): number => {
  const rect = scrollElement.getBoundingClientRect()
  const localY = clientY - rect.top + (scrollElement.scrollTop || 0) - RULER_HEIGHT
  return trackIndexAtY(rows, localY)
}
```

Then remove fixed `yToLaneIndex` dependence from track targeting paths that operate on variable-height timeline rows.

Requirements:

- `useClipDrag` should accept `trackLayout: Accessor<TimelineTrackLayoutRow[]>`.
- Clip drag should resolve destination by visible row `trackId`, not `tracks[laneIndex]`.
- Hidden descendants must never become pointer targets.
- Pointer positions below the last row should keep existing new-track/drop behavior.
- Browser device drag should accept `trackLayout` and resolve:
  - row hit: `{ kind: 'track', trackId: row.trackId, laneIndex }`
  - below final row: `{ kind: 'new-track' }`

Stop and reassess if clip placement currently requires a broad rewrite beyond mapping visible row targets back to full track ids.

## Phase 3: Overlay Alignment

### Files

- `src/components/timeline/timeline-overlays.tsx`

### Plan

Use `rowLayouts` as the source of truth:

- Recording preview:
  - find row by `recordingTrackId`
  - use `row.topPx`
  - use `row.clipLaneHeightPx`
- Range overlay:
  - continue using row layout data.
- New-track drop overlay:
  - keep `LANE_HEIGHT` only for the synthetic new-track row.

This prevents recording and selection visuals from drifting when rows have mixed expanded/collapsed heights.

## Phase 4: Layout-Driven Track Lane

### Files

- `src/components/timeline/TrackLane.tsx`
- `src/components/timeline/timeline-workspace.tsx`

### Plan

Change `TrackLane` to receive the full layout row:

```ts
type TrackLaneProps = {
  track: Track
  layout: Pick<
    TimelineTrackLayoutRow,
    'topPx' | 'heightPx' | 'clipLaneHeightPx' | 'automationHeightPx'
  >
  groupClipOverview: Array<{ startSec: number; endSec: number }>
  // existing action props stay unchanged
}
```

Use layout values:

- container top: `props.layout.topPx`
- container height: `props.layout.heightPx`
- separator top: `props.layout.clipLaneHeightPx - 1`
- automation top: `props.layout.clipLaneHeightPx`
- automation height: `props.layout.automationHeightPx`

Only render automation when:

```ts
props.automation.visible && props.layout.automationHeightPx > 0
```

Collapsed overview segments:

```ts
const collapsedSegments = createMemo(() => {
  if (props.track.channelRole === 'group') return props.groupClipOverview
  return props.track.clips.map((clip) => ({
    startSec: clip.startSec,
    endSec: clip.startSec + clip.duration,
  }))
})
```

Render slim segments with relative vertical sizing, not fixed `top-3 h-10`:

```tsx
<div
  class="absolute top-1 bottom-1 rounded-sm border border-white/10 bg-green-400/35"
  style={{
    left: `${segment.startSec * PPS}px`,
    width: `${Math.max(2, (segment.endSec - segment.startSec) * PPS)}px`,
  }}
/>
```

## Phase 5: Layout-Driven Sidebar and Collapse UI

### Files

- `src/components/timeline/TrackSidebar.tsx`
- `src/components/timeline/timeline-workspace.tsx`
- `src/components/Timeline.tsx`

### Plan

Add sidebar action:

```ts
onSetTracksCollapsed: (
  updates: Array<{ trackId: Track['id']; collapsed: boolean }>
) => void
```

Inside `TrackSidebar`, derive row dimensions from `layoutByTrackId`:

```ts
const rowLayout = () => layoutByTrackId().get(track.id)
const rowHeightPx = () => rowLayout()?.heightPx ?? LANE_HEIGHT
const clipLaneHeightPx = () => rowLayout()?.clipLaneHeightPx ?? LANE_HEIGHT
const automationHeightPx = () => rowLayout()?.automationHeightPx ?? 0
```

Replace local height math:

- row height uses `rowHeightPx()`
- control row height uses `clipLaneHeightPx()`
- automation row top uses `clipLaneHeightPx()`
- automation row height uses `automationHeightPx()`

Do not turn off automation visibility state when a row collapses. Hide displayed automation only:

```ts
const displayedAutomationVisible = () =>
  track.collapsed !== true && automationVisible()
```

Use `displayedAutomationVisible()` for automation lane rendering and automation add/show controls.

Add a collapse button for every track type:

```tsx
<button
  class="flex h-7 w-4 shrink-0 items-center justify-center text-xs text-muted-foreground hover:text-foreground"
  onClick={(event) => {
    event.stopPropagation()
    handleTrackCollapseClick(track, event)
  }}
  title={track.collapsed ? 'Expand track' : 'Collapse track'}
>
  {track.collapsed ? '▶' : '▼'}
</button>
```

Modifier-click bulk collapse helper:

```ts
const isBulkCollapseModifier = (event: MouseEvent | PointerEvent) => (
  event.metaKey || event.altKey
)
```

Handler:

```ts
const handleTrackCollapseClick = (track: Track, event: MouseEvent) => {
  const collapsed = track.collapsed !== true

  if (!isBulkCollapseModifier(event)) {
    sidebar().onToggleTrackCollapsed(track.id)
    return
  }

  const updates = sidebar().allTracks
    .filter((candidate) => candidate.collapsed !== collapsed)
    .map((candidate) => ({ trackId: candidate.id, collapsed }))

  sidebar().onSetTracksCollapsed(updates)
}
```

Collapsed sidebar rows should show only:

- collapse button
- color swatch/input
- track name or mute/name affordance
- optional solo affordance if it fits cleanly

Collapsed sidebar rows should not render:

- routing selectors
- send selectors
- automation buttons
- automation lane controls
- full meter
- volume slider

Preserve:

- drag-to-reorder through a stable compact-row drag target.
- group rail and parent group rail rendering.
- current selected-track styling.

## Phase 6: Track Color Picker

### Files

- `src/components/timeline/TrackSidebar.tsx`

### Plan

Add a compact swatch/input in expanded and collapsed row layouts:

```tsx
<label
  class="relative size-4 shrink-0 overflow-hidden rounded-sm border border-border"
  style={{ background: trackColor() }}
  title="Set track color"
  onClick={(event) => event.stopPropagation()}
>
  <input
    type="color"
    value={track.color ?? '#22c55e'}
    class="absolute inset-0 cursor-pointer opacity-0"
    onChange={(event) => {
      const color = event.currentTarget.value
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) return
      sidebar().onSetTrackColor(track.id, color)
    }}
  />
</label>
```

Keep context-menu `Clear track color`.

Remove context-menu `Assign color to grouped tracks and clips` after automatic group cascading is wired.

## Phase 7: Color Planning and History

### Files

- `src/lib/track-group-ops.ts`
- `src/lib/track-group-ops.test.ts`
- `src/hooks/useTimelineActions.ts`
- `src/components/timeline/TrackSidebar.tsx`
- `src/components/timeline/timeline-workspace.tsx`
- `src/components/Timeline.tsx`

### Plan

Replace `planAssignGroupColor` with `planSetTrackColor`, unless an external consumer requires keeping it.

```ts
export type SetTrackColorPlan = {
  trackUpdates: Array<{
    trackId: TrackId
    from: string | undefined
    to: string | undefined
  }>
  clipUpdates: Array<{
    clipId: string
    trackId: TrackId
    from: string
    to: string
  }>
}
```

Planner behavior:

- Missing target track returns `null`.
- Non-group target updates only that track when color changes.
- Group target updates the group and all descendants.
- Setting a group color updates descendant clips to that color.
- Clearing a group color clears group and descendant track colors only.
- Nested group descendants are included.

Sketch:

```ts
export const planSetTrackColor = (
  tracks: readonly Track[],
  trackId: TrackId,
  color: string | undefined,
): SetTrackColorPlan | null => {
  const track = tracks.find((candidate) => candidate.id === trackId)
  if (!track) return null

  const targetTrackIds = track.channelRole === 'group'
    ? new Set([track.id, ...collectTrackDescendantIds(tracks, track.id)])
    : new Set([track.id])

  return {
    trackUpdates: tracks
      .filter((candidate) => targetTrackIds.has(candidate.id))
      .filter((candidate) => candidate.color !== color)
      .map((candidate) => ({
        trackId: candidate.id,
        from: candidate.color,
        to: color,
      })),
    clipUpdates: color
      ? tracks
          .filter((candidate) => targetTrackIds.has(candidate.id))
          .flatMap((candidate) =>
            candidate.clips
              .filter((clip) => clip.color !== color)
              .map((clip) => ({
                clipId: clip.id,
                trackId: candidate.id,
                from: clip.color,
                to: color,
              })),
          )
      : [],
  }
}
```

Route `setTrackColor` through this plan:

- track persistence through `persistTrackPatch(projectId, trackId, { color })`
- local clip persistence through `createLocalTimelineRepository(projectId).updateClip`
- shared clip persistence through `clips.setColor`
- optimistic local track updates through `applyTrackPatch`
- optimistic local clip updates through `replaceLocalClip`

History rules:

- If exactly one track update and no clip updates, push `buildTrackColorHistoryEntry`.
- If multiple track or clip updates, push one `section-edit`.
- Group recolor must include the group track itself in history.

Remove dead wiring:

- `assignGroupColorToContents`
- `onAssignGroupColorToContents`
- `planAssignGroupColor` if no call sites remain.

## Phase 8: Bulk Collapse Persistence

### Files

- `src/hooks/useTimelineActions.ts`
- `src/components/Timeline.tsx`
- `src/components/timeline/timeline-workspace.tsx`
- `src/components/timeline/TrackSidebar.tsx`

### Plan

Add action:

```ts
setTracksCollapsed: (
  updates: Array<{ trackId: Track['id']; collapsed: boolean }>
) => Promise<void>
```

Implementation:

```ts
async function setTracksCollapsed(
  updates: Array<{ trackId: Track['id']; collapsed: boolean }>,
): Promise<void> {
  const projectId = options.room.projectId()
  if (!projectId || updates.length === 0) return

  const trackById = new Map(options.tracks().map((track) => [track.id, track]))
  const changed = updates.filter((update) => {
    const track = trackById.get(update.trackId)
    return track && track.collapsed !== update.collapsed
  })
  if (changed.length === 0) return

  await runWithConcurrency(changed, 8, async (update) => {
    await persistTrackPatch(projectId, update.trackId, { collapsed: update.collapsed })
  })

  for (const update of changed) {
    const track = trackById.get(update.trackId)
    if (!track) continue
    applyTrackPatch(track, { collapsed: update.collapsed })
  }
}
```

Do not push undo history for collapse.

## Phase 9: Cleanup

Remove dead code and props after color cascade becomes automatic:

- `assignGroupColorToContents` from `UseTimelineActionsReturn`.
- `onAssignGroupColorToContents` from sidebar and workspace props.
- context menu item for manual color assignment.
- imports and tests for `planAssignGroupColor`, unless intentionally retained.

Run `bun run knip` to verify no dead exports remain.

## Stop Conditions

Stop and reassess if:

- `placementTracks()` cannot be safely mapped from visible layout rows by `trackId`.
- Clip-drag placement requires broad rewrite beyond visible target resolution.
- Shared `clips.setColor` cannot persist all planned clip updates.
- `knip` reports externally consumed exports that would break by removing `planAssignGroupColor`.

## Validation Plan

Targeted checks during implementation:

```sh
bun test src/lib/timeline-track-layout.test.ts src/lib/track-group-ops.test.ts
```

Final checks:

```sh
bun run typecheck
bun test
bun run knip
git diff --check
bun run build
```

Manual checks:

- Collapse and expand a normal track, verify the row becomes slim and clips render as overview segments.
- Collapse and expand a group, verify descendants hide and show correctly.
- Collapse a track with visible automation, verify automation is hidden while collapsed and restored after expansion.
- Cmd-click or Alt-click collapse control, verify all tracks, including hidden descendants, receive the same target state.
- Recolor a normal track, verify only that track changes and undo returns it.
- Recolor a group, verify group, descendants, and descendant clips change with one undo step.
- Clear a group color, verify group and descendant track colors clear while clips keep their previous color.
- Drag clips and browser devices across mixed collapsed and expanded rows, verify targets match the visible row under the pointer.

## Expected Proof Artifacts

- Passing targeted tests for layout and color planning.
- Passing full `typecheck`, `test`, `knip`, `git diff --check`, and `build`.
- Final diff shows no schema migration and no new shared operation kind.
