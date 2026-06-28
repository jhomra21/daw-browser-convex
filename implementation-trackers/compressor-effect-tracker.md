# Compressor Effect Implementation Tracker

## Goal

Add a high-quality Ableton-inspired Compressor audio effect with custom AudioWorklet DSP, local/remote persistence, live and offline audio-engine support, effects panel UI, browser insertion, and validation.

## References

- Ableton reference images:
  - `/private/tmp/ableton-ui-reference/compressor-main.png`
  - `/private/tmp/ableton-ui-reference/compressor-transfer-curve.png`
  - `/private/tmp/ableton-ui-reference/compressor-output.png`
  - `/private/tmp/ableton-ui-reference/compressor-sidechain.png`
- Local reference codebases:
  - `/Users/juan/Documents/monorepo-new/apps/web/src/hooks/use-volume-meter.ts`
  - `/Users/juan/Documents/monorepo-new/apps/web/src/components/sidebar-right/soundboard/volume-meter.tsx`
  - `/Users/juan/Documents/dialkit/src/solid/components/Slider.tsx`
  - `/Users/juan/Documents/dialkit/src/solid/components/SegmentedControl.tsx`
- DSP references:
  - Giannoulis, Massberg, Reiss, “Digital Dynamic Range Compressor Design”
  - WebKit `DynamicsCompressorKernel`
  - FAUST `compressors.lib`
  - JUCE `dsp::Compressor`
  - `jadujoel/sidechain-compressor-audio-worklet`

## Architecture Decisions

- Use a custom `AudioWorkletProcessor`, not `DynamicsCompressorNode`.
- Use the same worklet source for live playback and offline export.
- Do not allocate inside `AudioWorkletProcessor.process()`.
- Defer live compressor metering until the UI consumes it; do not post unused worklet messages.
- Use `WeakSet<BaseAudioContext>` module registration and race guards, based on `monorepo-new` volume meter.
- Use subscription tokens to discard stale async node creation.
- Persist DSP parameters only. Keep graph `viewMode` local to `Compressor.tsx`.
- Use ratio `1..100`; display `inf:1` for `ratio >= 100`, never serialize `Infinity`.
- Phase 1 sidechain scope is internal detector shaping only. External sidechain track routing is a later phase.

## Phase 1: Shared Params And Contracts

Files:
- `packages/shared/src/effects-params.ts`
- `packages/shared/src/effects-params.test.ts`

Add:
- `CompressorDetectorMode = 'peak' | 'rms'`
- `CompressorDynamicsMode = 'compress' | 'expand'`
- `CompressorEnvelopeCurve = 'log' | 'linear'`
- `CompressorSidechainFilterType = 'lowpass' | 'highpass' | 'bandpass'`
- `CompressorSidechainParams`
- `CompressorParams`
- `CompressorParamsLite`
- `CompressorParamsInput`
- range constants
- `createDefaultCompressorParams`
- type guards
- `normalizeCompressorParams`
- `normalizeCompressorParamsForUpdate`
- `serializeCompressorParams`
- `computeCompressorStaticCurveDb`

Update:
- `AudioEffectKind` includes `compressor`
- `MasterAudioEffectKind` includes `master-compressor`
- `AudioEffectContractByKind` includes compressor
- `AUDIO_EFFECT_CONTRACTS.compressor`
- `AUDIO_EFFECT_ORDER = ['eq', 'compressor', 'saturator', 'delay', 'reverb']`
- `isAudioEffectKind`

Shared tests:
- defaults and clamping
- invalid enum fallback
- serialization stability
- audio effect order with compressor
- hard-knee compression
- soft-knee continuity
- expansion below threshold
- expansion unchanged above threshold

## Phase 2: Persistence And Shared Operations

Files:
- `convex/effects.ts`
- `packages/shared/src/shared-timeline-operations.ts`
- `api/timeline-operation-executor.ts`
- `src/lib/local-effects.ts`
- `src/lib/undo/types.ts`
- `src/lib/undo/history-persistence.ts`

Add operations:
- `effects.setCompressorParams`
- `effects.setMasterCompressorParams`

Add Convex mutations:
- `setCompressorParams`
- `setMasterCompressorParams`
- `serverSetCompressorParams`
- `serverSetMasterCompressorParams`

Update:
- validators
- operation parsers and registry
- API executor cases
- local effect kind mapping
- undo effect types and snapshots
- track delete/restore effect persistence
- reorder filtering to include `compressor`

