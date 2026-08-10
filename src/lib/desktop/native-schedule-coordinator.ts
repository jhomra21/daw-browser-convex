import {
  serializeNativeInstrumentEvents,
  serializeNativeScheduleWindow,
  serializeNativeVstScheduleAutomationEnable,
} from "@daw-browser/audio-engine/native-host-wire"
import type {
  NativeInstrumentEvent,
  NativeScheduleProgress,
  NativeSessionAsset,
  NativeSourceEvent,
  NativeVstAutomationSegment,
} from "@daw-browser/audio-engine/native-host-wire"
import { compilePortableFrameScheduleWindow } from "~/lib/portable-frame-schedule"
import { projectPortableClipEvents } from "@daw-browser/audio-engine/portable-clip-projector"
import type { PortablePreparedStretchAsset } from "@daw-browser/audio-engine/portable-stretch-preparation"
import type { AudioAssetRef, AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import { parseExternalAutomationParameterId, valueAtAutomationTime } from "@daw-browser/shared"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import { maxVst3WorkerFrames } from "@daw-browser/plugin-host-protocol"

type NativeSessionReply = { ok: true } | { ok: false; error: string }

export type NativeScheduleCoordinatorBridge = {
  queueScheduleWindow: (bytes: Uint8Array, transactionToken?: string) => Promise<NativeSessionReply>
  queueInstrumentEvents: (bytes: Uint8Array, transactionToken?: string) => Promise<NativeSessionReply>
  reenableVstScheduleAutomation?: (bytes: Uint8Array, transactionToken?: string) => Promise<NativeSessionReply>
  onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => () => void
  onLoss: (listener: (error?: string) => void) => () => void
}

export type NativeScheduleCapacity = {
  maximumFramesPerBlock: number
  maximumVstEventsPerBlock?: number
}

export type NativeScheduleCoordinator = {
  install: () => void
  dispose: () => void
  preflight: (graph: AudioCoreGraphSnapshot) => void
  queueInitialSynthState: (frame: number, transactionToken?: string) => Promise<void>
  prime: (frame: number, transactionToken?: string) => Promise<void>
  onProgress: (progress: NativeScheduleProgress) => void
  waitForAccepted: (minimumFrame: number) => Promise<void>
  waitForTransition: (transitionId: bigint, running: boolean) => Promise<void>
  waitForUrgent: (sequence: bigint) => Promise<void>
  reenableAutomation: (instanceId: string, parameterIds: readonly number[], transactionToken?: string) => Promise<void>
  currentProgress: () => NativeScheduleProgress | undefined
  currentFrame: () => number
  scheduleEndFrame: () => number
  isDisposed: () => boolean
}

const nativeInstrumentEventBatchSize = 256
const nativeScheduleChunkCount = 16
const nativeScheduleSubmissionAttempts = 8
const nativeScheduleRefillRetryLimit = 8
const nativeScheduleLookaheadSec = 2
const nativeScheduleRefillThresholdSec = 1
const nativeInstrumentEventCapacity = 256
const nativeProcessorEventCapacity = 256
const nativeSourceCapacity = 256
const nativeVoiceCapacity = 32
const nativeSourceLedgerCapacity = 1024

const assertReply = (reply: NativeSessionReply) => {
  if (!reply.ok) throw new Error(reply.error)
}

const clampNormalized = (value: number) => Math.min(1, Math.max(0, value))

const synthStateEvents = (snapshot: LivePlaybackSnapshot, frame: number): NativeInstrumentEvent[] => (
  snapshot.tracks
    .filter((track) => snapshot.mixer.fx.trackFx?.[track.id]?.instrument?.kind === "synth")
    .flatMap((track, synthIndex) => {
      const instrument = snapshot.mixer.fx.trackFx?.[track.id]?.instrument
      if (!instrument || instrument.kind !== "synth") return []
      const params = instrument.params
      const values = [
        params.gain,
        params.pan,
        params.filter.frequencyHz,
        params.filter.q,
        params.ampEnvelope.attackSec * 1000,
        params.ampEnvelope.decaySec * 1000,
        params.ampEnvelope.sustain,
        params.ampEnvelope.releaseSec * 1000,
      ]
      return values.map((value, target) => ({
        nodeId: track.id,
        noteId: 1,
        sequence: synthIndex * values.length + target + 1,
        frameOffset: frame,
        type: "parameter" as const,
        channel: 0,
        note: target + 1,
        value,
      }))
    })
)

export const nativeVstAutomationSegmentsForSnapshot = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
  startFrame: number,
  endFrame: number,
): NativeVstAutomationSegment[] => {
  const plan = snapshot.nativeExternalAttachmentPlan
  if (!plan) return []
  const attachments = new Map(plan.attachments.map((attachment) => [attachment.instanceId, attachment]))
  return snapshot.mixer.automationEnvelopes.flatMap((envelope) => {
    const parsed = parseExternalAutomationParameterId(envelope.parameterId)
    const attachment = parsed ? attachments.get(parsed.instanceId) : undefined
    const descriptor = attachment?.parameters?.find((parameter) => parameter.id === parsed?.parameterId)
    if (!parsed || !attachment || attachment.bypassed || !envelope.enabled
      || descriptor?.readOnly === true
      || envelope.points.length === 0) return []
    const targetMatches = envelope.target.kind === "master"
      ? attachment.graphNodeId === "master"
      : attachment.graphNodeId === envelope.target.trackId
    if (!targetMatches) return []
    const points = envelope.points
    const pointFrames = points.map((point) => Math.round(point.timeSec * sampleRateHz))
    const fallback = descriptor?.defaultValue ?? 0
    const segments: NativeVstAutomationSegment[] = []
    const appendSegment = (
      segmentStart: number,
      segmentEnd: number,
      interpolation: "linear" | "hold",
    ) => {
      if (segmentStart >= segmentEnd) return
      segments.push({
        instanceId: attachment.instanceId,
        parameterId: parsed.parameterId,
        startFrame: segmentStart,
        endFrame: segmentEnd,
        startValue: clampNormalized(valueAtAutomationTime(points, segmentStart / sampleRateHz, fallback)),
        endValue: clampNormalized(valueAtAutomationTime(points, segmentEnd / sampleRateHz, fallback)),
        interpolation,
      })
    }
    const firstFrame = pointFrames[0] ?? endFrame
    appendSegment(
      startFrame,
      Math.min(endFrame, firstFrame),
      "hold",
    )
    for (let index = 0; index < points.length - 1; index += 1) {
      const point = points[index]
      const pointFrame = pointFrames[index] ?? endFrame
      const nextFrame = pointFrames[index + 1] ?? endFrame
      const segmentStart = Math.max(startFrame, pointFrame)
      const segmentEnd = Math.min(endFrame, nextFrame)
      appendSegment(segmentStart, segmentEnd, point.interpolation === "linear" ? "linear" : "hold")
    }
    const lastFrame = pointFrames[pointFrames.length - 1] ?? startFrame
    appendSegment(Math.max(startFrame, lastFrame), endFrame, "hold")
    return segments
  }).sort((left, right) => (
    left.instanceId.localeCompare(right.instanceId)
      || left.parameterId - right.parameterId
      || left.startFrame - right.startFrame
  ))
}

