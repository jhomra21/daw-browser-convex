# Audio Warping Tracker

## Scope

Design an Ableton-like per-audio-clip warp model where users can choose whether a sample follows project BPM or remains in its natural source time. The first version should prioritize correct timing architecture, waveform/playback/export alignment, and a clean path to pitch-preserving DSP later.

## First-Version Opinion

Our architecture can support per-clip warp, but warp must become a canonical clip timing model, not a playback-only flag.

Recommended v1:

- Persist per-clip warp state.
- Add one pure source-time to timeline-time mapper.
- Drive waveform rendering from that mapper.
- Drive live audio and export from that mapper.
- Start with a Re-Pitch/varispeed audio mode.
- Add pitch-preserving stretch later behind a DSP boundary.

If we skip the shared timing model, playback, export, resize, BPM changes, and waveform visuals will drift apart.

## Validation Updates

The tracker has been validated against the current codebase. The plan is still sound, with these clarifications:

- The BPM ratio must use one consistent interpretation:
  - `playbackRate = projectBpm / sourceBpm`
  - `sourceSecondsPerTimelineSecond = playbackRate`
  - `timelineSecondsPerSourceSecond = sourceBpm / projectBpm`
- `clip.duration` should remain the authored timeline width in v1.
- The mapper should compute how much source audio is consumed inside that authored timeline width.
- If enabling warp should resize the clip to its natural warped length, that should be a deliberate one-time product action, not an implicit invariant.
- `sourceBpm` is user-entered or manually defaulted in v1. Auto BPM detection is not part of v1.
- Warp persistence must include undo/history, local repository adapters, remote timeline cache, clip creation, cloud/shared operation paths, and Convex/local rows.

## Implementation Status

Updated 2026-06-12:

- Completed core v1 timing model for persisted clip `audioWarp` state and a shared `getAudioClipTimeMap(...)` helper.
- Live playback, offline export, and waveform layout now use the same timeline/source map for audio clips.
- Re-Pitch/varispeed mode is implemented through `AudioBufferSourceNode.playbackRate`.
- Local timeline rows, remote timeline cache, shared clip-create payloads, and Convex clip rows now carry `audioWarp`.
- Added a waveform regression covering BPM-dependent warped density.
- Added focused bottom-panel sample controls for selected audio clips: Warp toggle, source BPM, read-only project BPM, read-only ratio, and Re-Pitch mode label.
- Direct warp edits now persist through local repositories and durable shared timeline operations, update optimistic clip state, reschedule changed clips during playback, and push undo/redo history through the existing clip-timing history path.
- Completed Gate 1 pure WSOLA DSP core in `packages/audio-engine`, with linked multi-channel processing, exact requested output frame counts, bounded output peak normalization, and automated deterministic/duration/pitch/continuity/performance coverage.
- Added the `AudioStretchCache` memory service in `packages/audio-engine` using the in-house WSOLA core, shared by live playback and export.
- Live playback now warms Stretch renders and uses stretched buffers when ready, falling back to Re-Pitch while rendering or after live render failure.
- Offline export now renders missing Stretch buffers synchronously through the same cache path and fails with a clear clip-scoped error if Stretch rendering fails.
- The sample clip panel now lets users choose Re-Pitch or Stretch and shows the Stretch quality/fallback warning for ratios outside the preferred range.
- Completed manual listening fixture support for Stretch quality checks. `packages/audio-engine/src/audio-stretching.test.ts` now has an opt-in fixture path that writes deterministic WAV files when `AUDIO_STRETCH_FIXTURE_DIR` is provided.
- Completed Stretch v1 hardening: the live stretch cache now persists rendered buffers to IndexedDB where available, uses deterministic keys that include clip timing, warp mode/BPM, project BPM, sample rate, channel count, buffer length, and a content fingerprint, and exposes render status for minimal selected-clip UI.
- Deferred warp markers. The current timing model is constant-rate only, and the tracker's Pitch-Preserving Stretch Decisions explicitly defer variable-rate segments. Adding markers now would require a persisted segment mapping contract and UI semantics that are not specified.
- Completed Auto BPM detection v1 for decoded/imported audio loops. The first pass uses an in-house deterministic onset/autocorrelation detector in `packages/audio-engine`, keeps low-confidence suggestions ephemeral, and auto-applies high-confidence import/manual detections through the existing clip warp write/history path with Warp enabled and Stretch mode selected.
- Deferred advanced stretch-resize gestures. The current resize path only models left trim/pad and right duration resize, with no gesture distinction for "trim resize" versus "stretch resize"; adding it now would require product-level interaction semantics and a pure resize contract extension.
- Remaining: warp markers, auto BPM detection, and advanced stretch-resize gestures remain future work.

