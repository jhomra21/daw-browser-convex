# Audio Metering and EQ Spectrum Validation Tracker

## Scope

Investigate and fix two related visual feedback gaps:

- The EQ device shows no live spectrum when no project audio has played yet.
- Live MIDI keyboard playback while transport is stopped does not visibly drive the target track meter in the right sidebar or the selected track spectrum in the effects panel.

This tracker was executed on the `audio-metering-refactor` branch.

## Execution Status

- [x] Validated tracker assumptions against the current source.
- [x] Exposed live MIDI visual activity from existing active keyboard rows.
- [x] Threaded transport-independent visualization activity through `Timeline`.
- [x] Renamed sidebar meter activation from `isPlaying` to `meteringActive`.
- [x] Renamed effects spectrum activation from `isPlaying` to `spectrumActive`.
- [x] Added a bounded effects-panel spectrum sampling clock for stopped-transport live MIDI.
- [x] Preserved existing audio routing and mixer graph behavior without speculative routing refreshes.
- [x] Ran final validators.

Corrected implementation note: Phase 5 was required by code inspection because `useEffectsPanelAudioSync` only re-sampled from reactive dependency changes; stopped-transport held notes do not advance `playheadSec`, so the effects panel needs a scoped RAF sampler while open and spectrum-active.

## Evidence from Current Code

### Effects panel spectrum is gated by transport playback

`src/hooks/useEffectsPanelAudioSync.ts` only samples analyser data when both the effects panel is open and `isPlaying()` is true:

```ts
createEffect(() => {
  if (!options.isOpen() || !options.isPlaying()) {
    setSpectrum(null);
    return;
  }
  options.playheadSec?.();
  const id = options.currentTargetId();
  const data = id === "master"
    ? audioEngine.getMasterSpectrum()
    : audioEngine.getTrackSpectrum(id);
  setSpectrum(data ?? null);
});
```

That means live MIDI preview while transport is stopped cannot update `Eq.spectrumData`, even if the audio graph is producing sound.

### Track sidebar meters are gated by transport playback

`src/components/timeline/TrackSidebar.tsx` subscribes and renders meters only while `sidebar().isPlaying` is true:

```ts
createEffect(() => {
  if (!sidebar().isPlaying) {
    setMeters(produce((current) => {
      for (const trackId of Object.keys(current)) delete current[trackId];
    }));
    return;
  }
  const unsubscribe = sidebar().subscribeTrackLevels((levelsByTrackId) => {
    setMeters(produce((current) => {
      for (const [trackId, levels] of levelsByTrackId) {
        current[trackId] = {
          left: clampUnit(levels.left),
          right: clampUnit(levels.right),
        };
      }
    }));
  });
  onCleanup(unsubscribe);
});
```

The meter JSX also ignores stored meter values while stopped:

```ts
const meter = sidebar().isPlaying
  ? meters[track.id]
  : undefined;
```

### MIDI keyboard audio is routed into the track graph

`src/hooks/useTimelineMidiOverlay.ts` starts live MIDI notes through `audioEngine.getTrackSynthGainNode(trackId)` or `audioEngine.previewDrumRackNote(trackId, pitch, velocity)`.

The audio-engine path proves that this routes into the track input:

```ts
// packages/audio-engine/src/synth-runtime.ts
const ensureTrackSynthGainNode = (trackId: string): GainNode => {
  options.ensureAudio();
  const trackInput = options.ensureTrackInput(trackId);
  const ctx = options.getAudioContext();
  if (!ctx) return trackInput;
  let node = gainNodes.get(trackId);
  if (!node) {
    node = ctx.createGain();
    node.connect(trackInput);
    gainNodes.set(trackId, node);
  }
  return node;
};
```

Drum Rack preview also uses `options.ensureTrackInput(trackId)` in `packages/audio-engine/src/drum-rack-runtime.ts`.

### Mixer outputs and meters are attached by the mixer graph

`packages/audio-engine/src/live-mixer-runtime.ts` creates track `input`, `gain`, and `output` nodes, then `updateTrackGains(tracks)` resolves routing and calls `reconnectTrackMeters`.

