# Export Performance Improvements Tracker

> Created: 2026-06-07
> Branch: `export-performance-improvements`
> Base branch: `origin/master` after PR #11 merge
> Scope: execution-safe follow-up plan for optimizing multi-stem export rendering without changing export behavior.
>
> 1. Reuse pure stem render setup across all-stems exports.
> 2. Preserve current mixdown/stem audio output semantics.
> 3. Keep per-stem `OfflineAudioContext` and Web Audio nodes fresh.
> 4. Validate with automated checks and targeted browser smoke evidence.

## Purpose

This tracker captures the follow-up performance work intentionally deferred from PR #11.

It exists to:

- keep the next branch focused on export performance only
- avoid mixing correctness fixes with broad audio-engine architecture work
- ground the plan in the current DAW export code after PR #11 merged
- borrow Diffusion's "prepared encoder/session" shape without copying video-only complexity
- preserve current local/cloud/stem export behavior while reducing repeated setup work
- provide a phase-by-phase implementation and validation sequence

This tracker should be updated during the branch with implementation notes, rejected candidates, browser/runtime evidence, review findings, and final validation artifacts.

---

## Branch

- Current branch: `export-performance-improvements`
- Base branch: `origin/master`
- Created after PR #11 merged into `master`.
- Source PR that produced this follow-up: PR #11, `export-refactor`.

---

## References