## Pitch-Preserving Stretch Decisions

Grill-me decisions from 2026-06-12:

- Use an in-house algorithm. Do not add Rubber Band, SoundTouchJS, or other DSP dependencies for engine stretch.
- Start with offline-only in-house WSOLA pre-rendering, not real-time AudioWorklet stretching.
- Keep Re-Pitch as the live fallback while a pitch-preserving render is pending.
- Cache stretched buffers in memory first. Defer IndexedDB persistence until quality and invalidation are proven.
- Render the visible/playable clip source window plus a small analysis margin, not whole source buffers.
- If live Stretch rendering fails, fall back to Re-Pitch and show an explicit warning state.
- If export Stretch rendering fails, fail the export with a clear error instead of silently exporting Re-Pitch.
- Optimize the first quality pass for melodic loops and short musical samples.
- Support a hard stretch range of `0.5x` to `2x`, with a quality warning outside `0.75x` to `1.33x`.
- Use the same rendered-buffer path for live playback and export.
- Keep the stretcher in `packages/audio-engine` behind a narrow `AudioStretcher` boundary.
- Own stretched-buffer caching through a pure cache service in `packages/audio-engine`; `AudioEngine` can own one live instance, and export can create or receive one.
- Validate with both automated technical checks and manual listening fixtures.
- Do not hide Stretch behind a feature flag on this branch.
- Let users choose between Re-Pitch and Stretch. Re-Pitch remains a valid creative mode.
- Render automatically after a short debounce when Stretch mode is selected or BPM/source BPM changes; export renders synchronously if cache is missing.
- If BPM/source BPM changes during playback, keep playing Re-Pitch until the new stretched render is ready, then reschedule the affected clip if still playing.
- Use multi-channel linked WSOLA from the start: compute the best overlap offset from mono-summed analysis and apply the same offset to all channels.
- Implement the DSP core on plain `Float32Array[]` channel data plus sample rate, with thin adapters to/from `AudioBuffer`.
- Support constant-rate stretching only for now. Defer warp markers and variable-rate segments.

## Pitch-Preserving Stretch Production Sequence

Treat the in-house WSOLA stretcher as production-quality engine code, not an experimental module. The implementation should still be gated so each layer proves its contract before the next layer depends on it.

Recommended sequence:

1. Build the pure WSOLA DSP core and tests first.
2. Add the memory cache/service boundary in `packages/audio-engine`.
3. Wire live playback to use stretched buffers when ready, with Re-Pitch fallback while rendering.
4. Wire export to use the same rendered-buffer path and fail clearly if Stretch rendering fails.
5. Add UI status/warning states for rendering, quality warning range, and fallback.
6. Add manual listening fixtures after automated technical checks pass.

Gate 1 pass criteria for the pure WSOLA core:

- Deterministic output for the same input and config.
- Requested output duration is exact within one sample.
- Output preserves sample rate and channel count.
- Output contains no `NaN` or `Infinity` samples.
- Output peaks remain bounded and do not introduce clipping beyond a small epsilon.
- Linked stereo channels remain sample-aligned.
- Sine fixture retains approximate fundamental pitch.
- Short loop-like synthetic fixture has no obvious edge discontinuity spikes.
- Offline render performance is acceptable for a few-second clip.

Initial automated fixtures:

- Single sine tone for objective duration and approximate pitch sanity checks.
- Short loop-like synthetic pattern for continuity, bounded peak, and no-invalid-sample checks.

Leave WSOLA tuning parameters such as window size, overlap, tolerance, and crossfade shape to the implementation/testing loop. They should be selected from measured results and listening fixtures, not locked in by planning alone.

## Current Repo Findings

Canonical audio clip timing is seconds-based:

```ts
type Clip = {
  startSec: number
  duration: number
  sourceDurationSec?: number
  leftPadSec?: number
  bufferOffsetSec?: number
}
```

Important files:

- `packages/timeline-core/src/types.ts`
- `convex/schema.ts`
- `src/lib/timeline-repository/types.ts`
- `packages/audio-engine/src/audio-scheduling.ts`
- `packages/audio-engine/src/clip-scheduler.ts`
- `packages/audio-engine/src/export-mixdown.ts`
- `src/lib/audio-waveform-layout.ts`
- `src/components/timeline/ClipComponent.tsx`
- `src/hooks/useClipResize.ts`

Current invariant to preserve:

- `getAudioClipTimeMap(...)` is the shared timing mapper for live playback, export, and waveform layout.
- Audio clips are currently absolute seconds.
- BPM affects MIDI, grid/snapping, resize snapping, and metronome.
- BPM does not alter audio clip duration, waveform density, or source playback speed.

That behavior is correct for unwarped clips.

## Diffusions Findings

Diffusions has the best architectural pattern to borrow.

Relevant files:

- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/utils/time.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/components/components.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/systems/timeline.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/decoders/audio.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/decoders/time-stretcher.ts`
- `/Users/juan/Documents/monorepo-new/apps/web/src/components/engine/timeline/render/audio.ts`

Core timing principle:

```ts
const startFrame = delayInFrames + trimStartFrame / playbackRate
const endFrame = delayInFrames + trimEndFrame / playbackRate
```

Equivalent principle for this repo:

```ts
timelineDuration = sourceDuration * timelineSecondsPerSourceSecond
sourceTime = timelineLocalTime * playbackRate
```

For v1, this principle informs the mapper, but `clip.duration` remains explicit. We do not derive and overwrite clip duration on every BPM change.

Borrow:

- Source window separate from timeline placement.
- Computed source-to-timeline mapping.
- Waveform uses the same rate/mapping as playback.
- Rate edits preserve clip anchors explicitly.
- Time-stretch DSP sits behind a decoder/render boundary.

Do not copy:

- Diffusions' ECS architecture.
- Its full decoder pipeline.
- Its WSOLA implementation without quality testing.

## External DAW And DSP Findings

### Ableton

Ableton's model is clip-level:

- Per-clip Warp toggle.
- Source/original BPM.
- Project BPM remaps warped clips.
- Unwarped clips stay in source seconds.
- Warp markers map source-time to beat-time.
- Modes include Beats, Tones, Texture, Re-Pitch, Complex, and Complex Pro.

Key lesson: warp is clip timebase, not just playback behavior.

### REAPER

REAPER's useful concept is item timebase:

- Time.
- Beats position only.
- Beats position, length, and rate.

This maps well to:

```ts
audioWarp.enabled === false // time-based
audioWarp.enabled === true  // beat/project-tempo based
```

### Web Audio And JS Libraries

Native Web Audio:

```ts
source.playbackRate.value = rate
```

This changes speed and pitch, so it is suitable only for Re-Pitch/varispeed.

Pitch-preserving warp requires a stretcher:

- SoundTouchJS: useful tempo/rate/pitch API reference.
- `soundtouchjs-audio-worklet`: useful AudioWorklet integration shape.
- Rubber Band WASM: likely higher quality, heavier integration.
- wavesurfer examples/issues: useful visual/audio caveats.
- Tone.js issues: duration and stop-time must account for playback rate.

## Proposed Clip Model

Add warp state to `Clip`, persisted in local repository and Convex:

```ts
export type AudioWarpMode = 'repitch' | 'stretch'

export type AudioWarp = {
  enabled: boolean
  sourceBpm?: number
  mode: AudioWarpMode
}

export type Clip<TBuffer = never> = {
  startSec: number
  duration: number
  sourceDurationSec?: number
  leftPadSec?: number
  bufferOffsetSec?: number
  audioWarp?: AudioWarp
}
```

MVP defaults:

```ts
audioWarp: {
  enabled: false,
  mode: 'repitch',
}
```

Do not add warp markers in v1.

## Core Mapping Helper

The most important implementation is a shared pure helper:

```ts
type AudioClipTimeMapInput = {
  clip: Pick<
    Clip,
    | 'startSec'
    | 'duration'
    | 'leftPadSec'
    | 'bufferOffsetSec'
    | 'sourceDurationSec'
    | 'audioWarp'
  >
  bufferDurationSec: number
  projectBpm: number
  rangeStartSec: number
  rangeEndSec?: number
}

