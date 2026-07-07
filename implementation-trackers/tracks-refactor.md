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
- Tree derivation, visible-row layout, descendant collection, and group overview generation live in `src/lib/timeline-track-layout.ts`.
- Group operations live in `src/lib/track-group-ops.ts`.
- Sidebar and lane rendering already consume visible layout rows.
- Collapse is persisted but not undoable.
- Structural group changes and track color changes are undoable.
- Basic track header drag reorder does not exist yet. V2.1 must introduce reorder as the base case, then layer group-aware reparenting on top.

Opus review conclusion: the original V2.1 and V2.5 describe one interaction and should be implemented together. Folded overview editing should be intentionally minimal, color propagation should match Ableton's single command, and nested routing can be implemented first because it has no UI dependency.

### V2.0 Keyboard Shortcut Backfill

Goal: match Ableton's grouping shortcut while keeping existing context menu actions.

Behavior:

- `Cmd+G` on macOS and `Ctrl+G` elsewhere groups the selected tracks when at least two reorderable tracks are selected.
- `Shift+Cmd+G` on macOS and `Shift+Ctrl+G` elsewhere ungroups the selected group or selected children when the existing ungroup action is available.
- Shortcuts should use the existing `groupTracks` and `ungroupTracks` actions so history, persistence, and validation stay centralized.
- Shortcuts must be ignored while text inputs, menus, dialogs, or editable controls are focused.

Tests:

- Shortcut invokes the same action path as the context menu.
- Shortcut is disabled for invalid selections.
- Shortcut does not fire while typing in editable UI.

### V2.1 Track Drag Reorder and Reparent

Goal: let users drag track sidebar headers to reorder tracks and move tracks or groups into and out of groups. This is one unified drag system, not separate reorder and reparent features.

Ableton behavior to approximate:

- Dragging a track above or below another track reorders it.
- Dragging into a group header nests the track under that group.
- Dragging a child out of a group's visual region clears its `groupId`.
- Dragging a group moves its entire subtree as a contiguous block.
- Dragging a group into one of its own descendants is rejected.
- Dropping into a collapsed group auto-expands it so the result is visible.
- Multi-selection preserves relative order.
- If selection includes a parent group and its child, the move set collapses to the parent group only.

Types in `src/lib/track-group-ops.ts`:

```ts
export type TrackDropZone = 'above' | 'below' | 'inside'

export type TrackDropTarget = {
  trackId: TrackId
  zone: TrackDropZone
}

export type TrackReorderPatch = {
  trackId: TrackId
  index: number
  groupId: TrackId | undefined
  outputTargetId: TrackId | undefined
}

export type TrackReorderPlan = {
  patches: TrackReorderPatch[]
  expandGroupIds: TrackId[]
}
```

Drop-zone resolution:

```ts
export function resolveTrackDropZone(input: {
  localY: number
  rowHeightPx: number
  targetIsGroup: boolean
}): TrackDropZone {
  const edgeBand = Math.min(12, input.rowHeightPx * 0.25)
  if (input.localY <= edgeBand) return 'above'
  if (input.localY >= input.rowHeightPx - edgeBand) return 'below'
  return input.targetIsGroup
    ? 'inside'
    : input.localY < input.rowHeightPx / 2
      ? 'above'
      : 'below'
}
```

Move-set normalization should avoid repeated linear parent lookups:

```ts
export function normalizeDragMoveSet(
  tracks: readonly Pick<Track, 'id' | 'groupId'>[],
  selectedIds: ReadonlySet<TrackId>,
): TrackId[] {
  const parentOf = new Map<TrackId, TrackId>()
  for (const track of tracks) {
    if (track.groupId) parentOf.set(track.id, track.groupId)
  }

  return tracks
    .filter((track) => selectedIds.has(track.id))
    .filter((track) => {
      let cursor = parentOf.get(track.id)
      while (cursor) {
        if (selectedIds.has(cursor)) return false
        cursor = parentOf.get(cursor)
      }
      return true
    })
    .map((track) => track.id)
}
```

Reorder planner, the core algorithm that replaces the undefined `buildTrackOrderPatch` placeholder:

