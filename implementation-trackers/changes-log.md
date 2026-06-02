# Skill Review Changes Log

Tracks review-driven follow-up work before merging the audio refactor branch.

## 2026-05-22 — Local-First Refactor PR Review Follow-Up

### Scope

- Re-reviewed PR #9 (`local-first-refactor` into `master`) across the local-first timeline, archive/export, sharing, Convex access, and UI action flows.
- Validated prior review findings before implementation and kept the broad caller-supplied Convex `userId` authorization issue as a separate architecture follow-up requiring verified Convex auth or authenticated API-only boundaries.
- Started the all-in-one completion pass for remaining local-first cloud/shared tracker work, with implementation planned as milestone commits inside this PR rather than separate PRs.
- Recorded the grilled plan corrections: restore primitives before conflict/offline download, durable shared outbox instead of ephemeral pending maps, durable R2 retry state, revoked-user local cache purge, and Worker/API-derived identity for touched sensitive flows.
- Added accepted collaborator revocation routes backed by service-token Convex mutations and a local cache purge path for explicit leave/access-loss handling.
- Added cloud-backup restore/duplicate actions, manifest-first lazy cloud asset reads, an explicit download-for-offline path with a 3-download concurrency limit, and conflict summary messaging with timestamps/counts.
- Added durable R2 deletion queueing for superseded backup assets, locally deleted cloud assets, deleted sample/export rows, and owner project-prefix cleanup.
- Added a durable shared outbox for failed/offline clip move/delete and track mix/routing/volume publishes, plus reconnect/manual retry and Project menu status.
- Moved sample/export delete metadata cleanup behind authenticated Hono routes with service-token Convex mutations and retained durable R2 cleanup draining.
- Added author-visible pending shared audio clips for import/recording while R2 upload and Convex clip publish complete before collaborators can see the clip.
- Added a remote timeline cache that persists shared Convex tracks/clips plus cloud asset references locally, uses the cache when live remote data is unavailable, and lets shared R2 assets lazy-cache through the existing offline download path.
- Routed selected shared timeline writes (clip move/delete and track mix/routing/volume), including durable outbox retries, through an authenticated Hono timeline-operation gateway backed by server-secret Convex mutations.
- Routed remaining shared timeline create/effect/recording-lock writes and shared full-view reads through authenticated Hono routes so touched shared browser paths no longer send caller-supplied `userId` directly to Convex.
- Added local-dev service-token binding fallback helpers for authenticated API routes and returned `404` for deleted/revoked backup metadata fetches instead of surfacing Convex access errors as `500`.
- Ran a Convex deployment/table inspection against the development deployment to confirm expected tables and indexes are present for the validation pass.

### Review Follow-Up

