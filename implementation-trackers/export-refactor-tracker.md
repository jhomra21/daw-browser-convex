# Export Refactor Tracker

> Created: 2026-06-06
> Branch: `export-refactor`
> Scope: execution-safe plan for MediaBunny export improvements:
>
> 1. Add browser-gated audio export formats beyond WAV.
> 2. Add richer local export targets, especially direct-to-file streaming.
> 3. Preserve current cloud/local export behavior until each seam is validated.
> 4. Take architectural inspiration from Diffusion without copying video-only complexity.

## Purpose

This tracker captures the plan for the export refactor branch before implementation starts.

It exists to:

- keep the work focused on export-related MediaBunny improvements only
- preserve current WAV export behavior while adding format and target seams
- ground the plan in the current DAW codebase, current MediaBunny docs, local MediaBunny source, and relevant Diffusion patterns
- avoid coupling export UI, encoding, storage metadata, and browser file targets more tightly
- provide a phase-by-phase implementation and validation sequence
- record decisions, rejected candidates, browser evidence, and validation artifacts as the branch progresses

This tracker should be updated during the branch with implementation notes, browser support findings, rejected alternatives, smoke-test results, and final validation output.

---

## Branch

- Current branch: `export-refactor`
- Base branch: `origin/master`
- Created from local `master` after PR #10 merge.
- Existing working tree context when branch was created:
  - `AGENTS.md` was already modified externally.
  - `README.md` was already modified by prior documentation work.
  - This branch should not accidentally mix those documentation edits into the export implementation unless explicitly requested.

---

## References

- Repo: `/Users/juan/Documents/daw-browser-convex`
- Diffusion reference repo: `/Users/juan/Documents/monorepo-new`
- MediaBunny local package source: `/Users/juan/Documents/daw-browser-convex/node_modules/mediabunny/src`
- MediaBunny docs:
  - <https://mediabunny.dev/>
  - <https://mediabunny.dev/guide/writing-media-files>
  - <https://mediabunny.dev/guide/media-sources>
  - <https://mediabunny.dev/api/AudioBufferSource>
- MDN File System Access / file streams context:
  - <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API>
  - <https://developer.mozilla.org/en-US/docs/Web/API/FileSystemWritableFileStream>
- MDN Web Audio API:
  - <https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API>
  - <https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext>

---

## Current DAW Export State

### Source evidence

- `packages/audio-engine/src/export-mixdown.ts`
  - `renderMixdown(...)` renders tracks, MIDI, synths, routing, and FX through `OfflineAudioContext`.
  - `encodeAudioBuffer(buffer)` currently uses `Output`, `BufferTarget`, `WavOutputFormat`, and `AudioBufferSource({ codec: "pcm-s16" })`.
  - The function returns a full in-memory `Blob`, MIME type, extension, duration, and sample rate.
- `src/components/timeline/ExportDialog.tsx`
  - Dynamically imports `@daw-browser/audio-engine/export-mixdown`.
  - Ensures clip buffers for the selected range.
  - Applies local or Convex-backed effect rows.
  - Renders then encodes the mixdown.
  - Saves local projects through `saveBlobLocally(...)`.
  - Uploads cloud project exports through `/api/exports`.
  - Hardcodes Convex/local metadata format to `"wav"`.
- `src/lib/local-export.ts`
  - Uses `window.showSaveFilePicker` when available, but writes an already-created `Blob`.
  - Falls back to object URL download.
- `src/lib/local-export-metadata.ts`
  - Restricts local export metadata to `format: "wav"`.
- `api/routes/exports.ts`
  - Upload route currently forces `format = "wav"`.
  - Defaults content type to `audio/wav`.
  - Stores exports in project-scoped R2 keys and returns `/api/export/:projectId?key=...`.
- `convex/exports.ts` and `convex/schema.ts`
  - Convex export rows already use `format: v.string()`, so the database does not block additional formats.

### Current constraints

- The current render pipeline already produces a complete `AudioBuffer` before encoding.
- More formats do not require changing timeline rendering first.
- Direct-to-file `StreamTarget` improves encoding-output memory use, but it does not remove the already-rendered `AudioBuffer` memory cost.
- Cloud upload currently expects multipart form data with a `File`/`Blob`, so streamed cloud upload is a separate future API change.
- Browser codec support varies. Compressed formats must be probed with MediaBunny `canEncodeAudio(...)`, not assumed.

---

## MediaBunny Findings To Use

### Local source evidence

- `node_modules/mediabunny/src/index.ts`
  - Exports `Output`, `AudioBufferSource`, `AudioSampleSource`, output formats, `BufferTarget`, `StreamTarget`, `FilePathTarget`, and `canEncodeAudio`.