## Phase 3: Compressor AudioWorklet DSP

Files:
- `packages/audio-engine/src/effects/compressor-worklet.ts`
- `packages/audio-engine/src/effects/compressor-chain-state.ts`
- `packages/audio-engine/src/effects/chain.ts`

Worklet requirements:
- peak/RMS detector
- compress/expand static curve
- soft knee
- attack/release envelope smoothing
- auto-release
- lookahead delay lines
- makeup/output/dry-wet
- internal sidechain detector shaping
- zero allocations in `process()`
- RMS ring buffer and lookahead buffers allocated in constructor
- no unused worklet meter messages in phase 1

Use chain shape:

```ts
export type CompressorNodeChain = {
  enabled: boolean
  internalsConnected: boolean
  workletNode: AudioWorkletNode
}
```

`connectFxChain` stage:

```ts
stagesByKind.set('compressor', {
  connectInput: (source) => source.connect(compressor.workletNode),
  outputs: [compressor.workletNode],
})
```

## Phase 4: Audio Engine Live And Offline Wiring

Files:
- `packages/audio-engine/src/live-mixer-runtime.ts`
- `packages/audio-engine/src/master-fx-runtime.ts`
- `packages/audio-engine/src/audio-engine.ts`
- `packages/audio-engine/src/mixer/types.ts`
- `packages/audio-engine/src/mixer/resolve-routing.ts`
- `packages/audio-engine/src/mixer/apply-offline-routing.ts`
- `packages/audio-engine/src/export-mixdown.ts`
- `src/lib/export/run-export-job.ts`

Add:
- `setTrackCompressor(trackId, params)`
- `setMasterCompressor(params)`
- compressor chain maps and pending param maps
- compressor support in routing rebuilds, dispose, clear, and pending apply
- offline worklet registration on `OfflineAudioContext`
- compressor params in resolved mixer graph and export FX collection

## Phase 5: Effects Panel State And Sync

Files:
- `src/components/timeline/create-effects-panel-audio-effects-state.ts`
- `src/hooks/useEffectsPanelAudioSync.ts`
- `src/components/timeline/EffectsPanel.tsx`

Add:
- `localCompressor`
- `compressorState`
- `addCompressor`
- `updateCompressor`
- compressor in `flushPending`
- compressor in `stateForKind`
- compressor in `localRowsForKind`
- compressor in persisted order detection
- compressor sync descriptor that calls audio engine track/master setters
- `Compressor` render case in `EffectsPanel.tsx`

## Phase 6: UI Component

File:
- `src/components/effects/Compressor.tsx`

Use:
- `EffectShell`
- `Knob`
- `DeviceToggleButton`
- `DeviceValueStrip`
- `DraggableDeviceGraph`

Initial UI:
- Ableton-inspired left column: Ratio, Attack, Release, Auto
- center transfer curve view first
- right column: Makeup, Peak/RMS, Compress/Expand, Dry/Wet
- bottom controls: Knee, Lookahead, Env Log/Linear
- local graph `viewMode` signal for transfer/gain-reduction/output

Meter helpers from `monorepo-new`:
- map `-60..+3 dB` to `0..100%`
- inverted gain-reduction meter using absolute negative dB

Use `DeviceToggleButton` for consistency. Borrow Dialkit `CLICK_THRESHOLD = 3` only if adding click-to-set threshold on the graph.

## Phase 7: Browser Catalog

File:
- `src/hooks/useTimelineBrowserController.ts`

Add built-in item:

```ts
{
  id: "builtin:audio-effect:compressor",
  source: "builtin",
  category: "audio-effect",
  label: "Compressor",
  subtitle: "Dynamics",
  searchText: "compressor dynamics sidechain peak rms expand",
}
```

Map payload:

```ts
{ kind: "audio-effect", effect: "compressor", label: "Compressor" }
```

Existing drag/drop should work through `AudioEffectKind`.

## Validation

Run:

```bash
git diff --check
bun run typecheck
bun test
bun run knip
bun run build
```

## Completion Checklist

- [x] Phase 1 shared params/contracts/tests
- [x] Phase 2 persistence/shared operations
- [x] Phase 3 AudioWorklet DSP and chain state
- [x] Phase 4 live/offline engine wiring
- [x] Phase 5 effects panel state/sync/render
- [x] Phase 6 compressor UI
- [x] Phase 7 browser catalog
- [x] Simplify pass
- [x] Validators pass
- [ ] Commit and push