- Protected public timeline list queries for tracks, clips, and effects with project access checks and updated cloud/API callers to pass the current user context.
- Flushed queued local timeline writes before manifest export/backup so local archives and cloud backups include pending IndexedDB writes.
- Added missing local undo history for drag moves, duplicate actions, and option-drag duplicates.
- Relabeled the project menu's audio export action, disabled the cloud backup button for non-local projects, and disabled local-project sharing until the project is backed up to the cloud.
- Added project access checks to direct effect reads, then replaced scalable UI/export/agent summary fanout with a single protected `effects.listByRoom` read and client-side track/master effect derivation.
- Fixed project rename authorization so `projects.setName` can no longer create owner rows for arbitrary existing project IDs; project ownership creation remains isolated to the existing owned-room creation path.
- Added Convex-side editor/owner checks to export metadata creation and removal so direct Convex calls cannot bypass the authenticated export API route's project authorization.
- Restored local-project effect export parity by loading IndexedDB local effects into the same mixdown `fx` shape used by cloud project exports.
- Guarded async project-persisted-state hydration with a local revision check so pending IndexedDB loads cannot overwrite newer in-memory edits.
- Kept instrument effect panel state reactive across project switches by passing live accessors into the extracted instrument state helper instead of spreading Solid props into a frozen object.
- Added local `syncState` rows to project manifests and archive restore so current cloud/local ID mappings survive backup/export/import flows.
- Added a cloud-backup conflict preflight before R2 asset uploads while keeping the final Convex upsert conflict check authoritative.
- Kept collaborator owned-slice deletion scoped to that user's tracks/clips/ownership rows so it no longer deletes shared project-level rows.
- Guarded async local EQ/reverb IndexedDB loads against project/target switches before writing panel state.
- Fixed drag-created track rollback cleanup so failed local/cloud move persistence removes the newly created empty lane when the failed planned move targeted it.
- Removed the unused private cloud-backup restore helper until a real restore flow is implemented.
- Hid and closed cloud-only AI Chat for local projects until a local agent path exists.
- Guarded async local effects, sample inventory, and export metadata loads against local-project switches before publishing active UI/audio state.
- Kept cloud-backup conflict detection based on the local project's latest persisted update time instead of the backup creation timestamp.
- Protected per-user agent chat history with project access and owner-user checks.
- Hid and closed cloud-only Room Chat for local projects until shared/cloud chat exists.
- Prevented local sample deletion while clips still reference the asset.
- Rolled back local clip resize commits when IndexedDB persistence fails and kept resize history behind successful local persistence.
- Reopened unchecked cloud/shared browser validation items in the local-first tracker until artifact evidence is recorded.
- Kept cloud-backup conflict rows on separate server backup and manifest update timestamps so repeat unchanged backups do not false-conflict.
- Routed the local-save failure backup CTA to `.dawproject` archive export, kept archive export local-only in the project menu, and guarded the archive export handler from cloud project IDs.
- Rolled back partially created local duplicate-drag clips and cleaned up previews/drag-created lanes when IndexedDB clip creation fails.
- Allowed read-only collaborators to list/download existing project exports while keeping export creation/removal writer-only.
- Updated invite acceptance to patch existing project-level roles, kept local MIDI create/edit paths projected into the active timeline, captured recording finalization context at start, and reindexed local tracks after deletes.
- Flushed debounced local mixer writes on lifecycle cleanup, made local track middle inserts shift persisted indexes, parsed cloud backup manifests before project creation, rolled back partial local duplicate creates, and aligned tracker viewer/export wording.
- Made local multi-clip deletion atomic at the repository boundary and reopened the broad server-verified Convex auth tracker item as a deferred architecture follow-up.
- Flushed pending MIDI saves on editor cleanup, made cloud resize history wait for persistence, made local clip creation durable before success, rejected corrupt archive entries, and aligned remaining viewer export validation wording.
- Made local multi-clip drag moves atomic at the repository boundary so partial IndexedDB move failures cannot diverge durable clip positions from the rolled-back UI.
- Removed the unused cloud timeline repository surface, dropped its stale `knip` exemption, and kept timeline writes on the validated local repository plus existing Convex mutation paths.
- Tightened agent-action and cloud-backup response type boundaries so sample/effect command handling and backup upload/conflict parsing no longer depend on broad unvalidated response shapes.
- Simplify review removed duplicated clip-delete selection reconciliation, made manifest mode parsing avoid a misleading fallback, and shared undo effect-params history entry parsing between legacy and current readers.
- Defensive-code review found no high-confidence redundant guards to remove; persistence, network/API, auth, async-staleness, and UI optional-handler guards were kept because they protect real boundary ambiguity.
- Restricted cloud project ownership creation to the create-only owned-room path, routed backup/client project creation through it, and cleared imported archive `syncState` so restored local projects do not inherit stale cloud mappings.
- Made local multi-clip undo/redo move replay persist through the atomic repository `moveClips` path before committing visible clip positions.
- Required project-level ownership markers for Convex project roles, preserved legacy `roomId` when reading persisted history, hid the global share menu for local projects, cleared stale media-status rows after missing-media replacement, and requested writable local asset storage before deletion.
- Surfaced async local project-state save failures through the existing local-save failure banner for timeline preferences, local mix writes, and cloud-sync actions by sharing one `localProject` action object across Timeline persistence paths.
- Blocked local asset-directory switches when existing project audio cannot be read and copied from the previous storage root, avoiding a saved folder handle that strands referenced assets.
- Included `syncState.updatedAt` rows in local project manifest freshness so cloud backup `skipIfUnchanged` cannot skip uploads after local/cloud ID mappings change.
- Wired the share menu to create invite-token URLs and accept them before protected cloud project reads, while preserving existing owner roles if an owner opens an invite.
- Guarded missing-media replacement on successful durable clip updates and removed newly created replacement assets when the target clip is stale.
- Rolled back auto-created local import tracks when local asset persistence fails, keeping failed imports atomic instead of leaving empty durable lanes.
- Routed share invite creation/acceptance through authenticated API endpoints and protected the Convex invite mutations with a service token so direct Convex calls cannot impersonate another `userId`.
- Excluded cloud-backup bookkeeping sync rows from manifest freshness while retaining real local/cloud ID-map `syncState` updates.
- Kept auto-created local import/recording tracks and their clips in one replayable history entry, and cleaned up saved local assets if clip metadata persistence fails.
- Protected cloud-backup and full-project-delete Convex entrypoints with an API-only service token, surfaced Project-menu share URLs by copying them to the clipboard, and preserved `track-clip-create` undo entries across reload.
- Kept default/sample-library insertion local for local projects, rolled back auto-created cloud import tracks when upload/clip creation fails, and enabled sharing for backed-up local projects based on local project mode instead of only ID shape.
- Blocked backup-only local projects from issuing share invites until a real shared promotion flow exists, rolled back auto-created local sample tracks on clip persistence failure, made combined track+clip redo clean up recreated tracks on clip failure, and preserved IndexedDB history when edits happen before local history hydration finishes.
- Preserved stronger existing project roles when accepting lower-role invite links and gated automatic local cloud backup ticks to explicitly backed-up/shared local projects.
- Replayed cloud multi-clip undo/redo moves through one validated Convex batch mutation so partial move persistence cannot diverge durable timeline state from rolled-back history state.
- Flushed debounced local effect writes before manifest export/backup, cleaned up auto-created cloud sample tracks when clip creation throws, and normalized IndexedDB undo history through the shared persisted-history parser.
- Required project-level ownership for full-project read access, kept cleanup-triggered local effect flushes registered until writes settle, and guarded async local instrument effect loads against project switches.
- Guarded local audio import projection/history and missing-media replacement UI/cache side effects against project switches after async local writes settle.
- Extended stale-project projection guards to local sample insertion, cloud audio import/recording, and serialized local history saves so older IndexedDB writes cannot overwrite newer undo stacks.
- Guarded local recording projection/history against project switches and preserved dirty effect drafts when local IndexedDB effect persistence fails so manifest/cleanup flushers surface the failure.
- Captured project/user context for debounced effect writes and guarded auto-created local track projection so stale effect/import/recording writes cannot publish into the active project after a switch.
- Flushed pending local project-state writes before manifest export/backup and cleaned up auto-created local import tracks against their original project so project switches cannot leave stale durable lanes.
- Kept cloud-backup pre-upload manifest and asset-read failures inside the `BackupResult` contract so backup callers surface local flush/read failures instead of leaking rejected promises.
- Split the Worker entrypoint into route modules, scoped pending local effect/project-state flushes by project, extracted audio import transaction orchestration, and collapsed the undo switch's large track transaction branches behind entry-specific executors.