- `node_modules/mediabunny/src/output-format.ts`
  - Confirms these relevant output formats:
    - `WavOutputFormat`
    - `Mp3OutputFormat`
    - `OggOutputFormat`
    - `WebMOutputFormat`
    - `FlacOutputFormat`
    - `AdtsOutputFormat`
    - `Mp4OutputFormat`
  - Confirms format/codec compatibility:
    - WAV supports PCM codecs including `pcm-s16`.
    - MP3 supports `mp3`.
    - Ogg supports `opus` and `vorbis`.
    - WebM supports `opus` and `vorbis` for audio.
    - FLAC supports `flac`.
    - ADTS supports `aac`.
  - Confirms each format exposes file extension and MIME type.
- `node_modules/mediabunny/src/target.ts`
  - `BufferTarget` writes into an in-memory `ArrayBuffer`; fast but not suitable for very large files.
  - `StreamTarget` writes to a `WritableStream<StreamTargetChunk>`.
  - `StreamTarget` is compatible with `FileSystemWritableFileStream`.
  - `StreamTarget` supports backpressure and optional chunking.
  - `FilePathTarget` is intended for server-side Node/Bun/Deno usage, not browser local exports.
- `node_modules/mediabunny/src/media-source.ts`
  - `AudioBufferSource` is appropriate for Web Audio `AudioBuffer`.
  - `.add(...)` returns a promise and should be awaited for backpressure.
- `node_modules/mediabunny/src/encode.ts`
  - `AudioEncodingConfig` requires bitrate for compressed codecs except PCM and FLAC.
  - `canEncodeAudio(...)` returns true for PCM because MediaBunny encodes PCM internally.
  - Non-PCM support depends on browser `AudioEncoder`/WebCodecs or registered custom encoders.
- `node_modules/mediabunny/src/output.ts`
  - `Output` supports `setMetadataTags(...)` before output start.
  - `addAudioTrack(...)`, `start()`, source adds, `source.close()`, and `finalize()` are the expected lifecycle.
  - `getMimeType()` is available from the output muxer, but a project-level descriptor can keep MIME/extension decisions deterministic.

### Docs evidence

Current MediaBunny search results confirm the public docs still center the same concepts:

- writing media files with `Output`
- using media sources such as `AudioBufferSource`
- selecting output targets such as buffers or streams
- using browser-compatible APIs directly

---

## Diffusion Patterns To Borrow

Use these as architectural inspiration, not as code to copy blindly.

### Browser export controller

Reference:

- `/Users/juan/Documents/monorepo-new/apps/web/src/context/export.tsx`

Pattern:

- UI calls a single export action.
- Export orchestration owns:
  - current config
  - progress
  - remaining time
  - cancellation
  - save picker
  - engine pause/resume
  - success/error feedback
- The encoder returns a discriminated result instead of throwing everything through UI code.

DAW applicability:

- Introduce a small export controller boundary inside or near `ExportDialog`, but do not create a broad app-wide provider unless a second export entry point appears.
- Keep `ExportDialog` from growing into a large orchestrator as format support, target selection, progress, and cancellation are added.
- Prefer a discriminated result for encode/save outcomes:
  - `success`
  - `canceled`
  - `error`

### Export descriptor maps

Reference:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/export-templates.ts`

Pattern:

- Export options live in descriptor data:
  - format
  - codec
  - extension
  - MIME type
  - bitrate/sample-rate defaults
  - template IDs
- UI consumes descriptors instead of duplicating strings.

DAW applicability:

- Create a single source of truth for audio export formats.
- Use descriptors for:
  - `id`
  - label
  - extension
  - MIME type
  - MediaBunny output format factory
  - audio codec
  - default bitrate where required
  - file picker accept type
  - support probe
- Avoid duplicated MIME maps between UI, encoder, local metadata, and API upload.

### Encoder config vs execution-only config

Reference:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/interfaces.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/export-progress.tsx`

Pattern:

- UI-facing `ExportConfig` omits execution-only values such as `target`, `scene`, and `onProgress`.
- Encoder-facing config receives those execution-only values at the boundary.

DAW applicability:

- Keep selected format/range/sample-rate/bitrate as UI config.
- Add file handle, target mode, and progress callback only at execution time.
- This keeps persisted/default settings independent from transient browser handles.

### Target abstraction

Reference:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/buffer.ts`

Pattern:

- One target abstraction chooses:
  - `StreamTarget` when a `FileSystemFileHandle` is provided
  - `BufferTarget` when no handle is provided
- The close/finalize path returns a `Blob` only for in-memory exports.

DAW applicability:

- Add an audio export target helper that creates:
  - `StreamTarget` for local save picker direct-to-file exports
  - `BufferTarget` for cloud upload and fallback downloads
- Keep this helper small and audio-specific.
- Track byte count with `target.onwrite` if progress/size reporting is needed.

### Lazy MediaBunny format imports

Reference:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/format.ts`

Pattern:

- Container-specific MediaBunny output classes are imported lazily.

