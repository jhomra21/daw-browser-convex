# Tracks Refactor Tracker

## Goal

Implement Ableton-style track grouping and collapse UX for the timeline while preserving the existing flat track model, local-first repository flow, Convex sync, routing validation, and undo architecture.

## References

- Ableton Arrangement View manual: <https://www.ableton.com/en/manual/arrangement-view/>
- Ableton Mixing manual: <https://www.ableton.com/en/manual/mixing/>
- Local Ableton reference images: `/private/tmp/ableton-ui-reference/track-grouping`
  - `ableton-live12-folded-group-track-arrangement.png`
  - `ableton-live12-arrangement-view-layout.png`
  - `ableton-live12-arrangement-mixer-track-controls.png`
  - `ableton-live12-arrangement-view-track-controls.png`
  - `ableton-live12-adjusting-track-height.png`
  - `ableton-live12-track-headers-circled.png`
  - `ableton-live12-group-track-session.png`
  - `patches-arrangement-layout-reference.jpg`
  - `ableton-live-12-track-groups.png`

## Ableton Behavior to Model

- Group tracks are summing containers and cannot hold clips.
- Grouped child tracks usually route to the group automatically unless they already have custom routing.
- Folded groups hide children and show a compact overview of child clips.
- Group rows visually hug children with a colored rail or strip.
- Nested grouping is supported, but nested group routing can be deferred.
- Track color propagation to children and clips should be explicit, not automatic on every edit.

## Current App State

Already present:

- `TrackChannelRole = 'track' | 'group' | 'return'`.
- Group tracks can be created.
- `outputTargetId` routing to group tracks is supported.
- `normalizeTrackRouting` validates group and return routing.
- `TrackSidebar.tsx` already has group-track awareness.
- `timeline-track-layout.ts` computes flat timeline rows.

Missing:

- No `groupId` parent pointer.
- No persisted `collapsed` state.
- No track color field.
- No tree-aware row filtering.
- No sidebar indentation, disclosure controls, group rail, or hugging UI.
- No folded group clip overview.
- No group and ungroup operations.
- No drag-to-reparent flow.

## Guiding Decisions

1. Use `groupId` parent pointers instead of `children[]`.
2. Keep tree derivation and layout in `src/lib/timeline-track-layout.ts`.
3. Add a focused `src/lib/track-group-ops.ts` for pure group, ungroup, and move planning.
4. Defer drag-to-reparent to v2.
5. Defer nested group audio routing to v2. Visual nesting can exist first.
6. Treat collapse as persisted visual state, but do not add it to undo history.
7. Keep group tracks clip-incompatible, matching Ableton.

## Phase 1: Data Model

Add structural and visual fields to `Track`.

```ts
export type Track<TBuffer = never> = {
  id: TrackId
  historyRef?: string
  name: string
  volume: number
  clips: Clip<TBuffer>[]
  muted?: boolean
  soloed?: boolean
  lockedBy?: string | null
  lockedAt?: number | null
  kind?: 'audio' | 'instrument'
  channelRole?: TrackChannelRole
  groupId?: TrackId
  collapsed?: boolean
  color?: string
  outputTargetId?: TrackId
  sends?: TrackSend[]
}
```

Update:

- `packages/timeline-core/src/types.ts`
- `src/lib/timeline-repository/types.ts`
- `src/lib/timeline-repository/track-row-builder.ts`
- `src/lib/timeline-repository/track-row-adapter.ts`
- `src/lib/tracks.ts`
- `src/hooks/useTimelineActions.ts`
- `convex/schema.ts`
- `convex/tracks.ts`
- `packages/shared/src/shared-timeline-operations.ts`

Convex schema target:

```ts
tracks: defineTable({
  projectId: v.string(),
  index: v.number(),
  kind: v.optional(v.string()),
  groupId: v.optional(v.id("tracks")),
  collapsed: v.optional(v.boolean()),
  color: v.optional(v.string()),
})
  .index("by_room", ["projectId"])
  .index("by_room_index", ["projectId", "index"])
```

`groupId`, `collapsed`, and `color` belong on `tracks`, not `mixerChannels`, because they are structural and visual state rather than mixer channel state.

## Phase 2: Tree and Layout Helpers

Extend `src/lib/timeline-track-layout.ts`.