type AudioClipTimeMap = {
  timelineStartSec: number
  timelineEndSec: number
  sourceStartSec: number
  sourceEndSec: number
  timelineDurationSec: number
  sourceDurationSec: number
  sourceSecondsPerTimelineSecond: number
  timelineSecondsPerSourceSecond: number
  playbackRate: number
  mode: 'raw' | 'repitch' | 'stretch'
  timelineToSourceSec: (timelineSec: number) => number
  sourceToTimelineSec: (sourceSec: number) => number
}
```

Use explicit names, not a vague `rate`:

```ts
const playbackRate = projectBpm / sourceBpm
const sourceSecondsPerTimelineSecond = playbackRate
const timelineSecondsPerSourceSecond = sourceBpm / projectBpm
```

Interpretation:

- Source 120 BPM into project 60 BPM gives `playbackRate = 0.5`, so one timeline second consumes 0.5 source seconds.
- The natural warped timeline duration of that source doubles because `timelineSecondsPerSourceSecond = 2`.
- Source 120 BPM into project 240 BPM gives `playbackRate = 2`, so one timeline second consumes 2 source seconds.
- The natural warped timeline duration halves because `timelineSecondsPerSourceSecond = 0.5`.
- `AudioBufferSourceNode.playbackRate` uses the playback-rate interpretation.

V1 duration policy:

- `clip.duration` is explicit authored timeline width.
- `timelineDurationSec` is the playable portion inside the requested timeline range.
- `sourceDurationSec` is the source span consumed by that timeline portion.
- Natural warped duration may be computed for UI display or a one-time "fit to project BPM" action, but should not silently replace `clip.duration` on project BPM changes.

## Scheduler Rule

MVP Re-Pitch scheduling should use the shared map:

```ts
const map = getAudioClipTimeMap({
  clip,
  bufferDurationSec: clip.buffer.duration,
  projectBpm,
  rangeStartSec: playheadSec,
  rangeEndSec: endLimitSec,
})

if (!map) return

const source = ctx.createBufferSource()
source.buffer = clip.buffer

if (map.mode === 'repitch') {
  source.playbackRate.value = map.playbackRate
}

source.connect(input)
source.start(
  nowCtx + Math.max(0, map.timelineStartSec - playheadSec),
  map.sourceStartSec,
  map.timelineDurationSec,
)
```

Important: `AudioBufferSourceNode.start(..., duration)` takes duration in output time, while `offset` is source time. The helper must return both explicit source and timeline durations.

## Waveform Rule

Waveform rendering must use the same map:

```ts
const map = getAudioClipTimeMap({
  clip,
  bufferDurationSec: sourceDurationSec,
  projectBpm,
  rangeStartSec: clip.startSec,
  rangeEndSec: clip.startSec + clip.duration,
})

const drawCols = Math.floor(map.timelineDurationSec * PPS)

const sourceStartSec = map.timelineToSourceSec(map.timelineStartSec)
const sourceEndSec = map.timelineToSourceSec(
  map.timelineStartSec + drawCols / PPS,
)
```

Visual rule: each screen pixel represents timeline time, then timeline time maps back into source time. Changing project BPM while warp is enabled changes waveform density inside the clip.

## Diffusions-Inspired API Design Direction

Take inspiration from Diffusions' domain-grouped engine helpers, but do not copy its ECS. The API should feel like small, explicit domain surfaces, not generic utility bags.

Preferred shape:

```ts
const map = audioWarp.time.map({
  clip,
  bufferDurationSec,
  projectBpm,
  rangeStartSec,
  rangeEndSec,
})

const sourceBpm = audioWarp.bpm.source(clip, projectBpm)
const nextClip = audioWarp.bpm.setSource(clip, 128)