DAW applicability:

- Current DAW already dynamically imports the export module from `ExportDialog`.
- Inside that lazy module, format-specific factories can still be descriptor-driven.
- Do not over-optimize with per-format dynamic imports unless bundle evidence shows value.

### Progress and cancellation UX

Reference:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/export-progress.tsx`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/encoder.ts`

Pattern:

- Long exports expose progress, remaining time, and cancel.
- Progress UI is presentational.

DAW applicability:

- Add progress only where accurate:
  - render progress can be added later if `renderMixdown` becomes incremental
  - encode byte progress can be tracked via `target.onwrite`
- Cancellation is useful but should not be faked. Add it only after the render/encode lifecycle has an actual cancel path.

### Filename and content-type hygiene

References:

- `/Users/juan/Documents/monorepo-new/apps/web/src/context/export.tsx`
- `/Users/juan/Documents/monorepo-new/apps/web/src/utils/browser.ts`
- `/Users/juan/Documents/monorepo-new/apps/api/src/naming.ts`

Pattern:

- Suggested filenames are generated centrally.
- Extensions are tied to MIME/format.
- Object URL downloads clean up after click.
- API-side naming has sanitization and fallback.

DAW applicability:

- Centralize export filename generation from project name or `mixdown_YYYY...`.
- Always derive extension from the selected audio export descriptor.
- Keep existing server-side `sanitizeFileNameSegment(...)`.
- Do not copy Diffusion's AI-generated naming; deterministic DAW export names are more appropriate.

---

## Diffusion Patterns Not To Copy

- Video-specific templates, resolutions, frame rates, alpha/container handling, and social-media presets.
- Mutating export config inside the encoder based on output format.
- Busy waits or polling loops for backpressure.
  - Diffusion uses a bounded `setTimeout(..., 0)` loop around audio/video synchronization.
  - This DAW codebase explicitly avoids polling loops unless they are justified and cleaned up deterministically.
- App-wide export provider unless there are multiple real export entry points.
- Cloud signed URL/provider architecture for the first audio export pass.
- Duplicate MIME maps across target helpers and descriptor files.
- `FilePathTarget` in browser code.

---

# Target Architecture

## Export format source of truth

Add a package-local audio export descriptor module, likely in:

```txt
packages/audio-engine/src/export-formats.ts
```

or keep it near `export-mixdown.ts` if the first implementation stays small.

Target shape:

```ts
type ExportAudioFormat = "wav" | "mp3" | "ogg-opus" | "flac"

type ExportAudioFormatDescriptor = {
  id: ExportAudioFormat
  label: string
  fileExtension: string
  mimeType: string
  codec: AudioCodec
  defaultBitrate?: number
}
```

Implementation should avoid type casts and should keep factories explicit.

## Export config boundary

Target shape:

```ts
type EncodeAudioBufferOptions = {
  format?: ExportAudioFormat
  bitrate?: number
  target?: ExportAudioTarget
  onWrite?: (bytesWritten: number) => void
}
```

Rules:

- WAV remains the default.
- Compressed formats must have explicit default bitrate where MediaBunny requires it.
- UI config should not store browser file handles.
- Target handles are execution-only.

## Target boundary

Target options:

- `buffer`
  - Uses `BufferTarget`.
  - Returns a `Blob`.
  - Required for current cloud upload and fallback downloads.
- `file`
  - Uses `StreamTarget`.
  - Writes to `FileSystemWritableFileStream`.
  - Returns metadata, not a `Blob`.
  - Local export only.

Do not use `FilePathTarget` in this browser app.

## Format set for first implementation

Start with:

- WAV
  - Format: `WavOutputFormat`
  - Codec: `pcm-s16`
  - MIME: `audio/wav`
  - Extension: `.wav`
  - Support: always available through MediaBunny PCM path.
- MP3
  - Format: `Mp3OutputFormat`
  - Codec: `mp3`
  - MIME: `audio/mpeg`
  - Extension: `.mp3`
  - Support: gated by `canEncodeAudio("mp3", ...)`.
- Ogg Opus
  - Format: `OggOutputFormat`
  - Codec: `opus`
  - MIME: prefer `audio/ogg` for app metadata and file picker.
  - Extension: `.ogg`
  - Support: gated by `canEncodeAudio("opus", ...)`.
- FLAC
  - Format: `FlacOutputFormat`
  - Codec: `flac`
  - MIME: `audio/flac`
  - Extension: `.flac`
  - Support: gated by `canEncodeAudio("flac", ...)`.

Defer:

- AAC/ADTS
  - Useful, but browser support and user-facing extension expectations need more validation.
- MP4/M4A audio-only
  - Potentially useful, but container naming and codec compatibility need a cleaner UX decision.
- WebM audio-only
  - Useful for web delivery but overlaps with Ogg Opus for the first pass.

---

# Implementation Plan

