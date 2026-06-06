# Package Boundaries and Audio Engine Follow-up Tracker

> Created: 2026-06-05
> Updated after validation: 2026-06-05
> Scope: execution-safe follow-up plan for PR #10 findings:
>
> 1. Make workspace package seams independently checkable.
> 2. Decompose `packages/audio-engine/src/audio-engine.ts` without changing its public interface.

## References

- Repo: `/Users/juan/Documents/daw-browser-convex`
- Diffusion reference repo: `/Users/juan/Documents/monorepo-new`
- TypeScript project references: <https://www.typescriptlang.org/docs/handbook/project-references.html>
- TypeScript `composite`: <https://www.typescriptlang.org/tsconfig/composite.html>
- TypeScript module resolution reference: <https://www.typescriptlang.org/docs/handbook/modules/reference.html>
- Bun workspaces: <https://bun.sh/docs/pm/workspaces>
- Node package exports: <https://nodejs.org/api/packages.html>
- MDN Web Audio API: <https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API>
- MDN `AudioContext`: <https://developer.mozilla.org/en-US/docs/Web/API/AudioContext>
- MDN `OfflineAudioContext`: <https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext>
- MDN `AudioWorklet`: <https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet>

## Validation Findings Incorporated

The initial plan was directionally right but not execution-safe. This revision is based on the current repository files and corrects the unsafe assumptions.

### Source evidence

- Root `package.json` has `workspaces: ["packages/*"]`, root dependencies on the four private packages, and `typecheck` currently runs only root app/API configs.
- Root `tsconfig.json` is an application config today: it includes `src`, `convex`, `vite.config.ts`, and all package `src` directories, and it owns app aliases `~/*` and `@/*` plus package source aliases.
- `api/tsconfig.json` currently extends `../tsconfig.json`, so it inherits app/Vite/package source settings. If the root config changes shape, API config must be updated at the same time.
- Package manifests currently export `.ts` source and have no package-local `check` scripts or package-local `tsconfig.json` files:
  - `@daw-browser/shared`
  - `@daw-browser/timeline-core`
  - `@daw-browser/audio-engine`
  - `@daw-browser/waveforms`
- Diffusion uses source-exported private workspace packages and package-local `check` scripts. Its root reference graph is not safe to copy directly into this repo without also adopting buildable/composite project configs.
- `packages/audio-engine/src/audio-engine.ts` currently owns runtime lifecycle, transport, metronome, synth/MIDI, mixer/effects, meters, source tracking, and scheduling in one class.
- AudioEngine has many real app consumers through `src/lib/audio-engine-singleton.ts`, timeline hooks, effects panel state, recording, MIDI overlay, undo execution, and playback controls. Public method names must remain stable.

### Corrections from validation

1. Do package-local checks first. Do not start by replacing root `tsconfig.json` with a reference orchestrator.
2. Keep source `.ts` exports initially. These are acceptable for private workspace packages and match the Diffusion pattern.
3. Do not use TypeScript project references unless package configs become buildable/composite. A root `references` graph is not useful with the current `tsc --noEmit -p ...` script and can fail under `tsc -b` if referenced projects disable emit.
4. If root/app config is split later, `api/tsconfig.json` must stop extending the app config and should extend a shared base config directly.
5. AudioEngine decomposition must be done by moving existing code exactly, one responsibility at a time. The object-literal examples from the first plan are sketches only and must not be copied as implementation because they introduce unsafe `this` patterns and unverified behavior changes.

---

# Plan 2 — Make Workspace Package Seams Enforceable

## Current Problem

PR #10 improved import direction, but package seams are still checked as part of the root app config instead of independently:

- Root `tsconfig.json` directly includes package implementation source.
- Root `paths` map package imports directly to package source.
- Package manifests export `.ts` source files, which is fine for private workspaces, but packages do not have their own `tsconfig.json` or `check` scripts.
- API config extends the app/root config and inherits unrelated app settings.

## Target Architecture

Each workspace package owns a local check surface:

```txt
packages/<name>/
  package.json
  tsconfig.json
  src/
```

The root check composes package-local checks plus app/API checks:

```txt
bun run check:packages
bun x tsc --noEmit -p tsconfig.json
bun x tsc --noEmit -p api/tsconfig.json
```

Keep package exports pointed at source until there is a real need for published declaration/dist artifacts.

