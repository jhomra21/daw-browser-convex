# Drum Rack Instrument Tracker

## Status

- Branch: `instrument-drum-rack`
- Scope: Planning tracker for an Ableton-inspired Drum Rack instrument and reusable instrument plumbing.
- Implementation policy: no code changes are included in this tracker commit.
- Validation target after implementation: `git diff --check`, `bun run typecheck`, `bun test`, `bun run knip`, `bun run build`.

## Goal

Add an Ableton-inspired Drum Rack instrument for instrument tracks, backed by reusable instrument state, persistence, live playback, offline export, undo, and browser drag/drop integration.

## Research Summary

### Ableton behavior

- Ableton's closest model is Drum Rack plus Simpler.
- Drum Rack is a pad grid. Pads map to MIDI notes.
- Dropping a sample onto an empty pad creates or configures an internal sample playback device for that pad.
- Empty pads show their MIDI note assignment, not default drum names.
- When a sample is dropped on a pad, the pad label becomes the sample filename.
- Simpler/Sampler handles sample playback, envelopes, pitch behavior, and one-shot style playback.
- C3 is commonly treated as the original pitch/root for sampler-style pitched playback, while Drum Rack pads trigger fixed samples by assigned MIDI note.
- Local Ableton reference directory currently only has effects screenshots, no Drum Rack or Simpler images.

### Current repo findings

- `AUDIO_EFFECT_CONTRACTS` is mature for audio effects, but instruments should use a thinner contract.
- Synth and Arpeggiator currently live in the existing effects persistence path through `createEffectsPanelInstrumentDevice`, `createPersistedEffectState`, and `createLocalEffectRows`.
- Synth is currently implicit on instrument tracks through default params, so row presence alone cannot define the active instrument.
- MIDI scheduling already produces note events through `getScheduledMidiEvents`.
- Live synth playback is oscillator-only in `packages/audio-engine/src/synth-runtime.ts`.
- Offline export duplicates synth MIDI rendering in `packages/audio-engine/src/export-mixdown.ts`.
- Browser sample drag data already provides `assetKey`, `url`, `sourceKind`, `source`, and optional `name`.
- Do not invent `sampleAssetId` or persist `AudioBuffer`.

### Reference codebase findings

- `/Users/juan/Documents/monorepo-new`: per-entity audio bus ownership and cache separation are useful for track and pad resource cleanup.
- `/Users/juan/Documents/dialkit`: snapshot-like parameter stores and Solid adapter cleanup patterns are useful for instrument panel state.
- Borrow explicit ownership, deterministic cleanup, and narrow consumer-shaped APIs.
- Reject broad generic abstractions that are not needed by current Synth and Drum Rack consumers.

## Key Decisions

- One active top-level instrument per instrument track.
- Drum Rack and Synth are exclusive. Adding one switches away from the other.
- Arpeggiator remains a MIDI effect before the instrument.
- Sample preview from a pad should play through the selected track's full FX chain.
- A standalone Sampler browser instrument is out of MVP scope. Sample playback is an internal Drum Rack pad voice.
- Drum Rack state is one params blob per track, not one row per pad.
- Pad sample identity uses existing sample drag fields: `assetKey`, `url`, `name`, `sourceKind`, and `source`.
- Empty pads show note labels only. Dropped samples set the pad display name from the sample filename.
- Live and offline Drum Rack scheduling should share a helper to avoid duplicate sample-hit logic.

## Shared Data Model

Add shared Drum Rack and instrument params in the shared package.

```ts
export type DrumRackPadSample = {
  assetKey: string
  url: string
  name?: string
  sourceKind: AudioSourceKind
  source: {
    durationSec: number
    sampleRate: number
    channelCount: number
  }
}

export type DrumRackPadParams = {
  id: string
  note: number
  name?: string
  sample?: DrumRackPadSample
  gain: number
  pan: number
  transpose: number
  startSec: number
  endSec?: number
  mute: boolean
  chokeGroup: number
}

export type DrumRackParams = {
  pads: DrumRackPadParams[]
  selectedPadId?: string
}

export type TrackInstrumentParams =
  | { kind: "synth"; params: SynthParams }
  | { kind: "drum-rack"; params: DrumRackParams }
```

Use a thin instrument contract:

- `InstrumentKind = "synth" | "drum-rack"`
- `createDefaultParams`
- `normalizeParams`
- `serializeParams`

Do not mirror audio effect contracts exactly:

- no `masterKind`
- no chain order
- no master bus support