```ts
updateTrackGains: (tracks: RuntimeTrack[]) => {
  const ctx = options.getAudioContext();
  const masterInput = options.getMasterInput();
  if (!ctx || !masterInput) return;

  const graph = resolveMixerGraph({ channels: createMixerChannels(tracks) });
  // ...
  applyLiveMixerGraph({
    graph,
    masterInput,
    trackNodes,
    reconnectTrackMeters: (trackId, gain) => {
      if (!activeMeterTrackIds.has(trackId)) {
        options.disposeTrackMeters(trackId);
        return;
      }
      options.reconnectTrackMeters(trackId, gain, () => outputs.get(trackId) === gain);
    },
  });
}
```

`AudioEngine.ensureAudio()` applies cached track gains by default, and `useTimelineAudioLifecycle` also calls `audioEngine.updateTrackGains(input.tracks())` reactively. So the first fix should not add new routing logic unless runtime validation proves a stale graph edge.

### Empty EQ spectrum before audio is expected

`packages/audio-engine/src/metering-runtime.ts` returns `null` before an analyser exists or when the sampled frequency bins are all zero:

```ts
getTrackSpectrum: (ctx, trackId, output) => {
  if (ctx && output) ensureTrackAnalyser(ctx, trackId, output);
  const analyser = analysers.get(trackId);
  if (!analyser) return spectrumLast.get(trackId) ?? null;
  analyser.getByteFrequencyData(tmp);
  let sum = 0;
  for (let i = 0; i < tmp.length; i++) sum += tmp[i];
  if (sum === 0) return spectrumLast.get(trackId) ?? null;
  // build SpectrumFrame...
}
```

`Eq.tsx` already draws the grid, EQ response curve, and nodes without `spectrumData`. It only draws the live spectrum fill if `displayedSpectrum` exists. We should not fake signal energy.

## External Documentation

- MDN `AnalyserNode`: https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode
  - Describes `AnalyserNode` as a Web Audio node that passes audio unchanged while exposing frequency/time-domain analysis.
- MDN `AnalyserNode.getByteFrequencyData()`: https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getByteFrequencyData
  - Copies current frequency data into a `Uint8Array`. A silent or not-yet-fed analyser producing zero bins is expected.
- MDN AudioWorklet guide, current 2026 result: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Using_AudioWorklet
  - AudioWorklet is the right primitive for low-latency audio-thread metering.
- MDN `AudioWorklet`: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
  - Confirms worklets are the modern Web Audio mechanism for custom processing on the audio rendering thread.

## Reference Codebase Notes

### `/Users/juan/Documents/monorepo-new`

`apps/web/src/hooks/use-volume-meter.ts` subscribes meters based on the presence of an audio node, not transport playback state:

```ts
export function useVolumeMeter() {
  const [levels, setLevels] = createSignal<ChannelLevels[]>(ZERO_LEVELS);
  let currentGainNode: GainNode | null = null;
  let teardown: (() => void) | null = null;
  let subscriptionToken = 0;

  const disconnect = () => {
    subscriptionToken++;
    currentGainNode = null;
    teardown?.();
    teardown = null;
    setLevels(ZERO_LEVELS);
  };

  const connect = async (gainNode: GainNode) => {
    if (currentGainNode === gainNode && teardown) return;
    disconnect();
    currentGainNode = gainNode;
    const token = ++subscriptionToken;
    const release = await subscribe(gainNode, handleLevels);
    if (token !== subscriptionToken) {
      release();
      return;
    }
    teardown = release;
  };

  onCleanup(disconnect);
  return { levels, connect, disconnect };
}
```

Useful patterns to copy conceptually:

- Subscribe when there is an active audio source or node, not when a transport flag says playback is running.
- Replay last meter values to new subscribers to avoid a one-frame zero flash.
- Guard async AudioWorklet setup with a token so stale subscriptions are released.
- Disconnect and reset to zero when the visualizer no longer has a source.

The current DAW already has a centralized `createMeteringRuntime`, so we do not need to copy this implementation. The relevant lesson is the activation model.

### `/Users/juan/Documents/dialkit`

No relevant audio metering or analyser code was found. It remains useful for Solid UI ergonomics, but not for this Web Audio issue.

### Public GitHub examples to inspect if implementation needs deeper meter behavior

Search results worth reviewing during implementation:

- `mdn/webaudio-examples`: official MDN Web Audio examples.
- `cwilso/volume-meter`: simple Web Audio volume meter example.
- `esonderegger/web-audio-peak-meter`: customizable Web Audio peak meter.
- `mmckegg/audio-rms`: RMS helper for Web Audio nodes.

