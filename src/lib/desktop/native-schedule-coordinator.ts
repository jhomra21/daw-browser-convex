import {
  serializeNativeInstrumentEvents,
  serializeNativeScheduleWindow,
  serializeNativeVstScheduleAutomationEnable,
} from "@daw-browser/audio-engine/native-host-wire"
import type {
  NativeInstrumentEvent,
  NativeProcessorAutomationEvent,
  NativeScheduleProgress,
  NativeSessionAsset,
  NativeSourceEvent,
  NativeVstAutomationSegment,
} from "@daw-browser/audio-engine/native-host-wire"
import { createPortableFrameScheduleWindowCompiler } from "~/lib/portable-frame-schedule"
import {
  nativeProcessorAutomationEventsAtCallbackBoundaries,
  nativeProcessorAutomationEventsForSchedule,
  sliceNativeProcessorAutomationEvents,
} from "~/lib/desktop/native-processor-automation"
import { projectPortableClipEvents } from "@daw-browser/audio-engine/portable-clip-projector"
import {
  chunkNativeSourceEvents,
  type NativePcmChunkDescriptor,
} from "@daw-browser/audio-engine/native-pcm-chunking"
import type { PortablePreparedStretchAsset } from "@daw-browser/audio-engine/portable-stretch-preparation"
import type { PreparedStretchProjectionMetadata } from "@daw-browser/audio-engine/prepared-stretch-artifact"
import type { AudioAssetRef, AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import { parseExternalAutomationParameterId, valueAtAutomationTime } from "@daw-browser/shared"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import type { NativeGraphRevisionStatus } from "@daw-browser/desktop-protocol/native-revision"
import { maxVst3WorkerFrames } from "@daw-browser/plugin-host-protocol"
import type { NativeTimelinePageManager } from "./native-timeline-page-manager"
import { NativePlaybackAbortError } from "./native-playback-abort"
import { nativeMappedSourceCoverage } from "~/lib/native-source-coverage"
import {
  arrangementFrameForLoop,
  loopFramesForTransport,
  type LoopFrames,
} from "@daw-browser/audio-engine/loop-frame-schedule"

type NativeSchedulePageManager = Pick<NativeTimelinePageManager, 'ensureRanges' | 'invalidateRanges'>

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

type NativeCandidateResources = {
  assets: readonly NativeSessionAsset[]
  assetSourceKeys: ReadonlyMap<string, string>
  nativePcmChunkDescriptors: readonly NativePcmChunkDescriptor[]
  preparedStretchAssets?: readonly PreparedStretchProjectionMetadata[]
}

export type NativeScheduleCoordinator = {
  coverThrough: (frame: number) => Promise<void>
  stageRevision: (snapshot: LivePlaybackSnapshot, graph: AudioCoreGraphSnapshot, frame: number,
    onRejected?: () => Promise<void>, resources?: NativeCandidateResources) => NativeScheduleCoordinator
  activateRevision: (proof: Pick<NativeGraphRevisionStatus, "status" | "activeRevision" | "publicationFrame">) => boolean
  suspendGraphPublication: () => Promise<void>
  resumeGraphPublication: (revision: number) => void
  install: () => void
  dispose: () => void
  abortPreparation: () => void
  preflight: (graph: AudioCoreGraphSnapshot) => void
  queueInitialSynthState: (frame: number, transactionToken?: string) => Promise<void>
  /**
   * Makes the pages a publication bound anywhere in `fromFrame`..`seamFrame` will read resident, submitting no window.
   * Aborting `signal` detaches from the preparation at once; page decodes already running stay shared with the page manager.
   */
  prepareCandidatePages: (snapshot: LivePlaybackSnapshot, graph: AudioCoreGraphSnapshot, fromFrame: number, seamFrame: number,
    resources: NativeCandidateResources, signal: AbortSignal) => Promise<void>
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
  refillDiagnostics: () => NativeRefillDiagnostics
}

export type NativeRefillDiagnostics = {
  progressCount: number
  compileCount: number
  compileTotalMs: number
  compileMaxMs: number
  submittedVstSegments: number
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
  activeNoteIds: Map<string, { pitch: number; velocity: number }>
  emittedSources: Map<string, number>
  sourceOrigins: Map<string, { signature: string; event: NativeSourceEvent }>
}

export type NativeLoopFrames = LoopFrames

export const nativeLoopFramesForSnapshot = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
): NativeLoopFrames | undefined => loopFramesForTransport(snapshot.transport, sampleRateHz)

export const arrangementFrameForNativeFrame = (
  frame: number,
  loop: NativeLoopFrames | undefined,
) => arrangementFrameForLoop(frame, loop)

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
  processorAutomationEvents: NativeProcessorAutomationEvent[]
  sourceChanges: Array<[string, number, number]>
  sourceOrigins: ScheduleLedgers["sourceOrigins"]
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

type PagePreparingCoordinator = NativeScheduleCoordinator & {
  preparePages: (fromFrame: number, seamFrame: number) => Promise<void>
}

