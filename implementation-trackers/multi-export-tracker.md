# Multi-Format Export Tracker

> Created: 2026-06-07
> Branch: `multi-export`
> Base branch: local `master` after `export-performance-improvements` merge
> Scope: let users request more than one export audio format in a single export operation while reusing render work.
>
> 1. Treat multi-format export as one higher-level export job, not N independent render jobs.
> 2. Render mixdowns/stems once per source, then encode/save once per selected format.
> 3. Preserve current single-format behavior when one format is selected.
> 4. Validate with automated checks and targeted browser smoke evidence.

## Purpose

This tracker captures the plan to add multi-format audio export for mixdowns and stems.

It exists to:

- keep the feature focused on export format fan-out only
- avoid rerendering the same mixdown or stem for each requested format
- preserve existing format support probing and disabled-format behavior
- keep local/cloud export semantics explicit
- provide a phase-by-phase implementation and validation sequence

This tracker should be updated during the branch with implementation notes, rejected candidates, browser/runtime evidence, review findings, and final validation artifacts.

---

## Branch

- Current branch: `multi-export`
- Base branch: local `master`
- Do not delete the completed `export-performance-improvements` branch.

---

## References

- Repo: `/Users/juan/Documents/daw-browser-convex`
- Diffusion reference repo: `/Users/juan/Documents/monorepo-new`
- Diffusion reference files:
  - `/Users/juan/Documents/monorepo-new/apps/web/src/context/export.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/export-progress.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/interfaces.ts`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/format.ts`
- Current DAW export files:
  - `src/components/timeline/ExportDialog.tsx`
  - `src/context/export.tsx`
  - `src/components/export/ExportProgressOverlay.tsx`
  - `src/lib/export/run-export-job.ts`
  - `src/lib/local-export.ts`
  - `src/lib/local-stem-export.ts`
  - `src/lib/export-format-support.ts`
  - `packages/audio-engine/src/export-mixdown.ts`
  - `packages/shared/src/export-audio-formats.ts`

---

## Current State

Current DAW export is single-format per queued job:

1. `ExportDialog` stores one `format: ExportAudioFormat`.
2. `enqueueTimelineExport(...)` / `enqueueStemExport(...)` enqueue one active job at a time.
3. `runTimelineExport(...)` renders one mixdown `AudioBuffer`, then calls `encodeAudioBuffer(rendered, { format })`.
4. `runStemExport(...)` creates one stem render session, then for each stem renders one `AudioBuffer` and calls `encodeAudioBuffer(stemBuffer, { format })`.
5. `encodeAudioBuffer(...)` already supports any single `ExportAudioFormat`.

Starting one queued export job per selected format would work mechanically, but it would repeat buffer prep, FX loading, and offline render work. The correct shape is one export job with multiple requested formats.

Diffusion currently appears single-format too:

1. `exportScene(sceneEid, config)` receives one `config.format`.
2. It opens one `showSaveFilePicker(...)`.
3. It creates one encoder through `createEncoder(world, { ...config, target, scene })`.
4. The progress overlay describes one container/codec configuration.

Diffusion is a useful negative reference here: do not copy a single-file export API when DAW audio export can fan out encodes from one rendered buffer.

---

## Target Architecture

Add multi-format fan-out at the app export orchestration layer:

```txt
mixdown:
  prepare/load once
  render one mixdown AudioBuffer
  encode + save WAV
  encode + save Ogg

stems:
  prepare/load once
  create one stem render session
  for each stem:
    render one stem AudioBuffer
    encode + save WAV
    encode + save Ogg
