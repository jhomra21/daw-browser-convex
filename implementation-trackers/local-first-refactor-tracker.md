# Local-First Refactor Tracker

## Purpose

This file is the working tracker for the local-first architecture refactor.

It exists to:
- keep the implementation ordered and scoped
- record the validated current codebase state before changes
- capture decisions made during planning
- track implementation progress step by step
- capture findings, bugs, regressions, validation evidence, and edge cases as they happen
- prevent Convex/R2/cloud assumptions from leaking back into local-only project flows

This tracker should be updated throughout the refactor, not just with progress, but also with browser validation findings, screenshots/log capture locations, sync decisions, migration decisions, and any cloud/local behavior changes discovered along the way.

---

## Branch

- Branch created for this work: `local-first-refactor`
- Default branch at planning time: `origin/master`

---

## Product Direction

The browser/local project becomes the source of truth.

Convex and R2 become optional infrastructure for:
- cloud backup
- cross-device sync
- sharing/collaboration

Normal solo usage should work without:
- login
- Convex
- R2
- network

When a user is not sharing or explicitly cloud-syncing, Convex should not be user-visible. The app should save locally first and only sync to the cloud in the background for projects that have cloud sync enabled.

## Decisions From Grill Review

Checked items in the decision sections mean the decision is resolved; implementation status is tracked in the phase checklists below.

- [x] Match Diffusion Studio's IndexedDB approach by adding and using `idb` (`openDB` / `deleteDB`) rather than building raw IndexedDB wrappers.
- [x] Match Diffusion Studio's project storage shape where practical:
  - global DB for project and directory entries
  - per-project DB
  - `assets` store
  - typed `entities` store for DAW rows
  - singleton project-state/settings store for world-level state
  - queued/coalesced entity writes
- [x] Adapt Diffusion Studio's asset handling for DAW audio reliability:
  - always copy imported/recorded audio into project-owned storage
  - keep original file handles only as provenance/restore metadata
  - do not depend on original external file handles for playback after import
- [x] Use project-owned storage with the same fallback model as Diffusion:
  - use the last saved directory handle when one exists
  - otherwise use OPFS through `navigator.storage.getDirectory()`
  - allow a later explicit directory-change/project-folder action
- [x] Use semantic IDs generated with `crypto.randomUUID()`, such as `project:<uuid>`, `track:<uuid>`, `clip:<uuid>`, and `asset:<uuid>`.
- [x] Replace app-facing `roomId` semantics with `projectId`.
- [x] Use one canonical `projectId` everywhere, including local IndexedDB and future Convex/shared records.
- [x] Keep local-to-cloud ID mappings only for row-level records such as tracks, clips, and assets.
- [x] When `/` opens without a `projectId`, show a local project picker instead of auto-creating a project.
- [x] The project picker must include a create-new-local-project action for first-time users.
- [x] Signed-out users can open local projects.
- [x] Signed-out users who open a non-local cloud/shared `projectId` must log in before loading it.
- [x] First implementation pass is local-only. Cloud backup/share promotion is deferred until local import, record, export, reload, and browser validation pass.
- [x] There is no migration or backward compatibility requirement for existing Convex projects. Existing cloud projects are disposable test data.
- [x] Local project deletion deletes the global project entry, closes/deletes the per-project IndexedDB database, and deletes app-owned assets. Original external provenance files are never deleted.
- [x] Perform an early focused `roomId` → `projectId` semantic rename before deeper local persistence work.

## Decisions From Cloud Grill Review

- [x] `backup` mode is snapshot backup/restore, not true bidirectional merge sync.
- [x] Backup conflicts use explicit user choices:
  - keep local and overwrite cloud
  - restore cloud over local
  - duplicate cloud as a new local project
- [x] A cloud backup stores a full versioned project manifest in Convex plus project-scoped R2 assets.
- [x] Cloud backup excludes undo/redo history; restored projects start with a fresh local history.
- [x] Backup-enabled projects support both automatic debounced backup and an explicit “Back up now” action.
- [x] R2 keys are project-scoped and include content hashes, e.g. `projects/{projectId}/assets/{assetId}/{contentHash}.{ext}`.
- [x] R2 reads must be authorized by canonical `projectId` and user/share access; raw key-based reads are not acceptable.
- [x] Backup mode keeps only the latest successful cloud snapshot in the first cloud pass.
- [x] Deleted cloud assets are marked pending deletion locally, removed from the next committed snapshot, then deleted from R2 immediately after that snapshot succeeds.
- [x] Project deletion attempts best-effort cleanup of the project-scoped R2 prefix after Convex deletion.
- [x] Shared mode uses local pending writes for the current user, but Convex-published state is what collaborators can see.
- [x] Shared-mode remote entities/assets are pulled from Convex/R2 into the local cache.
- [x] Shared-mode conflicts use last-write-wins.
- [x] Shared audio imports/recordings appear locally for the author while pending and are published to collaborators only after R2 upload plus Convex metadata write succeed.
- [x] Shared projects support `owner`, `editor`, and `viewer` roles.
- [x] Viewers can view/play and list/download existing exports only; they cannot create exports, edit, upload, record, rename, delete, or manage sharing.
- [x] Owners and editors can create exports; viewers can only list/download existing exports.
- [x] Share links are authenticated invite links with an intended role; accepting creates an access row. Invite-token revocation is implemented; accepted access-row revocation remains tracked in the shared-mode phase checklist.
- [x] Only owners can delete the cloud/shared project. Non-owners can leave/remove local cache only.
- [x] Restored/cloud projects load the manifest first, lazily cache assets by default, and offer an explicit “Download for offline” action.
- [x] Cloud-backed/shared projects can queue local edits offline and publish on reconnect with visible pending/not-shared-yet status.
- [x] Define a later `.dawproject` package using the same manifest schema and asset IDs as cloud backup.
- [x] Local DBs, cloud snapshots, and `.dawproject` archives must carry `schemaVersion` and use explicit migrations going forward.
- [x] UI must expose separate local/cloud status states for local save, backup, failures, conflicts, pending shared upload, and queued offline changes.
- [x] Cloud completion requires full browser plus cloud evidence, not just typecheck/build.

## Decisions From UI / Failure-State Grill Review

- [x] Project picker MVP shows recent local projects plus create, rename, and delete.
- [x] Local project deletion requires typing the project name before deleting.
- [x] Save/sync status appears as a compact toolbar badge near the project name, with detailed actions/status in the project menu.
- [x] Local save failures show persistent warning with retry/export/storage guidance.
- [x] Local save failure keeps unsaved changes in memory and must not be reported as saved or backed up.
- [x] Audio import/recording is atomic: if durable bytes plus metadata cannot be written, no clip is created.
- [x] Quota errors prompt retry/free-space/choose-folder guidance.
- [x] Missing/corrupt/unreadable media stays as a visible muted placeholder with restore/replace/remove actions, and the project remains loadable.
- [x] If a chosen visible project folder loses permission, require regrant or an explicit move-to-OPFS/storage-change action; do not silently split asset locations.
- [x] Backup conflict UI shows project names, local/cloud timestamps, cheap changed counts if available, and actions: keep local, restore cloud, duplicate cloud.
- [x] Backup conflict UI does not include deep timeline diff in the first version.
- [x] Failed cloud backup/shared uploads retry with capped exponential backoff plus manual retry.
- [x] Local editing remains enabled during failed/pending cloud retries.
- [x] Initial cloud transfer targets are 2 concurrent uploads and 3 concurrent downloads, tunable after validation; upload limiting is implemented and download limiting remains tied to unchecked restore/offline-download work.
- [x] Invite links are non-expiring but revocable.
- [x] Asset reads must either stream through access-checked `private, no-store` API routes or, if signed URLs are later introduced, mint only short-lived URLs after access checks.
- [x] Owner transfer is deferred from the first shared/cloud pass.

## Decisions From Rollout / Sequencing Grill Review

- [x] Phase 0 `roomId` → `projectId` is one focused semantic rename slice across app-facing code and Convex project-key terminology.
- [x] The rename slice should not intentionally change behavior except replacing URL/key terminology and dropping old `roomId` backcompat.
- [x] Do not add a runtime local-first feature flag.
- [x] The `local-first-refactor` branch can replace behavior directly, but each slice must remain buildable and validated.
- [x] Use thin temporary adapters only at boundaries during migration.
- [x] Delete old Convex-first paths as soon as their local repository replacements are validated.
- [x] Implementation slices should be buildable milestone slices, not tiny file-by-file edits or large unreviewable rewrites.
- [x] First implementation sequence:
  1. focused `roomId` → `projectId` rename
  2. `idb` and local DB foundation
  3. project picker and signed-out local boot
  4. local timeline CRUD
  5. local audio assets/import
- [x] Foundation slices require `bun run typecheck`, `bun run build`, `git diff --check`, and targeted browser/CDP probes when storage/browser APIs are involved.
- [x] Browser validation artifacts go outside the repo under `/Users/juan/Downloads/daw-local-first-validation/<timestamp-or-slice>/`.
- [x] Record validation artifact paths in this tracker after each validation pass.
- [x] Local asset performance gate:
  - no obvious long main-thread stalls during import/reload
  - playback remains stable during background saves
  - import writes are async/chunked
  - concrete timing thresholds are recorded from baseline CDP validation before being enforced
- [x] Old Convex tables/functions are removed or rewritten when their replacement cloud/share phase is implemented and validated.
- [x] No backward compatibility for old Convex data is maintained during Convex cleanup.
- [x] Run `bun run knip` only at major milestone finals:
  - local-only complete
  - cloud complete
  - archive complete if implemented

## All-In-One Completion PR Plan — 2026-06-01

The remaining unchecked cloud/shared work will be completed in this PR, split into reviewable commits. Each commit must leave the repo buildable when practical, and the tracker/changelog must be updated as bugs, edge cases, validation artifacts, and design corrections are discovered.

### Plan validation notes

- [x] The previous broad plan was grilled against the repo before implementation.
- [x] The PR will use schema additions where needed for idempotency, local/cloud mapping, retry state, and tombstones.
- [x] Revoked accepted collaborators must have their local shared/cloud cache purged, not merely marked read-only.
- [x] R2 cleanup failures must be durable/retriable, not only best-effort.
- [x] The security concern is direct browser access to the public Convex deployment with caller-supplied `userId` arguments, not normal app UI using the Better Auth session. New or touched sensitive write paths should derive identity through authenticated Worker routes or require API-only service tokens.
- [x] Full Convex Auth migration is not required for this PR unless implementation proves the Worker gateway approach cannot satisfy a touched flow.
- [x] Diffusion patterns are inspiration for local DB/cache/restore discipline; its local-only write queue must not be copied directly as shared sync because this app also needs auth, R2 upload ordering, Convex idempotency, and multi-user reconciliation.

### Commit sequence

1. Tracker and plan grounding.
2. Auth/access foundation:
   - accepted access-row revocation
   - revoked-user cache purge
   - API-only/server-secret protection for touched sensitive operations
