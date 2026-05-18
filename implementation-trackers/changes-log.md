# Skill Review Changes Log

Tracks review-driven follow-up work before merging the audio refactor branch.

## 2026-05-17 — Native Toolbar Redesign Follow-Up

### Scope

- Created the `native-toolbar-redesign` branch after the unified timeline/sidebar branch landed.
- Reworked the timeline toolbar so the center transport controls remain unchanged while the left side uses native app-style menu triggers.
- Moved toolbar-adjacent actions into top menu groups instead of scattered buttons and bottom-right controls.

### Toolbar and Menu Changes

- Added `File`, `Edit`, `Project`, `Project Media`, `Settings`, and `Share` menu triggers to the left side of `src/components/timeline/TransportControls.tsx`.
- Kept the center `TransportBar` intact and left the right side as playhead-only after moving `Share` into the left menu group.
- Wired `Timeline.tsx` to pass `onUndo` and `onRedo` into `TransportControls` so `Edit` can expose undo/redo actions.
- Removed the standalone `NavUser` toolbar avatar path and moved sign-in, account, logout, and about actions into `Settings`.
- Restored the missing project media functionality by adding a `Project Media` menu with project samples, default samples, exports, sample drag, copy, insert, and delete actions.
- Moved the bottom-right `Shortcuts` trigger out of `EffectsPanel` and into `Settings > Shortcuts` while preserving the same shortcut list users previously saw.
- Portaled the shortcuts submenu content so it is not clipped by the parent settings dropdown.
- Removed the bright shortcuts submenu border and standardized menu hover/focus styling so highlighted items keep readable text contrast.
- Updated `NativeMenuTrigger` to render the dropdown trigger as the shared `Button` component, avoiding nested interactive controls.
- Replaced the attempted dropdown-based menu-bar behavior with a dedicated Solid/Kobalte Menubar wrapper, matching shadcn's React/Radix Menubar pattern for desktop menu bars.
- Converted the native toolbar menus to `Menubar.Root/Menu/Trigger/Content` so hovering another top menu while one is open switches menus through Kobalte's built-in menubar context.
- Added highlighted/open trigger styling through Kobalte Menubar trigger state so top menu triggers remain visually selected while their menu is active.
- Removed the white focus outline around open menubar content while preserving item-level focus styling.
- Added conventional Popper spacing to top-level menus and submenus through Kobalte `gutter`/`shift` props instead of content margin offsets.
- Matched the submenu feel more closely to shadcn's Menubar styling with expanded subtrigger state, chevrons, stronger submenu shadow, and portaled submenu content to avoid clipping.
- Fixed the `Project Media` menu's horizontal scrollbar by hiding x-overflow while keeping vertical scrolling.
- Added native-feeling menubar animation gating: initial open and final close animate, while switching from one open top menu to another is instant.
- Removed top-level trigger press-scale, focus-ring flash, hover color transition, and stale highlighted-state styling so hover/open feedback changes immediately and only reflects the active menu.
- Let Kobalte own top-level `Media` and `Share` menu open state, keeping their side-effect handlers only, so menu-to-menu switching closes the previous content through the menubar context.
- Converted the `Share` menu close control from a native button to a `MenubarItem` so close behavior routes through the same menu primitive path.
- Hid non-active closed menu content during menu switching and tracked the active animation value inside the menubar wrapper so an older menu cannot flash during the final close animation.

### Solid Architecture Cleanup

- Replaced expanded per-menu prop lists with a file-local `ToolbarProvider`/`useToolbar` context for private toolbar menu components.
- Kept the toolbar context scoped to `TransportControls.tsx` instead of introducing global app state, matching Solid's context use case for avoiding prop drilling without broadening ownership.
- Kept menu-specific controllers local to `TransportControls`, including projects, samples, exports, share, and tempo controllers.
- Added `src/components/ui/menubar.tsx` as the Solid port of shadcn's Menubar wrapper, using `@kobalte/core/menubar` while preserving local dropdown menu styling.
- Used Solid's `mergeProps` in the menubar wrapper for default `gutter` and `shift` values so callers can override positioning without losing idiomatic default-prop handling.

### Review Follow-Up

