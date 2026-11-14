import type { Failure } from "./ae-08-processor-state-fuzz-oracle"

export const gateSteps = ["A1", "B1", "B2a", "B2b", "B3a-i", "B3a-ii", "B3b", "B4a", "B4b", "B5a", "B5b", "B6"]
const owned = (signature: string, greenAfter: string) => ({ signature, owner: greenAfter, greenAfter })
export const classes = [
  owned("stale-stamp-at-dispatch/host-refused/resend", "B3a-ii"),
  // The host admitted the batch and then cancelled it at a publication where its target lost its slot. The
  // stale-stamp class above is an admission refusal. B3a-ii owns both (rebinding across publication, then resend).
  owned("post-admission-publication-cancel/resend", "B3a-ii"),
  owned("latency-after-publish-false-rejection", "B5b"),
  owned("latency-before-publish-lost-edit", "B5b"),
  owned("restamp-timeout", "B3a-i"), owned("retained-override", "B5b"),
  owned("stale-patch-overwrite", "B3a-ii"), owned("latency-starvation", "B4b"),
  owned("transport-cancellation", "B5b"), owned("transient-overwrite", "B3a-ii"),
  owned("edit-identity", "B1"), owned("panel-rollback-on-native-rejection", "B2b"),
  owned("pause-seek-stale", "B3b"), owned("cheap-ack-retry-churn", "B4a"),
  owned("noop-adoption-churn", "B4a"), owned("panel-save-cancel-ownership", "B2b"),
  owned("stale-compile", "B4b"), owned("refill-coverage", "B5b"),
  owned("late-reply-domain", "B3b"), owned("domain-end-timeout", "B3b"),
  owned("cancelled-draft-persistence", "B3b"), owned("processor-wait-timer", "B3b"),
  owned("paused-prepared-flush", "B3b"), owned("pause-latency-completion", "B5b"),
  owned("candidate-reader-lease", "B4b"), owned("attachment-rebase", "B4b"),
  owned("attachment-spurious-rebuild", "B4a"),
  // A schedule native refused for clip capacity (parked) did not release the lane it holds for independent latency edits (they
  // never reach native, or reach it more than once), or something other than the capacity returning attempted it again (a
  // latency publication's own capacity advance), or the returning capacity bought zero or several attempts. And: the attempt
  // that recovered it published the graph it was compiled with, not the processor state and PDC of the latency changed meanwhile.
  owned("parked-wake", "B4b"), owned("parked-rebase-stale", "B4b"),
  // One reopening fact (an explicit retry, or native reporting more admission capacity) must buy exactly one attempt of the
  // blocked schedule: none loses the wake-up the owner's capacity epoch carries, more is retry churn.
  owned("explicit-retry-lost", "B4a"), owned("capacity-wake-lost", "B4a"),
  // A blocked adoption retained a compiled candidate whose inputs changed, and published it once capacity returned.
  owned("retained-candidate-stale", "B4a"),
  // An explicit restart whose only change is the compile context (instrument override, VST insert, bypass) must still compile it.
  owned("context-restart-lost", "B4a"),
  // An edit back to the adopted content must not leave the superseded intent's compile to publish.
  owned("stale-intent-published", "B4a"),
  // Edits made during one long compile cost one compile after it, not one concurrent compile per edit.
  owned("compile-churn", "B4a"),
  // A candidate retained for the transport domain a seek or pause ended is neither reused nor published in the next one.
  owned("retained-domain-stale", "B4a"),
  // A schedule compile is still pending after the transport domain it was captured in ended (pause, seek) or its session did
  // (loss, dispose): the owner cancels it at that moment instead of when the compile happens to resolve.
  owned("compile-domain-end", "B4a"),
  owned("compile-transport-mismatch", "B4a"),
  owned("compile-abort-block", "B4a"),
  // An adoption cancelled before its compile registered still compiled, or left an attempt or refusal behind.
  owned("adoption-cancel-leak", "B4a"),
  // A compile of another context than the one now asked for was published.
  owned("context-stale-published", "B4a"),
  // A refusal answered, or was recorded for, an intent other than the one that waited behind it.
  owned("refusal-intent-stale", "B4a"),
  // Content native refused was offered again under another intent.
  owned("content-rejection-lost", "B4a"),
  // A publication dropped before native claimed it still published or left its bank or assets held; one native claimed
  // was reported as something other than what native did.
  owned("publication-cancel-leak", "B4a"), owned("outcome-contradicts-native", "B4a"),
  // The handoff sweep dropped nothing inside the attempt's running window, or nothing past its settlement.
  owned("handoff-sweep-short", "B4a"),
  // A publication native holds (a callback claimed it) was cancelled by a pause or seek, and its caller was answered other
  // than what native did (superseded for a graph native promoted, adopted for one it did not). Or native promoted it between
  // the cancellation's Inspect and Rollback, the rollback's stale-revision was taken for "never published", and the pause or
  // seek waits on a graph the controller no longer tracks.
  owned("deferred-outcome-contradicts-native", "B5a"), owned("native-promotion-untracked", "B5a"),
  // A schedule publication released a clip's asset, and native never reclaimed it: ReclaimAssets does nothing while the
  // published predecessor's plan is unretired (audio-host.cpp:1708), and no Retire or Prepare follows on the schedule path.
  owned("retirement-starves-reclamation", "B5b"),
  // Native still holds a publication in flight once the controller has nothing left to ask: its Inspect or Rollback was
  // rejected or never sent, so the controller dropped the revision and nothing settles the publication (Fable F3/E2).
  owned("publication-left-in-flight", "B5a"),
  // Timeline.tsx handleEffectParamsCommitted falls through to rebuildPlaybackBackend when the
  // patch is unhandled for a removed target. Contract 3 (target removal cancels its barriers)
  // and Contract 5 (cancelled is not a caller failure) make that a cancelled receipt in B3b.
  owned("commit-after-removal-rebuild", "B3b"),
  // A desired change with no live dispatch (history replay) reaches native only through a
  // same-processor graph prepare, which keeps the slot's live runtime overrides
  // (audio_core.cpp compatible_processor_history). B3a-i executes desired content on the
  // live processor with proof.
  owned("graph-only-desired-change", "B3a-i"),
  // The processor-state ledger's desired for a removed or kind-replaced
  // instance ends with its incarnation.
  owned("ledger-incarnation", "B2a"),
  // A live preview's parameter delivery never reached the processor while the gesture is open.
  owned("live-preview-not-applied", "B3a-i"),
  // The controller settled a batch applied that the host cancelled at a publication it judged retained.
  owned("retained-predicate-drift", "B3a-i"),
  // Built-in automation re-enable reports an applied floor with no native batch behind it.
  owned("unproven-applied-floor", "B3a-i"),
  // An instrument urgent edit settles without its urgent event applied, or loses its proof to a same-core publication.
  owned("urgent-instrument-proof", "B3a-i"),
  // A reconcile dispatched desired content older than a gesture whose sequence was already allocated.
  owned("reconcile-overwrote-gesture", "B3a-i"),
  // A rollback replacement edit lost the parameter values the reconcile compares against.
  owned("rollback-without-values", "B3a-i"),
  // The parameter lane checks a batch's epoch at admission: a frame of an older epoch, before or after
  // the ACK, is not evidence that native dropped it.
  owned("parameter-pre-admission-cancel", "B3a-i"),
  // A flush settled applied (or never resolved) for a parameter batch native dropped at a newer epoch.
  owned("parameter-dropped-receipt", "B3a-i"),
  owned("parameter-future-epoch-drop", "B3a-i"),
  // A flush that ends a multi-field gesture sent the fields again although every one had applied.
  owned("gesture-end-redispatch", "B3a-i"),
  // Installing a state patch zeroes the slot's overrides (audio_core.cpp:8426-8450). A gesture applied before
  // it is gone, while its proof, receipt or carrier still stand for it; or a gesture after the install is invalidated with it.
  owned("patch-install-erased-override", "B3a-ii"), owned("patch-install-over-invalidation", "B3a-ii"),
  // A callback claimed the patch, so native applies it whatever the reply says: a negative or lost reply is uncertain, never a rejection.
  owned("claimed-patch-settled-as-rejected", "B3a-ii"),
  // Content a refused dispatch left behind is still desired; nothing re-executes it (a reconcile's own refusal, or a preview's with its gesture open).
  owned("refused-resend-stranded", "B3a-ii"),
  // The owner's own bookkeeping when a patch answers: a true reply puts its values in force, an unexplained false while running leaves them unknown.
  owned("patch-installed-bookkeeping", "B3a-ii"),
  // A patch equal to the prepared bytes is no no-op while an override stands over them or another patch is still to install.
  owned("patch-dedupe-lost-edit", "B3a-ii"),
  // A refused flush whose values a patch installed is answered by the install, not left to a later offer or deadline.
  owned("patch-install-refused-stranded", "B3a-ii"),
  // A record dispatched again must be told apart from the one a caller waited on, even on an unchanged revision.
  owned("dispatch-attempt-identity", "B3a-ii"),
  owned("patch-projected-stale-tail", "B3a-ii"),
  // The deadline answers a caller whose batch native applied but whose progress frame comes later. It is the only timer left
  // on the processor path; B3b removes it, and restamp-timeout above stays B3a-i's for every other applied-but-rejected record.
  owned("processor-proof-deadline", "B3b"),
  // Content still desired when its domain ended (a refused record, an admitted batch the epoch change dropped) was neither
  // executed again in the new domain nor handed back as cancelled: native ends on something older.
  owned("ending-domain-stranded", "B3b"),
  // A late Inspect reply (the latency transition's completion) put an open preview back to its old value before its terminal flush.
  owned("late-inspect-preview", "B3b"),
  // The controller's epoch waiters (and the proof deadline) keep a pause/seek's old-domain wait alive until a frame that may never come.
  // Split from transport-cancellation, which stays B5b's for every other transport failure.
  owned("old-domain-waiter", "B3b"),
  // A flush on the portable browser backend answers cancelled although that backend keeps its synchronous stale receipt.
  owned("browser-receipt-changed", "B3b"),
  // A preview whose send straddled a domain move was answered not-accepted, so Timeline fell through to the state-patch path.
  owned("preview-domain-fallback", "B3b"),
  // A flush submitted with no bridge, before prepare, or through a control captured before the session ended was kept for a
  // domain that will never report: it stays pending. A preview answered accepted. Both are unavailable/unprepared.
  owned("session-unavailable-pending", "B3b"),
]
export const controllerClassTable = {
  classes,
  prefixes: [
    { scenario: "prefix-11", seed: 11, greenAfter: "B3a-i" },
    { scenario: "prefix-12", seed: 12, greenAfter: "B1" },
    { scenario: "identity-same", seed: 1, greenAfter: "B1" },
    { scenario: "identity-changed", seed: 1, greenAfter: "B1" },
    { scenario: "ledger-inclusion", seed: 1, greenAfter: "B2a" },
    { scenario: "ledger-incarnation", seed: 1, greenAfter: "B2a" },
    // A native SetTransport refusal while a callback-claimed publication is pending still disposes the session: B3b answers
    // that dispose's waits `cancelled` and does not resend a refused SetTransport, so surviving the refusal is B5b's.
    { scenario: "transport-refusal", seed: 1, greenAfter: "B5b" },
    { scenario: "host-boundary", seed: 1, greenAfter: "A1" },
    { scenario: "paused-flush", seed: 1, greenAfter: "B3b" },
    // B3b. Every wait of an ended domain is answered without a failure, and still-desired content is executed again.
    { scenario: "pause-refused-pending", seed: 1, greenAfter: "B3b" },
    { scenario: "seek-refused-pending", seed: 1, greenAfter: "B3b" },
    { scenario: "rapid-seek", seed: 1, greenAfter: "B3b" },
    { scenario: "send-straddles-pause", seed: 1, greenAfter: "B3b" },
    { scenario: "two-registry-frame", seed: 1, greenAfter: "B3b" },
    // Unchanged by B3b: a portable browser flush keeps its synchronous receipts (accepted across a pause, stale across a restart), never cancelled.
    { scenario: "browser-flush-pause", seed: 1, greenAfter: "A1" },
    { scenario: "urgent-pause", seed: 1, greenAfter: "B3b" },
    { scenario: "processor-timer", seed: 1, greenAfter: "B3b" },
    { scenario: "late-inspect", seed: 1, greenAfter: "B3b" },
    // A submission with no session to report (no bridge, before prepare, after dispose or host loss) is refused at once.
    { scenario: "flush-no-bridge", seed: 1, greenAfter: "B3b" },
    { scenario: "flush-unprepared", seed: 1, greenAfter: "B3b" },
    { scenario: "flush-after-dispose", seed: 1, greenAfter: "B3b" },
    { scenario: "flush-after-loss", seed: 1, greenAfter: "B3b" },
    // The seed-7 exemption (a transport move behind its pending latency publication, B5b) must not cover any other old-domain wait.
    { scenario: "terminal-classifier", seed: 1, greenAfter: "B3b" },
    { scenario: "pause-latency", seed: 1, greenAfter: "B5b" },
    // B4a. Today's pause/seek/invalidation aborts keep it green; the owner's domain-end cancellation must keep it so.
    { scenario: "compile-domain-end", seed: 1, greenAfter: "B4a" },
    { scenario: "transport-mismatch", seed: 1, greenAfter: "B4a" },
    { scenario: "abort-no-block", seed: 1, greenAfter: "B4a" },
    { scenario: "resume-structure", seed: 1, greenAfter: "P8" },
    { scenario: "adoption-cancel", seed: 1, greenAfter: "B4a" },
    { scenario: "adoption-aba", seed: 1, greenAfter: "B4a" },
    { scenario: "adoption-context", seed: 1, greenAfter: "B4a" },
    { scenario: "adoption-refusal-context", seed: 1, greenAfter: "B4a" },
    { scenario: "adoption-refusal-key", seed: 1, greenAfter: "B4a" },
    { scenario: "adoption-explicit-upgrade", seed: 1, greenAfter: "B4a" },
    { scenario: "content-rejection", seed: 1, greenAfter: "B4a" },
    { scenario: "content-rejection-explicit", seed: 1, greenAfter: "B4a" },
    { scenario: "publication-cancel-unclaimed", seed: 1, greenAfter: "B4a" },
    { scenario: "publication-cancel-staged", seed: 1, greenAfter: "B4a" },
    { scenario: "publication-cancel-queued", seed: 1, greenAfter: "B4a" },
    { scenario: "publication-cancel-claimed", seed: 1, greenAfter: "B4a" },
    { scenario: "publication-cancel-handoff", seed: 1, greenAfter: "B4a" },
    // B5a. A publication native holds answers its caller with what native did, and what native promotes the controller tracks.
    // The pause or seek reaches it after the acknowledgement (plain), between the cancellation's Inspect and its Rollback
    // (late), or after the Rollback was answered publish-pending (deferred); the Publish reply may be lost instead.
    // Three pass today and are required green from B4b on: the seek ones (a seek re-adopts the intent, which hides the
    // contradiction whenever the second publication succeeds) and the pause native cancelled before any callback claimed it.
    { scenario: "deferred-outcome-pause", seed: 1, greenAfter: "B5a" },
    { scenario: "deferred-outcome-seek", seed: 1, greenAfter: "B4b" },
    { scenario: "deferred-outcome-pause-late", seed: 1, greenAfter: "B5a" },
    { scenario: "deferred-outcome-seek-late", seed: 1, greenAfter: "B4b" },
    { scenario: "deferred-outcome-pause-deferred", seed: 1, greenAfter: "B5a" },
    { scenario: "deferred-outcome-seek-deferred", seed: 1, greenAfter: "B4b" },
    { scenario: "deferred-outcome-pause-unclaimed", seed: 1, greenAfter: "B4b" },
    { scenario: "publish-reply-lost", seed: 1, greenAfter: "B5a" },
    { scenario: "inspect-reply-lost", seed: 1, greenAfter: "B5a" },
    { scenario: "rollback-reply-lost", seed: 1, greenAfter: "B5a" },
    { scenario: "reclaim-held-by-retirement", seed: 1, greenAfter: "B5b" },
    // Red at B4a only for attachment-spurious-rebuild (class owner B4a: the gate fails this prefix on it); attachment-rebase stays B4b's.
    { scenario: "attachment", seed: 1, greenAfter: "B4b" },
    // B4b. A parked schedule releases the execution lane: latency settles at unchanged clip capacity, the capacity
    // returning buys one attempt, and that attempt carries the latest latency. Red until B4b.
    { scenario: "parked-latency", seed: 1, greenAfter: "B4b" },
    { scenario: "parked-rebase", seed: 1, greenAfter: "B4b" },
    { scenario: "parked-hold", seed: 1, greenAfter: "B4b" },
    { scenario: "hold-dispose", seed: 1, greenAfter: "B4b" },
    // The owner's own path (an adoption parked and woken with no explicit publication) and the lease balance of a parked
    // candidate that stays valid or is invalidated meanwhile.
    { scenario: "parked-owner", seed: 1, greenAfter: "B4b" },
    { scenario: "leases-valid", seed: 1, greenAfter: "B4b" },
    { scenario: "leases-invalid", seed: 1, greenAfter: "B4b" },
    { scenario: "reenable-automation", seed: 1, greenAfter: "B3a-i" },
    { scenario: "instrument-urgent", seed: 1, greenAfter: "B3a-i" },
    // The B3a-i assertions of these two (never applied without proof) stay required green. Their seek answered stale before
    // B3b; the deferral holds only for gates before `pause-seek-stale` is due, and the gate code drops it from B3b on.
    { scenario: "urgent-epoch-drop", seed: 1, greenAfter: "B3a-i", defers: ["pause-seek-stale"] },
    { scenario: "held-urgent-note", seed: 1, greenAfter: "B3a-i" },
    { scenario: "retained-drift", seed: 1, greenAfter: "B3a-i" },
    { scenario: "reconcile-seek", seed: 1, greenAfter: "B3a-i" },
    { scenario: "reconcile-inflight", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "reconcile-first", seed: 1, greenAfter: "B3a-i" },
    { scenario: "parameter-preack-epoch", seed: 1, greenAfter: "B3a-i" },
    { scenario: "parameter-epoch-drop", seed: 1, greenAfter: "B3a-i", defers: ["pause-seek-stale"] },
    { scenario: "future-epoch-drop", seed: 1, greenAfter: "B3a-i" },
    { scenario: "unsent-second-domain", seed: 1, greenAfter: "B6" },
    { scenario: "retained-instrument", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "two-rejections", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "overlapping-flushes", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "retained-override-instrument", seed: 1, greenAfter: "B3a-i" },
    { scenario: "restated-override", seed: 1, greenAfter: "B3a-i" },
    { scenario: "restated-inflight", seed: 1, greenAfter: "B3a-i" },
    { scenario: "restated-queued", seed: 1, greenAfter: "B3a-i" },
    { scenario: "synth-replaced", seed: 1, greenAfter: "B3a-i" },
    { scenario: "rollback-values", seed: 1, greenAfter: "B3a-i" },
    { scenario: "patch-install", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-install-late-proof", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-first", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-negative", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-race-before-claim", seed: 1, greenAfter: "B3a-ii" },
    // patch-race-split is model-only (native claims and applies in one callback) and is not a gate prefix.
    { scenario: "patch-claimed-newest", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-installed", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "attempt-identity", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-projected-timing", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-prepared-override", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-prepared-pending", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "patch-refused-settled", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "rebound-credit", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "rebound-applied-rejected", seed: 1, greenAfter: "B3b" },
    { scenario: "joined-flush-credit", seed: 1, greenAfter: "B3b" },
    { scenario: "refused-resend", seed: 1, greenAfter: "B3a-ii" },
    { scenario: "refused-preview", seed: 1, greenAfter: "B3a-ii" },
  ],
  notExercised: [
    { portion: "a later floor lifted by an unrelated processor's batch while a patch is in flight", owner: "B3a-ii", reason: "The fixture has one processor-lane target (Utility) and native folds the floor by max, so no second target exists to lift it. A patch carries no proof sequence and is settled by its reply, so a foreign floor cannot settle or erase it; patch-install-late-proof covers a later frame proving a batch the install erased" },
    { portion: "recovery of a lost patch reply in a live session", owner: "B5b", reason: "D6 defers automatic renderer REPAIR. The ordinary supervisor watchdog ends the session; a Recording Stop queued behind a lost patch status can instead stall the still-live supervisor slot, where REPAIR also cannot dispatch (PARENT-RULING-7A-stop-D6.md). Seed 5 and W57 cover terminal loss and the existing claim/resend boundary only; reduced B5b is not unrestricted REPAIR certification." },
    { portion: "same-bank Rollback returning staged capacity to a concurrent retained refusal (Fable F2)", owner: "B5a", reason: "W27 witnesses earlier schedule release, reader-safe native reclaim, capacity 0→1 and exactly one blocked-intent retry; W28 proves own Rollback never renews its budget. The same-bank concurrent history is unreachable: public schedule admission disposes the other retained schedule (W27 adversarial replacement; PARENT-RULING-6B-stop.md:11-12), while the shared driver's latency payload stages no assets (asset staging is schedule-only). Rollback releases only its own staged_revision (audio-host.cpp:3143-3149); reclamation, not latency Rollback, returns capacity (audio-host.cpp:1782-1821)" },
    { portion: "hardware retirement continuity beyond the deterministic host", owner: "B5b", reason: "W45–W47 now exercise shared schedule/latency retirement, held readers, lost replies, safe lease release and loss. The reclaim-held-by-retirement prefix observes product Retire and actual capacity. These source gates do not certify hardware continuity." },
    { portion: "exactly one drain wake per terminal transition of a publication", owner: "B5a", reason: "Only the lost wake is observable (a held edit that never starts: hold-dispose, parked-hold, parked-owner); an extra wake only costs an empty drain, which no native command distinguishes" },
    { portion: "Contract 5 draft persistence (cancelled-draft-persistence)", owner: "B3b", reason: "Panel-level; covered by the hook fixture only (late-cancel, late-pause, late-seek, late-loop, ending-flush)" },
    { portion: "instrument urgent proof through the mounted hook and panel", owner: "B3a-i", reason: "Only the controller fixture mounts a synth (instrument-urgent); the hook fixture's project has no instrument track, so the panel-level instrument gesture is not exercised" },
    { portion: "rememberInstrumentParameters as the second writer of the prepared instrument snapshot", owner: "B3a-i", reason: "Called from the Timeline.tsx closure, which no fixture mounts; the structural removal is verified by reading the call sites, not by a fuzzer witness" },
    { portion: "proof inherited from a foreign host or earlier session", owner: "B3a-i", reason: "Each fixture owns one host whose floors reset at teardown or loss, and the progress wire carries no host identity to inject; session scoping is enforced by invalidation and is covered only through the I7 old-domain waiter checks" },
    { portion: "portable browser backend liveProcessorControl", owner: "B3b", reason: "Outside the native host model; the browser controller keeps its synchronous receipts. browser-flush-pause builds the real portable controller over a fake session and pins accepted across a pause and stale across a restart, never cancelled" },
  ],
}