```ts
export type TrackTreeNode = {
  trackId: TrackId
  children: TrackTreeNode[]
}

export function buildTrackTree(
  tracks: readonly Pick<Track, 'id' | 'groupId' | 'channelRole'>[],
): TrackTreeNode[] {
  const childrenByParent = new Map<string, TrackTreeNode[]>()
  const nodes = new Map<string, TrackTreeNode>()

  for (const track of tracks) {
    nodes.set(track.id, { trackId: track.id, children: [] })
  }

  for (const track of tracks) {
    const node = nodes.get(track.id)
    if (!node || !track.groupId || !nodes.has(track.groupId)) continue
    const siblings = childrenByParent.get(track.groupId) ?? []
    siblings.push(node)
    childrenByParent.set(track.groupId, siblings)
  }

  for (const [parentId, children] of childrenByParent) {
    const parent = nodes.get(parentId)
    if (parent) parent.children = children
  }

  return tracks
    .filter((track) => !track.groupId || !nodes.has(track.groupId))
    .flatMap((track) => {
      const node = nodes.get(track.id)
      return node ? [node] : []
    })
}

export function flattenVisibleTracks(
  tree: readonly TrackTreeNode[],
  collapsedById: ReadonlyMap<string, boolean> | Record<string, boolean | undefined>,
): string[] {
  const result: string[] = []
  const isCollapsed = (trackId: string) => (
    collapsedById instanceof Map ? collapsedById.get(trackId) === true : collapsedById[trackId] === true
  )
  const walk = (nodes: readonly TrackTreeNode[]) => {
    for (const node of nodes) {
      result.push(node.trackId)
      if (!isCollapsed(node.trackId)) walk(node.children)
    }
  }
  walk(tree)
  return result
}

export function computeDepthMap(tree: readonly TrackTreeNode[]): Map<string, number> {
  const depths = new Map<string, number>()
  const walk = (nodes: readonly TrackTreeNode[], depth: number) => {
    for (const node of nodes) {
      depths.set(node.trackId, depth)
      walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  return depths
}

export function wouldCreateCycle(
  tracks: readonly Pick<Track, 'id' | 'groupId'>[],
  trackId: string,
  proposedGroupId: string,
): boolean {
  const parentOf = new Map<string, string>()
  for (const track of tracks) {
    if (track.groupId) parentOf.set(track.id, track.groupId)
  }

  let current: string | undefined = proposedGroupId
  while (current) {
    if (current === trackId) return true
    current = parentOf.get(current)
  }
  return false
}
```

Update layout rows:

```ts
export type TimelineTrackLayoutRow = {
  trackId: Track['id']
  topPx: number
  heightPx: number
  clipLaneHeightPx: number
  automationHeightPx: number
  depth: number
  groupId?: Track['id']
}
```

`buildTimelineTrackLayoutRows` should receive visible IDs plus lookup maps, then produce rows only for visible tracks. Existing helpers like `trackIndexAtY` and `trackIdsInYRange` should continue to operate on visible rows.

## Phase 3: Group Operation Planning

Add `src/lib/track-group-ops.ts`.

Responsibilities:

- Plan grouping selected tracks.
- Plan ungrouping a group.
- Plan moving one track into or out of a group.
- Validate cycles.
- Keep routing decisions explicit and testable.

```ts
export type PlannedTrackGroupChildUpdate = {
  trackId: TrackId
  groupId: TrackId
  outputTargetId?: TrackId
}

export type GroupTracksPlan = {
  groupTrack: {
    name: string
    channelRole: TrackChannelRole
    index: number
    color?: string
  }
  childUpdates: PlannedTrackGroupChildUpdate[]
}
```

Rules:

- Group inserts at the first selected track index.
- Selected tracks become children of the new group.
- Child `outputTargetId` routes to the new group only when no custom routing exists.
- Ungroup resets `groupId`.
- If a child was routed to the removed group, reset output to Master.
- Reject moves that create cycles.
- Reject grouping return tracks unless a product decision says otherwise.

## Phase 4: Sidebar UI

Update `TrackSidebar.tsx` to render from layout rows instead of raw flat tracks.

New sidebar inputs:

```ts
trackLayout: TimelineTrackLayoutRow[]
trackById: ReadonlyMap<string, Track>
onToggleCollapsed: (trackId: Track['id']) => void
onGroupTracks: (trackIds: Track['id'][]) => void
onUngroupTracks: (groupId: Track['id']) => void
onMoveTrackToGroup: (trackId: Track['id'], groupId: Track['id'] | undefined) => void
```

Add constants in `src/lib/timeline-utils.ts`:

```ts
export const GROUP_INDENT_PX = 16
export const GROUP_RAIL_WIDTH = 4
```

Sidebar behavior:

- Render `<For each={trackLayout}>`.
- Resolve each track with `trackById`.
- Indent row content by `row.depth * GROUP_INDENT_PX`.
- Show a disclosure button for `channelRole === 'group'`.
- Show a colored rail for grouped children.
- Show a colored top strip for group header rows.
- Preserve current meters, routing controls, automation buttons, lock behavior, and volume controls.

Context menu additions:

- Group selected tracks.
- Remove from group.
- Ungroup tracks for group rows.
- Later: move to group submenu.

## Phase 5: Workspace Rendering

Update `timeline-workspace.tsx` to avoid array-index coupling between `props.tracks` and `props.trackLayout`.

Target pattern:

```tsx
<For each={props.trackLayout}>
  {(row) => {
    const track = () => props.trackById.get(row.trackId)
    return (
      <Show when={track()}>
        {(visibleTrack) => (
          <TrackLane
            track={visibleTrack()}
            topPx={row.topPx}
            automationHeightPx={row.automationHeightPx}
          />
        )}
      </Show>
    )
  }}
</For>
```

Selection, marquee, range selection, drag placement, and row hit-testing should consume visible rows only.

## Phase 6: Collapsed Group Clip Overview

When a group is collapsed, `TrackLane` should render a read-only overview of descendant clips instead of normal clip contents.

```ts
export function buildGroupClipOverview(
  groupId: TrackId,
  tracks: readonly Track[],
): Array<{ startSec: number; endSec: number }> {
  const children = tracks.filter((track) => track.groupId === groupId)
  const segments = children.flatMap((track) => (
    track.clips.map((clip) => ({
      startSec: clip.startSec,
      endSec: clip.startSec + clip.duration,
    }))
  ))

  segments.sort((left, right) => left.startSec - right.startSec)

  const merged: Array<{ startSec: number; endSec: number }> = []
  for (const segment of segments) {
    const last = merged[merged.length - 1]
    if (last && segment.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, segment.endSec)
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}
```

The overview is visual only in v1. Direct editing in folded overview can be added later.

## Phase 7: Actions and Persistence

Wire actions through `useTimelineActions.ts` or the existing track action boundary.

Handlers:

- `groupSelectedTracks`
- `ungroupTrack`
- `toggleTrackCollapsed`
- `moveTrackToGroup`
- `setTrackColor`

Persistence paths:

- Local repository: `createTrack`, `updateTrack`.
- Cloud operations: add shared timeline operations for group, collapse, and color.
- Convex mutations: validate `groupId` references a group track in the same project and does not create cycles.

Shared operation additions:

```ts
| { kind: 'tracks.setGroup'; payload: { trackId: string; groupId?: string } }
| { kind: 'tracks.setCollapsed'; payload: { trackId: string; collapsed: boolean } }
| { kind: 'tracks.setColor'; payload: { trackId: string; color?: string } }
```

## Phase 8: Undo and History

Add undo entries for structural edits:

```ts
| {
    type: 'track-group'
    projectId: string
    data: {
      groupTrackRef: TrackRef
      childUpdates: Array<{
        trackRef: TrackRef
        previousGroupRef?: TrackRef
        previousOutputTargetRef?: TrackRef
      }>
    }
  }
| {
    type: 'track-ungroup'
    projectId: string
    data: {
      groupTrackRef: TrackRef
      childSnapshots: Array<{
        trackRef: TrackRef
        previousGroupRef: TrackRef
        previousOutputTargetRef?: TrackRef
      }>
    }
  }
| {
    type: 'track-color'
    projectId: string
    data: { trackRef: TrackRef; from: string | undefined; to: string | undefined }
  }
```

Do not add undo for collapse and expand.

Track delete snapshots must preserve:

- `groupId`
- `collapsed`
- `color`
- existing routing snapshots
- clips, effects, and automation

Deleting a group should delete descendants as part of the group contents. This should be explicit in delete planning and history snapshot logic.

## Phase 9: Master Collapse

Master is not a normal track and is rendered separately by `MasterSidebarRow`.

Plan:

- Add `masterCollapsed` to local UI state or preferences.
- Add `onToggleCollapsed` to `MasterSidebarModel`.
- When collapsed, keep a compact master row visible.
- Hide master automation lane and detailed master controls while collapsed.
- Do not add master collapse to undo.

## Deferred v2 Work

V2 should build on the v1 grouping foundation without replacing it. The important v1 boundaries are:

- `groupId`, `collapsed`, and `color` already live on `Track`.
- Tree derivation and visible-row layout live in `src/lib/timeline-track-layout.ts`.
- Group operations live in `src/lib/track-group-ops.ts`.
- Sidebar and lane rendering already consume visible layout rows.
- Collapse is persisted but not undoable.
- Structural changes and color changes are undoable.

### V2.1 Drag-to-Reparent with Above, Below, and Inside Zones

Goal: let users drag track headers to reorder tracks and move tracks/groups into or out of groups using explicit drop zones.

Ableton behavior to approximate:

- Dropping above or below another track reorders.
- Dropping into a group nests the dragged track/group under that group.
- Dragging a child out of a group removes `groupId`.
- Dropping a group into one of its descendants is invalid.

Core model:

```ts
export type TrackDropZone = 'above' | 'below' | 'inside'

export type TrackReparentDropTarget = {
  trackId: TrackId
  zone: TrackDropZone
}

export type TrackReparentPlan = {
  movedTrackIds: TrackId[]
  parentGroupId?: TrackId
  insertIndex: number
  trackUpdates: Array<{
    trackId: TrackId
    groupId?: TrackId
    index: number
    outputTargetId?: TrackId
  }>
}
```

Drop-zone helper in `src/lib/track-group-ops.ts`:

```ts
export function resolveTrackDropZone(input: {
  pointerY: number
  rowTopPx: number
  rowHeightPx: number
  targetIsGroup: boolean
}): TrackDropZone {
  const localY = input.pointerY - input.rowTopPx
  const edgeSize = Math.min(10, input.rowHeightPx / 3)
  if (localY <= edgeSize) return 'above'
  if (localY >= input.rowHeightPx - edgeSize) return 'below'
  return input.targetIsGroup ? 'inside' : 'below'
}
```

Planning helper:

```ts
export function planTrackReparentDrop(input: {
  tracks: readonly Track[]
  draggedTrackIds: readonly TrackId[]
  target: TrackReparentDropTarget
}): TrackReparentPlan | null {
  const dragged = new Set(input.draggedTrackIds)
  const targetTrack = input.tracks.find((track) => track.id === input.target.trackId)
  if (!targetTrack || dragged.has(targetTrack.id)) return null

  const draggedWithDescendants = new Set<TrackId>()
  for (const trackId of dragged) {
    draggedWithDescendants.add(trackId)
    for (const childId of collectTrackDescendantIds(input.tracks, trackId)) {
      draggedWithDescendants.add(childId)
    }
  }
  if (draggedWithDescendants.has(targetTrack.id)) return null

  const parentGroupId = input.target.zone === 'inside'
    ? targetTrack.id
    : targetTrack.groupId
  if (parentGroupId) {
    for (const trackId of dragged) {
      if (wouldCreateCycle(input.tracks, trackId, parentGroupId)) return null
    }
  }

  // Compute final flat order by removing dragged subtree blocks, then inserting them
  // before/after/inside the target block. Return contiguous indexes for persistence.
  return buildTrackOrderPatch({ tracks: input.tracks, dragged, target: input.target, parentGroupId })
}
```

UI phases:

1. Add `useTrackHeaderDrag` or sidebar-local pointer handling in `TrackSidebar.tsx`.
2. Track active drag state:
   ```ts
   type ActiveTrackDrag = {
     pointerId: number
     draggedTrackIds: TrackId[]
     target: TrackReparentDropTarget | null
   }
   ```
3. Compute target row from `trackLayout` and `trackIndexAtY`.
4. Render a `TrackDropIndicator` overlay:
   - horizontal line above/below rows
   - inset highlight for `inside`
   - invalid drop style for cycles or return-track parent targets