### Validation

- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the review fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after replacing per-track effect fanout with room-level effect derivation.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the validated authorization, local export effects, and async hydration fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the reactive effect context, manifest `syncState`, and backup preflight fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the collaborator cleanup, async local effect guard, drag rollback, and dead helper fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the local AI Chat gate, stale local async guards, and backup timestamp fix.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the agent history access, local Room Chat gate, sample delete guard, resize rollback, and tracker evidence fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the backup conflict timestamp split, archive CTA/gating fixes, and local duplicate-drag rollback cleanup.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the export viewer, invite role, local MIDI projection, recording context, and local track reindex fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the mixer flush, local track insert reindex, backup manifest parse ordering, local duplicate rollback, and tracker wording fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the atomic local multi-clip delete and Convex auth tracker status fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the MIDI cleanup flush, cloud resize rollback, durable local clip creation, archive CRC validation, and tracker wording fixes.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the atomic local multi-clip drag move fix.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, and `bun run knip` passed after the final simplify cleanup and defensive-code review pass.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the ownership, atomic undo replay, local project save failure, asset-directory switch, and manifest freshness fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the invite share, missing-media replacement, and failed-import rollback fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the authenticated invite boundary, backup freshness bookkeeping, and atomic import/recording history fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the cloud-project service-token boundary, Project-menu share URL, and persisted `track-clip-create` fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the local sample insertion, cloud import rollback, and backup-mode share fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the backup-only share gate, local sample rollback, combined redo cleanup, and local history hydration fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the invite role downgrade guard and explicit auto-backup mode gate.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the cloud multi-clip history replay batch mutation.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the local effect flush, cloud sample rollback, and IndexedDB history normalization fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the project-access marker, cleanup effect flush, and stale instrument effect load fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the stale local import and missing-media replacement side-effect guards.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after extending stale projection guards and serializing local history saves.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the local recording stale guard and local effect persistence failure preservation fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after capturing debounced effect write context and stale auto-track projection cleanup.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after project-state manifest flushing and original-project import track cleanup fixes.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after keeping cloud-backup manifest/asset preparation failures in the `BackupResult` path.
- `bun run typecheck`, `git diff --check`, `git diff --check origin/master`, `bun run knip`, and `bun run build` passed after the thermo-nuclear maintainability refactor.