- Solid UI review found the dropdown triggers were nesting a `Button` inside `DropdownMenuTrigger`; fixed by rendering the trigger polymorphically as `Button`.
- A follow-up review after restoring the media menu returned no additional high-confidence findings.
- Simplified the menu callsites and then replaced local prop threading with the scoped toolbar context after reviewing Solid props/context guidance.
- Simplify review removed the duplicate share-menu open path so the menu open state handler is the single path that prepares the share URL.
- Simplify review noted broader repeated menu icon-button chrome and dropdown/menubar wrapper class duplication, but those were left unchanged to keep the follow-up focused.
- A second simplify review reused one shared grid-resolution list for the transport dropdown and Settings menu, fixed menubar child indentation, and skipped no-op effect order/index state updates when refreshed query rows match current state.
- Defensive-code review removed a redundant tempo draft length fallback and an empty defensive wrapper around static input pointer listener registration.
- A second defensive-code review found no additional high-confidence redundant guards, duplicated validation, or impossible-state branches.
- The post-commit menu polish simplify loop moved menu identity into the local `MenubarMenu` wrapper context, removed the duplicate `Share` open prop, combined animation state, and then returned LGTM for reuse, quality, and efficiency.
- The post-commit simplify cleanup also kept controlled menubar value tracking synced with external `value` props so animation decisions do not rely on stale local state.
- The post-commit defensive-code-review removed the redundant optional menubar animation context fallback and then returned LGTM.

### Validation

- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the initial native toolbar implementation and nested-trigger fix.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after simplifying menu prop passing.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after adding the local `ToolbarProvider`.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after restoring `Project Media`, samples, default samples, exports, and account/settings functionality.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after moving shortcuts into `Settings > Shortcuts`.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after moving `Share` into the left toolbar menu group.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after fixing the shortcuts submenu clipping, border, and menu hover contrast.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after porting the native toolbar menus from dropdown menus to Kobalte Menubar.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after polishing menubar focus outlines, menu/submenu spacing, submenu clipping, and media-menu overflow.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after simplify cleanup, defensive-code-review cleanup, log updates, and final diff review.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the second simplify pass, second defensive-code-review pass, log update, and final diff review.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the post-commit menu animation polish, repeated simplify loop, defensive-code-review rerun, log update, and final diff review.

## 2026-05-16 — Unified Timeline Sidebar Scroll Follow-Up

### Scope

- Created the `unify-timeline-sidebar` branch after the pointer-event cleanup landed on `master`.
- Reworked the timeline/sidebar layout so track rows and their sidebar controls share one vertical scroll context instead of scrolling independently.
- Kept horizontal scrolling scoped to the clip/timeline area while keeping the track sidebar visible at the right edge.

### Layout Changes

- Moved `TrackSidebar` into the main timeline scroll content in `src/components/Timeline.tsx` so vertical scrolling moves timeline lanes and sidebar rows together.
- Wrapped the clip/ruler area and sidebar in one wide flex content surface sized from timeline duration plus sidebar width.
- Kept the sidebar pinned during horizontal timeline scrolling with a sticky right-side wrapper.
- Removed the sidebar's independent vertical scroll container so the sidebar no longer drifts out of alignment with the timeline lanes.
- Made the sidebar header sticky to the shared timeline scrollport so `Sync Mix`, add-track controls, and routing controls stay aligned with the sticky timeline ruler.
- Locked the sidebar header height to the shared `RULER_HEIGHT` constant so its bottom border aligns with the timeline ruler border.
- Prevented the sidebar header controls from wrapping when users resize the sidebar, avoiding variable header height that would break row alignment.
- Changed the sidebar resize hit area from a layout-taking flex column to an absolutely positioned overlay on the sidebar's left edge, preserving the drag affordance without creating a visible 16px gap between the ruler and sidebar.

### Corrections During Visual Iteration