5. On pointer up, call `planTrackReparentDrop`, persist track patches, update local projection, and push undo history.

Validation:

- `planTrackReparentDrop` rejects cycles.
- Dragging a group moves its whole subtree as a contiguous block.
- Dropping inside a non-group falls back to below or is invalid.
- Dropping above/below a child preserves the target child’s parent group.
- Dropping above/below a root track removes parent group.

### V2.2 Nested Group Audio Routing

Goal: allow an inner group’s summed output to route to an outer group when the inner group is visually nested.

Current v1 limitation:

- `normalizeTrackRouting` blocks `outputTargetId` for `sourceRole === 'group'`.
- This keeps groups outputting to Master by default.

V2 routing rule:

- Normal tracks may route to group tracks.
- Group tracks may route to ancestor group tracks only.
- Group tracks must not route to themselves, descendants, siblings, returns, or normal tracks.
- Return tracks keep current behavior.

Shared routing update in `packages/shared/src/track-routing-core.ts`:

```ts
type RoutingTrackLike<TTrackId extends string = string> = {
  id: TTrackId
  channelRole?: string
  kind?: string
  groupId?: TTrackId
}

function isAncestorGroup<TTrackId extends string>(
  tracksById: ReadonlyMap<string, Pick<RoutingTrackLike<TTrackId>, 'id' | 'groupId' | 'channelRole'>>,
  sourceId: string,
  targetId: string,
) {
  let parentId = tracksById.get(sourceId)?.groupId
  while (parentId) {
    if (String(parentId) === targetId) return normalizeTrackChannelRole(tracksById.get(String(parentId))?.channelRole) === 'group'
    parentId = tracksById.get(String(parentId))?.groupId
  }
  return false
}
```

`normalizeTrackRouting` should permit:

```ts
const canUseOutputTarget = sourceRole === 'track'
  ? groupIds.has(targetId)
  : sourceRole === 'group'
    ? isAncestorGroup(tracksById, sourceId, targetId)
    : false
```

Persistence phases:

1. Add `groupId` to every routing normalization call site that passes track lists.
2. Update Convex `sanitizeTrackRouting` inputs to include `groupId`.
3. Update local repository routing normalization to include `groupId`.
4. Update audio engine mixer graph routing tests for nested group sums.

Tests:

- Inner group can route to its outer group.
- Inner group cannot route to child/descendant group.
- Inner group cannot route to sibling group.
- Normal track routing remains unchanged.
- Removing a group resets invalid nested group output targets.

### V2.3 Direct Editing of Clips from Folded Group Overview

Goal: make folded group overview segments editable enough to support common arrangement actions without unfolding.

V1 state:

- `buildGroupClipOverview` merges child clip ranges into read-only overview segments.
- `TrackLane` renders these segments without interaction.

V2 design:

- Keep overview segments read-only by default until the pointer hits a specific descendant clip.
- Use a richer overview model that preserves source clip IDs where segments do not overlap.
- If multiple descendant clips overlap into one segment, select the group range rather than a single clip.

Model:

```ts
export type GroupClipOverviewSegment = {
  startSec: number
  endSec: number
  clipRefs: Array<{
    trackId: TrackId
    clipId: string
  }>
}
```

Helper:

```ts
export function buildEditableGroupClipOverview(
  groupId: TrackId,
  tracks: readonly Track[],
): GroupClipOverviewSegment[] {
  const descendantIds = collectTrackDescendantIds(tracks, groupId)
  const segments = tracks
    .filter((track) => descendantIds.has(track.id))
    .flatMap((track) => track.clips.map((clip) => ({
      startSec: clip.startSec,
      endSec: clip.startSec + clip.duration,
      clipRefs: [{ trackId: track.id, clipId: clip.id }],
    })))

  // Merge overlaps, concatenating clipRefs.
  return mergeGroupOverviewSegments(segments)
}
```

Interaction phases:

1. Render `GroupOverviewClipComponent` instead of plain rectangles.
2. Pointer down on a segment:
   - one `clipRef`: select that real clip and allow drag/resize through existing clip handlers.
   - multiple `clipRefs`: select a time range across descendant tracks.
