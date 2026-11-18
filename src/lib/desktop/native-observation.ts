import { nativeGraphNodeId } from "@daw-browser/audio-engine/native-host-wire"
import type { NativeHostMeterBatch, NativeHostSpectrumFrame } from "@daw-browser/audio-engine/native-host-wire"
import type { SpectrumFrame, TrackStereoLevels, TrackStereoLevelsBatch } from "@daw-browser/audio-engine/audio-engine"
import type { DesktopBridge } from "~/types/desktop-bridge"
import type { NativeSessionReply } from "./native-publication-transaction"

type NativeSessionBridge = NonNullable<DesktopBridge["audioHost"]>["session"]

type NativeObservationSession = {
  onMeterBatch?: NativeSessionBridge["onMeterBatch"]
  onSpectrumFrame?: NativeSessionBridge["onSpectrumFrame"]
  setSpectrumNode?: NativeSessionBridge["setSpectrumNode"]
}

type NativeObservationHost = {
  session: NativeObservationSession | undefined
  transportEpoch: () => number
  // The controller's session facts as they stand now; a spectrum selection reply is judged against them.
  state: () => {
    sessionStarted: boolean
    sessionGeneration: number
    prepared: boolean
    preparedProjectId: string | undefined
    preparedProjectGeneration: number | undefined
    projectId: string | undefined
    projectGeneration: number
  }
}

type NativeObservationMaps = {
  meters: Map<bigint, string>
  spectrum: Map<string, bigint>
}