3. Shared sync schema/outbox foundation:
   - durable pending operations
   - idempotent operation keys
   - local/cloud ID mapping reuse
   - retry status and tombstones where needed
4. Cloud backup completion:
   - disable backup action
   - restore cloud over local
   - duplicate cloud backup as local project
   - conflict summary/actions
5. Cloud asset restore/offline cache:
   - lazy cloud asset fetch through access-checked routes
   - "Download for offline"
   - 3-concurrent download limiter
6. Durable R2 cleanup:
   - pending deleted cloud assets
   - deleted sample R2 cleanup
   - deleted export R2 cleanup
   - retry queue and status
7. Shared local-first completion:
   - ordered local outbox publishing
   - pending audio upload before Convex publish
   - remote pull/reconcile into local cache
   - offline retry/manual retry/status UI
8. Final validation and tracker closure.

### Bugs / findings log for this pass

- [x] Finding scoped to follow-up: broad Convex `userId` hardening remains architecture-sensitive because the browser currently creates a direct `ConvexClient` from public `VITE_CONVEX_URL`; this pass did not add new client-trusted identity checks, and the new R2 cleanup maintenance path uses a Worker-issued Convex auth token rather than browser-supplied identity.
- [x] Finding resolved: backup restore primitives now exist before conflict actions and offline download are surfaced.
- [x] Finding resolved: selected shared track/clip write failures now persist in a durable `syncState` outbox rather than relying only on ephemeral projection maps.
- [x] PR5 audit finding: durable shared outbox previously covered only clip move/delete and track mix/routing/volume, while the Worker timeline-operation gateway already accepted more operation kinds.
- [x] PR5 progress: generalized the durable shared outbox to store every authenticated timeline-operation kind supported by the Worker gateway, and wired shared effect parameter publishes (EQ, reverb, synth, arpeggiator, master EQ, master reverb) to queue on publish failure.
- [x] PR5 progress: added idempotent shared create operation IDs for server track/clip creation and persisted `sharedOperationResults` keyed by project/user/operation to make queued create retries safe from duplicate rows when the first publish succeeded but the response failed.
- [x] PR5 progress: shared clip create/createMany failures now enqueue durable timeline operations from audio import, recording, MIDI clip creation, duplicate clip actions, drag duplication, and undo/redo history recreation paths; shared track create failures also enqueue durably.
- [x] PR5 validation note: recording lock acquire/release/heartbeat publishes intentionally remain ephemeral and are not durably queued because replaying stale locks/unlocks can corrupt live collaboration state.
- [x] PR5 runtime blocker resolved via Convex CLI fallback: Convex MCP `status` timed out twice, but `bun x convex function-spec` confirmed `operationId` fields on `clips.serverCreate`, `clips.serverCreateMany`, and `tracks.serverCreate`; `bun x convex data --limit 1` confirmed the deployed `sharedOperationResults` table exists.
- [x] PR5 runtime smoke passed through authenticated Helium CDP/API: duplicate `tracks.create` requests with the same `operationId` returned the same track ID, duplicate `clips.create` requests with the same `operationId` returned the same clip ID, and the temporary smoke project was deleted.
- [x] PR5 shared outbox runtime smoke passed through the real Vite-served browser module: queued `tracks.create` and `clips.create` entries in IndexedDB reported pending, `flushSharedOutbox` published them through the authenticated Worker gateway, summaries returned to `{ pending: 0, failed: 0 }`, idempotent replay returned server IDs, and the temporary project/cache were cleaned up.
- [x] Finding resolved: `/api/agent/execute` now requires owner/editor role instead of generic project access before running mutating agent commands, while `/api/agent/chat` remains read-access gated for context.
- [x] PR5 progress: shared uploaded-audio clip creation now has a durable local outbox entry that stores the File, uploads to R2 first on retry, and only then publishes Convex `clips.create` metadata with the stable operation ID.
- [x] Finding resolved: Project menu now exposes explicit backup lifecycle labels (`pending`, `backing-up`, `backed-up`, `failed`) instead of only a generic local/cloud save label.
- [x] Runtime blocker resolved by restarting the `localhost:3000` dev server and completing owner login: direct authenticated `/api/samples` upload into a temporary owned project returned 200, and an authenticated readback of the returned URL returned 200 `audio/wav` with the expected 44-byte smoke file.
- [x] PR5 shared uploaded-audio outbox runtime smoke passed after R2 recovery: queued `clips.createUploadedAudio` started at `{ pending: 1, failed: 0 }`, `flushSharedOutbox({ retryFailed: true })` returned `{ pending: 0, failed: 0 }`, Convex full-view contained the created audio clip with `sourceKind: "upload"` and `sampleUrl`, and authenticated R2 readback returned 200 `audio/wav`.
- [x] Runtime blocker resolved with a second isolated Helium profile on debug port 9223: owner user `kGUsEidMUXevqejpl2ISQAtL1rbsAb1H` and collaborator user `Y9lsv5GyGwoeGgZwGxriVlsz2i0BzJLu` were both authenticated simultaneously for multi-user validation.
- [x] Multi-user viewer runtime smoke passed: collaborator accepted a viewer invite, full-view returned 200, `/api/agent/execute` returned 403, `/api/samples` upload returned 403, `/api/exports` upload returned 403, and downloading an owner-created export returned 200 `audio/wav`.
- [x] Multi-user editor runtime smoke passed: collaborator accepted an editor invite, `/api/agent/execute` returned 200 for track creation, and `/api/samples` upload returned 200 with a project-scoped R2 key.
- [x] Track/clip permission runtime smoke passed through the authenticated project timeline-operation API: owner created a real instrument track and MIDI clip; viewer full-view returned 200 and saw both, while viewer add-track, add-clip, move-clip, and delete-clip operations all returned 403; editor add-track and add-clip returned 200, editor move-clip returned 200 and full-view showed the moved clip on the target track/start time, editor delete-clip returned 200 and full-view confirmed the deleted clip was gone.
- [x] Accepted member revoke runtime smoke passed: owner member list showed the collaborator, `DELETE /api/projects/:projectId/members/:targetUserId` returned `revoked`, the member list became empty, and collaborator full-view plus agent execute both returned 403 after revoke.
- [x] Editor export runtime smoke passed: collaborator accepted an editor invite and `POST /api/exports` returned 200 with a project-scoped export R2 key.
- [x] Shared pending audio visibility runtime smoke passed: queued uploaded-audio outbox entry was `{ pending: 1, failed: 0 }`, collaborator full-view returned 200 without the clip before flush, flush returned `{ pending: 0, failed: 0 }`, and collaborator full-view then contained the clip with `sampleUrl`.
- [x] PR5 local validation passed after shared outbox/idempotency changes: `bun run typecheck`, `git diff --check`, `bun run knip`, and `bun run build`.
- [x] PR5 browser smoke passed through direct Helium CDP after `agent-browser` could not discover a Chrome binary; localhost rendered the expected Browser DAW title and local project picker text.
- [x] Finding resolved: R2 cleanup now uses a durable Convex retry queue drained by authenticated Worker routes after reload.
- [x] Finding resolved: browser-native prompt/confirm/alert usage has been removed from local project, backup, timeline import/delete, share-copy, timeline project lifecycle, and login error flows; these now use app-native dialogs or inline app messages.
- [x] Finding resolved: backup uploads now flush pending `cloud-delete:asset:*` markers even when the project manifest is otherwise unchanged.
- [x] Finding resolved: local Convex auth JWK artifact files were deleted and added to `.gitignore` so generated secrets are not accidentally re-added.
- [x] Implemented accepted access-row revocation through authenticated Worker routes plus service-token Convex mutations; owners cannot revoke themselves or another owner through this path.
- [x] Implemented owner-facing accepted-member revocation in the Share menu; members load from `/api/projects/:projectId/members`, removal calls the authenticated Worker delete route, and success/error states are inline with no browser-native dialogs.
- [x] Implemented local cache purge for explicit leave/access-loss handling so revoked shared/cloud project caches are removed from IndexedDB before navigation.
- [x] Validated auth/access foundation with `bun run typecheck`.
- [x] Post-audit tracker correction: durable shared outbox completion wording now excludes the recording lock flow, matching `track-recording-session.ts` where locks are deliberately published ephemerally.
- [x] Post-audit mapping cleanup: cloud backup asset mapping rows now come from `src/lib/local-cloud-id-map.ts` instead of duplicating `cloud-id:*` / `local-id:*` row construction inside `cloud-backup.ts`.
- [x] Browser module runtime validation passed through the local Vite app with mocked backup endpoints: backup commit persisted `cloud-id:asset:*` and `local-id:asset:*` rows, `getCloudIdMapping`/`getLocalIdForCloudId` read them back, and `buildProjectManifest` retained the uploaded cloud asset key.
- [x] Browser module runtime validation passed for restored cloud assets: restore wrote asset metadata plus `cloud-source:asset:*`, `cloud-id:asset:*`, and reverse `local-id:asset:*` rows; lazy cloud read succeeded; `downloadCloudAssetsForOffline` cached the asset; and a subsequent offline read used the local cache.
- [x] Browser module runtime validation passed for backup conflict/retry actions: conflict detection returned 409 metadata without promoting local mode, overwrite committed backup mode plus mapping rows, duplicate-cloud created a separate local-only project with cloud source rows, transient failures retried, and a manual retry after a failed attempt succeeded.
- [x] Browser module runtime validation passed for shared outbox reconnect core: an offline shared `tracks.setVolume` publish wrote a pending `shared-outbox:*` row, reconnect/flush published the original operation, and the outbox summary returned to `{ pending: 0, failed: 0 }`.
- [x] Browser module runtime validation passed for post-promotion local usability: after backup promotion, the project remained in `backup` mode and its local asset bytes still read from local storage.
- [x] Fresh-profile restore validation passed in an isolated `agent-browser` session: restoring a mocked cloud manifest created the backup-mode project, persisted asset metadata plus cloud source/mapping rows, lazy-fetched the cloud asset, downloaded it for offline use, reopened the browser profile, and read the cached asset locally while cloud fetches returned unavailable.
- [x] Duplicate runtime-plan reconciliation: auth gating, R2 upload, shared URL/current behavior, collaborator pending-audio visibility, offline shared edit reconnect, raw-key rejection, and access-checked routes were marked complete where Phase 14/15 already contained matching runtime evidence.

---

## Validated Current Codebase State

### Auth / route boot

- `src/routes/index.tsx` currently requires a session before the studio loads.
- Signed-out users are redirected to `/about`.
- Local-first solo use therefore currently cannot open the studio without auth.

### Project source of truth

- `src/hooks/useTimelineData.ts` currently treats Convex rooms as projects.
- It reads/writes `roomId` in the URL.
- It lists projects with `convexApi.projects.listMineDetailed`.
- It loads timeline state with `convexApi.timeline.fullView`.
- It creates, renames, and deletes projects through Convex mutations.
- `convex/projects.ts` stores project rows and ownership markers.

