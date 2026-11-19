# 11. Built-in device control performance

Read-only source audit, 2026-10-31. Only this report was written. No tests, builds, app launch, native commands, or subagents were run. The checkout had substantial unrelated in-progress work; this report describes the source read during this audit. Line references are to that checkout.

## 0. Measured results (2026-10-31)

Source: `acceptance-reports/device-control-cost-2026-10-31/` (`README.md` and `results.json`).
- Part A drives the real EffectsPanel in Chromium. Part B drives the real `useTimelinePlayback` hook over a fake native host.
- Reproduce: `bun tools/acceptance/device-control-cost.ts`, about 8 minutes. Two runs produced byte-identical output, SHA-256 `86996808…`.

The measurements supersede the matrix in section 2.

| Finding | Verdict | Measured |
|---|---|---|
| DP-07 | **CONFIRMED, highest impact** | One processor-only Delay `dryWet` edit costs one schedule compile, prepare, publish and window while playing. While paused with a native preview, it causes one preview disposal: a host stop plus teardown, reason `paused-preview-structural-change`. 20 edits cost 20 of each. A new object identity with the same content costs 0. The live-processor state-patch path alone costs 0. Preview drafts enter the projection (`create-effects-panel-audio-effects-state.ts:902-918`), and every preview writes a draft (`:1258`), so this applies during drags, not only on commit. |
| DP-02 | CONFIRMED | 20 wheel ticks on a Compressor knob: 20 writes, 20 history entries, 60 legacy submits. A drag of the same knob: 1 write and 1 history entry. |
| DP-03 | CONFIRMED | Writes and history entries per 20-move drag: Delay filter graph 20/20, Reverb filter 13/13, Reverb space 12/12. This holds on native as well. The EQ band dot gives 1/1. |
| DP-04 | CONFIRMED | Synth drag, wheel or key: 42 engine applies for 20 inputs, with up to 100 dispatches in one frame when the inputs arrive together. Persistence is debounced to 1/1 for Synth; the Arpeggiator wheel gives 3 writes. |
| DP-05 | CONFIRMED | EQ spectrum decay: 206 rAF callbacks in 240 frames, the same whether the device is expanded or folded. |
| DP-01 | PARTIAL | A 20-move knob drag gives 23 whole-chain submits on legacy. **0 node constructions** were seen during edits, so retained nodes are updated in place. Native gives 0 legacy submits. |
| DP-06 | PARTIAL | Not profiled. Chain submits dominate. |

## 1. Summary (original source audit)

1. **Medium (corrected by parent review, see DP-01):** each effect preview on the browser/legacy engine resubmits the whole target chain (`src/components/timeline/create-effects-panel-audio-effects-state.ts:1161-1166`). The engine diffs by instance and updates retained nodes in place, so it does not reconstruct nodes. The cost is a whole-chain walk per frame, `JSON.stringify` of every instance's params, resource snapshots, and latency and auxiliary-route republishing. Gestures coalesce to one dispatch per animation frame (`:1177-1192`).
2. **High, undo and persistence pressure:** effect knob wheel and double-click reset do not open an interaction. They use `setVisualValue` (`src/hooks/useSteppedValueControl.ts:49-55,196-200`) and take the immediate update path, which applies to the engine, persists, and commits history for every changed value (`src/components/timeline/create-effects-panel-audio-effects-state.ts:1081-1121`). The same class of issue applies to Delay/Reverb graph handles and Delay graph keyboard edits, which call `onChange` directly.
3. **Medium, granular control updates:** Synth and other instrument controls update persisted state without a frame-coalesced gesture. Engine application and preview callbacks run for every changed state (`src/components/timeline/create-persisted-effect-state.ts:319-334`); persistence is debounced by 200 ms for instrument state (`src/components/timeline/create-effects-panel-state.ts:309-352`). The exact history/write counts for every instrument control and asynchronous sampled-instrument update are not established by tests read here.
4. **Medium, idle UI work:** EQ spectrum decay deliberately schedules RAF until the spectrum is silent (`src/components/effects/Eq.tsx:173-195`). The EQ stays mounted when collapsed because the device shell hides its content rather than unmounting it (`src/components/effects/EffectShell.tsx:211-220`); no collapsed/offscreen gate was found in the decay loop.
5. **Medium, redundant graph searches:** EQ walks its band list on every pointer move to find the active band (`src/components/effects/Eq.tsx:525-528`), and its parent maps the complete band list on every update (`src/components/timeline/EffectsPanel.tsx:645`). This is bounded by the small fixed EQ band count, so not an observed project-scale hot-path problem.