## 2026-05-21 — Local-First Refactor Phase 16

### Scope

- Added `.dawproject` archive import/export using a zip package with `manifest.json` shared with the cloud backup manifest shape and project-owned assets stored under stable asset IDs.
- Routed archive imports through the shared manifest migration/assertion path and restored imported projects into local IndexedDB plus project-owned asset storage.

### PR Review Follow-Up

- Validated PR review findings against the real codebase and fixed the confirmed ownership, metadata access, local timeline hydration, storage-folder migration, archive integrity, archive rollback, and app-owned asset cleanup issues.
- Kept the fixes at the existing API/Convex access, local repository hydration, local asset, and archive boundaries instead of adding parallel validation flows.

### Validation

- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed.

## 2026-05-21 — Local-First Refactor Phases 14–15

### Scope

- Added cloud backup/share promotion scaffolding with versioned local project manifests, project-scoped R2 asset uploads, latest-manifest Convex persistence, local cloud ID mapping, manual backup, and automatic signed-in backup ticks.
- Added role/share/security work for cloud projects: owner/editor/viewer role model, authenticated invite primitives, role-aware access checks for protected R2 reads/writes, project-scoped export reads, and project deletion cleanup for R2 plus related Convex rows.

### Validation

- `bun run typecheck` passed.
- `bun run build` and `git diff --check` passed.

## 2026-05-21 — Local-First Refactor Phase 1–13 Review

### Scope

- Completed the local-first refactor through Phase 13, covering signed-out local project boot, IndexedDB/OPFS persistence, local audio import/recording/export, missing-media recovery actions, local project state ownership, local samples, undo/redo, and local/cloud boundary scaffolding.
- Updated `implementation-trackers/local-first-refactor-tracker.md` so phases 1–13 and their validation items are checked with runtime evidence.

### Review Follow-Up

- Simplify review extracted the repeated local timeline track-row to `Track` adapter into `src/lib/timeline-repository/track-row-adapter.ts` and reused it from track creation, import-created tracks, and drag-created tracks.
- Simplify review parallelized default-sample metadata cache/fallback loading in `src/hooks/useProjectSamples.ts`.
- Simplify review reused the previous assets directory handle once during project storage-folder moves in `src/lib/local-assets.ts`.
- Broader local/cloud repository routing and local-effect-state consolidation suggestions were left unchanged to avoid destabilizing the validated phase boundary.
- Defensive-code review found possible redundant non-null guards in recording/backend paths, but they were kept because TypeScript does not preserve those filtered invariants across the current persisted/auth boundaries without adding less-clear assertions.

### Validation

- `bun run typecheck` and `git diff --check` passed after simplify cleanup.
- `bun run typecheck` and `git diff --check` passed after the defensive-code review pass.
- `bun run typecheck`, `bun run build`, `git diff --check`, and `bun run knip` passed after the review cleanup and log updates.

## 2026-05-20 — Post-Trace Performance Follow-Up

### Scope

- Compared the new CDP trace, CPU profile, heap sampling profile, and heap snapshot captures against the earlier local playback captures.
- Confirmed the previous performance commits materially reduced baseline playback cost before making additional changes.
- Validated the remaining findings against the codebase before implementation and rejected speculative Convex subscription changes until a follow-up trace proves the root cause.

### Performance Fixes