- Confirmed that earlier sticky-header attempts appeared ineffective because the dev server had been stopped before visual verification.
- Removed an attempted first-row border adjustment after confirming the perceived double-border issue was not the root cause.
- Removed the resize gutter's temporary sticky background strip once the resize hit area was converted to a non-layout overlay.
- Kept the resize divider visually distinct while ensuring the invisible hit area no longer affects layout or introduces blank space.
- Simplify review found no scoped reuse, quality, or efficiency cleanup needed; its positioning-context concern was already covered by the sticky sidebar wrapper.
- Defensive-code review removed the optional `bottomOffsetPx` fallback from `TrackSidebar` because the single `Timeline` callsite always passes the shared bottom offset.
- Fixed clip drag release cleanup by listening for shared drag `pointerup` and `pointercancel` in the capture phase, so clip-level pointer-up handling cannot leave the drag session active after release.
- Rebalanced timeline stacking so the sidebar header remains above the ruler, the ruler remains above scrolled clips, and playhead/loop guide overlays sit above clips/text while staying below the sticky ruler.
- Replaced the sidebar row separator element with an inset row shadow during simplify cleanup, preserving track/sidebar row alignment without adding per-row decorative DOM.
- Simplify review also replaced the sidebar row's hard-coded `96px` height with the shared `LANE_HEIGHT` constant so future timeline lane-height changes cannot desynchronize sidebar rows.
- Defensive-code review found no high-confidence redundant guards, duplicated validation, or impossible-state branches in the drag-release or stacking follow-up.
- Restyled clip name labels from rounded inset badges into full-width integrated top strips with stronger opacity and `p-1` text padding, so labels read as part of the clip instead of floating cards while keeping the intended compact inset around the text.
- Added an optional `dragCursorClass` lifecycle hook to shared `useDrag` and wired clip dragging to `cursor-grabbing`, keeping the active move cursor cleanup in the same path as global pointer listener cleanup.
- Simplify review initially suggested vertical-only padding, but the label intentionally remains `p-1` to preserve the desired text inset; broader cursor-class ownership concerns were left unchanged because overlapping drag sessions are outside the current single-active-drag UI path.
- Defensive-code review found no high-confidence redundant guards or impossible branches in the clip label and drag-cursor follow-up.

### Validation

- `bun run typecheck`, `bun run build`, and `git diff --check` passed after moving the sidebar into the timeline scroll content.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after making the sidebar header sticky.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after aligning the sidebar header height with `RULER_HEIGHT`.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after converting the resize hit area into an absolute overlay.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after simplify review; final validation was rerun after defensive-code cleanup and log updates.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the clip-drag release and timeline/sidebar stacking fixes.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the final guide-layering correction, simplify cleanup, defensive-code-review rerun, log update, and final diff review.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the clip label strip, drag cursor lifecycle, simplify cleanup, defensive-code-review rerun, log update, and final diff review.

## 2026-05-15 — Track Sidebar Routing and Meter Visibility Follow-Up

### Scope

- Reviewed the current track-row redesign follow-up after the track sidebar routing controls moved from the effects panel into the sidebar.
- Used `implementation-trackers/audio-refactor-branch-tracker.md`, `implementation-trackers/timeline-refactor-tracker.md`, and this changes log as history context.

### Before Review Skills