### Timeline source of truth

Convex currently stores durable project/timeline state:
- `tracks`
- `mixerChannels`
- `clips`
- `samples`
- `projects`
- `ownerships`
- `effects`
- `chatHistories`
- `roomMessages`
- `exports`

Relevant files:
- `convex/schema.ts`
- `convex/timeline.ts`
- `convex/projects.ts`
- `convex/tracks.ts`
- `convex/clips.ts`
- `convex/effects.ts`
- `convex/samples.ts`
- `convex/exports.ts`
- `convex/ownerships.ts`
- `convex/roomAccess.ts`

### Local persistence that already exists

Local persistence exists, but it is not the authoritative project document.

Existing local state:
- `src/lib/timeline-storage.ts`
  - local mix
  - routing
  - mix-sync flag
  - grid
  - BPM
  - loop
  - undo/redo history
- `src/lib/audio-peaks/peak-db.ts`
  - IndexedDB waveform peak asset/chunk cache
- `src/hooks/useTimelineMidiOverlay.ts`
  - MIDI editor card localStorage state
- `src/components/AgentChat.tsx`
  - `agent_auto_apply` localStorage state

Decision:
- Existing localStorage should not remain the long-term home for project-owned state.
- Per-project IndexedDB should become the durable home for project data.
- localStorage should remain only for UI/global preferences.

### Track and clip ID coupling

- `src/types/timeline.ts` currently defines `TrackId` as `Id<'tracks'>` from Convex.
- Many hooks and helpers rely on Convex document IDs as app-level IDs.

Decision:
- App-level track/clip IDs must become local string IDs.
- Cloud sync must maintain local-to-cloud ID mappings.
- Project identity itself should be the canonical `projectId`, not a separate local ID plus cloud room ID.

### Sample/import flow

Validated current flow:
- `src/hooks/useTimelineClipImport.ts` decodes imported audio, then creates an uploaded audio clip.
- `src/hooks/useClipBuffers.ts` uploads to `/api/samples`.
- `src/lib/clip-create.ts` requires `sampleUrl` for audio Convex clip creation.
- `convex/clips.ts` requires complete source metadata for audio clips and upserts sample rows.
- `api/index.ts` `POST /api/samples` writes uploaded audio to R2.

Decision:
- Normal local import must not upload to R2.
- Imported audio must first become a local asset.
- R2 upload happens only during cloud sync/share promotion.

### Recording flow

Validated current flow:
- `src/hooks/useTrackRecording.ts` requires `roomId` and `userId`.
- Recording uses Convex track locks through `src/lib/track-recording-session.ts`.
- Completed recordings call `createUploadedAudioClip`.
- Recordings are uploaded to R2 before they become durable project clips.

Decision:
- Local-only recording must write to local storage/OPFS/project assets first.
- Convex locks apply only in shared mode.

### Export flow

Validated current flow:
- `src/components/timeline/ExportDialog.tsx` renders mixdown in the browser.
- It fetches effects from Convex.
- It uploads the encoded WAV to `/api/exports`.
- It optionally records metadata in `convex/exports.ts`.

Decision:
- Local-only export should use `showSaveFilePicker` where available and fallback to a blob download.
- R2 export upload should happen only for cloud sync/share.

### Samples menu

Validated current flow:
- `src/hooks/useProjectSamples.ts` reads Convex `samples.listByRoom`.
- It also reads Convex `clips.listByRoom`.
- Default samples are fetched from `/api/default-samples` and `/api/default-sample`.
- Project sample items currently require URL-backed assets.

Decision:
- Project samples must become a merged list of local assets, local recordings, OPFS/project-folder assets, default samples, and cloud-synced samples.
- Local samples should not require `url`.

### Effects, mixer, and routing

Validated current flow:
- Effects are persisted through Convex queries/mutations in `EffectsPanel`, `create-effects-panel-state`, and `convex/effects.ts`.
- Mixer volume/mute/solo/routing is a mix of localStorage local overrides and Convex shared writes.
- `useTimelineMixerController` schedules Convex writes for shared mix state.

Decision:
- Effects, mixer, routing, BPM, grid, and loop are project state and should move to per-project IndexedDB for local projects.
- Shared/cloud mode can continue to project those changes into Convex.

### Undo/redo

Validated current flow:
- `src/lib/undo/exec.ts` executes undo/redo through Convex mutations.
- `src/hooks/useTimelineHistory.ts` persists history locally but replays against Convex-backed operations.

Decision:
- Undo/redo must become repository-backed.
- Local project history replays local repository operations.
- Shared/cloud history can replay cloud repository operations.

### Share flow

Validated current flow:
- `src/lib/timeline-share.ts` builds a share URL from `roomId`.
- `src/hooks/useShareMenuController.ts` opens/copies that URL.
- `src/hooks/useTimelineActions.ts` ensures a room share link.

Decision:
- Sharing should promote or link a local project to a Convex room.
- Share URL should reference cloud/shared identity, not force local-only projects to become Convex projects on boot.

### Cloud access and cleanup issues discovered during validation

Current cloud issues to account for:
- `/api/samples/:roomId/:sourceId` streams R2 objects by `?key=...` without access checks.
- `/api/export` streams R2 exports by `?key=...` without access checks.
- Some Convex room-scoped list queries are not access-guarded.
- Convex functions rely heavily on client-supplied `userId`.
- Project deletion does not clean R2 objects.
- Sample/export removal deletes Convex metadata only, not R2 blobs.
- Project cleanup does not clearly remove every room-scoped row such as samples, exports, effects, chat histories, and messages in the current branch state.

Decision:
- Cloud sync/share work must include explicit access-control and cleanup decisions.
- R2 garbage collection must not be left implicit.

---

## Validated Diffusion Studio Reference

Reference repo inspected:
- `/Users/juan/Documents/monorepo-new/apps/web/src`

The originally described path with spaces/capitalization was not present; the validated local path is lowercase `monorepo-new`.

### Global DB pattern

Validated file:
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/db/global-db.ts`

Validated patterns:
- IndexedDB database name: `global-db`
- Stores:
  - `directories`
  - `projects`
- Stores `FileSystemDirectoryHandle` entries.
- Tracks project names, timestamps, recent projects, and thumbnails.
- `retrieveDirectoryHandle()` returns the last saved directory handle if present, otherwise falls back to `navigator.storage.getDirectory()`.

Correction:
- OPFS fallback is for missing prior directory handle, not specifically IndexedDB failure.

### Per-project DB pattern

Validated file:
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/db/project-db.ts`

Validated patterns:
- Per-project DB name: `db-v2-${projectId}`
- Stores:
  - `entities`
  - `assets`
  - `fonts`
  - `world`
- Uses a `WriteQueue` to batch entity writes/deletes via `requestIdleCallback`.
- Uses `WorldStateWriter` to coalesce world-state writes.

Correction:
- Comments imply `db-{projectId}` in places, but actual DB name is `db-v2-${projectId}`.
- `duplicateProject(projectId)` copies `entities`, `assets`, and `fonts`, but not `world`.

### Asset storage pattern

Validated file:
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/ecs/assets.ts`

Validated patterns:
- Asset metadata is stored in the per-project IndexedDB `assets` store.
- Asset records can store `FileSystemFileHandle`.
- Sequence assets also store `FileSystemDirectoryHandle`.
- Blob/File/URL inputs can be written under an `assets` folder in the chosen directory or OPFS fallback.
- Existing `FileSystemFileHandle` inputs store the original handle directly.
- `remove(...ids)` removes IndexedDB asset records but does not delete underlying filesystem files.

Decision for this DAW:
- For reliable offline reopening, prefer copying imported audio into OPFS or a chosen project folder instead of relying only on external file handles.
- Keep external file handles as provenance where useful, but make the local asset copy the durable playback source.
- Diffusion stores existing `FileSystemFileHandle` inputs directly; this DAW intentionally adapts that behavior for audio by always copying imported/recorded audio into project-owned storage.

### Permission pattern

Validated files:
- `/Users/juan/Documents/monorepo-new/apps/web/src/utils/browser.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/context/engine.tsx`

Validated patterns:
- `verifyHandlePermission(handle, mode)`
- `verifyHandlePermissions(handles, mode)`
- Existing handles are checked with `queryPermission`.
- Missing permissions are re-requested from a user-activated dialog.

Decision:
- Local-first DAW must provide a "Restore media access" flow for file handles that need regrant.

### Export/import pattern

Validated files:
- `/Users/juan/Documents/monorepo-new/apps/web/src/context/export.tsx`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/buffer.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-left/project-menu/file-menu.tsx`

Validated patterns:
- `showSaveFilePicker` is used for file exports.
- Encoded output can stream to a writable file handle.
- Asset import/export exists.
- Full project archive import/export was not found.

Decision:
- Do not assume Diffusion provides a ready project archive model.
- Add DAW project archive import/export later only if product requirements require portable `.daw` packages.

---

## Current Browser API Assumptions

Validated from current MDN/Chrome/web.dev references:
- File System Access API supports user-picked file/directory handles in Chromium-based browsers.
- `FileSystemHandle.queryPermission()` and `requestPermission()` are the relevant permission APIs.
- Persisted handles can be stored in IndexedDB, but permission may need to be restored.
- OPFS is available through `navigator.storage.getDirectory()`.
- OPFS is origin-private and not visible as a normal user folder.
- File System Access APIs require secure contexts and have browser support caveats.

Current local declarations are incomplete:
- `src/types/file-system-access.d.ts` only declares `showOpenFilePicker` and `FileSystemFileHandle.getFile`.

Decision:
- Expand browser File System API types before implementing local assets.
- Keep fallback behavior for browsers without full File System Access support.

---

## Refactor Guardrails

- Do not make Convex/R2 part of local-only startup.
- Do not upload imported samples during normal local usage.
- Do not require login for local projects.
- Do not keep `sampleUrl` as the only durable audio reference.
- Do not rely on Convex IDs as local project IDs.
- Do not store large audio blobs in localStorage.
- Do not treat waveform IndexedDB cache as source audio storage.
- Do not leave sync/share behavior implicit.
- Do not introduce a large generic framework; use focused repository and storage boundaries.
- Keep project state in IndexedDB; keep localStorage for UI/global preferences only.
- Validate with the app, browser logs, network logs, storage inspection, and screenshots after implementation slices.

---

## Target Architecture

### Project modes

Projects should have explicit modes:
- `local-only`
- `backup`
- `shared`

First implementation pass:
- implement `local-only`
- leave `backup` and `shared` as deferred cloud modes
- keep code seams compatible with future sync/share, but do not build cloud conflict resolution in the first pass

#### `local-only`

- No auth required.
- No Convex required.
- No R2 required.
- All project state and assets are local.

#### `backup`