## Phase 2.1 — Add `tsconfig.base.json`

Create a shared base config by moving common compiler options from the current root config, not by changing behavior wholesale.

Target shape:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

Rules:

- Do not add Diffusion's stricter flags in this slice unless they pass without broad unrelated cleanup.
- Do not make this config an orchestrator.
- Do not add `composite`, `declaration`, or build output settings in this slice.

## Phase 2.2 — Keep root `tsconfig.json` as the app config for now

Update root `tsconfig.json` to extend `./tsconfig.base.json`, but keep it as the current app-level check config.

Expected root config shape:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["vite/client"],
    "paths": {
      "~/*": ["./src/*"],
      "@/*": ["./src/*"],
      "@daw-browser/audio-engine/*": ["./packages/audio-engine/src/*"],
      "@daw-browser/shared": ["./packages/shared/src/index.ts"],
      "@daw-browser/timeline-core/*": ["./packages/timeline-core/src/*"],
      "@daw-browser/waveforms/*": ["./packages/waveforms/src/*"]
    }
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "packages/audio-engine/src/**/*.ts",
    "packages/shared/src/**/*.ts",
    "packages/timeline-core/src/**/*.ts",
    "packages/waveforms/src/**/*.ts",
    "convex/**/*.ts",
    "vite.config.ts"
  ]
}
```

This intentionally preserves the current root check while package-local checks are introduced. Removing package includes/path aliases is a later phase after package-local checks are proven.

## Phase 2.3 — Add package-local `tsconfig.json` files

Add one `tsconfig.json` per package.

Shared and timeline-core:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM"]
  },
  "include": ["src/**/*.ts"]
}
```

`DOM` is required for the current source-export workspace pattern because `shared` uses Web Crypto for local IDs, and `timeline-core` resolves shared package source during its package-local check.

Audio-engine and waveforms:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM"]
  },
  "include": ["src/**/*.ts"]
}
```

Rules:

- Add only the libs each package needs.
- Do not include app `src`, `convex`, or `api` files from package configs.
- Do not add project references in this phase.

## Phase 2.4 — Add package-local `check` scripts

Add the same local script to each package manifest:

```json
{
  "scripts": {
    "check": "bun --bun tsc --noEmit"
  }
}
```

Then add a root package-check script and include it in `typecheck`:

```json
{
  "scripts": {
    "check:packages": "bun --filter '@daw-browser/shared' --filter '@daw-browser/timeline-core' --filter '@daw-browser/audio-engine' --filter '@daw-browser/waveforms' check",
    "typecheck": "bun run check:packages && bun x tsc --noEmit -p tsconfig.json && bun x tsc --noEmit -p api/tsconfig.json"
  }
}
```

If Bun filter syntax behaves unexpectedly, use explicit package commands instead of introducing a custom runner:

```bash
bun --cwd packages/shared run check
bun --cwd packages/timeline-core run check
bun --cwd packages/audio-engine run check
bun --cwd packages/waveforms run check
```

## Phase 2.5 — Fix API config inheritance only when splitting root/app config

Do not let `api/tsconfig.json` extend a future app-only config. If root remains the app config, leave API as-is until the split is ready. If app/root config is split, update API in the same change.

Target API config when split:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ESNext"],
    "types": ["./worker-configuration.d.ts"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": [
    "**/*.ts",
    "../packages/shared/src/**/*.ts",
    "../packages/timeline-core/src/**/*.ts",
    "../src/types/**/*.ts"
  ]
}
```

Rules:

- API should not inherit Vite client types.
- API should not include `src/**/*.tsx`, audio-engine, or waveforms unless real API imports require them.
- Validate with `--listFilesOnly` after changing inheritance.

## Phase 2.6 — Optional later seam hardening

Only after Phase 2.1-2.5 pass cleanly, consider narrowing app/root includes and package path aliases.

Safe later target:

- Keep app aliases `~/*` and `@/*` only in the app config.
- Let package imports resolve through workspace package manifests where possible.
- Keep package-internal imports relative.
- Do not export package internals unless a real external consumer exists.

