# Plan 002: Bound EQ interaction and spectrum rendering work

> Follow each step and verification gate. Preserve the EQ visual design and sample-accurate native control path.
>
> **Drift check**: `git diff --stat 964a313..HEAD -- src/components/effects/Eq.tsx src/hooks/useEffectsPanelAudioSync.ts src/hooks/useTimelinePlayback.ts src/lib/desktop/native-playback-controller.ts src/components/timeline/create-effects-panel-audio-effects-state.ts native/audio-host-macos/src/audio-host.cpp`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-patch-built-in-state-without-stopping.md`
- **Category**: performance
- **Planned at**: commit `964a313`, 2026-08-01

## Why this matters

EQ dragging currently performs several synchronous workloads for every pointer event. `Eq.tsx` updates persisted draft state, redraws the full canvas immediately, smooths roughly one sample per horizontal pixel with a variable-radius nested loop, and calls `BiquadFilterNode.getFrequencyResponse` for every enabled band. Separately, every draft change causes `create-effects-panel-audio-effects-state.ts` to rebuild and reapply browser-engine effect instances, even when native playback owns audio. Native spectrum frames are also forwarded directly into Solid state with no renderer-side frame budget. These paths can monopolize the renderer long enough to freeze controls and starve playback coordination.

## Current state

- `src/components/effects/Eq.tsx:447-463` calls `draw()` synchronously from a reactive effect for every band/spectrum/tick update.
- `Eq.tsx:338-372` performs per-pixel spectrum sampling and nested smoothing.
- `Eq.tsx:390-426` recomputes all enabled band responses on every draw.
- `Eq.tsx:493-536` calls `onBandChange` on every pointer move.
- `src/components/timeline/create-effects-panel-audio-effects-state.ts:701-707` reapplies all effect instances whenever draft params change.
- `src/hooks/useEffectsPanelAudioSync.ts:288-308` writes every spectrum frame into a Solid signal.
- `src/lib/desktop/native-playback-controller.ts:285-304` allocates a new `Float32Array` and notifies listeners for every accepted native spectrum frame.
- `native/audio-host-macos/src/audio-host.cpp:748-787` copies spectrum samples from the realtime callback into a bounded queue; FFT work is off callback and should remain there.

## Commands

| Purpose | Command | Expected |
|---|---|---|
| EQ/state tests | `bun test src/hooks/useEffectsPanelAudioSync.test.ts src/components/timeline/create-effects-panel-audio-effects-state.test.ts` plus the new pure EQ render-work test | all pass |
| Controller tests | `bun test src/lib/desktop/native-playback-controller.test.ts` | all pass |
| Typecheck | `bun run typecheck` | exit 0 |
| Focused lint | `bun x oxlint --deny-warnings src/components/effects/Eq.tsx src/hooks/useEffectsPanelAudioSync.ts src/lib/desktop/native-playback-controller.ts src/components/timeline/create-effects-panel-audio-effects-state.ts` | exit 0 |
| Package | `bun --filter @daw-browser/desktop package` | exit 0 |

## Scope

**In scope**

- `src/components/effects/Eq.tsx` and focused tests
- `src/hooks/useEffectsPanelAudioSync.ts` and focused tests
- `src/hooks/useTimelinePlayback.ts` if subscription shape changes
- `src/lib/desktop/native-playback-controller.ts` and tests
- `src/components/timeline/create-effects-panel-audio-effects-state.ts` and tests
- Native spectrum cadence changes only if renderer coalescing is insufficient

**Out of scope**

- Changing EQ visual appearance
- Lowering audio callback rate or buffer size
- Removing spectrum visualization
- DSP response behavior or persisted EQ schema
- `AGENTS.md` and root `main.js`

## Steps

### 1. Make canvas drawing one-frame-latest

Replace synchronous reactive `draw()` calls with a single scheduled canvas frame:

- store invalidation flags for spectrum, response, nodes/grid, and size;
- allow at most one pending `requestAnimationFrame`;
- multiple pointer/spectrum updates before that frame collapse into one draw using latest values;
- cancel the pending frame on cleanup;
- do not create a self-rescheduling loop while fresh spectrum frames are arriving.

The existing silence decay may schedule frames only while visible spectrum energy remains and must share the same draw scheduler.

**Verify**: a test emits many band and spectrum updates synchronously and observes one scheduled draw.

### 2. Separate drag preview from durable commit

Add explicit continuous-edit semantics instead of treating each pointer sample as a completed edit:

- begin: capture geometry, target/instance/project generation, automation override ownership, and the normalized persisted baseline;
- preview: update local drag visuals and the owning live backend at most once per display frame without history or persistence;
- commit: synchronously flush the exact final value on pointer-up/cancel, then create one history entry and one durable write from initial to final state;
- explicit cancellation: restore baseline without history/persistence. Lost capture, pointer-cancel, and pointer-up commit the latest visible value to avoid UI/backend divergence.

Reuse the existing 200 ms settled-write infrastructure where it fits. Do not create one persistence operation or history notification per pointer sample. Keep keyboard/knob discrete edits immediate.

Extend `Knob`/`useSteppedValueControl` with optional begin/end/cancel callbacks so frequency, gain, and Q knobs use the same interaction contract. Send automation override notifications once at interaction start.

**Verify**: 100 pointer moves produce one pending preview per frame and one final persistence/history commit.

### 3. Cache response work and make smoothing linear

Replace `smoothSpectrumY`’s per-pixel variable-radius nested scan with a bounded O(bin count + canvas width) smoothing pass, such as prefix sums or a two-pass sliding window. Reuse typed buffers and gradients where size/theme permits. Cache only the combined EQ response data and recompute it when band parameters or canvas dimensions change. Do not introduce offscreen static-layer canvases unless profiling after these changes still proves them necessary. Do not allocate in pointer-move or per-frame hot paths.

**Verify**: unit-test the smoothing helper and add a benchmark-style assertion that work scales linearly with canvas width.

### 4. Stop duplicate browser-chain synchronization outside legacy ownership

Add an explicit reactive `usesLegacyAudioEngine()` ownership accessor, defined as neither native nor portable-browser playback being prepared. Thread it from playback through Timeline and effects-panel controller ownership. Gate both browser-chain synchronization paths:

- direct/reactive `applyInstancesToEngine` calls in `create-effects-panel-audio-effects-state.ts`;
- persisted-chain synchronization in `useEffectsPanelAudioSync.ts`.

Behavior:

- browser backend owns audio: continue optimistic browser-engine updates;
- native backend prepared/active: send mapped preview events and do not rebuild browser effect chains;
- portable backend prepared/active: send mapped portable processor events and do not rebuild/restart the portable backend for every preview;
- backend ownership transition to browser: apply the latest complete instance snapshot once.

Keep persistence and native parameter event delivery independent.

**Verify**: tests prove rapid native-owned EQ drafts produce zero browser chain applications and one current snapshot is applied when browser ownership resumes.

### 5. Bound spectrum delivery to display cadence

At the playback subscription boundary, own exactly one animation-frame loop per subscriber. Native callbacks replace one pending latest frame; browser/portable spectrum is pulled once per display frame. Drop superseded frames and cancel on unsubscribe/target change. Reuse the `Float32Array` already produced by the desktop decoder rather than making another controller copy.

Do not throttle meter/audio processing and do not put browser APIs in native/controller modules that must remain platform-neutral. If necessary, inject a scheduler from `useTimelinePlayback`.

Only change native production cadence if profiling still shows host-side pressure after renderer work is bounded. If changed, decimate before copying full spectrum events from the callback, preserve queue bounds, and keep FFT off the callback.

**Verify**: burst tests prove latest-frame delivery and no callbacks after unsubscribe.

### 6. Update topology-stable Web Audio EQ nodes in place

The browser runtimes already retain EQ nodes and expose `getEqTopologySignature` plus `applyEqNodeParams` in `packages/audio-engine/src/effects/dsp.ts`. In `live-mixer-runtime.ts` and `master-fx-runtime.ts`:

- when EQ topology is unchanged, update retained node parameters in place;
- preserve node identities and routing;
- rebuild only for enabled state, channel mode, band type/order, or enabled-band topology changes;
- keep candidate preparation transactional so a later effect failure cannot leak partial parameter changes.

**Verify**: frequency/gain/Q edits preserve node identities and routing; structural edits still rebuild.

### 7. Add focused performance diagnostics

In development builds only, add a narrow EQ diagnostic that records:

- pointer events received versus commits emitted;
- spectrum frames received versus painted;
- worst and average canvas draw duration over the interaction;
- browser effect-chain applications during native ownership.

Do not log parameter values or project/user data. Remove the logs after packaged runtime validation unless a small disabled-by-default diagnostic helper already exists.

**Verify**: packaged runtime drag stays responsive, playback/meter cadence continues, and logs show bounded commits/paints.

## Test plan

- Add a pure render-work helper and test rather than introducing a DOM mounting dependency solely for `Eq.tsx`.
- Add a pure linear smoothing helper test.
- Add scheduler tests with an injected fake frame scheduler.
- Add pointer coalescing/final-flush component tests.
- Add preview-versus-final-commit tests for history and persistence.
- Add native-ownership browser-chain suppression test.
- Add spectrum burst/latest-frame/unsubscribe tests.
- Add browser-runtime tests proving topology-stable EQ edits update retained nodes in place.
- Runtime: drag an EQ node continuously for at least ten seconds during arranged playback and held MIDI; confirm no multi-second UI freeze, no audible dropout, and stable host/worker PIDs.

## Done criteria

- [ ] EQ draws at most once per display frame.
- [ ] Spectrum smoothing is O(canvas width), with reused buffers.
- [ ] Pointer moves emit at most one native/persistence-facing update per display frame and preserve the final value.
- [ ] Native-owned and portable-owned drafts do not rebuild browser effect chains through either synchronization path.
- [ ] Spectrum delivery is latest-only and display-cadence bounded.
- [ ] No new polling/timer loops.
- [ ] Focused tests, typecheck, lint, and desktop package pass.

## STOP conditions

- Immediate local visual state cannot be separated from persisted/audio state without changing public effect contracts.
- Browser engine ownership is not observable at the effects controller boundary.
- Profiling shows the audio callback, rather than renderer work, is the dominant stall after frame coalescing.
- A fix requires reducing audio processing quality or changing persisted EQ data.

## Maintenance notes

Keep three rates distinct: audio-block parameter delivery, display-frame visualization, and debounced persistence. Future effects with interactive graphs should reuse this separation rather than tying pointer, rendering, persistence, and backend graph synchronization together.