```ts
export function planTrackReorder(input: {
  tracks: readonly Pick<Track, 'id' | 'index' | 'groupId' | 'channelRole' | 'outputTargetId' | 'collapsed'>[]
  moveRootIds: readonly TrackId[]
  target: TrackDropTarget
}): TrackReorderPlan | null {
  const { tracks, moveRootIds, target } = input
  const moveRoots = new Set(moveRootIds)
  const trackById = new Map(tracks.map((track) => [track.id, track]))
  const targetTrack = trackById.get(target.trackId)
  if (!targetTrack) return null
  if (target.zone === 'inside' && targetTrack.channelRole !== 'group') return null

  const movedSubtree = new Set<TrackId>()
  for (const rootId of moveRoots) {
    movedSubtree.add(rootId)
    for (const descendantId of collectTrackDescendantIds(tracks, rootId)) {
      movedSubtree.add(descendantId)
    }
  }
  if (movedSubtree.has(target.trackId)) return null

  const newParentGroupId = target.zone === 'inside' ? targetTrack.id : targetTrack.groupId
  if (newParentGroupId) {
    for (const rootId of moveRoots) {
      if (wouldCreateCycle(tracks, rootId, newParentGroupId)) return null
    }
  }

  const displayOrder = [...tracks].sort((a, b) => a.index - b.index).map((track) => track.id)
  const rest = displayOrder.filter((id) => !movedSubtree.has(id))
  const targetIndex = rest.indexOf(target.trackId)
  if (targetIndex === -1) return null

  const insertAt = (() => {
    if (target.zone === 'above') return targetIndex
    if (target.zone === 'inside') return targetIndex + 1
    const targetDescendants = collectTrackDescendantIds(tracks, target.trackId)
    let lastIndex = targetIndex
    for (let index = targetIndex + 1; index < rest.length; index++) {
      if (!targetDescendants.has(rest[index])) break
      lastIndex = index
    }
    return lastIndex + 1
  })()

  const movedInOrder = displayOrder.filter((id) => movedSubtree.has(id))
  const finalOrder = [
    ...rest.slice(0, insertAt),
    ...movedInOrder,
    ...rest.slice(insertAt),
  ]

  const patches: TrackReorderPatch[] = []
  for (let index = 0; index < finalOrder.length; index++) {
    const trackId = finalOrder[index]
    const track = trackById.get(trackId)
    if (!track) continue
    const groupId = moveRoots.has(trackId) ? newParentGroupId : track.groupId
    const outputTargetId = moveRoots.has(trackId) && groupId ? (track.outputTargetId ?? groupId) : track.outputTargetId
    if (track.index !== index || track.groupId !== groupId || track.outputTargetId !== outputTargetId) {
      patches.push({ trackId, index, groupId, outputTargetId })
    }
  }

  const expandGroupIds = target.zone === 'inside' && targetTrack.collapsed ? [targetTrack.id] : []
  return patches.length > 0 || expandGroupIds.length > 0 ? { patches, expandGroupIds } : null
}
```

Implementation notes:

- Use `trackLayout` for hit testing, row top, row height, and depth. Do not map visible row indexes back into the flat track array.
- Keep pointer state component-local in `TrackSidebar.tsx` unless a second consumer appears.
- Pointer flow:
  1. `pointerdown` on the track name button records start position and captures the pointer.
  2. `pointermove` beyond a 4px threshold enters drag mode.
  3. Drag mode computes `TrackDropTarget` from layout rows and `resolveTrackDropZone`.
  4. Sidebar renders an absolute drop indicator.
  5. `pointerup` calls `planTrackReorder`, persists patches, pushes undo, expands any target groups, and clears drag state.
- Drop indicator can be rendered directly from JSX. A separate `TrackDropIndicator` type is unnecessary unless a second consumer needs it.
- For `above` and `below`, render a horizontal line at the row edge indented to the target parent depth.
- For `inside`, render an inset rounded rectangle inside the group row.
- For invalid targets, render the same target in the destructive color and do not persist on drop.

Shared operation and persistence:

```ts
| {
    kind: 'tracks.reorderAndGroup'
    payload: {
      updates: Array<{
        trackId: string
        index: number
        groupId?: string | null
        outputTargetId?: string | null
      }>
    }
  }
```