- Moved track output and send routing controls into `src/components/timeline/TrackSidebar.tsx` and wired them from `src/components/Timeline.tsx`.
- Removed the duplicated routing card path from `src/components/timeline/EffectsPanel.tsx` so routing edits now live in the track rows.
- Raised the sidebar resize minimum width to 320px and adjusted the track-row grid columns so the stereo audio meter remains visible at minimum width instead of being clipped.
- Restored per-track volume editing as a horizontal sidebar slider under the record/solo controls, matching the redesigned Ableton-style track row layout.
- Restyled the volume slider as a smaller flat rectangular control with a filled amber segment, gray remainder, 2px border, and preserved row spacing instead of the native rounded thumb.
- Added explicit pointer-drag handling for the custom volume slider so the flat no-thumb control supports click-and-drag changes rather than click-only updates.
- Preserved existing send routes and amounts when changing the sidebar's selected send target instead of replacing the full sends array.
- Added hidden-scrollbar styling for the track sidebar scroll area while preserving vertical scrolling.
- Renamed return-track labels in the sidebar and send selector to `Return #` and removed the separate return badge.
- Refined the track-name click target into a compact centered border-only control with instant hover/selection state changes and a consistent visible border across muted and selected rows.
- Darkened the inactive stereo meter wells so meters remain visible against selected track rows.
- Tightened the track-row layout so sidebar columns use consistent horizontal spacing while keeping the record/solo controls, volume slider, and stereo meter group fixed-width at minimum sidebar sizes.
- Raised the shared sidebar minimum width to 336px across initial state, drag-resize clamping, and rendered sidebar width so the right-side stereo meters do not compress or clip.
- Made the sidebar resize divider visually thinner/brighter while increasing its transparent drag hit area without changing the visible divider width.
- Replaced the visible native routing select triggers with aligned custom trigger shells while keeping invisible native selects for dropdown behavior, so label and chevron spacing stay visually balanced.
- Added immediate per-track selected-value state for the custom routing triggers so the visible output/send labels reflect the native select choice without waiting for persisted routing props to round trip.
- Added local-first routing persistence for output/send changes so owner routing choices survive refresh from local storage while Convex remains the sharing/sync path.
- Fixed the local mix persist path so silent in-memory routing updates also flush the merged local mix map to local storage.
- Saved routing patches directly to the room local mix key before applying optimistic shared routing, avoiding any dependency on the later shared write path.
- Added a dedicated per-room local routing storage key and merged it into the local track state on load so routing restore no longer depends on the mix override cleanup path.
- Moved the local routing write to the Timeline sidebar callback boundary so every output/send UI change flushes local routing before any mixer-controller permission, equality, or shared-write branch can skip it.
- Moved local routing persistence back into the mixer-controller routing application boundary so sidebar changes, undo/redo, and other controller-level routing applications update the same local-first store.
- Made the sidebar send `None` option clear all sends for the single-send dropdown contract so hidden additional sends cannot reappear after refresh.
- Persisted normalized local routing before the mixer controller's no-op equality return so re-selecting `None` repairs stale local routing storage even when pending in-memory routing already matches.
- Persisted sidebar routing changes through the shared local mix abstraction at the Timeline callback boundary as well, so selecting send `None` flushes `sends: []` before any controller snapshot/equality/pending-routing branch can interfere.
- Manually confirmed the local-first send `None` path now survives immediate refresh without waiting for Convex/shared persistence.
- Validated the final Solid UI review findings and fixed stale record-arm row state, timeline drag listener cleanup, clip-resize listener cleanup, MIDI editor JSX `.map()` rendering, and AgentChat deferred scroll cleanup.
- Switched timeline lane selection from mouse-only drag events to pointer events so the pointer-start contract, global move/up listeners, and cleanup path use the same event family.
- Fixed the follow-up Solid review findings by reading MIDI `<For>` note indices at pointer-event time, moving the MIDI grid-cell memo below its row dependency, and routing pointer lane scrub movement through `usePlayheadControls.moveScrub`.

### Simplify Review

- Memoized sidebar group and return track lists so each track row reuses derived routing target arrays instead of filtering all tracks per row.
- Removed now-unused routing callback props from `EffectsPanel`, `TimelinePanels`, and the effects-panel callsite in `Timeline`.
- Grouped the shared timeline and track-sidebar hidden-scrollbar CSS selectors to avoid duplicate scrollbar declarations.
- Removed the now-unused routing-specific return fields from `useEffectsPanelTarget` after the final simplify rerun; the rerun then returned LGTM.
- Quantized custom slider drag values to the existing `0.01` step and skipped duplicate volume emissions during pointer drags to reduce hot-path mixer/history churn.
- Avoided no-op meter state updates and stopped the meter RAF loop when playback is stopped because stopped meters are not rendered.
- Reused a local `displayTrackName` helper for both row labels and send options, and aligned the label wrapper with the centered track-name button.
- Reused a local unit clamp helper for volume and stereo-meter values, removed a redundant header wrapper, and noted the file-wide TrackSidebar formatting churn for later cleanup outside this focused sidebar layout follow-up.
- Reconciled the custom routing trigger selected-value maps after the simplify review so confirmed values and removed tracks do not leave stale local labels, skipped no-op selected-value updates, and reused target-name maps for output/send label lookups.
- A simplify rerun for local-first routing skipped broad storage abstraction changes, kept branded-track-id-safe target lookups, and briefly removed the duplicate mixer-controller routing write before later validation restored controller-boundary persistence alongside the Timeline callback write.
- The repeated simplify loop removed the final duplicate routing write from `useTimelineLocalMix.persist` because the merged local track-state save already writes the dedicated routing map, then reuse, quality, and efficiency reruns all returned LGTM.
- The final simplify rerun returned LGTM for reuse, quality, and in-scope efficiency.
- The Solid UI simplify pass reused the existing `useDrag` pointer lifecycle helper for lane selection, removed unused hook cleanup exports and MIDI grid-cell key state, routed AgentChat deferred scroll frames through one tracked scheduling helper, and moved the remaining inline deferred-scroll callers onto that helper.
- The post-review simplify loop cached MIDI grid column and major-step values inside the grid-cell memo, reduced grid-cell entries to booleans, coalesced superseded AgentChat deferred-scroll work, and let pointer lane scrubs start without redundant mouse listeners; the rerun returned LGTM for reuse, quality, and efficiency.

