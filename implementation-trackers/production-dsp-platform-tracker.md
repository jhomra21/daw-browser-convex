# Production DSP Platform Tracker

## Relationship to Audio Settings

This work belongs in a separate tracker and future branch. The Audio Settings dashboard is a focused browser-device and runtime-preference feature. This roadmap changes project schemas, automation identity, recording architecture, mixer routing, processor contracts, export behavior, testing infrastructure, and production DSP capabilities across the repository.

The completed Audio Settings work remains the control and diagnostics surface for the global settings introduced here.

## Goal

Build a production-grade browser audio platform that supports serious music production and sound design while preserving the existing canonical mixer graph, live/offline architecture, project compatibility, and honest browser capability boundaries.

## Success Criteria

- Custom DSP has browser-backed numerical characterization at 44.1, 48, and 96 kHz.
- Live and offline graph behavior has defined parity tolerances.
- Duplicate effect instances automate independently and retain identity through reorder, persistence, and export.
- Mono and stereo layouts have explicit, tested conversion semantics.
- Recording supports bounded uncompressed PCM capture, monitoring, sample-domain punch boundaries, and calibration.
- Every processor reports derived latency and tail behavior.
- Parallel paths, sends, groups, and master convergence support plugin delay compensation.
- Routing supports pre-FX, pre-fader, post-fader, cue, and external sidechain edges.
- Production processors follow common lifecycle, timing, automation, bypass, and validation requirements.
- Loudness and true-peak analysis conform to EBU R128 and ITU-R BS.1770 tolerances.
- WAV export supports 16-bit PCM, 24-bit PCM, and 32-bit float through MediaBunny.
- Integer PCM export applies dither exactly once at final quantization.
- Export supports explicit tail, loudness, limiter, sample-rate-conversion, and stem policies.
- Recording and export have bounded memory behavior and explicit overflow/cancellation handling.
- Browser diagnostics distinguish requested, active, measured, calibrated, and inferred values.
- Existing projects and current output behavior migrate deterministically.

## Product and Architecture Decisions

### Preserve

- `AudioEngine` as the application-facing audio facade.
- `resolveMixerGraph` as the canonical pure routing source.
- Separate live and offline graph adapters consuming the same resolved graph.
- Stable effect instance IDs.
- Pure normalization and schema validation in shared packages.
- MediaBunny for supported encoding and container work.
- Existing compressed recording as a temporary compatibility fallback.
- Current post-fader send behavior as the migration default.
- Current 16-bit WAV and sample-peak normalization behavior as migration defaults.

### Do not expose

- Fake ASIO/Core Audio driver selection.
- Fake hardware buffer sizes.
- Exact hardware round-trip latency claims.
- Hardware direct-monitor controls.
- Native interface channel matrices unless browser APIs expose them reliably.
- Hardware xrun counts that the browser does not report.
- A claim that Web Audio capture is direct, unprocessed hardware PCM.

### Do not introduce prematurely

- A universal generic processor registry.
- Full WAM host compatibility.
- Tone.js as an engine replacement.
- Faust as the mandatory DSP architecture.
- SharedArrayBuffer as a hard requirement before a bounded fallback exists.
- A global oversampling setting.
- A single global quality enum for live, offline, and processor-local behavior.
- Deterministic WASM sample-rate conversion without measured benefit.
- Surround or ambisonic routing before mono/stereo is complete.

## Research and Implementation References

### Standards and browser APIs

- Web Audio API 1.1.
- MDN AudioWorklet, AudioParam, OfflineAudioContext, media constraints, and media track settings.
- Chrome AudioWorklet design pattern.
- SharedArrayBuffer and COOP/COEP cross-origin isolation guidance.
- WebCodecs AudioData and AudioEncoder.
- EBU R128 version 5.
- ITU-R BS.1770.
- EBU Tech 3341, 3342, and 3343.

### Open-source references and candidates