## Phase 1 — Add format descriptors and support probing

- [x] Add `ExportAudioFormat` and descriptor helpers.
- [x] Add `listExportAudioFormats()` or a constant descriptor list.
- [x] Add `getExportAudioFormatMetadata(format)`.
- [x] Add `getSupportedExportAudioFormats({ sampleRate, numberOfChannels })`.
- [x] Use MediaBunny `canEncodeAudio(...)` for compressed formats.
- [x] Keep WAV available even when `AudioEncoder` is unavailable.

Validation notes to record:

- Browser used: existing Helium remote-debugging session on port `9222`.
- WAV support: available by default.
- MP3 support: unavailable in the tested browser session.
- Ogg Opus support: supported by `getSupportedExportAudioFormats()` and shown enabled in the export dialog after the support-probe rendering fix.
- FLAC support: unavailable in the tested browser session.

## Phase 2 — Make `encodeAudioBuffer` format-aware

- [x] Change `encodeAudioBuffer(buffer)` to accept options while preserving the existing default WAV call.
- [x] Select MediaBunny output format and `AudioBufferSource` codec from the descriptor.
- [x] Pass bitrate only where required.
- [x] Await source `.add(...)` and close/finalize in the existing lifecycle order.
- [x] Return selected `format`, duration, sample rate, and size/Blob metadata; callers derive MIME type and extension from shared format metadata.
- [x] Skip simple metadata tags for now because no project/title metadata is available at the audio-engine boundary.

Rules:

- Do not change `renderMixdown(...)` behavior in this phase.
- Do not introduce new public package exports until the consumer needs them.
- Do not duplicate MIME/extension strings outside the descriptor source.

## Phase 3 — Update `ExportDialog` format UX

- [x] Add a format selector with WAV default.
- [x] Probe support when the export dialog is opened.
- [x] Disable unsupported compressed options.
- [x] Show concise unsupported labels rather than failing late.
- [x] Pass selected format to `encodeAudioBuffer(...)`.
- [x] Use shared descriptor metadata for filename, file picker type, local metadata, cloud form data, and Convex row creation.

Keep UI local and simple:

- Avoid turning the dialog into a generic template system.
- Use explicit JSX unless repeated dynamic structure becomes clearly smaller with descriptors.

## Phase 4 — Widen metadata and upload contracts

- [x] Widen `src/lib/local-export-metadata.ts` from `format: "wav"` to supported export format IDs or string.
- [x] Preserve existing WAV metadata rows.
- [x] Update `/api/exports` to read and validate `format` from form data.
- [x] Stop forcing `audio/wav`; use uploaded file type or descriptor MIME fallback.
- [x] Preserve server-side filename sanitization and project-scoped R2 key behavior.
- [x] Continue storing `format` in Convex as string.

Rules:

- Keep API route thin.
- Keep validation deterministic and local.
- Do not introduce a broad export upload schema package unless API and frontend both need the same validator.

## Phase 5 — Add direct-to-file local target

- [x] Add a small audio export target helper inspired by Diffusion's `TargetBuffer`.
- [x] For local projects with File System Access support, ask for the file handle before encoding.
- [x] Create `StreamTarget` from `handle.createWritable()`.
- [x] Use `{ chunked: true }` for large exports.
- [x] Return metadata without constructing a `Blob`.
- [x] Track output size through `target.onwrite` or final stream metadata where feasible.
- [x] Fall back to `BufferTarget` plus existing object URL download when direct file streaming is unavailable; stop cleanly before rendering if the save picker is canceled.

Rules:

- Browser local export only.
- Cloud export remains `BufferTarget` until an explicit streaming upload API is designed.
- If user cancels save picker, stop before rendering/encoding when possible.

## Phase 6 — Optional progress and cancellation cleanup

Only after phases 1-5 are stable:

- [x] Track encode byte accounting through `target.onwrite`; progress UI was deferred in this focused pass.
- [x] Defer estimated output size for compressed formats until compressed formats are supported in the tested browser path.
- [x] Defer separate rendering/encoding/saving/uploading statuses; current success/error UX remained stable.
- [x] Defer cancellation because the current offline render step has no real cancel path; adding a fake cancel button would be misleading.

Do not add polling loops.

---

# Future Plan — Global Export Provider, Queue, Presets, And Ableton-Style Stems

## Motivation

The first export refactor pass intentionally kept export orchestration local to `ExportDialog` because there was only one real export entry point.

That constraint has changed for the next export direction. A broader export system is justified if it supports multiple real callers:

- timeline mixdown export
- selected-track stem export
- all-stems export
- clip export
- project/media menu export actions
- keyboard shortcut export actions
- background export queue
- reusable audio export presets/templates
- shared progress UI outside the dialog

The goal is to borrow Diffusion's useful export controller pattern without copying video-only complexity.

## Diffusion API Patterns To Reuse