### Defensive-Code Review

- Removed redundant role guards from sidebar routing change handlers after verifying the handlers are only wired from role-gated selects.
- Removed the redundant stereo-level tuple shape check in `TrackSidebar` because the callback type already guarantees `[number, number]` when present.
- Removed the redundant sidebar resize `maxWidth` lower clamp because the final width clamp already enforces the minimum width.
- Tightened the effects-panel target type to `Track["id"] | "master"` and removed the now-redundant empty-target fallback in `useEffectsPanelTarget`.
- Removed the optional fallback around the required sidebar mono meter callback.
- Kept permission and optional-callback guards because they protect writable-track and optional integration boundaries.
- A defensive-code-review rerun found no additional high-confidence redundant guards in the return-label naming or track-name UI state changes.
- A defensive-code-review rerun found no high-confidence redundant guards, impossible branches, or stale log entries in the sidebar spacing, resize minimum, fixed meter group, or resize-hitbox follow-up.
- A defensive-code-review rerun found no high-confidence redundant guards or stale log entries in the custom routing trigger selected-value follow-up.
- A defensive-code-review rerun removed the redundant sidebar meter sampling `try` wrapper and tuple-element fallbacks after verifying the Timeline callsite already catches audio-engine meter failures and returns a typed stereo tuple.
- The repeated defensive-code-review loop returned LGTM for both UI and routing-storage groups with no additional high-confidence redundant guards or impossible branches.
- The post-confirmation defensive-code-review removed the now-impossible meter `current` fallback after proving every rendered track receives a sampled meter entry in the same tick, and clarified an intermediate simplify-log entry that was superseded by the confirmed callback-plus-controller local routing persistence path.
- The final defensive-code-review rerun returned LGTM with no additional high-confidence redundant guards or impossible branches.
- The Solid UI defensive-code-review removed redundant lane-drag scroll-element fallbacks, duplicate `useDrag` cancellation, and duplicate parent lane-drag cleanup while keeping hook-owned cleanup that stops scrub state and clears marquee state.
- The post-review defensive-code-review loop returned LGTM for AgentChat, timeline hooks, MIDI, TrackSidebar, and the changes log; the AgentChat scroll coalescing was kept as the accepted simplify efficiency fix rather than removed as redundant defense.

### Validation