- MediaBunny: retain for encoding, PCM24, PCM float, streaming targets, and capability probing.
- `padenot/ringbuf.js`: evaluate for SAB recording transport.
- `libebur128`: primary native/WASM loudness reference candidate.
- `libsamplerate-js`, SoXR WASM, and r8brain: benchmark before selecting an offline SRC.
- Web Audio Modules API/SDK: parameter, state, event, and plugin-contract reference only.
- Faust WASM: selected processor and synthesis prototyping candidate.
- Tone.js: scheduling/context reference only.
- Essentia.js, Meyda, and aubio.js: analysis subsystem candidates.
- ChowDSP and Signalsmith ecosystems: algorithm and validation references.

### Local references

- `/Users/juan/Documents/monorepo-new`
- `/Users/juan/Documents/opencode`
- `/Users/juan/Documents/solid-primitives`
- `/Users/juan/Documents/dialkit`
- `/Users/juan/Documents/daw-effect-research`

## Wave A: Compatibility and DSP Foundations

### A1. Capability and project-version policy

- [ ] Define Chrome stable as the production browser target.
- [ ] Define smoke-test expectations and feature degradation for other browsers.
- [ ] Add active capability tests for AudioWorklet.
- [ ] Add an active capability test for AudioWorklet in OfflineAudioContext.
- [ ] Add transferable-buffer capability reporting.
- [ ] Add SharedArrayBuffer and `crossOriginIsolated` reporting.
- [ ] Add output-selection and sink-routing capability reporting.
- [ ] Add active media-track-settings reporting.
- [ ] Audit authentication, R2 assets, Workers, OAuth, and third-party resources before enabling COOP/COEP.
- [ ] Define the selected COOP/COEP policy or explicitly defer isolation.
- [ ] Add a project format version and canonical migration entry point.
- [ ] Add migration fixtures for every existing project version.
- [ ] Define requested, active, measured, calibrated, and inferred terminology.
- [ ] Define numerical tolerances separately for browser nodes and owned DSP.

```ts
export type AudioPlatformCapabilities = {
  audioWorklet: boolean
  offlineAudioWorklet: boolean
  transferableBuffers: boolean
  sharedArrayBuffer: boolean
  crossOriginIsolated: boolean
  outputSelection: boolean
  sinkRouting: boolean
  mediaTrackSettings: boolean
}
```

#### Acceptance

- [ ] Existing projects load without audible changes.
- [ ] Capability reporting uses active tests where practical.
- [ ] Unsupported hardware controls remain absent.
- [ ] Migrations are versioned and idempotent.

### A2. Numerical characterization harness

- [ ] Add deterministic silence, impulse, step, DC, sine, sweep, and seeded-noise fixtures.
- [ ] Add stereo isolation and opposite-polarity fixtures.
- [ ] Add clipped, subnormal, NaN, and Infinity fixtures.
- [ ] Add peak, RMS, DC, and finite-sample metrics.
- [ ] Add frame-offset and cross-correlation metrics.
- [ ] Add frequency-response and phase-response metrics.
- [ ] Add THD+N and aliasing-energy metrics.
- [ ] Add channel-leakage and crosstalk metrics.
- [ ] Add declared-versus-measured latency metrics.
- [ ] Add browser-backed Web Audio integration execution.
- [ ] Characterize EQ at 44.1, 48, and 96 kHz.
- [ ] Characterize compressor at all supported rates and layouts.
- [ ] Characterize saturator aliasing and gain behavior.
- [ ] Characterize delay timing and feedback behavior.
- [ ] Characterize reverb impulse and tail behavior.
- [ ] Characterize complete track, group, send, and master paths.
- [ ] Add live/offline topology and numerical parity reports.

```ts
export type AudioComparison = {
  frameOffset: number
  peakError: number
  rmsError: number
  dcOffset: readonly number[]
  channelLeakageDb: number
  containsNonFiniteSamples: boolean
}
```

#### Acceptance

- [ ] Failures identify processor, sample rate, channel layout, and metric.
- [ ] Owned kernels use strict deterministic tolerances.
- [ ] Browser nodes use invariant and bounded-tolerance tests.
- [ ] Existing behavior is characterized before structural DSP changes.

### A3. Static worklet modules and fault handling