const sourceKey = (event: NativeSourceEvent) => (
  `${event.sourceNodeId}:${event.assetId}:${event.stopFrame}:${event.fadeOutEndFrame}`
)

type ScheduleLedgers = {
  activeNoteIds: Set<string>
  emittedSources: Map<string, number>
}

export type NativeLoopFrames = {
  startFrame: number
  endFrame: number
  lengthFrames: number
}

export const nativeLoopFramesForSnapshot = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
): NativeLoopFrames | undefined => {
  if (!snapshot.transport.loopEnabled) return undefined
  const startFrame = Math.round(snapshot.transport.loopStartSec * sampleRateHz)
  const endFrame = Math.round(snapshot.transport.loopEndSec * sampleRateHz)
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
    || startFrame < 0 || endFrame <= startFrame) return undefined
  return { startFrame, endFrame, lengthFrames: endFrame - startFrame }
}

export const arrangementFrameForNativeFrame = (
  frame: number,
  loop: NativeLoopFrames | undefined,
) => {
  if (!loop || frame < loop.endFrame) return frame
  return loop.startFrame + ((frame - loop.startFrame) % loop.lengthFrames + loop.lengthFrames) % loop.lengthFrames
}

type NativeScheduleSlice = {
  nativeStartFrame: number
  nativeEndFrame: number
  arrangementStartFrame: number
  arrangementEndFrame: number
  iteration: number
  reachesLoopBoundary: boolean
}

const splitNativeScheduleRange = (
  startFrame: number,
  endFrame: number,
  loop: NativeLoopFrames | undefined,
): NativeScheduleSlice[] => {
  if (!loop) return [{
    nativeStartFrame: startFrame,
    nativeEndFrame: endFrame,
    arrangementStartFrame: startFrame,
    arrangementEndFrame: endFrame,
    iteration: 0,
    reachesLoopBoundary: false,
  }]
  const slices: NativeScheduleSlice[] = []
  let cursor = startFrame
  while (cursor < endFrame) {
    const beforeLoop = cursor < loop.startFrame
    const arrangementStartFrame = beforeLoop
      ? cursor
      : arrangementFrameForNativeFrame(cursor, loop)
    const nativeBoundary = beforeLoop
      ? loop.startFrame
      : cursor + loop.endFrame - arrangementStartFrame
    const nativeEndFrame = Math.min(endFrame, nativeBoundary)
    slices.push({
      nativeStartFrame: cursor,
      nativeEndFrame,
      arrangementStartFrame,
      arrangementEndFrame: arrangementStartFrame + nativeEndFrame - cursor,
      iteration: beforeLoop ? 0 : Math.floor((cursor - loop.startFrame) / loop.lengthFrames) + 1,
      reachesLoopBoundary: nativeEndFrame === nativeBoundary,
    })
    cursor = nativeEndFrame
  }
  return slices
}