## Sample Assignment

Use existing Browser sample payloads.

```ts
function sampleToPadSample(sample: SampleDragData): DrumRackPadSample {
  return {
    assetKey: sample.assetKey,
    url: sample.url,
    name: sample.name,
    sourceKind: sample.sourceKind,
    source: sample.source,
  }
}

function assignSampleToPad(
  params: DrumRackParams,
  padId: string,
  sample: SampleDragData,
): DrumRackParams {
  return {
    ...params,
    pads: params.pads.map((pad) =>
      pad.id === padId
        ? { ...pad, name: sample.name ?? pad.name, sample: sampleToPadSample(sample) }
        : pad,
    ),
    selectedPadId: padId,
  }
}
```

## Runtime Architecture

Replace the synth-only scheduling boundary with a thin instrument runtime shaped around `AudioEngine`.

```ts
type InstrumentRuntime = {
  setTrackInstrument: (trackId: string, params: TrackInstrumentParams) => void
  clearTrackInstrument: (trackId: string) => void
  scheduleMidiClip: (
    track: Track<AudioBuffer>,
    clip: Clip<AudioBuffer>,
    playheadSec: number,
    nowCtx: number,
    endLimitSec?: number,
  ) => boolean
  previewDrumRackPad: (trackId: string, padId: string, velocity: number) => void
  disposeTrack: (trackId: string) => void
}
```

Drum Rack runtime requirements:

- Precompute `Map<number, padIndex>` per track for O(1) note-to-pad lookup.
- Use `AudioBufferSourceNode` per triggered pad.
- Connect pad hit nodes into the track input so existing track FX apply.
- Use a short fade when choking active notes to avoid clicks.
- Register scheduled sources with `SourceRegistry.add(clip.id, source)` so clip stops remain correct.
- Keep sample buffer loading outside the runtime. Runtime consumes resolved buffers or a resolved config.

Shared sample-hit helper:

```ts
function scheduleDrumRackHit(input: {
  ctx: BaseAudioContext
  destination: AudioNode
  buffer: AudioBuffer
  pad: DrumRackPadParams
  when: number
  velocity: number
}): AudioBufferSourceNode | null {
  if (input.pad.mute) return null

  const source = input.ctx.createBufferSource()
  source.buffer = input.buffer
  source.playbackRate.value = Math.pow(2, input.pad.transpose / 12)

  const gain = input.ctx.createGain()
  gain.gain.setValueAtTime(input.velocity * input.pad.gain, input.when)

  const pan = input.ctx.createStereoPanner()
  pan.pan.value = input.pad.pan

  source.connect(gain)
  gain.connect(pan)
  pan.connect(input.destination)

  const endSec = input.pad.endSec ?? input.buffer.duration
  source.start(input.when, input.pad.startSec, Math.max(0, endSec - input.pad.startSec))
  return source
}
```

## Persistence And Compatibility

Use the existing local and Convex effect-row path initially because the repo already persists Synth and Arpeggiator there.

Add:

- local kind for instrument or Drum Rack state
- shared operation for setting the active track instrument
- Convex mutation for setting active track instrument
- remote read compatibility for legacy `synth` rows

Correct shape:

- New writes should prefer one active instrument row/blob per track.
- Legacy `synth` rows should be read as `{ kind: "synth" }` during migration.
- Adding Drum Rack should clear or supersede Synth in the active-instrument model.
- Adding Synth should clear or supersede Drum Rack.

## UI Plan

### Browser

- Add Drum Rack to the `midi-instruments` tab.
- Dropping Drum Rack on an existing instrument track switches that track's active instrument to Drum Rack.
- Dropping Drum Rack on a new track creates an instrument track, sets Drum Rack, and creates/selects a MIDI clip.
- Keep Synth browser behavior, but route it through the active-instrument switch.

### Effects panel

- Render the instrument section from the active instrument.
- Show Synth or Drum Rack, not both.
- Keep Arpeggiator as a separate MIDI effect card before the instrument.
- Preserve existing Synth behavior after migration.

### Drum Rack component

- Add `src/components/effects/DrumRack.tsx`.
- Use an explicit 4x4 pad grid.
- Pad displays:
  - sample filename when assigned
  - MIDI note label when empty
  - selected state
  - muted or disabled state
- Pad detail area displays:
  - sample name
  - note
  - gain
  - pan
  - attack and release if included in MVP
  - choke group if included in MVP
- Dragging a sample from the assets browser onto a pad assigns that sample to the pad.
- Clicking a pad previews through the track FX chain.

