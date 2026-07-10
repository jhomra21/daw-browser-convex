# Export UI Redesign Tracker

> Created: 2026-07-10
> Branch: `export-ui-redesign`
> Base commit: `7988aa2`
> Scope: redesign the audio export dialog around Ableton Live 12's export hierarchy, expose export options already supported by the browser audio engine, and add a small set of high-value export capabilities without introducing speculative video or hardware-rendering architecture.

## Purpose

The existing export workflow is functional but presents source, range, and format as a short flat form. This tracker defines an implementation-safe redesign that:

- follows Ableton's Selection, Rendering, and Encoding grouping
- exposes existing sample-rate, channel-count, bitrate, and multi-track stem capabilities
- keeps browser support probing and local/cloud save behavior explicit
- preserves one-render/multi-format fan-out
- avoids claiming Ableton behavior that the engine does not yet implement
- keeps `ExportDialog` readable by extracting only small repeated UI shells

## References

### Product reference

- Ableton Live 12 manual, section 5.1.3, Exporting Audio and Video:
  - <https://www.ableton.com/en/live-manual/12/managing-files-and-sets/#exporting-audio-and-video>
  - Selection Options
  - Rendering Options
  - Encoding Options

### Local code references

- Current DAW export:
  - `src/components/timeline/ExportDialog.tsx`
  - `src/context/export.tsx`
  - `src/lib/export/run-export-job.ts`
  - `src/lib/export-format-support.ts`
  - `src/lib/local-export.ts`
  - `src/lib/local-stem-export.ts`
  - `packages/audio-engine/src/export-mixdown.ts`
  - `packages/audio-engine/src/export-audio-support.ts`
  - `packages/shared/src/export-audio-formats.ts`
- Existing export trackers:
  - `implementation-trackers/export-refactor-tracker.md`
  - `implementation-trackers/export-performance-improvements-tracker.md`
  - `implementation-trackers/multi-export-tracker.md`