Do not convert root `tsconfig.json` into this until the project is ready for buildable references:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/timeline-core" },
    { "path": "./packages/audio-engine" },
    { "path": "./packages/waveforms" }
  ]
}
```

If project references are adopted later:

- Use `tsc -b`, not `tsc --noEmit -p`, as the orchestrator command.
- Make referenced projects `composite: true` and emit declarations or otherwise satisfy referenced-project requirements.
- Rework source exports and package consumers deliberately if declaration/dist artifacts are introduced.
- Update `api/tsconfig.json` before or with the root split.

## Phase 2 Acceptance Criteria

Required validation after Phase 2.1-2.4:

```bash
bun run check:packages
bun run typecheck
bun run knip
bun run build
git diff --check -- . ':(exclude)dist/**'
```

Targeted seam checks:

```bash
bun x tsc --noEmit -p packages/shared/tsconfig.json
bun x tsc --noEmit -p packages/timeline-core/tsconfig.json
bun x tsc --noEmit -p packages/audio-engine/tsconfig.json
bun x tsc --noEmit -p packages/waveforms/tsconfig.json
bun x tsc --noEmit -p api/tsconfig.json --listFilesOnly
```

Manual inspection after `--listFilesOnly`:

- API should not pull unrelated app UI files.
- API should not pull `packages/audio-engine` or `packages/waveforms` unless new real API imports require them.

---

# Plan 3 — Decompose `AudioEngine` Without Changing Its Public Interface

## Current Problem

`packages/audio-engine/src/audio-engine.ts` is about 1,424 lines and owns unrelated responsibilities:

- `AudioContext` lifecycle
- master graph and destination wiring
- track node graph
- EQ/reverb effects
- mixer routing
- metering and spectrum
- `AudioWorklet` setup
- transport clock
- metronome scheduling
- MIDI synth state
- source scheduling
- source cleanup
- decode lifecycle

The public `AudioEngine` class is useful to app consumers. The problem is internal locality, not the public API.

## Public facade to preserve

Do not change real consumers in `src/` unless an import path format change is mechanically required.

Known public methods used by the app include:

```txt
ensureAudio
resume
close
decodeAudioData
getAudioContext
getTrackSynthGainNode
getTrackSynthPreviewState
setBpm
setMetronomeEnabled
onTransportStart
onTransportPause
onTransportStop
onTransportSeek
updateTrackGains
previewTrackVolume
scheduleAllClipsFromPlayhead
rescheduleClipsAtPlayhead
stopAllSources
setTrackEq
setTrackReverb
setMasterEq
setMasterReverb
setTrackSynth
setTrackArpeggiator
clearTrackArpeggiator
clearTrackSynth
getTrackLevel
getTrackSpectrum
getMasterSpectrum
subscribeTrackStereoLevels
```

Rules:

- Preserve method names, parameters, return types, and side effects unless a separate behavior change is explicitly approved.
- Do not add new public package exports for extracted internals.
- Extract by moving existing functions/state with minimal adaptation.
- Do not copy the old plan's object-literal sketches as implementation; avoid methods that call `this` inside returned object literals.
- Prefer plain functions and explicit dependencies over hidden shared module state.

## Phase 3.1 — Freeze behavior before extracting

Before the first extraction, run validators and smoke the behavior that can regress:

```bash
bun run typecheck
bun run knip
bun run build
git diff --check -- . ':(exclude)dist/**'
```

Manual smoke matrix:

```txt
Transport:
- play from 0 schedules audio and MIDI
- seek during playback clears old sources and schedules new ones
- loop end caps scheduling through endLimitSec
- stop resets source registry and active notes

Mixer:
- muted track gain becomes 0
- soloed track suppresses unrelated outputs
- send routing connects to return/group target
- outputTargetId routes to group/master

Effects:
- track EQ/reverb applies through existing calls
- master EQ/reverb applies through existing calls

Meters:
- subscribeTrackStereoLevels starts worklet activity
- unsubscribe disables worklet activity
- getTrackSpectrum returns last frame if current bins are empty

