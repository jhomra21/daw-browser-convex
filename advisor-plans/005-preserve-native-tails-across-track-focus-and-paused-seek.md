# Plan 005: Preserve native synth/effect tails across track focus and paused seeking

> Validate current source before editing. Preserve all existing user work. Do not commit or push.

## Proven root cause

- Timeline lane pointer-down intentionally combines track selection with `startScrub(event.clientX, { listen: false })` in `useTimelineSelection.ts`.
- `startScrub` calls `playback.setPlayhead(sec, tracks)`.
- In Electron/native mode, paused `setPlayhead` currently calls `nativePlayback.rebuildPrepared(sec)`.
- `rebuildPrepared` unconditionally calls `dispose()`, which:
  - stops and tears down the native session;
  - disposes the coordinator;
  - clears live-note/tail ownership;
  - releases assets;
  - tears down coordinated VST workers.
- Destroying the native core and VST workers destroys released synth envelopes and all built-in/external effect state. This is why audio, meters, and spectrum stop instantly when selecting another timeline track.
- Existing `nativePlayback.pause(playheadSec)` already changes epoch/frame and replaces the schedule coordinator while retaining the prepared graph/core, assets, processor state, and VST attachments.

## Required implementation

1. Do not rebuild/dispose a prepared native session merely to reposition the playhead while paused.
2. Reuse or shape the existing same-core paused transport transition:
   - retain the prepared native core and graph revision;
   - retain built-in DSP history and attached VST worker state;
   - replace only the coordinator/schedule ownership for the new frame/epoch;
   - publish the paused transport frame without starting playback;
   - keep live MIDI preview available.
3. Prefer an explicit controller method named for the consumer, such as `seekPrepared(playheadSec)`, if calling `pause()` from a paused seek would obscure intent. It may delegate to the same internal same-core transition.
4. UI selection and live-MIDI target must remain independent:
   - future notes route to the newly focused playable instrument;
   - already released notes/tails remain owned by their original graph node and continue audibly.
5. Preserve explicit teardown for Stop, project switch, lifecycle suspension/loss, plugin structural insertion/removal/reorder, and explicit panic.
6. Preserve active-playback seek semantics unless the same-core transition is already correct for it.
7. Do not change VST always-submit behavior from plan 004.
8. Do not add timers, arbitrary tail windows, browser fallback, or duplicate graph/session machinery.

## Regression tests

1. Paused native preview with a released live note:
   - call paused playhead seek/focus path;
   - assert no native `stop`, `teardown`, asset release, VST re-coordination, reset callback, or graph republish;
   - assert the same prepared graph revision/session remains owned.
2. Assert the coordinator/epoch/frame moves to the requested paused playhead and transport remains stopped.
3. Assert `hasLiveMidiTails()` remains true and the original note handle remains owned after the paused seek.
4. Timeline integration: lane selection plus scrub while paused must use same-core seek rather than `rebuildPrepared`.
5. Future MIDI after selecting another instrument routes to the new track while the old track's released tail remains alive.
6. Same-pitch notes on two targets do not overwrite each other's ownership.
7. Explicit Stop/project change/lifecycle suspension and structural graph rebuild still dispose deterministically.
8. Existing active playback seek tests remain passing.

## Validation

```sh
bun test src/hooks/useTimelinePlayback.test.ts src/lib/desktop/native-playback-controller.test.ts src/hooks/useTimelineMidiOverlay.test.ts
sh native/audio-core/scripts/test-native.sh
cmake --build native/build/audio-host-debug
ctest --test-dir native/build/audio-host-debug --output-on-failure
bun run typecheck
bun test
bun run build
bun --cwd apps/desktop package
git diff --check
```

## Packaged verification

1. Open Untitled 3 and select Track 2.
2. Press/release one note and wait until its Valhalla delay tail is clearly audible.
3. During the tail, click Track 1, Master, an empty lane area, and another instrument if available.
4. Confirm:
   - the full old Track 2 tail remains audible;
   - track/master meters continue;
   - EQ spectrum continues when monitoring the relevant target;
   - no host restart/VST warning occurs.
5. Press a new note after focus changes and confirm it routes only to the newly selected playable instrument.
6. Confirm explicit Stop still terminates sound.