- [ ] Replace inline compressor Blob source with a versioned worklet module.
- [ ] Replace inline meter Blob source with a versioned worklet module.
- [ ] Add a package-local once-per-context worklet loader.
- [ ] Validate worklet messages from `unknown`.
- [ ] Add processor registration failure status.
- [ ] Add `processorerror` handling.
- [ ] Define click-free recoverable bypass behavior.
- [ ] Bound processor diagnostics and prevent message storms.
- [ ] Define parameter smoothing per automatable parameter.
- [ ] Verify no owned processor allocates per sample or render quantum.
- [ ] Add malformed-message and processor-fault tests.

```ts
export type ProcessorFault = {
  code: string
  recoverable: boolean
}

export type ProcessorTelemetry = {
  processedFrames: number
  overruns: number
}
```

#### Acceptance

- [ ] No runtime-generated worklet source remains.
- [ ] Registration is once per context.
- [ ] Processor failures cannot indefinitely mute the full graph.
- [ ] Worklet teardown is deterministic.

## Wave B: Automation Identity and Channel Semantics

### B1. Effect-instance automation identity

- [ ] Extend track automation targets with optional `effectInstanceId`.
- [ ] Extend master automation targets with optional `effectInstanceId`.
- [ ] Keep `parameterId` processor-local.
- [ ] Version target-key generation.
- [ ] Update local automation persistence.
- [ ] Update Convex automation schemas and operations.
- [ ] Update project snapshots and archive import/export.
- [ ] Update manual override keys.
- [ ] Update automation UI option construction.
- [ ] Update live binding lookup to be instance-keyed.
- [ ] Update offline binding lookup to be instance-keyed.
- [ ] Preserve unresolved legacy envelopes without arbitrary retargeting.
- [ ] Bind a legacy effect envelope only when one compatible instance exists.
- [ ] Add migration tests for duplicate, deleted, reordered, missing, local, and cloud instances.
- [ ] Convert suitable compressor scalar parameters to AudioParams.
- [ ] Retain structured compressor configuration as validated messages.
- [ ] Keep hold and linear curves during the identity migration.

```ts
export type AutomationTarget =
  | { kind: "track"; trackId: string; effectInstanceId?: string }
  | { kind: "master"; effectInstanceId?: string }
```

#### Acceptance

- [ ] Two same-kind effects automate independently.
- [ ] Reordering does not retarget automation.
- [ ] Deletion leaves a recoverable unresolved envelope.
- [ ] Live and offline automation target the same instance.
- [ ] Compressor automation does not depend on MessagePort timing.

### B2. Mono and stereo channel semantics

- [ ] Add `ChannelLayout = "mono" | "stereo"`.
- [ ] Define source-layout persistence where user intent matters.
- [ ] Define mono-to-stereo gain behavior.
- [ ] Define stereo-to-mono downmix behavior.
- [ ] Configure custom worklet channel behavior explicitly.
- [ ] Audit native-node `channelCount`, `channelCountMode`, and `channelInterpretation`.
- [ ] Require every processor to declare supported layouts.
- [ ] Handle zero, one, two, and unexpected extra worklet channels safely.
- [ ] Add mono/stereo live and offline parity tests.
- [ ] Preserve current stereo behavior for migrated tracks and effects.

#### Acceptance

- [ ] Mono remains centered.
- [ ] Stereo channel isolation is preserved.
- [ ] Polarity and width operations follow documented gain rules.
- [ ] Unsupported extra channels are never silently interpreted.

## Wave C: Production Recording

### C1. Bounded uncompressed PCM capture

- [ ] Connect capture to the engine's active AudioContext.
- [ ] Remove the separate recording-preview AudioContext.
- [ ] Add a `MediaStreamAudioSourceNode` recording input.
- [ ] Add explicit input channel selection and mapping.
- [ ] Add software input gain and polarity.
- [ ] Add a recorder AudioWorklet tap.
- [ ] Add a meter tap.
- [ ] Implement a fixed transferable `Float32Array` pool.
- [ ] Implement a bounded Worker-side queue.
- [ ] Return transferred buffers to the pool.
- [ ] Define chunk frame count and maximum queued duration.
- [ ] Count and expose capture overruns.
- [ ] Fail visibly instead of silently corrupting audio on unrecoverable overflow.
- [ ] Flush the final partial recording block.
- [ ] Store active `MediaStreamTrack.getSettings()` values.
- [ ] Encode captured PCM to lossless WAV or FLAC through MediaBunny.
- [ ] Retain MediaRecorder as a labeled compressed fallback for one release.
- [ ] Add long-duration bounded-memory tests.

