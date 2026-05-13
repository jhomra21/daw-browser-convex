# Audio Refactor Branch Tracker

Completed work tracked from `audio-engine-refactor` relative to `origin/master`.

## Branch / Project Guidance

- [x] Added Solid-specific agent guidance in `AGENTS-solid.md`.
- [x] Updated root project guidance for the current Solid, TypeScript, and explicit-UI conventions.
- [x] Added consistency and simplification guidance files for future refactor passes.
- [x] Added `knip` configuration and package scripts for unused dependency/export checks.
- [x] Updated dependency lockfile and TypeScript configuration for the refactor.
- [x] Updated README and supporting notes touched during the branch.

## API / Agent Commands

- [x] Split agent command execution out of `api/index.ts` into `api/agent-actions.ts`.
- [x] Added centralized command target helpers in `src/lib/agent-command-targets.ts`.
- [x] Added API-side clip target validation in `api/clip-targets.ts`.
- [x] Centralized API track/clip indexing helpers in `api/indexing.ts`.
- [x] Added agent support for creating and deleting tracks.
- [x] Added agent support for track volume, mute, solo, and routing changes.
- [x] Added agent support for MIDI clip creation and editing.
- [x] Added agent support for sample/audio clip creation, movement, copy, and bulk removal.
- [x] Added agent support for EQ, reverb, synth, arpeggiator, and timing commands.
- [x] Updated agent chat execution to use the refactored command pipeline.
- [x] Removed the legacy `/api/test` Hono endpoint.

## Convex Data Model / Access Control

- [x] Added `convex/roomAccess.ts` for shared room and project access checks.
- [x] Updated shared chat reads and writes to require room access.
- [x] Added `mixerChannels` as the shared mixer-state table.
- [x] Moved track volume, mute, solo, lock, and routing state into mixer channel records.
- [x] Added mixer-channel helpers for stale lock normalization and merged track views.
- [x] Added an idempotent mixer-channel backfill mutation for pre-refactor track rows.
- [x] Updated timeline full-view reads to return tracks merged with mixer-channel state.
- [x] Added sanitized track routing mutations for output targets and sends.
- [x] Added routing-reference cleanup when tracks are deleted.
- [x] Added track write/access helpers in `convex/trackWrites.ts`.
- [x] Added clip write/access helpers in `convex/clipWrites.ts`.
- [x] Enforced clip ownership for move, timing, MIDI, remove, and bulk remove mutations.
- [x] Added audio/instrument clip-kind compatibility checks.
- [x] Expanded clip creation and batch creation to persist source metadata and MIDI payloads.
- [x] Added sample-row upsert support from created audio clips.
- [x] Added normalized sample-library persistence in `convex/sampleRows.ts`.
- [x] Updated sample removal to use ownership-aware room access.
- [x] Guarded master effect writes with room access.
- [x] Guarded track effect writes with explicit ownership/write access checks.
- [x] Expanded project cleanup for tracks, clips, markers, effects, samples, exports, and ownerships.
- [x] Added project delete/preflight status handling for access-denied and conflict cases.
- [x] Updated project list, ensure, and delete flows to include rooms available through ownerships.
- [x] Added schema indexes for mixer channels, room track lookup, samples, and ownership access.
- [x] Regenerated Convex API typings for the new modules and functions.

## Timeline Orchestration / State

- [x] Refactored `src/components/Timeline.tsx` into a thinner hook-driven orchestration component.
- [x] Moved timeline panel composition into `src/components/timeline/timeline-panels.tsx`.
- [x] Moved timeline overlay composition into `src/components/timeline/timeline-overlays.tsx`.
- [x] Added projected timeline model state for optimistic clip and track rendering.
- [x] Added resolved timeline model state for routing, mix, and pending shared updates.
- [x] Added timeline identity handling for room, user, ownership, and writable track scopes.
- [x] Added timeline preferences for grid, snap, zoom, loop, sidebar, and view settings.
- [x] Added per-room persisted state for UI and local mix preferences.
- [x] Added sidebar resize behavior with bounded width constraints.
- [x] Added high-level timeline action orchestration in `useTimelineActions`.
- [x] Added selection state for clips, tracks, effects targets, and the master target.
- [x] Added pure timeline selection reconciliation helpers.
- [x] Added timeline selection gesture handling for lanes and clip groups.
- [x] Added MIDI overlay orchestration for opening, closing, bounds, and clip linkage.