const buildNativeScheduleCoordinator = (input: {
  bridge: NativeScheduleCoordinatorBridge
  snapshot: LivePlaybackSnapshot
  graph?: AudioCoreGraphSnapshot
  acceptsLiveMidi?: boolean
  epoch: number
  sampleRateHz: number
  capacity: NativeScheduleCapacity
  assets: readonly NativeSessionAsset[]
  assetSourceKeys?: ReadonlyMap<string, string>
  preparedStretchAssets?: readonly (PortablePreparedStretchAsset | PreparedStretchProjectionMetadata)[]
  nativePcmChunkDescriptors?: readonly NativePcmChunkDescriptor[]
  pageManager?: NativeSchedulePageManager
  projectGeneration?: number
  startFrame: number
  preparedPublicationFrame?: number
  initialOwnership?: ScheduleLedgers
  initialSequence?: number
  onFault?: (error: Error) => void
  onHostLoss?: (error?: string) => void
  onRenderedFrame?: (frame: number) => void
  onRefillDiagnostics?: (snapshot: NativeRefillDiagnostics) => void
}, onPreparedWindowRejected?: () => Promise<void>) => {
  let disposed = false
  let graphRevision = input.snapshot.revision
  let graphPublicationSuspended = false
  let preparedPublicationFrame = input.preparedPublicationFrame
  const hydrationAbortController = new AbortController()
  let installed = false
  let unsubscribeProgress: (() => void) | undefined
  let unsubscribeLoss: (() => void) | undefined
  let latestProgress: NativeScheduleProgress | undefined
  let nextWindowStartFrame = input.startFrame
  let nextSequence = input.initialSequence ?? 9
  let nextWindowId = 1
  let refillInFlight: Promise<void> | undefined
  let refillRequested = false
  let scheduleComplete = false
  let refillEnabled = false
  let refillFrame = input.startFrame
  let refillFailureCount = 0
  let refillFaulted = false
  let progressCount = 0
  let compileCount = 0
  let compileTotalMs = 0
  let compileMaxMs = 0
  let submittedVstSegments = 0
  const refillDiagnostics = (): NativeRefillDiagnostics => ({
    progressCount, compileCount, compileTotalMs, compileMaxMs, submittedVstSegments,
  })
  const activeNoteIds = new Map(input.initialOwnership?.activeNoteIds)
  const emittedSources = new Map(input.initialOwnership?.emittedSources)
  const sourceOrigins = new Map(input.initialOwnership?.sourceOrigins)
  const acceptedWindows: Array<{
    startFrame: number
    endFrame: number
    before: ScheduleLedgers
    window: ScheduleWindowCandidate
  }> = []
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
  // Even deleting the final clip needs a complete empty prepared window so
  // native can prove coverage and reconcile the old audible set at the seam.
  const scheduleEndFrame = Math.max(scheduleEndFrameFor(input.snapshot, input.sampleRateHz, input.graph),
    input.preparedPublicationFrame === undefined ? 0 : input.startFrame + input.capacity.maximumFramesPerBlock)
  const acceptsLiveMidi = input.acceptsLiveMidi === true
  const ownedScheduleEndFrame = acceptsLiveMidi ? Number.MAX_SAFE_INTEGER : scheduleEndFrame
  const loop = nativeLoopFramesForSnapshot(input.snapshot, input.sampleRateHz)
  const arpeggiators = new Map(Object.entries(input.snapshot.mixer.fx.trackFx ?? {}).map(([trackId, fx]) => [trackId, fx.arp]))
  const compilePortableWindow = createPortableFrameScheduleWindowCompiler({
    revision: input.snapshot.revision,
    transportEpoch: input.epoch,
    sampleRateHz: input.sampleRateHz,
    bpm: input.snapshot.bpm,
    tracks: input.snapshot.tracks,
    automationEnvelopes: input.snapshot.mixer.automationEnvelopes,
    arpeggiators,
  })
  const assetEntries: [string, AudioAssetRef][] = []
  for (const snapshotAsset of input.snapshot.assets) {
    const asset = input.assets.find(({ asset: candidate }) => (
      candidate.assetId === `portable-export:${snapshotAsset.assetId}`
    ))?.asset
    if (asset) assetEntries.push([snapshotAsset.assetId, asset])
  }
  const assets = new Map(assetEntries)
  const sessionAssetIds = new Map(input.assets.map(({ asset, sessionAssetId }) => [asset.assetId, sessionAssetId]))
  const sourceRates = new Map(input.assets.map(({ asset }) => [asset.assetId, asset.sampleRateHz]))
  const preparedStretchAssets = new Map(
    (input.preparedStretchAssets ?? []).map((asset) => [asset.clipId, asset]),
  )
  const audioTracks = input.snapshot.tracks.filter((track) => track.kind !== "instrument")
  let scheduleGraph = input.graph

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
    ledgers: ScheduleLedgers = { activeNoteIds, emittedSources, sourceOrigins },
  ): ScheduleWindowCandidate => {
    const instrumentEvents: NativeInstrumentEvent[] = []
    const instrumentEventKeys: string[] = []
    const noteChanges = new Map<string, boolean>()
    const sourceChanges = new Map<string, number>()
    const sourceStarts = new Map<string, number>()
    const candidateOrigins: ScheduleLedgers["sourceOrigins"] = new Map()
    const sampleSourceEvents: NativeSourceEvent[] = []
    const vstAutomationSegments: NativeVstAutomationSegment[] = []
    const processorAutomationEvents: NativeProcessorAutomationEvent[] = []
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
      if (slice.iteration > 0 && slice.nativeStartFrame >= (loop?.endFrame ?? Number.MAX_SAFE_INTEGER)) {
        const previousIteration = `${slice.iteration - 1}\u0000`
        const carriedKeys = new Set([
          ...noteChanges.keys(),
          ...ledgers.activeNoteIds.keys(),
        ])
        for (const key of carriedKeys) {
          const active = noteChanges.has(key)
            ? noteChanges.get(key) === true
            : ledgers.activeNoteIds.has(key)
          if (active && key.startsWith(previousIteration)) releaseBoundaryNote(key, slice.nativeStartFrame)
        }
      }
      const schedule = compilePortableWindow({
        timeOrigin: { timelineSec: arrangementStartSec, frame: slice.nativeStartFrame },
        rangeStartFrame: slice.nativeStartFrame,
        rangeEndFrame: slice.nativeEndFrame,
      })
      if (input.preparedPublicationFrame !== undefined && slice.nativeStartFrame === input.startFrame) {
        const desiredNotes = new Map(schedule.events.flatMap((event) => event.type === "note-on"
          && event.frame === slice.nativeStartFrame ? [[loop
            ? `${slice.iteration}\u0000${event.target.trackId}\u0000${event.noteId}`
            : `${event.target.trackId}\u0000${event.noteId}`, event] satisfies [string, typeof event]] : []))
        const targets = new Set(scheduleGraph?.nodes.filter((node) => node.kind === "instrument").map((node) => node.id))
        for (const [key, voice] of ledgers.activeNoteIds) {
          const desired = desiredNotes.get(key)
          if (desired?.pitch === voice.pitch && desired.velocity === voice.velocity) continue
          const parts = key.split("\u0000")
          const nodeId = parts[loop ? 1 : 0]
          const noteId = Number(parts[loop ? 2 : 1])
          noteChanges.set(key, false)
          if (!nodeId || !targets.has(nodeId)) continue
          instrumentEvents.push({
            nodeId, noteId: loop ? noteId + Number(parts[0]) * 0x1_0000_0000 : noteId,
            sequence: nextSequence + instrumentEvents.length, frameOffset: startFrame,
            type: "note-off", channel: 0, note: voice.pitch, value: 0,
          })
          instrumentEventKeys.push(key)
        }
      }
      if (scheduleGraph) {
        processorAutomationEvents.push(
          ...sliceNativeProcessorAutomationEvents(
            nativeProcessorAutomationEventsAtCallbackBoundaries(
              nativeProcessorAutomationEventsForSchedule(scheduleGraph, schedule.events),
              input.capacity.maximumFramesPerBlock,
              input.startFrame,
              slice.nativeEndFrame,
            ),
            slice.nativeStartFrame,
            slice.nativeEndFrame,
          ),
        )
      }
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
          epoch: input.epoch,
          firstSequence: nextSequence + instrumentEvents.length + sampleSourceEvents.length,
          allowInstruments: false,
          includeStableIdentity: true,
          preparedStretchAssets,
          projectGeneration: input.projectGeneration,
          warpContext: "offline",
          assetRatePolicy: "asset-rate",
        })
      if (!projection.supported) throw new Error(projection.reasons.join(" "))
      const nativeEvents = chunkNativeSourceEvents(
        projection.events,
        input.nativePcmChunkDescriptors ?? [],
        nextSequence + instrumentEvents.length + sampleSourceEvents.length,
      )
      for (const event of nativeEvents) {
        const eventStart = Math.max(event.startFrame, slice.arrangementStartFrame)
        const eventEnd = Math.min(event.stopFrame, slice.arrangementEndFrame)
        if (eventEnd <= eventStart) continue
        const sourceRate = sourceRates.get(event.assetId) ?? input.sampleRateHz
        const sourceStart = event.sourceOffsetFrame + (event.sourceOffsetFraction ?? 0)
          + (eventStart - event.startFrame) * sourceRate / input.sampleRateHz
        const sourceEnd = event.sourceOffsetFrame + (event.sourceOffsetFraction ?? 0)
          + (eventEnd - event.startFrame) * sourceRate / input.sampleRateHz
        const sourceOffsetFrame = Math.floor(sourceStart)
        const wireFraction = Math.fround(sourceStart - sourceOffsetFrame)
        const fractionCarry = wireFraction === 1 ? 1 : 0
        const sourceFrameCount = Math.ceil(sourceEnd - sourceStart)
        const key = `${slice.iteration}\u0000${event.sourceIdentity ?? sourceKey(event)}`
        const signature = JSON.stringify([
          event.sourceNodeId, event.assetId,
          sessionAssetIds.get(event.assetId),
          shiftFrame(event.startFrame), event.sourceOffsetFrame, Math.fround(event.sourceOffsetFraction ?? 0),
          event.gain, shiftFrame(event.fadeInStartFrame), shiftFrame(event.fadeInEndFrame),
          shiftFrame(event.fadeOutStartFrame), shiftFrame(event.fadeOutEndFrame),
          event.fadeInCurve, event.fadeInCurvePosition, event.fadeOutCurve, event.fadeOutCurvePosition,
        ])
        const seamDeclaration = preparedPublicationFrame !== undefined && startFrame === input.startFrame
          && slice.nativeStartFrame === startFrame
        const previousStop = sourceChanges.get(key) ?? ledgers.emittedSources.get(key)
        if (!seamDeclaration && previousStop !== undefined && previousStop > startFrame) continue
        if (!sourceChanges.has(key) && ledgers.emittedSources.size >= nativeSourceLedgerCapacity) {
          throw capacityError(`the source ledger exceeds its fixed capacity of ${nativeSourceLedgerCapacity}.`)
        }
        if (sourceFrameCount <= 0) continue
        sourceChanges.set(key, shiftFrame(eventEnd))
        sourceStarts.set(key, shiftFrame(eventStart))
        const accepted = seamDeclaration ? ledgers.sourceOrigins.get(key) : undefined
        const origin = accepted?.signature === signature ? accepted.event : undefined
        const candidate = {
          ...event,
          startFrame: origin?.startFrame ?? shiftFrame(eventStart),
          stopFrame: shiftFrame(eventEnd),
          sourceOffsetFrame: origin?.sourceOffsetFrame ?? sourceOffsetFrame + fractionCarry,
          sourceOffsetFraction: origin?.sourceOffsetFraction ?? (fractionCarry ? 0 : wireFraction),
          sourceFrameCount: origin
            ? Math.ceil(sourceEnd - origin.sourceOffsetFrame - (origin.sourceOffsetFraction ?? 0))
            : sourceFrameCount,
          fadeInStartFrame: shiftFrame(event.fadeInStartFrame),
          fadeInEndFrame: shiftFrame(event.fadeInEndFrame),
          fadeOutStartFrame: shiftFrame(event.fadeOutStartFrame),
          fadeOutEndFrame: shiftFrame(event.fadeOutEndFrame),
        }
        candidateOrigins.set(key, { signature, event: candidate })
        sampleSourceEvents.push(candidate)
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
    const orderedSampleSourceEvents = sampleSourceEvents.toSorted((left, right) => (
      Math.max(startFrame, left.startFrame) - Math.max(startFrame, right.startFrame) || left.sequence - right.sequence
    )).map((event, index) => ({
      ...event,
      sequence: nextSequence + instrumentEvents.length + index,
    }))
    return {
      instrumentEvents,
      instrumentEventKeys,
      sampleSourceEvents: orderedSampleSourceEvents,
      vstAutomationSegments,
      processorAutomationEvents,
      sourceChanges: [...sourceChanges].map(([key, stop]) => [key, stop, sourceStarts.get(key) ?? startFrame]),
      sourceOrigins: candidateOrigins,
      sequenceCount: instrumentEvents.length + sampleSourceEvents.length,
    }
  }

  const preflightCallbackStarts = function* (blockSize: number, endFrame: number) {
    // Between arrangement boundaries, raw session-rate sources occupy the same
    // slots, notes keep the same voice ledger, and automation only repeats its
    // callback seed. Validate the boundary block and its neighbors, including
    // the first ordinary callback after initialization. Complex projections
    // retain the exhaustive gate: this is not a lookahead or capacity reduction.
    const canSkipUnchangedCallbacks = !loop
      && (input.nativePcmChunkDescriptors?.length ?? 0) === 0
      && [...assets.values()].every((asset) => asset.sampleRateHz === input.sampleRateHz)
      && input.snapshot.tracks.every((track) => track.clips.every((clip) => (
        (clip.midi?.mappings?.length ?? 0) === 0 && clip.audioWarp?.enabled !== true
      )))
    if (!canSkipUnchangedCallbacks) {
      for (let frame = input.startFrame; frame < endFrame; frame += blockSize) yield frame
      return
    }
    const starts = new Set<number>()
    const addBoundary = (frame: number) => {
      const block = Math.floor((frame - input.startFrame) / blockSize)
      for (const neighbor of [block - 1, block, block + 1]) {
        const start = input.startFrame + neighbor * blockSize
        if (start >= input.startFrame && start < endFrame) starts.add(start)
      }
    }
    addBoundary(input.startFrame)
    addBoundary(endFrame - 1)
    const schedule = compilePortableWindow({
      timeOrigin: { timelineSec: input.startFrame / input.sampleRateHz, frame: input.startFrame },
      rangeStartFrame: input.startFrame,
      rangeEndFrame: endFrame,
    })
    for (const event of schedule.events) {
      addBoundary(event.frame)
      if (event.type === "parameter-ramp") addBoundary(event.endFrame)
    }
    const projection = projectPortableClipEvents({
      tracks: audioTracks, assets, bpm: input.snapshot.bpm, sampleRateHz: input.sampleRateHz,
      rangeStartSec: 0, rangeEndSec: endFrame / input.sampleRateHz,
      epoch: input.epoch, firstSequence: nextSequence, allowInstruments: false,
      warpContext: "offline", assetRatePolicy: "asset-rate",
    })
    if (!projection.supported) throw new Error(projection.reasons.join(" "))
    for (const event of projection.events) {
      addBoundary(event.startFrame)
      addBoundary(event.stopFrame)
    }
    // External envelopes are projected separately from native processor events.
    for (const envelope of input.snapshot.mixer.automationEnvelopes) {
      if (!envelope.enabled) continue
      for (const point of envelope.points) addBoundary(Math.round(point.timeSec * input.sampleRateHz))
    }
    yield* [...starts].sort((left, right) => left - right)
  }

  const validateCallbackCapacity = (graph: AudioCoreGraphSnapshot) => {
    const blockSize = input.capacity.maximumFramesPerBlock
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw capacityError("the device callback block size is invalid.")
    const attachments = input.snapshot.nativeExternalAttachmentPlan?.attachments ?? []
    const preflightLedgers: ScheduleLedgers = {
      activeNoteIds: new Map(),
      emittedSources: new Map<string, number>(),
      sourceOrigins: new Map(),
    }
    const activeByNode = new Map<string, number>()
    const vstNodeIds = new Set(attachments.map((attachment) => attachment.graphNodeId))
    // Built-in instruments steal voices. Only the independent native VST
    // event ledger constrains note admission.
    const heldNoteCapacityByNode = new Map(
      graph.nodes.filter((node) => node.kind === "instrument" && vstNodeIds.has(node.id))
        .map((node) => [node.id, 256]),
    )
    const preflightEnd = loop
      ? Math.max(
        input.startFrame + Math.max(blockSize * 2, loop.lengthFrames * 2),
        loop.endFrame + Math.max(blockSize * 2, loop.lengthFrames * 2),
      )
      : scheduleEndFrame
    for (const start of preflightCallbackStarts(blockSize, preflightEnd)) {
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
        ), 0) + window.processorAutomationEvents.reduce((count, event) => {
          if (event.kind === "set") return count + (event.frame >= start && event.frame < end ? 1 : 0)
          if (event.frame >= end || event.endFrame <= start) return count
          return count + 1 + (event.endFrame < end ? 1 : 0)
        }, 0)
        if (processorCount > nativeProcessorEventCapacity) {
          throw capacityError(`callback at frame ${start} contains ${processorCount} processor events; the native limit is 256.`)
        }
        for (const [eventIndex, event] of window.instrumentEvents.entries()) {
          const noteKey = window.instrumentEventKeys[eventIndex] ?? `${event.nodeId}\u0000${event.noteId}`
          if (event.type === "note-on") {
            preflightLedgers.activeNoteIds.set(noteKey, { pitch: event.note, velocity: event.value })
            activeByNode.set(event.nodeId, (activeByNode.get(event.nodeId) ?? 0) + 1)
          } else {
            if (preflightLedgers.activeNoteIds.delete(noteKey)) {
              const active = (activeByNode.get(event.nodeId) ?? 1) - 1
              if (active === 0) activeByNode.delete(event.nodeId)
              else activeByNode.set(event.nodeId, active)
            }
          }
          const active = activeByNode.get(event.nodeId) ?? 0
          const capacity = heldNoteCapacityByNode.get(event.nodeId)
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
    scheduleGraph = graph
    validateCallbackCapacity(graph)
  }

  const awaitPreparation = async <Value>(operation: Promise<Value>): Promise<Value> => {
    const signal = hydrationAbortController.signal
    let onAbort: (() => void) | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        if (signal.aborted) { reject(signal.reason); return }
        onAbort = () => reject(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
      })])
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }

  const hydrationRangesFor = (startFrame: number, window: ScheduleWindowCandidate) => {
    const frameCountByAssetId = new Map(
      input.assets.map(({ asset }) => [asset.assetId, asset.frameCount]),
    )
    return window.sampleSourceEvents.flatMap((event) => {
      const sourceAssetKey = input.assetSourceKeys?.get(event.assetId)
      const totalFrames = frameCountByAssetId.get(event.assetId)
      if (!sourceAssetKey || totalFrames === undefined) return []
      const elapsedFrames = Math.max(0, startFrame - event.startFrame)
        * (sourceRates.get(event.assetId) ?? input.sampleRateHz) / input.sampleRateHz
      const sourceStart = event.sourceOffsetFrame + (event.sourceOffsetFraction ?? 0) + elapsedFrames
      const coverage = nativeMappedSourceCoverage(sourceStart, Math.max(0, Math.ceil(event.sourceFrameCount - elapsedFrames)), totalFrames)
      if (!coverage || coverage.frameCount === 0) return []
      return [{
        sourceAssetKey,
        startFrame: coverage.startFrame,
        endFrame: coverage.startFrame + coverage.frameCount,
      }]
    })
  }

  const queueWindow = async (
    startFrame: number,
    endFrame: number,
    window: ScheduleWindowCandidate,
    token?: string,
  ) => {
    const hydrationRanges = hydrationRangesFor(startFrame, window)
    if (input.pageManager && hydrationRanges.length > 0) {
      const hydration = input.pageManager.ensureRanges(hydrationRanges, hydrationAbortController.signal)
      if (preparedPublicationFrame === undefined) await hydration
      else await awaitPreparation(hydration)
    }
    const chunkCount = Math.max(
      Math.ceil(window.instrumentEvents.length / nativeInstrumentEventBatchSize),
      Math.ceil(window.sampleSourceEvents.length / nativeInstrumentEventBatchSize),
      Math.ceil(window.vstAutomationSegments.length / nativeInstrumentEventBatchSize),
      Math.ceil(window.processorAutomationEvents.length / nativeInstrumentEventBatchSize),
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
      const processorAutomationEvents = window.processorAutomationEvents.slice(
        chunk * nativeInstrumentEventBatchSize,
        (chunk + 1) * nativeInstrumentEventBatchSize,
      )
      const payload = serializeNativeScheduleWindow({
        revision: graphRevision,
        preparedRevision: preparedPublicationFrame === undefined ? 0 : graphRevision,
        requestedPublicationFrame: preparedPublicationFrame ?? 0,
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
        processorAutomationEvents,
        assets: input.assets,
      })
      let lastError: Error | undefined
      for (let attempt = 0; attempt < nativeScheduleSubmissionAttempts; attempt += 1) {
        hydrationAbortController.signal.throwIfAborted()
        if (disposed) throw new NativePlaybackAbortError("coordinator-disposed")
        const submission = input.bridge.queueScheduleWindow(payload, token)
        const reply = preparedPublicationFrame === undefined ? await submission : await awaitPreparation(submission)
        hydrationAbortController.signal.throwIfAborted()
        if (disposed) throw new NativePlaybackAbortError("coordinator-disposed")
        if (reply.ok) {
          lastError = undefined
          break
        }
        lastError = new Error(`Native schedule window ${windowId} (${startFrame}-${endFrame}) was rejected: ${reply.error}`)
        if (preparedPublicationFrame !== undefined && onPreparedWindowRejected) {
          await onPreparedWindowRejected()
          if (disposed) throw new NativePlaybackAbortError("coordinator-disposed")
        }
        if (attempt === 0 && input.pageManager && hydrationRanges.length > 0
          && /mapped|written|hydration|range/i.test(reply.error)) {
          input.pageManager.invalidateRanges(hydrationRanges)
          const hydration = input.pageManager.ensureRanges(hydrationRanges, hydrationAbortController.signal)
          if (preparedPublicationFrame === undefined) await hydration
          else await awaitPreparation(hydration)
        }
      }
      if (lastError) throw lastError
      submittedVstSegments += vstAutomationSegments.length
    }
    acceptedWindows.push({
      startFrame, endFrame, window,
      before: { activeNoteIds: new Map(activeNoteIds), emittedSources: new Map(emittedSources), sourceOrigins: new Map(sourceOrigins) },
    })
    nextWindowId += 1
    for (const [index, event] of window.instrumentEvents.entries()) {
      const key = window.instrumentEventKeys[index]
      if (!key) continue
      if (event.type === "note-on") activeNoteIds.set(key, { pitch: event.note, velocity: event.value })
      else if (event.type === "note-off") activeNoteIds.delete(key)
    }
    for (const [key, stopFrame] of window.sourceChanges) emittedSources.set(key, stopFrame)
    if (preparedPublicationFrame !== undefined && startFrame === input.startFrame) sourceOrigins.clear()
    for (const [key, origin] of window.sourceOrigins) sourceOrigins.set(key, origin)
    for (const [key, stopFrame] of emittedSources) {
      if (stopFrame <= startFrame) {
        emittedSources.delete(key)
        sourceOrigins.delete(key)
      }
    }
    nextSequence += window.sequenceCount
    nextWindowStartFrame = endFrame
    scheduleComplete = !acceptsLiveMidi && endFrame >= scheduleEndFrame
  }

  const compileRefillWindow = (start: number, end: number) => {
    if (!input.onRefillDiagnostics) return compileWindow(start, end)
    const started = performance.now()
    try {
      return compileWindow(start, end)
    } finally {
      const elapsed = performance.now() - started
      compileCount += 1
      compileTotalMs += elapsed
      compileMaxMs = Math.max(compileMaxMs, elapsed)
    }
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
    if (nextWindowStartFrame >= threshold) return
    while (!disposed && !scheduleComplete && nextWindowStartFrame < targetEnd) {
      // A retained source already has a native cursor through its old window.
      // Split at that cursor's end, then schedule its continuation, not a replay.
      let endFrame = Math.min(targetEnd, ...[...emittedSources.values()].filter((stop) => stop > nextWindowStartFrame))
      let candidate = compileRefillWindow(nextWindowStartFrame, endFrame)
      for (;;) {
        const chunkCount = Math.max(
          Math.ceil(candidate.instrumentEvents.length / nativeInstrumentEventBatchSize),
          Math.ceil(candidate.sampleSourceEvents.length / nativeInstrumentEventBatchSize),
          Math.ceil(candidate.vstAutomationSegments.length / nativeInstrumentEventBatchSize),
          Math.ceil(candidate.processorAutomationEvents.length / nativeInstrumentEventBatchSize),
          1,
        )
        if (
          chunkCount <= nativeScheduleChunkCount
          && candidate.instrumentEvents.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount
          && candidate.sampleSourceEvents.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount
          && candidate.vstAutomationSegments.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount
          && candidate.processorAutomationEvents.length <= nativeInstrumentEventBatchSize * nativeScheduleChunkCount
        ) break
        const shorter = nextWindowStartFrame + Math.max(
          1,
          Math.floor((endFrame - nextWindowStartFrame) / 2),
        )
        if (shorter >= endFrame) throw capacityError("a logical window cannot fit within the native wire limits.")
        endFrame = shorter
        candidate = compileRefillWindow(nextWindowStartFrame, endFrame)
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
    // Diagnostics are observational; consumer failures must not alter refill behavior.
    if (input.onRefillDiagnostics) {
      try { input.onRefillDiagnostics(refillDiagnostics()) } catch {}
    }
    if (refillInFlight !== marker) {
      release()
      return
    }
    refillInFlight = undefined
    release()
    if (!refillRequested || !refillEnabled || disposed || scheduleComplete || graphPublicationSuspended) return
    refillRequested = false
    const latest = latestProgress
    if (latest) requestRefill(latest, true)
  }

  const requestRefill = (progress: NativeScheduleProgress, force = false) => {
    if (disposed) return
    if (progress.revision !== graphRevision || progress.epoch !== input.epoch) return
    if (!force && progress.progressSequence <= (latestProgress?.progressSequence ?? 0n)) return
    if (!force && input.onRefillDiagnostics) progressCount += 1
    latestProgress = progress
    if (progress.scheduleComplete) {
      scheduleComplete = true
      refillRequested = false
    }
    refillFrame = Number(progress.renderedThroughFrame)
    while (acceptedWindows[0] && acceptedWindows[0].endFrame <= refillFrame) acceptedWindows.shift()
    input.onRenderedFrame?.(refillFrame)
    resolveWaiters(progress)
    if (!refillEnabled || scheduleComplete || refillFaulted || graphPublicationSuspended) return
    if (refillInFlight !== undefined) {
      refillRequested = true
      return
    }
    const { marker, operation, release } = beginRefill(refillFrame)
    void operation.then(() => {
      refillFailureCount = 0
    }).catch((error) => {
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
    const reason = new NativePlaybackAbortError("coordinator-disposed")
    hydrationAbortController.abort(reason)
    unsubscribeListeners()
    activeNoteIds.clear()
    emittedSources.clear()
    sourceOrigins.clear()
    acceptedWindows.length = 0
    failWaiters(reason)
  }

  const wait = <T extends { resolve: () => void; reject: (error: Error) => void }>(
    set: Set<T>,
    waiter: T,
  ) => new Promise<void>((resolve, reject) => {
    if (disposed) {
      reject(new NativePlaybackAbortError("coordinator-disposed"))
      return
    }
    waiter.resolve = resolve
    waiter.reject = reject
    set.add(waiter)
    if (latestProgress) resolveWaiters(latestProgress)
  })

  const coordinator: PagePreparingCoordinator = {
    async coverThrough(frame) {
      while (refillInFlight) await refillInFlight
      if (disposed) throw new NativePlaybackAbortError("coordinator-disposed")
      const { marker, operation, release } = beginRefill(frame)
      try { await operation } finally { finishRefill(marker, release) }
    },
    stageRevision(snapshot, graph, frame, onRejected, resources) {
      const accepted = acceptedWindows.find((window) => window.startFrame <= frame && window.endFrame > frame)
      if (!accepted) throw new Error("Native active schedule does not cover the publication seam.")
      const ownership = {
        activeNoteIds: new Map(accepted.before.activeNoteIds),
        emittedSources: new Map(accepted.before.emittedSources),
        sourceOrigins: new Map(accepted.before.sourceOrigins),
      }
      if (input.preparedPublicationFrame !== undefined && accepted.startFrame === input.startFrame)
        ownership.sourceOrigins.clear()
      for (const [index, event] of accepted.window.instrumentEvents.entries()) {
        if (event.frameOffset >= frame) continue
        const key = accepted.window.instrumentEventKeys[index]
        if (!key) continue
        if (event.type === "note-on") ownership.activeNoteIds.set(key, { pitch: event.note, velocity: event.value })
        else if (event.type === "note-off") ownership.activeNoteIds.delete(key)
      }
      for (const [key, stop, start] of accepted.window.sourceChanges) {
        if (start < frame && stop > frame) {
          ownership.emittedSources.set(key, stop)
          const origin = accepted.window.sourceOrigins.get(key)
          if (origin) ownership.sourceOrigins.set(key, origin)
        }
      }
      const oldInstruments = new Map(input.graph?.nodes.map((node) => [node.id, node.instrument]))
      const candidateAssetIds = new Map((resources?.assets ?? input.assets)
        .map(({ asset, sessionAssetId }) => [asset.assetId, sessionAssetId]))
      const retainedInstruments = new Set(graph.nodes.filter((node) => node.instrument
        && JSON.stringify(node.instrument) === JSON.stringify(oldInstruments.get(node.id))
        && (node.instrument.kind === "synth" || (
          node.instrument.kind === "granular" ? [node.instrument.assetId] : node.instrument.zones.map((zone) => zone.assetId)
        ).every((assetId) => sessionAssetIds.get(assetId) === candidateAssetIds.get(assetId)))).map((node) => node.id))
      for (const key of ownership.activeNoteIds.keys()) {
        const nodeId = key.split("\u0000")[loop ? 1 : 0]
        if (!nodeId || !retainedInstruments.has(nodeId)) ownership.activeNoteIds.delete(key)
      }
      // The candidate declares the complete audible set, independently of the
      // active bank's accepted horizon. Its origins remain private until proof.
      ownership.emittedSources.clear()
      return createNativeScheduleCoordinator({
        ...input, ...resources, snapshot, graph, startFrame: frame,
        preparedPublicationFrame: frame, initialOwnership: ownership,
        // Publication retains the transport epoch and the core's source sequence floor.
        initialSequence: nextSequence,
      }, onRejected)
    },
    activateRevision(proof) {
      if (disposed || preparedPublicationFrame === undefined || proof.status !== "published"
        || proof.activeRevision !== graphRevision || proof.publicationFrame !== BigInt(preparedPublicationFrame)) return false
      preparedPublicationFrame = undefined
      onPreparedWindowRejected = undefined
      return true
    },
    async suspendGraphPublication() {
      graphPublicationSuspended = true
      if (refillInFlight) await refillInFlight
    },
    resumeGraphPublication(revision) {
      graphRevision = revision
      graphPublicationSuspended = false
      if (latestProgress?.revision === revision) requestRefill(latestProgress, true)
    },
    install,
    dispose,
    abortPreparation: () => hydrationAbortController.abort(new NativePlaybackAbortError("coordinator-disposed")),
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
    async preparePages(fromFrame, seamFrame) {
      const end = Math.min(ownedScheduleEndFrame, seamFrame + Math.max(
        input.capacity.maximumFramesPerBlock,
        Math.round(input.sampleRateHz * nativeScheduleLookaheadSec),
      ))
      const ranges = hydrationRangesFor(fromFrame, compileWindow(fromFrame, end))
      if (input.pageManager && ranges.length > 0)
        await awaitPreparation(input.pageManager.ensureRanges(ranges, hydrationAbortController.signal))
    },
    async prepareCandidatePages(snapshot, graph, fromFrame, seamFrame, resources, signal) {
      // Compiled on private, empty ledgers: every audible source is declared from `fromFrame`, as a published bank would.
      const candidate = buildNativeScheduleCoordinator({
        ...input, ...resources, snapshot, graph, startFrame: fromFrame, preparedPublicationFrame: fromFrame,
        initialOwnership: { activeNoteIds: new Map(), emittedSources: new Map(), sourceOrigins: new Map() },
        initialSequence: nextSequence,
      })
      const abort = () => candidate.abortPreparation()
      signal.addEventListener("abort", abort, { once: true })
      try {
        if (signal.aborted) abort()
        await candidate.preparePages(fromFrame, seamFrame)
      } finally {
        signal.removeEventListener("abort", abort)
        candidate.dispose()
      }
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
    refillDiagnostics,
  }
  return coordinator
}

export const createNativeScheduleCoordinator = (...args: Parameters<typeof buildNativeScheduleCoordinator>): NativeScheduleCoordinator =>
  buildNativeScheduleCoordinator(...args)