References:

- `/Users/juan/Documents/monorepo-new/apps/web/src/context/export.tsx`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/export-progress.tsx`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/export-templates.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/interfaces.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/encode/encoder.ts`

Useful patterns:

- A provider owns export execution, progress, cancellation, and shared progress UI.
- Callers invoke a small export API instead of owning render/encode/save details.
- UI-facing export config excludes execution-only values such as targets, callbacks, and cancellation handles.
- Export presets/templates are descriptor data consumed by UI.
- Progress UI is presentational and receives the active export state plus a cancel callback.

DAW-specific differences:

- Keep all video/resolution/FPS/social-media template logic out of this app.
- Keep MediaBunny browser file handles, `AbortSignal`, write callbacks, project IDs, and save targets as execution-only values.
- Keep render/encode logic in `packages/audio-engine`; keep job/progress UI state in the app.

## Target Modules

Add app-level export orchestration:

```txt
src/context/export.tsx
src/components/export/ExportProgressOverlay.tsx
src/lib/export/export-jobs.ts
src/lib/export/export-presets.ts
src/lib/export/export-sources.ts
src/lib/export/run-export-job.ts
```

Add deeper audio-engine stem rendering only after provider/queue seams are validated:

```txt
packages/audio-engine/src/export-stems.ts
packages/audio-engine/src/mixer/render-stem-graph.ts
```

Reuse existing lower-level modules:

```txt
packages/audio-engine/src/export-mixdown.ts
packages/audio-engine/src/mixer/resolve-routing.ts
packages/audio-engine/src/mixer/apply-offline-routing.ts
src/lib/cloud-export.ts
src/lib/local-export.ts
src/lib/export-format-support.ts
```

## Provider Interface

Target shape:

```ts
type ExportContextValue = {
  jobs: Accessor<ExportJob[]>
  activeJob: Accessor<ExportJob | undefined>
  exporting: Accessor<boolean>
  enqueueExport: (request: ExportJobRequest) => string
  cancelExport: (jobId: string) => void
  openTimelineExportDialog: () => void
}
```

Rules:

- Run one export job at a time first.
- Keep the queue serialized until browser resource usage is proven safe for parallel rendering.
- Use an `AbortController` per running job.
- Render shared progress UI from the provider, not from `ExportDialog`.

## Export Sources

Target shape:

```ts
type ExportSource =
  | { type: 'timeline'; range: ExportRange }
  | { type: 'clip'; trackId: string; clipId: string }
  | { type: 'stems'; stemMode: StemExportMode; range: ExportRange }

type StemExportMode =
  | { type: 'selected-tracks'; trackIds: string[] }
  | { type: 'all-tracks' }
  | { type: 'groups' }
  | { type: 'returns' }
```

Project/media menu export actions should trigger one of these sources or open the export dialog. Completed export rows remain handled by `useProjectExports(...)` and `ProjectMediaMenu`.

## Export Presets

Target shape:

```ts
type ExportPreset = {
  id: string
  name: string
  format: ExportAudioFormat
  destination: 'auto' | 'local' | 'cloud'
  stemOptions?: StemExportOptions
}

type StemExportOptions = {
  includeReturns: boolean
  includeGroups: boolean
  includeMasterFx: boolean
  renderMode: 'ableton-style' | 'raw-tracks'
}
```

Initial preset examples:

```ts
export const exportPresets = [
  { id: 'wav-mixdown', name: 'WAV Mixdown', format: 'wav', destination: 'auto' },
  { id: 'mp3-mixdown', name: 'MP3 Mixdown', format: 'mp3', destination: 'auto' },
  {
    id: 'wav-ableton-stems',
    name: 'WAV Stems',
    format: 'wav',
    destination: 'auto',
    stemOptions: {
      includeReturns: true,
      includeGroups: true,
      includeMasterFx: false,
      renderMode: 'ableton-style',
    },
  },
]
```

Default stem behavior should keep `includeMasterFx: false` because recombining processed stems with master processing can double-process or fail to null against the final mix. The user should be able to opt in.

## Export Jobs And Progress

Target shape:

```ts
type ExportJobStatus =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'saving'
  | 'completed'
  | 'canceled'
  | 'failed'

type ExportJob = {
  id: string
  source: ExportSource
  preset: ExportPreset
  status: ExportJobStatus
  createdAt: number
  progressLabel?: string
  sizeBytes?: number
  resultUrl?: string
  localSavedName?: string
  error?: string
}
```

For stem exports, prefer one parent job with child stem progress over one unrelated job per stem.

Progress overlay should show:

- active job name and source
- phase
- selected format
- bytes written during encoding
- current stem name, when exporting stems
- completed stem count
- cancel button
- completed cloud URL or local saved name

## Ableton-Style Stem Export Requirement

Stem export should preserve routing behavior similar to Ableton:

- source track volume/mute/solo behavior
- source track effects
- output routing into groups
- group effects
- sends to returns
- return effects
- solo/mute-aware routing
- optional master effects

Do not implement Ableton-style stems by calling `renderMixdown({ tracks: [track] })`. That loses shared routing context.

## Existing Routing Evidence

The current DAW code already has routing primitives that should be reused:

- `packages/timeline-core/src/types.ts`
  - `TrackChannelRole = 'track' | 'group' | 'return'`
  - `TrackSend`
  - `outputTargetId`
- `packages/shared/src/track-routing-core.ts`
  - normalizes sends to return tracks
  - normalizes output targets to group tracks
- `packages/audio-engine/src/mixer/resolve-routing.ts`
  - resolves active sends and output routing
  - handles solo-aware routing state
- `packages/audio-engine/src/mixer/apply-offline-routing.ts`
  - builds an offline graph with track, group, return, and master nodes
  - connects sends through return inputs
  - connects outputs through groups or master
- `src/components/timeline/TrackSidebar.tsx`
  - exposes group output target and return send UI

## Ableton-Style Stem Renderer Shape

Add an audio-engine API:

```ts
type StemRenderRequest = {
  tracks: Track<AudioBuffer>[]
  bpm: number
  range: ExportRange
  stems: StemDefinition[]
  fx?: ExportFx
  sampleRate?: number
  numberOfChannels?: number
  signal?: AbortSignal
  onProgress?: (progress: StemRenderProgress) => void
}

type StemDefinition = {
  id: string
  name: string
  sourceTrackIds: string[]
  includeGroups: boolean
  includeReturns: boolean
  includeMasterFx: boolean
}

type RenderedStem = {
  id: string
  name: string
  buffer: AudioBuffer
}
```

```ts
export async function renderStemMixdowns(
  request: StemRenderRequest,
): Promise<RenderedStem[]>
```

## Ableton-Style Stem Rendering Algorithm

For each stem:

1. Build the full normal mixer graph with all tracks, groups, returns, sends, and FX.
2. Create offline mixer nodes from the full graph.
3. Schedule audio and MIDI only for the stem's source tracks.
4. Keep group and return channels alive so source signal can flow through them.
5. Apply or omit master FX according to `includeMasterFx`.
6. Render the resulting buffer.
7. Encode and save the stem through the existing export target/save modules.

The key principle is source isolation through the full graph:

```txt
selected source track -> source FX -> group output -> group FX -> master
selected source track -> send amount -> return FX -> master
```

This preserves group and return contribution caused by the selected source without pretending a track rendered alone is equivalent.

## Clip Export

Clip export should reuse the same source-isolated graph idea:

- derive range from the selected clip
- schedule only that clip
- preserve its track, group, return, and optional master processing

Target source:

```ts
{ type: 'clip', trackId, clipId }
```

## Entry Points

Add entry points only after provider and queue are stable:

- timeline dialog: queues `source: { type: 'timeline', range }`
- track menu/sidebar: export selected track stem
- multi-selection actions: export selected tracks as stems
- project/media menu: export mixdown and export stems actions
- keyboard shortcut: `Cmd/Ctrl + Shift + E` opens export UI
- optional default export action can queue a default preset later, but initial shortcut should not silently start a long export

## Implementation Sequence

1. Extract global export provider and shared progress overlay.
2. Move timeline mixdown execution out of `ExportDialog` without changing behavior.
3. Add serialized queue and provider-level cancellation.
4. Add audio export presets/templates.
5. Add Ableton-style stem render API in audio-engine.
6. Add stem export job runner and parent/child progress.
7. Add clip export through the source-isolated graph seam.
8. Wire project/media menu and keyboard entry points.
9. Run validators and browser smoke tests for timeline export, local/cloud save, cancel, stems, and clip export.

## Risks To Avoid

- Do not put provider/job UI state in `packages/audio-engine`.
- Do not duplicate local/cloud save logic.
- Do not push stem-specific UI branching into `ExportDialog`.
- Do not make `ProjectMediaMenu` own export execution.
- Do not parallelize stem renders initially.
- Do not default to master FX on stems.
- Do not call filtered-track stem export Ableton-style unless the full mixer graph is preserved.

---

# Validation Plan

## Automated checks

Run before any commit or final summary after implementation:

```bash
bun run typecheck
bun run knip
bun run build
git diff --check
```

For tracker-only updates:

```bash
git diff --check -- implementation-trackers/export-refactor-tracker.md
```

## Browser smoke tests

Record browser and OS for each run.