## Timeline UI / Controls

- [x] Updated track sidebar controls for selection, routing, locks, ownership, and record-arm state.
- [x] Updated track lanes to consume multi-selection and drag/resize handlers.
- [x] Updated clip components for selection groups, MIDI clip opening, and drag interactions.
- [x] Added timeline drag/drop state for root file drags and new-track drop targeting.
- [x] Refactored clip drag behavior around placement utilities and multi-drag snapshots.
- [x] Refactored clip resize behavior for selection-aware timeline updates.
- [x] Refactored clip import flows for files, samples, and inserted sample payloads.
- [x] Added project samples hook updates for sample loading and menu integration.
- [x] Added samples menu controller for sample picker state and actions.
- [x] Added projects menu controller for rename, delete, focus, and escape behavior.
- [x] Added exports menu controller and project export state wiring.
- [x] Added share menu controller for room URL opening, copying, and copied state.
- [x] Updated transport controls for project, sample, export, share, tempo, loop, and record actions.
- [x] Added transport tempo controller for BPM editing and persisted tempo changes.
- [x] Updated playhead controls for loop-aware transport behavior.
- [x] Updated timeline styling for panels, overlays, menus, and layout polish.
- [x] Removed the orphaned `AudioRecorder` component.
- [x] Removed the orphaned `VisualEqualizer` component.

## Effects Panel / Parameters

- [x] Added effects-panel target resolution for master, track, group, return, and instrument targets.
- [x] Added effects-panel audio sync for persisted EQ, reverb, synth, and arpeggiator state.
- [x] Added persisted effect draft state for local UI edits before commits.
- [x] Updated effects panel routing UI for sends, output targets, write permissions, and history commits.
- [x] Refactored EQ, reverb, synth, arpeggiator, and synth-card components around the new state shape.
- [x] Extracted reusable EQ, reverb, arpeggiator, and parallel FX chain helpers.
- [x] Removed legacy synth `wave` compatibility serialization in favor of normalized `wave1` / `wave2` params.

## Audio Engine / Scheduling

- [x] Split shared audio scheduling helpers into `src/lib/audio-scheduling.ts`.
- [x] Centralized playable audio-window trimming for clip start, left pad, buffer offset, range start, and end limits.
- [x] Centralized MIDI event scheduling for clip bounds, MIDI offsets, range starts, and end limits.
- [x] Refactored the audio engine around shared scheduling, effects, routing, and mixer utilities.
- [x] Routed live track audio through the resolved mixer graph instead of directly to master.
- [x] Added per-track send gain nodes for return routing.
- [x] Added cleanup for removed mixer nodes, send gains, EQ chains, reverb chains, and meter analysers.
- [x] Applied track and master EQ/reverb through shared effects chain helpers.
- [x] Refactored synth scheduling through shared synth voice helpers and normalized synth params.
- [x] Applied arpeggiator processing before MIDI note scheduling.
- [x] Added targeted clip rescheduling for changed clip IDs at the current playhead.

## Mixer / Routing

- [x] Added mixer channel projection from tracks in `src/lib/mixer/channels.ts`.
- [x] Added mixer graph resolution for outputs, sends, mute, solo, master FX, and per-track FX.
- [x] Added live mixer graph application for track gains, output gains, group outputs, returns, and meters.
- [x] Added offline mixer graph creation for export rendering.
- [x] Added routing rules that only normal tracks can send to returns.
- [x] Added routing rules that only track and return channels can output to groups.
- [x] Prevented group channels from routing to other group outputs.
- [x] Normalized routing by dropping self-routes, invalid targets, and near-zero sends.
- [x] Updated solo routing so dry paths and relevant return paths remain audible while unrelated outputs mute.
- [x] Added mutation argument builders and equality helpers for persisted routing updates.

## Clips / Sources / Samples

- [x] Added audio source metadata normalization for asset keys, source kind, duration, sample rate, and channel count.
- [x] Added persisted audio source metadata shapes for upload, URL, and recording sources.
- [x] Required complete source metadata for audio clip creation.
- [x] Added server payload builders for clip source metadata and timing fields.
- [x] Primed waveform assets after clip decode and upload workflows.
- [x] Added batch clip creation with local snapshot to server-ID mapping.
- [x] Added sample upload helper with explicit `sample-upload-failed` handling.
- [x] Added clip sample URL and clip mutation argument helpers.
- [x] Rejected incompatible audio/MIDI clip moves based on target track kind.
- [x] Added multi-clip drag and duplicate placement with relative positions, grid quantization, and overlap avoidance.
- [x] Added default sample cache helpers.
- [x] Added sample buffer loader with per-URL pending, ready, and failed load states.
- [x] Deduplicated concurrent sample buffer loads for the same URL.
- [x] Added sample fetch retry and retry-after backoff behavior.
- [x] Added sample loader cache invalidation and full cache clearing.