- `bun run typecheck`, `git diff --check`, and `bun run build` passed after simplify cleanup.
- `bun run typecheck`, `git diff --check`, and `bun run build` passed after defensive cleanup and log updates.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the sidebar volume slider restoration, styling, and drag-interaction fixes.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the final simplify and defensive-code-review follow-up cleanup.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the final repeated review loop where both simplify and defensive-code-review returned LGTM.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the return-label and track-name border follow-up.
- `bun run typecheck` and `git diff --check` passed after the selected-row meter contrast follow-up.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the track-sidebar spacing, resize minimum, fixed meter group, and resize-hitbox follow-up.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the simplify and defensive-code-review cleanup for the sidebar layout follow-up.
- `bun run typecheck` and `git diff --check` passed after the routing dropdown trigger alignment follow-up.
- `bun run typecheck` and `git diff --check` passed after the instant routing trigger selected-value follow-up.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the simplify cleanup and defensive-code-review rerun for the custom routing trigger follow-up.
- `bun run typecheck` and `git diff --check` passed after adding local-first routing persistence.
- `bun run typecheck` and `git diff --check` passed after fixing the local mix flush path for local-first routing.
- `bun run typecheck` and `git diff --check` passed after making routing writes flush directly to local storage.
- `bun run typecheck` and `git diff --check` passed after adding dedicated local routing storage.
- `bun run typecheck` and `git diff --check` passed after moving local routing persistence to the sidebar callback boundary.
- `bun run typecheck` and `git diff --check` passed after the simplify and defensive-code-review cleanup for local-first routing persistence.
- `bun run typecheck` and `git diff --check` passed after the repeated simplify loop; the repeated defensive-code-review loop then returned LGTM.
- `bun run typecheck` and `git diff --check` passed after moving local routing persistence into the mixer controller and clearing all sends for sidebar `None`.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after making routing persistence run before no-op equality checks.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after adding the local mix callback-boundary write for sidebar routing changes.
- User validation confirmed selecting a return send, changing it to `None`, and refreshing immediately now keeps `None`.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after post-confirmation simplify and defensive-code-review cleanup.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the Solid UI cleanup, simplify pass, defensive-code-review pass, and pointer-event lane selection follow-up.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the final post-review simplify loop, defensive-code-review loop, changes-log update, and final diff review.

## 2026-05-13 — Access-Control Review Follow-Up

### Scope

- Re-reviewed the branch after the final code-review pass, using `implementation-trackers/audio-refactor-branch-tracker.md`, `implementation-trackers/timeline-refactor-tracker.md`, and this changes log as history context.
- Ignored legacy data, migration, and backfill concerns per the current merge-review scope.

### Before Review Skills

- Added room access enforcement to `convex/timeline.fullView` and updated `src/hooks/useTimelineData.ts` to pass `userId` with full-view reads.
- Removed the frontend effect that silently ensured ownership for arbitrary URL room IDs, so direct navigation no longer grants access before timeline reads.
- Added room access enforcement to `convex/tracks.create` before inserting tracks and ownership rows.
- Added target-track write access enforcement for clip creation and track-lock enforcement for clip move/timing mutations.

### Simplify Review

- Removed a redundant clip-kind compatibility wrapper in `convex/clips.ts`.
- Reused normalized merged-track lock state directly instead of re-normalizing it in clip lock checks.
- Avoided the duplicate target-track merge read in `clips.move` by checking the returned compatible target track for locks.
- Encapsulated writable compatible track lookup for clip creation so ownership and compatibility checks stay together.
- Rewrote the `timeline.fullView` query argument/key callbacks with local room/user/bootstrap values to keep bootstrap gating easier to scan.

### Defensive-Code Review

- Reviewed backend access/lock guards, frontend drag-placement guards, and tracker/log changes for redundant defensive code.
- Kept track `getMergedTrack` null guards because removing them caused TypeScript errors without adding assertion plumbing, and the guards preserve persistence-boundary safety.
- Kept multi-drag clip lookup guards because removing them would require a broader proof helper or non-null assertions.
- Tracker/log review found no stale or contradictory entries to update beyond this new follow-up record.

### Validation

- `bun run typecheck`, `git diff --check`, and `bun run build` passed after the access-control fixes.
- `bun run typecheck`, `git diff --check`, and `bun run build` passed after simplify cleanup.
- `bun run typecheck`, `git diff --check`, and `bun run build` passed after defensive-code review.
- `bun run knip` remains expected to fail on the already-known repo-level unused files/exports, unlisted `kysely` dependency reference, and duplicate audio-peaks export.

## 2026-05-13 — Pre-Merge Post-Implementation Review

### Scope

- Reviewed the full `audio-engine-refactor` branch against `origin/master`.
- Reviewed `implementation-trackers/audio-refactor-branch-tracker.md` as the branch-level completed-work inventory.
- Reviewed `implementation-trackers/timeline-refactor-tracker.md` as the detailed implementation, validation, blocker, and decision log.
- Created this delta-only log for changes and outcomes from `/simplify` and `/defensive-code-review`.

### Before Review Skills