- Removed duplicate cold-path `updateTrackGains` work from `AudioEngine.ensureAudio()` because playback scheduling already updates track gains with the current render tracks.
- Kept cached track-gain application as the default `ensureAudio()` behavior for non-playback audio gestures, while letting playback opt out because scheduling immediately applies current render tracks.
- Removed eager metronome node setup from `ensureAudio()` so metronome nodes are created only from the existing metronome-enabled and transport-start paths.
- Kept the master analyser lazy by reconnecting an existing analyser during master routing rebuilds without creating a new analyser unless spectrum data is requested.
- Reused stable empty draft and preview maps in `useTimelineResolvedModel`.
- Reused `resolvedTracks()` when there are no draft clip edits and reused `placementTracks()` when there are no preview clips, avoiding repeated full timeline resolution for the common idle/playback path.
- Passed the existing `Timeline` `trackLookup()` into `TimelineOverlays` instead of rebuilding a duplicate timeline track index inside the overlays layer.
- Replaced the EQ draw effect's `props.bands.map(...).join('|')` dependency signature with direct band-field reads and merged the duplicate spectrum redraw effect into the same draw effect.

### Profiling Follow-Up

- Captured a matching active-playback CDP profile by reloading the open app tab through Helium/CDP, clicking Play, profiling playback, clicking Stop, and taking heap artifacts.
- Confirmed `ensureAudio` dropped from the prior dominant CPU hotspot to roughly `1.3ms` in the matching active-playback capture.
- Added a fuller interactive capture workload that keeps playback running while dragging track 1 and track 2 volume sliders and sweeping EQ canvas bands.
- The interactive workload exposed EQ canvas response/draw work as the main remaining app CPU hotspot, with track-volume interactions visible but much smaller.

### Review Follow-Up

- Code review found that removing cached `updateTrackGains` from `ensureAudio()` could leave MIDI audition/live-note preview unrouted when the first audio gesture was not playback.
- Review validation confirmed the root cause was `updateTrackGains()` owning both pre-audio track caching and post-audio live mixer graph application.
- Added an `ensureAudio({ applyCachedTrackGains: false })` playback opt-out so non-playback callers still apply the cached mixer graph after `AudioContext` creation, while Play avoids the duplicate first-play graph update before scheduling.
- A follow-up code review returned LGTM for the full uncommitted performance diff.
- Simplify review found no scoped reuse, quality, or efficiency cleanup needed for the post-trace performance diff.
- Defensive-code review found no high-confidence redundant guards, duplicated validation, impossible branches, or stale log entries.

### Validation

- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the low-risk performance fixes.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the cached-track-gains review fix.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the post-implementation simplify and defensive-code reviews plus log update.
- Matching active-playback artifacts were written to `/Users/juan/Downloads/daw-cdp-capture-2026-05-20T14-44-42-613Z`.
- Interactive playback/volume/EQ artifacts were written to `/Users/juan/Downloads/daw-cdp-capture-2026-05-20T15-13-25-929Z`.

## 2026-05-19 — Scale Performance Follow-Up

### Scope

- Implemented the validated scale findings from the follow-up trace/heap review across audio metering, runtime disposal, MIDI scheduling, EQ updates, spectrum sampling, and drag/projection churn.

### Performance Fixes

- Reduced track meter worklet message frequency and stopped creating analyser/splitter spectrum nodes for every track unless spectrum data is requested.
- Batched meter publications per animation frame and only keeps live meter nodes for audible routed tracks.
- Changed sidebar meters to fine-grained Solid store updates so one track meter tick does not clone and republish the full meter object.
- Centralized track audio runtime disposal and expanded `AudioEngine.close()` cleanup for mixer, effects, synth, meter, spectrum, master, and pending-param state.
- Removed per-note MIDI cleanup timers; synth-note cleanup now follows oscillator end events and disconnects note gain nodes once oscillators finish.
- Avoided creating a duplicate synth oscillator when both configured waves are identical, including offline export.
- Cached arpeggiator expansion per MIDI notes array and arp signature to avoid recomputing generated notes during repeated scheduling.
- Added a cached playback scheduling index that skips clips outside the active playback window before touching per-track audio nodes.
- Updated track/master EQ changes in place when the enabled-band topology is unchanged, avoiding graph rebuilds for pure parameter changes.
- Reused spectrum output buffers for track and master spectrum reads.
- Cached drag-session track lookups, skipped duplicate drag draft move publications, and avoided cloning projection draft maps when incoming move data is unchanged.
- Replaced recording-preview front-array shifting with a bounded ring-style start index and periodic compaction.
- Removed array/map allocation from EQ parameter serialization.

### Review Follow-Up

