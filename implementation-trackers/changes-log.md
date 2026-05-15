# Skill Review Changes Log

Tracks review-driven follow-up work before merging the audio refactor branch.

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

### Simplify Review

- Memoized sidebar group and return track lists so each track row reuses derived routing target arrays instead of filtering all tracks per row.
- Removed now-unused routing callback props from `EffectsPanel`, `TimelinePanels`, and the effects-panel callsite in `Timeline`.
- Grouped the shared timeline and track-sidebar hidden-scrollbar CSS selectors to avoid duplicate scrollbar declarations.
- Removed the now-unused routing-specific return fields from `useEffectsPanelTarget` after the final simplify rerun; the rerun then returned LGTM.
- Quantized custom slider drag values to the existing `0.01` step and skipped duplicate volume emissions during pointer drags to reduce hot-path mixer/history churn.
- Avoided no-op meter state updates and stopped the meter RAF loop when playback is stopped because stopped meters are not rendered.
- Reused a local `displayTrackName` helper for both row labels and send options, and aligned the label wrapper with the centered track-name button.
- The final simplify rerun returned LGTM for reuse, quality, and in-scope efficiency.

### Defensive-Code Review

- Removed redundant role guards from sidebar routing change handlers after verifying the handlers are only wired from role-gated selects.
- Removed the redundant stereo-level tuple shape check in `TrackSidebar` because the callback type already guarantees `[number, number]` when present.
- Removed the redundant sidebar resize `maxWidth` lower clamp because the final width clamp already enforces the minimum width.
- Tightened the effects-panel target type to `Track["id"] | "master"` and removed the now-redundant empty-target fallback in `useEffectsPanelTarget`.
- Removed the optional fallback around the required sidebar mono meter callback.
- Kept permission and optional-callback guards because they protect writable-track and optional integration boundaries.
- A defensive-code-review rerun found no additional high-confidence redundant guards in the return-label naming or track-name UI state changes.
- The final defensive-code-review rerun returned LGTM with no additional high-confidence redundant guards or impossible branches.

### Validation

- `bun run typecheck`, `git diff --check`, and `bun run build` passed after simplify cleanup.
- `bun run typecheck`, `git diff --check`, and `bun run build` passed after defensive cleanup and log updates.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the sidebar volume slider restoration, styling, and drag-interaction fixes.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the final simplify and defensive-code-review follow-up cleanup.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the final repeated review loop where both simplify and defensive-code-review returned LGTM.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the return-label and track-name border follow-up.
- `bun run typecheck` and `git diff --check` passed after the selected-row meter contrast follow-up.

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