- Use one atomic shared operation for collaboration rather than a sequence of index and group updates.
- Convex mutation validates all track IDs belong to the same project.
- Convex mutation validates each `groupId` points to a same-project group track or is null.
- Convex mutation validates no cycles in the resulting parent graph.
- Convex mutation validates indexes are contiguous from 0.
- Local repository mirrors the operation as a single transaction.

Undo entry:

```ts
| {
    type: 'track-reorder'
    projectId: string
    data: {
      patches: Array<{
        trackRef: TrackRef
        fromIndex: number
        toIndex: number
        fromGroupRef?: TrackRef
        toGroupRef?: TrackRef
        fromOutputTargetRef?: TrackRef
        toOutputTargetRef?: TrackRef
      }>
    }
  }
```

Tests:

- Drag track above another track and indexes update correctly.
- Drag track below the last track and it moves to the end.
- Drag track inside a group and it gets `groupId` plus auto-route output.
- Drag track out of a group by dropping above a root track and `groupId` clears.
- Drag group and all descendants move as one contiguous block.
- Drag group into its child and planner returns null.
- Multi-select parent plus child collapses to parent only.
- Drop inside collapsed group expands the group.
- Reordering a collapsed group preserves hidden descendant order.
- Basic reorder works in projects with zero groups.
- Convex mutation rejects stale, partial, cross-project, or non-contiguous patches.

### V2.2 Nested Group Audio Routing

Goal: allow an inner group’s summed output to route to an outer group when the inner group is visually nested.

Current v1 limitation:

- `normalizeTrackRouting` blocks `outputTargetId` for `sourceRole === 'group'`.
- This keeps groups outputting to Master by default.

V2 routing rule:

- Normal tracks may route to group tracks.
- Group tracks may route only to ancestor group tracks by walking up the `groupId` chain from the source track's parent.
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
  candidateAncestorId: string,
): boolean {
  let cursor = tracksById.get(sourceId)?.groupId
  while (cursor) {
    if (String(cursor) === candidateAncestorId) {
      return normalizeTrackChannelRole(tracksById.get(String(cursor))?.channelRole) === 'group'
    }
    cursor = tracksById.get(String(cursor))?.groupId
  }
  return false
}
```

`normalizeTrackRouting` should permit:

```ts
const tracksById = new Map(tracks.map((track) => [String(track.id), track]))
const normalizedOutputTargetId = (() => {
  if (!track || !outputTargetId || String(outputTargetId) === sourceId) return undefined
  const targetId = String(outputTargetId)
  if (sourceRole === 'track') return groupIds.has(targetId) ? outputTargetId : undefined
  if (sourceRole === 'group') return isAncestorGroup(tracksById, sourceId, targetId) ? outputTargetId : undefined
  return undefined
})()
```

Audit required call sites because `RoutingTrackLike` now needs `groupId`:

- `packages/shared/src/track-routing-core.ts`
- `packages/timeline-core/src/track-routing.ts`
- Local repository routing normalization.
- Convex `sanitizeTrackRouting` and any tracks-table input projection.
- Audio engine mixer graph construction.

Auto-routing behavior:

- When V2.1 creates a nested group inside an outer group, the inner group's `outputTargetId` should auto-route to the outer group using the same rule as normal tracks.
- When a group is ungrouped or moved outside its parent, invalid nested group routing resets to Master.

Tests:

- Inner group can route to its outer group.
- Inner group cannot route to sibling group.
- Inner group cannot route to descendant group.
- Inner group cannot route to normal track.
- Removing or ungrouping the outer group resets the inner group output to Master.
- Audio engine mixer graph verifies nested group sum reaches Master through the outer group.

### V2.3 Assign Group Color to Grouped Tracks and Clips

Goal: match Ableton’s single “Assign Track Color to Grouped Tracks and Clips” command.

Scope:

- Changing a group color still changes only the group.
- One context menu command applies the group color to all descendant tracks and all clips inside those descendants.
- Do not add separate direct-child, descendants-only, track-only, or clip-only menu variants unless product feedback proves they are needed.

Planner in `src/lib/track-group-ops.ts`:

```ts
export type AssignGroupColorPlan = {
  trackUpdates: Array<{ trackId: TrackId; from: string | undefined; to: string }>
  clipUpdates: Array<{ clipId: string; trackId: TrackId; from: string | undefined; to: string }>
}