- Code review found the timerless MIDI cleanup path still needed live oscillator stops so `onended` cleanup can run; scheduled live synth oscillators to stop at the envelope end time, matching offline export.
- Code review found drag draft no-op suppression could keep a stale move key after invalid placement cleared draft moves; reset the cached move key whenever active drag draft moves are cleared.
- Simplify review found no scoped reuse cleanup needed.
- Simplify review aligned sidebar meter store state with the audio-engine `{ left, right }` level shape instead of reshaping it to local `L/R` fields.
- A later simplify review reused the exported audio-engine `TrackStereoLevels` type in `TrackSidebar` and zeroed disposed meter tracks so routed-away tracks cannot keep stale visible meter levels.
- Post-review simplify removed the stale stereo-analyser fallback path after worklet-batched metering became the only consumer path.
- Post-review simplify replaced drag draft move string keys with structural move comparison and capped per-note-array arpeggiator cache entries.
- Simplify review reset the recording preview ring start index consistently across delegated cleanup and halt paths.
- Simplify review replaced MIDI note cleanup membership scans with a per-note remaining-oscillator counter and changed playback scheduling lookup to jump past clips ending before the playhead.
- Defensive-code review removed redundant EQ topology, sidebar meter, and recording-context guards already proven by their callers/write paths.
- A final defensive-code review removed redundant arpeggiator cache key, ensured-track-node, and recording preview reset guards already proven by local map/caller invariants.
- Defensive-code review found no duplicate, stale, conflicting, or overly verbose log entries in the scale follow-up.

### Validation

- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the scale performance follow-up.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the code-review follow-up fixes.
- `bun run typecheck` and `git diff --check` passed after simplify cleanup before defensive-code-review.

## 2026-05-19 — Audio Performance Trace Follow-Up

### Scope

- Re-reviewed Chrome heap timeline, heap profile, and heap snapshot captures from local playback after earlier live-routing changes.
- Re-reviewed the follow-up heap/profile/trace captures after the first performance pass to confirm the impulse/reverb allocation stacks were gone and isolate the remaining lag/audio-glitch sources.
- Confirmed the strongest initial lag sources were repeated reverb impulse allocation, unchanged reverb reapplication, track-meter hot-path allocation, and smaller spectrum/timeline churn.
- Confirmed the remaining follow-up hotspots were non-idempotent EQ graph mutation, volume-drag mixer fanout, playback playhead UI publication on every RAF, sidebar meter sampling, and effects-panel spectrum sampling.

### Performance Fixes

- Kept the existing live mixer routing signature work in `src/lib/mixer/apply-live-routing.ts` so unchanged routing no longer disconnects/reconnects track graph nodes or meters every update.
- Added pre-allocation impulse metadata in `src/lib/effects/dsp.ts` so `src/lib/audio-engine.ts` can check the impulse cache before creating an expensive `AudioBuffer`.
- Added a shared `serializeReverbParams` helper in `src/lib/effects/params.ts` and engine-owned track/master reverb signatures so unchanged reverb params do not rebuild convolver chains or track/master routing.
- Updated `src/lib/effects/chain.ts` so disabled reverb updates adjust gains and delay state without generating an unused impulse response.
- Changed stereo meter reads from tuple allocation to a reusable `{ left, right }` result object owned by the audio engine, updated `TrackSidebar` to consume the new shape, and wired `Timeline` through the meter subscription path.
- Added `serializeEqParams` and engine-owned track/master EQ signatures so unchanged EQ params do not rebuild or reconnect biquad graph nodes.
- Added direct audio-engine track-volume preview during sidebar slider drags, with mixer/history updates committed only at pointer release.
- Replaced the sidebar meter RAF loop with audio-engine-owned AudioWorklet push metering and a `subscribeTrackStereoLevels` callback path.
- Removed the continuous effects-panel spectrum RAF loop; spectrum now samples on demand when the panel is open and its audio target changes.
- Added the throttled transport playhead as an effects-panel spectrum resample trigger so panels opened before analyser data exists can populate once playback advances.
- Throttled Solid playhead UI state publication to about 30Hz while preserving the RAF transport clock and per-frame loop checks.
- Flush the current transport playhead on pause so the throttled UI state remains authoritative for resume scheduling.

### Review Follow-Up

