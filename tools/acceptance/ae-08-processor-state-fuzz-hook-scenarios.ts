import type createHookFixture from "./ae-08-processor-state-fuzz-hook"
import type { Action } from "./ae-08-processor-state-fuzz-host"
import runA2cScenario, { a2cScenarios } from "./ae-08-processor-state-fuzz-hook-scenarios-a2c"

type Fixture = Awaited<ReturnType<typeof createHookFixture>>
type Driver = { fixture: Fixture; act: (action: Action) => Promise<void>; drain: () => Promise<void>; nextFair: () => Action | undefined; bound: number; seed: number }

// Separate inventory: never append to the durable pre-step-5 campaign arrays.
export const step5LiveScenarios = ["b5c-live", "b5c-foreign", "b5c-undo", "b5c-redo"];
export const step5GuardScenarios = ["b5c-identical", "b5c-structure"];

export default async function runHookScenario(name: string, driver: Driver) {
  const { fixture, act, drain, nextFair, bound, seed } = driver
  const until = async (predicate: () => boolean) => {
    for (let count = 0; count < bound; count++) {
      if (predicate()) return
      const next = nextFair()
      if (!next) break
      await act(next)
    }
    if (!predicate()) throw new Error(`Unreachable ${name} witness dependency`)
  }
  if (step5LiveScenarios.includes(name) || step5GuardScenarios.includes(name)) {
    if (name === "b5c-undo" || name === "b5c-redo") {
      await act({ kind: "gain", value: -6 }); await drain();
      await act({ kind: "observe-persisted" }); await drain();
      if (name === "b5c-redo") { await act({ kind: "undo" }); await drain(); }
    }
    await act({ kind: "capture-retry" });
    if (name === "b5c-foreign") await act({ kind: "external-adoption", value: -9 });
    else if (name === "b5c-undo") await act({ kind: "undo" });
    else if (name === "b5c-redo") await act({ kind: "redo" });
    else if (name === "b5c-identical") await act({ kind: "project-identical" });
    else if (name === "b5c-structure") await act({ kind: "latency", value: 2048 });
    else await act({ kind: "gain", value: -9 });
    await drain();
    await act({ kind: "observe-persisted" }); await drain();
    await act({ kind: "check", mode: name === "b5c-structure" ? "b5c-structure" : "b5c-live" });
    await act({ kind: "check", mode: "drained" });
    return;
  }
  if (a2cScenarios.includes(name)) return runA2cScenario(name, { fixture, act, drain, until, seed })
  if (name.startsWith("late-") || name === "domain-timeout") {
    await act({ kind: name === "late-cancel" ? "preview" : "gain", value: -9 })
    // A preview's wait is its send, so its reply is what is held; a flush waits for native to apply its record, which
    // is pending as soon as the flush is registered (a flush joins an admitted preview's record, with no reply of its own).
    await until(() => fixture.state().waiters.some((waiter) => !waiter.settled
      && waiter.name === (name === "late-cancel" ? "preview" : "flush"))
      && (name !== "late-cancel" || fixture.state().replies.some((reply) => reply.name === "parameters")))
    await act({ kind: "capture-domain", value: name === "late-cancel" ? 0 : undefined })
    const held = fixture.state().replies.find((reply) => reply.name === "parameters")
    if (name === "domain-timeout") {
      // Deliver admission but withhold callback/progress until pause invalidates
      // the sequence waiter. No timeout is selected to trigger cancellation.
      if (held) await act({ kind: "deliver-reply", id: held.id })
      await act({ kind: "pause" })
    } else {
      await act({ kind: name.slice(5) })
      if (held) await act({ kind: "deliver-reply", id: held.id })
    }
    await drain()
    if (name !== "late-cancel") { await act({ kind: "read-persisted" }); await drain() }
    await act({ kind: "check", mode: name === "domain-timeout" ? "domain-timeout" : "late-domain" })
    return
  }
  if (name === "pause-latency") {
    await act({ kind: "latency", value: 2048 })
    await until(() => fixture.state().latencyPending && !fixture.state().pendingControl)
    await act({ kind: "inspect-latency" })
    await until(() => !fixture.state().pendingControl)
    await act({ kind: "pause" })
    await until(() => !fixture.state().running && !fixture.state().pendingControl)
    await act({ kind: "inspect-latency" }); await drain()
    await act({ kind: "check", mode: "pause-latency" })
    return
  }
  if (name === "patch-install") {
    // Patch A is in flight and patch B is coalesced behind it. The panel's newer edit (-9) is carried by B, the one whole-content
    // selector (design L4), so no parameters command exists; B's install proves it and zeroes the slot's overrides.
    const wake = async (command: string) => {
      for (let count = 0; count < bound; count++) {
        const action = fixture.enabled().find((entry) => entry.kind === "control-wake" && fixture.commandName(entry.id) === command)
        if (action) { await act(action); return }
        const next = nextFair()
        if (!next) break
        await act(next)
      }
      throw new Error(`No scheduler path to ${command}`)
    }
    const reply = async (command: string) => {
      const action = fixture.enabled().find((entry) => entry.kind === "deliver-reply" && fixture.replyName(entry.id) === command)
      if (!action) throw new Error(`No reply ${command}`)
      await act(action)
    }
    await act({ kind: "gain-patch", value: -1 })
    await act({ kind: "gain-patch", value: -3 })
    await act({ kind: "gain", value: -9 })
    await wake("patch"); await act({ kind: "render-block" }); await reply("patch")
    await act({ kind: "render-block" }); await act({ kind: "deliver-progress" })
    await wake("patch"); await act({ kind: "render-block" }); await reply("patch")
    await drain()
    await act({ kind: "mark", mode: "expected", value: -9 })
    await act({ kind: "observe-persisted" }); await drain()
    await act({ kind: "check", mode: "patch-install" })
    return
  }
  if (name === "prefix-10") {
    await act({ kind: "clip-timing", value: 0.25 }); await drain()
    await act({ kind: "check", mode: "lease-populated" })
    // The in-memory AudioBuffer source has no asynchronous page read. Do not
    // claim the held-reader/candidate-release portion from populated I5 alone.
    return
  }
  if (name === "starve-refill" || name === "underfill") {
    await act({ kind: "long-loop" }); await drain()
    await until(() => fixture.state().running)
    await drain()
    // Reach the refill boundary fairly first. Hold the actual queued refill
    // as well as all progress delivery, not just notifications on a full bank.
    for (let count = 0; count < 200 && fixture.state().coverageFrames >= 48_000n; count++) {
      await act({ kind: "render-block" })
      await act({ kind: "deliver-progress" })
    }
    if (fixture.state().pendingControl?.name !== "window") throw new Error("Starvation missed queued refill")
    // Coordinator lookahead=2s, refill threshold=1s (:100–101,1021–1032).
    // 24 callbacks at 512/48000 = 256ms, below the one-second refill slack.
    // No progress, command wake, reply or rAF is delivered inside this window.
    const blocks = name === "underfill" ? 220 : 24
    await act({ kind: "starvation-begin", value: blocks })
    for (let count = 0; count < blocks; count++) await act({ kind: "render-block" })
    await act({ kind: "starvation-end" })
    await act({ kind: "deliver-progress" }); await drain()
    await act({ kind: "check", mode: "starvation" })
    await act({ kind: "check", mode: "drained" })
    return
  }
  if (name === "identity-same" || name === "identity-changed") {
    await act({ kind: "preview", value: -6 }); await drain()
    await act({ kind: "identity-baseline" })
    if (name === "identity-changed") await act({ kind: "preview", value: -9 })
    await act({ kind: "commit" }); await drain()
    await act({ kind: "check", mode: name })
  } else if (name === "prefix-1") {
    await act({ kind: "clip-timing", value: 0.25 }); await drain()
    await act({ kind: "project-identical" }); await drain()
    await act({ kind: "freeze" })
    for (let count = 0; count < 25; count++) {
      await act({ kind: "project-identical" }); await drain()
    }
    await act({ kind: "check", mode: "identical" })
    await act({ kind: "check", mode: "drained" })
  } else if (name === "prefix-6") {
    await act({ kind: "gain", value: -6 })
    await until(() => fixture.time.canFailPersistence())
    await act({ kind: "preview", value: -13 })
    await act({ kind: "persist-fail" })
    await drain()
    await act({ kind: "check", mode: "panel-newer" })
    await act({ kind: "external-adoption", value: -11 }); await drain()
    await act({ kind: "cancel" }); await drain()
    await act({ kind: "check", mode: "panel-cancel" })
  } else if (name === "prefix-8") {
    await act({ kind: "block-asset" })
    await act({ kind: "clip-timing" }); await drain()
    await act({ kind: "capture-retry" })
    for (let count = 0; count < 25; count++) {
      await act({ kind: "cheap-ack" }); await drain()
      await act({ kind: "deliver-progress" }); await drain()
    }
    await act({ kind: "check", mode: "retry-budget" })
  } else if (name === "explicit-retry") {
    // Each explicit request is one new attempt of the retained candidate, however often the previous attempt was blocked.
    await act({ kind: "block-asset" })
    await act({ kind: "clip-timing" }); await drain()
    for (let count = 0; count < 3; count++) {
      await act({ kind: "capture-retry" })
      await act({ kind: "restart-schedule" }); await drain()
      await act({ kind: "check", mode: "explicit-retry" })
    }
  } else if (name === "capacity-reopen") {
    // Native reporting more capacity is the one fact that reopens a capacity-blocked attempt; plain progress afterwards does not.
    await act({ kind: "block-asset" })
    await act({ kind: "clip-timing" }); await drain()
    await act({ kind: "capture-retry" })
    await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" }); await drain()
    for (let count = 0; count < 5; count++) {
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
    }
    await act({ kind: "check", mode: "capacity-reopen" })
  } else if (name === "parked-latency") {
    // The clip's candidate is refused for capacity and parked; the panel then changes the spectral FFT. Native gets the FFT
    // with no pause, seek or loss, the parked schedule is not attempted by it, and the capacity returning publishes it once.
    await act({ kind: "block-asset" })
    await act({ kind: "clip-timing" }); await drain()
    await act({ kind: "capture-retry" })
    await act({ kind: "latency", value: 2048 }); await drain()
    // Native's independent opportunities are rendered blocks and their progress frames, not the drain that follows them.
    for (let count = 0; count < 25; count++) { await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }) }
    await drain()
    await act({ kind: "check", mode: "parked-settled" })
    await act({ kind: "capture-retry" })
    await act({ kind: "block-asset", value: 0 })
    await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" }); await drain()
    for (let count = 0; count < 12; count++) { await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain() }
    await act({ kind: "check", mode: "parked-recovered" })
    await act({ kind: "check" })
  } else if (name === "parked-page-hold") {
    // The capacity returning wakes the parked schedule, whose retained candidate is reused: its attempt waits on a real
    // deferred mapped-page completion, and the FFT changed meanwhile queues behind the attempt (a running adoption holds
    // latency). The candidate's leases are the attempt's until native answers; the latency runs once the attempt settles.
    await act({ kind: "block-asset" })
    await act({ kind: "clip-timing" }); await drain()
    await act({ kind: "capture-retry" })
    await act({ kind: "block-asset", value: 0 })
    await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" })
    // A recovery that never starts is the wake lost, reported by the check below rather than as an unreachable witness.
    for (let count = 0; count < bound && fixture.state().pendingControl?.name !== "asset-page"; count++) {
      const next = nextFair()
      if (!next) break
      await act(next)
    }
    const attempted = fixture.state().pendingControl?.name === "asset-page"
    await act({ kind: "mark", mode: "page-hold", value: attempted ? 1 : 0 })
    await act({ kind: "check", mode: "page-held" })
    if (!attempted) return
    await act({ kind: "latency", value: 2048 })
    // Native callbacks render, but no progress frame reaches the controller: the latency queued behind the attempt starts
    // because the attempt settled, not because a frame told the controller to look again.
    const immediate = ["control-wake", "deliver-reply", "resolve-compile", "publication-acknowledge", "idb-task", "lifecycle-ready"]
    for (let count = 0; count < bound; count++) {
      const enabled = fixture.enabled()
      const panelFrame = fixture.time.enabled().find((entry) => entry.kind === "raf-tick" && entry.site.includes("parameter-gesture-owner"))
      const next = enabled.find((entry) => immediate.includes(entry.kind)) ?? (panelFrame && { kind: panelFrame.kind, id: panelFrame.id })
        ?? (count < 60 ? enabled.find((entry) => entry.kind === "render-block") : undefined)
      if (!next) break
      await act(next)
    }
    await act({ kind: "check", mode: "page-quiet" })
    await drain()
    for (let count = 0; count < 12; count++) { await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain() }
    await act({ kind: "check", mode: "page-released" })
    await act({ kind: "check" })
  } else if (name === "progress-only") {
    await act({ kind: "block-asset" })
    await act({ kind: "clip-timing" }); await drain()
    await act({ kind: "capture-retry" })
    for (let count = 0; count < 25; count++) {
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
    }
    await act({ kind: "check", mode: "progress-only" })
  } else if (name === "explicit-context") {
    // Nothing the projection fingerprint sees has changed; only what the compile is handed has (an instrument override).
    await act({ kind: "clip-timing", value: 0.25 }); await drain()
    await act({ kind: "capture-retry" })
    await act({ kind: "restart-schedule", mode: "override" }); await drain()
    await act({ kind: "check", mode: "context-compiled" })
    // The same key with another context, asked for while the first compile is held, is another intent and compiles.
    await act({ kind: "capture-retry" })
    await act({ kind: "restart-schedule" })
    await until(() => fixture.state().compilationIds.length > 0)
    await act({ kind: "restart-schedule", mode: "override" }); await drain()
    for (let count = 0; count < 12; count++) { await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain() }
    await act({ kind: "check", mode: "context-inflight" })
  } else if (name === "intent-aba") {
    // B is compiling when the edit returns to the adopted A: B must not publish over it.
    await act({ kind: "clip-timing", value: 0.25 }); await drain()
    await act({ kind: "capture-retry" })
    await act({ kind: "clip-timing", value: 0.5 })
    await until(() => fixture.state().compilationIds.length > 0)
    await act({ kind: "clip-timing", value: 0.25 }); await drain()
    // Native publishes only as blocks render, so give a superseded intent every chance to land.
    for (let count = 0; count < 12; count++) { await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain() }
    await act({ kind: "check", mode: "aba-final" })
    // A is compiling, B waits behind it, and the edit returns to A: B is never compiled, and A publishes.
    await act({ kind: "capture-retry" })
    await act({ kind: "clip-timing", value: 0.5 })
    await until(() => fixture.state().compilationIds.length > 0)
    await act({ kind: "clip-timing", value: 0.75 }); await act({ kind: "clip-timing", value: 0.5 }); await drain()
    for (let count = 0; count < 12; count++) { await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain() }
    await act({ kind: "check", mode: "aba-waiting" })
  } else if (name === "edits-during-compile") {
    await act({ kind: "capture-retry" })
    await act({ kind: "clip-timing", value: 0.1 })
    await until(() => fixture.state().compilationIds.length > 0)
    for (const value of [0.2, 0.3, 0.4, 0.5]) await act({ kind: "clip-timing", value })
    await drain()
    await act({ kind: "check", mode: "edits-compiles" })
  } else if (name === "retained-seek") {
    // A capacity-blocked adoption holds a compiled candidate; the seek ends the transport domain it was compiled in.
    await act({ kind: "block-asset" })
    await act({ kind: "clip-timing", value: 0.25 }); await drain()
    await act({ kind: "capture-retry" })
    await act({ kind: "seek", value: 0.25 }); await drain()
    await act({ kind: "block-asset", value: 0 })
    await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" }); await drain()
    // The seek's transport transition completes on rendered blocks, and the reopened adoption queues behind it.
    for (let count = 0; count < 12; count++) { await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain() }
    await act({ kind: "check", mode: "seek-retained" })
  } else if (name === "pending-attempt") {
    // Native refuses an asset command because a publication is pending: one attempt, then only a capacity fact or an explicit retry.
    await act({ kind: "block-asset", mode: "publication-pending" })
    await act({ kind: "clip-timing" }); await drain()
    await act({ kind: "capture-retry" })
    for (let count = 0; count < 25; count++) {
      await act({ kind: "render-block" }); await act({ kind: "deliver-progress" }); await drain()
    }
    await act({ kind: "check", mode: "progress-only" })
    await act({ kind: "capture-retry" })
    await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" }); await drain()
    await act({ kind: "check", mode: "capacity-reopen" })
  } else if (name === "retained-candidate") {
    await act({ kind: "block-asset" })
    await act({ kind: "clip-timing", value: 0.5 }); await drain()
    await act({ kind: "clip-timing", value: 0.25 }); await drain()
    await act({ kind: "block-asset", value: 0 })
    await act({ kind: "grant-capacity" }); await act({ kind: "deliver-progress" }); await drain()
    await act({ kind: "check", mode: "retained-final" })
  } else if (name === "prefix-9") {
    await act({ kind: "external-adoption", value: -11 }); await drain()
    await act({ kind: "check", mode: "adoption" })
    await act({ kind: "tempo" }); await act({ kind: "meter" })
    await act({ kind: "loop" }); await drain()
    await act({ kind: "check", mode: "context" })
  } else if (name === "stale-compile") {
    await act({ kind: "clip-timing", value: 0 })
    await until(() => fixture.state().compilationIds.length > 0)
    const stale = fixture.state().compilationIds[0]
    await act({ kind: "capture-stale-compile" })
    await act({ kind: "clip-timing", value: 0.25 })
    await act({ kind: "tempo" })
    await act({ kind: "resolve-compile", id: stale })
    await act({ kind: "check", mode: "stale-released" })
    await drain()
    await act({ kind: "check", mode: "context" })
    await act({ kind: "check", mode: "stale-final" })
    await act({ kind: "check", mode: "drained" })
  } else throw new Error(`Unknown hook scenario ${name}`)
}