- Added `implementation-trackers/audio-refactor-branch-tracker.md` to summarize completed work across API, Convex, timeline UI, audio engine, mixer/routing, clips/samples, waveforms, recording, export, undo/history, auth/share, and cleanup.
- Preserved `implementation-trackers/timeline-refactor-tracker.md` as the detailed step-by-step tracker for the timeline/audio cleanup refactor.

### Simplify Review

- Reused `createTimelineTrackIndex` in `src/hooks/useTimelineMidiOverlay.ts` instead of maintaining local clip/track lookup scanning.
- Memoized the MIDI overlay track index so repeated clip lookups reuse the same derived index until tracks change.
- Added `src/lib/sample-drag-data.ts` and replaced repeated raw sample drag MIME strings in sample drag/drop producer and consumers.
- Added shared sample drag serialization/parsing helpers so the drag payload contract lives with the MIME type.
- Added `src/lib/dom-dataset.ts` for shared dataset ancestor walking used by project and sample menu outside-click handling.
- Replaced dynamic `closest()` selector interpolation in project/sample menu outside-click handling with dataset walking.
- Escaped the dynamic project rename input selector before `querySelector`.
- Reused the existing clip-drag track index when planning duplicated clip placements and avoided allocating a copied drag-type array on global dragover.
- Reused the same clip-drag track index for non-duplicate placement planning and grouped same-track clip edit replacements so projected timeline resolution no longer remaps a track's clip array once per edited clip.
- Deferred a broader project-delete batch cleanup optimization as out of scope for this pre-merge review.
- Deferred replacing global dragover bounds checks with root-scoped containment handling because it is broader than this focused pre-merge cleanup.
- A final simplify loop returned LGTM for reuse, quality, and efficiency after the scoped fixes above.

### Defensive-Code Review

- Removed one proven redundant optional fallback in duplicate clip placement by reading the already-validated target track's `clips` directly.
- Removed an unnecessary exported `SampleDragData` type after defensive/log review found it would add a new `knip` unused-type finding.
- Removed one impossible replacement-track guard in projected timeline clip edit application by carrying the already-proven track object with its pending replacements.
- Updated `implementation-trackers/timeline-refactor-tracker.md` so the `useTimelineMidiOverlay.ts` shared-index checklist and decision log reflect the pre-merge cleanup.
- Kept API clip-selection fallback guards because TypeScript cannot prove the narrowed invariant without adding a new assertion path.
- Kept multi-drag clip lookup guards because removing them would require non-null assertions or a broader proof helper.
- Kept the concise pre-review tracker provenance in this delta log because the post-implementation review requires recording the before-skill context as well as review-driven changes.
- Frontend, audio, and tracker reviews found no additional high-confidence redundant guards or duplicated log entries to remove.
- A final defensive-code-review loop returned LGTM for source and tracker/log changes.

### Validation

- `bun run typecheck` passed after simplify and defensive cleanup.
- `bun run build` passed after simplify and defensive cleanup.
- `git diff --check` passed after simplify and defensive cleanup.
- `bun run knip` still fails on the existing repo-level unused files/exports, unlisted `kysely` dependency reference, and duplicate `ensurePeakAsset` / `primeWaveformAsset` export already tracked in `timeline-refactor-tracker.md`.

## 2026-05-13 — Code Review Validation Follow-Up

### Review Finding

- `/review` found one high-confidence pre-merge issue: existing `tracks` rows from pre-refactor deployments would not have matching `mixerChannels` rows after mixer state moved out of the `tracks` table.
- Validated the finding with `/review-validate` against `origin/master` schema/history, current Convex read paths, and the lack of any existing backfill/migration.
- Confirmed the failure path: `convex/timeline.fullView`, `tracks.listByRoom`, and mutation helpers using `getMergedTrack`/`ensureMixerChannelForTrack` would throw on existing rooms before data reached the client.

### Fix

- Added an idempotent internal Convex mutation, `mixerChannels.backfillMissingMixerChannels`, to create missing mixer-channel rows for existing tracks.
- Reused `buildMixerChannelInsert` so migrated rows use the same mixer defaults and lock normalization as newly created tracks.
- Seeded migrated mixer rows from legacy track fields (`volume`, `muted`, `soloed`, `lockedBy`, `lockedAt`) when those fields exist on pre-refactor documents.
- Kept strict read-path invariants so missing or duplicate mixer-channel rows still surface data-integrity problems after migration.