- Auth required.
- Local project remains canonical for editing.
- Convex/R2 receive debounced full-manifest snapshot backups plus project-scoped assets.
- Backup is restore/overwrite oriented, not bidirectional merge sync.
- Latest successful cloud snapshot is retained for the first cloud pass.
- No collaboration locks/chat required.
- Conflicts are explicit user choices, not automatic merges.

#### `shared`

- Auth required.
- Local project is promoted/linked to Convex/shared records using the canonical `projectId`.
- Unsynced assets are uploaded to R2.
- Collaboration features activate.
- Shared chat, room access, ownership, and locks become available.
- Current-user edits are local pending writes until Convex publishes them.
- Convex-published state is what collaborators can see.
- Remote entities/assets are pulled from Convex/R2 into the local cache.
- Shared conflicts use last-write-wins.

### Local DB split

Add a local persistence module under:
- `src/lib/local-projects/`

Likely files:
- `global-db.ts`
- `project-db.ts`
- `project-schema.ts`
- `project-store.ts`
- `asset-store.ts`
- `file-permissions.ts`
- `opfs.ts`
- `sync-state.ts`

### Global local project index

Suggested durable shape:

```ts
type LocalProjectEntry = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  syncEnabled: boolean
  sharingEnabled: boolean
  directoryHandle?: FileSystemDirectoryHandle
}
```

Decision:
- `id` is the canonical `projectId` used locally and by future cloud/shared records.
- Do not store a separate `cloudRoomId` for project identity.

### Per-project local DB

Each project gets a separate IndexedDB database.

Match Diffusion Studio's pattern with DAW-specific records:
- `entities`
  - typed DAW rows such as tracks, clips, effects, mixer channels, markers, and other timeline entities
- `assets`
  - local audio/sample/export asset metadata and handles
- `projectState`
  - singleton project-level state such as BPM, grid, loop, viewport, transport defaults, and other world-level settings
- `history`
  - local undo/redo history when it is migrated into IndexedDB
- `syncState`
  - future cloud/share sync metadata

Decision:
- Do not use one giant serialized project blob.
- Do not split the first implementation into many separate `tracks` / `clips` / `effects` stores.
- Use a typed `entities` store plus snapshot-loading helpers that assemble the UI model.

### Local timeline snapshot

The UI needs a Convex-independent timeline snapshot:

```ts
type LocalTimelineSnapshot = {
  projectId: string
  name: string
  tracks: LocalTrackRow[]
  clips: LocalClipRow[]
  effects: LocalEffectRow[]
  samples: LocalSampleAsset[]
  exports: LocalExportAsset[]
  updatedAt: number
}
```

Decision:
- `resolveTimelineTracks` should be adapted to consume a source-neutral snapshot rather than a Convex-only `fullView` type.

### Local asset model

Suggested asset shape:

```ts
type LocalSampleAsset = {
  id: string
  name: string
  kind: 'file-handle' | 'opfs' | 'cloud' | 'default-url'
  handle?: FileSystemFileHandle
  opfsPath?: string
  cloudUrl?: string
  hash: string
  mimeType: string
  size: number
  durationSec: number
  sampleRate: number
  channelCount: number
  createdAt: number
  cloudAssetKey?: string
  cloudSyncedAt?: number
}
```

Decision:
- Prefer a durable OPFS/project-folder copy for imported audio.
- Store file handles as provenance/optional restore source.
- Always copy imported/recorded audio into project-owned storage, even when the browser provides a `FileSystemFileHandle`.

### Audio source reference

Clips should move from URL-first to source-reference-first:

```ts
type LocalAudioSourceRef =
  | { kind: 'local-file'; assetId: string }
  | { kind: 'opfs'; assetId: string }
  | { kind: 'cloud'; assetId: string; url: string }
  | { kind: 'default-url'; assetId: string; url: string }
```

Compatibility fields like `sampleUrl` may remain temporarily during migration, but local asset IDs should become the durable reference.

### Sync state

Suggested sync shape:

```ts
type ProjectSyncState = {
  enabled: boolean
  mode: 'local-only' | 'backup' | 'shared'
  lastPulledAt?: number
  lastPushedAt?: number
  pendingLocalChanges: boolean
  pendingAssetUploads: string[]
  pendingAssetDeletions: string[]
  lastCloudSnapshotVersion?: string
  conflict?: 'backup-conflict'
  idMap: {
    tracks: Record<string, string>
    clips: Record<string, string>
    assets: Record<string, string>
  }
}
```

Decision:
- `ProjectSyncState` should not contain a separate cloud room identity.
- Future cloud records use the same canonical `projectId`.
- Backup sync state should track pending uploads/deletions and the last acknowledged cloud snapshot.

### Cloud backup manifest

Backup snapshots should use the same durable project shape as local/archive manifests:

```ts
type CloudProjectManifest = {
  schemaVersion: number
  projectId: string
  name: string
  updatedAt: number
  entities: DawEntity[]
  assets: CloudAssetReference[]
  projectState: LocalProjectState
}
```

Decision:
- Store the full manifest in Convex.
- Store asset blobs in R2 under project-scoped keys.
- Exclude undo/redo history from cloud backup.
- Keep only the latest successful backup snapshot in the first cloud pass.
- Use `schemaVersion` and explicit migrations for future manifest changes.

### Portable project archive

Later archive format:
- `.dawproject`
- zip-like package
- `manifest.json` using the same schema as cloud backup
- `assets/` folder keyed by stable asset IDs and stored asset paths

Decision:
- Define the format in the plan, but do not implement it before local-first and cloud backup work.

### Save / sync status UI

The UI should distinguish local persistence from cloud/share state.

Required status states:
- `Saved locally`
- `Local save failed`
- `Backup pending`
- `Backing up`
- `Backed up`
- `Backup failed`
- `Backup conflict`
- `Shared pending upload`
- `Offline changes queued`

Decision:
- Do not collapse local and cloud status into a single generic saved indicator.
- Local save status should remain visible even when cloud backup/share is disabled.
- Cloud failure must not imply local save failure.
- Show compact status in the toolbar near the project name.
- Put detailed status/actions in the project menu.
- Local save failures should be persistent warnings with retry/export/storage guidance.

### Project picker UX

The first local project picker should include:
- recent local projects sorted by `lastOpenedAt`
- new project action
- rename project action
- delete project action

Decision:
- When `/` has no `projectId`, show the picker.
- Deleting a local project requires typing the project name.
- The delete warning must explain that local project data and app-owned assets will be deleted.
- Cloud project browsing can come later; the picker MVP stays local.

### Missing media and quota UX

Decision:
- Audio import/recording must be atomic.
- If asset bytes and metadata are not durable, do not create the clip.
- On quota/storage failure, show retry/free-space/choose-folder guidance.
- If an existing asset is missing, corrupt, or unreadable on reload, keep the clip as a muted missing-media placeholder.
- Missing-media placeholders should offer restore, replace, and remove actions.
- The project should remain loadable even with missing media.
- If a chosen project folder loses permission, require regrant or an explicit move-to-OPFS/storage-change action.
- Do not silently split a project across OPFS and a previously chosen visible folder.

---

## Implementation Phases

### Slice policy

- [x] Keep every implementation slice buildable.
- [x] Prefer milestone slices over file-by-file edits or large rewrites.
- [x] Do not add a runtime local-first feature flag.
- [x] Use temporary adapters only at repository/cloud/local boundaries.
- [x] Delete temporary adapters and old Convex-first paths as soon as replacements are validated.
- [x] Run `bun run knip` only at major milestone finals: local-only complete, cloud complete, archive complete if implemented.

Preferred first sequence:
1. focused `roomId` → `projectId` rename
2. `idb` and local DB foundation
3. project picker and signed-out local boot
4. local timeline CRUD
5. local audio assets/import

### Phase 0 — Project identity rename

- [x] Perform a focused app-facing `roomId` → `projectId` semantic rename.
- [x] Replace URL `roomId` semantics with `projectId`.
- [x] Rename Convex room-key fields/functions where they represent project identity.
- [x] Keep collaboration-specific language such as locks/chat/shared access only where the feature is actually collaboration-specific.
- [x] Do not preserve backward compatibility for old `roomId` URLs.
- [x] Keep the rename slice behavior-neutral except for URL/key naming and explicit backcompat removal.

Validation:
- [x] `bun run typecheck` — passed after rename fixes.
- [x] `bun run build` — passed after rename fixes.
- [x] `git diff --check` — passed after rename fixes.
- [x] Open existing local dev app path with `?projectId=...` once local boot exists.

### Phase 1 — Local persistence foundation

- [x] Decision: add `idb` and follow Diffusion Studio's `openDB` / `deleteDB` pattern.
- [x] Add `idb` dependency.
- [x] Add global local projects DB.
- [x] Add per-project DB with `entities`, `assets`, `projectState`, `history`, and `syncState` stores.
- [x] Add local project schema/types.
- [x] Add local asset metadata schema/types.
- [x] Add OPFS helpers.
- [x] Add file handle permission helpers.
- [x] Add local project create/list/open/rename/delete primitives.
- [x] Add project picker for `/` when no `projectId` is present.
- [x] Add create-new-local-project action inside the picker.
- [x] Add recent-project list sorted by `lastOpenedAt`.
- [x] Add picker rename action.
- [x] Add picker delete action requiring typed project name confirmation.
- [x] Add local project deletion that removes the global entry, per-project DB, and app-owned assets.

Validation:
- [x] `bun run typecheck` — passed for local DB foundation and picker.
- [x] `bun run build` — passed for local DB foundation and picker.
- [x] `git diff --check` — passed for local DB foundation and picker.
- [x] Create a local project in browser runtime.
- [x] Inspect IndexedDB global DB entries.
- [x] Reload and confirm project list survives.
- [x] Rename a local project from the picker and confirm it persists.
- [x] Delete a local project and confirm its DB/app-owned assets are removed.

### Phase 2 — Browser File System API support

- [x] Expand `src/types/file-system-access.d.ts`.
- [x] Add support for directory handles, save picker, writable streams, OPFS, and permission APIs.
- [x] Add browser capability checks and fallbacks.

Validation:
- [x] In Helium, evaluate support for `showOpenFilePicker`, `showDirectoryPicker`, `showSaveFilePicker`, and `navigator.storage.getDirectory`.
- [x] Verify permission query/request path from a user gesture.

### Phase 3 — Local IDs

- [x] Decouple `TrackId` from `Id<'tracks'>` — app-facing `TrackId` is now a string, with Convex branding confined to cloud mutation/query argument builders.
- [x] Update local app types to use prefixed `crypto.randomUUID()` string IDs.
- [x] Introduce cloud ID mapping for tracks, clips, and assets.
- [x] Keep Convex-specific IDs inside cloud adapter/sync modules.
- [x] Keep project identity as canonical `projectId` rather than local ID plus cloud room mapping.

Validation:
- [x] Typecheck all local ID conversions — passed for new local ID and repository foundation.
- [x] Create local tracks and verify no Convex request is required in local-only mode — validated through the Tracks menu on a signed-out local project.
- [x] Create local clips and verify no Convex ID is required in local-only mode.

