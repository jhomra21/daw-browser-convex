import "fake-indexeddb/auto"

export type VirtualWorkKind = "fire-timer" | "raf-tick" | "idb-task" | "persist-fail"
export type VirtualWork = {
  id: number
  kind: VirtualWorkKind
  site: string
  run: () => void
  cancelled: boolean
  fired?: boolean
  delay?: number
  due?: number
}
export type VirtualTime = ReturnType<typeof createVirtualTime>

type RecordEvent = <Value>(event: Value) => void

// Semantic attribution: a timer belongs to the processor path when product code that owns processor waits (controller, owner,
// coordinator, live control, the panel's flush) asked for it, whatever helper or function name it went through. The hook's lifecycle
// deadline and host supervisor timers are other owners'.
const processorWaitOwners = /\/src\/(lib\/desktop\/native-|lib\/live-processor-control|components\/timeline\/create-effects-panel|components\/Timeline\.tsx)/
export const isProcessorWaitTimer = (site: string) => {
  const origin = site.split("\n").find((frame) => frame.includes("/src/") || frame.includes("/apps/"))
  return origin !== undefined && processorWaitOwners.test(origin)
}
const callSite = () => new Error().stack?.split("\n").slice(2, 10).join("\n") ?? "unknown"

export const createVirtualTime = (record: RecordEvent) => {
  const work: VirtualWork[] = []
  const active = new Map<number, VirtualWork>()
  const immediateIds = new WeakMap<object, number>()
  const pendingEffectTransactions = new Set<IDBTransaction>()
  // Creation ordinals identify which write a failure position targets.
  const effectOrdinals = new Map<IDBTransaction, number>()
  // Lifecycle of every effect write, so a scenario can land an event while a known write is open.
  const effectStates = new Map<number, "open" | "complete" | "aborted">()
  let effectWrites = 0
  let nextId = 0
  let installed = false
  let restoring = false
  let now = 0
  let escapeNextTimer = false
  const escapedTimers = new Set<number | NodeJS.Timeout>()
  let escaped = Promise.withResolvers<void>()
  const dateNowDescriptor = Object.getOwnPropertyDescriptor(Date, "now")
  const performanceNowDescriptor = Object.getOwnPropertyDescriptor(performance, "now")

  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const globalDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>([
    ["setTimeout", Object.getOwnPropertyDescriptor(globalThis, "setTimeout")],
    ["clearTimeout", Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")],
    ["requestAnimationFrame", Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame")],
    ["cancelAnimationFrame", Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame")],
    ["setImmediate", Object.getOwnPropertyDescriptor(globalThis, "setImmediate")],
    ["clearImmediate", Object.getOwnPropertyDescriptor(globalThis, "clearImmediate")],
  ])
  const transactionPrototype = globalThis.IDBDatabase.prototype
  const transactionDescriptor = Object.getOwnPropertyDescriptor(transactionPrototype, "transaction")

  const enqueue = (kind: VirtualWorkKind, site: string, run: () => void) => {
    const entry: VirtualWork = { id: ++nextId, kind, site, run, cancelled: false }
    work.push(entry)
    active.set(entry.id, entry)
    record({ event: "virtual-work-scheduled", id: entry.id, kind, site })
    return entry
  }
  const cancel = (id: number, kind: VirtualWorkKind) => {
    const entry = active.get(id)
    if (!entry || entry.kind !== kind) return
    entry.cancelled = true
    active.delete(id)
    record({ event: "virtual-work-cancelled", id, kind, site: entry.site })
  }

  const install = () => {
    if (installed) throw new Error("Virtual time already installed")
    installed = true
    restoring = false
    const virtualSetTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const callback = handler instanceof Function ? () => handler(...args) : () => undefined
      if (escapeNextTimer) {
        escapeNextTimer = false
        // Mutation: deliberately fail to own a timer requested by product code.
        // Its real callback, not a sleep, wakes the test and trips the sentinel.
        const handle = realSetTimeout(() => { callback(); escaped.resolve() }, timeout)
        escapedTimers.add(handle)
        record({ event: "mutation-unowned-product-timer", site: callSite(), delay: timeout })
        return handle
      }
      const entry = enqueue("fire-timer", `setTimeout(${timeout ?? 0})\n${callSite()}`, callback)
      entry.delay = timeout ?? 0
      entry.due = now + entry.delay
      return entry.id
    }
    const virtualClearTimeout = (id?: number | NodeJS.Timeout) => {
      if (id !== undefined && escapedTimers.has(id)) {
        realClearTimeout(id); escapedTimers.delete(id); escaped.resolve()
      } else cancel(Number(id), "fire-timer")
    }
    const virtualRequestAnimationFrame = (callback: FrameRequestCallback) => {
      const entry = enqueue("raf-tick", `requestAnimationFrame\n${callSite()}`, () => callback(now))
      entry.due = now + 1000 / 60
      return entry.id
    }
    const virtualCancelAnimationFrame = (id: number) => cancel(id, "raf-tick")
    const virtualSetImmediate = (callback: (...args: never[]) => void) => {
      const entry = enqueue("idb-task", `setImmediate\n${callSite()}`, callback)
      immediateIds.set(entry, entry.id)
      return entry
    }
    const virtualClearImmediate = (handle: NodeJS.Immediate) => {
      const id = immediateIds.get(handle)
      if (id !== undefined) cancel(id, "idb-task")
    }
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: virtualSetTimeout })
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, writable: true, value: virtualClearTimeout })
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: virtualRequestAnimationFrame })
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: virtualCancelAnimationFrame })
    Object.defineProperty(globalThis, "setImmediate", { configurable: true, writable: true, value: virtualSetImmediate })
    Object.defineProperty(globalThis, "clearImmediate", { configurable: true, writable: true, value: virtualClearImmediate })
    Object.defineProperty(Date, "now", { configurable: true, value: () => 1_700_000_000_000 + now })
    Object.defineProperty(performance, "now", { configurable: true, value: () => now })

    if (transactionDescriptor) {
      const original = transactionPrototype.transaction
      const wrapped = function (
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        const transaction = original.call(this, storeNames, mode, options)
        const stores = Array.isArray(storeNames) ? storeNames : [storeNames]
        if (mode === "readwrite" && stores.includes("entities")) {
          pendingEffectTransactions.add(transaction)
          const ordinal = ++effectWrites
          effectOrdinals.set(transaction, ordinal)
          effectStates.set(ordinal, "open")
          transaction.addEventListener("complete", () => { pendingEffectTransactions.delete(transaction); effectStates.set(ordinal, "complete") }, { once: true })
          transaction.addEventListener("abort", () => { pendingEffectTransactions.delete(transaction); effectStates.set(ordinal, "aborted") }, { once: true })
          record({ event: "effect-write-transaction", stores, site: callSite() })
        }
        return transaction
      }
      Object.defineProperty(transactionPrototype, "transaction", { ...transactionDescriptor, value: wrapped })
    }
  }

  const restore = () => {
    if (!installed || restoring) return
    restoring = true
    for (const [name, descriptor] of globalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    if (transactionDescriptor) Object.defineProperty(transactionPrototype, "transaction", transactionDescriptor)
    for (const handle of escapedTimers) realClearTimeout(handle)
    escapedTimers.clear()
    if (dateNowDescriptor) Object.defineProperty(Date, "now", dateNowDescriptor)
    else Reflect.deleteProperty(Date, "now")
    if (performanceNowDescriptor) Object.defineProperty(performance, "now", performanceNowDescriptor)
    else Reflect.deleteProperty(performance, "now")
    for (const entry of work) if (!entry.fired && !entry.cancelled) cancel(entry.id, entry.kind)
    pendingEffectTransactions.clear()
    installed = false
    restoring = false
  }

  // IndexedDB tasks are FIFO tasks, not freely reorderable requests. Draining
  // microtasks between selections preserves fake-indexeddb's transaction rules.
  const enabled = () => {
    const pending = [...active.values()]
    const firstIdb = pending.find((entry) => entry.kind === "idb-task")
    const firstTimer = pending.filter((entry) => entry.kind === "fire-timer")
      .reduce<VirtualWork | undefined>((first, entry) => !first || (entry.due ?? 0) < (first.due ?? 0) ? entry : first, undefined)
    return pending.filter((entry) => (entry.kind !== "idb-task" || entry === firstIdb)
      && (entry.kind !== "fire-timer" || entry === firstTimer))
  }
  const run = (id: number) => {
    const entry = enabled().find((entry) => entry.id === id)
    if (!entry) throw new Error(`No enabled virtual work ${id}`)
    entry.fired = true
    active.delete(id)
    now = Math.max(now, entry.due ?? now)
    record({ event: "virtual-work-fired", id, kind: entry.kind, site: entry.site })
    entry.run()
  }
  const failNextPersistence = () => {
    const transaction = pendingEffectTransactions.values().next().value
    if (!transaction) throw new Error("persist-fail without pending effect write")
    record({ event: "persist-fail-abort" })
    transaction.abort()
    pendingEffectTransactions.delete(transaction)
  }
  const sentinel = () => {
    let didFire = false
    const id = realSetTimeout(() => { didFire = true }, 0)
    return {
      fired: () => didFire,
      clear: () => realClearTimeout(id),
    }
  }

  return {
    install,
    restore,
    enabled,
    run,
    failNextPersistence,
    canFailPersistence: () => pendingEffectTransactions.size > 0,
    // Ordinal of the write persist-fail would abort, and the writes started so far.
    nextFailureOrdinal: () => {
      const transaction = pendingEffectTransactions.values().next().value
      return transaction && effectOrdinals.get(transaction)
    },
    effectWrites: () => effectWrites,
    effectTransactions: () => [...effectStates].map(([ordinal, state]) => ({ ordinal, state })),
    scheduleDeadline: (site: string, callback: () => void) => {
      const entry = enqueue("fire-timer", site, callback)
      entry.delay = 2000; entry.due = now + 2000
      return entry.id
    },
    cancelExternal: (id: number) => cancel(id, "fire-timer"),
    inventory: () => work.map(({ run: _run, ...entry }) => entry),
    armEscape: () => { escapeNextTimer = true; escaped = Promise.withResolvers<void>() },
    hasEscaped: () => escapedTimers.size > 0,
    waitEscape: () => escaped.promise,
    sentinel,
  }
}
