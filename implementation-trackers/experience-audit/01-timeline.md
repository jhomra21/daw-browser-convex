# Timeline Editing Surface

## Area summary

The timeline has solid foundations: clip drag, resize, marquee, overview navigation, and automation gestures generally have explicit cleanup and cancellation paths; zoom coalesces wheel updates and cancels scheduled work. The clearest experience gaps are loop-edit cancellation and silent persistence failures. Two concrete scaling costs remain in gesture and collapsed-group paths.

## Findings

### TL-01 — Loop edits are committed on pointer cancellation

- **Category:** A
- **Evidence:** `src/components/timeline/TimelineRuler.tsx:131-135`
  ```ts
  const onPointerUp = () => {
    if (!dragging) return
    dragging = false
  ```
  `src/components/timeline/TimelineRuler.tsx:78-80` registers `pointercancel` to this same handler. There is no window-blur or Escape cancellation path; cleanup only detaches listeners (`:192-194`).
- **User experience:** If the OS/browser cancels a pointer, the partially drawn or adjusted loop remains as if the gesture completed. Losing focus mid-drag can leave the gesture active until another pointer event or unmount.
- **Minimal fix:** Store the loop start/end before editing; handle pointercancel, Escape, and window blur by restoring that baseline, then detach listeners. Reuse the explicit cancel/finish lifecycle in `ArrangementOverview` (`src/components/timeline/ArrangementOverview.tsx:68-76,109-123`).
- **Size:** S
- **Risk:** Low
- **Verify:** Browser check: begin a loop create/resize, move, send pointercancel or blur (and separately Escape), and confirm the baseline loop returns and a subsequent gesture works normally.

### TL-02 — Failed clip moves and fade saves fail silently

- **Category:** A
- **Evidence:** `src/hooks/useClipDrag.ts:632-636`
  ```ts
  }).catch(() => {
    commitClipMoves(previousMoves)
  ```
  `src/components/Timeline.tsx:1383-1396` similarly catches fade-save errors and rolls back without notifying.
- **User experience:** A move or fade can appear to succeed, then revert with no explanation or retry affordance. This is especially confusing when editing a shared or locally persisted project.
- **Minimal fix:** Reuse the existing timeline `notify` path for failed writes, including a concise action-specific message; keep the current rollback behavior. Pass the notifier into the clip-drag commit boundary if needed, as the surrounding clip action/import flows already do.
- **Size:** S
- **Risk:** Low
- **Verify:** Force the move/fade persistence request to fail in a browser test; confirm the edit rolls back and an accessible, actionable error message appears.

### TL-03 — Clip resize scans and allocates clip arrays on every pointer move

- **Category:** B
- **Evidence:** `src/hooks/useClipResize.ts:167-185`
  ```ts
  const track = tracks().find(t => t.id === activeResize.trackId)
  const clip = track?.clips.find(c => c.id === activeResize.clipId)
  const others = track.clips.filter(c => c.id !== clip.id)
  ```
  The right-edge path performs another neighbor scan at `:253-259`.
- **User experience:** Each pointer event performs repeated linear scans and allocates a filtered array proportional to clips on the track. Dense tracks therefore make trim/resize work scale with clip count even though the gesture’s target and neighbor constraints are stable.
- **Minimal fix:** At resize start, retain the target track/clip and derive the nearest relevant neighboring boundary once; update that snapshot only if the track’s clip arrangement changes during the gesture. Keep the existing draft-timing and cancellation flow.
- **Size:** M
- **Risk:** Med
- **Verify:** Browser performance check on a generated dense track: drag each resize edge and compare pointer-event work before/after; confirm snapping, overlap limits, and Escape rollback remain unchanged.

### TL-04 — Collapsed group overviews rescan all tracks and clips per group

- **Category:** B
- **Evidence:** `src/components/timeline/timeline-workspace.tsx:276-284`
  ```ts
  for (const track of props.tracks) {
    if (track.channelRole !== "group" || track.collapsed !== true) continue
    overviews.set(track.id, buildGroupClipOverview(track.id, props.tracks))
  }
  ```
  `src/lib/timeline-track-layout.ts:117-126` collects descendants, filters the full track list, flattens their clips, and sorts them for each group.
- **User experience:** With multiple collapsed groups, rebuilding the overview repeats whole-project traversal and clip sorting for each group. This work is tied to track updates and can make large arrangements feel less responsive.
- **Minimal fix:** Build the group-descendant/clip ownership index once per track snapshot, then derive collapsed group segments from that index. Reuse the existing `buildTrackTree`/`computeDepthMap` layout model rather than independently rediscovering group relationships.
- **Size:** M
- **Risk:** Med
- **Verify:** Compare overview generation counts and timings for many collapsed groups before/after; visually confirm each group still includes only descendant clips and merges adjacent same-color segments.

## Looked at and fine

- `src/hooks/useDrag.ts`: clip drag captures the initiating pointer and cancels on pointercancel, Escape, blur, lost pointer capture, and cleanup.
- `src/hooks/useClipResize.ts`: resize has pointer-ID filtering, pointer capture, Escape/blur/pointercancel rollback, and removes its listeners.
- `src/hooks/useTimelineSelection.ts`: marquee selection resets on both end and cancel; it reuses binary-search row lookup from `timeline-track-layout`.
- `src/hooks/useTimelineViewport.ts`: wheel zoom is coalesced per animation frame; timeout, observer, scroll listener, and pending frame are cleaned up.
- `src/components/timeline/ArrangementOverview.tsx`: pointer capture is released and preview range is restored on cancellation/lost capture.
- `src/components/timeline/ClipComponent.tsx`: waveform drawing is paint-coalesced and the scheduled frame is cancelled on cleanup; visible clip rendering uses the existing render-range helper.
- `src/hooks/useTimelineKeyboard.ts`: timeline shortcut listener is removed on cleanup and defers to editable fields, dialogs, menus, and local keyboard surfaces.
- Queried repository usages for timeline layout, section-edit, clip-create, track-group, resolver, audio-import, waveform, and timeline-repository modules; no unused export/file claim is supported by the inspected usage evidence. No duplicate implementation finding was confirmed.