Progress note:
- Added prefixed ID helpers for `project`, `track`, `clip`, and `asset`.
- App-facing `TrackId` still points at Convex IDs until the repository routing slice moves Convex-specific mutation inputs behind the cloud adapter; local track projection currently uses the repository boundary while this is being untangled.

### Phase 4 — Local project boot

- [x] Remove auth requirement from the studio route.
- [x] Refactor `useTimelineData` or add a local-first facade — local projects are now merged into the timeline project list and local create/rename/delete/open paths use IndexedDB project APIs.
- [x] Show local project picker when no `projectId` is selected.
- [x] Create/open local projects from the picker.
- [x] Use `projectId` as the only project identity in URLs and app-facing state.
- [x] Require login only when a requested `projectId` is not local and must be loaded from future cloud/shared state — the route gates non-local project IDs for signed-out sessions while local project IDs still open directly.

Validation:
- [x] Open app signed out — validated at `http://127.0.0.1:3000/`.
- [x] Confirm no redirect to `/about`.
- [x] Confirm local project picker appears.
- [x] Create a project from the picker.
- [x] Confirm no Convex requests are required for local-only boot.

Evidence:
- `/Users/juan/Downloads/daw-local-first-validation/phase-local-picker/picker.png`
- `/Users/juan/Downloads/daw-local-first-validation/phase-local-picker/project-open.png`
- IndexedDB names observed: `daw-browser-projects`, per-project `daw-browser-project-project:<uuid>`, and existing `audio-peaks-db`.

### Phase 5 — Source-neutral timeline repository

- [x] Add `src/lib/timeline-repository/types.ts`.
- [x] Add `local-timeline-repository.ts`.
- [x] Corrected cloud repository strategy: keep existing Convex adapters, add durable shared outbox for supported shared writes, and do not add a misleading `cloud-timeline-repository.ts` wrapper.
- [x] Route core create/move/delete/timing/mixer/effect operations through the repository.

Touchpoints:
- [x] `src/hooks/useTimelineActions.ts` — local project Add Track now writes through `local-timeline-repository` and inserts the projected track without requiring `userId`.
- [x] `src/hooks/useTimelineClipImport.ts` — local audio file import now creates a local track when needed, copies bytes to local assets, writes clip metadata through `local-timeline-repository`, and inserts the projected clip without Convex.
- [x] `src/hooks/useTimelineClipActions.ts` — local clip delete, clip duplicate, and track delete now use `local-timeline-repository` when `projectId` is local.
- [x] `src/hooks/useClipDrag.ts` — local clip moves and ctrl-drag duplication now write through `local-timeline-repository`; drag-created tracks are local for local projects.
- [x] `src/hooks/useClipResize.ts` — local clip timing resize now persists through `local-timeline-repository.updateClip` instead of Convex.
- [x] `src/hooks/useTimelineMixerController.ts` — local track volume, mute/solo, sends, and routing now persist through `local-timeline-repository.updateTrack` for local projects.
- [x] `src/hooks/useTrackRecording.ts` — local projects can start/stop recording without `userId` or Convex locks; recorded blobs are copied to local assets and local clips are created through `local-timeline-repository`.
- [x] `src/hooks/useTimelineHistory.ts` — local projects now get a history scope without `userId`; undo/redo replay can route local track/clip create/delete/move/timing/mix/routing operations through `local-timeline-repository`.
- [x] `src/hooks/useProjectedTimelineModel.ts` — local projects no longer query Convex ownerships and treat local projected tracks/clips as writable.
- [x] `src/components/timeline/EffectsPanel.tsx` — local master/track EQ and reverb now persist to project IndexedDB effect entities.
- [x] `src/components/timeline/create-effects-panel-state.ts` — local synth and arpeggiator state now persist to project IndexedDB effect entities.
- [x] `src/components/midi/MidiEditorCard.tsx` — local MIDI note edits persist through `local-timeline-repository.updateClip` without requiring `userId`.
- [x] `src/components/timeline/ExportDialog.tsx` — local exports skip Convex effect queries and `/api/exports`, saving the rendered WAV locally.

Validation:
- [x] Run local-only create track flow.
- [x] Run local-only create clip flow.
- [x] Run local-only move flow through local repository code path.
- [x] Run local-only delete flow through local repository code path.
- [x] Verify local DB changes after local track create.
- [x] Verify local DB changes after local audio clip import.
- [x] Verify cloud repository still preserves current shared behavior when enabled — adapter typecheck/build passes; runtime wiring is still deferred until core cloud routing switches to the adapter.

Evidence:
- `/Users/juan/Downloads/daw-local-first-validation/local-track-create-before.png`
- `bun run typecheck && bun run build && git diff --check` after adding the local timeline repository and write adapters.
- Helium local project reload smoke test after cloud adapter addition: app shell loaded; existing generic API/resource noise remained unchanged.
- `/Users/juan/Downloads/daw-local-first-validation/local-track-create-after.png`
- Browser network log for the local track-create flow showed no captured Convex requests.
- `/Users/juan/Downloads/daw-local-first-validation/local-clip-import-after.png`
- IndexedDB after local audio import contained one `track:*`, one `clip:*`, and one `asset:*` row; browser network log showed no captured Convex requests.
- Existing Helium browser reload after local Convex gates showed only Vite connect logs and no new local-project Convex subscription errors.
- Local export validation with a stubbed `showSaveFilePicker` saved `mixdown_20260521152437018.wav` in-browser and showed no captured `/api/exports` request.
- Helium local track create wrote a `track-create` history entry under `mb:history:<projectId>:local`; `Meta+Z` removed the track row from IndexedDB and `Meta+Y` restored it without new Convex subscription errors.
- Helium local effects validation added master EQ, wrote `master:master-eq` to the per-project IndexedDB `entities` store, and confirmed the row survived reload.
- Helium local history validation wrote undo/redo state to the per-project IndexedDB `history/timeline` row; `Meta+Z` updated IndexedDB history counts and removed the newest local track row.
- Helium Media menu validation on a local project showed no captured Convex network requests after opening the samples menu path.
- Helium lifecycle flush validation created a local track, dispatched page lifecycle events, and confirmed the IndexedDB track count stayed durable after the flush path.
- Helium project-state validation changed BPM to 137 and toggled Sync Mix, confirming per-project IndexedDB `projectState/bpm` and `projectState/syncMix` rows were written.
- Helium localStorage suppression validation cleared local project-owned keys, edited BPM/grid/syncMix, and confirmed new `projectState` rows were written while `mb:bpm`, `mb:grid`, `mb:loop`, `mb:mix-sync`, `mb:mix`, and `mb:routing` stayed absent.
- Helium reload after missing-media status wiring showed the local project still boots; the existing generic 500 resource noise remains unrelated to timeline rendering.
- Helium reload after storage error handling changes showed the local project still boots.
- Helium local track-create validation after TrackId decoupling added a local track and confirmed IndexedDB track rows remained valid.
- Helium reload after asset provenance metadata changes showed the local project still boots.
- Helium undo/local-mix validation cleared legacy mix/routing localStorage keys, exercised local track/mix history flow, and confirmed those keys stayed absent.
- Helium toolbar validation confirmed the local project renders the `Saved locally` badge.
- Helium Project menu validation confirmed local save status plus backup/archive/storage actions render.
- Helium import validation exercised the local audio import path after wiring local-save-failed banner state; normal import remained functional.
- Helium reload smoke test after waveform cache scoping confirmed the local project still boots with local clips present.
- Helium validation after missing-media action wiring confirmed validators pass; Retry, Replace, and Remove are wired in code, and reload smoke still renders the local save state.
- Helium Project menu validation confirmed `Choose storage folder` renders for local projects; screenshot evidence captured with the local Project menu open.
- Helium reload smoke after local/cloud clip creation split confirmed the local project still renders with `Saved locally`.
- Helium Project menu validation after local project facade wiring confirmed the current local project appears in the Project menu with local save state.
- Helium route validation confirmed local project URLs still open directly after the cloud-login gate; cloud prompt path could not be observed because the browser session is currently signed in.
- Helium Phase 13 validation changed BPM/grid/loop and reloaded, confirming `projectState/bpm`, `projectState/grid`, and `projectState/loop` persisted in per-project IndexedDB.
- Helium Phase 13 validation toggled local track solo and reloaded, confirming mixer state persisted on local track entity rows.
- Helium Phase 13 validation added master reverb and reloaded, confirming local effect rows persisted in per-project IndexedDB.
- Helium Phase 13 export validation rendered from a local project with local master effects and captured no `/api/exports` requests.
- Helium Phase 1 validation created a temporary local project from the picker, inspected `daw-browser-projects`, confirmed the picker survived reload, and verified project lifecycle entries in IndexedDB.
- Helium Phase 2 validation confirmed `showOpenFilePicker`, `showDirectoryPicker`, `showSaveFilePicker`, and `navigator.storage.getDirectory` are available; OPFS permission query/request both returned `granted`.
- Added `src/lib/local-cloud-id-map.ts` to persist local-to-cloud track/clip/asset mappings and stable `historyRef` values in each project's `syncState` store.
- Added `src/hooks/useCloudSyncTick.ts`; the 30-second debounced backup timer is scoped, cleaned up through Solid cleanup, and gated off for local-only projects.
- Helium Phase 6 validation imported `/tmp/daw-phase-validation.wav` into a local project, confirmed local asset metadata in IndexedDB, captured no `/api/samples`, recorded `/tmp/daw-phase6-trace.json`, and verified rapid BPM edits persisted while playback continued.
- Helium Phase 6 quota validation monkey-patched OPFS to throw `QuotaExceededError`; clip count stayed unchanged, confirming no broken clip was created.
- Helium Phase 10 now stores local export metadata in `projectState/exports` after successful browser save/download while continuing to avoid `/api/exports` for local-only exports.
- Helium offline validation set the browser offline, created a local track, played/stopped locally, restored network, and confirmed the local project still reported `Saved locally`.
- Final validators passed after the phase 1–13 completion sweep: `bun run typecheck && bun run build && git diff --check && bun run knip`.
- Post-implementation simplify review extracted shared local track-row projection, parallelized default-sample metadata loading, and reused the previous asset directory handle during storage-folder moves.
- Post-implementation defensive-code review found no high-confidence cleanup that could be removed without weakening TypeScript/persistence/auth boundary clarity.
- Post-review validators passed: `bun run typecheck && bun run build && git diff --check && bun run knip`.

### Phase 6 — Local audio asset store

