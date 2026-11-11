import { z } from "zod"
import { classes } from "./ae-08-processor-state-fuzz-classes"

export const mutationSchema = z.enum(["stale-overwrite", "false-receipt", "early-release", "noop-churn",
  "drop-batch", "false-rejection", "lost-edit", "swallow-waiter", "never-wake-latency", "underfill",
  "real-timer", "native-rollback", "force-rebuild", "drop-dispatch", "drop-transport", "history-replay-on-failure",
  "captured-rollback", "skip-latest-edit", "no-undo", "retain-reservation", "no-release", "no-hold", "no-loop-end", "no-abort", "skip-swap", "dirty-flush", "clear-override", "allocate-only-replay", "wrong-latest", "same-stop-wrong-start", "two-sources"])
export const hookClassTable = {
  classes,
  prefixes: [
    { scenario: "prefix-1", seed: 1, greenAfter: "B4a" },
    { scenario: "prefix-6", seed: 6, greenAfter: "B2b" },
    { scenario: "prefix-8", seed: 8, greenAfter: "B4a" },
    { scenario: "prefix-9", seed: 9, greenAfter: "B2a" },
    { scenario: "stale-compile", seed: 10, greenAfter: "B4b" },
    // B4a. One reopening fact buys one attempt of the retained blocked candidate; the candidate never outlives its inputs.
    { scenario: "explicit-retry", seed: 1, greenAfter: "B4a" },
    { scenario: "capacity-reopen", seed: 1, greenAfter: "B4a" },
    { scenario: "retained-candidate", seed: 1, greenAfter: "B4a" },
    // B4a, design review r1. Green today; each is red under the in-memory mutation of the v1 design noted in the phase 1c report.
    { scenario: "explicit-context", seed: 1, greenAfter: "B4a" },
    { scenario: "intent-aba", seed: 1, greenAfter: "B4a" },
    { scenario: "edits-during-compile", seed: 1, greenAfter: "B4a" },
    { scenario: "retained-seek", seed: 1, greenAfter: "B4a" },
    { scenario: "pending-attempt", seed: 1, greenAfter: "B4a" },
    // Green today (the hook's ownership key ignores plain progress); the owner's blocked-attempt record must keep it so.
    { scenario: "progress-only", seed: 1, greenAfter: "B4a" },
    // B4b. A parked schedule releases the execution lane: the FFT change settles at unchanged clip capacity, costs the
    // schedule no attempt, and the returning capacity publishes it over the latest latency.
    { scenario: "parked-latency", seed: 1, greenAfter: "B4b" },
    // The recovery attempt of a parked schedule is held inside its mapped-page write: one page completion, leases balanced.
    { scenario: "parked-page-hold", seed: 1, greenAfter: "B4b" },
    // A publication lands between preview and flush; the same-core successor rebinding is B3a-i's.
    { scenario: "identity-same", seed: 1, greenAfter: "B3a-i" },
    { scenario: "identity-changed", seed: 1, greenAfter: "B1" },
    ...["cancel", "pause", "seek", "loop"].map((kind) => ({ scenario: `late-${kind}`, seed: 7, greenAfter: "B3b" })),
    { scenario: "domain-timeout", seed: 20, greenAfter: "B3b" },
    { scenario: "pause-latency", seed: 7, greenAfter: "B5b" },
    { scenario: "prefix-10", seed: 10, greenAfter: "B4b" },
    // A patch queued behind a newer gesture installs over it; native, panel and persisted must all end on the gesture.
    { scenario: "patch-install", seed: 1, greenAfter: "B3a-ii" },
    // A2c. Cell scenarios enumerate one exact interleaving per seed; `cells` is the full count.
    // History replay reaches native only through a graph prepare, where the retained live override
    // outlives it (graph-only-desired-change, B3a-i); ordering and reservation failures are classed
    // edit-identity (B1) and gated there.
    { scenario: "history-equal-undo-return", seed: 1, greenAfter: "B3a-i" },
    { scenario: "history-redo", seed: 1, greenAfter: "B3a-i" },
    { scenario: "history-save-newer", seed: 1, cells: 6, greenAfter: "B1" },
    { scenario: "history-save-failed", seed: 1, greenAfter: "B1" },
    { scenario: "identity-unchanged", seed: 1, greenAfter: "B1" },
    { scenario: "save-fail-positions", seed: 1, cells: 180, greenAfter: "B2b" },
    { scenario: "commit-after-removal", seed: 1, greenAfter: "B3b" },
    { scenario: "context-matrix", seed: 1, greenAfter: "B4b" },
    { scenario: "stale-compile-asset-wait", seed: 1, greenAfter: "B4b" },
    { scenario: "candidate-page-hold", seed: 1, greenAfter: "B4b" },
    { scenario: "sample-swap", seed: 1, greenAfter: "B4b" },
    { scenario: "sample-swap-window", seed: 1, greenAfter: "B4b" },
    { scenario: "paused-flush", seed: 1, greenAfter: "B3b" },
    // Hook seeds 3 and 84: a refused record stays pending and the transport action then ends its domain.
    { scenario: "pause-refused-pending", seed: 1, greenAfter: "B3b" },
    // A preview's send straddles the pause: still accepted, never the state-patch fallback.
    { scenario: "preview-across-pause", seed: 1, greenAfter: "B3b" },
    // Semantic attribution: any timer a processor wait allocates, whatever helper made it.
    { scenario: "processor-timer", seed: 1, greenAfter: "B3b" },
    { scenario: "cancel-other-save", seed: 1, greenAfter: "B3a-i" },
    { scenario: "instrument-urgent", seed: 1, greenAfter: "B3a-i" },
    // A gesture that returns to its starting value has nothing to commit or restore but must still end.
    { scenario: "gesture-equal-return", seed: 1, greenAfter: "B3a-i" },
    { scenario: "gesture-cancel-unchanged", seed: 1, greenAfter: "B3a-i" },
    // Previews that each changed other fields: the flush that ends the gesture must not send what already applied.
    { scenario: "gesture-multi-field-return", seed: 1, greenAfter: "B3a-i" },
    { scenario: "gesture-multi-field-cancel", seed: 1, greenAfter: "B3a-i" },
  ].map((prefix) => ({ cells: 1, ...prefix })),
  notExercised: [
    { portion: "rollback of a failed save after its member was removed and re-added (registry replace incarnation guard)", owner: "B3a-i", reason: "The registry observes membership only through the projection echo of the same FIFO IndexedDB queue, so a failed write always aborts before any later membership write can land; the hook fixture has no second projection source. The guard stays covered by code review in B3a-i and is not claimed as witnessed" },
    { portion: "Stretch render-state with deferred stretch windows", owner: "A2c", reason: "The hook mounts useTimelinePlayback with deferredStretchWindows always empty and an in-memory buffer; sample swap itself (new source key and buffer) is witnessed by sample-swap and sample-swap-window" },
    { portion: "cancelling a candidate that is mid asset command", owner: "A2c", reason: "The controller serializes an already prepared candidate through its asset command, so a superseded candidate completes once and is followed by the survivor; stale-compile-asset-wait asserts that bound, while stale-compile covers a stale compile that never reaches prepare" },
    { portion: "history reserveInstanceEffectEdit wiring and the full Timeline mount", owner: "A2c", reason: "The fixture now uses the production createTimelineEffectCommit callback with the real useTimelineHistory, createProcessorEditRegistry, createEffectsPanelAudioDevice and resolveDesiredPlaybackFx. It does not mount Timeline.tsx; Timeline's reserveInstanceEffectEdit closure and its reservation/replay wiring remain independently constructed by mountHookHistory, not exercised through the full Timeline mount" },
    { portion: "commit-after-removal reached through a live panel gesture", owner: "A2c", reason: "The panel cancels an open gesture when its member row is removed, so the fallthrough is reachable only by a late commit callback; the witness drives that callback directly" },
    { portion: "attachment parked rebase and attachment-latency I9 in the mounted hook", owner: "A2c", reason: "Witnessed by the controller fixture (attachment scenario); the mounted hook fixture has no external attachment plan" },
    { portion: "prefix-10 page read held across candidate release", owner: "A2c", reason: "In-memory AudioBuffer sources have no asynchronous page read; prefix-10 asserts only populated I5 ownership" },
  ],
}