- [x] Local project WAV export still works.
- [x] Cloud project WAV export still uploads and opens. After upgrading `@cloudflare/vite-plugin` and `wrangler` to `4.98.0`, the dev server established the remote R2 binding, `/api/exports` accepted an authenticated WAV upload for temporary project `4e3add48-bd65-4c76-9bfa-1b7bc11c16b0`, and the returned `/api/export/...` URL opened successfully with `content-type: audio/wav` and `size=44`.
- [x] Unsupported compressed formats are disabled or fail with a clear message before encoding.
- [x] Each supported compressed format exports a playable file. In the tested Helium session only Ogg Opus was supported; direct encoder validation produced an `audio/ogg` `.ogg` Blob (`sizeBytes=152`) and an `<audio>` element loaded metadata successfully (`duration=0.12`, `error=null`, `canPlayType("audio/ogg")="maybe"`). MP3 and FLAC were unsupported and remained disabled.
- [x] Local direct-to-file export writes through `StreamTarget` without creating an intermediate Blob.
- [x] Fallback download still works when File System Access is unavailable.
- [x] Cloud export row stores correct name, format, duration, sample rate, size, URL, and R2 key. Created and read back a Convex export row for the temporary project with `name="cloud-smoke.wav"`, `format="wav"`, `duration=0.001`, `sampleRate=44100`, `sizeBytes=44`, URL, and project-scoped R2 key.
- [x] R2 object content type matches selected format. Fetching the returned export URL reported `content-type: audio/wav` for the uploaded WAV file.
- [x] Local export list shows the selected format and does not drop existing WAV rows.

## Manual regression areas

- [x] Existing lazy export chunking remains intact.
- [x] No package boundary regression from `@daw-browser/audio-engine/export-mixdown`.
- [x] No accidental changes to live playback or `AudioEngine`.
- [ ] No unrelated README/AGENTS changes included in export implementation commit unless requested. Pending because no export implementation commit exists yet and `README.md`/`AGENTS.md` remain modified in the working tree.

---

# Risks and Mitigations

## Browser codec support varies

Risk:

- MP3, Opus, and FLAC may not all encode in every browser.

Mitigation:

- Use `canEncodeAudio(...)`.
- Disable unsupported formats.
- Keep WAV default and always available.

## StreamTarget reduces only output memory

Risk:

- Users may expect streaming export to remove all memory pressure, but `renderMixdown(...)` still creates an `AudioBuffer`.

Mitigation:

- Treat direct-to-file as an output memory improvement.
- Defer incremental/offline sample streaming as a separate render architecture project.

## API hardcoding can silently corrupt metadata

Risk:

- If API keeps forcing `format = "wav"` or `audio/wav`, cloud exports for new formats will be mislabeled.

Mitigation:

- Update API upload validation and content type handling in the same phase as UI format selection.

## Duplicated format maps can drift

Risk:

- UI, encoder, API, and metadata can disagree on extension/MIME/format IDs.

Mitigation:

- Keep one descriptor source for frontend/audio-engine behavior.
- Keep API validation minimal but aligned with accepted IDs.

## Direct-to-file save picker timing

Risk:

- Asking for a file handle after rendering wastes work if the user cancels.

Mitigation:

- For local streamed exports, ask for the save handle before rendering.
- For fallback/cloud paths, preserve current behavior.

---

# Progress Log

- [x] Created `export-refactor` branch from local `master`.
- [x] Reviewed current DAW export pipeline.
- [x] Reviewed current MediaBunny docs search results and local source in `node_modules/mediabunny/src`.
- [x] Reviewed Diffusion export patterns in `/Users/juan/Documents/monorepo-new`.
- [x] Added this tracker plan before implementation.
- [x] Implement Phase 1.
- [x] Implement Phase 2.
- [x] Implement Phase 3.
- [x] Implement Phase 4.
- [x] Implement Phase 5.
- [x] Run automated validators.
- [x] Run remaining browser smoke tests for cloud export after the local Worker/R2 upload path is fixed or a working staging/production Worker is available.
- [x] Review final diff for simplicity, duplicated maps, accidental docs changes, and package seam regressions.

## Implementation Notes

- Added shared audio export format metadata in `packages/shared/src/export-audio-formats.ts` so UI, API upload validation, and local metadata use the same IDs, extensions, and MIME types.
- Kept MediaBunny-specific codec and output-format factories in `packages/audio-engine/src/export-mixdown.ts`.
- Added `getSupportedExportAudioFormats(...)` using `canEncodeAudio(...)`; WAV remains available without `AudioEncoder`.
- Updated `encodeAudioBuffer(...)` to support buffer and stream targets while preserving WAV as the default call shape.
- Added local file handle selection before rendering for local exports, but create the writable stream only immediately before encoding so render failures do not leave an opened stream.
- Cloud exports intentionally remain on `BufferTarget` and multipart upload.
- Did not add metadata tags in this pass because there is no project/title value at the audio-engine boundary yet; adding generic tags would not improve the export and would add coupling.

## Automated Validation Results

- [x] `bun run typecheck` passed.
- [x] `bun run knip` passed.
- [x] `bun run build` passed.
- [x] `git diff --check` passed.