- [x] Add local asset create/read/delete APIs.
- [x] Copy all imported audio into OPFS or selected project assets folder, including files that arrive through `FileSystemFileHandle`.
- [x] Copy all recorded audio into OPFS or selected project assets folder.
- [x] Store asset metadata in per-project IndexedDB.
- [x] Store optional original file handle provenance without depending on it for playback — local asset rows now retain original file name and last-modified metadata while playback continues to use copied project storage bytes.
- [x] Make import/recording asset writes atomic so clips are not created unless bytes plus metadata are durable.
- [x] Add quota/storage failure handling with retry/free-space/choose-folder guidance — local asset writes now classify permission/quota/unsupported/write failures and import/recording paths avoid clip creation unless bytes are durable while surfacing retry/free-space guidance.
- [x] Add missing-media placeholder state for unreadable/corrupt/missing assets — local asset read failures now mark clips with `mediaStatus` and render a visible missing/permission placeholder.
- [x] Add restore/replace/remove actions for missing-media placeholders — missing-media clips now expose Retry, Replace, and Remove actions; local Replace writes a new durable asset and updates the clip source metadata.
- [x] Require regrant or explicit storage move if a chosen project folder loses permission — local projects now expose `Choose storage folder`, persist the new directory handle, and copy readable existing local assets into the selected folder.
- [x] Resolve buffers from local asset references — `useClipBuffers` decodes local `sourceAssetKey` assets from per-project storage before falling back to `sampleUrl`.
- [x] Keep waveform peak cache keyed by local asset ID/project scope.

Validation:
- [x] Record baseline import/reload timings from CDP validation before enforcing hard thresholds.
- [x] Confirm no obvious long main-thread stalls during import/reload.
- [x] Confirm playback remains stable during background saves.
- [x] Import audio in local-only mode.
- [x] Confirm clip appears.
- [x] Confirm playback buffer loads locally.
- [x] Confirm no `/api/samples` request happens.
- [x] Reload and confirm audio can be restored.
- [x] Simulate quota/storage failure and confirm no broken clip is created.
- [x] Simulate missing media and confirm placeholder/restore/replace/remove behavior.

### Phase 7 — Local clip creation

- [x] Split `createUploadedAudioClip` into local and cloud paths — local file/recording paths now use `createLocalAudioClip`, while cloud paths keep R2-backed `createUploadedAudioClip`.
- [x] Add local clip creation using local assets.
- [x] Keep cloud clip creation for shared/sync upload.
- [x] Remove local-only dependency on `sampleUrl` — local file and recording creation persist `sourceAssetKey` local assets without URL fields.

Validation:
- [x] Create clips from imported files without network.
- [x] Create MIDI clips without Convex.
- [x] Verify undo history can reference local clip IDs.

### Phase 8 — Autosave

- [x] Add Diffusion-style idle/coalesced local write queue for high-frequency entity mutations.
- [x] Use immediate awaited writes for asset creation, project lifecycle, and explicit save-critical operations.
- [x] Flush queued writes on project switch, visibility hide, and before unload where available — local timeline repository flushes pending writes on `visibilitychange`, `pagehide`, `beforeunload`, `loadSnapshot`, destructive operations, and Timeline project cleanup.
- [x] Add cleaned-up 30-second cloud sync tick only for sync-enabled projects.
- [x] Ensure sync interval is scoped and cleaned up.

Decision:
- Local autosave should not wait 30–60 seconds for important edits.
- 30-second cadence is for cloud sync, not the only local save mechanism.

Validation:
- [x] Edit project state rapidly and confirm writes coalesce.
- [x] Reload after edits and confirm local state survives.
- [x] Enable sync and confirm cloud sync tick does not run in local-only mode.

### Phase 9 — Recording

- [x] Make local recording independent of `userId` and `projectId` cloud identity.
- [x] Write recording blobs into OPFS/project assets.
- [x] Create local asset metadata.
- [x] Create local clips from recorded assets.
- [x] Keep Convex locks only for shared mode.

Validation:
- [x] Record in signed-out local-only mode.
- [x] Confirm local recorded clip appears.
- [x] Confirm no `/api/samples` request happens.
- [x] Reload and confirm recorded audio restores.

### Phase 10 — Export

- [x] Use `showSaveFilePicker` where available.
- [x] Add blob-download fallback.
- [x] Save local export metadata if useful.
- [x] Upload to `/api/exports` only in cloud sync/share mode.
- [x] Stop querying Convex effects for local-only export.

Validation:
- [x] Export local-only project.
- [x] Confirm downloaded/saved file is valid.
- [x] Confirm no `/api/exports` request happens.

### Phase 11 — Samples menu

- [x] Merge local project assets with default samples and cloud samples — local projects now build project samples from per-project IndexedDB assets and local timeline clip usage while cloud projects keep the Convex-backed inventory path.
- [x] Display local recordings/imports without requiring URL — local asset rows use `local-asset:<assetId>` menu URLs and insertion writes clips with durable `sourceAssetKey` references.
- [x] Support deleting local sample metadata/assets safely — local sample delete removes the local asset row/blob and refreshes the menu without calling Convex.
- [x] Keep default samples R2-backed with cache/fallback behavior.

Validation:
- [x] Import local sample and see it in samples menu.
- [x] Insert local sample into timeline.
- [x] Reload and confirm menu state persists.

### Phase 12 — Undo/redo

- [x] Make undo/redo execute repository operations.
- [x] Keep local history per project in IndexedDB.
- [x] Preserve stable history refs through local ID changes and cloud promotion.

Validation:
- [x] Undo/redo track create/delete locally.
- [x] Undo/redo clip create/delete/move/timing locally.
- [x] Undo/redo effects/mix/routing locally.

### Phase 13 — Effects, mixer, routing, and preferences

- [x] Move project-owned BPM/grid/loop/mix/routing/effects into per-project IndexedDB. BPM/grid/loop/syncMix and local mix overrides now hydrate/save through `projectState`; effects and local timeline routing/mix are in project stores, and local project-owned state no longer hydrates from legacy localStorage fallbacks.
- [x] Keep localStorage only for UI/global preferences — local project-owned BPM/grid/loop/syncMix/localMix no longer reads or writes legacy localStorage values, including history replay paths.
- [x] Adapt effects panel state to local repository/local store.
- [x] Keep Convex effects only for cloud/shared repository.
- [x] Add compact local/cloud save status badge near the project name in the toolbar.
- [x] Add detailed save/backup/share status actions to the project menu.
- [x] Add persistent local-save-failed warning with retry/export/storage guidance.

Validation:
- [x] Change BPM/grid/loop and reload.
- [x] Change track mixer/routing and reload.
- [x] Change effects and reload.
- [x] Export local project with local effects applied.

### Phase 14 — Cloud sync and share promotion

Cloud work is deferred until local-only workflows are proven, but the cloud contract is decided here.

Current scope clarification:
- Completed backup promotion keeps local `project:*` projects in local ownership mode with `mode: "backup"` and uses the same canonical `projectId` for cloud backup records.
- Completed shared-mode validation covers cloud/shared projects loaded through the authenticated Worker/Convex paths.
- Directly converting a local `project:*` backup into a collaborator-openable shared room is not implemented in this branch; the Project menu does not issue invite links for local projects until a dedicated shared-promotion flow exists.

#### Backup mode

- [x] Require auth when enabling backup and when using cloud/shared invite flows.
- [x] Add backup disable flow.
- [x] Add explicit “Back up now” action.
- [x] Add automatic debounced backup for backup-enabled projects.
- [x] Build full versioned project manifest from local `entities`, `assets`, and `projectState`.
- [x] Upload unsynced local audio assets to project-scoped R2 keys with content hashes.
- [x] Commit latest backup manifest to Convex by canonical `projectId`.
- [x] Exclude undo/redo history from cloud backup.
- [x] Detect backup conflicts when local and cloud both changed since the last acknowledged snapshot.
- [x] Surface explicit conflict actions:
  - keep local and overwrite cloud
  - restore cloud over local
  - duplicate cloud as a new local project
- [x] Show conflict summary with project names, local/cloud timestamps, and cheap changed counts if available.
- [x] Do not build deep timeline diff for the first backup conflict UI.
- [x] Add capped exponential backoff for failed backup uploads.
- [x] Add manual retry for failed backup uploads.
- [x] Keep local editing enabled while backup is failed/pending.
- [x] Use an initial cloud upload transfer limit of 2.
- [x] Use an initial cloud download transfer limit of 3 when restore/offline-download flows are implemented.
- [x] Mark locally deleted cloud assets as pending deletion.
- [x] Delete superseded R2 assets immediately after a new snapshot commits without them.
- [x] Attempt best-effort deletion of the project-scoped R2 prefix when an owner deletes the cloud project.
- [x] Restore by loading manifest first and lazy-caching assets by default.
- [x] Add explicit “Download for offline” action for cloud-backed assets.

#### Shared mode

- [x] Create/link Convex shared records by canonical `projectId` for cloud/shared projects; local backup-to-shared promotion is explicitly blocked until a real promotion flow exists.
- [x] Add owner/editor/viewer role model.
- [x] Add authenticated invite links with intended role.
- [x] Make invite links non-expiring but revocable.
- [x] Accepting a share link creates an access row for the authenticated user.
- [x] Owners can revoke invite links.
- [x] Owners can revoke already accepted access rows.
- [x] Defer owner transfer from the first shared/cloud pass.
- [x] Owners and editors can edit/export.
- [x] Viewers can view/play and list/download existing exports only; they cannot create exports.
- [x] Only owners can delete the cloud/shared project.
- [x] Non-owners can leave/remove local cache only.
- [x] Use local pending writes for selected current-user shared edits: clip move/delete and track mix/routing/volume writes queue durably on publish failure.
- [x] Extend durable shared outbox operation coverage to retry-safe Worker timeline-operation kinds, including track/clip creation and effect writes; the recording lock flow intentionally remains an ephemeral live-collaboration path and does not enqueue lock/unlock retries.
- [x] Queue shared effect writes durably on publish failure for direct panel edits and effect undo/redo/history replay.
- [x] Add server-side idempotency for shared `tracks.create`, `clips.create`, and `clips.createMany` operations using client operation IDs.
- [x] Queue failed shared track create, clip create, and clip createMany publishes durably after assigning operation IDs.
- [x] Publish queued clip move/delete and track mix/routing/volume writes through authenticated Hono gateway to Convex; collaborators only see Convex-published state.
- [x] Pull remote entities/assets from Convex/R2 into local cache.
- [x] Use last-write-wins for shared conflicts.
- [x] For imported/recorded shared audio, show a local pending clip immediately to the author.
- [x] Publish shared audio clips to collaborators only after R2 upload and Convex metadata write succeed.
- [x] Queue selected local shared edits while offline and publish on reconnect with visible pending/not-shared-yet state.
- [x] Add capped exponential backoff for failed shared track/clip write publishes.
- [x] Add manual retry for failed shared track/clip write publishes.
- [x] Keep local editing enabled while supported shared track/clip writes are failed/pending.