Lifecycle:
- ensureAudio creates context lazily
- close disconnects nodes and clears runtime state
- export dialog/render still imports @daw-browser/audio-engine/export-mixdown
```

## Phase 3.2 — Extract `transport-clock.ts` first

This is the lowest-risk pure extraction because the current clock state is scalar:

Current fields:

```txt
bpm
transportEpochCtxTime
transportEpochTimelineSec
transportRunning
```

Move existing logic from:

```txt
secondsPerBeat
timelineToCtxTime
ctxTimeToTimeline
setBpm
onTransportStart/onTransportPause/onTransportStop/onTransportSeek epoch updates
```

Implementation rules:

- Keep clamping behavior for invalid BPM exactly as currently implemented.
- Keep `onTransportSeek(..., offsetSec)` mapping behavior exactly.
- Keep metronome reset behavior in `AudioEngine` until metronome extraction.
- Validate after this extraction before touching source scheduling.

## Phase 3.3 — Extract `source-registry.ts`

Current fields:

```txt
activeSources
activeSourcesByClip
```

Move only source tracking and source cleanup:

```txt
stopAllSources audio-source portion
stopSourcesForClip
activeSources onended cleanup
clip-specific source indexing
```

Implementation rules:

- Preserve current stop/disconnect try/catch behavior.
- Preserve delayed master stop behavior for master/return routing if currently tied to source cleanup.
- Do not move synth active-note cleanup in this phase; call the existing AudioEngine synth cleanup from the facade.
- Validate playback, seek, and `rescheduleClipsAtPlayhead` after this extraction.

## Phase 3.4 — Extract `audio-runtime.ts`

Current fields:

```txt
audioCtx
masterGain
destination
```

Move lifecycle helpers only:

```txt
create AudioContext
create/connect master gain
resume
decodeAudioData
close context/master/destination portion
currentTime/output latency accessors if useful internally
```

Implementation rules:

- Preserve lazy `ensureAudio` behavior.
- Preserve `applyCachedTrackGains` behavior by keeping the facade orchestration in `AudioEngine`.
- Preserve `getAudioContext()` behavior for MIDI overlay/recording consumers.
- Do not move master EQ/reverb routing in this phase.

## Phase 3.5 — Extract `metering-runtime.ts`

Current fields/methods:

```txt
meterRuntime
meterWorkletReady
meterWorkletNodes
meterWorkletLevels
pendingMeterLevels
meterListeners
meterFlushHandle
zeroTrackStereoLevels
ensureMeterWorkletModule
emitTrackStereoLevels
queueTrackStereoLevels
updateMeterWorkletSubscriptionState
ensureTrackMeterWorklet
subscribeTrackStereoLevels
ensureTrackAnalyser
reconnectTrackMeters
disposeTrackMeterRuntime
getTrackLevel
getTrackSpectrum
getMasterSpectrum meter pieces only after master analyzer is isolated
```

Implementation rules:

- Start with track stereo levels and track analyzers; leave master analyzer in the facade until the track-meter extraction is stable.
- Preserve RAF batching and cleanup exactly.
- Preserve `getTrackSpectrum` fallback to the last spectrum frame.
- Validate effects panel meters after this extraction.

## Phase 3.6 — Extract `live-mixer-runtime.ts`

Current fields/methods:

```txt
tracksSnapshot
mixerRuntime.trackNodes
mixerRuntime.trackSendGains
mixerRuntime.returnInputGains
mixerRuntime.groupInputGains
effectsRuntime.eqChains
effectsRuntime.eqSignatures
effectsRuntime.eqTopologySignatures
effectsRuntime.reverbs
effectsRuntime.reverbSignatures
pending track/master effect params as needed
ensureTrackNodes
rebuildTrackRouting
previewTrackVolume
setTrackEq
setTrackReverb
updateTrackGains
buildResolvedMixerGraph
cleanupTrackSendGains
disposeTrackRuntime
```

Implementation rules:

- Keep master EQ/reverb in `AudioEngine` until track routing/effects are stable.
- Keep `applyLiveMixerGraph`, `resolveMixerGraph`, and existing mixer/effects helpers; do not duplicate them.
- Preserve routing signatures and no-op behavior.
- Preserve meter reconnect callbacks into `metering-runtime`.
- Validate routing, mute/solo, sends, track EQ, and track reverb.

## Phase 3.7 — Extract `synth-runtime.ts`

Current fields/methods:

```txt
synthRuntime.configs
synthRuntime.arpeggiators
synthRuntime.activeOscillators
synthRuntime.activeNotesByClip
synthRuntime.activeNotesByTrack
setTrackSynth
setTrackArpeggiator
clearTrackArpeggiator
clearTrackSynth
computeCurrentAmp
stopActiveNote
stopActiveNotesForClip
stopAllActiveNotes
retargetActiveNotesForTrack
ensureTrackSynthGainNode
getTrackSynthGainNode
getTrackSynthPreviewState
scheduleMidiClip
```

Implementation rules:

- Preserve MIDI overlay/preview consumers: `getAudioContext`, `getTrackSynthGainNode`, and `getTrackSynthPreviewState` must continue to work.
- Preserve active note retargeting when synth params change.
- Keep scheduling orchestration in `AudioEngine` until clip scheduler extraction.
- Validate MIDI playback and overlay preview before proceeding.

## Phase 3.8 — Extract `metronome-runtime.ts`

Current fields/methods:

```txt
metronomeEnabled
metronomeGain
metronomeBuffer
metronomeSources
metronomeSchedulerId
nextMetronomeBeatTimelineSec
metronomeLookaheadSec
metronomeIntervalMs
ensureMetronomeNodes
createMetronomeBuffer
setMetronomeInterval
clearMetronomeInterval
computeNextBeatTimelineSec
scheduleMetronomeTicks
resetMetronomeState
setMetronomeEnabled
metronome portions of onTransportStart/onTransportPause/onTransportStop/onTransportSeek
```

Implementation rules:

- Existing `setInterval` usage is acceptable only for audio lookahead scheduling.
- Keep cleanup deterministic: clear interval and stop/disconnect scheduled metronome sources.
- Preserve beat alignment and `resetMetronome` seek behavior.
- Validate metronome enable/disable, play, pause, stop, and seek.

## Phase 3.9 — Extract `master-fx-runtime.ts` only after track mixer is stable

Current fields/methods:

```txt
masterEqChain
masterEqSignature
masterEqTopologySignature
masterAnalyser
masterSpectrumTmp
masterSpectrumLast
masterAnalyserConnected
masterReverb
masterReverbSignature
pendingMasterEqParams
pendingMasterReverbParams
ensureMasterAnalyser
setMasterEq
setMasterReverb
rebuildMasterRouting
getMasterSpectrum
```

Implementation rules:

- Preserve analyzer tap behavior.
- Preserve pending master effect params before audio is initialized.
- Preserve current routing order through EQ/reverb/final destination.
- Validate master EQ/reverb and master spectrum display.

## Phase 3.10 — Extract `clip-scheduler.ts` last

Current fields/methods:

```txt
scheduleIndexCache
scheduleAudioClip
scheduleMidiClip orchestration after synth extraction
getScheduleIndex
findFirstScheduleEntryEndingAfter
scheduleAllClipsFromPlayhead
rescheduleClipsAtPlayhead
```

Implementation rules:

- Keep existing pure helpers in `audio-scheduling.ts`; do not duplicate them.
- Preserve `WeakMap<RuntimeTrack[], ScheduleIndex>` cache semantics.
- Preserve end-limit behavior for loop scheduling.
- Preserve audio clip offset/start/duration behavior.
- Preserve clip-specific reschedule behavior: stop only affected audio sources and synth notes, then schedule the affected clips.
- Validate play, seek, loop scheduling, and clip reschedule.

## Final target module layout

```txt
packages/audio-engine/src/
  audio-engine.ts                  # public facade only
  audio-runtime.ts                 # context/master/destination lifecycle
  transport-clock.ts               # bpm and context/timeline mapping
  source-registry.ts               # audio source tracking/cleanup
  metering-runtime.ts              # track meters/analyzers/worklet batching
  live-mixer-runtime.ts            # track graph/routing/track effects
  synth-runtime.ts                 # MIDI synth state and active notes
  metronome-runtime.ts             # metronome lookahead scheduling
  master-fx-runtime.ts             # master EQ/reverb/analyzer routing
  clip-scheduler.ts                # audio/MIDI clip scheduling orchestration
  audio-scheduling.ts              # existing pure scheduling helpers
  export-mixdown.ts                # keep separate/offline export path
  effects/
  mixer/