const peaks = waveform.peaks.select({
  assetKey,
  sourceStartSec: map.sourceStartSec,
  sourceEndSec: map.sourceEndSec,
  bins: map.timelinePixelWidth,
})
```

Concrete naming targets:

- `audioWarp.time.map(...)`: canonical timeline/source mapping.
- `audioWarp.bpm.source(...)`: resolves clip source BPM with fallback policy.
- `audioWarp.bpm.setSource(...)`: returns the clip warp patch for a source BPM edit.
- `audioWarp.bpm.project(...)`: clamps/resolves project BPM for warp math if needed.
- `waveform.peaks.select(...)`: source-window peak selection driven by the map.
- `audioWarp.resize.apply(...)`: pure resize helper for warped audio clips.
- `audioWarp.schedule.window(...)`: scheduling window derived from the same map, if playback/export need a narrower wrapper.

Implementation note: these can be plain exported objects or modules. The important part is the callsite language and grouping, for example `waveform.peaks` and `audioWarp.bpm`, not adopting Diffusions' component storage model.

Avoid:

- `getRate(...)` style helpers with ambiguous units.
- Separate waveform/playback/export math.
- Mutating helpers. Prefer patch-returning helpers:

```ts
const patch = audioWarp.bpm.setSource({
  clip,
  sourceBpm: 128,
  projectBpm,
})
```

## Resize Semantics

Recommended v1 behavior:

Unwarped clips:

- Keep current behavior.
- Left resize trims/pads source.
- Right resize changes timeline duration.
- BPM does not affect audio source mapping.

Warped clips:

- Left resize changes source offset through the mapper.
- Right resize changes timeline duration.
- Source consumed is derived by `timelineDuration * playbackRate`.
- BPM changes alter visual/audio mapping.

Keep warp math out of `useClipResize.ts` by adding a pure helper:

```ts
function resizeWarpedAudioClip(input: {
  clip: Clip
  edge: 'left' | 'right'
  nextStartSec?: number
  nextEndSec?: number
  projectBpm: number
}) {
  // returns timing patch:
  // startSec, duration, bufferOffsetSec, leftPadSec
}
```

## UI Plan

The Ableton-style bottom-panel idea fits the current app.

Do not build a generic inspector in v1. Add a focused clip detail section when the selected clip is audio.

V1 controls:

- Warp toggle.
- Source BPM number input.
- Read-only Project BPM.
- Read-only computed ratio.
- Later: Mode, Re-Pitch / Stretch.

Example shape:

```tsx
<Show when={selectedAudioClip()}>
  {(clip) => (
    <SampleClipPanel
      clip={clip()}
      projectBpm={props.bpm}
      onWarpChange={commitClipWarp}
    />
  )}
</Show>
```

## Implementation Phases

### Phase 1: Data And Pure Timing Model

- Add `audioWarp` to clip types.
- Persist in Convex and local repository.
- Add `getAudioClipTimeMap(...)`.
- Add the initial API surface around `audioWarp.time`, `audioWarp.bpm`, and `waveform.peaks`.
- Add mapping unit tests.
- No UI/audio changes yet.

Persistence files to account for include:

- `packages/timeline-core/src/types.ts`
- `convex/schema.ts`
- `convex/clips.ts`
- `src/lib/timeline-repository/types.ts`
- `src/lib/timeline-repository/local-timeline-repository.ts`
- `src/lib/timeline-repository/track-row-adapter.ts`
- `src/lib/clip-create.ts`
- `src/lib/remote-timeline-cache.ts`
- `src/lib/resolve-timeline-tracks.ts`
- `src/lib/undo/*`
- shared/cloud operation paths that create, update, or replay clip timing state

### Phase 2: Waveform Warp

- Update `src/lib/audio-waveform-layout.ts`.
- Make waveform density change with BPM when warp is enabled.
- Keep unwarped behavior identical.

### Phase 3: Re-Pitch Audio MVP

- Use `AudioBufferSourceNode.playbackRate`.
- Make live playback and export use the same helper.
- Label this honestly as Re-Pitch/varispeed.

### Phase 4: Clip UI

- Add bottom-panel `SampleClipPanel`.
- Persist warp toggle/source BPM per clip.
- Reschedule changed clips after warp edits.

### Phase 5: Pitch-Preserving Stretch

- Add an `AudioStretcher` boundary.
- Evaluate Rubber Band WASM versus SoundTouchJS/AudioWorklet.
- Cache stretched buffers for export/live reuse where appropriate.

### Phase 6: Advanced Ableton Behavior

- Warp markers.
- Auto BPM detection.
- Beats/Tones/Texture/Complex-style modes.
- Stretch-resize gesture distinct from trim-resize.

## Main Risks

1. Playback-only warp flag: guaranteed visual/export drift.
2. Ambiguous rate naming: use `sourceSecondsPerTimelineSecond` and `playbackRate`.
3. Pitch-preserving DSP too early: high complexity, defer behind an interface.
4. Resize behavior ambiguity: define trim vs stretch before coding.
5. Collaboration/undo missing fields: warp edits must be persisted and undoable like timing.

## Recommendation

Build v1 as Ableton-like timing semantics with Re-Pitch audio, not full Ableton DSP. This gives us correct architecture, visual behavior, BPM-following clips, export consistency, and a clean path to real pitch-preserving stretch later.