```ts
export type RecordingInputConfiguration = {
  deviceId: string
  layout: ChannelLayout
  inputChannel: number
  monitor: "off" | "auto" | "on"
  gainDb: number
  invertPolarity: boolean
}
```

```ts
export type RecordingSessionStatus =
  | { state: "capturing"; capturedFrames: number; overruns: number }
  | { state: "stopping" }
  | { state: "completed"; capturedFrames: number }
  | { state: "failed"; reason: string; recoverable: boolean }
```

#### Acceptance

- [ ] Thirty-minute capture remains within a fixed memory bound.
- [ ] Worker stalls produce explicit overrun status.
- [ ] Device loss terminates safely.
- [ ] Mono and stereo channels are correct.
- [ ] Capture reports requested and active settings separately.

### C2. SharedArrayBuffer recording transport

- [ ] Implement only after the transferable transport contract is stable.
- [ ] Add a wait-free single-producer/single-consumer ring buffer.
- [ ] Evaluate `padenot/ringbuf.js` against an internal implementation.
- [ ] Gate SAB transport behind `crossOriginIsolated`.
- [ ] Preserve the same session, overflow, and recovery API as the fallback.
- [ ] Add isolated and non-isolated deployment tests.

#### Stop condition

- [ ] Stop rollout if COOP/COEP breaks authentication, required assets, Workers, OAuth, or third-party resources.

### C3. Input monitoring

- [ ] Add monitoring off, auto, and on modes.
- [ ] Route monitoring through the armed track's existing mixer input.
- [ ] Define whether monitoring is pre-FX or through track FX.
- [ ] Add click-free monitor connect/disconnect fades.
- [ ] Add feedback warnings.
- [ ] Distinguish software monitoring from interface direct monitoring.
- [ ] Tear monitoring down on stop, cancel, device loss, project switch, context rebuild, and error.
- [ ] Keep monitor/cue paths out of export by default.

### C4. Sample-domain punch boundaries

- [ ] Represent record start, punch-in, and punch-out as context frames.
- [ ] Apply punch boundaries in the recorder worklet using `currentFrame`.
- [ ] Capture one transport epoch for timeline-to-context conversion.
- [ ] Stop using delayed UI callback time as the recording boundary.
- [ ] Add render-quantum boundary tests.

### C5. Recording calibration

- [ ] Add manual recording offset.
- [ ] Add loopback calibration using a known broadband sequence.
- [ ] Cross-correlate captured return with the source.
- [ ] Compute measurement confidence.
- [ ] Reject weak or ambiguous measurements.
- [ ] Persist calibration by input, output, sample rate, and applicable platform identity.
- [ ] Mark unstable device identifiers as non-reusable.
- [ ] Never mix browser latency estimates with calibrated offset.

```ts
export type RecordingCalibration = {
  inputDeviceId: string
  outputDeviceId: string
  sampleRate: number
  measuredRoundTripFrames: number
  recordingOffsetFrames: number
  confidence: number
}
```

#### Acceptance

- [ ] Repeated valid calibration measurements stay within tolerance.
- [ ] Mismatched configurations never reuse stale calibration.
- [ ] Old projects and preferences default to zero recording offset.

## Wave D: Timing, Delay Compensation, and Routing

### D1. Processor timing contracts

- [ ] Add derived latency and tail functions beside each effect implementation.
- [ ] Keep timing out of persisted effect state.
- [ ] Include normalized state, sample rate, BPM, layout, and processor quality where relevant.
- [ ] Define finite and unbounded tail categories.
- [ ] Define fixed-latency behavior for bypassed processors.
- [ ] Add measured-versus-declared timing tests.

```ts
export type EffectTiming = {
  latencyFrames: number
  tail:
    | { kind: "finite"; frames: number }
    | { kind: "unbounded" }
}
```

### D2. Latency-changing parameter policy