- Plan validation confirmed the root-level fix belongs in the DSP/audio-engine hot paths rather than hook-local guards.
- Simplify review reused the new RMS and companding helpers from mono meter sampling and removed duplicate impulse cache-key construction.
- Efficiency review found no additional scoped hot-path cleanup needed.
- Defensive-code review removed the unreachable stereo analyser null guard after verifying the typed construction path is the only `stereoAnalysers` insertion path.
- Review validation confirmed EQ graph churn, volume-drag fanout, playback UI pressure, meter sampling, and spectrum sampling were supported by the trace; the EQ-to-clipping link remains a mitigation hypothesis pending runtime confirmation.
- Simplify review disabled AudioWorklet meter processing while no sidebar meter subscribers are registered; broader worklet string-module extraction was left unchanged to keep the follow-up focused.
- Defensive-code review removed redundant pending-effect signature checks, made required sidebar meter/volume-preview callbacks non-optional, removed the redundant live-routing send-gain cleanup callback, simplified meter subscription cleanup, and corrected the meter-shape log wording.
- A later simplify loop added pointer-cancel capture release for sidebar volume drags, then reuse, quality, and efficiency reviews returned LGTM for that pass.
- A later defensive-code-review loop returned LGTM for audio, UI/hooks, and changes-log accuracy.
- Code review found a real pause/resume edge case from throttled playhead publication; plan validation confirmed the root fix belongs in the playback hook's shared transport-position computation.
- Follow-up code review found the on-demand spectrum sampler can stay `null` when the effects panel opens before analyser data exists; review validation confirmed the root fix should reuse the existing throttled `playheadSec` transport signal as the open-panel resample trigger instead of restoring a dedicated spectrum RAF loop.
- Post-review simplify extracted the AudioWorklet processor name into a shared constant; broader lazy worklet allocation and meter update batching suggestions were left unchanged to avoid expanding the focused follow-up.
- Post-review defensive-code-review removed a redundant non-empty RMS length fallback and reworded earlier "final" review-loop log entries now superseded by later follow-ups.
- Follow-up simplify reused the shared EQ/reverb serializers in the effects panel and decoupled the sidebar's meter prop shape from the audio-engine type export.
- Follow-up defensive-code-review removed unreachable live-routing fallbacks now proven redundant by resolved mixer graph normalization and track-node construction.
- A later simplify rerun replaced the meter AudioWorklet boolean control message with a small object payload and shared sidebar pointer-capture release logic between volume drag completion and cancellation.
- A later defensive-code-review rerun found no additional high-confidence redundant guards or impossible branches in audio internals, UI/hooks, or the changes log.

### Validation

- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the performance fixes.
- `bun run typecheck` and `git diff --check` passed after simplify cleanup.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after defensive-code-review cleanup, log update, and final diff review.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the EQ idempotence, volume preview, AudioWorklet metering, and on-demand spectrum fixes.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the playhead UI throttling follow-up.
- `bun run typecheck` and `git diff --check` passed after the first simplify cleanup.
- `bun run typecheck` and `git diff --check` passed after the simplify rerun cleanup.
- `bun run typecheck` passed after defensive-code-review cleanup before the final validation pass.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the post-implementation review rerun, log update, and final diff review.
- `bun run typecheck` and `git diff --check` passed after the final simplify pointer-cancel cleanup.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the pause playhead flush fix.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after wiring the playhead-driven spectrum resample trigger.
- `bun run typecheck` and `git diff --check` passed after post-review simplify cleanup.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the follow-up cleanup review rerun.
- `bun run typecheck` and `git diff --check` passed after the latest simplify rerun before defensive-code-review.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the latest post-implementation review log update and final diff review.

## 2026-05-18 — Tracks Menu Relocation

### Scope

- Created the `move-track-controls-menu` branch from `master`.
- Moved the track creation and mix-sync controls from the top row of `src/components/timeline/TrackSidebar.tsx` into a new `Tracks` menu in `src/components/timeline/TransportControls.tsx`.

### Menu and Shortcut Changes

- Added a top-level `Tracks` menu immediately to the left of `Share`.
- Moved `Sync Mix`, `Add Track`, `Return`, `Group`, and `Instrument` into the new menu.
- Kept `Sync Mix` visually stateful in the menu when enabled.
- Replaced temporary descriptive menu subtext with actual shortcut labels where keybinds exist.
- Added `Shift + R` for adding return tracks and `Shift + G` for adding group tracks through `src/hooks/useTimelineKeyboard.ts`.
- Surfaced `Shift + T`, `Shift + R`, `Shift + G`, and `Ctrl/Cmd + Shift + T` in the `Tracks` menu and the existing `Settings > Shortcuts` list.
- Removed the track-sidebar header buttons while preserving the sticky ruler-height spacer so sidebar rows remain aligned with the timeline ruler.
- Removed the visible `Loop` and `Grid` labels from the center transport controls, leaving icon-sized buttons with the existing accessibility labels and active-state color.

