# Plan 006: Bound live-tail ownership state and reuse immutable schedule indexes

## Accepted behavior to preserve

- Native synth, built-in effect, and external VST tails survive note release, sparse silent gaps, and track-focus/paused-seek changes.
- Tail ownership is conservatively retained until explicit session teardown because arbitrary VST tails do not expose a trustworthy completion event.
- Exactly-once note release remains enforced.

## Cleanup

1. Replace the unbounded per-note `liveMidiNoteOwnership` retention with bounded session-level state:
   - do not claim retained-tail ownership until a live note-on is successfully queued;
   - after a successful live note-on, conservatively retain session tail ownership until explicit native session disposal;
   - failed/cancelled note preparation must not claim ownership;
   - `hasLiveMidiTails()` preserves its current externally observed behavior.
2. Replace unbounded released-handle bookkeeping with a bounded/non-retaining representation where possible, such as a `WeakSet` keyed by the live note handle object. Preserve exactly-once release for repeated calls with the same handle.
3. Update tests for:
   - failed preparation does not claim tail ownership;
   - successful note/release keeps tail ownership through focus/seek;
   - repeated release is queued exactly once;
   - repeated notes do not create per-note retained state.
4. In `native-schedule-coordinator.ts`, compute immutable snapshot-derived arpeggiator, asset, and audio-track indexes once per coordinator rather than inside every `compileWindow`.
5. Preserve all schedule projection, loop identities, retries, capacity preflight, and contiguous-window behavior.
6. Do not alter VST always-submit behavior, effect timing, session teardown semantics, or wire contracts.

## Validation

```sh
bun test src/lib/desktop/native-playback-controller.test.ts src/lib/desktop/native-schedule-coordinator.test.ts
bun run typecheck
bun test
bun run build
bun --cwd apps/desktop package
git diff --check
```