The declared built-in effect kinds are: `utility`, `eq`, `autofilter`, `gate`, `compressor`, `saturator`, `lofi`, `limiter`, `chorus`, `flanger`, `phaser`, `tremolo`, `autopan`, `ensemble`, `delay`, `reverb`, and `spectral` (`packages/shared/src/effects-params.ts:1010`). Instrument rows also include `synth`, `drum-rack`, `sampler`, `granular`, and the arpeggiator (`src/components/timeline/create-effects-panel-state.ts:78-145`).

## 2. Device × input-path matrix

Cells use the requested labels. For effect rows, **REBUILD** means a browser/legacy chain rebuild occurs on each dispatched preview/value; native playback can instead use parameter/state patches where the mapper accepts the edit. **PER-TICK** means an immediate effect edit persists and adds history per value, even if a native update is supported. Instrument controls are marked **UNCONFIRMED** where engine apply is observed per update but the requested per-input persistence/history/message behavior was not proven. “Automation lane” means edits to automation data, not playback evaluation.

| Device | Engine (browser / native) | Pointer drag | XY / graph | Wheel | Keys | Double-click / reset | Typed number | Select / toggle | Automation lane |
|---|---|---|---|---|---|---|---|---|---|
| Utility | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| EQ | Browser rebuild / native parameter patch when mapped | REBUILD | REBUILD | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Auto Filter | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Gate | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Compressor | Browser rebuild / native parameter patch when mapped | REBUILD | N/A (graph is meter display) | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Saturator | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Lo-Fi | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Limiter | Browser rebuild / native parameter patch when mapped | REBUILD | N/A (meter display) | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Chorus | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Flanger | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Phaser | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Tremolo | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Auto Pan | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Ensemble | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Delay | Browser rebuild / native parameter patch when mapped | REBUILD | REBUILD | PER-TICK | PER-TICK | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Reverb | Browser rebuild / native parameter patch when mapped | REBUILD | REBUILD | PER-TICK | PER-TICK | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Spectral | Browser rebuild / native parameter patch when mapped | REBUILD | N/A | PER-TICK | REBUILD | PER-TICK | N/A | PER-TICK | UNCONFIRMED |
| Synth | Browser/native instrument apply per state update; native mapping is limited | UNCONFIRMED | N/A | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | N/A | UNCONFIRMED | UNCONFIRMED |
| Drum Rack | Browser/native sampled-instrument apply; exact input cost unconfirmed | UNCONFIRMED | N/A | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED |
| Sampler | Browser/native sampled-instrument apply; exact input cost unconfirmed | UNCONFIRMED | N/A | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED |
| Granular | Browser/native sampled-instrument apply; exact input cost unconfirmed | UNCONFIRMED | N/A | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED |
| Arpeggiator | Browser engine apply; native prepared-graph update not established | UNCONFIRMED | N/A | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED | N/A | UNCONFIRMED | UNCONFIRMED |

**Matrix totals (176 input-path cells):** OK 0, PER-TICK 53, REBUILD 35, UNCONFIRMED 50, N/A 38. “PER-TICK” on discrete buttons/selects means each user change is an immediate persisted/history operation, not repeated events from a held gesture.

## 3. Findings

### DP-01 — Legacy effect previews resubmit the whole chain

- **Parent review correction (2026-10-31):** the claim below that each preview reconstructs effect resources is wrong for retained instances.
  - `applyTrackFxInstances` skips unchanged instances with a `JSON.stringify` comparison (`packages/audio-engine/src/live-mixer-runtime.ts:531-537,564`).
  - It updates the retained nodes of each kind in place:
    - EQ nodes when the topology is the same (`:565-575`);
    - static worklets (`:576-584`);
    - compressor, saturator, delay and reverb, through `state.set` (`:585-617`).
  - It constructs a node only when the instance is new or its kind changed (`:618+`). A routing rebuild happens only when the list changes (`:552-553`) or when a `state.set` reports `requiresRoutingRebuild`.
  - **Remaining cost per frame:**
    - a whole-target `buildRuntimeInstancesForTarget`;
    - stringifying the params of every instance on the target twice;
    - two resource snapshots;
    - `publishGraphLatency` and `applyAuxiliaryRoutes`.
  - **Unconfirmed:** which `state.set` parameters report `requiresRoutingRebuild`, and whether in-place sets ramp or step (zipper noise). Matrix cells marked REBUILD should be read as "whole-chain resubmit" until this is measured.