- [ ] Reserve fixed maximum latency for bounded lookahead processors where practical.
- [ ] Prevent ordinary automation from changing external processor latency.
- [ ] Rebuild and crossfade topology for oversampling changes.
- [ ] Rebuild and crossfade topology for linear-phase changes.
- [ ] Rebuild and crossfade topology for convolution topology changes.
- [ ] Dispose replaced graphs deterministically.

### D3. Plugin delay compensation

- [ ] Add a separate pure timing pass over `ResolvedMixerGraph`.
- [ ] Reject routing cycles before timing resolution.
- [ ] Calculate longest-path latency with indexed maps.
- [ ] Resolve compensation for track and group convergence.
- [ ] Resolve compensation for sends.
- [ ] Resolve compensation for dry/wet branches.
- [ ] Resolve compensation for master convergence.
- [ ] Resolve detector alignment where sidechain timing requires it.
- [ ] Consume identical compensation values in live and offline adapters.
- [ ] Keep creative delay out of PDC latency.

```ts
export type ResolvedPathTiming = {
  intrinsicFrames: number
  compensationFrames: number
}
```

#### Acceptance

- [ ] Parallel impulses align within one sample offline.
- [ ] Live alignment meets the documented tolerance.
- [ ] Bypass does not shift timing.
- [ ] Invalid cyclic graphs fail deterministically.

### D4. Explicit send tap points

- [ ] Extend sends with optional pre-FX, pre-fader, and post-fader taps.
- [ ] Default missing taps to current post-fader behavior.
- [ ] Add named input, post-FX, post-fader, and output/PDC nodes.
- [ ] Include tap topology in routing signatures.
- [ ] Define mute and solo behavior for each tap.
- [ ] Add live/offline tap tests.

```ts
export type SendTap = "pre-fx" | "pre-fader" | "post-fader"

export type TrackSend = {
  targetId: TrackId
  amount: number
  tap?: SendTap
}
```

### D5. Cue and sidechain routing

- [ ] Add a cue/monitor bus isolated from master export.
- [ ] Add external sidechain edges.
- [ ] Keep sidechain edges non-audible.
- [ ] Validate target processor compatibility.
- [ ] Prevent sidechain leakage into audible output.
- [ ] Define group and return stem behavior.

## Wave E: Production Processor Standards and Effects

### E1. Processor release contract

Every owned processor must define and test:

- [ ] Normalized state.
- [ ] Stable parameter IDs.
- [ ] Automation rate.
- [ ] Parameter smoothing.
- [ ] Supported channel layouts.
- [ ] Latency.
- [ ] Tail.
- [ ] Reset and flush behavior.
- [ ] Click-free bypass.
- [ ] Fault behavior.
- [ ] Live construction.
- [ ] Offline construction.
- [ ] Numerical characterization.
- [ ] Sample-rate behavior.
- [ ] Non-finite input/output policy.

### E2. Quality policy

- [ ] Add a global live CPU ceiling.
- [ ] Add an offline render-quality default.
- [ ] Keep sound-changing processor quality in processor state.
- [ ] Apply oversampling only where the processor creates new bandwidth or aliasing.
- [ ] Require topology swaps for latency-changing quality changes.

### E3. Utility processor

- [ ] Gain.
- [ ] Polarity.
- [ ] Mono conversion.
- [ ] Pan and balance.
- [ ] Stereo width.
- [ ] Mid/side encode and decode.
- [ ] Channel swap.
- [ ] DC blocker.

### E4. Gate and expander

- [ ] Attack, hold, release, hysteresis, and range.
- [ ] Sidechain filter.
- [ ] External sidechain.
- [ ] Optional fixed-latency lookahead.
- [ ] Gain-reduction metering.

### E5. True-peak limiter

- [ ] Standards-based oversampled peak detection.
- [ ] Fixed maximum lookahead.
- [ ] Ceiling and release controls.
- [ ] Channel linking.
- [ ] Declared latency.
- [ ] Gain-reduction metering.
- [ ] Offline verification pass.

### E6. Flexible filter and autofilter

- [ ] Low-pass, high-pass, band-pass, notch, and state-variable modes.
- [ ] Drive and resonance bounds.
- [ ] Envelope follower.
- [ ] LFO modulation.
- [ ] Sample-rate and stability characterization.