type ScheduleWindowCandidate = {
  instrumentEvents: NativeInstrumentEvent[]
  instrumentEventKeys: string[]
  sampleSourceEvents: NativeSourceEvent[]
  vstAutomationSegments: NativeVstAutomationSegment[]
  noteChanges: Array<[string, boolean]>
  sourceChanges: Array<[string, number]>
  sequenceCount: number
}

const tailFramesFor = (
  snapshot: LivePlaybackSnapshot,
  graph: AudioCoreGraphSnapshot | undefined,
  sampleRateHz: number,
) => {
  const tailByNode = new Map<string, number>()
  for (const node of graph?.nodes ?? []) {
    let nodeTail = 0
    for (const processor of node.processorOrder) {
      // Unbounded tails are continued by the native host's tail observer and
      // end only through explicit Stop/teardown. They must not turn the
      // schedule into an arbitrary finite padding window.
      if (processor.tailKind === "unbounded") continue
      nodeTail += Math.max(0, processor.tailFrames)
    }
    if (node.instrument && "ampReleaseMs" in node.instrument) {
      nodeTail += Math.round(
        Math.max(0, node.instrument.ampReleaseMs ?? 0) * Math.max(1, sampleRateHz) / 1000,
      )
    }
    tailByNode.set(node.id, nodeTail)
  }
  for (const attachment of snapshot.nativeExternalAttachmentPlan?.attachments ?? []) {
    if (attachment.bypassed) continue
    if (attachment.declaredTailFrames === null) {
      continue
    }
    tailByNode.set(
      attachment.graphNodeId,
      (tailByNode.get(attachment.graphNodeId) ?? 0) + attachment.declaredTailFrames,
    )
  }
  const finiteTailFrames = Math.max(0, ...tailByNode.values())
  return finiteTailFrames
}

export const scheduleEndFrameFor = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
  graph?: AudioCoreGraphSnapshot,
) => {
  let contentEndFrame = Math.round(snapshot.transport.playheadSec * sampleRateHz)
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      contentEndFrame = Math.max(contentEndFrame, Math.round((clip.startSec + clip.duration) * sampleRateHz))
    }
  }
  for (const envelope of snapshot.mixer.automationEnvelopes) {
    for (const point of envelope.points) contentEndFrame = Math.max(contentEndFrame, Math.round(point.timeSec * sampleRateHz))
  }
  // Native schedule windows are end-exclusive. Keep one empty frame after the
  // last timeline boundary so a note-off exactly at a clip end can be emitted
  // in the final window without violating the native window contract.
  return nativeLoopFramesForSnapshot(snapshot, sampleRateHz)
    ? Number.MAX_SAFE_INTEGER
    : contentEndFrame + Math.max(1, tailFramesFor(snapshot, graph, sampleRateHz))
}

const capacityError = (message: string) => new Error(`Native schedule capacity exceeded: ${message}`)

