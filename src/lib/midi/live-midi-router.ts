import type { MidiInputEvent } from './midi-input'

export type LiveMidiNoteHandle = { readonly id: number }
type MidiNoteOnEvent = {
  sourceId: string
  timeStamp: number
  channel: number
  kind: 'note-on'
  note: number
  velocity: number
}

type ActiveNote = {
  handle: LiveMidiNoteHandle
  deferred: boolean
  stopped: boolean
}

type LiveMidiRouter = {
  receive: (event: MidiInputEvent) => void
  resetSource: (sourceId: string) => void
  panic: () => void
}

type LiveMidiRouterOptions = {
  acceptsChannel: (channel: number) => boolean
  startNote: (event: MidiNoteOnEvent) => LiveMidiNoteHandle | undefined
  releaseNote: (handle: LiveMidiNoteHandle, eventTimeStamp: number, force?: boolean) => void
  applyExpression: (event: MidiInputEvent) => void
}

const noteKey = (sourceId: string, channel: number, note: number) => `${sourceId}\u0000${channel}\u0000${note}`
const channelKey = (sourceId: string, channel: number) => `${sourceId}\u0000${channel}`

export const createLiveMidiRouter = (options: LiveMidiRouterOptions): LiveMidiRouter => {
  const active = new Map<string, ActiveNote[]>()
  const sustained = new Set<string>()

  const release = (entry: ActiveNote, timeStamp: number, force = false) => {
    if (entry.stopped) return
    entry.stopped = true
    options.releaseNote(entry.handle, timeStamp, force)
  }
  const drain = (key: string, timeStamp: number, includeHeld = false, force = false) => {
    const queue = active.get(key)
    if (!queue) return
    for (const entry of queue) {
      if (includeHeld || entry.deferred) release(entry, timeStamp, force)
    }
    const remaining = includeHeld ? [] : queue.filter((entry) => !entry.deferred)
    if (remaining.length === 0) active.delete(key)
    else active.set(key, remaining)
  }
  const drainChannel = (
    sourceId: string,
    channel: number,
    timeStamp: number,
    deferForSustain: boolean,
    includeHeld: boolean,
    force = false,
  ) => {
    const key = channelKey(sourceId, channel)
    for (const [activeKey, queue] of active) {
      if (!activeKey.startsWith(`${key}\u0000`)) continue
      if (deferForSustain && sustained.has(key)) {
        for (const entry of queue) entry.deferred = true
      } else {
        drain(activeKey, timeStamp, includeHeld, force)
      }
    }
  }
  const hasActiveOnChannel = (sourceId: string, channel: number) => (
    Array.from(active.keys()).some((key) => key.startsWith(`${channelKey(sourceId, channel)}\u0000`))
  )

  return {
    receive: (event) => {
      if (event.kind === 'note-on') {
        if (!options.acceptsChannel(event.channel)) return
        const handle = options.startNote({ ...event, kind: 'note-on' })
        if (!handle) return
        const key = noteKey(event.sourceId, event.channel, event.note)
        const queue = active.get(key) ?? []
        queue.push({ handle, deferred: false, stopped: false })
        active.set(key, queue)
        return
      }
      if (event.kind === 'note-off') {
        const key = noteKey(event.sourceId, event.channel, event.note)
        const queue = active.get(key)
        const entry = queue?.find((candidate) => !candidate.deferred)
        if (!entry) return
        if (sustained.has(channelKey(event.sourceId, event.channel))) {
          entry.deferred = true
          return
        }
        release(entry, event.timeStamp)
        const remaining = queue?.filter((candidate) => candidate !== entry) ?? []
        if (remaining.length === 0) active.delete(key)
        else active.set(key, remaining)
        return
      }
      if (event.kind !== 'control-change') {
        if (!options.acceptsChannel(event.channel)) return
        options.applyExpression(event)
        return
      }
      const key = channelKey(event.sourceId, event.channel)
      if (event.controller === 64) {
        if (!options.acceptsChannel(event.channel) && !hasActiveOnChannel(event.sourceId, event.channel)) return
        if (event.value >= 0.5) sustained.add(key)
        else if (sustained.delete(key)) drainChannel(event.sourceId, event.channel, event.timeStamp, false, false)
      } else if (event.controller === 120) {
        if (!options.acceptsChannel(event.channel) && !hasActiveOnChannel(event.sourceId, event.channel)) return
        sustained.delete(key)
        drainChannel(event.sourceId, event.channel, event.timeStamp, false, true, true)
      } else if (event.controller === 121) {
        if (!options.acceptsChannel(event.channel) && !hasActiveOnChannel(event.sourceId, event.channel)) return
        if (sustained.delete(key)) drainChannel(event.sourceId, event.channel, event.timeStamp, false, false)
      } else if (event.controller === 123) {
        if (!options.acceptsChannel(event.channel) && !hasActiveOnChannel(event.sourceId, event.channel)) return
        drainChannel(event.sourceId, event.channel, event.timeStamp, true, true)
      } else {
        if (!options.acceptsChannel(event.channel)) return
      }
      options.applyExpression(event)
    },
    resetSource: (sourceId) => {
      for (const [key, queue] of active) {
        if (!key.startsWith(`${sourceId}\u0000`)) continue
        for (const entry of queue) release(entry, Number.NaN, true)
        active.delete(key)
      }
      for (const key of sustained) if (key.startsWith(`${sourceId}\u0000`)) sustained.delete(key)
    },
    panic: () => {
      for (const queue of active.values()) for (const entry of queue) release(entry, Number.NaN, true)
      active.clear()
      sustained.clear()
    },
  }
}