## Export Plan

- Extend export FX/instrument collection so each track can provide `TrackInstrumentParams`.
- Render Synth and Drum Rack through shared instrument scheduling helpers.
- Resolve Drum Rack pad buffers before or during export using existing sample URL and buffer-loading paths.
- Do not persist decoded buffers.
- Avoid adding another copy of the Drum Rack scheduling algorithm in `export-mixdown.ts`.

## Phased Implementation

### Phase 1: Shared instrument params

Files:

- `packages/shared/src/instrument-params.ts`
- `packages/shared/src/drum-rack-params.ts`
- shared exports and tests

Add:

- `InstrumentKind`
- `TrackInstrumentParams`
- `INSTRUMENT_CONTRACTS`
- Drum Rack defaults, normalization, serialization, and note helpers

### Phase 2: Persistence and operations

Files:

- `packages/shared/src/shared-timeline-operations.ts`
- `convex/effects.ts`
- `api/timeline-operation-executor.ts`
- `src/lib/local-effects.ts`

Add:

- operation parser and durable operation for active track instrument
- local persistence support
- Convex mutation support
- compatibility with existing `synth` rows

### Phase 3: Effects panel instrument state

Files:

- `src/components/timeline/create-effects-panel-state.ts`
- `src/components/timeline/create-effects-panel-controller.ts`
- `src/hooks/useEffectsPanelAudioSync.ts`
- `src/components/timeline/EffectsPanel.tsx`

Add:

- active instrument accessor
- switch instrument action
- Drum Rack state
- Synth migration into the shared active-instrument model

### Phase 4: Audio runtime

Files:

- `packages/audio-engine/src/instrument-runtime.ts`
- `packages/audio-engine/src/drum-rack-runtime.ts`
- `packages/audio-engine/src/audio-engine.ts`
- `packages/audio-engine/src/clip-scheduler.ts` or current MIDI scheduling boundary
- shared scheduling helper for live and offline use

Add:

- track instrument set/clear methods
- Drum Rack note scheduling
- pad preview through track input and FX
- deterministic cleanup for track disposal and transport stop

### Phase 5: Browser and drag/drop

Files:

- `src/components/timeline/browser/browser-drag-types.ts`
- `src/hooks/useTimelineBrowserController.ts`
- `src/components/Timeline.tsx`
- `src/components/timeline/timeline-device-insert-actions.ts`

Add:

- Drum Rack browser item
- active instrument drop payload
- sample-to-pad drop support using existing `SampleDragData`

### Phase 6: Drum Rack UI

Files:

- `src/components/effects/DrumRack.tsx`
- small local child components only if the file becomes hard to scan

Add:

- explicit 4x4 grid
- pad detail panel
- sample assignment
- pad preview
- reset and mute controls as needed for MVP

### Phase 7: Export and undo

Files:

- `packages/audio-engine/src/export-mixdown.ts`
- `src/lib/export/run-export-job.ts`
- `src/lib/undo/types.ts`
- `src/lib/undo/history-persistence.ts`
- `src/lib/undo/exec.ts`
- track delete/restore effect snapshot paths

Add:

- active instrument snapshots
- Drum Rack undo restore
- Drum Rack offline rendering
- stem rendering support

### Phase 8: Tests and validation

Add tests for:

- Drum Rack normalization and serialization
- sample assignment preserving existing `SampleDragData` fields
- note-to-pad routing
- exclusive instrument switching
- legacy Synth row compatibility
- live scheduling helper behavior
- offline export scheduling behavior
- undo restore for Synth and Drum Rack

Run:

```sh
git diff --check
bun run typecheck
bun test
bun run knip
bun run build
```

## Scope Cuts

Not included in MVP:

- standalone Sampler browser instrument
- pitched keyboard Sampler instrument
- per-pad effects chains
- per-pad sends and return chains
- macro controls
- pad layering
- slice mode
- 128-pad scrolling
- step sequencer
- velocity layers
- round-robin

## Risks To Avoid

- Do not infer active instrument from row presence alone.
- Do not create `sampleAssetId`; use existing `assetKey` and sample metadata.
- Do not persist `AudioBuffer`.
- Do not duplicate live and offline sample-hit scheduling.
- Do not add broad generic instrument abstractions before Synth and Drum Rack prove the need.
- Do not typecast in implementation.
- Do not make Pad state 16 separate DB rows.
- Do not make a standalone Sampler part of the MVP browser surface.