### E7. Modulation processors

- [ ] Chorus.
- [ ] Flanger.
- [ ] Phaser.
- [ ] Tremolo.
- [ ] Auto-pan.
- [ ] Ensemble.

### E8. Lo-fi processors

- [ ] Bit-depth reduction.
- [ ] Sample-rate reduction.
- [ ] Jitter.
- [ ] Noise.
- [ ] Quantization modes.

### E9. IR, cabinet, and convolution tools

- [ ] User IR loading.
- [ ] IR trimming.
- [ ] Predelay.
- [ ] Mono/stereo IR handling.
- [ ] Cabinet mode.
- [ ] Evaluate partitioned convolution if native convolution is insufficient.

### E10. Multiband dynamics

- [ ] Implement only after crossover, PDC, sidechain, and dynamics contracts are proven.
- [ ] Add crossover magnitude and phase reconstruction tests.
- [ ] Add band recombination and latency tests.

### E11. Nonlinear oversampling

- [ ] Add 2x, 4x, and 8x options only for appropriate nonlinear processors.
- [ ] Add anti-alias filter characterization.
- [ ] Add latency reporting.
- [ ] Add live CPU and offline quality policies.

## Wave F: Metering, Loudness, and Export Fidelity

### F1. Real-time metering

- [ ] Sample peak.
- [ ] RMS.
- [ ] Clipping.
- [ ] DC estimate.
- [ ] Correlation.
- [ ] Optional bounded true-peak preview.
- [ ] Reduced-rate worklet-to-main-thread frames.
- [ ] Meter reset, pause, seek, and silence semantics.

### F2. Standards loudness analysis

- [ ] Select an audited BS.1770/EBU R128 implementation or WASM kernel.
- [ ] Evaluate `libebur128` as the primary candidate.
- [ ] Add EBU reference-sequence fixtures.
- [ ] Add native reference comparison in tests.
- [ ] Implement momentary LUFS.
- [ ] Implement short-term LUFS.
- [ ] Implement integrated LUFS.
- [ ] Implement loudness range.
- [ ] Implement standards-grade true peak.

#### Acceptance

- [ ] Loudness and true peak match the selected reference within declared tolerances.
- [ ] Disabled meters have negligible worklet overhead.

### F3. Staged export pipeline

- [ ] Snapshot project and audio state.
- [ ] Determine source range.
- [ ] Determine preroll and finite tail.
- [ ] Render.
- [ ] Analyze.
- [ ] Apply normalization gain.
- [ ] Optionally limit.
- [ ] Verify achieved values.
- [ ] Quantize and dither.
- [ ] Encode and save.
- [ ] Preserve cancellation through every stage.

### F4. WAV depth and dither

- [ ] Add MediaBunny `pcm-s16`.
- [ ] Add MediaBunny `pcm-s24`.
- [ ] Add MediaBunny `pcm-f32`.
- [ ] Add TPDF dither for integer PCM.
- [ ] Never dither float.
- [ ] Never dither before lossy encoding.
- [ ] Verify actual encoded bit depth.
- [ ] Verify FLAC depth support before exposing FLAC bit-depth controls.

```ts
export type WavEncodingSettings =
  | { codec: "pcm-s16"; dither: "none" | "tpdf" }
  | { codec: "pcm-s24"; dither: "none" | "tpdf" }
  | { codec: "pcm-f32"; dither: "none" }
```

### F5. Normalization and limiting

- [ ] Preserve sample-peak normalization as a separate legacy mode.
- [ ] Add target LUFS.
- [ ] Add true-peak ceiling.
- [ ] Add optional true-peak limiting.
- [ ] Reanalyze after gain and limiting.
- [ ] Report achieved LUFS and true peak.

```ts
export type ExportNormalization =
  | { mode: "none" }
  | { mode: "sample-peak"; targetDbfs: number }
  | {
      mode: "loudness"
      targetLufs: number
      truePeakCeilingDbtp: number
      limiting: "off" | "true-peak"
    }
```

### F6. Render tails