```

## Implementation sequence and validation gates

Run these as separate slices. Do not start the next slice until validators and relevant smoke pass.

1. Freeze behavior with validators and browser smoke.
2. Extract `transport-clock.ts`; run validators.
3. Extract `source-registry.ts`; run validators and playback/seek/reschedule smoke.
4. Extract `audio-runtime.ts`; run validators and lifecycle/recording/MIDI overlay smoke.
5. Extract track metering into `metering-runtime.ts`; run validators and meter smoke.
6. Extract track graph/routing/effects into `live-mixer-runtime.ts`; run validators and mixer/effects smoke.
7. Extract synth/MIDI state into `synth-runtime.ts`; run validators and MIDI smoke.
8. Extract metronome into `metronome-runtime.ts`; run validators and metronome smoke.
9. Extract master effects/analyzer into `master-fx-runtime.ts`; run validators and master effects smoke.
10. Extract clip scheduling into `clip-scheduler.ts`; run full validators and full browser smoke.

Required validators after each slice:

```bash
bun run typecheck
git diff --check -- . ':(exclude)dist/**'
```

Required validators before marking the full AudioEngine decomposition complete:

```bash
bun run typecheck
bun run knip
bun run build
git diff --check -- . ':(exclude)dist/**'
```

Browser smoke before completion:

```txt
- local project create/reload
- play/pause/stop
- seek while playing
- loop scheduling if available
- MIDI clip playback
- MIDI overlay preview still works
- track EQ/Reverb add and live update
- master EQ/Reverb add and live update
- meters update and stop updating after unsubscribe/close
- export dialog opens
- export render still imports @daw-browser/audio-engine/export-mixdown
```

## Phase 3 Acceptance Criteria

- `AudioEngine` public methods unchanged.
- `src/` consumers unchanged except import formatting if absolutely necessary.
- No package-internal runtime module exported unless required by a real consumer.
- `audio-engine.ts` is reduced substantially while remaining a readable facade.
- Each extracted module has one reason to change.
- No duplicate scheduling, routing, effect, or metering logic is introduced.
- Validators and browser smoke pass.

---

# Plan 4 — Finish Remaining Package Seam Hardening

## Goal

Close the remaining unchecked Plan 2 items without introducing buildable TypeScript project references yet:

1. Split API away from the app/root TypeScript config so API no longer inherits Vite/browser app settings.
2. Narrow the root app config so packages are checked by their package-local configs and are pulled into the app only through real imports.
3. Record an explicit "no project references yet" decision because the current private workspace packages still source-export `.ts` files and use `tsc --noEmit`.

## Current evidence to preserve

- `api/` imports `@daw-browser/shared` and `@daw-browser/timeline-core/types`; it does not import `@daw-browser/audio-engine`, `@daw-browser/waveforms`, `~/*`, or `@/*`.
- A temporary validation of the narrowed app config passed:

```bash
bun x tsc --noEmit -p .tmp-tsconfig-app-narrow.json
```

- A temporary validation of API extending `tsconfig.base.json` directly passed:

```bash
bun x tsc --noEmit -p .tmp-tsconfig-api-esnext.json
```

These temp files were only validation probes; do not add them to the repo.

## Phase 4.1 — Split API config from the app config

Update `api/tsconfig.json` so it extends `../tsconfig.base.json`, not `../tsconfig.json`.

Target:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ESNext"],
    "types": ["./worker-configuration.d.ts"],
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": [
    "**/*.ts",
    "../packages/shared/src/**/*.ts",
    "../packages/timeline-core/src/**/*.ts",
    "../src/types/**/*.ts"
  ]
}
```

Validation after this phase:

```bash
bun x tsc --noEmit -p api/tsconfig.json
bun x tsc --noEmit -p api/tsconfig.json --listFilesOnly > /tmp/daw-api-files.txt
```

Manual check:

```bash
rg "packages/(audio-engine|waveforms)|src/components|src/hooks|vite/client" /tmp/daw-api-files.txt
```

Expected result: no matches. `packages/shared`, `packages/timeline-core`, and `src/types` may appear because they are explicit API dependencies.

## Phase 4.2 — Narrow root `tsconfig.json` to the app surface

Keep root `tsconfig.json` as the app config, but remove package implementation globs from `include` and remove package source aliases from `paths`. Workspace package imports should resolve through each package's `package.json` exports.

Target:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["vite/client"],
    "paths": {
      "~/*": ["./src/*"],
      "@/*": ["./src/*"]
    }
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "convex/**/*.ts",
    "vite.config.ts"
  ]
}
```