- **Severity:** Medium (was High)
- **Affected devices and paths:** all 17 effects, knob/strip pointer drags and held-key knob edits; EQ graph drag. Browser/legacy engine only. Native uses mapped live parameter messages where supported, otherwise its state-patch/rebuild fallback.
- **Evidence:** `src/components/timeline/create-effects-panel-audio-effects-state.ts:1159-1175` explicitly calls `setMasterFxInstances`/`setTrackFxInstances` for the legacy engine even when `terminal` is false. `:1177-1192` coalesces pending interaction previews by instance key to one RAF dispatch. `src/components/timeline/EffectsPanel.tsx:594-598` opens/commits the effect gesture; `src/components/ui/knob.tsx:109-119` routes Knob gesture lifecycle to the provider. The legacy engine's `setTrackFxInstances` normalizes and applies a replacement list (`packages/audio-engine/src/live-mixer-runtime.ts:736-748`).
- **Why it hurts:** a smooth drag still reconstructs effect resources every display frame. Besides CPU and allocation churn, rebuilding filters/delays/reverbs during playback risks audible discontinuity; the transition helper can ramp crossfade levels, but does not make per-frame reconstruction free (`packages/audio-engine/src/effects/chain.ts:136-139`).
- **Minimal fix direction:** route legacy preview values through the same parameter-preview mechanism as native mapped controls, using AudioParam automation or processor-specific live setters. Keep the existing gesture begin/commit/cancel, final persistence, and history behavior.
- **Proof:** a browser E2E drag held across 20+ pointer moves should assert one final persistence write/history entry, no more than one live parameter application per animation frame, zero effect-chain constructions during previews, and expected final audio value. Compare audio continuity against a stationary control.
- **Test evidence:** source interaction tests cover preview/flush/commit ordering (`src/components/timeline/create-effects-panel-audio-effects-state.test.ts:359-429`), but I found no test asserting zero legacy chain rebuilds during a drag.

### DP-02 — Wheel and reset edits bypass effect gestures

- **Severity:** High
- **Affected devices and paths:** all effect Knobs, Delay value strips; wheel and double-click reset. All immediate effect toggles/selects and header reset are also one-shot immediate commits rather than preview gestures.
- **Evidence:** `src/hooks/useSteppedValueControl.ts:49-55` makes `setVisualValue` emit without `onInteractionStart`; wheel calls it directly at `:196-200`. Knob's double-click uses that method (`src/components/ui/knob.tsx:190-194`); Delay strip does too (`src/components/effects/Delay.tsx:89-91,105-109`). Effect changes outside an active interaction take the direct branch at `src/components/timeline/create-effects-panel-audio-effects-state.ts:1081-1121`, where engine apply happens at `:1097-1105`, persistence at `:1107-1116`, and history commit at `:1117-1119`. In the legacy engine, each immediate value rebuilds the chain through `sendInteraction` (`:1161-1166`).
- **Why it hurts:** a 20-event wheel burst can queue 20 persistence writes and history entries and rebuild 20 chains. Native mapped support reduces audio engine cost but does not remove the per-value persistence/history work.
- **Minimal fix direction:** open and close the existing parameter interaction for wheel bursts and reset actions; retain the existing preview coalescing and one commit/persist/history operation. For discrete toggles/selects, keep a single direct commit.
- **Proof:** a browser E2E 20-tick wheel gesture plus double-click should count one gesture-level commit, one persistence write and one history entry, with previews no greater than one per frame. Add an engine call counter for browser chain rebuilds and native parameter/state-patch messages.
- **Test evidence:** existing unit coverage exercises gesture ordering, but the cited test skips unless its browser child is active (`src/components/timeline/create-effects-panel-audio-effects-state.test.ts:359-429`). No wheel/reset persistence/history counter test was found.

### DP-03 — Several graph handles update directly on every pointer/key event