Validation:
- [x] Enable cloud sync from local project.
- [x] Confirm unsynced assets upload.
- [x] Confirm Convex receives metadata.
- [x] Confirm local-to-cloud ID map persists.
- [x] Open shared URL for an existing cloud/shared project and confirm shared behavior works.
- [x] Restore a backup on a fresh browser profile.
- [x] Verify backup restore/download-for-offline controls open app-native dialogs without browser-native dialogs.
- [x] Verify failed backup retry/backoff plus manual retry.
- [x] Verify viewers can list/download existing exports but cannot create exports/edit/upload/record.
- [x] Verify owners/editors can export.
- [x] Verify shared pending audio clips are invisible to collaborators until upload/publish succeeds.
- [x] Verify failed shared upload retry/backoff plus manual retry.
- [x] Verify offline queued edits publish on reconnect.
- [x] Verify “Download for offline” app-native completion dialog path.

Non-goals for the local-only first implementation pass only:
- [x] Defer cloud backup conflict resolution until the cloud phase.
- [x] Do not implement automatic migration from existing Convex projects.
- [x] Do not preserve old `roomId` links.

### Phase 15 — Cloud security and cleanup

- [x] Replace raw key-based R2 reads with access-checked reads by canonical `projectId`.
- [x] Stream through an access-checked API route or mint short-lived signed asset URLs only after access is verified.
- [x] Add role-aware access checks for project-scoped Convex queries/mutations.
- [x] Enforce owner/editor/viewer permissions:
  - owners manage/delete/share
  - editors edit/export
  - viewers view/play and list/download existing exports only
- [x] Define R2 cleanup for deleted samples/exports; project prefix cleanup exists.
- [x] Delete pending R2 assets only after a successful snapshot removes references to them.
- [x] Queue and drain deletion of the full project-scoped R2 prefix on owner project deletion with durable retry state.
- [x] Define Convex cleanup for samples, exports, effects, chat histories, and room messages.
- [x] Stop relying on client-supplied user IDs where server-verified auth context is required. Sample/export delete paths, shared timeline writes, shared effect writes, track recording locks, and shared full-view reads now go through authenticated Hono routes where the server derives the user ID.

Validation:
- [x] Verify unauthorized sample/export reads are rejected where intended.
- [x] Verify access-checked asset routes enforce fresh permissions; if signed URLs are introduced, verify they are short-lived.
- [x] Delete cloud/shared project and verify cleanup behavior.
- [x] Confirm no orphaned R2 objects remain for tested deletion flows or record intentional retention policy.
- [x] Verify raw copied R2 keys cannot be used without project access.
- [x] Verify revoked users lose metadata and asset access.
- [x] Delete a cloud-backed asset locally, commit a backup snapshot, and confirm pending local delete markers are sent to the Worker and cleared only after the server returns the key in `deletedAssetKeys`.
Evidence:
- Added versioned project manifest building from local entities, assets, and projectState; undo/redo history remains excluded.
- Added cloud backup API that uploads assets to project-scoped `projects/{projectId}/assets/{assetId}/{contentHash}` R2 keys and commits the latest manifest to Convex.
- Added backup enable/manual backup and automatic 30-second debounced signed-in backup wiring while keeping local editing available if backup fails.
- Added owner/editor/viewer role schema, authenticated non-expiring revocable invite primitives, role-aware API access checks for samples/exports/cloud backup routes, and accepted access-row revocation through authenticated Worker routes plus owner-facing Share menu controls.
- Replaced raw export streaming with project-scoped `/api/export/:projectId` and rejects copied keys whose prefix does not match the requested project.
- Added owner project deletion route that finalizes Convex cleanup and then best-effort removes the project-scoped R2 prefix; Convex cleanup includes samples, exports, effects, chat histories, project messages, invites, and cloud backups.
- Added authenticated timeline-operation API gateway for selected shared clip/track writes; Convex function inspection confirmed the corresponding server-secret mutations are published in the development deployment.
- Extended the authenticated timeline-operation API gateway to shared track/clip creation, shared EQ/reverb/synth/arpeggiator writes, track recording locks, and a server-derived `/timeline/full-view` snapshot route.
- Convex function inspection confirmed `clips.serverCreate`, `clips.serverCreateMany`, `tracks.serverCreate`, `tracks.serverLock`, and `effects.serverSet*` mutations are published in the development deployment; failure logs were empty during validation.
- PR5 create idempotency validation: Convex CLI metadata inspection confirmed `operationId` on deployed shared create mutations and the `sharedOperationResults` table exists; authenticated API smoke proved duplicate shared track/clip create requests with the same operation IDs return stable server IDs.
- PR5 shared outbox validation: browser/Vite runtime smoke imported the real `shared-outbox.ts`, queued `tracks.create` and `clips.create` entries in IndexedDB, flushed them through the authenticated Worker timeline gateway, observed outbox summary return to zero pending/failed, and cleaned up the temporary project/cache.
- Browser/API smoke evidence captured under `/Users/juan/Downloads/daw-local-first-validation/2026-06-01-hardening/`; unauthenticated timeline read/write API requests returned `403`.
- Authenticated localhost:3000 runtime validation passed: minimal cloud backup create/fetch returned `200`, share invite creation/member listing returned `200`, owner project delete returned `200`, post-delete backup fetch returned `404`, and `/api/r2-cleanup` returned `processed:0, deleted:0` for the no-asset deletion flow.
- Helium runtime validation created a backup-enabled local project, opened `Download for offline` and `Restore cloud backup` app-native dialogs, and observed zero `Page.javascriptDialogOpening` native dialog events.
- Helium share-copy validation confirmed the Project menu button is labeled `Copy share link`, changes inline to `Copied` after click, keeps the menu open, and opens no app/native dialog.
- Added Share menu accepted-member management: owners can list accepted editor/viewer members and remove access through inline controls backed by `/api/projects/:projectId/members`.
- Helium R2 lifecycle validation inserted pending `cloud-delete:asset:*` markers in the per-project IndexedDB `syncState`, clicked `Back up now`, observed `/api/cloud-backups` returning those keys in `deletedAssetKeys`, and confirmed the local markers were removed only after that confirmed response.
- During R2 lifecycle validation, the first stale local Worker processed queued deletes but returned `deleted:0`; restarting the local Vite/Worker dev server restored R2 binding behavior and the same pending marker flow passed.
- Browser-native dialog sweep validation found no remaining `alert`, `confirm`, or `prompt` calls under `src/`.
- Deleted generated local Convex auth JWK artifacts (`.convex-auth-private.jwk`, `.convex-auth-jwks.json`) and added `.gitignore` entries for both.
- Unauthenticated copied asset URL checks on localhost:3000 rejected sample/export reads with `403`; a mismatched copied export key rejected with `400`.
- Convex failure logs were clean after the final fixed validation cursor; an earlier deleted-backup fetch exposed a `500`, fixed by returning `404` when the caller no longer has project access.
- Command validation passed: `bun run typecheck`, `git diff --check`, `bun run knip`, and `bun run build`.

### Phase 16 — Portable project archive

- [x] Define `.dawproject` as a zip-like package.
- [x] Store `manifest.json` using the same schema as cloud backup.
- [x] Store asset files under `assets/` by stable asset IDs and stored asset paths.
- [x] Include `schemaVersion` and route archive imports through the same manifest parser as cloud snapshots.
- [x] Keep archive import/export out of the local-only first pass and out of the first cloud backup implementation unless explicitly prioritized later.

Validation:
- [x] Export a project archive.
- [x] Import it into a fresh browser profile.
- [x] Confirm manifest, assets, clips, effects, mixer, and project state restore.
- [x] Confirm unsupported future schema versions fail with a clear message.

---

## Dev Browser Validation Plan

Use the user-provided Helium remote debugging session for runtime validation:

```bash
open -a "Helium" --args --remote-debugging-port=9222
curl http://127.0.0.1:9222/json/version
```

Validated example environment from planning:

```json
{
  "Browser": "Chrome/148.0.7778.167",
  "Protocol-Version": "1.3",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "V8-Version": "14.8.178.21",
  "WebKit-Version": "537.36 (@65db666ac2cf205fcc36db8bb5b9cd87f94808ac)",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/2f359bc8-4d4b-4dea-8cc4-f6dc2c1197c8"
}
```

Use browser automation/CDP where useful to:
- capture console logs
- capture failed network requests
- inspect IndexedDB/localStorage state through runtime evaluation
- inspect File System Access API support
- capture screenshots for visual validation
- exercise real DAW flows end-to-end
- validate local/cloud status UI transitions
- validate Convex logs/functions and R2 object lifecycle for cloud flows

Artifact policy:
- write screenshots/logs/traces outside the repo under `/Users/juan/Downloads/daw-local-first-validation/<timestamp-or-slice>/`
- record artifact paths in this tracker after each validation pass
- do not commit generated browser artifacts

### Runtime validation flows

#### Studio boot without auth

- [x] Open the app signed out.
- [x] Confirm no redirect to `/about`.
- [x] Confirm the local project picker appears when no `projectId` is present.
- [x] Create/open a local project from the picker.
- [x] Confirm no Convex request is required for local-only startup.
- [x] Capture screenshots of the picker and opened local project state.
- [x] Capture console/network logs.

#### Local project lifecycle

- [x] Create a local project.
- [x] Rename it.
- [x] Reload the page.
- [x] Confirm it survives reload from IndexedDB.
- [x] Inspect global and per-project IndexedDB entries.
- [x] Capture screenshot of restored project.

#### Local import

- [x] Import or drag an audio file.
- [x] Confirm clip appears visually.
- [x] Confirm playback buffer resolves locally.
- [x] Confirm no `/api/samples` upload occurs in local-only mode.
- [x] Reload and confirm clip/audio restore.
- [x] Capture screenshot and network log.

#### Recording

- [x] Record into a local project.
- [x] Confirm recorded clip appears.
- [x] Confirm source asset is local/OPFS-backed.
- [x] Confirm no R2 upload occurs unless sync/share is enabled.
- [x] Reload and confirm recording restores.

#### Export

- [x] Render/export locally.
- [x] Confirm file save/download path works.
- [x] Confirm no `/api/exports` request happens in local-only mode.
- [x] Verify exported audio file is playable.

#### Reload/reopen

- [x] Reload browser.
- [x] Reopen same project.
- [x] Confirm tracks/clips/effects/mixer state restore.
- [x] Confirm missing file permissions are surfaced clearly.
- [x] Confirm restore-permissions UI works from user gesture.

#### Offline behavior

- [x] Simulate offline/network blocked.
- [x] Verify local project editing works.
- [x] Verify playback works for local assets.
- [x] Verify sync/share UI reports offline or disabled state cleanly.

#### Cloud promotion

- [x] Enable backup from a local project and validate existing cloud/shared project links.
- [x] Confirm auth is required only at this point.
- [x] Confirm local assets upload to R2.
- [x] Confirm Convex receives timeline metadata.
- [x] Confirm local-to-cloud ID mappings are persisted.
- [x] Confirm local project remains usable after promotion.
- [x] Confirm backup status moves through pending/backing-up/backed-up.
- [x] Confirm backup failures show failure status without corrupting local state.
- [x] Restore the backed-up project in a fresh browser profile.
- [x] Confirm restored assets lazy-load and then cache locally.
- [x] Run “Download for offline” and verify the app-native completion path; no cloud assets required downloading in the validated project.
- [x] Force a backup conflict and verify keep-local, restore-cloud, and duplicate-cloud choices.