Important: package source files may still appear in `--listFilesOnly` because app files import workspace packages. That is fine. The goal is that package files are no longer direct root `include` entries and package internals are no longer root path aliases.

Validation after this phase:

```bash
bun x tsc --noEmit -p tsconfig.json
bun x tsc --noEmit -p tsconfig.json --listFilesOnly > /tmp/daw-app-files.txt
```

Manual check:

```bash
rg "/Users/juan/Documents/daw-browser-convex/api/" /tmp/daw-app-files.txt
```

Expected result: no matches, unless a real app import starts depending on API files. Do not use a bare `api/` search here because dependencies such as `node_modules/better-auth/dist/api/*.d.mts` are legitimate app transitive type files. Do not add package path aliases back unless TypeScript resolution fails and the failure is proven.

## Phase 4.3 — Re-run package-local checks after narrowing

Package-local checks are the seam guard. Run them again after root/API split changes:

```bash
bun run check:packages
bun x tsc --noEmit -p packages/shared/tsconfig.json
bun x tsc --noEmit -p packages/timeline-core/tsconfig.json
bun x tsc --noEmit -p packages/audio-engine/tsconfig.json
bun x tsc --noEmit -p packages/waveforms/tsconfig.json
```

If any package fails because it relied on app config settings, fix that package's local `tsconfig.json`; do not put package settings back into the root app config.