- UI and architecture references:
  - `/Users/juan/Documents/dialkit/src/solid/components/SelectControl.tsx`
  - `/Users/juan/Documents/dialkit/src/solid/components/SegmentedControl.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/inspector/export.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/inspector/export-progress.tsx`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/context/export.tsx`
  - `/Users/juan/Documents/solid-primitives/packages/storage/src/persisted.ts`

## Current State

### Current dialog

`src/components/timeline/ExportDialog.tsx` currently exposes:

- source:
  - Mixdown
  - All track stems
  - Selected track stem
- range:
  - Whole timeline
  - Loop region
  - Custom start/end seconds
- formats:
  - WAV
  - MP3
  - Ogg Opus
  - FLAC
- inline preparation, progress, cancellation, errors, and saved-output messages

The dialog is a compact `max-w-lg` single-column form. It does not distinguish signal selection, rendering behavior, and encoding behavior.

### Existing engine capabilities not exposed by the dialog

`packages/audio-engine/src/export-mixdown.ts` already accepts:

- `sampleRate?: number`
- `numberOfChannels?: number`
- `bitrate?: number` in `encodeAudioBuffer(...)`
- isolated source-track rendering
- optional master FX inclusion in `renderStemMixdown(...)`

`src/lib/export/run-export-job.ts` already supports:

- one render with multiple output formats
- multiple selected track IDs in `StemExportRequest`
- local direct-to-file streaming
- cloud mixdown upload
- local stem directory export
- progress and cancellation

### Verified defects and constraints

- Installed MediaBunny 1.35.1 requires a positive bitrate in FLAC audio configuration. The current engine does not provide one, so FLAC may pass support probing and fail during encoding.
- `src/lib/export-format-support.ts` caches one support result using the default 44.1 kHz stereo configuration. That cache becomes incorrect when sample rate, channel count, or lossy bitrate is configurable.
- Timeline export plumbing currently receives one primary selected track ID. Multiple export track IDs must be derived in timeline order from range selection, selected clips, and the primary selected track.
- Stem rendering already includes reachable group/return routing and intentionally excludes master FX. This branch must not add an inaccurately named Include Return and Main Effects toggle.
- Local/cloud export metadata already stores numeric sample rate and requires no schema or persistence migration.

### Engine gaps

The engine does not currently provide:

- peak normalization
- selectable PCM bit depth
- dithering
- Ableton-style two-pass loop rendering with wrapped effect tails
- AIFF encoding
- video export
- external-hardware real-time rendering

## Ableton Mapping

| Ableton option | DAW status | Plan |
| --- | --- | --- |
| Main | Available as Mixdown | Rename in UI, preserve internal mode |
| All Individual Tracks | Available as All track stems | Rename in UI |
| Selected Tracks Only | Request supports multiple IDs; UI sends one | Wire current timeline multi-selection |
| Individual track | Can use selected stem path | Include track choices only if the current selection model provides a clean consumer-shaped API |
| Render Start | Representable by custom range | Expose directly |
| Render Length | Representable from start/end | Store start and length in UI, convert at request boundary |
| Include Return and Main Effects | Current stems include routed group/return processing and exclude master FX | Do not expose a toggle in this branch |
| Render as Loop | Loop range exists, tail wrapping does not | Keep Loop Region shortcut; do not label it Render as Loop |
| Convert to Mono | Supported by `numberOfChannels` | Expose |
| Normalize | Not supported | Add deterministic buffer normalization |
| Sample Rate | Supported by `sampleRate` | Expose 44.1, 48, and 96 kHz after capability/memory validation |
| Encode PCM | WAV and FLAC supported | Group as lossless output |
| Bit Depth | WAV is fixed to `pcm-s16` | Defer pending MediaBunny codec verification |
| Dither | Not supported | Defer with bit-depth work |
| Encode MP3 | Supported | Expose bitrate |
| Ogg Opus | Supported DAW extension | Keep under compressed formats |
| Create Analysis File | Ableton-specific `.asd` | Omit |
| Video options | No video timeline/export path | Omit |

## Product Decisions

### Dialog hierarchy

Use three explicit sections:

1. Selection Options
2. Rendering Options
3. Encoding Options

The footer remains the single place for Cancel/Close and Export actions. Progress remains owned by `ExportProvider`.

### Terminology

- Dialog title: `Export Audio`
- `Mixdown` becomes `Main`
- `All track stems` becomes `All Individual Tracks`
- `Selected track stem` becomes `Selected Tracks Only`
- `Custom Start/End` becomes `Render Start` and `Render Length`
- Keep `Whole Timeline` and `Loop Region` as range-fill shortcuts

### Scope boundaries

Implement now:

- Ableton-style section layout and terminology
- direct Render Start/Length controls
- whole-timeline and loop-region range shortcuts
- multiple selected tracks
- sample rate
- stereo/mono
- MP3 and Opus bitrate
- normalization
- configuration-aware browser support probing
- valid FLAC encoder configuration
- clear lossless/compressed encoding grouping
- static export configuration summary
- existing phase-based progress and completion presentation

Defer:

- bit depth and dithering
- AIFF
- true Render as Loop tail wrapping
- video
- real-time hardware export
- export templates/presets
- export preference persistence
- percentage progress, remaining-time estimation, or render progress bars
- Include Return and Main Effects control
- independent group, return, or master stem files

## Target Request Model

Keep lower-level encoding single-format. Add render settings and per-format encoding options to the app-level request.

```ts
export type ExportRenderSettings = {
  sampleRate: 44100 | 48000 | 96000
  numberOfChannels: 1 | 2
  normalize: boolean
}

export type ExportEncodingSettings = {
  bitrateByFormat: Partial<Record<'mp3' | 'ogg-opus', number>>
}

export type TimelineExportRequest = {
  getTracks: () => RuntimeTrack[]
  bpm: number
  masterVolume: number
  range: ExportRange
  formats: readonly ExportAudioFormat[]
  render: ExportRenderSettings
  encoding: ExportEncodingSettings
  projectId?: string
  userId?: string
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
  signal: AbortSignal
  onProgress?: (progress: ExportProgress) => void
}
```

Do not add a broad generic export-config package. These settings have one current app consumer and should remain shaped around `runTimelineExport(...)` and `runStemExport(...)`.

## Range Model

Keep `ExportRange` as the engine contract:

```ts
export type ExportRange =
  | { mode: 'whole' }
  | { mode: 'loop'; startSec: number; endSec: number }
  | { mode: 'custom'; startSec: number; endSec: number }