- **Severity:** High
- **Affected devices and paths:** Delay filter graph pointer drag and keyboard arrows/PageUp/PageDown/Home/End; Reverb filter and space graph pointer drags and graph keyboard controls. Browser rebuilds for each event; native mapped fields can use state patches, otherwise fallback.
- **Evidence:** Delay graph handles call `onLowCutChange`/`onHighCutChange` directly (`src/components/effects/Delay.tsx:124-143,157-173`), and those paths end in `props.onChange` (`:184-198`). Reverb handles call `onLowCutChange`, `onHighCutChange`, and `onSpaceChange` directly (`src/components/effects/Reverb.tsx:167-169,197-250`). Shared `DraggableDeviceGraph` invokes `onDrag` on pointerdown and every pointermove without gesture start/end callbacks (`src/components/effects/draggable-device-graph.tsx:67-76,116-127`). The effect provider only wraps the effect card and is consumed by controls that explicitly use it (`src/components/timeline/EffectsPanel.tsx:594-598`); these graph handlers don't.
- **Why it hurts:** pointer movement and keyboard repeat each take the immediate persistence/history route; browser mode rebuilds the effect chain for each event. Reverb space handles can change two parameters on one event, further increasing work.
- **Minimal fix direction:** add the graph handles to the existing effect parameter interaction lifecycle. Coalesce preview updates by instance/frame and commit once on pointerup/key release, preserving Escape/pointercancel rollback.
- **Proof:** E2E drag and held-key tests for each graph should count frame-bounded engine previews, one write/history entry per gesture, and cancel restoration. For browser audio, assert chain construction only at initialization/terminal commit, not per move.
- **Test evidence:** no source test found covering Delay/Reverb graph persistence counts or cancel behavior. EQ already has a begin/preview/commit/cancel graph path (`src/components/effects/Eq.tsx:476-503,525-543`).

### DP-04 — Instrument edits are not frame-coalesced

- **Severity:** Medium
- **Affected devices and paths:** Synth Knob pointer/wheel/key changes; Drum Rack pad knobs and choke-group select; Sampler/Granular number/select/checkbox controls; Arpeggiator knob/toggle/select.
- **Evidence:** `SynthKnob` forwards value changes to `Knob` but does not pass `onInteractionStart`/`onInteractionEnd` (`src/components/effects/Synth.tsx:147-175`); the instrument panel's update callback writes state (`src/components/timeline/EffectsPanel.tsx:362-383`). Sampler and Granular inputs call `onUpdate`/`onUpdateZone` on change (`src/components/effects/Sampler.tsx:50-71`; `Granular.tsx:42-52`). Arpeggiator controls call `onChange` without a gesture (`src/components/effects/Arpeggiator.tsx:52-125`). Every instrument state update starts `applyToEngine` and `onParamsApplied` in `src/components/timeline/create-persisted-effect-state.ts:319-334`; persistence is debounced by 200 ms for instrument state (`src/components/timeline/create-effects-panel-state.ts:309-352`).
- **Why it hurts:** high-rate pointer/wheel/key changes cause serialized engine applies and preview notifications more often than a display frame. Typed number entry can also apply partially entered intermediate values. Persistence has a debounce, but no equivalent input-frame coalescing was found.
- **Minimal fix direction:** connect continuous instrument controls to a gesture-scoped draft/preview path that coalesces engine updates per frame and persists/records once on settle. Keep text inputs and selectors as deliberate discrete commits, or defer their engine apply until valid input is committed.
- **Proof:** E2E tests should exercise 20 pointer/wheel changes and multi-character typed entry, count engine/native messages, local/Convex writes and history entries, and assert latest value wins without sample-buffer reloads for unrelated parameter edits.
- **Test evidence:** I found no per-input instrument write/history/message counter test. Instrument state uses a debounce, but whether every instrument kind's history callback collapses multiple edits was not established by this read-only audit.

### DP-05 — EQ spectrum decay can animate while the device is hidden

- **Severity:** Low
- **Affected devices and paths:** EQ meter/spectrum; collapsed or offscreen panel, after playback/analyser frames have stopped.
- **Evidence:** `src/components/effects/Eq.tsx:173-195` reschedules RAF while spectrum remains audible and explains the loop as decay after transport pause. `EffectShell.tsx:211-220` retains children and uses `hidden={collapsed()}` rather than unmounting. The decay loop has no visibility/collapsed check in the read range.
- **Why it hurts:** a collapsed/offscreen EQ can keep updating a signal and scheduling paint work until the displayed spectrum decays.
- **Minimal fix direction:** reuse the existing `scheduleDraw` cancellation and device visibility state to stop decay while hidden/offscreen, then draw the correct decayed state when shown again. Avoid adding a timer/polling loop.
- **Proof:** browser test with a synthetic nonzero spectrum, collapse the EQ, and assert no subsequent decay RAF/state updates while hidden; unfold and verify the display catches up or resumes decay.
- **Test evidence:** no visibility/collapse decay test found.

