# Waveforms Refactor Tracker

## Scope

Fix local-project waveform rendering and playback alignment for audio clips.

## Findings

- Diffusion did not directly provide a waveform-specific pattern for this branch.
- The issue was in this app's own local media path: `ClipComponent` skipped waveform generation unless a decoded `buffer` or `sampleUrl` already existed.
- Local clips can have only `sourceAssetKey` at render time. The existing `ensureClipBuffer` path already knows how to load those assets from local/cloud storage.
- Waveform layout duplicated part of the audio scheduling offset math. That made it easier for the visual source window to drift from what playback actually schedules, especially when decoded buffer duration is the reliable source of truth.
- Playback schedules clips slightly ahead to avoid past-time starts, but the visual playhead timer started from the pre-schedule `currentTime`. That can make the playhead lead what the user hears by the schedule-ahead window.

## Architecture Audit Findings

Status after plan-validate-execute pass:

- Completed focused root-level follow-up for findings 2-5 where current code supports it.
- Deferred broad persistence repair/versioning and full resize/export migration because current local/cloud clip rows only expose duration, sample rate, channel count, source asset key, and sample URL, not a content hash, size, or revision.

### 1. Clip source-window semantics need one domain API

Current state:

- Playback/export use `getPlayableAudioWindow(...)`.
- Waveform layout now wraps `getPlayableAudioWindow(...)`.
- Resize still directly mutates `leftPadSec`, `bufferOffsetSec`, and `duration`.
- MIDI drawing still has local trimming math inside `ClipComponent.tsx`.

Recommended next step:

- Promote a single clip-window model that returns timeline and source ranges:
  - `timelineStartSec`
  - `timelineEndSec`
  - `sourceStartSec`
  - `sourceEndSec`
  - `silentLeadSec`
  - `playableDurationSec`
- Keep pixel projection (`PPS`, canvas width, draw columns) as a UI-only adapter.
- Add tests that compare playback, export, waveform, and resize expectations against the same window helper.

Status:

- Partially completed. Waveform layout now consumes `getPlayableAudioWindow(...)`, and regression tests compare waveform output against playback windows.
- Deferred migrating resize/export onto a new expanded `ClipSourceWindow` shape in this pass because playback already exposes the root scheduling helper and resize persists direct timing fields through existing repository contracts.

### 2. Waveform cache identity is too thin

Current state:

- `@daw-browser/waveforms` caches peak records by `assetKey` only.
- Local waveform keys are namespaced as `${projectId}:${sourceAssetKey}`, which prevents cross-project collisions.
- The cache does not validate duration, sample rate, channel count, file size, content hash, or asset revision before reusing stored peaks.

Risk:

- If a local/cloud asset changes while the key stays the same, stale peaks can remain valid forever.
- Replacement/recovery flows are especially sensitive because playback may decode the new source while waveform cache still returns old peaks.

Recommended next step:

- Introduce a `ClipSourceIdentity` / `WaveformSourceIdentity` with:
  - `projectId`
  - `sourceAssetKey`
  - `waveformAssetKey`
  - `sampleUrl`
  - `durationSec`
  - `sampleRate`
  - `channelCount`
  - optional `contentHash`, `sizeBytes`, or asset revision.
- Store identity metadata in `PeakAssetRecord`.
- Validate stored records against identity before reusing them.
- Invalidate or version peak cache on media replacement.

Status:

- Completed within current metadata support. Waveform peak requests now pass a `WaveformSourceIdentity` containing the waveform key plus available source duration, sample rate, and channel count.
- `PeakAssetRecord` stores identity metadata for newly extracted peaks, and cached/stored peak records are rejected when duration, sample rate, channel count, or asset key no longer match.
- Deferred content-hash, size, revision, and explicit replacement invalidation because those fields do not currently exist on clip source metadata or local/cloud timeline repository rows.

### 3. `ClipComponent` still owns too much media logic

Current state:

- `ClipComponent.tsx` draws the interaction shell, renders MIDI notes, renders audio peaks, resolves sample URLs, chooses waveform keys, kicks off buffer hydration, fetches waveform slices, and handles async staleness.

Risk:

- Rendering can accidentally become a second source of truth for media loading and waveform identity.
- Future UI changes may reintroduce timing or source identity drift.

Recommended next step:

- Add a `useClipWaveformViewModel(...)` hook or resolver that owns:
  - source identity
  - buffer preload trigger
  - sample URL resolution
  - waveform slice request
  - audio-vs-MIDI-vs-placeholder state
  - media status
- Make `ClipComponent` consume a dumb view model and draw only.