// Match symptoms, not invariant numbers: a new symptom must fail every gate.
export const classifyFailure = (failure: Failure): Failure => ({
  reason: null, error: null, transition: null, ...failure,
  class: failure.class ?? (
    failure.invariant === "I7" && failure.detail.startsWith("Old-domain controller waiter survives") ? "old-domain-waiter"
      : failure.invariant === "I7" && failure.detail === "Pause disposes native session after callback-claimed SetTransport refusal" ? "transport-cancellation"
      : failure.invariant === "I4" && failure.detail === "Unsettled controller request at logical drain bound" && failure.domain === "ending-transport-domain" ? "domain-end-timeout"
      : failure.invariant === "I4" && failure.detail === "Unsettled controller request at logical drain bound"
        || failure.detail === "Fixed parallel topology latency/PDC differs from desired FFT" ? "latency-starvation"
        : failure.invariant === "I2" && failure.detail === "Native content regressed below newer confirmed edit" ? "transient-overwrite"
          : failure.invariant === "I8" && failure.detail === "Running active coverage is below renderedThroughFrame plus one block" ? "refill-coverage"
            : failure.invariant === "I1" && failure.detail.startsWith("Native differs from desired:") ? "retained-override" : undefined),
})
export const gateViolations = (failures: readonly Failure[], gate: string) => {
  const step = gateSteps.indexOf(gate)
  if (step < 0) throw new Error(`Unknown gate ${gate}`)
  return failures.filter((failure) => {
    const entry = classes.find((entry) => entry.signature === failure.class)
    return !entry || gateSteps.indexOf(entry.greenAfter) <= step
  })
}