```

Use start and length only as dialog state:

```ts
const customRange = (): ExportRange => {
  const start = Math.max(0, renderStartSec())
  const length = Math.max(0.001, renderLengthSec())
  return {
    mode: 'custom',
    startSec: start,
    endSec: start + length,
  }
}
```

This preserves current engine APIs and avoids propagating duplicate range representations.

## Normalization Design

Normalization belongs after rendering and before encoding so every selected format receives the same normalized signal.

Add a pure helper near export mixdown:

```ts
export const getAudioBufferPeak = (buffer: AudioBuffer): number => {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) {
      peak = Math.max(peak, Math.abs(data[index]))
    }
  }
  return peak
}
```

Normalize the job-local rendered buffer once in place before multi-format encoding. The buffer is owned by one export source and is intentionally reused by every requested format.

Rules:

- silence remains silence
- peaks at or above full scale are not amplified
- non-silent material below full scale is scaled to a maximum absolute peak of 1
- non-finite samples must not produce a non-finite gain
- one normalized rendered buffer is reused for all requested formats

## UI Structure

Keep `ExportDialog` as the orchestrator and extract only small visual shells:

```tsx
const ExportSection: Component<{ title: string; children: JSX.Element }> = (props) => (
  <section class="border border-border bg-background/40">
    <div class="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {props.title}
    </div>
    <div class="grid gap-2 p-3">{props.children}</div>
  </section>
)