Build notes:

- Existing `baseline-browser-mapping` staleness warning still appears during client build.
- Build completed successfully.

## Browser Smoke Results

- [x] Confirmed dev server was already listening on `127.0.0.1:3000`.
- [x] Reused the existing Helium remote-debugging session on port `9222`; no new browser was opened.
- [x] Reused existing tab `t3` at `http://localhost:3000/?projectId=project%3A60a3de65-9138-4e1a-b805-4d9990ad03ee`.
- [x] Opened `File -> Export Mixdown...`.
- [x] Confirmed export dialog shows format selector with WAV available, Ogg Opus enabled when supported, and MP3/FLAC disabled as unavailable in this browser session.
- [x] Ran a local WAV export smoke test using an in-page save-picker stub that returned a `WritableStream`, exercising the direct `StreamTarget` path without opening a native file picker.
- [x] Confirmed UI reached `Saved export locally`.
- [x] Confirmed stream target wrote and closed: `writes = 1`, `bytes = 224`, `closed = true`, `aborted = false`.
- [x] Ran fallback download smoke with `showSaveFilePicker` unavailable; confirmed `URL.createObjectURL` called once, anchor click called once, generated `.wav` download name, and object URL revoked.
- [x] Opened the Media menu after export and confirmed the existing local export row remained visible with `WAV` format.
- [x] Clicked Play then Stop after reload to smoke-check live playback controls remained responsive.
- [x] Reloaded the existing tab after the test to restore native browser APIs.

Notes:

- This smoke test validates the local direct-to-file code path and UI success state, but it does not verify an actual on-disk playable file because the native file picker was intentionally stubbed for automation.
- Direct Ogg Opus encoder/playability validation passed in the Helium session: supported formats were `["wav","ogg-opus"]`, encoded Blob metadata was `format="ogg-opus"`, `mimeType="audio/ogg"`, `extension=".ogg"`, `sizeBytes=152`, and audio metadata loaded with `duration=0.12`.
- A full UI Ogg export attempt against the existing long local project hung while rendering/encoding and was stopped by reloading the tab; the direct encoder/playability path passed, so this was not counted as cloud/local save-path validation.
- Authenticated cloud export smoke was attempted by creating temporary cloud project `b1048cdf-0e91-48ad-8773-1bf30bf60dc0`; the upload request payload was correct, but `/api/exports` returned HTTP 500 `fetch failed` from the local Worker/R2 path, so cloud runtime rows/R2/open-link checks remain blocked.
- Retried the cloud blocker after restarting the dev server as requested. The previous server process was stopped, but the restarted `bun run dev` failed before listening on port `3000` because Wrangler could not create the remote preview session (`Failed to start the remote proxy session`). Cloud runtime checks therefore remain blocked before a second upload attempt could run.
- Upgraded `wrangler` alone to `4.98.0`, but `bun dev` still failed because `@cloudflare/vite-plugin@1.25.6` carried a nested `wrangler@4.69.0`. Upgraded `@cloudflare/vite-plugin` to `1.40.0`, which depends on `wrangler@4.98.0`; `bun dev` then started successfully and established the remote connection.
- Re-ran cloud export runtime validation against temporary project `4e3add48-bd65-4c76-9bfa-1b7bc11c16b0`: `/api/exports` returned `200` with project-scoped R2 key and URL, fetching the URL returned `200`, `content-type: audio/wav`, `size=44`, and the Convex export row readback contained the expected name, format, duration, sample rate, size, URL, and R2 key. The temporary cloud project was deleted afterward.
- After simplify cleanup, re-ran a normalized cloud upload smoke against temporary project `d37c1250-bea3-4fab-b729-08f0bdf44863`: submitted `name="normalized-test.ogg"` with `format="wav"`, `/api/exports` returned `200`, the R2 key ended in `-normalized-test.wav`, fetching the URL returned `200`, `content-type: audio/wav`, `size=44`, and the temporary cloud project was deleted afterward.

## Future Plan Execution Notes

- Added a timeline-scoped export provider with serialized job execution, active-job progress, and provider-level cancellation.
- Moved timeline mixdown execution out of `ExportDialog` into `src/lib/export/run-export-job.ts`; the dialog now collects range/format inputs and enqueues a provider job.
- Added a shared export progress overlay rendered outside the dialog.
- Added initial export preset descriptors and exposed mixdown presets in the export dialog.
- Added an Ableton-style stem render API in `packages/audio-engine/src/export-mixdown.ts` that renders selected source tracks through the full resolved mixer graph instead of filtering the track list.
- Wired the Media menu and `Cmd/Ctrl + Shift + E` to open the export dialog.
- Narrowed stem/clip UI execution to backend seams only in this pass because no selected-track or selected-clip export UI contract exists yet; the implemented stem render API is the root seam needed before those entry points can safely enqueue real jobs.