// Native track meters and the spectrum analyser as one observation: the node maps of the prepared graph, the latest
// levels and frame, and which analyser node the host has been asked to select.
export const createNativeObservation = (host: NativeObservationHost) => {
  const meterListeners = new Set<(levels: TrackStereoLevelsBatch) => void>()
  const masterMeterListeners = new Set<(levels: TrackStereoLevels) => void>()
  const spectrumListeners = new Set<(frame: SpectrumFrame | null) => void>()
  let unsubscribeMeters: (() => void) | undefined
  let unsubscribeSpectrum: (() => void) | undefined
  let meterNodeIds = new Map<bigint, string>()
  let meterRevision = 0
  let latestMeterSequence = 0n
  let levels: TrackStereoLevelsBatch = new Map()
  let masterLevels: TrackStereoLevels = { left: 0, right: 0 }
  let spectrumNodeIds = new Map<string, bigint>()
  let spectrumTarget: string | undefined
  let spectrumDesiredNodeId: bigint | null | undefined
  let spectrumSelectedNodeId: bigint | null | undefined
  let spectrumSelectionGeneration = 0
  let spectrumSelectionRequest: { generation: number; nodeId: bigint | null } | undefined
  let latestSpectrumSequence = 0n

  const resetMeters = () => {
    const next = new Map<string, TrackStereoLevels>()
    for (const nodeId of meterNodeIds.values()) {
      if (nodeId !== "master") next.set(nodeId, { left: 0, right: 0 })
    }
    levels = next
    masterLevels = { left: 0, right: 0 }
    for (const listener of meterListeners) listener(next)
    for (const listener of masterMeterListeners) listener(masterLevels)
  }

  const reconcileSpectrumSelection = (ownershipReleased = false) => {
    if (!host.state().sessionStarted) return
    const target = spectrumTarget
    spectrumDesiredNodeId = target === undefined ? null : spectrumNodeIds.get(target)
    // A target absent from the active map may be a candidate-only node. Keep
    // the request pending until publication promotes its observation map.
    const nodeId = spectrumDesiredNodeId
    if (nodeId === undefined) return
    const supersedesRequest = spectrumSelectionRequest !== undefined
      && spectrumSelectionRequest.nodeId !== nodeId
    if (nodeId === spectrumSelectedNodeId && !supersedesRequest) return
    if (!ownershipReleased && spectrumSelectionRequest?.nodeId === nodeId) return
    const session = host.session
    const requested = host.state()
    const selectionGeneration = ++spectrumSelectionGeneration
    spectrumSelectionRequest = { generation: selectionGeneration, nodeId }
    const finish = (reply: NativeSessionReply | undefined) => {
      if (spectrumSelectionRequest?.generation !== selectionGeneration) {
        // A stale successful command still changed the host. Reassert the
        // desired target after that reply, not merely the renderer cache.
        if (reply?.ok && requested.sessionGeneration === host.state().sessionGeneration
          && nodeId !== spectrumDesiredNodeId) {
          spectrumSelectedNodeId = undefined
          reconcileSpectrumSelection(true)
        }
        return
      }
      spectrumSelectionRequest = undefined
      const now = host.state()
      if (!reply?.ok || selectionGeneration !== spectrumSelectionGeneration
        || requested.sessionGeneration !== now.sessionGeneration || !now.prepared || !now.sessionStarted
        || now.preparedProjectId !== requested.projectId || now.preparedProjectGeneration !== requested.projectGeneration
        || requested.projectId !== now.projectId || requested.projectGeneration !== now.projectGeneration) return
      spectrumSelectedNodeId = nodeId
    }
    void session?.setSpectrumNode?.(nodeId).then(finish, () => finish(undefined))
  }

  const handleSpectrumFrame = (frame: NativeHostSpectrumFrame) => {
    const nodeId = spectrumNodeIds.get(spectrumTarget ?? "")
    if (
      !nodeId || frame.graphRevision !== meterRevision
      || frame.transportEpoch !== host.transportEpoch() || frame.nodeId !== nodeId
      || frame.sequence <= latestSpectrumSequence
    ) return
    latestSpectrumSequence = frame.sequence
    const next: SpectrumFrame = {
      data: frame.data,
      sampleRate: frame.sampleRateHz,
      graphRevision: frame.graphRevision,
      transportEpoch: frame.transportEpoch,
      sequence: frame.sequence,
      nodeId: frame.nodeId,
      fftSize: frame.fftSize,
      binCount: frame.binCount,
    }
    for (const listener of spectrumListeners) listener(next)
  }

  const handleMeterBatch = (batch: NativeHostMeterBatch) => {
    if (batch.graphRevision !== meterRevision || batch.transportEpoch !== host.transportEpoch()
      || batch.sequence <= latestMeterSequence) return
    latestMeterSequence = batch.sequence
    const changed = new Map<string, TrackStereoLevels>()
    let master: TrackStereoLevels | undefined
    for (const entry of batch.entries) {
      const nodeId = meterNodeIds.get(entry.nodeId)
      if (!nodeId) continue
      const next = {
        left: Math.min(1, Math.max(0, entry.leftRms)),
        right: Math.min(1, Math.max(0, entry.rightRms)),
      }
      if (nodeId === "master") master = next
      else changed.set(nodeId, next)
    }
    if (changed.size > 0) {
      levels = new Map([...levels, ...changed])
      for (const listener of meterListeners) listener(changed)
    }
    if (master) {
      masterLevels = master
      for (const listener of masterMeterListeners) listener(master)
    }
  }

  const clearSpectrumFrame = () => {
    latestSpectrumSequence = 0n
    for (const listener of spectrumListeners) listener(null)
  }

  return {
    maps: (tracks: readonly { id: string }[]): NativeObservationMaps => ({
      meters: new Map<bigint, string>([
        ...tracks.map((track) => [nativeGraphNodeId(track.id), track.id] as const),
        [nativeGraphNodeId("master"), "master"],
      ]),
      spectrum: new Map<string, bigint>([
        ...tracks.map((track) => [track.id, nativeGraphNodeId(track.id)] as const),
        ["master", nativeGraphNodeId("master")] as const,
      ]),
    }),
    promote: (revision: number, candidate: NativeObservationMaps) => {
      const previousTracks = new Set([...meterNodeIds.values()].filter((id) => id !== "master"))
      const nextTracks = new Set([...candidate.meters.values()].filter((id) => id !== "master"))
      const changed = new Map<string, TrackStereoLevels>()
      const next = new Map(levels)
      for (const id of previousTracks) {
        if (nextTracks.has(id)) continue
        next.delete(id)
        changed.set(id, { left: 0, right: 0 })
      }
      for (const id of nextTracks) {
        if (previousTracks.has(id)) continue
        next.set(id, { left: 0, right: 0 })
        changed.set(id, { left: 0, right: 0 })
      }
      const target = spectrumTarget
      const wasSelected = target !== undefined && spectrumNodeIds.has(target)
      const nextNodeId = target === undefined ? undefined : candidate.spectrum.get(target)
      meterRevision = revision
      meterNodeIds = candidate.meters
      spectrumNodeIds = candidate.spectrum
      if (target !== undefined && candidate.spectrum.has(target)) {
        spectrumDesiredNodeId = candidate.spectrum.get(target)
        reconcileSpectrumSelection(true)
      }
      levels = next
      if (changed.size > 0) {
        for (const listener of meterListeners) listener(changed)
      }

      if (target === undefined) return
      if (nextNodeId !== undefined) return
      if (!wasSelected) return
      spectrumTarget = undefined
      spectrumDesiredNodeId = null
      latestSpectrumSequence = 0n
      for (const listener of spectrumListeners) listener(null)
      if (host.state().sessionStarted) reconcileSpectrumSelection(true)
    },
    // A new prepared graph: its meters start at zero and its analyser has no frame yet.
    configure: (revision: number, tracks: readonly { id: string }[]) => {
      meterRevision = revision
      latestMeterSequence = 0n
      meterNodeIds = new Map([
        ...tracks.map((track) => [nativeGraphNodeId(track.id), track.id] as const),
        [nativeGraphNodeId("master"), "master"],
      ])
      resetMeters()
      spectrumNodeIds = new Map([
        ...tracks.map((track) => [track.id, nativeGraphNodeId(track.id)] as const),
        ["master", nativeGraphNodeId("master")] as const,
      ])
      latestSpectrumSequence = 0n
      for (const listener of spectrumListeners) listener(null)
    },
    attach: () => {
      unsubscribeMeters?.()
      unsubscribeMeters = host.session?.onMeterBatch?.(handleMeterBatch)
      unsubscribeSpectrum?.()
      unsubscribeSpectrum = host.session?.onSpectrumFrame?.(handleSpectrumFrame)
    },
    forgetSpectrumSelection: () => { spectrumSelectedNodeId = undefined },
    clear: () => {
      unsubscribeMeters?.()
      unsubscribeMeters = undefined
      resetMeters()
      meterNodeIds = new Map()
      meterRevision = 0
      latestMeterSequence = 0n
      unsubscribeSpectrum?.()
      unsubscribeSpectrum = undefined
      spectrumNodeIds = new Map()
      latestSpectrumSequence = 0n
      spectrumSelectionGeneration += 1
      spectrumDesiredNodeId = undefined
      spectrumSelectedNodeId = undefined
      spectrumSelectionRequest = undefined
      for (const listener of spectrumListeners) listener(null)
    },
    setMeterRevision: (revision: number) => { meterRevision = revision },
    clearSpectrumFrame,
    reconcileSpectrumSelection,
    subscribeTrackMeters: (listener: (levels: TrackStereoLevelsBatch) => void) => {
      meterListeners.add(listener)
      if (levels.size > 0) listener(new Map(levels))
      return () => meterListeners.delete(listener)
    },
    subscribeMasterMeter: (listener: (levels: TrackStereoLevels) => void) => {
      masterMeterListeners.add(listener)
      listener(masterLevels)
      return () => masterMeterListeners.delete(listener)
    },
    subscribeSpectrum: (targetId: string, listener: (frame: SpectrumFrame | null) => void) => {
      spectrumListeners.add(listener)
      spectrumTarget = targetId
      if (host.state().prepared) reconcileSpectrumSelection()
      listener(null)
      return () => {
        spectrumListeners.delete(listener)
        if (spectrumListeners.size === 0) {
          spectrumTarget = undefined
          reconcileSpectrumSelection(true)
        }
      }
    },
  }
}
