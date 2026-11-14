# Area 3: Devices, effects, instruments, mixer, MIDI editing

## Summary

The shared `Knob` and mixer slider already provide keyboard access, reset, fine drag, pointer cancellation, and value text. EQ and Utility also have an explicit preview/commit path. The clearest gaps are that most device knobs use the immediate-update path, Delay's frequency value strips are a less capable slider variant, MIDI notes have no visible velocity/keyboard editing affordance, and effect-value formatters are repeated with inconsistent output.

## Findings

### DV-01 — High: Most device-knob drags rebuild and persist the full effect chain per change

- **Category:** B
- **Evidence:** `src/components/timeline/create-effects-panel-audio-effects-state.ts:1148-1164`
  > `const updateInstance = ...`
  > `applyInstancesToEngine(targetId, currentOrderForTarget(targetId))`
  > `persistInstanceParams(targetId, persistedInstanceId, kind, next)`
- **User experience:** Each emitted knob value on this path invokes a full target-chain engine update and starts a persistence write. A quick drag can therefore trigger repeated graph work and local/cloud writes instead of one preview stream and one commit.
- **Minimal fix sketch:** Route continuous controls through the existing `beginParameterInteraction` / `previewParameterInteraction` / `commitParameterInteraction` pattern used by EQ and Utility. Keep the existing `dispatchInteractionPreview` frame coalescing for engine previews, and persist/record history on commit.
- **Size:** M
- **Risk:** medium
- **Verify:** In a browser, drag a built-in effect knob while observing engine update and persistence calls; confirm previews are at most once per frame and one final commit/write occurs.

### DV-02 — Medium: Delay frequency value strips omit the knob's reset and wheel interactions

- **Category:** A
- **Evidence:** `src/components/effects/Delay.tsx:66-80,83-98`
  > `const control = useSteppedValueControl(...)`
  > `onPointerDown={control.onPointerDown}`
  > `onKeyDown={control.handleKeyDown}`
- **User experience:** These frequency strips support drag and keyboard changes, but unlike `Knob` they do not connect `control.handleWheel` or a double-click reset. The same device's knob controls do support both via `src/components/ui/knob.tsx:225-233`.
- **Minimal fix sketch:** Reuse the interaction contract from `Knob`: wire wheel changes and provide the same reset-value/double-click behavior for `DelayValueStrip`, or use `Knob` where its existing value strip presentation is not needed.
- **Size:** S
- **Risk:** low
- **Verify:** In a browser, hover a Delay frequency strip and use wheel, double-click, and keyboard; confirm the supported input methods have consistent value/reset results.

### DV-03 — Medium: MIDI notes are pointer-only, with no velocity editing surface

- **Category:** A
- **Evidence:** `src/components/midi/MidiEditorCard.tsx:631-653`
  > `<div ...>` note element
  > `onPointerDown={...}`
  > `onDblClick={...}`
- **User experience:** Notes can be inserted, dragged, resized, and deleted, but the rendered note has no focusability or keyboard handler and the editor renders no velocity lane/control. Users cannot select/edit velocity or manipulate notes without a pointer.
- **Minimal fix sketch:** Build on the existing `MidiEditorNote` `velocity` update operation in `src/lib/midi/editor-persistence.ts:17-20`; add a keyboard-accessible note selection/edit path and a compact velocity editor that commits through `persistence.saveSoon`.
- **Size:** M
- **Risk:** medium
- **Verify:** Browser E2E: create/select a note, adjust its velocity and pitch/length by keyboard, reload the clip, and confirm the values persist.

### DV-04 — Medium: Device value formatting is duplicated and already diverges

- **Category:** C
- **Evidence:** `src/components/effects/Delay.tsx:38-40`; `src/components/effects/Saturator.tsx:37-39`; `src/components/effects/Reverb.tsx:63-64`
  > `...toFixed(1)} kHz`
  > `...toFixed(1)} kHz`
  > `...toFixed(1)}k Hz`
- **User experience / maintenance cost:** Frequency, percentage, dB, and time labels are formatted independently across effect components. For example, Reverb emits `k Hz` while Delay and Saturator emit `kHz`; precision and rounding rules also differ by effect.
- **Minimal fix sketch:** Reuse the existing parameter metadata/contracts where available and consolidate the repeated unit-formatting rules in one shared formatter, keeping effect-specific precision explicit at the call site.
- **Size:** S
- **Risk:** low
- **Verify:** Browser E2E or a focused formatter check across values below/at/above 1 kHz and representative dB/ms/percent values; verify labels remain accurate and consistent.

### DV-05 — Low: Reorder hit-test geometry is frozen when the drag activates

- **Category:** A
- **Evidence:** `src/components/timeline/create-effect-card-reorder-drag.ts:95-109,115-124`
  > `const rect = element.getBoundingClientRect()`
  > `cardRects.push(...)`
  > `updatePreview(position)`
- **User experience:** Card positions are measured once at drag activation and reused for all later pointer moves. If the chain scrolls or its layout changes mid-drag, the insertion indicator and drop index can refer to the old card positions.
- **Minimal fix sketch:** Refresh card geometry from the current chain on pointer movement when scroll/layout changes, or cancel the active reorder when its measured container geometry becomes invalid. Keep `targetIndexForPoint` as the single hit-test rule.
- **Size:** S
- **Risk:** low
- **Verify:** Browser E2E: begin a reorder drag, scroll the chain or change its geometry, then drop; verify the preview indicator and final order match the current visible card positions.

## Looked at and fine

- `src/components/ui/knob.tsx` delegates to `useSteppedValueControl`, which implements Shift fine adjustment, double-click reset, wheel and keyboard changes, and accessible slider values. `src/hooks/useSteppedValueControl.ts` handles pointer-drag lifecycle through `useDrag`.
- `src/components/timeline/MixerVolumeSlider.tsx` provides pointer capture/cancel/lost-capture handling, keyboard input, double-click reset, and dB value text.
- `src/components/midi/MidiEditorCard.tsx` explicitly cleans up note-drag listeners on pointer cancellation, lost capture, blur, Escape, and unmount. MIDI writes use `persistence.saveSoon`, and save errors expose retry/dismiss UI.
- Device cards share `EffectShell`; chain reordering uses the existing `createEffectCardReorderDrag` helper. EQ graph drawing coalesces draw requests with `requestAnimationFrame` and cancels pending frames on cleanup.
- VST parameter queueing and feedback paths have bounded/coalesced delivery (`src/lib/desktop/native-vst-parameter-queue.ts` and `src/lib/desktop/vst-parameter-feedback-controller.ts`). No user-visible scan/trust failure issue was established from the inspected insertion messages.
- Searched scoped exports/usages and the workspace audio-engine package for dead-code candidates and duplicated effect definitions. No unused export/file or duplicate effect-definition finding was confirmed, so none is reported.