- [ ] Add no-tail mode.
- [ ] Add fixed-duration mode.
- [ ] Add automatic silence-detection mode.
- [ ] Require a silence hold duration.
- [ ] Require an absolute maximum tail.
- [ ] Prevent unbounded OfflineAudioContext allocation.
- [ ] Add delay and reverb tail fixtures.

```ts
export type ExportTailPolicy =
  | { mode: "none" }
  | { mode: "fixed"; durationSec: number }
  | {
      mode: "automatic"
      silenceThresholdDb: number
      silenceHoldSec: number
      maximumSec: number
    }
```

### F7. Stem semantics

- [ ] Dry source stems.
- [ ] Post-track-FX stems.
- [ ] Reachable group/return stems.
- [ ] Group output stems.
- [ ] Return output stems.
- [ ] Full master-contribution stems.
- [ ] Document whether each mode recombines to the master.

### F8. Sample-rate-conversion evaluation

- [ ] Build native OfflineAudioContext SRC fixtures.
- [ ] Benchmark libsamplerate.
- [ ] Benchmark SoXR.
- [ ] Evaluate r8brain if browser integration is practical.
- [ ] Measure passband ripple and stopband rejection.
- [ ] Measure aliasing and phase.
- [ ] Measure streaming memory and speed.
- [ ] Review licenses and maintenance.
- [ ] Adopt a deterministic SRC only if it has measurable product benefit.

#### Stop condition

- [ ] Do not ship a selectable SRC quality mode without validated behavioral differences.

## Wave G: Reliability, Performance, and Diagnostics

### G1. Runtime diagnostics

- [ ] Requested AudioContext settings.
- [ ] Active AudioContext settings.
- [ ] Requested capture settings.
- [ ] Active media-track settings.
- [ ] Browser latency estimates.
- [ ] Calibrated recording offset.
- [ ] Graph/PDC latency.
- [ ] Recorder overrun count.
- [ ] Worklet fault count.
- [ ] Explicitly named inferred application stalls.

### G2. Performance policy

- [ ] Define processor CPU budgets.
- [ ] Define live track/effect-count fixtures.
- [ ] Test at 44.1, 48, and 96 kHz.
- [ ] Bound every cache and ring buffer.
- [ ] Prevent audio-thread logging and message storms.
- [ ] Prevent allocations in owned `process()` loops.
- [ ] Add long-export memory budgets.
- [ ] Add long-recording memory budgets.

### G3. Stress and lifecycle tests

- [ ] Context suspend and resume.
- [ ] Device unplug.
- [ ] Permission revocation.
- [ ] Context rebuild.
- [ ] Sample-rate change.
- [ ] Rapid effect bypass and reorder.
- [ ] Latency-changing topology replacement.
- [ ] Project switch during recording.
- [ ] Worker termination.
- [ ] SAB and non-SAB capture.
- [ ] Background and visibility transitions.
- [ ] Export cancellation during render, analysis, encoding, and saving.
- [ ] Worklet registration and processor construction failure.

### G4. Resource-leak verification

- [ ] No leaked media streams.
- [ ] No leaked AudioContexts.
- [ ] No leaked AudioWorkletNodes.
- [ ] No leaked Workers.
- [ ] No leaked object URLs.
- [ ] No leaked event listeners.
- [ ] No stale monitoring paths.
- [ ] No stale ring buffers.
- [ ] No polling loops.

## Wave H: Advanced Sound Design

These items begin only after the platform contracts and validation gates above are stable.

### H1. Production sampler

- [ ] Multisample zones.
- [ ] Velocity layers.
- [ ] Round robin.
- [ ] Root-note mapping.
- [ ] Loop and crossfade-loop modes.
- [ ] Envelopes and filters.
- [ ] Modulation.
- [ ] Choke groups.
- [ ] Cache and streaming policy.

### H2. Granular processor/instrument

- [ ] Grain size and density.
- [ ] Position and spray.
- [ ] Pitch and reverse probability.
- [ ] Window shapes.
- [ ] Stereo spread.
- [ ] Freeze.
- [ ] Sample-accurate modulation.
- [ ] Worklet/WASM performance characterization.

### H3. Spectral platform

