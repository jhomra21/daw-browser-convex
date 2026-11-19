import type { createNativePlaybackController } from "../../../src/lib/desktop/native-playback-controller"
import type { PreparedStretchArtifactLease } from "@daw-browser/audio-engine/prepared-stretch-store"

type LateCommitObservation = {
  input: (original: Parameters<typeof createNativePlaybackController>[0]) => Parameters<typeof createNativePlaybackController>[0];
  controller: (original: ReturnType<typeof createNativePlaybackController>) => ReturnType<typeof createNativePlaybackController>;
  lease: (invoke: () => Promise<PreparedStretchArtifactLease>) => Promise<PreparedStretchArtifactLease>;
  invoke: (key: string, operation: string) => Promise<string>;
  scriptInstalled: () => void;
  registrationReturned?: () => void;
}

// Serialized into an acceptance-only new-document script. No production import,
// global raw bridge, extra native subscription, recurring task, or project access.
export const installLateCommitObservation = (
  nonce: string, onScriptInstalled: () => void, onRegistrationReturned?: () => void,
) => {
  type Controller = ReturnType<typeof createNativePlaybackController>
  type Input = Parameters<typeof createNativePlaybackController>[0]
  const trace: { sequence: number; epochMs: number; event: string; operation?: string; ok?: boolean }[] = []
  const subscriptions = { meter: 0, spectrum: 0, schedule: 0, loss: 0 }
  const counters = { begins: 0, commits: 0, starts: 0, stops: 0, teardowns: 0,
    mappedCreates: 0, leaseAcquires: 0, leaseReleases: 0, liveLeaseHandles: 0,
    duplicateLeaseReleases: 0, progressEvents: 0, faults: 0 }
  const operations = new Set<Promise<unknown>>()
  const waiters = new Set<() => void>()
  let controller: Controller | undefined
  let armed = false
  let consumed = false
  let held = false
  let overflow = false
  let release: (() => void) | undefined
  let heldSequence = 0
  let closed = false
  const notify = () => { for (const waiter of waiters) waiter() }
  const record = (event: string, operation?: string, ok?: boolean) => {
    if (trace.length < 2048) trace.push({ sequence: trace.length + 1, epochMs: Date.now(), event, operation, ok })
    else overflow = true
    notify()
  }
  const track = <Value>(promise: Promise<Value>): Promise<Value> => {
    operations.add(promise)
    void promise.then(() => operations.delete(promise), () => operations.delete(promise))
    return promise
  }
  const wait = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (closed) { waiters.delete(check); reject(new Error("Acceptance observation closed.")) }
      else if (predicate()) { waiters.delete(check); resolve() }
    }
    waiters.add(check)
    check()
  })
  const call = async <Value extends { ok: boolean }>(operation: string, invoke: () => Promise<Value>) => {
    record("request", operation)
    let result: Value
    try { result = await invoke() } catch (error) { record("bridge-rejection", operation); throw error }
    record("bridge-reply", operation, result.ok)
    if (operation === "commitTransaction" && result.ok && armed) {
      armed = false
      if (controller?.getPendingStart()?.mode !== "play") {
        record("gate-owner-mismatch", operation)
        throw new Error("Acceptance gate requires the actual pending Play attempt.")
      }
      consumed = true
      held = true
      // The original contextBridge promise has completed. Main's handler awaits
      // supervisor Commit before ok=true; no native ACK/transaction queue is held.
      const delivery = new Promise<void>((resolve) => { release = resolve })
      heldSequence = trace.length + 1
      record("delivery-held", operation, true)
      await delivery
      held = false
      release = undefined
    }
    record("renderer-delivery", operation, result.ok)
    return result
  }
  const input = (original: Input): Input => {
    const bridge = original.bridge
    if (!bridge) return original
    const session = bridge.session
    const subscribe = <Value>(
      key: keyof typeof subscriptions, originalSubscribe: (listener: (value: Value) => void) => () => void,
      listener: (value: Value) => void,
    ) => {
      const off = originalSubscribe((value) => {
        if (key === "schedule") { counters.progressEvents++; notify() }
        listener(value)
      })
      subscriptions[key]++
      record("subscribe", key)
      let retired = false
      return () => {
        off()
        if (!retired) { retired = true; subscriptions[key]--; record("unsubscribe", key) }
      }
    }
    return {
      ...original,
      reportFault: (fault, options) => { counters.faults++; record("product-fault"); original.reportFault?.(fault, options) },
      bridge: {
        ...bridge,
        session: {
          ...session,
          beginTransaction: () => {
            counters.begins++
            return call("beginTransaction", () => session.beginTransaction())
          },
          commitTransaction: (token) => {
            counters.commits++
            return call("commitTransaction", () => session.commitTransaction(token))
          },
          createMappedAsset: session.createMappedAsset ? (asset, token) => {
            counters.mappedCreates++
            return call("createMappedAsset", () => session.createMappedAsset!(asset, token))
          } : undefined,
          start: () => { counters.starts++; return call("start", () => session.start()) },
          stop: (reason: string) => { counters.stops++; return call("stop", () => session.stop(reason)) },
          teardown: () => { counters.teardowns++; return call("teardown", () => session.teardown()) },
          onMeterBatch: (listener) => subscribe("meter", session.onMeterBatch.bind(session), listener),
          onSpectrumFrame: session.onSpectrumFrame
            ? (listener) => subscribe("spectrum", session.onSpectrumFrame!.bind(session), listener) : undefined,
          onScheduleProgress: (listener) => subscribe("schedule", session.onScheduleProgress.bind(session), listener),
          onLoss: (listener) => subscribe("loss", session.onLoss.bind(session), listener),
        },
      },
    }
  }
  const observeController = (original: Controller): Controller => {
    const observed = {
      ...original,
      start: (...args: Parameters<Controller["start"]>) => track(original.start(...args).then((result) => {
        record("start-settled")
        return result
      })),
      dispose: (...args: Parameters<Controller["dispose"]>) => track(original.dispose(...args).then(() => {
        record("dispose-settled")
      })),
      pause: (...args: Parameters<Controller["pause"]>) => track(original.pause(...args)),
    }
    controller = observed
    record("controller-created")
    return observed
  }
  const lease = async (invoke: () => Promise<PreparedStretchArtifactLease>) => {
    const original = await invoke()
    counters.leaseAcquires++
    counters.liveLeaseHandles++
    record("lease-acquired")
    let retired = false
    return {
      ...original,
      release: () => track(original.release().then(() => {
        if (retired) counters.duplicateLeaseReleases++
        else { retired = true; counters.leaseReleases++; counters.liveLeaseHandles-- }
        record("lease-release-completed")
      })),
    }
  }
  const snapshot = () => ({
    held, armed, consumed, overflow, prepared: controller?.isPrepared() ?? null,
    active: controller?.isActive() ?? null, pendingOperations: operations.size,
    subscriptions: { ...subscriptions }, counters: { ...counters }, trace: [...trace],
  })
  const releaseGate = () => { if (release) { record("gate-release"); release() } }
  const invoke = async (key: string, operation: string) => {
    if (key !== nonce) throw new Error("Acceptance observation capability mismatch.")
    if (operation.startsWith("ui-")) record("ui-request", operation.slice(3))
    else if (operation === "arm") {
      if (!controller || consumed || armed || held || controller.isPrepared() || controller.getPendingStart() || operations.size)
        throw new Error("Fresh stopped controller required for one-shot acceptance gate.")
      armed = true
      record("gate-armed")
    } else if (operation === "held") await wait(() => held)
    else if (operation === "stopped") await wait(() => {
      const stop = trace.find((entry) => entry.sequence > heldSequence && entry.operation === "stop"
        && (entry.event === "bridge-reply" || entry.event === "bridge-rejection"))
      const teardown = trace.find((entry) => entry.sequence > heldSequence && entry.operation === "teardown"
        && (entry.event === "bridge-reply" || entry.event === "bridge-rejection"))
      return held && Boolean(stop && teardown)
    })
    else if (operation === "release") releaseGate()
    else if (operation === "stop-settled") {
      // Hook Stop awaits its preliminary Pause before calling dispose(), so the
      // tracked-operation snapshot in "settle" can drain inside that gap.
      const uiStop = trace.findLast((entry) => entry.event === "ui-request" && entry.operation === "stop")
      if (!uiStop) throw new Error("Stop settlement requires a recorded UI Stop.")
      await wait(() => trace.some((entry) => entry.sequence > uiStop.sequence && entry.event === "dispose-settled"))
      await Promise.allSettled(operations)
      record("ownership-settled")
    } else if (operation === "settle") {
      const pending = controller?.getPendingStart()
      if (pending) await pending.promise.catch(() => undefined)
      await Promise.allSettled(operations)
      record("ownership-settled")
    } else if (operation === "progress") {
      const before = counters.progressEvents
      await wait(() => counters.progressEvents >= before + 2)
    } else if (operation === "close") { releaseGate(); closed = true; notify() }
    else if (operation !== "snapshot") throw new Error("Unknown acceptance observation operation.")
    return JSON.stringify(snapshot())
  }
  const observation: LateCommitObservation = { input, controller: observeController, lease, invoke, scriptInstalled: onScriptInstalled }
  if (onRegistrationReturned) observation.registrationReturned = onRegistrationReturned
  Object.defineProperty(globalThis, "__dawLateCommitObservation", { configurable: true, value: observation })
}
