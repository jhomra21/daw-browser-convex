# Area 7: Audio Engine & Shared Packages

## Summary

The package has meaningful safeguards already: shared automation evaluation is binary-searched, clip scheduling indexes and sorts entries, waveform peaks have bounded memory/disk caches, effect graph reconnection has a fade transition, and live/offline routing share the same graph resolver. The clearest user-facing risk is abrupt gain changes; the clearest scale risks are repeated automation-envelope scans and synchronous full-buffer export analysis. The main organization issue found is duplicated generic math and a waveform-to-engine package dependency. No unused in-scope implementation file was confirmed.

## Findings

### AE-01 — Abrupt mixer gain changes are applied without ramps

- **Category:** A
- **Evidence:** `packages/audio-engine/src/audio-engine.ts:810-815`
  > `if (!this.masterGain) return`
  > `this.masterGain.gain.value = nextVolume`
  Also, `packages/audio-engine/src/mixer/apply-live-routing.ts:61-63` assigns track gain values directly.
- **What the user experiences:** Moving master or track volume while audio is sounding can produce a discontinuity, heard as a click or abrupt level jump. Not every assignment causes an audible artifact, but these live gain writes are not smoothed.
- **Minimal fix sketch:** Route live master/track gain updates through a small shared AudioParam ramp helper that cancels stale automation, anchors at the current value, and ramps over a short bounded interval. Keep offline rendering’s static value assignment unchanged.
- **Size:** S
- **Risk:** Low
- **How to verify:** In an E2E audio smoke, play a steady tone and move master and track faders repeatedly; capture loopback audio and check for discontinuities while confirming the final gain reaches the requested value.

### AE-02 — MIDI expression events repeatedly scan all automation envelopes

- **Category:** B
- **Evidence:** `packages/audio-engine/src/audio-engine.ts:955-965,975-981`
  > `for (const event of events) {`
  > `const hasAutomationEnvelope = this.automationEnvelopes.some((candidate) => (`
  `packages/audio-engine/src/export-mixdown.ts:1195-1201` repeats the envelope `.find(...)` inside its event loop.
- **What the user experiences:** Projects with many MIDI expression events and automation envelopes incur work proportional to events × envelopes during live scheduling and export. This can make dense playback updates/export slower even though ordinary automation-point lookup itself is binary-searched.
- **Minimal fix sketch:** Build one lookup keyed by track, effect instance, and parameter before walking expression events, then use it for the live and offline restore lookups. Keep the shared `valueAtAutomationTime` evaluator as the value source.
- **Size:** M
- **Risk:** Low
- **How to verify:** Use a deterministic performance fixture with increasing event/envelope counts; confirm lookup work scales approximately linearly with the combined input sizes and compare playback scheduling duration before/after.

### AE-03 — True-peak validation scans the rendered buffer synchronously

- **Category:** B
- **Evidence:** `packages/audio-engine/src/export-mixdown.ts:180-195`
  > `const measured = scanTruePeak(buffer, signal)`
  `packages/audio-engine/src/true-peak-scanner.ts:19-29` iterates every channel and frame and evaluates the oversampling kernel inline.
- **What the user experiences:** A long export with an enabled reachable limiter performs a full-duration CPU scan on the calling thread after rendering; the export UI may feel unresponsive during that validation pass.
- **Minimal fix sketch:** Run the existing scan kernel in a worker or in bounded chunks with progress/yielding. Preserve abort checks and the current ceiling/tolerance decision.
- **Size:** M
- **Risk:** Med
- **How to verify:** Export a long fixture with and without a limiter while recording renderer responsiveness and elapsed scan time; verify identical measured peak and abort behavior.

### AE-04 — Sampler scheduling allocates fade curves per voice segment

- **Category:** B
- **Evidence:** `packages/audio-engine/src/sampler-runtime.ts:121-127`
  > `const fadeInCurve = Float32Array.from({ length: 32 }, ...)`
  > `const fadeOutCurve = Float32Array.from({ length: 32 }, ...)`
- **What the user experiences:** Dense sampler playback repeatedly allocates two 32-sample typed arrays for each segment needing a fade, adding avoidable garbage-collection pressure during note scheduling.
- **Minimal fix sketch:** Keep immutable fade-in/fade-out curves at module scope (or cache them once) and reuse them with `setValueCurveAtTime`.
- **Size:** S
- **Risk:** Low
- **How to verify:** Schedule many sampler notes with segment fades in the existing audio performance harness; compare allocation count/heap churn and verify the rendered fade envelope is unchanged.

### AE-05 — Shared clamp and time/beat math is duplicated