### Validation

- `bun run typecheck` passed after the backfill fix.
- `bun run build` passed after the backfill fix.
- `git diff --check` passed after the backfill fix.
- `bun run knip` still fails only on the already-known repo-level unused files/exports, unlisted `kysely` dependency reference, and duplicate audio-peaks export.

### Follow-Up

- Run `mixerChannels:backfillMissingMixerChannels` with paginated arguments on existing Convex deployments before relying on strict mixer-channel reads for pre-refactor rooms.

## 2026-05-13 — Final Pre-Merge Cleanup Review

### Scope

- Re-ran the post-implementation cleanup sequence across the full `audio-engine-refactor` branch before merge.
- Used `implementation-trackers/audio-refactor-branch-tracker.md`, `implementation-trackers/timeline-refactor-tracker.md`, and this changes log as review context so intentional refactor decisions and known `knip` findings were not re-flagged.

### Simplify Review

- Reused `createTimelineTrackIndex` in `src/lib/undo/builders.ts` for clip-move history lookup construction.
- Reused `createTimelineTrackIndex` in `src/lib/export-mixdown.ts` for offline render track lookup construction.
- Exported and reused the sample drag payload type from `src/lib/sample-drag-data.ts` so sample drag/drop and insert flows share one payload contract.
- Replaced the full-table mixer-channel backfill scan with a paginated internal mutation and optional `roomId` scope.
- Replaced the backfill helper's legacy-track `any` read with an explicit structural legacy-field type.
- Left broader `useProjectSamples.ts` default-sample concurrency/cancellation cleanup out of scope because it was not part of the current focused follow-up diff.

### Defensive-Code Review

- Removed redundant post-sanitization checks in `convex/sampleRows.ts` after the input gate already proves duration, sample rate, and channel count are defined.
- Removed duplicate sample payload validation in the sample drop path because `parseSampleDragData` already validates the drag MIME payload before placement.
- Removed impossible optional track fallbacks in multi-drag placement after the target index is clamped to the valid track range.
- Kept API clip-selection and multi-drag clip lookup guards where removal would require non-null assertions or a broader proof helper.
- Kept mixer-channel schema guards because they are useful data-integrity checks at a persistence/migration boundary.

### Validation

- `bun run typecheck` and `bun run build` passed after the simplify cleanup.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after defensive cleanup and log updates.
- `bun run knip` still fails only on the already-known repo-level unused files/exports, unlisted `kysely` dependency reference, and duplicate audio-peaks export.

## 2026-05-13 — Final Branch-Wide Review Rerun

### Scope

- Re-ran the post-implementation cleanup sequence across all current `audio-engine-refactor` branch changes immediately before merge.
- Used `implementation-trackers/audio-refactor-branch-tracker.md`, `implementation-trackers/timeline-refactor-tracker.md`, and this changes log as history context so intended refactor structure and known `knip` blockers were not re-flagged.

### Simplify Review

- Removed duplicate typed sample payload validation from `src/hooks/useTimelineClipImport.ts`; inserted samples now rely on the shared `SampleDragData` contract and parser-owned validation.
- Removed the unnecessary paginated-track cast in `convex/mixerChannels.ts` so the backfill mutation uses Convex's inferred page item type directly.
- Resolved clip ownership concurrently in `convex/clips.ts` before the delete loop, preserving ordered skipped/removed semantics while avoiding serial ownership reads for multi-clip deletes.

### Defensive-Code Review

- Removed an impossible empty-items branch in API clip copy handling after the writable selection guard already proves the mapped payload list is non-empty.
- Kept API selected-clip fallback checks because TypeScript still cannot prove the success shape without extra assertion plumbing.
- Updated `implementation-trackers/timeline-refactor-tracker.md` to clarify initial-vs-current tracker wording and the accepted `knip` blocker state.

### Validation

- `bun run typecheck`, `bun run build`, and `git diff --check` passed after simplify cleanup.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after defensive cleanup and tracker/log updates.
- `bun run knip` remains expected to fail on the already-known repo-level unused files/exports, unlisted `kysely` dependency reference, and duplicate audio-peaks export.
