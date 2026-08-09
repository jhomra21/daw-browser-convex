# Plan 007: Resolve validated Thermos native transport, preflight, and loop findings

## Scope

Fix only the three concrete correctness findings from the single Thermos run. Preserve all user-confirmed tail, sparse VST, focus/seek, editor, loop, and native-only behavior. Do not perform broad module decomposition.

## Finding 1: Complete VST musical transport context

- Extend the existing native worker block context/wire contract with the musical transport data required by VST3 `ProcessContext`:
  - sample position;
  - tempo/BPM;
  - project musical position in quarter notes;
  - time-signature numerator/denominator;
  - cycle active flag and cycle start/end in quarter notes when looping;
  - playing state and transport discontinuity.
- Populate VST3 validity/state flags only for fields actually supplied.
- Derive values from the canonical playback snapshot/transport context, not plugin-local assumptions.
- During arrangement looping:
  - native scheduling frames remain monotonic;
  - musical project position and cycle context reflect the wrapped arrangement timeline.
- Preserve compatibility/version validation across desktop protocol, plugin-host protocol, host, worker, tests, and package artifacts.
- Add tests for normal playback, paused live preview, tempo-synced playback, loop cycle bounds, and wrapped musical position.

## Finding 2: Validate all finite arrangement windows

- Live-MIDI capability must not reduce finite arrangement capacity validation to only the initial two-second lookahead.
- Keep runtime scheduling memory bounded.
- Choose the smallest correct approach after reading current code:
  - preflight every finite arrangement callback block through `scheduleEndFrame`; or
  - apply identical capacity/voice/event/automation validation to every compiled refill window before publishing it.
- Loops/open-ended live scheduling must retain bounded preflight.
- A capacity fault in a later finite block must be reported before that block reaches realtime processing, with the existing reason-coded fault behavior.
- Add a regression with a safe first two seconds and an over-capacity later block.

## Finding 3: Release spanning notes only on real loop wrap

- Do not release/retrigger an intro note merely because a projected slice first reaches `loopStart`.
- Release carried notes only when projection crosses the actual `loopEnd -> loopStart` wrap.
- Preserve iteration-qualified identities, capacity accounting, and carried-note release on subsequent wraps.
- Add regressions for:
  - playback beginning before loop start with a note spanning into the loop;
  - first actual wrap;
  - playback starting exactly at loop start;
  - repeated wraps.

## Validation

```sh
bun test src/lib/desktop/native-schedule-coordinator.test.ts packages/plugin-host-protocol/src/index.test.ts packages/audio-engine/src/native-host-wire.test.ts apps/desktop/audio-host.test.ts
cmake --build native/build/audio-host-debug
ctest --test-dir native/build/audio-host-debug --output-on-failure
bun run typecheck
bun test
bun run build
bun --cwd apps/desktop package
git diff --check
```

## Constraints

- No browser audio fallback in Electron.
- No arbitrary tail/silence windows.
- No polling/timers.
- No broad refactor of the large transport/controller/audio-core modules.
- Do not commit or push.