const ExportField: Component<{ label: string; children: JSX.Element }> = (props) => (
  <div class="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-3">
    <div class="text-sm text-muted-foreground">{props.label}</div>
    <div class="min-w-0">{props.children}</div>
  </div>
)
```

Final implementation must avoid arbitrary Tailwind values. Use standard grid fractions or a semantic utility only if the exact label column is necessary.

Do not introduce a metadata-driven form renderer. The content is static and should remain explicit JSX.

## Implementation Phases

### Phase 1: Confirm contracts and tests

- [x] Re-read the latest export dialog, runner, context, audio-engine, and selection models.
- [x] Verify how timeline multi-selection reaches `Timeline` and `timeline-panels`.
- [x] Verify MediaBunny accepted audio codecs/bitrates from installed source.
- [x] Add focused tests for format metadata, encoder configuration, request normalization, selection derivation, and audio normalization before wiring UI.

### Phase 2: Correct shared encoding metadata and MediaBunny configuration

- [x] Add MP3 bitrate presets 128, 192, 256, and 320 kbps with 192 kbps default.
- [x] Add Ogg Opus bitrate presets 64, 96, 128, 160, and 192 kbps with 128 kbps default.
- [x] Keep WAV and FLAC lossless with no user-facing bitrate.
- [x] Provide the valid internal FLAC bitrate required by MediaBunny.
- [x] Resolve the same effective bitrate for support probing and encoding.
- [x] Add focused shared and audio-engine support tests.

### Phase 3: Extend engine and runner settings

- [x] Add render settings accepted by timeline and stem requests.
- [x] Pass `sampleRate` and `numberOfChannels` into mixdown/stem render requests.
- [x] Pass per-format bitrate into `encodeAudioBuffer(...)`.
- [x] Normalize the job-local buffer once in place at the render/encode boundary.
- [x] Preserve one-render/multi-format behavior.
- [x] Preserve local/cloud and stem save semantics.

### Phase 4: Selected-track export

- [x] Replace single `selectedTrackId` export plumbing with ordered selected track IDs.
- [x] Derive IDs from range-selection tracks first.
- [x] Otherwise derive IDs from selected clips in timeline order.
- [x] Otherwise use the primary selected track.
- [x] Deduplicate IDs while preserving timeline order.
- [x] Keep only renderable normal tracks with clips.
- [x] Disable Selected Tracks Only when no eligible tracks are selected.
- [x] Preserve deterministic track order in generated stems.

### Phase 5: Make support probing configuration-aware

- [x] Key support results by sample rate, channel count, and effective per-format bitrate.
- [x] Reprobe when those settings change.
- [x] Prevent stale asynchronous results from overwriting newer settings.
- [x] Remove selected formats that become unsupported and fall back to WAV when necessary.
- [x] Keep unsupported formats visible and disabled.
- [x] Remove the current retry timer rather than adding polling.

### Phase 6: Redesign dialog

- [x] Widen the dialog without changing shared dialog defaults.
- [x] Add Selection Options, Rendering Options, and Encoding Options sections.
- [x] Rename source choices to Ableton terminology.
- [x] Add Render Start and Render Length controls.
- [x] Add Whole Timeline and Loop Region shortcuts.
- [x] Add Sample Rate control.
- [x] Add Stereo/Mono control.
- [x] Add Normalize toggle.
- [x] Group WAV/FLAC as lossless outputs.
- [x] Group MP3/Ogg Opus as compressed outputs.
- [x] Show bitrate controls only for selected supported compressed formats.
- [x] Keep unavailable browser formats visible but disabled with clear text.
- [x] Keep the export action disabled when no supported format is selected.

### Phase 5: Progress and result presentation
### Phase 7: Configuration summary and existing progress presentation
- [x] Show a compact pre-export summary: source, duration, channel mode, sample rate, and selected formats.
- [x] Show a compact pre-export summary: source, selected-track count, duration, channel mode, sample rate, normalization, selected formats, and lossy bitrates.
- [x] Derive whole-timeline duration from the latest track snapshot.
- [x] Do not estimate percentage, remaining time, or file size.
- [x] Reuse `ExportProgressStatus`.
- [x] Keep cancellation semantics unchanged.
- [x] Keep local/cloud completion messages concise.

- [x] Add polite live regions to progress, errors, and results.
### Phase 7: Validation
### Phase 8: Validation
- [x] Focused tests for normalization.
- [x] Shared metadata tests for bitrate presets and defaults.
- [x] Audio support tests for valid WAV, MP3, Opus, and FLAC configuration.
- [x] Focused tests for request option propagation.
- [x] Focused tests for selected-track filtering.
- [x] Focused tests for selected-track derivation and filtering.
- [x] Focused tests for range start/length conversion.
- [x] `bun run typecheck`
- [x] `bun test`
- [x] `bun run knip`
- [x] `git diff --check`
- [x] `bun run build`

## Manual Smoke Matrix

### Mixdown

- Main, whole timeline, WAV, 44.1 kHz, stereo
- Main, loop region, MP3, 48 kHz, stereo
- Main, custom range, FLAC + MP3, normalized
- Main, custom range, mono

### Stems

- All Individual Tracks, WAV
- Selected Tracks Only with one eligible track
- Selected Tracks Only with multiple eligible tracks
- Selected Tracks Only with only group/return/master rows selected
- duplicate track names across multiple formats

### Browser behavior

- browser with File System Access
- fallback single-file download
- unsupported compressed encoder
- canceled file/directory picker
- cancellation during preparing/encoding/saving

## Risks

- Higher sample rates increase `OfflineAudioContext` memory proportionally.
- Mono rendering must preserve mixer behavior and not merely discard a stereo channel.
- Normalization adds a full-buffer scan and in-place channel writes.
- Browser support for compressed codecs remains runtime-dependent.
- Support results must be keyed by the exact sample-rate, channel-count, and bitrate tuple.
- FLAC must remain hidden or disabled if a valid installed MediaBunny configuration cannot be proven.
- Cloud export still requires an in-memory encoded blob.
- `OfflineAudioContext.startRendering()` cannot be interrupted reliably once started.

## Completion Criteria

- The dialog follows the Ableton Selection/Rendering/Encoding hierarchy.
- Every newly visible setting is wired to real behavior.
- No control claims unsupported Ableton semantics.
- Existing formats, multi-format fan-out, local/cloud behavior, stems, progress, and cancellation continue to work.
- Focused and full validators pass.
- The final diff has been reviewed with the simplify skill.

## Review Log

### Opus plan review

Verdict: Needs changes.

Adopted corrections:

- fix FLAC encoder configuration before exposing the redesigned control
- make support probing configuration-aware
- derive ordered selected track IDs from range selection, selected clips, then primary track
- normalize once in place on the job-local rendered buffer
- remove preferences, progress estimation, and Include Return and Main Effects from this branch
- keep a static configuration summary and existing phase-based progress

### Plan validation

Valid: Yes.

Evidence:

- Current engine contracts already supported sample rate, channel count, stem isolation, and one-render/multi-format encoding.
- Installed MediaBunny 1.35.1 validation requires a positive FLAC bitrate, so support probing and encoding now share one effective configuration.
- Timeline selection state exposes range selection, selected clip IDs, and the primary track needed for deterministic selected-stem derivation.
- Existing runner boundaries remain the correct root-level location for render settings, normalization, encoding settings, saving, cancellation, and progress.

### Simplify review

Completed.

Adopted cleanups:

- removed redundant range state and derived the engine range from one mode plus start/length inputs
- initialized lossy bitrates from shared metadata instead of duplicated literals
- reused one renderable-track predicate and one normalized range-bounds helper
- memoized selected export track derivation away from playhead-driven panel updates
- reused the same render/encoding settings for support probing and export requests
- removed the redundant track snapshot prop
- generated support cache keys from all export formats and their effective defaults
- skipped duplicate cached support probes and no-op selected-format updates
- replaced extracted class-string constants with local JSX classes
- extracted one small explicit format option component without introducing a form model
- removed a redundant per-sample finite check during normalization

### Validation results

- Focused export tests: 16 passed, 0 failed.
- `bun run typecheck`: passed.
- `bun test`: 305 passed, 0 failed, 704 expectations.
- `bun run knip`: passed.
- `git diff --check`: passed.
- `bun run build`: passed with existing bundle-size and browser-data freshness warnings.