- [ ] Reusable FFT/window/overlap-add infrastructure.
- [ ] Spectral latency reporting.
- [ ] Spectral freeze.
- [ ] Spectral gate.
- [ ] Morphing.
- [ ] Bin shifting and blur.
- [ ] Harmonic/percussive tools.
- [ ] Noise profiling.

### H4. Advanced synthesis

- [ ] Wavetable synthesis.
- [ ] FM and phase modulation.
- [ ] Physical modeling.
- [ ] Modal synthesis.
- [ ] Resonators.
- [ ] Audio-rate modulation matrix.
- [ ] Evaluate Faust WASM for selected processors.
- [ ] Defer MPE until instrument and event contracts are stable.

### H5. Advanced pitch and time

- [ ] Formant-aware pitch shifting.
- [ ] Phase-vocoder modes.
- [ ] Transient preservation.
- [ ] Monophonic pitch correction.
- [ ] Polyphonic offline quality modes.
- [ ] Quality and latency reporting.

## Delivery Milestones

### Milestone 1: Foundation

- [ ] Complete Wave A.
- [ ] Complete browser-backed numerical characterization.
- [ ] Complete worklet module migration and fault handling.

### Milestone 2: Identity and channels

- [ ] Complete Wave B.
- [ ] Ship versioned automation migration.
- [ ] Prove mono/stereo live/offline parity.

### Milestone 3: Recording

- [ ] Complete Wave C transferable-buffer recording.
- [ ] Ship monitoring and active capture diagnostics.
- [ ] Ship calibration and sample-domain punch.
- [ ] Keep compressed fallback available.

### Milestone 4: Timing and routing

- [ ] Complete Wave D.
- [ ] Ship PDC and send tap selection.
- [ ] Ship cue and external sidechain routing.

### Milestone 5: Essential production DSP

- [ ] Complete processor release standards.
- [ ] Ship utility, gate/expander, limiter, filter, modulation, and lo-fi processors.
- [ ] Ship IR/cabinet tools.

### Milestone 6: Metering and export

- [ ] Complete Wave F.
- [ ] Ship loudness and true-peak analysis.
- [ ] Ship PCM16/24/float, dither, tails, loudness normalization, and documented stems.

### Milestone 7: Hardening

- [ ] Complete Wave G.
- [ ] Publish performance, overrun, numerical parity, and resource-leak reports.

### Milestone 8: Advanced sound design

- [ ] Begin Wave H only after prior release gates remain stable.

## Mandatory Validation Gates

For every implementation phase:

- [ ] Run focused unit and numerical tests during iteration.
- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run knip`.
- [ ] Run `git diff --check`.
- [ ] Run `bun run build` at milestone completion.
- [ ] Run browser-backed Web Audio integration tests.
- [ ] Test 44.1, 48, and 96 kHz.
- [ ] Test mono and stereo.
- [ ] Test project migrations.
- [ ] Review the complete diff for duplicate logic, dead code, casts, lifecycle leaks, and contract drift.

## Stop Conditions

- [ ] Stop COOP/COEP rollout if required authenticated or cross-origin resources break.
- [ ] Stop SAB work until overflow and recovery semantics work without SAB.
- [ ] Stop automation migration if ambiguous envelopes cannot be preserved.
- [ ] Stop PDC if cycles are not rejected or latency can change without a rebuild policy.
- [ ] Stop any processor release if live/offline state, timing, and parameter identity diverge.
- [ ] Stop loudness release if reference fixtures miss tolerance.
- [ ] Stop SRC adoption without acceptable licensing, browser memory, determinism, and measurable quality benefit.
- [ ] Stop export-tail work if unbounded effects can allocate unbounded renders.
- [ ] Stop recording release if consumer stalls can silently corrupt captures.

## Expected Proof Artifacts

- [ ] Browser capability matrix.
- [ ] Project migration fixture report.
- [ ] Numerical parity report by browser, processor, sample rate, layout, and metric.
- [ ] Processor timing and PDC impulse-alignment report.
- [ ] Recording memory and overrun report.
- [ ] SAB and transferable transport comparison.
- [ ] Calibration repeatability report.
- [ ] EBU/reference loudness conformance report.
- [ ] Export codec and bit-depth inspection report.
- [ ] SRC benchmark report before dependency adoption.
- [ ] Stress-test resource-leak report.