- Repo: `/Users/juan/Documents/daw-browser-convex`
- Diffusion reference repo: `/Users/juan/Documents/monorepo-new`
- Diffusion reference files:
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/encoder.ts`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/buffer.ts`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/format.ts`
- Current DAW export files:
  - `packages/audio-engine/src/export-mixdown.ts`
  - `packages/audio-engine/src/mixer/channels.ts`
  - `packages/audio-engine/src/mixer/resolve-routing.ts`
  - `packages/audio-engine/src/mixer/apply-offline-routing.ts`
  - `src/lib/export/run-export-job.ts`
- MDN `OfflineAudioContext`: <https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext>
- MediaBunny docs: <https://mediabunny.dev/guide/writing-media-files>

---

## Current State

PR #11 added format-aware export, local direct-to-file streaming, cloud export metadata persistence, progress UI, cancellation for abort-aware phases, and initial source-track stem export.

Pre-change all-stems flow:

1. `src/lib/export/run-export-job.ts` collects renderable stem tracks.
2. For each stem, it calls `exportMixdown.renderStemMixdown(...)`.
3. `packages/audio-engine/src/export-mixdown.ts` calls `renderSourceIsolatedMixdown(...)`.
4. Each stem render recomputes:
   - `computeRangeSec(...)`
   - `createTimelineTrackIndex(tracks)`
   - `createMixerChannels(tracks)`
   - `resolveMixerGraph(...)`
5. Each stem still correctly creates a fresh `OfflineAudioContext`, fresh mixer nodes, schedules clips/MIDI, and calls `startRendering()`.

The repeated pure setup is not a correctness issue, but it creates unnecessary work for large all-stems exports.

Final implementation creates one prepared stem render session per stem export, stores a local `trackById` map and resolved mixer graph once, then calls `renderTrackStem(track)` for each stem while still creating fresh Web Audio resources per render.

---

## Diffusion Pattern To Borrow

Diffusion creates an encoder/session object that prepares stable execution context once, then uses that context during render:

```ts
const encoder = await createEncoder(world, config)
const result = await encoder.render()
```

DAW applicability:

- Create a small audio-engine stem render session.
- Precompute pure derived export data once per stem export batch.
- Keep per-render Web Audio resources fresh because `AudioNode`s belong to one `BaseAudioContext`.
- Keep the app runner simple: load buffers/effects, create the session, render and encode each stem sequentially.

Do not copy Diffusion's video frame loop, ECS world cloning, canvas sources, or audio worklet streaming into this DAW audio export path.

---

## Target Architecture

Add a prepared stem render session in `packages/audio-engine/src/export-mixdown.ts`:

```ts
export function createStemRenderSession(req: ExportRequest): {
  renderTrackStem: (track: Pick<Track<AudioBuffer>, 'id' | 'name'>) => Promise<AudioBuffer>
}
```

Internal shape:

```ts
type PreparedExportRender = {
  bpm: number
  range: {
    startSec: number
    endSec: number
    durationSec: number
  }
  sampleRate: number
  numberOfChannels: number
  trackById: Map<string, Track<AudioBuffer>>
  mixerGraph: ResolvedMixerGraph
  signal?: AbortSignal
}
```

Use the prepared render for stems:

```txt
prepare range + trackById + mixer graph once
render stem 1 with fresh OfflineAudioContext/nodes
render stem 2 with fresh OfflineAudioContext/nodes
render stem 3 with fresh OfflineAudioContext/nodes
```

Do not attempt to reuse:

- `OfflineAudioContext`
- `AudioNode`s
- `AudioBufferSourceNode`s
- `OscillatorNode`s
- scheduled MIDI/audio source nodes

Those must remain per-render.

---

# Implementation Plan

## Phase 1 — Split pure render preparation from per-render Web Audio work

- [x] Add an internal `prepareExportRender(req)` helper in `packages/audio-engine/src/export-mixdown.ts`.
- [x] Move pure setup into the helper:
  - range calculation
  - duration/length inputs
  - sample rate/channel defaults
  - track ID lookup map
  - mixer graph resolution
- [x] Keep the helper pure and deterministic.
- [x] Do not change `renderMixdown(...)` output behavior.

Rules:

- No behavior changes to range handling.
- No changes to effect mapping or routing semantics.
- No shared mutable module state.

## Phase 2 — Render from prepared setup

- [x] Add an internal `renderSourceIsolatedMixdownFromPrepared(...)` helper.
- [x] It should receive the prepared render data plus:
  - optional `sourceTrackIds`
  - `includeMasterFx`
  - `AbortSignal`
- [x] It should create a fresh `OfflineAudioContext` for each call.
- [x] It should create fresh offline mixer nodes for each call.
- [x] It should schedule the same audio clips and MIDI events as the current implementation.
- [x] It should preserve abort checks before and after `startRendering()`.

Rules:

- Do not reuse Web Audio nodes across renders.
- Do not change source isolation behavior.
- Do not change master FX inclusion behavior.

## Phase 3 — Add a stem render session API

- [x] Add `createStemRenderSession(req)` to `packages/audio-engine/src/export-mixdown.ts`.
- [x] The session should prepare once and expose `renderTrackStem(track)`.
- [x] Keep `renderStemMixdown(req)` as a compatibility wrapper around the session for any one-stem callers.
- [x] Keep `renderMixdown(req)` working through the prepared render path.

Rules:

- Keep package public API small.
- Do not introduce a separate package export path for this follow-up.
- Avoid exporting extra types unless the app needs them directly.

## Phase 4 — Use the session in app stem export

- [x] Update `src/lib/export/run-export-job.ts` so `runStemExport(...)` creates one render session after buffers/effects are loaded.
- [x] Use `session.renderTrackStem(track)` inside the existing per-stem loop.
- [x] Preserve current progress reporting:
  - current stem name
  - completed stem count
  - encoding bytes
- [x] Preserve current per-stem encode/write behavior.

Rules:

- Do not batch all rendered stem buffers in memory.
- Render one stem, encode/write it, then continue.
- Keep stem output filenames unchanged.

## Phase 5 — Validate and review

- [x] Run `bun run typecheck`.
- [x] Run `bun run knip`.
- [x] Run `git diff --check`.
- [x] Run `bun run build`.
- [x] Run or document a targeted browser smoke for selected/all stems if the dev server/browser context is available.
- [x] Review the final diff for duplicate setup, dead helper code, and unchanged mixdown behavior.

---

## Expected Non-Goals

- Do not parallelize stem rendering.
- Do not stream stems directly from `OfflineAudioContext` render quanta.
- Do not rewrite mixer routing.
- Do not add master/group/return stem modes in this branch.
- Do not change cloud upload behavior.
- Do not change local file picker behavior.
- Do not introduce benchmark-only instrumentation into production code.

---

## Validation Log

Record commands and results here as implementation progresses.

- [x] Implementation completed 2026-06-07:
  - Added prepared export render setup in `packages/audio-engine/src/export-mixdown.ts`.
  - Added `createStemRenderSession(req)` with a consumer-shaped `renderTrackStem(track)` API and kept `renderStemMixdown(req)` as a compatibility wrapper.
  - Updated `src/lib/export/run-export-job.ts` to create one stem render session per stem export and render/encode stems sequentially.
  - Preserved fresh `OfflineAudioContext` and mixer node creation per render; no rendered stem buffers are batched.
- [x] Simplify review completed 2026-06-07:
  - Kept the session API focused on the app's real all-stems caller.
  - Replaced the full timeline track index with a local `trackById` map because rendering only needs track lookup by ID.
  - Added an early abort check before prepared render setup.
- [x] `bun run typecheck` — passed.
- [x] `bun run knip` — passed.
- [x] `git diff --check` — passed.
- [x] `bun run build` — passed.

---

## Browser Smoke Log

Record browser evidence here if available.

- [ ] Selected-stem export still succeeds.
- [ ] All-stems export still writes expected stem files.
- [ ] Cancel remains hidden during rendering and available during abort-aware phases.
- [x] Browser smoke skipped: no dev server/browser export flow was available in this subagent context. Automated validators passed.
