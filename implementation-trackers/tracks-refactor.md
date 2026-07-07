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

- Drag-to-reparent with above, below, and inside zones.
- Nested group audio routing where inner group output can route to outer group.
- Direct editing of clips from folded group overview.
- Explicit “assign group color to children and clips” command.
- Reorder-aware group dragging and drop indicators.

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