3. Double click:
   - one MIDI clip: open MIDI editor.
   - one audio clip: open sample detail.
   - multiple clips: unfold group and select range.
4. Context menu:
   - “Select contained clips”
   - “Unfold group”
   - “Delete contained clips in segment”

Risk controls:

- Do not create synthetic clips.
- Always commit edits against real descendant clip IDs.
- When dragging an overview segment with multiple clips, use section/range edit operations, not individual clip drag.

Tests:

- Non-overlapping descendant clips keep separate segment refs.
- Overlapping descendant clips merge and preserve all refs.
- Single-segment drag delegates to existing clip move path.
- Multi-segment range delete affects only descendant tracks in the group.

### V2.4 Explicit “Assign Group Color to Children and Clips” Command

Goal: match Ableton’s explicit color propagation behavior without making color edits surprising.

Product behavior:

- Changing a group color changes only the group.
- A context menu command applies group color to:
  - direct children only, or
  - all descendants, depending on menu choice.
- A second option applies color to clips too.

Operation model:

```ts
export type AssignGroupColorScope = 'direct-children' | 'all-descendants'

export type AssignGroupColorPlan = {
  trackUpdates: Array<{ trackId: TrackId; from?: string; to: string }>
  clipUpdates: Array<{ clipId: string; trackId: TrackId; from?: string; to: string }>
}
```

Planner:

```ts
export function planAssignGroupColor(input: {
  tracks: readonly Track[]
  groupId: TrackId
  scope: AssignGroupColorScope
  includeClips: boolean
}): AssignGroupColorPlan | null {
  const group = input.tracks.find((track) => track.id === input.groupId)
  if (!group?.color) return null
  const childIds = input.scope === 'direct-children'
    ? new Set(input.tracks.filter((track) => track.groupId === group.id).map((track) => track.id))
    : collectTrackDescendantIds(input.tracks, group.id)

  const targetTracks = input.tracks.filter((track) => childIds.has(track.id))
  return {
    trackUpdates: targetTracks.map((track) => ({ trackId: track.id, from: track.color, to: group.color })),
    clipUpdates: input.includeClips
      ? targetTracks.flatMap((track) => track.clips.map((clip) => ({ clipId: clip.id, trackId: track.id, from: clip.color, to: group.color })))
      : [],
  }
}
```

Persistence phases:

1. Reuse `tracks.setColor` for track colors.
2. Add clip color support if clip color is not currently persisted through shared/local operations.
3. Add a batch shared operation if per-clip writes become too chatty.
4. Add undo entry that stores all previous track and clip colors.

UI:

- Group context menu:
  - “Assign color to direct child tracks”
  - “Assign color to all descendant tracks”
  - “Assign color to child tracks and clips”
  - “Assign color to descendant tracks and clips”

Tests:

- Command is disabled when group has no color.
- Direct-child scope excludes nested descendants.
- Descendant scope includes nested children.
- Undo restores previous track and clip colors.

### V2.5 Reorder-Aware Group Dragging and Drop Indicators

Goal: make drag-to-reparent predictable for nested groups, collapsed groups, and multi-selection.

Rules:

- A group drag includes its visible or hidden descendants.
- Dragging selected tracks preserves their relative order.
- If selection includes both a parent group and its child, collapse the move set to the parent group only.
- Collapsed group drops treat the group as a single block.
- Expanded group drops can target children or the group’s inside zone.

Move-set helper:

```ts
export function normalizeDraggedTrackIds(input: {
  tracks: readonly Track[]
  selectedTrackIds: readonly TrackId[]
  primaryTrackId: TrackId
}): TrackId[] {
  const selected = input.selectedTrackIds.length > 0
    ? new Set(input.selectedTrackIds)
    : new Set([input.primaryTrackId])

  return input.tracks.filter((track) => {
    if (!selected.has(track.id)) return false
    let parentId = track.groupId
    while (parentId) {
      if (selected.has(parentId)) return false
      parentId = input.tracks.find((candidate) => candidate.id === parentId)?.groupId
    }
    return true
  }).map((track) => track.id)
}
```

Indicator model:

```ts
export type TrackDropIndicator = {
  kind: 'line' | 'inside' | 'invalid'
  topPx: number
  leftIndentPx: number
  widthPx: number
  label?: string
}
```

