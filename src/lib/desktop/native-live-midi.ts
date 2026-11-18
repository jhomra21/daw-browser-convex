import { serializeNativeInstrumentEvents } from "@daw-browser/audio-engine/native-host-wire"
import type { NativeInstrumentEvent } from "@daw-browser/audio-engine/native-host-wire"
import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { DesktopBridge } from "~/types/desktop-bridge"

export type NativeLiveMidiNoteHandle = {
  backend: "native"
  trackId: string
  pitch: number
  noteId: number
}

type LiveNoteReadiness = {
  promise: Promise<void>
  released: boolean
  force: boolean
  noteOnQueued: boolean
  releaseQueued: boolean
}

type NativeLiveMidiHost = {
  bridge: { session: Pick<NonNullable<DesktopBridge["audioHost"]>["session"], "queueInstrumentEvents"> } | undefined
  // The controller's facts as they stand now.
  state: () => {
    hostLost: boolean
    livePreviewActive: boolean
    sampleRate: number
    transportEpoch: number
    preparedTracks: LivePlaybackSnapshot["tracks"] | undefined
    preparedNodes: AudioCoreGraphSnapshot["nodes"] | undefined
  }
  observeControl: <T>(operation: Promise<T>) => Promise<T>
  reportStopped: (message: string) => void
  ensureLivePreview: (playheadSec: number) => Promise<string>
}

// Live MIDI notes played into the native session, and the one ordered queue their events and the transport's release
// events travel through.
export const createNativeLiveMidi = (host: NativeLiveMidiHost) => {
  let nextLiveNoteId = 1
  let nextLiveEventSequence = 1_000_000
  let liveInstrumentQueueGeneration = 0
  let liveInstrumentEventTail = Promise.resolve()
  const liveNoteReadiness = new Map<number, LiveNoteReadiness>()
  const releasedLiveNoteHandles = new WeakSet<NativeLiveMidiNoteHandle>()
  let liveMidiTailOwned = false
  const resetListeners = new Set<() => void>()

  const queueLiveInstrumentEvent = (event: NativeInstrumentEvent) => {
    const bridge = host.bridge
    const live = () => {
      const now = host.state()
      return !now.hostLost && now.livePreviewActive && now.sampleRate !== 0
    }
    if (!bridge || !live()) return Promise.resolve(false)
    const generation = liveInstrumentQueueGeneration
    const bytes = serializeNativeInstrumentEvents(host.state().transportEpoch, [event])
    const queued = liveInstrumentEventTail.then(async () => {
      if (generation !== liveInstrumentQueueGeneration || !live()) return false
      try {
        const reply = await host.observeControl(bridge.session.queueInstrumentEvents(bytes))
        if (!reply.ok && generation === liveInstrumentQueueGeneration) host.reportStopped(reply.error)
        return reply.ok
      } catch (error: unknown) {
        if (generation === liveInstrumentQueueGeneration && host.state().livePreviewActive) {
          host.reportStopped(error instanceof Error ? error.message : "Native live MIDI event failed.")
        }
        return false
      }
    }).catch(() => undefined)
    liveInstrumentEventTail = queued.then(() => undefined)
    return queued
  }

  return {
    queueEvent: queueLiveInstrumentEvent,
    nextEventSequence: () => nextLiveEventSequence++,
    lastEventSequence: () => nextLiveEventSequence - 1,
    // Events queued before now are dropped when their turn comes.
    supersedeEvents: () => { liveInstrumentQueueGeneration += 1 },
    // As above, and later events no longer wait for the dropped ones.
    restartQueue: () => {
      liveInstrumentQueueGeneration += 1
      liveInstrumentEventTail = Promise.resolve()
    },
    // The session ended: its notes are gone with it.
    reset: () => {
      for (const listener of resetListeners) listener()
      liveNoteReadiness.clear()
      liveMidiTailOwned = false
    },
    hasTails: () => liveMidiTailOwned,
    subscribeReset: (listener: () => void) => {
      resetListeners.add(listener)
      return () => resetListeners.delete(listener)
    },
    startNote: (note: {
      trackId: string
      pitch: number
      velocity: number
      playheadSec?: number
    }): NativeLiveMidiNoteHandle | undefined => {
      if (!host.bridge || host.state().hostLost || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127
        || !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) return undefined
      const { preparedTracks, preparedNodes } = host.state()
      if (preparedTracks && !preparedTracks.some((track) => track.id === note.trackId)) {
        return undefined
      }
      if (preparedNodes && !preparedNodes.some((node) => (
        node.id === note.trackId && node.kind === "instrument"
      ))) {
        return undefined
      }
      const noteId = nextLiveNoteId++
      const wasReady = host.state().livePreviewActive
      const queueNoteOn = () => queueLiveInstrumentEvent({
          nodeId: note.trackId,
          noteId,
          sequence: nextLiveEventSequence++,
          frameOffset: 0,
          type: "live-note-on",
          channel: 0,
          note: note.pitch,
          value: note.velocity,
        })
      const readiness: LiveNoteReadiness = {
        promise: Promise.resolve(),
        released: false,
        force: false,
        noteOnQueued: false,
        releaseQueued: false,
      }
      const queueRelease = () => {
        if (!readiness.noteOnQueued || readiness.releaseQueued) return
        readiness.releaseQueued = true
        void queueLiveInstrumentEvent({
          nodeId: note.trackId,
          noteId,
          sequence: nextLiveEventSequence++,
          frameOffset: 0,
          type: "live-note-off",
          channel: 0,
          note: note.pitch,
          value: 0,
        }).finally(() => {
          liveNoteReadiness.delete(noteId)
        })
      }
      const queueAfterPreparation = async (result: string) => {
        const { preparedTracks: tracks, preparedNodes: nodes } = host.state()
        const instrument = nodes?.find((node) => node.id === note.trackId)?.instrument
        if (
          result !== "started"
          || readiness.force
          || (!wasReady && instrument?.kind !== "synth")
          || !tracks?.some((track) => track.id === note.trackId)
          || !nodes?.some((node) => (
            node.id === note.trackId && node.kind === "instrument"
          ))
        ) {
          liveNoteReadiness.delete(noteId)
          return
        }
        readiness.noteOnQueued = (await queueNoteOn()) === true
        if (readiness.noteOnQueued) liveMidiTailOwned = true
        if (readiness.released && readiness.noteOnQueued) queueRelease()
        else liveNoteReadiness.delete(noteId)
      }
      readiness.promise = (host.state().livePreviewActive
        ? queueAfterPreparation("started")
        : host.ensureLivePreview(note.playheadSec ?? 0).then(queueAfterPreparation)
      ).catch(() => {
        liveNoteReadiness.delete(noteId)
      })
      liveNoteReadiness.set(noteId, readiness)
      return { backend: "native", trackId: note.trackId, pitch: note.pitch, noteId }
    },
    releaseNote: (handle: NativeLiveMidiNoteHandle, force = false) => {
      if (handle.backend !== "native" || !host.bridge) return
      if (releasedLiveNoteHandles.has(handle)) return
      releasedLiveNoteHandles.add(handle)
      const readiness = liveNoteReadiness.get(handle.noteId)
      if (readiness) {
        readiness.released = true
        readiness.force = force
        void readiness.promise
        return
      }
      if (!host.state().livePreviewActive) return
      void queueLiveInstrumentEvent({
        nodeId: handle.trackId,
        noteId: handle.noteId,
        sequence: nextLiveEventSequence++,
        frameOffset: 0,
        type: "live-note-off",
        channel: 0,
        note: handle.pitch,
        value: 0,
      })
    },
  }
}