### DP-06 — EQ graph does small repeated scans

- **Severity:** Low
- **Affected devices and paths:** EQ graph pointer drag.
- **Evidence:** `applyBandPointerValue` linearly finds the band for each pointer event (`src/components/effects/Eq.tsx:525-528`); parent update maps the bands array (`src/components/timeline/EffectsPanel.tsx:645`).
- **Why it hurts:** repeated scans and array allocation per move are unnecessary, though EQ has a small fixed band set, so this is not a demonstrated quadratic or project-size bottleneck.
- **Minimal fix direction:** only optimize if profiling shows measurable cost; a memoized band index may be used, but preserve immutable updates and existing interaction semantics.
- **Proof:** measure CPU/allocation counts while dragging with the maximum supported number of bands; no correctness-only test is needed unless the update structure changes.
- **Test evidence:** no hot-path allocation measurement found.

### DP-07 — Effect parameter fingerprinting serializes broad project state

- **Severity:** Medium
- **Affected devices and paths:** parameter changes that update track/effect state while native playback is paused or playing.
- **Evidence:** `src/hooks/useTimelinePlayback.ts:1940-1957` JSON-stringifies all tracks and clips in a native preview fingerprint; `:1970-1972` nests that fingerprint in a desired schedule fingerprint; the reactive effect recomputes it at `:2035-2042`. During playback, changed fingerprints may request a schedule update at `:2045-2050`; paused-preview fingerprint changes are separately handled at `:2052-2057`.
- **Parent review addition (2026-10-31):** the desired schedule fingerprint includes `readPlaybackInputsIdentity()` (`:1962-1972`).
  - Its input is `nativePlaybackInputs` (`src/components/Timeline.tsx:435-442`), which holds:
    - the whole canonical view;
    - the local snapshot;
    - `effectsExportSnapshot()?.snapshotEffectsProjection()`;
    - automation patches and sidechains.
  - Every effect-parameter change that reaches the effects projection therefore runs a `replaceEqualDeep` over the whole canonical view, and advances the identity.
  - While native playback runs, an advanced identity calls `requestTimelineSchedule` (`:2046-2049`).
  - While paused with a native preview, it can call `disposeNativePreview(…, "paused-preview-structural-change")` (`:2052-2057`).
  - **Unconfirmed, highest priority:**
    - whether a processor-only edit really reaches either branch, which depends on whether drafts enter the projection and on dedupe inside the schedule owner;
    - how many schedule compiles and preview disposals one edit causes.
  - Measure this before AE-08 B5b; it touches AE-08-owned code.
- **Why it hurts:** every dependency-triggered pass maps and serializes full track/clip state, rather than checking only relevant structural/schedule inputs. Parameter edits may therefore incur whole-project traversal and stringify work, though actual preview disposal is gated by state and is not asserted here.
- **Minimal fix direction:** maintain a narrow structural/schedule revision or compare explicit relevant fields using existing playback lifecycle signals. Do not add a second general-purpose fingerprint or mutation mechanism.
- **Proof:** performance test with many tracks/clips and repeated single-parameter edits, count serialized bytes/visits and verify unchanged topology does not trigger schedule compilation or preview disposal.
- **Test evidence:** no fingerprint-cost or “parameter-only edit avoids full-project scan” test found.

## 4. Confirmed-good list