Rendering:

- Use `trackLayout` for row top/height/depth.
- For `above`/`below`, render a horizontal line at the row edge, indented to the target parent depth.
- For `inside`, render an inset rounded rectangle inside the group row.
- For invalid drops, render the same target in red with reason text.

Persistence:

- Add `tracks.reorderAndGroup` shared operation if individual `setGroup`/index patches cause inconsistent collaborative intermediate states.
- Convex mutation should accept a complete ordered patch:
  ```ts
  {
    projectId: string
    updates: Array<{ trackId: Id<'tracks'>; index: number; groupId?: Id<'tracks'> | null }>
  }
  ```
- Local repository should mirror the same atomic operation or queue patches under one local write transaction.

Tests:

- Dragging parent group excludes selected children from duplicate moves.
- Reordering a collapsed group preserves hidden descendant order.
- Dropping below the last child of a group keeps or removes parent based on indicator depth.
- Multi-track drag preserves relative order and contiguous indexes.
- Collaborative mutation rejects partial/cross-project patches.

### V2 Suggested Implementation Order

1. Add pure drop-zone and reorder planning helpers in `track-group-ops.ts`.
2. Add tests for move-set normalization, drop-zone resolution, cycle rejection, and reorder patches.
3. Add sidebar track drag state and non-persistent visual indicators.
4. Wire reorder/reparent persistence and undo for local projects.
5. Add shared `tracks.reorderAndGroup` operation and Convex mutation for cloud projects.
6. Enable nested group routing in shared routing normalization and audio graph tests.
7. Replace read-only overview segments with editable overview refs.
8. Add explicit group color propagation commands and undo.
9. Run full validators and simplify pass.

### V2 Validation

Run before merging V2:

```bash
bun test
bun run typecheck
bun run knip
bun run build
git diff --check
```

Manual validation checklist:

- Drag a track above, below, and inside a group.
- Drag an expanded group and verify descendants move with it.
- Drag a collapsed group and verify hidden descendants remain attached.
- Try to drag a group into its child and confirm invalid indicator.
- Route inner group to outer group and verify audio still reaches Master.
- Edit a single folded overview clip and confirm the real child clip updates.
- Use group color propagation and undo it.
- Verify collaboration sees reorder/reparent as one coherent update.

## Tests

Add tests for:

- `buildTrackTree` preserves flat order.
- `flattenVisibleTracks` hides descendants of collapsed groups.
- `computeDepthMap` handles nested groups.
- `wouldCreateCycle` rejects invalid parent assignments.
- `buildTimelineTrackLayoutRows` emits only visible rows.
- `trackIndexAtY` and `trackIdsInYRange` work with hidden descendants.
- `planGroupTracks` chooses first selected index and preserves custom routing.
- `planUngroupTracks` resets output only when output targets the group.
- Convex group mutations reject cross-project groups, non-group parents, and cycles.
- Track delete snapshots preserve group metadata and descendants.

## Validation

Run before merge:

```bash
bun test
bun run typecheck
bun run knip
bun run build
git diff --check
```

## Implementation Order

1. Add data model fields across core types, local repository, shared operations, and Convex schema.
2. Add tree and visible-layout helpers in `timeline-track-layout.ts`.
3. Add `track-group-ops.ts` with pure planning functions and tests.
4. Switch workspace and sidebar rendering to visible layout rows and track lookup maps.
5. Add disclosure controls, indentation, colored rails, and group header strips.
6. Wire group, ungroup, move, collapse, and color actions.
7. Add undo support for group, ungroup, color, delete snapshots, and descendant deletion.
8. Add collapsed group clip overview rendering.
9. Add Master collapse state and UI.
10. Run full validators and simplify dead or duplicate code before review.

## Progress

- [x] Research Ableton grouping behavior.
- [x] Collect reference images.
- [x] Inspect current timeline, routing, sidebar, repository, Convex, and undo architecture.
- [x] Synthesize combined implementation plan.
- [x] Implement data model fields.
- [x] Implement tree-aware layout.
- [x] Implement pure group operations.
- [x] Implement sidebar and workspace UI.
- [x] Implement collapsed overview.
- [x] Implement action, persistence, and undo wiring.
- [x] Implement Master collapse.
- [x] Run validators.