export const createNativeScheduleCoordinator = (input: {
  bridge: NativeScheduleCoordinatorBridge
  snapshot: LivePlaybackSnapshot
  graph?: AudioCoreGraphSnapshot
  acceptsLiveMidi?: boolean
  epoch: number
  sampleRateHz: number
  capacity: NativeScheduleCapacity
  assets: readonly NativeSessionAsset[]
  preparedStretchAssets?: readonly PortablePreparedStretchAsset[]
  projectGeneration?: number
  startFrame: number
  onFault?: (error: Error) => void
  onHostLoss?: (error?: string) => void
  onRenderedFrame?: (frame: number) => void
}) => {
  let disposed = false
  let installed = false
  let unsubscribeProgress: (() => void) | undefined
  let unsubscribeLoss: (() => void) | undefined
  let latestProgress: NativeScheduleProgress | undefined
  let nextWindowStartFrame = input.startFrame
  let nextSequence = 9
  let nextWindowId = 1
  let refillInFlight: Promise<void> | undefined
  let refillRequested = false
  let scheduleComplete = false
  let refillEnabled = false
  let refillFrame = input.startFrame
  let refillFailureCount = 0
  let refillFaulted = false
  const activeNoteIds = new Set<string>()
  const emittedSources = new Map<string, number>()
  const transitionWaiters = new Set<{
    transitionId: bigint
    running: boolean
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const acceptedWaiters = new Set<{
    frame: number
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const urgentWaiters = new Set<{
    sequence: bigint
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const scheduleEndFrame = scheduleEndFrameFor(input.snapshot, input.sampleRateHz, input.graph)
  const acceptsLiveMidi = input.acceptsLiveMidi === true
  const ownedScheduleEndFrame = acceptsLiveMidi ? Number.MAX_SAFE_INTEGER : scheduleEndFrame
  const loop = nativeLoopFramesForSnapshot(input.snapshot, input.sampleRateHz)
  const arpeggiators = new Map(Object.entries(input.snapshot.mixer.fx.trackFx ?? {}).map(([trackId, fx]) => [trackId, fx.arp]))
  const assets = new Map<string, AudioAssetRef>(input.snapshot.assets.map((asset) => [
    asset.assetId,
    {
      version: 1,
      assetId: `portable-export:${asset.assetId}`,
      frameCount: asset.buffer.length,
      sampleRateHz: asset.buffer.sampleRate,
      channelCount: asset.buffer.numberOfChannels,
    },
  ]))
  const preparedStretchAssets = new Map(
    (input.preparedStretchAssets ?? []).map((asset) => [asset.clipId, asset]),
  )
  const audioTracks = input.snapshot.tracks.filter((track) => track.kind !== "instrument")

  const failWaiters = (error: Error) => {
    for (const waiter of transitionWaiters) waiter.reject(error)
    for (const waiter of acceptedWaiters) waiter.reject(error)
    for (const waiter of urgentWaiters) waiter.reject(error)
    transitionWaiters.clear()
    acceptedWaiters.clear()
    urgentWaiters.clear()
  }

  const resolveWaiters = (progress: NativeScheduleProgress) => {
    for (const waiter of transitionWaiters) {
      if (progress.appliedTransportTransitionId < waiter.transitionId || progress.running !== waiter.running) continue
      waiter.resolve()
      transitionWaiters.delete(waiter)
    }
    for (const waiter of acceptedWaiters) {
      if (progress.acceptedThroughFrame < waiter.frame && !progress.scheduleComplete) continue
      waiter.resolve()
      acceptedWaiters.delete(waiter)
    }
    for (const waiter of urgentWaiters) {
      if (progress.appliedUrgentSequence < waiter.sequence) continue
      waiter.resolve()
      urgentWaiters.delete(waiter)
    }
  }

  const compileWindow = (
    startFrame: number,
    endFrame: number,
    ledgers: ScheduleLedgers = { activeNoteIds, emittedSources },
  ): ScheduleWindowCandidate => {
    const instrumentEvents: NativeInstrumentEvent[] = []
    const instrumentEventKeys: string[] = []
    const noteChanges = new Map<string, boolean>()
    const sourceChanges = new Map<string, number>()
    const sampleSourceEvents: NativeSourceEvent[] = []
    const vstAutomationSegments: NativeVstAutomationSegment[] = []
    const noteIsActive = (key: string) => noteChanges.has(key)
      ? noteChanges.get(key) === true
      : ledgers.activeNoteIds.has(key)
    const releaseBoundaryNote = (key: string, frame: number) => {
      const parts = key.split("\u0000")
      const iteration = Number(parts[0])
      const nodeId = parts[1]
      const baseNoteId = Number(parts[2])
      if (!nodeId || !Number.isSafeInteger(iteration) || !Number.isSafeInteger(baseNoteId)) return
      const nativeNoteId = Number.isSafeInteger(baseNoteId + iteration * 0x1_0000_0000)
        ? baseNoteId + iteration * 0x1_0000_0000
        : baseNoteId
      instrumentEvents.push({
        nodeId,
        noteId: nativeNoteId,
        sequence: nextSequence + instrumentEvents.length,
        frameOffset: frame,
        type: "note-off",
        channel: 0,
        note: 0,
        value: 0,
      })
      instrumentEventKeys.push(key)
      noteChanges.set(key, false)
    }
    const slices = splitNativeScheduleRange(startFrame, endFrame, loop)
    for (const slice of slices) {
      const arrangementStartSec = slice.arrangementStartFrame / input.sampleRateHz
      const arrangementEndSec = slice.arrangementEndFrame / input.sampleRateHz
      if (slice.iteration > 0 && slice.nativeStartFrame >= (loop?.endFrame ?? Number.MAX_SAFE_INTEGER)) {
        const previousIteration = `${slice.iteration - 1}\u0000`
        const carriedKeys = new Set([
          ...noteChanges.keys(),
          ...ledgers.activeNoteIds,
        ])
        for (const key of carriedKeys) {
          const active = noteChanges.has(key)
            ? noteChanges.get(key) === true
            : ledgers.activeNoteIds.has(key)
          if (active && key.startsWith(previousIteration)) releaseBoundaryNote(key, slice.nativeStartFrame)
        }
      }
      const schedule = compilePortableFrameScheduleWindow({
        revision: input.snapshot.revision,
        transportEpoch: input.epoch,
        sampleRateHz: input.sampleRateHz,
        bpm: input.snapshot.bpm,
        timeOrigin: { timelineSec: arrangementStartSec, frame: slice.nativeStartFrame },
        rangeStartFrame: slice.nativeStartFrame,
        rangeEndFrame: slice.nativeEndFrame,
        rangeEndSec: arrangementEndSec,
        tracks: input.snapshot.tracks,
        automationEnvelopes: [],
        arpeggiators,
        stableNoteIds: true,
        eventRangeStartSec: arrangementStartSec,
        noteScheduleStartSec: 0,
        clipSpanningNoteOn: true,
      })
      const scheduledEvents = schedule.events
        .filter((event) => event.type === "note-on" || event.type === "note-off")
        .toSorted((left, right) => (
          left.frame - right.frame
            || (left.type === right.type ? left.sequence - right.sequence : left.type === "note-off" ? -1 : 1)
        ))
      for (const event of scheduledEvents) {
        const noteKey = loop
          ? `${slice.iteration}\u0000${event.target.trackId}\u0000${event.noteId}`
          : `${event.target.trackId}\u0000${event.noteId}`
        const nativeNoteId = loop && Number.isSafeInteger(event.noteId + slice.iteration * 0x1_0000_0000)
          ? event.noteId + slice.iteration * 0x1_0000_0000
          : event.noteId
        const noteEvent: NativeInstrumentEvent = {
          nodeId: event.target.trackId,
          noteId: nativeNoteId,
          sequence: nextSequence + instrumentEvents.length,
          frameOffset: event.frame,
          type: event.type,
          channel: 0,
          note: event.pitch,
          value: event.type === "note-on" ? event.velocity : 0,
        }
        if (event.type === "note-on") {
          if (noteIsActive(noteKey)) continue
          noteChanges.set(noteKey, true)
        } else {
          if (!noteIsActive(noteKey)) continue
          noteChanges.set(noteKey, false)
        }
        instrumentEvents.push(noteEvent)
        instrumentEventKeys.push(noteKey)
      }
      const shiftFrame = (frame: number) =>
        slice.nativeStartFrame + frame - slice.arrangementStartFrame
      const projection = audioTracks.length === 0
        ? { supported: true as const, events: [] }
        : projectPortableClipEvents({
          tracks: audioTracks,
          assets,
          bpm: input.snapshot.bpm,
          sampleRateHz: input.sampleRateHz,
          rangeStartSec: 0,
          rangeEndSec: arrangementEndSec,
          epoch: input.epoch,
          firstSequence: nextSequence + instrumentEvents.length + sampleSourceEvents.length,
          emitStartFrame: { start: slice.arrangementStartFrame, end: slice.arrangementEndFrame },
          allowInstruments: false,
          includeStableIdentity: true,
          preparedStretchAssets,
          projectGeneration: input.projectGeneration,
          warpContext: "offline",
        })
      if (!projection.supported) throw new Error(projection.reasons.join(" "))
      for (const event of projection.events) {
        const eventStart = Math.max(event.startFrame, slice.arrangementStartFrame)
        const eventEnd = Math.min(event.stopFrame, slice.arrangementEndFrame)
        if (eventEnd <= eventStart) continue
        const duration = event.stopFrame - event.startFrame
        const sourceStart = event.sourceOffsetFrame + (event.sourceOffsetFraction ?? 0)
          + event.sourceFrameCount * (eventStart - event.startFrame) / duration
        const sourceEnd = event.sourceOffsetFrame + (event.sourceOffsetFraction ?? 0)
          + event.sourceFrameCount * (eventEnd - event.startFrame) / duration
        const sourceOffsetFrame = Math.floor(sourceStart)
        const sourceFrameCount = Math.ceil(sourceEnd - sourceStart)
        const key = `${slice.iteration}\u0000${event.sourceIdentity ?? sourceKey(event)}`
        const previousStop = sourceChanges.get(key) ?? ledgers.emittedSources.get(key)
        if (previousStop !== undefined && previousStop > startFrame) continue
        if (!sourceChanges.has(key) && ledgers.emittedSources.size >= nativeSourceLedgerCapacity) {
          throw capacityError(`the source ledger exceeds its fixed capacity of ${nativeSourceLedgerCapacity}.`)
        }
        if (sourceFrameCount <= 0) continue
        sourceChanges.set(key, shiftFrame(eventEnd))
        sampleSourceEvents.push({
          ...event,
          startFrame: shiftFrame(eventStart),
          stopFrame: shiftFrame(eventEnd),
          sourceOffsetFrame,
          sourceOffsetFraction: sourceStart - sourceOffsetFrame,
          sourceFrameCount,
          fadeInStartFrame: shiftFrame(event.fadeInStartFrame),
          fadeInEndFrame: shiftFrame(event.fadeInEndFrame),
          fadeOutStartFrame: shiftFrame(event.fadeOutStartFrame),
          fadeOutEndFrame: shiftFrame(event.fadeOutEndFrame),
        })
      }
      vstAutomationSegments.push(...nativeVstAutomationSegmentsForSnapshot(
        input.snapshot,
        input.sampleRateHz,
        slice.arrangementStartFrame,
        slice.arrangementEndFrame,
      ).map((segment) => ({
        ...segment,
        startFrame: shiftFrame(segment.startFrame),
        endFrame: shiftFrame(segment.endFrame),
      })))
    }
    return {
      instrumentEvents,
      instrumentEventKeys,
      sampleSourceEvents,
      vstAutomationSegments,
      noteChanges: [...noteChanges],
      sourceChanges: [...sourceChanges],
      sequenceCount: instrumentEvents.length + sampleSourceEvents.length,
    }
  }

  const validateCallbackCapacity = (graph: AudioCoreGraphSnapshot) => {
    const blockSize = input.capacity.maximumFramesPerBlock
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw capacityError("the device callback block size is invalid.")
    const attachments = input.snapshot.nativeExternalAttachmentPlan?.attachments ?? []
    const preflightLedgers: ScheduleLedgers = {
      activeNoteIds: new Set<string>(),
      emittedSources: new Map<string, number>(),
    }
    const activeByNode = new Map<string, number>()
    const voiceCapacityByNode = new Map(
      graph.nodes
        .filter((node) => node.kind === "instrument")
        .map((node) => [node.id, node.instrument?.voiceCapacity ?? nativeVoiceCapacity]),
    )
    const preflightEnd = loop
      ? Math.max(
        input.startFrame + Math.max(blockSize * 2, loop.lengthFrames * 2),
        loop.endFrame + Math.max(blockSize * 2, loop.lengthFrames * 2),
      )
      : scheduleEndFrame
    for (let start = input.startFrame; start < preflightEnd; start += blockSize) {
        const end = Math.min(preflightEnd, start + blockSize)
        const window = compileWindow(start, end, preflightLedgers)
        const initial = start === input.startFrame ? synthStateEvents(input.snapshot, start) : []
        const instrumentCount = window.instrumentEvents.length + initial.length
        if (instrumentCount > nativeInstrumentEventCapacity) {
          throw capacityError(`callback at frame ${start} contains ${instrumentCount} instrument events; the native limit is 256.`)
        }
        if (window.sampleSourceEvents.length > nativeSourceCapacity) {
          throw capacityError(`callback at frame ${start} contains ${window.sampleSourceEvents.length} source events; the native source limit is 256.`)
        }
        const processorCount = window.vstAutomationSegments.reduce((count, segment) => (
          count + (segment.startFrame < end && segment.endFrame > start ? 1 : 0)
            + (segment.interpolation === "linear" && segment.endFrame < end ? 1 : 0)
        ), 0)
        if (processorCount > nativeProcessorEventCapacity) {
          throw capacityError(`callback at frame ${start} contains ${processorCount} processor events; the native limit is 256.`)
        }
        for (const [eventIndex, event] of window.instrumentEvents.entries()) {
          const noteKey = window.instrumentEventKeys[eventIndex] ?? `${event.nodeId}\u0000${event.noteId}`
          if (event.type === "note-on") {
            preflightLedgers.activeNoteIds.add(noteKey)
            activeByNode.set(event.nodeId, (activeByNode.get(event.nodeId) ?? 0) + 1)
          } else {
            if (preflightLedgers.activeNoteIds.delete(noteKey)) {
              const active = (activeByNode.get(event.nodeId) ?? 1) - 1
              if (active === 0) activeByNode.delete(event.nodeId)
              else activeByNode.set(event.nodeId, active)
            }
          }
          const active = activeByNode.get(event.nodeId) ?? 0
          const capacity = voiceCapacityByNode.get(event.nodeId)
          if (capacity !== undefined && active > capacity) {
            throw capacityError(`instrument ${event.nodeId} needs ${active} simultaneous voices; its fixed ledger capacity is ${capacity}.`)
          }
        }
        const midiCounts = new Map<string, number>()
        for (const event of window.instrumentEvents) {
          midiCounts.set(event.nodeId, (midiCounts.get(event.nodeId) ?? 0) + 1)
        }
        const automationCounts = new Map<string, number>()
        for (const segment of window.vstAutomationSegments) {
          automationCounts.set(segment.instanceId, (automationCounts.get(segment.instanceId) ?? 0) + 1 + (
            segment.interpolation === "linear" && segment.endFrame < end ? 1 : 0
          ))
        }
        for (const attachment of attachments) {
          const midiCount = midiCounts.get(attachment.graphNodeId) ?? 0
          const automationCount = automationCounts.get(attachment.instanceId) ?? 0
          const maximum = Math.min(
            attachment.workerTransport.maximumEventsPerBlock,
            input.capacity.maximumVstEventsPerBlock ?? maxVst3WorkerFrames,
          )
          if (midiCount + automationCount > maximum) {
            throw capacityError(`VST ${attachment.instanceId} callback at frame ${start} combines ${midiCount} MIDI and ${automationCount} automation events; its limit is ${maximum}.`)
          }
        }
        for (const [key, stopFrame] of window.sourceChanges) {
          preflightLedgers.emittedSources.set(key, stopFrame)
        }
        for (const [key, stopFrame] of preflightLedgers.emittedSources) {
          if (stopFrame <= start) preflightLedgers.emittedSources.delete(key)
        }
    }
  }

  const preflight = (graph: AudioCoreGraphSnapshot) => {
    validateCallbackCapacity(graph)
  }

  const queueWindow = async (
    startFrame: number,
    endFrame: number,
    window: ScheduleWindowCandidate,
    token?: string,
  ) => {
    const chunkCount = Math.max(
      Math.ceil(window.instrumentEvents.length / nativeInstrumentEventBatchSize),
      Math.ceil(window.sampleSourceEvents.length / nativeInstrumentEventBatchSize),
      Math.ceil(window.vstAutomationSegments.length / nativeInstrumentEventBatchSize),
      1,
    )
    if (chunkCount > nativeScheduleChunkCount) {
      throw capacityError(`logical window ${startFrame}-${endFrame} needs ${chunkCount} wire chunks; split the window before submission.`)
    }
    const windowId = nextWindowId
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const instrumentEvents = window.instrumentEvents.slice(
        chunk * nativeInstrumentEventBatchSize,
        (chunk + 1) * nativeInstrumentEventBatchSize,
      )
      const sampleSourceEvents = window.sampleSourceEvents.slice(
        chunk * nativeInstrumentEventBatchSize,
        (chunk + 1) * nativeInstrumentEventBatchSize,
      )
      const vstAutomationSegments = window.vstAutomationSegments.slice(
        chunk * nativeInstrumentEventBatchSize,
        (chunk + 1) * nativeInstrumentEventBatchSize,
      )
      const payload = serializeNativeScheduleWindow({
        revision: input.snapshot.revision,
        epoch: input.epoch,
        windowId,
        startFrame,
        endFrame,
        chunkIndex: chunk,
        chunkCount,
        endsSchedule: !acceptsLiveMidi && endFrame >= scheduleEndFrame && chunk === chunkCount - 1,
        instrumentEvents,
        sampleSourceEvents,
        vstAutomationSegments,
        assets: input.assets,
      })
      let lastError: Error | undefined
      for (let attempt = 0; attempt < nativeScheduleSubmissionAttempts; attempt += 1) {
        const reply = await input.bridge.queueScheduleWindow(payload, token)
        if (reply.ok) {
          lastError = undefined
          break
        }
        lastError = new Error(reply.error)
        // Yield to the Electron I/O loop so a queued native reply or realtime
        // queue reclamation can make progress before the bounded retry.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      if (lastError) throw lastError
    }
    nextWindowId += 1
    for (const [key, active] of window.noteChanges) {
      if (active) activeNoteIds.add(key)
      else activeNoteIds.delete(key)
    }
    for (const [key, stopFrame] of window.sourceChanges) emittedSources.set(key, stopFrame)
    for (const [key, stopFrame] of emittedSources) {
      if (stopFrame <= startFrame) emittedSources.delete(key)
    }
    nextSequence += window.sequenceCount
    nextWindowStartFrame = endFrame
    scheduleComplete = !acceptsLiveMidi && endFrame >= scheduleEndFrame
  }

  const refill = async (renderedFrame: number, token?: string) => {
    if (disposed || scheduleComplete) return
    const targetEnd = Math.min(
      ownedScheduleEndFrame,
      renderedFrame + Math.max(
        input.capacity.maximumFramesPerBlock,
        Math.round(input.sampleRateHz * nativeScheduleLookaheadSec),
      ),
    )
    const threshold = renderedFrame + Math.round(input.sampleRateHz * nativeScheduleRefillThresholdSec)
    if (nextWindowStartFrame >= targetEnd && nextWindowStartFrame >= threshold) return
    while (!disposed && !scheduleComplete && nextWindowStartFrame < targetEnd) {
      let endFrame = targetEnd
      let candidate = compileWindow(nextWindowStartFrame, endFrame)
      for (;;) {
        const chunkCount = Math.max(
          Math.ceil(candidate.instrumentEvents.length / nativeInstrumentEventBatchSize),
          Math.ceil(candidate.sampleSourceEvents.length / nativeInstrumentEventBatchSize),
          Math.ceil(candidate.vstAutomationSegments.length / nativeInstrumentEventBatchSize),
          1,
        )
        if (
          chunkCount <= nativeScheduleChunkCount
          && candidate.instrumentEvents.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount
          && candidate.sampleSourceEvents.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount
          && candidate.vstAutomationSegments.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount
        ) break
        const shorter = nextWindowStartFrame + Math.max(
          1,
          Math.floor((endFrame - nextWindowStartFrame) / 2),
        )
        if (shorter >= endFrame) throw capacityError("a logical window cannot fit within the native wire limits.")
        endFrame = shorter
        candidate = compileWindow(nextWindowStartFrame, endFrame)
      }
      await queueWindow(nextWindowStartFrame, endFrame, candidate, token)
    }
  }

  const beginRefill = (renderedFrame: number, token?: string) => {
    let release: () => void = () => {}
    const marker = new Promise<void>((resolve) => {
      release = resolve
    })
    refillInFlight = marker
    const operation = refill(renderedFrame, token)
    return { marker, operation, release }
  }

  const finishRefill = (marker: Promise<void>, release: () => void) => {
    if (refillInFlight !== marker) {
      release()
      return
    }
    refillInFlight = undefined
    release()
    if (!refillRequested || !refillEnabled || disposed || scheduleComplete) return
    refillRequested = false
    const latest = latestProgress
    if (latest) requestRefill(latest, true)
  }

  const requestRefill = (progress: NativeScheduleProgress, force = false) => {
    if (disposed) return
    if (progress.revision !== input.snapshot.revision || progress.epoch !== input.epoch) return
    if (!force && progress.progressSequence <= (latestProgress?.progressSequence ?? 0n)) return
    latestProgress = progress
    if (progress.scheduleComplete) {
      scheduleComplete = true
      refillRequested = false
    }
    refillFrame = Number(progress.renderedThroughFrame)
    input.onRenderedFrame?.(refillFrame)
    resolveWaiters(progress)
    if (!refillEnabled || scheduleComplete || refillFaulted) return
    if (refillInFlight !== undefined) {
      refillRequested = true
      return
    }
    const { marker, operation, release } = beginRefill(refillFrame)
    void operation.then(() => {
      refillFailureCount = 0
    }).catch((error: unknown) => {
      if (disposed || scheduleComplete || refillFaulted) return
      const fault = error instanceof Error ? error : new Error("Native schedule refill failed.")
      refillFailureCount += 1
      if (refillFailureCount >= nativeScheduleRefillRetryLimit) {
        refillFaulted = true
        input.onFault?.(fault)
        failWaiters(fault)
        return
      }
      // A running host can reject a refill while its realtime queues or VST
      // automation buffer are being reclaimed. Keep the candidate ledgers
      // unchanged and retry it on the next progress notification instead of
      // stopping playback and marking every attached VST as degraded.
      refillRequested = true
    }).finally(() => finishRefill(marker, release))
  }

  const unsubscribeListeners = () => {
    unsubscribeProgress?.()
    unsubscribeProgress = undefined
    unsubscribeLoss?.()
    unsubscribeLoss = undefined
  }

  const install = () => {
    if (installed || disposed) return
    installed = true
    unsubscribeProgress = input.bridge.onScheduleProgress(requestRefill)
    unsubscribeLoss = input.bridge.onLoss((error) => {
      if (disposed) return
      disposed = true
      unsubscribeListeners()
      const message = error ?? "Native playback host connection was lost."
      failWaiters(new Error(message))
      input.onHostLoss?.(message)
    })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    unsubscribeListeners()
    activeNoteIds.clear()
    emittedSources.clear()
    failWaiters(new Error("Native schedule coordinator was disposed."))
  }

  const wait = <T extends { resolve: () => void; reject: (error: Error) => void }>(
    set: Set<T>,
    waiter: T,
  ) => new Promise<void>((resolve, reject) => {
    if (disposed) {
      reject(new Error("Native schedule coordinator was disposed."))
      return
    }
    waiter.resolve = resolve
    waiter.reject = reject
    set.add(waiter)
    if (latestProgress) resolveWaiters(latestProgress)
  })

  const coordinator: NativeScheduleCoordinator = {
    install,
    dispose,
    preflight,
    async queueInitialSynthState(frame, transactionToken) {
      const events = synthStateEvents(input.snapshot, frame)
      if (events.length === 0) return
      assertReply(await input.bridge.queueInstrumentEvents(
        serializeNativeInstrumentEvents(input.epoch, events),
        transactionToken,
      ))
      nextSequence = Math.max(nextSequence, events.length + 1)
    },
    async prime(frame, transactionToken) {
      nextWindowStartFrame = frame
      refillFrame = frame
      while (refillInFlight) await refillInFlight
      const { marker, operation, release } = beginRefill(frame, transactionToken)
      try {
        await operation
      } finally {
        finishRefill(marker, release)
      }
      refillEnabled = true
      if (refillRequested && latestProgress && !scheduleComplete) {
        refillRequested = false
        requestRefill(latestProgress, true)
      }
    },
    onProgress: requestRefill,
    waitForAccepted(minimumFrame) {
      if (latestProgress?.acceptedThroughFrame !== undefined
        && (latestProgress.acceptedThroughFrame >= minimumFrame || latestProgress.scheduleComplete)) {
        return Promise.resolve()
      }
      return wait(acceptedWaiters, {
        frame: minimumFrame,
        resolve: () => {},
        reject: () => {},
      })
    },
    waitForTransition(transitionId, running) {
      if (latestProgress && latestProgress.appliedTransportTransitionId >= transitionId
        && latestProgress.running === running) return Promise.resolve()
      return wait(transitionWaiters, {
        transitionId,
        running,
        resolve: () => {},
        reject: () => {},
      })
    },
    waitForUrgent(sequence) {
      if (latestProgress && latestProgress.appliedUrgentSequence >= sequence) return Promise.resolve()
      return wait(urgentWaiters, {
        sequence,
        resolve: () => {},
        reject: () => {},
      })
    },
    async reenableAutomation(instanceId, parameterIds, transactionToken) {
      const reenable = input.bridge.reenableVstScheduleAutomation
      if (!reenable) throw new Error("The native VST schedule automation bridge is unavailable.")
      assertReply(await reenable(
        serializeNativeVstScheduleAutomationEnable(instanceId, parameterIds),
        transactionToken,
      ))
    },
    currentProgress: () => latestProgress,
    currentFrame: () => Number(latestProgress?.renderedThroughFrame ?? refillFrame),
    scheduleEndFrame: () => ownedScheduleEndFrame,
    isDisposed: () => disposed,
  }
  return coordinator
}