- Knob pointer gestures and Delay value-strip pointer gestures begin, commit, and cancel via the shared effect interaction provider (`src/components/ui/knob.tsx:109-119`; `src/components/effects/Delay.tsx:68-79`; `src/components/timeline/EffectsPanel.tsx:594-598`).
- Effect interaction previews coalesce to the latest queued callback per instance to at most one dispatch per RAF; commit flushes a pending frame before terminal work (`src/components/timeline/create-effects-panel-audio-effects-state.ts:1177-1205,1305-1308`). This bounds dispatch frequency, but does not prevent legacy chain rebuilds (DP-01).
- Effect gesture commit takes the last interaction value, writes parameters once, then commits the undo-history payload once (`src/components/timeline/create-effects-panel-audio-effects-state.ts:1313-1327`; persistence completion is in `:1330-1357`).
- Knob keyboard arrows, PageUp/PageDown, Home/End begin a held-key interaction on first keydown and commit on keyup/blur/disabled; repeats use the same interaction (`src/hooks/useSteppedValueControl.ts:56-80,135-195`). The browser engine still takes the costly preview route from DP-01.
- EQ canvas drag begins once, sends previews during drag, and commits/cancels on end (`src/components/effects/Eq.tsx:476-503,525-543`). EQ selected-band knobs also have their own interaction callbacks (`:579-605`).
- Compressor and Limiter graphs are read-only displays, not parameter handles (`src/components/effects/Compressor.tsx:90-113,149-166`; `src/components/effects/Limiter.tsx:43-48`).
- Native built-in parameter mapping exists for supported values; e.g. mapper fields for utility and Auto Filter (`src/lib/desktop/native-built-in-parameter-mapper.ts:180-224`). The mapper also rejects some synth edits when non-live state differs (`:150-178`).
- Instrument parameter persistence is debounced for 200 ms (`src/components/timeline/create-effects-panel-state.ts:147,309-352`), unlike effect immediate edits. It does not itself coalesce engine applies.
- Preset-step UI was not found in the EffectsPanel source read, and effect chain reordering is previewed as UI state and applied after drop (`src/components/timeline/EffectsPanel.tsx:782-790`). Reorder frame/persistence behavior was not exhaustively verified, so it is not counted as a matrix input path.

## 5. Open questions

- Does `createPersistedEffectState` produce exactly one history entry for a burst of instrument updates that settles within the 200 ms debounce, and how does that differ between local and shared projects?
- Which synth, arpeggiator, sampler, Drum Rack, and granular fields map to live native parameter messages versus state patches, schedule publication, or graph rebuild? The effect mapper's synth mapper covers only its listed live fields (`src/lib/desktop/native-built-in-parameter-mapper.ts:150-178`); all native branches were not traced for every instrument path.
- Are instrument parameter updates that alter sampled-instrument preparation coalesced/superseded before decoding or native paging? Establish per-kind engine and IPC counts before assigning precise instrument matrix statuses.
- Does the effect preset-step feature exist in another panel/component, and does it batch changes into one persistence/history operation?
- Do local/shared automation-lane edits for built-in effect/instrument parameters publish one envelope mutation per point move or use a draft/commit gesture? This report marks those cells UNCONFIRMED because automation lane writes do not necessarily route through the device-control callbacks.
- Which effects use `AudioParam` ramps for live browser parameter edits? The inspected effect route replaces runtime instances rather than showing per-parameter ramps. The 10 ms gain ramp in `packages/audio-engine/src/audio-param-ramp.ts` applies to mixer gain/routing, not proof of built-in effect smoothing. Click/zipper-noise behavior needs audio-output measurement.
- Are Compressor, Limiter, Gate meters suspended while their device cards are collapsed/offscreen or the transport is stopped? Their components subscribe while mounted (`src/components/effects/Compressor.tsx:120-138`; `Limiter.tsx:23-32`; `Gate.tsx:32`); the exact analyser publication lifecycle was not followed through the audio engine.
- Does the whole EffectsPanel re-evaluate or rebuild stable card children for each draft parameter update? The card list uses `For` and memoized per-key lookup (`src/components/timeline/EffectsPanel.tsx:693-720`), but no component profiling or Solid graph instrumentation was run.
- Cell counts reflect the source behavior verified here, not runtime counters. **UNCONFIRMED cells must remain unconfirmed until narrow browser/native message and persistence instrumentation proves the path.**

## Commands run

- `df -h /` — reported 34 GiB free, above the 30 GB stop threshold.
```sh
python3 -c 'from pathlib import Path; from collections import Counter; lines=Path("/Users/juan/Documents/daw-browser-convex/implementation-trackers/experience-audit/11-device-control-performance.md").read_text().splitlines(); table=[x for x in lines if x.startswith("|") and not x.startswith("|---")]; rows=table[1:]; c=Counter();
for line in rows:
 for x in [v.strip() for v in line.strip("|").split("|")][2:]: c["N/A" if x.startswith("N/A") else x]+=1
print("device rows",len(rows),"input cells",sum(c.values()),dict(c))'
```
- `git -C /Users/juan/Documents/daw-browser-convex status --short -- implementation-trackers/experience-audit/11-device-control-performance.md`
- `git -C /Users/juan/Documents/daw-browser-convex diff --check -- implementation-trackers/experience-audit/11-device-control-performance.md`
- Read-only file reads and searches were performed through the repository file/search tools. No tests were run.