```

Keep `packages/audio-engine/src/export-mixdown.ts` and `encodeAudioBuffer(buffer, { format })` single-format. Multi-format export is a consumer concern, not a lower-level encoder contract.

For local mixdown exports:

- keep the existing single-format `showSaveFilePicker(...)` flow when exactly one format is selected
- use a directory picker when multiple formats are selected because one action creates multiple files

For local stem exports:

- keep using a directory picker
- save every selected format under the existing `stems` folder
- include each format extension in generated stem filenames

For cloud mixdown exports:

- render once
- encode/upload once per selected format
- persist metadata for each uploaded export
- return a success outcome that can summarize multiple saved/uploaded files

---

# Implementation Plan

## Phase 1 — Normalize requested formats

- [x] Replace the one-format dialog state with a small selected-formats state in `ExportDialog`.
- [x] Reuse `supportedFormats` so unsupported formats remain disabled.
- [x] Ensure at least one supported format is selected before enabling `Render & Save`.
- [x] Keep single-format default behavior as WAV.
- [x] Pass selected formats to export requests.

Rules:

- Do not allow unsupported formats to be submitted.
- Do not duplicate format metadata or support-probing logic.
- Do not convert static format UI into a broad config model; keep the UI explicit and local.

## Phase 2 — Extend export request/progress shapes

- [x] Update `TimelineExportRequest` to carry `formats: readonly ExportAudioFormat[]`.
- [x] Update `StemExportRequest` through the shared timeline request shape.
- [x] Update export context request types to accept selected formats.
- [x] Add progress fields for the current format and total/completed format counts.
- [x] Update `ExportProgressOverlay` so users can see which format is currently encoding/saving.

Rules:

- Preserve existing cancellation behavior.
- Keep one active queued job for the whole multi-format operation.
- Do not introduce parallel export jobs for each format.

## Phase 3 — Fan out mixdown encoding/saving

- [x] Update `runTimelineExport(...)` to render the mixdown once.
- [x] Encode/save each selected format sequentially from the same rendered buffer.
- [x] Preserve the existing single-format local file save flow.
- [x] Add a multi-format local directory-save flow for mixdowns.
- [x] Upload and persist metadata once per selected cloud format.
- [x] Return a success summary that remains useful for one or many outputs.

Rules:

- Do not rerun `renderMixdown(...)` per format.
- Do not hold encoded blobs longer than needed.
- Keep direct-to-file streaming when a local writable handle is available.

## Phase 4 — Fan out stem encoding/saving

- [x] Update `runStemExport(...)` to use selected formats.
- [x] Keep one prepared stem render session per export.
- [x] Render each stem once, then encode/save all selected formats for that stem.
- [x] Keep moving stem-by-stem so rendered stem buffers are not batched in memory.
- [x] Preserve unique stem filename handling across duplicate track names and formats.

Rules:

- Do not parallelize stem rendering.
- Do not render the same stem once per format.
- Do not change stem source-isolation behavior.

## Phase 5 — Validate and review

- [x] Run `bun run typecheck`.
- [x] Run `bun run knip`.
- [x] Run `git diff --check`.
- [x] Run `bun run build` if typecheck/knip pass.
- [ ] Run targeted browser smoke for:
  - single-format mixdown export
  - multi-format mixdown export
  - multi-format all-stems export
- [ ] Review the final diff for duplicate render paths, dead helpers, contract drift, and avoidable complexity.

---

## Expected Non-Goals

- Do not add video export support.
- Do not change MediaBunny encoder internals.
- Do not add parallel encoding unless the codebase already has a clear concurrency abstraction that makes it safe.
- Do not add new cloud storage concepts beyond saving/uploading one output per selected format.
- Do not change routing, FX, source isolation, range computation, or audio rendering semantics.
- Do not delete or rewrite the existing export queue.

---

## Validation Log

Record commands and results here as implementation progresses.

- [x] Plan validation complete — existing code confirmed single-format request state, one queued export job, mixdown single render before one encode, stem render session rendering each stem once, existing support probing in `ExportDialog`, and direct streaming targets in local export helpers.
- [x] Implementation complete — multi-format fan-out added at export orchestration layer without changing audio-engine encoder contracts.
- [x] `bun run typecheck` — passed.
- [x] `bun run knip` — passed.
- [x] `git diff --check` — passed.
- [x] `bun run build` — passed.

---

## Browser Smoke Log

Record browser smoke evidence here.

- [ ] Single-format mixdown export smoke blocked — native save picker/file-system export flow requires an interactive browser project with exportable audio content.
- [ ] Multi-format mixdown export smoke blocked — native directory picker/file-system export flow requires an interactive browser project with exportable audio content.
- [ ] Multi-format all-stems export smoke blocked — native directory picker/file-system export flow requires an interactive browser project with exportable audio content.

---

## Review Log

Record review findings here.

- [x] Final implementation review complete — no duplicate render paths introduced; mixdown and stem rendering remain single-render per source; audio-engine encoder contract stays single-format; no dead helpers or parallel job flow added.

## Implementation Notes

- `ExportDialog` now submits `formats` while keeping WAV selected by default and filtering selections through probed supported formats.
- `runTimelineExport(...)` renders once, then sequentially encodes each requested format; single-format local exports keep `showSaveFilePicker`, while multi-format local mixdowns use a directory picker.
- `runStemExport(...)` creates one stem render session and renders each stem once before encoding all selected formats for that stem.
- Stem filename de-duplication keys by final extension so the same track can produce `Track.wav` and `Track.mp3` while duplicate track names still receive suffixes.