### Review Follow-Up

- Simplify review found duplicated track-creation handlers between keyboard shortcuts and the `Tracks` menu; consolidated them into shared local handlers in `src/components/Timeline.tsx`.
- A follow-up simplify review found the `Tracks` menu props were being passed as separate transport props; grouped them into a single `tracksMenu` prop in `src/components/timeline/TransportControls.tsx`.
- Simplify review found no scoped efficiency cleanup needed.
- Defensive-code review found no high-confidence redundant guards, duplicated validation, or impossible-state branches in the tracks menu follow-up.

### Validation

- `bun run typecheck` and `bun run build` passed after moving the controls into the `Tracks` menu.
- `bun run typecheck` and `bun run build` passed after adding return/group shortcuts and updating shortcut labels.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after simplify cleanup and defensive-code-review.
- `bun run typecheck` and `bun run build` passed after removing the center transport `Loop` and `Grid` button labels.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the follow-up `tracksMenu` prop grouping.

## 2026-05-18 — Center Transport Controls Redesign

### Scope

- Created the `play-controls` branch from `master`.
- Redesigned the center toolbar transport controls in `src/components/timeline/TransportControls.tsx` to better match Ableton-style play, stop, and record controls while keeping the surrounding toolbar structure intact.

### Toolbar Changes

- Replaced separate play and pause buttons with a single play/pause toggle so the play button becomes pause while playback is active.
- Simplified record, play/pause, and stop into icon-only controls with matching dimensions and spacing.
- Kept record as the same current-color glyph as the other transport icons when inactive, reserving red styling for the active recording state.
- Aligned the metronome, loop, grid, and grid-resolution controls with the center transport button sizing and removed extra icon margin offsets that made icons appear off-center.
- Matched center-toolbar button hover colors and height to the left native menu trigger styling, using the same neutral hover background/text treatment instead of the bright default ghost-button hover.

### Review Follow-Up

- Simplify review reused the native menu trigger class for center text-style controls so hover color, height, padding, and typography stay tied to the left toolbar menus.
- Simplify review found no scoped efficiency cleanup needed; the button-size conflict concern was rejected because the shared `cn` helper uses `tailwind-merge` to resolve conflicting Tailwind utilities.
- Defensive-code review found no high-confidence redundant guards, duplicated validation, or impossible-state branches in the transport control follow-up.

### Validation

- `bun run typecheck`, `bun run build`, and `git diff --check` passed after the transport control redesign.
- `bun run typecheck` and `git diff --check` passed after follow-up sizing, centering, record-state, and hover-color adjustments.
- `bun run typecheck` and `git diff --check` passed after simplify cleanup and defensive-code-review.

## 2026-05-18 — Dead Code and Knip Cleanup

### Scope

- Created the `cleanup-one` branch from `master` after the native toolbar redesign PR landed.
- Ran `bun run knip` to identify unused files, unused exports/types, unlisted dependencies, and duplicate exports.
- Verified findings with source searches before editing.
- Preserved planned future-use UI files, including `nav-user` and unused shared UI primitives, instead of deleting them.

### Cleanup

- Added `kysely@0.28.11` as a direct dependency because `api/auth.ts` imports `Kysely` directly and Better Auth's Kysely adapter expects the `0.28.x` export surface.
- Replaced the duplicate `primeWaveformAsset` alias with direct `ensurePeakAsset` usage in `clip-source-client`.
- Converted unused exported helpers, constants, and types to file-local declarations where they only had internal consumers.
- Removed unused Convex mutation/action/prefetch/invalidate/batch helper exports from `src/lib/convex.ts`.
- Removed unused Menubar group/radio-group exports.
- Removed the unused `buttonVariants` export while keeping `ButtonProps` for the preserved future-use sidebar UI.
- Updated `knip.json` so Knip ignores planned future-use UI files and UI-only export/type reports under `src/components/ui`.

### Validation

- `bun run knip` passed after cleanup and intentional UI ignores.
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after cleanup.

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
- Tightened the toolbar row padding from `px-3 py-2` to `px-2 py-1` so the native menu bar uses a more compact top, bottom, and side inset.

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
- `bun run typecheck`, `bun run build`, and `git diff --check` passed after tightening the native toolbar row padding and updating this log.

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