These should be used only for validating metering approach, not as dependencies.

## Root Cause

The two observed issues are related by **visualizer activity gating**:

1. Live MIDI audio can exist while the transport is stopped.
2. Both the right-sidebar meter and the EQ spectrum currently use transport `isPlaying` as the signal for whether to subscribe/sample.
3. Therefore live MIDI does not reach visualizers, even when it reaches the audio graph.

The EQ graph itself is not the root problem. Empty spectrum is correct when no analyser data exists. The bug is that live MIDI does not turn on spectrum sampling or sidebar meter rendering.

## Design Goals

- Preserve original MIDI UX and audio routing.
- Do not fake spectrum data.
- Do not duplicate mixer routing logic in UI hooks.
- Keep track meters and EQ spectrum post-FX/post-volume because current code samples `mixerRuntime.getTrackOutput(trackId)`.
- Keep transport playback state separate from visualizer activity.
- Make naming clear so future changes do not confuse “transport is playing” with “audio is currently worth visualizing”.

## Implementation Plan

### Phase 1: Expose live MIDI visual activity

Add a small activity accessor to `useMidiKeyboardInput` and surface it through `useTimelineMidiOverlay`.

Current state already tracks active rows:

```ts
const [activeRows, setActiveRows] = createSignal<Set<number>>(new Set(), { equals: false });
```

Add:

```ts
return {
  octave,
  hasActiveNotes: () => activeRows().size > 0,
  isActive: (pitch: number) => activeRows().has(pitch),
};
```

Then update `UseTimelineMidiOverlayReturn`:

```ts
midiKeyboard: {
  enabled: Accessor<boolean>;
  canPlay: Accessor<boolean>;
  targetLabel: Accessor<string | null>;
  octave: Accessor<number>;
  hasActiveNotes: Accessor<boolean>;
  toggle: () => void;
  isActive: (pitch: number) => boolean;
}
```

And return:

```ts
midiKeyboard: {
  enabled: midiKeyboardEnabled,
  canPlay: midiKeyboardCanPlay,
  targetLabel: midiKeyboardTargetLabel,
  octave: midiKeyboard.octave,
  hasActiveNotes: midiKeyboard.hasActiveNotes,
  toggle: () => setMidiKeyboardEnabled(value => !value),
  isActive: midiKeyboard.isActive,
}
```

Why this shape:

- It is derived from existing pressed-key state, so no duplicate live-note counter is needed.
- It works for held synth notes.
- Drum Rack one-shots triggered from keyboard may have very short active key windows. If that proves visually too short, extend Phase 1 to track “recent MIDI activity” inside the hook with a deterministic timeout. Do not add that until manual validation shows the active-note window is insufficient.

### Phase 2: Define visualizer activity in `Timeline.tsx`

Create a local derived accessor near the existing MIDI overlay setup:

```ts
const audioVisualizationActive = () =>
  isPlaying() || midiKeyboard.hasActiveNotes();
```

Initial recommendation is **held-note activity**, not merely `midiKeyboard.enabled() && midiKeyboard.canPlay()`. This avoids keeping AudioWorklet metering active forever just because MIDI Keys is enabled.

If we want instant first-frame visual readiness before the keydown worklet emits, test this broader variant:

```ts
const audioVisualizationActive = () =>
  isPlaying() || (midiKeyboard.enabled() && midiKeyboard.canPlay());
```

Prefer the narrower `hasActiveNotes` variant unless first-note visual latency is unacceptable.

### Phase 3: Rename sidebar metering props

Change `TrackSidebar` and `TimelineWorkspace` from `isPlaying` to `meteringActive`.

Example type changes:

```ts
// timeline-workspace.tsx
sidebar: {
  meteringActive: boolean;
  subscribeTrackLevels: AudioEngine["subscribeTrackStereoLevels"];
  // ...
};
```

```ts
// TrackSidebar.tsx
type TrackSidebarProps = {
  sidebar: {
    meteringActive: boolean;
    subscribeTrackLevels: (
      listener: (levels: ReadonlyMap<string, TrackStereoLevels>) => void,
    ) => () => void;
    // ...
  };
};
```

Then update subscription and rendering:

```ts
createEffect(() => {
  if (!sidebar().meteringActive) {
    setMeters(produce((current) => {
      for (const trackId of Object.keys(current)) delete current[trackId];
    }));
    return;
  }
  const unsubscribe = sidebar().subscribeTrackLevels((levelsByTrackId) => {
    setMeters(produce((current) => {
      for (const [trackId, levels] of levelsByTrackId) {
        const next = {
          left: clampUnit(levels.left),
          right: clampUnit(levels.right),
        };
        const previous = current[trackId];
        if (previous?.left === next.left && previous.right === next.right) continue;
        current[trackId] = next;
      }
    }));
  });
  onCleanup(unsubscribe);
});
```

```ts
const meter = sidebar().meteringActive
  ? meters[track.id]
  : undefined;
```

Pass it from `Timeline.tsx`:

```ts
sidebar={{
  meteringActive: audioVisualizationActive(),
  subscribeTrackLevels: (listener) => audioEngine.subscribeTrackStereoLevels(listener),
  // ...
}}
```

### Phase 4: Rename effects spectrum activity props

Change `EffectsPanelProps.isPlaying` to `spectrumActive`, then thread that through `createEffectsPanelController` and `useEffectsPanelAudioSync`.

Example:

```ts
type EffectsPanelProps = {
  spectrumActive: boolean;
  playheadSec?: number;
  // ...
};
```

```ts
const controller = createEffectsPanelController({
  // ...
  spectrumActive: () => props.spectrumActive,
  playheadSec: () => props.playheadSec,
});
```

In `useEffectsPanelAudioSync`:

```ts
type UseEffectsPanelAudioSyncOptions = {
  isOpen: Accessor<boolean>;
  spectrumActive: Accessor<boolean>;
  // ...
};

createEffect(() => {
  if (!options.isOpen() || !options.spectrumActive()) {
    setSpectrum(null);
    return;
  }
  options.playheadSec?.();
  try {
    const audioEngine = options.audioEngine();
    const id = options.currentTargetId();
    const data = id === "master"
      ? audioEngine.getMasterSpectrum()
      : audioEngine.getTrackSpectrum(id);
    setSpectrum(data ?? null);
  } catch {
    setSpectrum(null);
  }
});
```

Pass from `Timeline.tsx`:

```ts
effectsPanel: {
  // ...
  spectrumActive: audioVisualizationActive(),
  playheadSec: playheadSec(),
}
```

Keep `playheadSec` read because it currently triggers spectrum sampling during transport movement. For live MIDI while stopped, `audioVisualizationActive()` changes on keydown/keyup, but spectrum may need repeated sampling while a note is held. If the current effect only runs on the first active transition, Phase 5 adds a visual sampling tick.

### Phase 5: Confirm whether spectrum needs a sampling clock while transport is stopped

`useEffectsPanelAudioSync` currently depends on `playheadSec` for repeated sampling during transport playback. When transport is stopped, `playheadSec` does not advance. A held MIDI note may set `spectrumActive` true once, causing only one sample.

If manual validation shows the EQ spectrum does not animate while a MIDI note is held, add a scoped RAF sampler inside `useEffectsPanelAudioSync` that runs only while:

- effects panel is open
- `spectrumActive()` is true
- the current target is valid

Example:

```ts
const sampleSpectrum = () => {
  try {
    const audioEngine = options.audioEngine();
    const id = options.currentTargetId();
    const data = id === "master"
      ? audioEngine.getMasterSpectrum()
      : audioEngine.getTrackSpectrum(id);
    setSpectrum(data ?? null);
  } catch {
    setSpectrum(null);
  }
};

createEffect(() => {
  if (!options.isOpen() || !options.spectrumActive()) {
    setSpectrum(null);
    return;
  }

  let frame = requestAnimationFrame(function tick() {
    sampleSpectrum();
    frame = requestAnimationFrame(tick);
  });

  onCleanup(() => cancelAnimationFrame(frame));
});
```

This is a justified visual-only RAF. It is bounded by panel-open and audio-visualization-active state, and cleaned up deterministically.

Do not add a parallel polling loop outside this hook.

### Phase 6: Validate mixer/analyser wiring before adding routing refreshes

After Phases 1 through 5, manually test whether first-note meters and spectrum work.

If not, instrument this sequence:

1. `useTimelineMidiOverlay.startLiveNote`
2. `audioEngine.ensureAudio()`
3. `audioEngine.getTrackSynthGainNode(trackId)`
4. `mixerRuntime.ensureTrackInput(trackId)`
5. `mixerRuntime.getTrackOutput(trackId)`
6. `metering.reconnectTrackMeters(...)`

Only if evidence shows the mixer graph is stale, add the smallest audio-engine API surface:

```ts
ensureTrackGraph(tracks: RuntimeTrack[]) {
  this.ensureAudio();
  this.updateTrackGains(tracks);
}
```

Then call it in `useTimelineMidiOverlay` before preview/live note:

```ts
options.audioEngine.ensureTrackGraph(options.tracks());
```

This is intentionally deferred. Reusing `updateTrackGains(options.tracks())` avoids duplicating routing logic, but it should not be called on every note if the current lifecycle already keeps the graph current.

## Test Plan

### Unit and component tests

1. `useMidiKeyboardInput.test.ts`
   - Add coverage that `hasActiveNotes()` is false initially, true after a playable keydown, and false after keyup/blur/target change.
   - Assert octave/velocity controls do not set active notes.

2. `TrackSidebar` test, if the repo has component-test precedent available
   - Render with `meteringActive=false`.
   - Assert `subscribeTrackLevels` is not called and meter heights are zero.
   - Flip to `meteringActive=true`.
   - Emit a fake level batch and assert the target meter height updates.
   - Flip back to false and assert unsubscribe was called and meters clear.

3. `useEffectsPanelAudioSync` test
   - Provide a fake `audioEngine.getTrackSpectrum`.
   - Assert no sampling when `isOpen=false`.
   - Assert no sampling when `spectrumActive=false`.
   - Assert sampling occurs when `isOpen=true` and `spectrumActive=true`.
   - If Phase 5 RAF is added, use fake RAF or a small isolated sampler helper to avoid timing flakiness.

4. `metering-runtime` test, optional but useful
   - Keep current `null` on silence behavior explicit.
   - Confirm `getTrackSpectrum` returns `null` when no analyser exists and returns the last non-zero frame after silence if that behavior remains desired.

### Manual validation

1. Fresh reload. Do not press Play.
2. Create or select an instrument track with Synth.
3. Open Effects panel for that track and ensure EQ exists.
4. Enable MIDI Keys.
5. Hold `A`.
6. Expected:
   - Transport remains stopped.
   - Right-sidebar meter for the instrument track moves.
   - EQ live spectrum shows energy for the selected instrument track.
   - MIDI editor keyboard row highlights the held pitch if the editor is open.
7. Release `A`.
8. Expected:
   - Meter returns toward zero.
   - Spectrum decays or clears without freezing at a misleading value.
9. Switch target to another instrument track while holding no notes.
10. Expected:
    - No stale meter or spectrum for the old track.
11. Test Drum Rack:
    - Assign a sample to C2.
    - Enable MIDI Keys.
    - Trigger the mapped key while stopped.
    - Expected sidebar meter moves for the Drum Rack track. Spectrum may be brief for short one-shots.
12. Press Play with audio clips.
13. Expected:
    - Existing transport playback meters and EQ spectrum still work.

### Validation commands

Run after implementation:

```bash
bun run typecheck
bun test
bun run knip
bun run build
```

Also run:

```bash
git diff --check
```

## Risk Assessment

- Low risk if limited to renaming `isPlaying` visualizer props and adding derived `audioVisualizationActive`.
- Medium risk if adding a RAF sampler, because it introduces a visual loop. Keep it scoped and cleaned up inside `useEffectsPanelAudioSync`.
- Medium risk if forcing `updateTrackGains` on MIDI note start, because note-on is a hot path. Only add it after proving the graph can be stale.

## Non-Goals

- Do not change the actual audio routing or track output tap point unless validation proves it is wrong.
- Do not change EQ to show fake spectrum energy on silence.
- Do not make EQ show pre-EQ input spectrum in this pass. Current behavior is post-FX/post-volume track output.
- Do not replace the centralized `createMeteringRuntime` with a per-component meter hook.

## Acceptance Criteria

- Live MIDI while transport is stopped visibly drives the right-sidebar target track meter.
- Live MIDI while transport is stopped updates the selected track EQ spectrum when the Effects panel is open.
- Existing playback metering and spectrum behavior still works during transport playback.
- EQ remains visually useful on silence by showing grid and EQ curve, but no fake spectrum.
- Validators pass.