Status:

- Completed for waveform/media loading. `useClipWaveformViewModel(...)` now owns source identity construction, buffer preload triggering, sample URL resolution, waveform slice requests, and async staleness checks.
- `ClipComponent` still owns drawing and MIDI note rendering because that is UI projection logic.

### 4. Audio buffer cache and waveform cache use different identities

Current state:

- Audio buffers are cached by clip id, then shared by sample URL or source asset key.
- Waveforms are cached by waveform asset key.
- `resolveClipSampleUrl(...)` can produce fallback URLs separate from local asset loading.

Risk:

- Playback and waveform can resolve different underlying sources if key/url/local fallback behavior diverges.

Recommended next step:

- Make both buffer loading and waveform loading consume the same `ClipSourceIdentity`.
- Add regression tests where two clips share a source but have different `leftPadSec` and `bufferOffsetSec`.

Status:

- Partially completed. Waveform loading now uses the same resolved sample URL and decoded buffer metadata as buffer loading, and peak identity validation uses the clip source metadata available to both paths.
- Deferred replacing the clip buffer cache keying strategy because it has existing clip-id plus shared-source behavior and no source revision metadata exists to make a stronger shared identity safe.

### 5. Decoded duration should be authoritative and visible

Current state:

- Playback uses decoded `buffer.duration`.
- Waveform layout now prefers decoded `buffer.duration` when present, otherwise metadata.

Risk:

- If source metadata is wrong, waveform layout can shift after async decode.

Recommended next step:

- Treat decoded duration as authoritative.
- If decoded duration differs from persisted metadata beyond a small epsilon, repair metadata or mark waveform identity stale.
- Expose whether the waveform view model is using metadata duration or decoded duration.

Status:

- Partially completed. Waveform layout and source identity both prefer decoded buffer duration, sample rate, and channel count when present, so cached peaks generated from stale metadata are bypassed after decode.
- Deferred persisted metadata repair and explicit stale-state UI because no validated local/cloud persistence flow currently updates decoded metadata as a background repair from render code.

## Implementation

- Added `ensureClipBuffer` plumbing from `timeline-workspace.tsx` through `TrackLane.tsx` into `ClipComponent.tsx`.
- When an audio clip has waveform metadata but no `buffer` or `sampleUrl`, `ClipComponent` now asks the existing buffer loader to hydrate the clip.
- Reused `getPlayableAudioWindow` for waveform layout so drawing and playback share the same clip `leftPadSec` / `bufferOffsetSec` / duration semantics.
- Prefer decoded `buffer.duration` for waveform layout once available, matching playback.
- Extracted the waveform layout calculation into a focused helper with regression coverage that compares layout output directly against playback scheduling windows.
- Exposed `@daw-browser/audio-engine/audio-scheduling` as a package subpath for the shared scheduling helper.
- Shifted playback visual timer starts by the schedule-ahead window during play, seek while playing, and loop wrap.
- Added waveform source identity metadata validation so stale peak records are rejected when available source duration, sample rate, channel count, or waveform key changes.
- Extracted waveform loading and media preload decisions into `useClipWaveformViewModel`.
- Kept waveform extraction/storage in `@daw-browser/waveforms`; no Diffusion code or new abstraction was introduced.

## Validation

- [x] `bun run typecheck`
- [x] `bun test src/lib/audio-waveform-layout.test.js`
- [x] `bun run knip`
- [x] `git diff --check`
- [x] `bun run build`
- [x] Helium localhost smoke via DevTools: stopped, played from `0.00s`, captured six `AudioBufferSourceNode.start(...)` calls and no page-level errors. First source was scheduled at `currentTime + 0.02s`, matching the scheduler lookahead.
- [x] `bun --filter '@daw-browser/waveforms' check`
- [x] `bun test packages/waveforms/src/source-identity.test.ts`

## Changed Files

- `src/components/timeline/ClipComponent.tsx`
- `src/components/timeline/TrackLane.tsx`
- `src/components/timeline/timeline-workspace.tsx`
- `src/lib/audio-waveform-layout.ts`
- `src/lib/audio-waveform-layout.test.js`
- `src/hooks/useTimelinePlayback.ts`
- `knip.json`
- `packages/audio-engine/package.json`
- `packages/waveforms/package.json`
- `packages/waveforms/src/asset-store.ts`
- `packages/waveforms/src/extract-peaks.ts`
- `packages/waveforms/src/source-identity.ts`
- `packages/waveforms/src/source-identity.test.ts`
- `packages/waveforms/src/types.ts`
- `src/hooks/useClipWaveformViewModel.ts`