export function planAssignGroupColor(
  tracks: readonly Track[],
  groupId: TrackId,
): AssignGroupColorPlan | null {
  const group = tracks.find((track) => track.id === groupId)
  if (!group?.color) return null

  const descendantIds = collectTrackDescendantIds(tracks, groupId)
  const descendants = tracks.filter((track) => descendantIds.has(track.id))

  return {
    trackUpdates: descendants
      .filter((track) => track.color !== group.color)
      .map((track) => ({ trackId: track.id, from: track.color, to: group.color })),
    clipUpdates: descendants.flatMap((track) =>
      track.clips
        .filter((clip) => clip.color !== group.color)
        .map((clip) => ({ clipId: clip.id, trackId: track.id, from: clip.color, to: group.color })),
    ),
  }
}
```

Persistence:

- Track colors reuse the existing `tracks.setColor` shared operation.
- Clip colors add or reuse `clips.setColor`, depending on the existing clip color persistence surface.
- If the batch is too large, for example more than 20 operations, add batch operations for track and clip colors instead of dispatching many individual writes.
- Undo should be a compound entry that restores all previous track and clip colors together.

UI:

- Add one group-row context menu item: “Assign color to grouped tracks and clips”.
- Disable the item when the group has no color.

Tests:

- Planner returns null when group has no color.
- Command updates all descendant tracks and their clips.
- Command skips tracks and clips that already have the target color.
- Undo restores all previous colors.

### V2.4 Folded Group Overview Interaction, Minimal Scope

Goal: make folded group overview useful without introducing synthetic clip editing.

V1 state:

- `buildGroupClipOverview` merges child clip ranges into read-only overview segments.
- `TrackLane` renders these overview segments for collapsed groups.

Scope decision:

- Do not implement direct clip editing in the folded state.
- Do not add `clipRefs`, overview segment dragging, or overview segment resizing in V2.
- If users need to edit child clips, they should unfold the group first.

Interactions:

1. Click a folded group overview segment to unfold the group and select the corresponding time range across child tracks.
2. Double-click a folded group row to unfold the group.
3. Context menu on folded group row includes “Unfold group” and “Select all clips in group”.

Implementation notes:

- Keep the existing overview data model unless the time-range selection needs segment identity.
- Route clicks through existing selection state where possible.
- Do not create synthetic clips.
- Do not bypass existing clip edit actions.

Tests:

- Double-clicking a folded group row unfolds it.
- Context menu unfold uses the same collapse action path.
- Selecting overview range affects only descendants of the group.
- No direct drag or resize affordance appears for overview segments.

### V2 Suggested Implementation Order

1. Backfill grouping keyboard shortcuts because they reuse existing V1 actions and are low risk.
2. Enable nested group routing in shared routing normalization, Convex sanitization, local repository normalization, and audio graph tests.
3. Add pure V2.1 helpers and tests for drop-zone resolution, move-set normalization, cycle rejection, contiguous subtree movement, and reorder patches.
4. Add `tracks.reorderAndGroup` shared operation, Convex mutation, and local transaction.
5. Add sidebar track drag state and visual indicators without persistence side effects.
6. Wire drag persistence, target group auto-expansion, and undo for reorder/reparent.
7. Add the single Ableton-style group color propagation command and compound undo.
8. Add minimal folded overview interactions.
9. Run full validators and a simplify pass before merging V2.

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

- `Cmd+G` or `Ctrl+G` groups selected tracks through the same path as the context menu.
- Basic track reorder works in projects with zero groups.
- Drag a track above, below, and inside a group.
- Drag a track out of a group by dropping into the root level.
- Drag an expanded group and verify descendants move with it.
- Drag a collapsed group and verify hidden descendants remain attached.
- Try to drag a group into its child and confirm the invalid indicator.
- Drop inside a collapsed group and confirm it expands.
- Route an inner group to an outer group and verify audio still reaches Master.
- Ungroup or move an inner group out and verify invalid nested routing resets to Master.
- Use group color propagation and undo it.
- Double-click a folded group overview row and confirm it unfolds.
- Verify collaboration sees reorder/reparent as one coherent update.
- Verify reorder undo and redo produce a clean round trip.

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