## Phase 4.4 — Explicitly do not adopt project references in this slice

Do not add this yet:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/shared" },
    { "path": "./packages/timeline-core" },
    { "path": "./packages/audio-engine" },
    { "path": "./packages/waveforms" }
  ]
}
```

Reason: the current package configs are `noEmit` source-check configs, not buildable referenced projects. If project references are introduced later, that must be its own plan with:

```json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true,
    "outDir": "dist"
  }
}
```

and the orchestrator must use:

```bash
bun x tsc -b
```

not:

```bash
bun x tsc --noEmit -p tsconfig.json
```

For this tracker, completion means recording the decision and leaving project references unadopted intentionally.

## Phase 4.5 — Final validators before marking Plan 4 complete

Run:

```bash
bun run typecheck
bun run knip
bun run build
git diff --check -- . ':(exclude)dist/**'
```

Then inspect:

```bash
git diff -- tsconfig.json api/tsconfig.json package.json packages/*/tsconfig.json
```

Acceptance criteria:

- API extends `../tsconfig.base.json`, not `../tsconfig.json`.
- Root app config keeps only app aliases (`~/*`, `@/*`).
- Root app config no longer directly includes package source globs.
- `bun run typecheck` still composes `check:packages`, root app check, and API check.
- No TypeScript project references were added.
- `knip`, build, and whitespace checks pass.

## Plan 4 tasks

- [x] Update `api/tsconfig.json` to extend `../tsconfig.base.json`.
- [x] Validate API list files and confirm no app UI/audio/waveform files are pulled into API.
- [x] Narrow root `tsconfig.json` to app files and app aliases only.
- [x] Validate app list files and confirm API files are not pulled into the app check.
- [x] Re-run package-local checks after root/API split changes.
- [x] Record the explicit no-project-references-yet decision.
- [x] Run final validators.
- [x] Mark remaining Plan 2 unchecked items complete after evidence is recorded.

### 2026-06-05 Plan 4 completion evidence

- `api/tsconfig.json` now extends `../tsconfig.base.json` directly, so API no longer inherits Vite client types or app aliases from the root app config.
- Root `tsconfig.json` now keeps only app aliases (`~/*`, `@/*`) and no longer directly includes package source globs.
- API list-file validation passed with no matches for `packages/audio-engine`, `packages/waveforms`, `src/components`, `src/hooks`, or `vite/client`.
- App list-file validation passed with no repo API files pulled into the app check. The check intentionally searches for the repo API path, not bare `api/`, because node_modules packages can legitimately contain `dist/api` type files.
- Package-local checks passed after the root/API split.
- No TypeScript `references`, `composite`, or declaration emit settings were added; project references remain intentionally deferred until a future buildable-package plan.
- Final validators passed: `bun run typecheck`, `bun run knip`, `bun run build`, and `git diff --check -- . ':(exclude)dist/**'`.

---

# Execution Status

## Plan 2 tasks

- [x] Add `tsconfig.base.json` from current shared compiler options.
- [x] Add package-local `tsconfig.json` files.
- [x] Add package-local `check` scripts.
- [x] Add root `check:packages` and wire it into `typecheck`.
- [x] Validate package-local checks and current app/API checks.
- [x] Split root/app/API configs further using Plan 4.
- [x] Record the Plan 4 decision to not adopt project references until composite/buildable package configs are intentionally introduced.

## Plan 3 tasks

- [x] Freeze current AudioEngine behavior with validators.
- [x] Extract `transport-clock.ts`.
- [x] Extract `source-registry.ts`.
- [x] Extract `audio-runtime.ts`.
- [x] Extract track metering into `metering-runtime.ts`.
- [x] Extract track mixer/effects into `live-mixer-runtime.ts`.
- [x] Extract synth/MIDI state into `synth-runtime.ts`.
- [x] Extract metronome into `metronome-runtime.ts`.
- [x] Extract master effects/analyzer into `master-fx-runtime.ts`.
- [x] Extract clip scheduling into `clip-scheduler.ts`.
- [x] Run full validators and browser smoke.

### 2026-06-05 intermediate completion audit

- Package seam tasks are complete. The current package-local checks match the validated source-exported private workspace package pattern used by Diffusion.
- `transport-clock.ts`, `source-registry.ts`, `audio-runtime.ts`, `metering-runtime.ts`, `metronome-runtime.ts`, `master-fx-runtime.ts`, and `clip-scheduler.ts` are real responsibility extractions.
- At this intermediate point, `live-mixer-runtime.ts` and `synth-runtime.ts` were not yet full responsibility extractions. The final extraction audit below supersedes this earlier finding.
- Diffusion's `AudioBus` pattern keeps state, sync, effect-chain rebuild, parameter updates, and cleanup together behind a small consumer-shaped object. The final mixer and synth work follows that shape by moving cohesive behavior with its state instead of leaving thin map holders plus large facade methods.

### 2026-06-05 final extraction audit

- `live-mixer-runtime.ts` now owns track node construction, routing signatures, send gains, track EQ/reverb chains, pending track effect params, live mixer graph application, track cleanup, and meter/synth disposal callbacks.
- `synth-runtime.ts` now owns synth params, arpeggiators, synth gain nodes, active oscillators/notes, active note retargeting, MIDI clip scheduling, clip note stopping, all-note stopping, and synth track cleanup.
- `audio-engine.ts` now delegates track mixer/effects and synth/MIDI behavior through the runtime module interfaces while preserving its public facade methods.
- Helium smoke completed against the already-open local tab: master EQ/reverb visible and live, track EQ/reverb added and rendered, play/stop and metronome toggle produced no final console errors, and a browser-side `AudioEngine` MIDI/synth smoke exercised synth preview, synth gain creation, MIDI scheduling, clip reschedule, and cleanup without console errors.

## Execution log

- 2026-06-05: Added package-local TypeScript check surfaces and wired them into root `typecheck`.
- 2026-06-05: Extracted `transport-clock.ts`, `source-registry.ts`, and `audio-runtime.ts` as the first low-risk AudioEngine slices.
- 2026-06-05: `bun run typecheck`, `bun run knip`, `bun run build`, and `git diff --check -- . ':(exclude)dist/**'` passed after these slices.
- 2026-06-05: Extracted `metering-runtime.ts` and `metronome-runtime.ts`; full validators passed and Helium reload/play/stop/space-key smoke on the already-open tab reported no reload console errors.
- 2026-06-05: Added `master-fx-runtime.ts`, `clip-scheduler.ts`, `synth-runtime.ts`, and `live-mixer-runtime.ts`; public `AudioEngine` methods remained unchanged.
- 2026-06-05 audit: Corrected the tracker to mark `live-mixer-runtime.ts` and `synth-runtime.ts` as incomplete because those files are currently state holders, not full responsibility extractions.
- 2026-06-05: Finished the `live-mixer-runtime.ts` and `synth-runtime.ts` extractions and restored their tracker items to complete after full validation and browser smoke passed.
- 2026-06-05: Completed the strict follow-up browser smoke for track EQ/reverb, master EQ/reverb, and MIDI/synth runtime behavior in the already-open Helium tab.
- 2026-06-05: Completed Plan 4 by splitting API away from the app config, narrowing root `tsconfig.json` to app aliases/includes, preserving package-local seam checks, and intentionally deferring project references.
