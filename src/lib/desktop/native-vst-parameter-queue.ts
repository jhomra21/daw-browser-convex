import { serializeNativeVstParameterEvents } from "@daw-browser/audio-engine/native-host-wire"
import { maxVst3WorkerEventsPerBlock } from "@daw-browser/plugin-host-protocol"

export type NativeSessionReply = { ok: true } | { ok: false; error: string }

export type NativeVstParameterEvent = {
  instanceId: string
  id: number
  value: number
}

export type NativeVstParameterSender = (bytes: Uint8Array) => Promise<NativeSessionReply>
export type NativeVstParameterQueue = {
  enqueue: (event: NativeVstParameterEvent) => Promise<boolean>
  dispose: () => void
}

type PendingEntry = {
  event: NativeVstParameterEvent
  waiters: Array<(delivered: boolean) => void>
}

const keyFor = (event: NativeVstParameterEvent) => `${event.instanceId}:${event.id}`

export const createNativeVstParameterQueue = (
  send: NativeVstParameterSender,
): NativeVstParameterQueue => {
  const pending = new Map<string, PendingEntry>()
  const activeByKey = new Map<string, PendingEntry>()
  let inFlight = false
  let drainScheduled = false
  let disposed = false

  const resolveWaiters = (entry: PendingEntry, delivered: boolean) => {
    const waiters = entry.waiters
    entry.waiters = []
    for (const resolve of waiters) resolve(delivered)
  }

  const sendPayload = async (instanceId: string, events: NativeVstParameterEvent[]) => {
    try {
      const bytes = serializeNativeVstParameterEvents(instanceId, events.map((event) => ({
        id: event.id,
        value: event.value,
        sampleOffset: 0,
      })))
      const reply = await send(bytes)
      return reply.ok
    } catch {
      return false
    }
  }

  const drain = async () => {
    if (inFlight || disposed) return
    inFlight = true
    try {
      while (!disposed && pending.size > 0) {
        const snapshot = [...pending.values()]
        pending.clear()
        for (const entry of snapshot) {
          activeByKey.set(keyFor(entry.event), entry)
        }
        const grouped = new Map<string, PendingEntry[]>()
        for (const entry of snapshot) {
          const events = grouped.get(entry.event.instanceId) ?? []
          events.push(entry)
          grouped.set(entry.event.instanceId, events)
        }
        for (const [instanceId, entries] of grouped) {
          for (let offset = 0; offset < entries.length; offset += maxVst3WorkerEventsPerBlock) {
            const chunk = entries.slice(offset, offset + maxVst3WorkerEventsPerBlock)
            const delivered = !disposed && await sendPayload(
              instanceId,
              chunk.map((entry) => entry.event),
            )
            for (const entry of chunk) {
              activeByKey.delete(keyFor(entry.event))
              resolveWaiters(entry, delivered)
            }
          }
        }
      }
    } finally {
      inFlight = false
    }
  }

  const scheduleDrain = () => {
    if (inFlight || drainScheduled || disposed) return
    drainScheduled = true
    void Promise.resolve().then(() => {
      drainScheduled = false
      void drain()
    })
  }

  const enqueue = (event: NativeVstParameterEvent) => {
    if (disposed) return Promise.resolve(false)
    const key = keyFor(event)
    const current = pending.get(key)
    const active = activeByKey.get(key)
    const promise = new Promise<boolean>((resolve) => {
      if (current) {
        resolveWaiters(current, false)
        pending.set(key, {
          event,
          waiters: [resolve],
        })
        return
      }
      if (active) {
        resolveWaiters(active, false)
      }
      pending.set(key, { event, waiters: [resolve] })
    })
    scheduleDrain()
    return promise
  }

  return {
    enqueue,
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of pending.values()) resolveWaiters(entry, false)
      for (const entry of activeByKey.values()) resolveWaiters(entry, false)
      pending.clear()
      activeByKey.clear()
    },
  }
}