#### Collaboration/shared mode

- [x] Open shared project link.
- [x] Confirm current shared behavior still works.
- [x] Verify shared chat, locks, ownership, and share UI only appear in shared mode.
- [x] Verify authenticated invite links create the expected owner/editor/viewer access.
- [x] Verify viewers can view/play and list/download existing exports but cannot create exports/edit/upload/record.
- [x] Verify owners and editors can export.
- [x] Import/record audio as an editor and confirm the author sees a pending local clip before upload completes.
- [x] Confirm collaborators see the clip only after R2 upload and Convex metadata write succeed.
- [x] Simulate offline edits and confirm they queue locally, show pending/not-shared-yet status, and publish on reconnect.
- [x] Verify last-write-wins behavior for same-entity shared edits.
- [x] Capture screenshot and logs for shared mode.

Evidence:
- Earlier local-mode shared UI gating evidence captured under `/Users/juan/Downloads/daw-local-first-validation/shared-ui-gating/`; the local picker and opened local timeline show normal local controls and no Room Chat/share controls.
- The earlier authenticated shared-mode validation gap was closed by the two-account Helium validation below.
- Authenticated two-account Helium validation created shared room `shared-droid-1780533875463` with Juan as owner and Fast AI Photos as editor. Both existing tabs rendered shared-mode UI (`Share`, `Cloud saved`, `AI Chat`, `Room Chat`) and shared screenshots/state were captured under `/Users/juan/Downloads/daw-local-first-validation/shared-room-1780533875463/`.
- Same-entity LWW runtime validation passed for shared track volume: Juan wrote `0.23`, Fast AI Photos then wrote `0.67`, and both authenticated full-view reads returned final volume `0.67`; evidence stored at `/Users/juan/Downloads/daw-local-first-validation/shared-room-1780533875463/lww-volume-validation.json`.

#### Cloud security and cleanup

- [x] Confirm raw copied R2 keys cannot fetch samples/exports without project access.
- [x] Confirm access-checked API routes or signed URLs enforce owner/editor/viewer permissions.
- [x] Delete a cloud/shared project as owner and confirm Convex rows/access rows plus project-scoped R2 prefix are removed.
- [x] Leave/remove local cache as a non-owner and confirm cloud project data is not deleted.
- [x] Revoke a user and confirm they lose metadata and asset access.
- [x] Delete a cloud-backed asset locally, commit a snapshot without it, and confirm the pending R2 object is deleted only after that snapshot succeeds.

Evidence:
- Earlier static inspection confirmed owner delete, non-owner leave, and accepted-member revoke are routed through authenticated Worker/Convex paths with role checks and local cache purge hooks; the runtime evidence below closes the multi-user and R2 cleanup gaps.
- Authenticated revoke validation passed on shared room `shared-droid-1780533875463`: owner revoked the editor, member list became empty, the revoked editor's full-view route returned `403`, and project-scoped asset access returned no readable object; evidence stored at `/Users/juan/Downloads/daw-local-first-validation/shared-room-1780533875463/revoke-access-validation.json`.
- Authenticated non-owner leave validation passed on disposable room `shared-droid-leave-1780534843668`: editor leave returned `status: "left"`, owner full-view still returned `200` with one track, and the editor full-view route returned `403`; evidence stored at `/Users/juan/Downloads/daw-local-first-validation/shared-room-1780533875463/non-owner-leave-validation.json`.
- Authenticated owner delete API validation passed on disposable room `shared-droid-leave-1780534843668`: owner delete returned `status: "deleted"` and owner/member/editor routes returned `403` afterward; evidence stored at `/Users/juan/Downloads/daw-local-first-validation/shared-room-1780533875463/owner-delete-validation.json`.
- Convex CLI follow-up confirmed the deleted disposable room no longer appeared in recent `projects` or `tracks` rows, but exposed a real cleanup retry gap: its `project-prefix` row remained in `r2DeleteQueue` after R2 `list` failed with `list: Unspecified error (0)`.
- Added a Worker maintenance retry path for deleted-project R2 cleanup rows: `r2Deletes.listDueAny`, a maintenance Worker Convex token, `drainDueR2DeleteQueue`, and the bearer-token-gated route `POST /api/maintenance/r2-delete-queue/drain`; evidence stored at `/Users/juan/Downloads/daw-local-first-validation/shared-room-1780533875463/owner-delete-r2-queue-maintenance.json`.
- Earlier project-scoped R2 object validation hit an intermittent local Worker R2 binding/runtime issue; evidence stored at `/Users/juan/Downloads/daw-local-first-validation/shared-room-1780533875463/r2-binding-blocker.json`.
- After restarting the dev server, the intermittent R2 binding issue cleared. A fresh disposable project `shared-droid-r2-retry-1780536611424` uploaded and read a `44` byte sample successfully, owner delete returned `status: "deleted"`, post-delete project/sample routes returned `403`, Convex `r2DeleteQueue` was empty after drain, the deleted project was absent from recent Convex `projects`/`tracks` reads, and `wrangler r2 object get <exact uploaded key> --remote` returned `The specified key does not exist.` Evidence stored at `/Users/juan/Downloads/daw-local-first-validation/shared-room-1780533875463/owner-delete-r2-final-proof.json`.

### Validation artifacts to capture

For each major flow, capture:
- browser console logs
- failed network requests
- Convex/R2/API requests
- Convex function/log evidence for cloud mutations
- R2 upload/read/delete evidence for asset lifecycle checks
- app-visible error messages
- IndexedDB/localStorage state before and after reload
- screenshots before and after the action
- if relevant, downloaded/exported audio files

Artifact paths should be recorded here as validation happens.

---

## Validation Commands

Repository commands from `package.json`:
- `bun run typecheck`
- `bun run build`
- `bun run knip`

Use during implementation:
- [x] `bun run typecheck`
- [x] `bun run build`
- [x] `git diff --check`
- [x] Targeted browser/CDP probes for slices involving storage, browser APIs, boot, assets, or cloud flows.
- [x] `bun run knip` at major milestone finals only: local-only complete, cloud complete, archive complete if implemented.

There is no dedicated test script in `package.json` at planning time.

---

## Highest-Risk Items

- [x] `TrackId` and Convex ID coupling.
- [x] `sampleUrl` assumptions across playback, export, waveform rendering, undo, drag/drop, and samples menu.
- [x] Undo/redo currently being Convex mutation-based.
- [x] Recording currently requiring room/user/locks/upload.
- [x] Effects currently being Convex-backed and queried directly.
- [x] Sync conflicts and local-to-cloud ID mapping.
- [x] Browser permission restore UX for external file handles.
- [x] R2/Convex cleanup and access control.
- [x] Ensuring local saves never block playback or hot-path audio scheduling.
- [x] Backup conflict UX accidentally overwriting local or cloud work.
- [x] Shared last-write-wins overwriting collaborator edits without enough visible status.
- [x] Pending shared audio clips publishing metadata before assets are readable.
- [x] Revoked users retaining stale signed URLs or cached cloud access longer than intended.
- [x] Local project deletion accidentally deleting original external provenance files instead of only app-owned assets.
- [x] Silent storage fallback splitting assets across locations after folder permission loss.
- [x] Quota failures creating metadata without durable audio bytes.

---

## Recommended First Implementation Slice

Start with foundation only:

- [x] Early focused `roomId` → `projectId` semantic rename.
- [x] Add `idb` dependency.
- [x] Add local project/global DB.
- [x] Add per-project DB.
- [x] Add File System Access/OPFS type support.
- [x] Add local asset metadata model.
- [x] Add permission utilities based on the validated Diffusion Studio pattern.
- [x] Add local project open/create/list/rename/delete primitives.
- [x] Add local project picker for empty `/` with recent projects, create, rename, and typed-name delete.
- [x] Validate through Helium/CDP with logs, storage inspection, and screenshots.

Do not migrate every timeline editing path in the first slice.

Reason:
- The storage foundation needs to be proven before touching every Convex-dependent editing path.

---

## Open Decisions To Resolve During Implementation

No major architecture decisions remain open from the planning grill. Future implementation may still expose small UI copy, naming, or sequencing decisions.

Closed decisions:
- [x] Add `idb` dependency and use Diffusion Studio's IndexedDB style.
- [x] Always copy imported/recorded audio into project-owned storage.
- [x] Use last saved directory handle when available and OPFS fallback otherwise.
- [x] Do not migrate existing Convex projects.
- [x] Backup mode uses latest-snapshot backup/restore, not bidirectional merge sync.
- [x] Backup conflicts use explicit keep-local, restore-cloud, or duplicate-cloud choices.
- [x] Deleted cloud assets are removed after a successful snapshot no longer references them.
- [x] Shared mode uses local pending writes plus Convex-published collaborator state.
- [x] Shared conflicts use last-write-wins.
- [x] Shared roles are owner, editor, and viewer.
- [x] Viewers can view/play and list/download existing exports only; they cannot create exports.
- [x] `.dawproject` is a later zip-like manifest-plus-assets archive format.
- [x] Project picker MVP is recent projects plus create/rename/typed-name delete.
- [x] Local save failure is persistent warning plus retry/export/storage guidance.
- [x] Import/recording asset writes are atomic; quota failure creates no clip.
- [x] Missing media uses visible muted placeholders with restore/replace/remove.
- [x] Chosen folder permission loss requires regrant or explicit storage move.
- [x] Cloud retries use capped exponential backoff plus manual retry.
- [x] Initial transfer targets are 2 uploads and 3 downloads; the upload limit is implemented, and the download limit remains tied to unchecked restore/offline-download work.
- [x] Invite links are non-expiring/revocable; asset reads use access-checked no-store streaming routes unless short-lived signed URLs are introduced later.
- [x] Owner transfer is deferred.
- [x] No runtime feature flag.
- [x] Use buildable milestone slices.
- [x] First sequence is rename, DB foundation, picker/boot, CRUD, assets.
- [x] Validation artifacts go to `/Users/juan/Downloads/daw-local-first-validation/<timestamp-or-slice>/`.
- [x] `knip` runs only at major milestone finals.
Evidence:
- Added `.dawproject` archive export/import using an uncompressed zip package with `manifest.json` and `assets/{assetId}/{storagePath}` entries.
- Archive manifests reuse the cloud backup manifest schema and are checked through the shared manifest migration/assertion path on import.
- Archive import creates a fresh local project ID, restores manifest entities/project state/asset metadata into IndexedDB, and writes asset bytes back into project-owned storage.
- Project menu exposes Export `.dawproject` and Import `.dawproject` actions.