## Waveforms / Peaks

- [x] Removed the legacy `src/lib/waveform.ts` Float32 peak and sprite cache implementation.
- [x] Added the `src/lib/audio-peaks` asset, chunk, extraction, storage, render, resample, and selection pipeline.
- [x] Added multi-resolution peak extraction at 400, 100, and 25 peaks per second.
- [x] Added two-second peak chunking for waveform assets.
- [x] Added byte-quantized min/max peak storage.
- [x] Added IndexedDB storage for peak asset metadata and chunk data.
- [x] Added in-memory caches and pending-load deduping for peak records and chunks.
- [x] Added waveform asset priming from existing `AudioBuffer` values and decoded sample URLs.
- [x] Added waveform window selection that picks an appropriate peak level, loads required chunks, fills missing bins with silence, and resamples to requested bins.
- [x] Added canvas waveform drawing from byte-encoded peak data.

## Recording

- [x] Added recording support detection across WebM, Ogg, and MP4 MediaRecorder MIME types.
- [x] Added recording session helpers for track locking, lock release, and lock heartbeat.
- [x] Refactored recording cleanup to stop recorders, media tracks, preview analysis, analysis contexts, preview state, and locks.
- [x] Updated recording target selection to prefer armed compatible unlocked audio tracks.
- [x] Added recording fallback to any compatible unlocked audio track before creating a new track.
- [x] Committed auto-created recording tracks to history only when retained or when automatic discard fails.
- [x] Deleted empty auto-created recording tracks on failed recording cleanup when possible.

## Export / Mixdown

- [x] Updated export mixdown to resolve the same mixer graph used by live playback.
- [x] Added offline mixer nodes with track FX, master FX, sends, group outputs, mute, solo, and volume applied.
- [x] Rendered MIDI clips through shared synth voice scheduling.
- [x] Applied arpeggiator processing before offline MIDI rendering.
- [x] Rendered audio clips through shared playable-window timing with trim and offset handling.
- [x] Preserved WAV output encoding through `encodeAudioBuffer`.

## Undo / History

- [x] Added history builders for track create/delete, track volume, mute, solo, routing, effects, clip delete, clip move, and clip timing.
- [x] Added stable clip and track history refs instead of relying only on current server IDs.
- [x] Added history ref resolution for recreated clips and tracks.
- [x] Validated room IDs before undo/redo entry execution.
- [x] Updated clip create undo/redo to remove and recreate clips through current Convex payload paths.
- [x] Updated clip delete undo/redo to recreate deleted clips, sync recreated IDs, and remove recreated clips.
- [x] Added multi-clip move history with clip rescheduling after replay.
- [x] Added clip timing history for start, duration, left pad, buffer offset, and MIDI offset.
- [x] Added track create/delete undo and redo through Convex mutations and local track actions.
- [x] Restored mix state, routing, effects, and clips during track delete undo.
- [x] Added routing undo/redo through normalized `tracks.setRouting` payloads.
- [x] Added effect undo/redo for track EQ, reverb, synth, arp, master EQ, and master reverb.
- [x] Added persisted history migration and normalization for ref-based clip, track, routing, timing, and effect entries.
- [x] Removed older undo execution paths based on broad untyped Convex API casts and direct local `setTracks` mutations.

## Auth / Sharing / Routing UI

- [x] Added auth redirect helpers and tightened login redirect handling.
- [x] Updated root and index route wiring touched by the auth/share flow.
- [x] Updated timeline share helpers for the refactored room/project state.
- [x] Added optimistic grant scope helpers.
- [x] Added delete conflict message helpers.

## Static UI / Cleanup

- [x] Rewrote the about page as explicit JSX with small local wrapper components.
- [x] Moved about-page entrance and reveal motion into shared CSS.
- [x] Standardized several UI primitives around `cn` class composition.
- [x] Applied small layout and Tailwind cleanup across chat, effects, MIDI, timeline, and shared UI components.
- [x] Added file-system access type declarations.