- **Category:** C
- **Evidence:** The same clamp expression appears in `packages/shared/src/synth-params.ts:112`, `packages/shared/src/granular-params.ts:28`, `packages/shared/src/effects-params.ts:44-46`, `packages/shared/src/drum-rack-params.ts:49-51`, `packages/timeline-core/src/clip-fades.ts:19-21`, and `src/lib/midi-editor-grid.ts:32` / `src/lib/timeline-midi-bounds.ts:13`. Beat conversion also repeats in `src/lib/timeline-range-selection.ts:52-58` and `src/lib/midi/recording-session.ts:24`.
- **What the user experiences:** No direct audio defect identified; maintenance cost is duplicated edge-case behavior and future changes needing repeated edits.
- **Minimal fix sketch:** Extract only helpers with a common contract and multiple real consumers, likely a shared numeric clamp and a shared seconds/beats conversion pair. Preserve any intentionally different invalid-input policies at the call sites.
- **Size:** S
- **Risk:** Low
- **How to verify:** Search for remaining identical formulas across `packages/` and `src/lib/`; run existing boundary tests for parameter normalization, timeline range selection, and MIDI recording.

### AE-06 — Waveforms package imports an audio-engine implementation path

- **Category:** C
- **Evidence:** `packages/waveforms/src/asset-store.ts:1-5`
  > `import {`
  > `  createAudioPcmSourceDescriptor,`
  > `} from '@daw-browser/audio-engine/media-pages'`
  The same package-internal import is used as a type dependency in `packages/waveforms/src/types.ts:1` and `src/extract-peaks.ts:1`.
- **What the user experiences:** No immediate user-visible issue; the package boundary is inverted, so waveform consumers pull an engine package and engine media-page API changes can force waveform changes.
- **Minimal fix sketch:** Move the PCM source/page descriptor contract and its pure descriptor constructor to a lower-level shared media contract package, then make both packages depend on that contract. This specific dependency was not recorded among the package-boundary tracker’s listed follow-ups, which focus on package-local checks and `AudioEngine` decomposition.
- **Size:** M
- **Risk:** Med
- **How to verify:** Inspect package dependency/import direction and run package-local type checks; confirm waveform tests and its application consumers resolve the contract without importing `audio-engine`.

### AE-07 — Decode sample-rate constant is exported but only used locally

- **Category:** D
- **Evidence:** `packages/audio-engine/src/audio-runtime.ts:14`
  > `export const CANONICAL_DECODE_SAMPLE_RATE = 44_100`
  Repository-wide symbol search found its only use at `packages/audio-engine/src/audio-runtime.ts:37`; Knip also reports this export as unused.
- **What the user experiences:** No direct effect; this exposes a symbol that has no external consumer and enlarges the package’s apparent API.
- **Minimal fix sketch:** Remove the `export` modifier while retaining the local constant.
- **Size:** S
- **Risk:** Low
- **How to verify:** Repository-wide search confirms no external imports; rerun Knip for this symbol and the package’s type check.

## Looked at and fine

- **Graph resolution is shared:** `resolveLiveMixerGraph` and `resolveExportMixerGraph` both ultimately call `resolveMixerGraph`; offline graph construction does not have a parallel routing resolver. The tracker’s AudioEngine decomposition and package-check follow-ups are marked complete.
- **Small effect-parameter edits are incremental:** `packages/audio-engine/src/live-mixer-runtime.ts:551-558` preserves EQ nodes when topology is unchanged and queues parameter updates; effect routing reconnection is separately guarded by `createGainTransitionOwner` in `packages/audio-engine/src/effects/chain.ts:103-120`.
- **Clip scheduling avoids a naive all-clips scan for normal playhead starts:** `packages/audio-engine/src/clip-scheduler.ts:58-67,82-100,179-188` caches a sorted-by-end index and uses binary search. The targeted reschedule path scans track clips to match selected clip IDs, rather than doing a nested all-clips/all-IDs search.
- **Automation point evaluation is not linear per query:** `packages/shared/src/automation-parameters.ts:481-518` uses binary search and documents the allocation-free evaluator.
- **Waveform peaks have bounded caches and request coalescing:** `packages/waveforms/src/asset-store.ts:22-40,128-139,248-264,277-299` caps record/chunk caches, shares pending generation/load work, and supports cancellation.
- **Live/offline gain and routing are intentionally distinct execution adapters:** `packages/audio-engine/src/mixer/apply-live-routing.ts` maintains/reuses live edges, while `packages/audio-engine/src/mixer/apply-offline-routing.ts:182-244` constructs an isolated offline graph. Both consume the shared routing plan and graph resolution.
- **No unused in-scope implementation file was confirmed.** Knip exited nonzero and reported 376 unused files and 23 duplicate exports across the repository, including generated acceptance evidence; its output did not establish an unused in-scope source file. The one in-scope unused export above was checked against whole-repo references.
- **No AudioWorklet per-block allocation finding confirmed:** inspected worklet processors are represented through `worklet-assets.ts`/portable host sources and the repository’s worklet checks; the available evidence did not establish a concrete avoidable per-block object-allocation defect.
