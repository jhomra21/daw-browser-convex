import {
  selectPortableWasmAudioWorkletBackend,
  portableWasmPagedPreparationCount,
  type PortableWasmCapability,
  type PortableWasmBackendSelection,
  type PortableWasmPlaybackSession,
  WasmAudioWorkletBackend,
} from "@daw-browser/audio-engine/wasm-audio-worklet-backend"
import { LIVE_SCHEDULE_HORIZON_SEC } from "@daw-browser/audio-engine/audio-engine"
import type { AudioAssetRef, AudioCoreGraphSnapshot, PlanarPcm } from "@daw-browser/audio-core-contract"
import type {
  PreparedPortableSession,
  PortableAssetRegistryInput,
  PortablePreparedQualification,
} from "@daw-browser/audio-engine/portable-session-compiler"
import {
  portableWasmPagedMaxChannels,
  portableWasmPagedPageFrames,
  portableWasmPagedSlotCount,
  portableWasmProtocolVersion,
  type PortableWasmPreparedSourceEvent,
  type PortableWasmStatusMessage,
} from "@daw-browser/audio-engine/portable-wasm-protocol"
import { RECORDER_BLOCK_FRAMES, RECORDER_MAX_QUEUED_BLOCKS } from "@daw-browser/audio-engine/recording-protocol"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import { compilePreparedPortableLiveSession } from "~/lib/portable-live-session"
import type { LivePlaybackCompileContext, LivePlaybackSnapshot, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import { createPortableRecordingWriter } from "~/lib/recording/portable-recording-writer"
import type {
  LiveProcessorControl,
  LiveProcessorControlRequest,
  LiveProcessorControlResult,
} from "~/lib/live-processor-control"
import type { PortablePreparedStretchAsset } from "@daw-browser/audio-engine/portable-stretch-preparation"
import {
  preparePortablePagedStretchAssets,
  type PortablePagedStretchAsset,
} from "@daw-browser/audio-engine/portable-stretch-paging"
import {
  createPreparedStretchArtifactRepository,
  type PreparedStretchArtifactRepository,
} from "@daw-browser/audio-engine/prepared-stretch-store"
import type { AudioPcmSourceResolver } from "~/lib/audio-pcm-source-resolver"
import type { AudioPcmSourceDescriptor, DecodedAudioPage } from "@daw-browser/audio-engine/media-pages"

type PortableStartResult = "started" | "unavailable"
type PortablePreparedStretch = PortablePreparedStretchAsset | PortablePagedStretchAsset
type PortableOrdinaryDescriptor = {
  asset: AudioAssetRef
  descriptor: AudioPcmSourceDescriptor
}
type PortableScheduleRange = Extract<PreparedPortableSession, { supported: true }>["scheduleRange"]
type PortableSessionFault = {
  error?: Error
}

type PortableSession = Pick<
  PortableWasmPlaybackSession,
  | "connectInput" | "dispose" | "installSchedule" | "markActive" | "onFault" | "onRecordingStatus" | "postRecordingControl" | "prepareGraph" | "publishGraph" | "registerAsset" | "scheduleSources" | "setTransport"
> & {
  pagedCapabilities?: PortableWasmPlaybackSession["pagedCapabilities"]
  registerPagedAsset?: PortableWasmPlaybackSession["registerPagedAsset"]
  writeAssetPage?: PortableWasmPlaybackSession["writeAssetPage"]
  prepareAssetRange?: PortableWasmPlaybackSession["prepareAssetRange"]
  schedulePreparedSources?: PortableWasmPlaybackSession["schedulePreparedSources"]
  replaceSources?: PortableWasmPlaybackSession["replaceSources"]
  resetSources?: PortableWasmPlaybackSession["resetSources"]
  releaseAssetPreparation?: PortableWasmPlaybackSession["releaseAssetPreparation"]
  trimAssetPages?: PortableWasmPlaybackSession["trimAssetPages"]
  queueProcessorEvents?: PortableWasmPlaybackSession["queueProcessorEvents"]
  reenableProcessorAutomation?: PortableWasmPlaybackSession["reenableProcessorAutomation"]
  onTransportPosition?: PortableWasmPlaybackSession["onTransportPosition"]
  onGraphContinuity?: PortableWasmPlaybackSession["onGraphContinuity"]
}

const isPagedStretchAsset = (
  asset: PortablePreparedStretch,
): asset is PortablePagedStretchAsset => "manifest" in asset

type PortableBackend = {
  createPlaybackSession: (
    context: BaseAudioContext,
    capability: Extract<PortableWasmCapability, { available: true }>,
    maxFramesPerBlock: number,
  ) => Promise<PortableSession>
}

const portableRecordingControlTimeoutMs = 2_000
// The native portable core reserves this fixed preparation table. It is not
// part of the wire capability payload, so the backend exposes the local
// default alongside the runtime paged capabilities.
const portablePagedPreparationCapacity = portableWasmPagedPreparationCount
export type PortableRecordingDiagnostics = Extract<PortableWasmStatusMessage, { type: "recording-capture-diagnostics" }>

const deferred = <T>() => {
  let resolve = (_value: T) => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const boundedControl = <T>(promise: Promise<T>, message: string) => new Promise<T>((resolve, reject) => {
  // Control acknowledgements are bounded so a lost worklet cannot leave input
  // monitoring or MediaStream resources active indefinitely.
  const deadline = setTimeout(() => reject(new Error(message)), portableRecordingControlTimeoutMs)
  promise.then((value) => {
    clearTimeout(deadline)
    resolve(value)
  }, (cause: unknown) => {
    clearTimeout(deadline)
    reject(cause)
  })
})

const planarPcm = (buffer: AudioBuffer): PlanarPcm => ({
  frameCount: buffer.length,
  planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
})

const instrumentAssetKeys = (snapshot: LivePlaybackSnapshot) => new Set(
  Object.values(snapshot.mixer.fx.trackFx ?? {}).flatMap((entry) => {
    if (entry.instrument?.kind === 'sampler') {
      return entry.instrument.params.zones.map((zone) => zone.sample.assetKey)
    }
    if (entry.instrument?.kind === 'drum-rack') {
      return entry.instrument.params.pads.flatMap((pad) => pad.sample ? [pad.sample.assetKey] : [])
    }
    if (entry.instrument?.kind === 'granular' && entry.instrument.params.zone) {
      return [entry.instrument.params.zone.sample.assetKey]
    }
    return []
  }),
)

const isInstalledSnapshotAsset = (
  snapshot: LivePlaybackSnapshot,
  assetId: string,
  instrumentKeys: ReadonlySet<string>,
) => {
  const usedByStretch = snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.sourceAssetKey === assetId
    && clip.audioWarp?.enabled === true
    && clip.audioWarp.mode === 'stretch'
  )))
  const usedByInstalledSource = snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.sourceAssetKey === assetId
    && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch')
  )))
  return !usedByStretch || usedByInstalledSource || instrumentKeys.has(assetId)
}

const assetRegistry = (
  snapshot: LivePlaybackSnapshot,
  generation: number,
  preparedStretchAssets: readonly PortablePreparedStretch[] = [],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
): PortableAssetRegistryInput => ({
  projectGeneration: generation,
  assets: [
    ...(() => {
      const instrumentKeys = instrumentAssetKeys(snapshot)
      return snapshot.assets.flatMap((asset) => {
        const buffer = asset.buffer
        const descriptor = ordinaryDescriptors.get(asset.assetId)
        if ((!buffer && !descriptor) || !isInstalledSnapshotAsset(snapshot, asset.assetId, instrumentKeys)) return []
        if (!buffer && instrumentKeys.has(asset.assetId)) return []
        return [{
          projectAssetId: asset.assetId,
          portableAssetId: asset.assetId,
          projectGeneration: generation,
          handle: { slot: 0, generation },
          decoded: {
            sampleRateHz: buffer?.sampleRate ?? descriptor?.descriptor.sampleRate ?? 0,
            channelCount: buffer?.numberOfChannels ?? descriptor?.descriptor.channelCount ?? 0,
            frameCount: buffer?.length ?? descriptor?.descriptor.frameCount ?? 0,
          },
        }]
      }).map((entry, slot) => ({ ...entry, handle: { ...entry.handle, slot } }))
    })(),
    ...[...new Map(preparedStretchAssets.map((prepared) => [prepared.portableAssetId, prepared])).values()]
      .map((prepared, slot) => ({
        projectAssetId: prepared.projectAssetId,
        portableAssetId: prepared.portableAssetId,
        projectGeneration: generation,
        handle: { slot: installedSnapshotAssetCount(snapshot, ordinaryDescriptors) + slot, generation },
        decoded: {
          sampleRateHz: prepared.asset.sampleRateHz,
          channelCount: prepared.asset.channelCount,
          frameCount: prepared.asset.frameCount,
        },
      })),
  ],
})

const installedSnapshotAssetCount = (
  snapshot: LivePlaybackSnapshot,
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
) => {
  const instrumentKeys = instrumentAssetKeys(snapshot)
  return snapshot.assets.reduce((count, asset) => {
    if (!asset.buffer && !ordinaryDescriptors.has(asset.assetId)) return count
    return count + (isInstalledSnapshotAsset(snapshot, asset.assetId, instrumentKeys) ? 1 : 0)
  }, 0)
}

const resolveOrdinaryDescriptors = async (
  snapshot: LivePlaybackSnapshot,
  resolveSource: AudioPcmSourceResolver | undefined,
  signal?: AbortSignal,
) => {
  const clipsByAsset = new Map<string, LivePlaybackSnapshot["tracks"][number]["clips"][number]>()
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      if (clip.sourceAssetKey
        && !clip.midi
        && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === "stretch")) {
        clipsByAsset.set(clip.sourceAssetKey, clip)
      }
    }
  }
  const descriptors = new Map<string, PortableOrdinaryDescriptor>()
  for (const asset of snapshot.assets) {
    if (asset.buffer || !clipsByAsset.has(asset.assetId)) continue
    if (!resolveSource) throw new Error(`Audio asset "${asset.assetId}" has no source resolver.`)
    const clip = clipsByAsset.get(asset.assetId)
    if (!clip) continue
    signal?.throwIfAborted()
    const descriptor = await resolveSource(clip, signal)
    if (descriptor.frameCount <= 0 || descriptor.channelCount > portableWasmPagedMaxChannels) {
      throw new Error(`Portable audio asset "${asset.assetId}" has incompatible paged metadata.`)
    }
    if (asset.source && (
      descriptor.sampleRate !== asset.source.sampleRate
      || descriptor.channelCount !== asset.source.channelCount
      || descriptor.frameCount !== Math.round(asset.source.durationSec * asset.source.sampleRate)
    )) throw new Error(`Portable audio asset "${asset.assetId}" descriptor metadata is inconsistent.`)
    descriptors.set(asset.assetId, {
      asset: {
        version: 1,
        assetId: asset.assetId,
        frameCount: descriptor.frameCount,
        sampleRateHz: descriptor.sampleRate,
        channelCount: descriptor.channelCount,
      },
      descriptor,
    })
  }
  return descriptors
}

const preparedSession = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
  epoch: number,
  projectGeneration: number,
  horizonSec: number,
  sourceFirstSequence = 1,
  preparedStretchAssets: readonly PortablePreparedStretch[] = [],
  sourceRangeStartSec?: number,
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
): PreparedPortableSession => compilePreparedPortableLiveSession(snapshot, {
  assetRegistry: assetRegistry(snapshot, projectGeneration, preparedStretchAssets, ordinaryDescriptors),
  preparedStretchAssets: new Map(preparedStretchAssets.map((asset) => [asset.clipId, asset])),
  sampleRateHz,
  transportEpoch: epoch,
  timeOrigin: {
    timelineSec: snapshot.transport.playheadSec,
    frame: Math.round(snapshot.transport.playheadSec * sampleRateHz),
  },
  rangeEndSec: snapshot.transport.playheadSec + horizonSec,
  sourceRangeStartSec,
  clipSpanningNoteOn: true,
  sourceFirstSequence,
})

type PortablePagedPreparation = {
  id: number
  assetId: string
  pageKeys: readonly string[]
  stopFrame: number
  epoch: number
  released: boolean
}

type PortablePreparedSource = PortableWasmPreparedSourceEvent & {
  preparation: PortablePagedPreparation
}

const pagedSourceCoverage = (
  asset: {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  },
  source: Extract<PreparedPortableSession, { supported: true }>["sources"][number],
) => {
  const sourceOffset = source.sourceOffsetFrame + (source.sourceOffsetFraction ?? 0)
  const lastPosition = sourceOffset + source.sourceFrameCount - 1
  const coverageEnd = Math.min(asset.asset.frameCount, Math.floor(lastPosition) + 2)
  if (
    !Number.isFinite(sourceOffset)
    || !Number.isSafeInteger(source.sourceOffsetFrame)
    || source.sourceOffsetFrame < 0
    || !Number.isSafeInteger(source.sourceFrameCount)
    || source.sourceFrameCount < 1
    || source.sourceOffsetFrame >= asset.asset.frameCount
    || source.sourceFrameCount > asset.asset.frameCount - source.sourceOffsetFrame
    || coverageEnd <= source.sourceOffsetFrame
  ) return undefined
  const firstPage = Math.floor(source.sourceOffsetFrame / asset.pageFrames)
  const lastPage = Math.floor((coverageEnd - 1) / asset.pageFrames)
  const pageKeys = Array.from(
    { length: lastPage - firstPage + 1 },
    (_, index) => `${asset.asset.assetId}:${firstPage + index}`,
  )
  return { firstPage, lastPage, coverageEnd, pageKeys }
}

const requiredPagedPagePlan = (
  sources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][],
  preparedStretchAssets: readonly PortablePreparedStretch[],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>,
) => {
  const pagedAssets = new Map<string, {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  }>([
    ...[...ordinaryDescriptors.values()].map((entry) => [entry.asset.assetId, {
      asset: entry.asset,
      pageFrames: portableWasmPagedPageFrames,
      descriptor: entry.descriptor,
    }] as const),
    ...preparedStretchAssets.filter(isPagedStretchAsset).map((asset) => [asset.asset.assetId, {
      asset: asset.asset,
      pageFrames: asset.manifest.pageFrames,
      artifactId: asset.artifactId,
    }] as const),
  ])
  const keys = new Set<string>()
  let preparationCount = 0
  for (const source of sources) {
    const asset = pagedAssets.get(source.assetId)
    if (!asset) continue
    const coverage = pagedSourceCoverage(asset, source)
    if (!coverage) return undefined
    preparationCount += 1
    for (const key of coverage.pageKeys) keys.add(key)
  }
  return { pageKeys: keys, preparationCount }
}

const pagedCapacityError = (input: {
  pageCount: number
  pageCapacity: number
  preparationCount: number
  preparationCapacity: number
  baselinePreparationCount?: number
}) => {
  if (input.pageCount > input.pageCapacity) {
    return new Error(
      `Portable paged playback requires ${input.pageCount} resident pages, `
        + `but only ${input.pageCapacity} are available.`,
    )
  }
  const totalPreparations = input.preparationCount + (input.baselinePreparationCount ?? 0)
  if (totalPreparations > input.preparationCapacity) {
    if (input.baselinePreparationCount === undefined) {
      return new Error(
        `Portable paged playback requires ${input.preparationCount} prepared ranges, `
          + `but only ${input.preparationCapacity} are available.`,
      )
    }
    return new Error(
      `Portable paged playback refresh requires ${totalPreparations} prepared ranges `
        + `(${input.baselinePreparationCount ?? 0} active baseline + ${input.preparationCount} continuation), `
        + `but only ${input.preparationCapacity} are available.`,
    )
  }
  return undefined
}

const fitPortableStartupHorizon = (input: {
  snapshot: LivePlaybackSnapshot
  sampleRateHz: number
  epoch: number
  projectGeneration: number
  requestedHorizonSec: number
  sourceFirstSequence: number
  preparedStretchAssets: readonly PortablePreparedStretch[]
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
  pageSlotCapacity: number
  preparationCapacity: number
  signal?: AbortSignal
}) => {
  const pageFrames = portableWasmPagedPageFrames
  const requestedFrames = Math.max(pageFrames, Math.round(input.requestedHorizonSec * input.sampleRateHz))
  for (
    let horizonFrames = requestedFrames;
    horizonFrames >= pageFrames;
    horizonFrames -= pageFrames
  ) {
    input.signal?.throwIfAborted()
    const horizonSec = horizonFrames / input.sampleRateHz
    const prepared = preparedSession(
      input.snapshot,
      input.sampleRateHz,
      input.epoch,
      input.projectGeneration,
      horizonSec,
      input.sourceFirstSequence,
      input.preparedStretchAssets,
      undefined,
      input.ordinaryDescriptors,
    )
    if (!prepared.supported) continue
    const plan = requiredPagedPagePlan(
      prepared.sources,
      input.preparedStretchAssets,
      input.ordinaryDescriptors,
    )
    if (!plan) throw new Error("Portable paged source range is outside its prepared asset.")
    if (
      plan.pageKeys.size <= input.pageSlotCapacity
      && plan.preparationCount <= input.preparationCapacity
    ) return prepared
  }
  const minimumPrepared = preparedSession(
    input.snapshot,
    input.sampleRateHz,
    input.epoch,
    input.projectGeneration,
    pageFrames / input.sampleRateHz,
    input.sourceFirstSequence,
    input.preparedStretchAssets,
    undefined,
    input.ordinaryDescriptors,
  )
  if (!minimumPrepared.supported) throw new Error("Portable paged playback minimum horizon is unsupported.")
  const minimumPlan = requiredPagedPagePlan(
    minimumPrepared.sources,
    input.preparedStretchAssets,
    input.ordinaryDescriptors,
  )
  if (!minimumPlan) throw new Error("Portable paged source range is outside its prepared asset.")
  const capacityError = pagedCapacityError({
    pageCount: minimumPlan.pageKeys.size,
    pageCapacity: input.pageSlotCapacity,
    preparationCount: minimumPlan.preparationCount,
    preparationCapacity: input.preparationCapacity,
  })
  if (capacityError) throw capacityError
  throw new Error(
    `Portable paged playback requires ${minimumPlan.preparationCount} prepared ranges, `
      + `but only ${input.preparationCapacity} are available.`,
  )
}

const readPortableWasmPages = async function* (input: {
  descriptor: AudioPcmSourceDescriptor
  startFrame: number
  endFrame: number
  signal?: AbortSignal
}): AsyncGenerator<DecodedAudioPage> {
  const pageFrames = portableWasmPagedPageFrames
  const { descriptor, startFrame, endFrame, signal } = input
  let expectedStartFrame = startFrame
  let accumulatedFrames = 0
  let accumulatedPlanes: Float32Array[] | undefined

  for await (const page of descriptor.readPages({ startFrame, endFrame, signal })) {
    signal?.throwIfAborted()
    if (
      !Number.isSafeInteger(page.startFrame)
      || !Number.isSafeInteger(page.frameCount)
      || page.startFrame !== expectedStartFrame
      || page.frameCount <= 0
      || page.startFrame + page.frameCount > endFrame
      || page.sampleRate !== descriptor.sampleRate
      || page.channelCount !== descriptor.channelCount
      || page.planes.length !== descriptor.channelCount
      || page.planes.some((plane) => plane.length !== page.frameCount)
    ) {
      throw new Error("Portable ordinary source page metadata or coverage is invalid.")
    }
    const planes = accumulatedPlanes ?? Array.from(
      { length: descriptor.channelCount },
      () => new Float32Array(pageFrames),
    )
    accumulatedPlanes = planes
    let pageOffset = 0
    while (pageOffset < page.frameCount) {
      signal?.throwIfAborted()
      const copyFrames = Math.min(page.frameCount - pageOffset, pageFrames - accumulatedFrames)
      for (let channel = 0; channel < descriptor.channelCount; channel += 1) {
        const sourcePlane = page.planes[channel]
        const destinationPlane = planes[channel]
        if (!sourcePlane || !destinationPlane) {
          throw new Error("Portable ordinary source page channel metadata is invalid.")
        }
        destinationPlane.set(
          sourcePlane.subarray(pageOffset, pageOffset + copyFrames),
          accumulatedFrames,
        )
      }
      pageOffset += copyFrames
      accumulatedFrames += copyFrames
      expectedStartFrame += copyFrames
      if (accumulatedFrames === pageFrames) {
        yield {
          startFrame: expectedStartFrame - pageFrames,
          frameCount: pageFrames,
          sampleRate: descriptor.sampleRate,
          channelCount: descriptor.channelCount,
          planes,
        }
        accumulatedPlanes = undefined
        accumulatedFrames = 0
      }
    }
  }
  signal?.throwIfAborted()
  if (expectedStartFrame !== endFrame) {
    throw new Error("Portable ordinary source pages do not cover the requested range exactly.")
  }
  if (accumulatedFrames > 0) {
    if (!accumulatedPlanes) throw new Error("Portable ordinary source page accumulator is missing.")
    yield {
      startFrame: endFrame - accumulatedFrames,
      frameCount: accumulatedFrames,
      sampleRate: descriptor.sampleRate,
      channelCount: descriptor.channelCount,
      planes: accumulatedPlanes.map((plane) => plane.slice(0, accumulatedFrames)),
    }
  }
}

const preparePagedSources = async (input: {
  session: PortableSession
  sources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  preparedStretchAssets: readonly PortablePreparedStretch[]
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
  repository: PreparedStretchArtifactRepository
  generation: number
  preparationCapacity: number
  baselinePreparationCount?: number
  pinnedPageKeys?: ReadonlySet<string>
  signal?: AbortSignal
}): Promise<{
  events: readonly PortableWasmPreparedSourceEvent[]
  preparations: readonly PortablePagedPreparation[]
}> => {
  const pagedAssets = new Map<string, {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  }>([
    ...[...input.ordinaryDescriptors.values()].map((entry) => [entry.asset.assetId, {
      asset: entry.asset,
      pageFrames: portableWasmPagedPageFrames,
      descriptor: entry.descriptor,
    }] as const),
    ...input.preparedStretchAssets.filter(isPagedStretchAsset).map((asset) => [asset.asset.assetId, {
      asset: asset.asset,
      pageFrames: asset.manifest.pageFrames,
      artifactId: asset.artifactId,
    }] as const),
  ])
  if (pagedAssets.size === 0) return { events: [], preparations: [] }
  if (!input.session.prepareAssetRange || !input.session.writeAssetPage || !input.session.releaseAssetPreparation) {
    throw new Error("Portable playback backend does not expose paged asset support.")
  }
  const requiredPages = new Map<string, Set<number>>()
  const pagePlan = requiredPagedPagePlan(input.sources, input.preparedStretchAssets, input.ordinaryDescriptors)
  if (!pagePlan) throw new Error("Portable Stretch source range is outside its prepared asset.")
  const pageKeys = pagePlan.pageKeys
  const pinnedPageKeys = input.pinnedPageKeys ?? new Set<string>()
  const unionPageCount = new Set([...pinnedPageKeys, ...pageKeys]).size
  const capacityError = pagedCapacityError({
    pageCount: unionPageCount,
    pageCapacity: input.session.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
    preparationCount: pagePlan.preparationCount,
    preparationCapacity: input.preparationCapacity,
    baselinePreparationCount: input.baselinePreparationCount,
  })
  if (capacityError) throw capacityError
  for (const source of input.sources) {
    const asset = pagedAssets.get(source.assetId)
    if (!asset) continue
    const coverage = pagedSourceCoverage(asset, source)
    if (!coverage) throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" is invalid.`)
    const pages = requiredPages.get(source.assetId) ?? new Set<number>()
    for (let page = coverage.firstPage; page <= coverage.lastPage; page += 1) pages.add(page)
    requiredPages.set(source.assetId, pages)
  }
  const availableSlots = input.session.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount
  if (unionPageCount > availableSlots) {
    throw new Error(`Portable paged playback requires ${unionPageCount} resident pages, but only ${availableSlots} are available.`)
  }
  const preparations: PortablePagedPreparation[] = []
  try {
    input.signal?.throwIfAborted()
    for (const [assetId, pages] of requiredPages) {
      const asset = pagedAssets.get(assetId)
      if (!asset) continue
      for (const pageIndex of pages) {
        input.signal?.throwIfAborted()
        const pageStart = pageIndex * asset.pageFrames
        const pageEnd = Math.min(asset.asset.frameCount, pageStart + asset.pageFrames)
        if (pageEnd <= pageStart) throw new Error(`Portable Stretch page ${pageIndex} is outside its asset.`)
        const range = await input.session.prepareAssetRange(
          assetId,
          input.generation,
          pageStart,
          pageEnd - pageStart,
          0,
        )
        if (range.status === "prepared") {
          const release = await input.session.releaseAssetPreparation(range.preparationId, input.generation)
          if (release !== "released") throw new Error(`Portable Stretch page preparation could not be released (${release}).`)
          continue
        }
        if (range.status !== "missing-page" || range.firstMissingPage === undefined) {
          throw new Error(`Portable Stretch page range for "${assetId}" was rejected (${range.status}).`)
        }
        const firstFrame = range.firstMissingPage * asset.pageFrames
        const endFrame = Math.min(asset.asset.frameCount, firstFrame + asset.pageFrames)
        const pages = asset.descriptor
          ? readPortableWasmPages({
            descriptor: asset.descriptor,
            startFrame: firstFrame,
            endFrame,
            signal: input.signal,
          })
          : asset.artifactId
            ? input.repository.read(asset.artifactId, firstFrame, endFrame)
            : undefined
        if (!pages) throw new Error(`Portable asset "${assetId}" has no page source.`)
        for await (const page of pages) {
          input.signal?.throwIfAborted()
          const pageIndex = page.startFrame / asset.pageFrames
          if (
            !Number.isSafeInteger(pageIndex)
            || pageIndex < 0
            || page.startFrame !== pageIndex * asset.pageFrames
            || page.frameCount <= 0
            || page.frameCount > asset.pageFrames
            || page.startFrame + page.frameCount > asset.asset.frameCount
            || page.sampleRate !== asset.asset.sampleRateHz
            || page.channelCount !== asset.asset.channelCount
            || page.planes.length !== asset.asset.channelCount
            || page.planes.some((plane) => plane.length !== page.frameCount)
          ) throw new Error(`Portable asset "${assetId}" page metadata or coverage is invalid.`)
          const result = await input.session.writeAssetPage(assetId, input.generation, pageIndex, page.frameCount, page.planes)
          input.signal?.throwIfAborted()
          if (result.status !== "written") throw new Error(`Portable page ${pageIndex} was rejected (${result.status}).`)
        }
      }
    }
    const events: PortableWasmPreparedSourceEvent[] = []
    for (const source of input.sources) {
      input.signal?.throwIfAborted()
      const asset = pagedAssets.get(source.assetId)
      if (!asset) continue
      const coverage = pagedSourceCoverage(asset, source)
      if (!coverage) throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" is invalid.`)
      const range = await input.session.prepareAssetRange(
        source.assetId,
        input.generation,
        source.sourceOffsetFrame,
        coverage.coverageEnd - source.sourceOffsetFrame,
        0,
      )
      input.signal?.throwIfAborted()
      if (range.status !== "prepared") {
        throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" was rejected (${range.status}).`)
      }
      events.push({
        ...source,
        preparationId: range.preparationId,
      })
      preparations.push({
        id: range.preparationId,
        assetId: source.assetId,
        pageKeys: coverage.pageKeys,
        stopFrame: source.stopFrame,
        epoch: input.generation,
        released: false,
      })
    }
    return { events, preparations }
  } catch (error) {
    await Promise.all(preparations.map((preparation) => input.session.releaseAssetPreparation?.(preparation.id, input.generation)))
    throw error
  }
}

const scheduleSourcesInGlobalOrder = async (input: {
  session: PortableSession
  revision: number
  epoch: number
  ordinary: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  prepared: readonly PortableWasmPreparedSourceEvent[]
}) => {
  const ordinaryBySequence = new Map(input.ordinary.map((source) => [source.sequence, source]))
  const preparedBySequence = new Map(input.prepared.map((source) => [source.sequence, source]))
  const sequences = [...new Set([...ordinaryBySequence.keys(), ...preparedBySequence.keys()])].sort((left, right) => left - right)
  if (sequences.length === 0) {
    await input.session.scheduleSources(input.revision, input.epoch, [])
    return
  }
  let index = 0
  while (index < sequences.length) {
    const firstSequence = sequences[index]
    if (firstSequence === undefined) break
    const isPrepared = preparedBySequence.has(firstSequence)
    if (isPrepared) {
      if (!input.session.schedulePreparedSources) {
        throw new Error("Portable playback backend does not expose paged asset support.")
      }
      const group: PortableWasmPreparedSourceEvent[] = []
      while (index < sequences.length) {
        const sequence = sequences[index]
        if (sequence === undefined || !preparedBySequence.has(sequence)) break
        const event = preparedBySequence.get(sequence)
        if (!event) throw new Error(`Portable source sequence ${sequence} is missing from its schedule group.`)
        group.push(event)
        index += 1
      }
      await input.session.schedulePreparedSources(
        input.revision,
        input.epoch,
        group,
      )
    } else {
      const group: Extract<PreparedPortableSession, { supported: true }>["sources"][number][] = []
      while (index < sequences.length) {
        const sequence = sequences[index]
        if (sequence === undefined || preparedBySequence.has(sequence)) break
        const event = ordinaryBySequence.get(sequence)
        if (!event) throw new Error(`Portable source sequence ${sequence} is missing from its schedule group.`)
        group.push(event)
        index += 1
      }
      await input.session.scheduleSources(
        input.revision,
        input.epoch,
        group,
      )
    }
  }
}

const replaceSourcesAtomically = async (input: {
  session: PortableSession
  revision: number
  epoch: number
  ordinary: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  prepared: readonly PortableWasmPreparedSourceEvent[]
}) => {
  if (input.session.replaceSources) {
    await input.session.replaceSources(input.revision, input.epoch, input.ordinary, input.prepared)
    return
  }
  await scheduleSourcesInGlobalOrder(input)
}

type PortableRecordingSession = {
  numericSessionId: number
  source: MediaStreamAudioSourceNode
  disconnectInput: () => void
  unsubscribeStatus: () => void
  unsubscribeTrack: () => void
  writer: ReturnType<typeof createPortableRecordingWriter>
  configured: ReturnType<typeof deferred<number>>
  finalized: ReturnType<typeof deferred<void>>
  cancelled: ReturnType<typeof deferred<void>>
  diagnostics?: PortableRecordingDiagnostics
  onFailure?: (error: Error) => void
  phase: "configuring" | "recording" | "finalizing" | "cancelling"
  configurationPending: boolean
  terminal: boolean
}

/**
 * Activates the browser portable renderer only after its immutable payload,
 * worklet, graph, assets, source schedule, and running transport are all
 * acknowledged. A failure before activation leaves the caller on legacy;
 * a fault after activation disconnects the portable node without fallback.
 */
export const createPortableBrowserPlaybackController = (input: {
  compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
  getAudioContext: () => AudioContext | null
  scheduleHorizonSec?: number
  getProjectGeneration?: () => number
  resolveSource?: AudioPcmSourceResolver
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  reportFault?: (message: string) => void
  onGraphContinuity?: (message: Extract<PortableWasmStatusMessage, { type: "graph-continuity" }>) => void
  backend?: PortableBackend
  select?: (project: PortablePreparedQualification) => Promise<PortableWasmBackendSelection>
  createRecordingWriter?: typeof createPortableRecordingWriter
  createPreparedStretchRepository?: () => PreparedStretchArtifactRepository
}) => {
  const backend = input.backend ?? new WasmAudioWorkletBackend()
  const select = input.select ?? ((project) => selectPortableWasmAudioWorkletBackend(undefined, project))
  const safeProjectGeneration = (generation: number) =>
    Number.isSafeInteger(generation) && generation > 0 ? generation : 1
  let active: PortableSession | undefined
  let activeProjectGeneration: number | undefined
  let activeTransport: LivePlaybackTransport | undefined
  let activeScheduleRange: PortableScheduleRange | undefined
  let playing = false
  let pendingStart: Promise<PortableStartResult> | undefined
  let pendingStartMode: "play" | "preview" | undefined
  let lifecycleGeneration = 0
  let recording: PortableRecordingSession | undefined
  let epoch = 0
  let positionFrame = 0
  let positionSequence = 0
  let activeSourceSequence = 0
  let refreshPromise: Promise<PortableStartResult> | undefined
  let transportIntent = 0
  let failedRefreshEndFrame: number | undefined
  let activeRevision: number | undefined
  let activeGraph: AudioCoreGraphSnapshot | undefined
  let activeFrameSchedule: Extract<PreparedPortableSession, { supported: true }>["schedule"] | undefined
  let activePreparedStretchAssets: readonly PortablePreparedStretch[] = []
  let activeOrdinarySources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][] = []
  let activeOrdinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map()
  let activePreparedSources: readonly PortablePreparedSource[] = []
  let activePreparations: readonly PortablePagedPreparation[] = []
  let nextLiveProcessorSequence = 0
  let nextRecordingSessionId = 1
  let unsubscribeFault: (() => void) | undefined
  let startupAbortController: AbortController | undefined
  const stretchRepository = input.createPreparedStretchRepository?.() ?? createPreparedStretchArtifactRepository()
  let repositoryDisposed = false
  const releasePreparedStretchAssets = async (assets: readonly PortablePreparedStretch[]) => {
    const leases = new Set(assets.filter(isPagedStretchAsset).map((asset) => asset.lease))
    await Promise.all([...leases].map((lease) => lease.release().catch(() => undefined)))
  }

  const clearActiveSessionState = () => {
    const session = active
    const generation = epoch
    const cleanup: Promise<unknown>[] = []
    active = undefined
    activeProjectGeneration = undefined
    activeTransport = undefined
    activeScheduleRange = undefined
    activeRevision = undefined
    activeGraph = undefined
    activeFrameSchedule = undefined
    if (session?.releaseAssetPreparation && generation !== undefined) {
      for (const preparation of activePreparations) {
        if (!preparation.released) {
          cleanup.push(session.releaseAssetPreparation(preparation.id, generation).then((result) => {
            if (result === "released") preparation.released = true
          }).catch(() => undefined))
        }
      }
    }
    activePreparations = []
    activeOrdinarySources = []
    activeOrdinaryDescriptors = new Map()
    activePreparedSources = []
    cleanup.push(releasePreparedStretchAssets(activePreparedStretchAssets))
    activePreparedStretchAssets = []
    playing = false
    return Promise.all(cleanup)
  }

  const releaseRuntime = async (runtime: PreparedRuntime | undefined) => {
    if (!runtime || runtime.released) return
    runtime.released = true
    const releases: Promise<unknown>[] = []
    for (const preparation of runtime.preparations) {
      if (!preparation.released) {
        const release = runtime.session.releaseAssetPreparation?.(preparation.id, runtime.epoch)
        if (release) {
          releases.push(release.then((result) => {
            if (result === "released") preparation.released = true
          }).catch(() => undefined))
        }
      }
    }
    await Promise.all(releases)
    await releasePreparedStretchAssets(runtime.preparedStretchAssets)
    runtime.unsubscribeFault()
    runtime.session.dispose()
  }

  const releaseExpiredPreparations = async (session: PortableSession, frame: number, generation: number) => {
    const expired = activePreparations.filter((preparation) => !preparation.released && preparation.stopFrame <= frame)
    if (!session.releaseAssetPreparation || expired.length === 0) return
    const results = await Promise.all(expired.map(async (preparation) => ({
      preparation,
      result: await session.releaseAssetPreparation?.(preparation.id, generation),
    })))
    const released = new Set(
      results.filter((entry) => entry.result === "released").map((entry) => entry.preparation.id),
    )
    for (const preparation of expired) {
      if (released.has(preparation.id)) preparation.released = true
    }
    activePreparations = activePreparations.filter((preparation) => !released.has(preparation.id))
  }

  const teardownSession = () => {
    unsubscribeFault?.()
    unsubscribeFault = undefined
    const session = active
    const cleanup = clearActiveSessionState()
    session?.dispose()
    return cleanup
  }

  const clearRecording = (session: PortableRecordingSession) => {
    if (recording === session) recording = undefined
    session.unsubscribeStatus()
    session.unsubscribeTrack()
    try { session.disconnectInput() } catch {}
    try { session.source.disconnect() } catch {}
  }

  const failRecording = (session: PortableRecordingSession, error: Error) => {
    if (session.terminal) return
    session.terminal = true
    try {
      active?.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-cancel" })
    } catch {}
    void session.writer.abort().catch(() => undefined)
    session.writer.terminate()
    if (session.phase === "configuring" && session.configurationPending) session.configured.reject(error)
    else if (session.phase === "finalizing") session.finalized.reject(error)
    else if (session.phase === "cancelling") session.cancelled.reject(error)
    if (session.phase !== "configuring") session.onFailure?.(error)
    clearRecording(session)
  }

  const dispose = () => {
    lifecycleGeneration += 1
    transportIntent += 1
    pendingStart = undefined
    pendingStartMode = undefined
    refreshPromise = undefined
    startupAbortController?.abort()
    startupAbortController = undefined
    const recordingSession = recording
    if (recordingSession) failRecording(recordingSession, new Error("Portable recording stopped with playback."))
    const sessionCleanup = teardownSession()
    if (!repositoryDisposed) {
      repositoryDisposed = true
      void sessionCleanup
        .catch(() => undefined)
        .then(() => stretchRepository.dispose?.())
        .catch(() => undefined)
    }
  }

  type PreparedRuntime = {
    session: PortableSession
    prepared: Extract<PreparedPortableSession, { supported: true }>
    projectGeneration: number
    epoch: number
    transport: LivePlaybackTransport
    requestedFrame: number
    unsubscribeFault: () => void
    sessionFault: PortableSessionFault
    preparedStretchAssets: readonly PortablePreparedStretch[]
    preparations: readonly PortablePagedPreparation[]
    ordinarySources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
    ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
    preparedSources: readonly PortablePreparedSource[]
    released: boolean
  }

  const prepareRuntime = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
    nextEpoch: number,
    sourceFirstSequence: number,
    compileContext?: LivePlaybackCompileContext,
  ): Promise<PreparedRuntime | undefined> => {
    const context = input.getAudioContext()
    if (!context) return undefined
    const preparationAbortController = new AbortController()
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
      || preparationAbortController.signal.aborted
    const requestedFrame = Math.round(transport.playheadSec * context.sampleRate)
    let session: PortableSession | undefined
    let unsubscribeSessionFault: (() => void) | undefined
    let preparedStretchAssets: readonly PortablePreparedStretch[] = []
    let runtimePreparations: readonly PortablePagedPreparation[] = []
    const sessionFault: PortableSessionFault = {}
    let transferredStretchOwnership = false
    startupAbortController = preparationAbortController
    try {
      const compilation = await input.compileSnapshot(transport, compileContext)
      if (cancelled()) return undefined
      if (!compilation.supported || compilation.snapshot.transport.loopEnabled) return undefined
      if (compilation.snapshot.tracks.some((track) => track.clips.some((clip) => (
        clip.audioWarp?.enabled === true && clip.audioWarp.mode === "stretch"
      )))) {
        const preparation = await preparePortablePagedStretchAssets({
          tracks: compilation.snapshot.tracks,
          projectBpm: compilation.snapshot.bpm,
          projectGeneration: safeProjectGeneration(projectGeneration),
          repository: stretchRepository,
          resolveSource: input.resolveSource,
          signal: preparationAbortController.signal,
        })
        if (!preparation.supported) {
          input.reportFault?.(preparation.message)
          return undefined
        }
        preparedStretchAssets = preparation.assets
      }
      if (cancelled()) return undefined
      const ordinaryDescriptors = await resolveOrdinaryDescriptors(
        compilation.snapshot,
        input.resolveSource,
        preparationAbortController.signal,
      )
      if (cancelled()) return undefined
      const prepared = preparedSession(
        compilation.snapshot,
        context.sampleRate,
        nextEpoch,
        safeProjectGeneration(projectGeneration),
        input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC,
        sourceFirstSequence,
        preparedStretchAssets,
        undefined,
        ordinaryDescriptors,
      )
      if (!prepared.supported) return undefined
      const selection = await select(prepared.qualification)
      if (cancelled()) return undefined
      if (!selection.selected) return undefined
      const playbackSession = await backend.createPlaybackSession(context, selection.capability, 8_192)
      session = playbackSession
      unsubscribeSessionFault = playbackSession.onFault((error: Error) => {
        if (active !== playbackSession) {
          sessionFault.error = error
          return
        }
        const recordingSession = recording
        if (recordingSession) failRecording(recordingSession, error)
        input.reportFault?.(error.message)
        unsubscribeFault = undefined
        clearActiveSessionState()
      })
      const hasPagedAssets = preparedStretchAssets.some(isPagedStretchAsset) || ordinaryDescriptors.size > 0
      const startupPrepared = hasPagedAssets
        ? fitPortableStartupHorizon({
          snapshot: compilation.snapshot,
          sampleRateHz: context.sampleRate,
          epoch: nextEpoch,
          projectGeneration: safeProjectGeneration(projectGeneration),
          requestedHorizonSec: input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC,
          sourceFirstSequence,
          preparedStretchAssets,
          ordinaryDescriptors,
          pageSlotCapacity: playbackSession.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
          preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
          signal: preparationAbortController.signal,
        })
        : prepared
      await playbackSession.prepareGraph(startupPrepared.graph)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      if (hasPagedAssets && (
        !playbackSession.registerPagedAsset
        || !playbackSession.writeAssetPage
        || !playbackSession.prepareAssetRange
        || !playbackSession.schedulePreparedSources
        || playbackSession.pagedCapabilities?.pageFrames !== portableWasmPagedPageFrames
        || playbackSession.pagedCapabilities?.maxChannels !== portableWasmPagedMaxChannels
      )) {
        throw new Error("Portable playback backend does not expose paged asset support.")
      }
      const registerPagedAsset = playbackSession.registerPagedAsset
      for (const asset of startupPrepared.graph.assets) {
        const source = compilation.snapshot.assets.find((candidate) => candidate.assetId === asset.assetId)
        const preparedSource = preparedStretchAssets.find((candidate) => candidate.asset.assetId === asset.assetId)
        const ordinaryDescriptor = ordinaryDescriptors.get(asset.assetId)
        if ((preparedSource && isPagedStretchAsset(preparedSource)) || ordinaryDescriptor) {
          if (preparedSource && isPagedStretchAsset(preparedSource)
            && preparedSource.manifest.pageFrames !== portableWasmPagedPageFrames) {
            throw new Error(`Portable Stretch artifact "${preparedSource.artifactId}" has an incompatible page size.`)
          }
          if (!registerPagedAsset) throw new Error("Portable playback backend does not expose paged asset support.")
          const registration = await registerPagedAsset(asset, nextEpoch)
          if (registration.status !== "registered") {
            throw new Error(`Portable paged audio asset "${asset.assetId}" was rejected (${registration.status}).`)
          }
          continue
        }
        const pcm = preparedSource?.pcm ?? (source?.buffer ? planarPcm(source.buffer) : undefined)
        if (!pcm) throw new Error(`Portable playback asset "${asset.assetId}" is not hydrated.`)
        const result = await playbackSession.registerAsset(asset, pcm, nextEpoch)
        if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
        if (result.status !== "registered") throw new Error(`Portable audio asset "${asset.assetId}" was rejected.`)
      }
      await playbackSession.publishGraph(startupPrepared.graph.revision)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.setTransport(nextEpoch, false, startupPrepared.schedule.timeOrigin.frame)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.installSchedule(startupPrepared.schedule)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      const paged = await preparePagedSources({
        session: playbackSession,
        sources: startupPrepared.sources,
        preparedStretchAssets,
        ordinaryDescriptors,
        repository: stretchRepository,
        generation: nextEpoch,
        preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
        signal: preparationAbortController.signal,
      })
      const preparedSourceEvents = paged.events
      const preparations = paged.preparations
      runtimePreparations = preparations
      const ordinarySources = startupPrepared.sources.filter((source) => (
        !preparedStretchAssets.some((candidate) => isPagedStretchAsset(candidate) && candidate.asset.assetId === source.assetId)
        && !ordinaryDescriptors.has(source.assetId)
      ))
      await replaceSourcesAtomically({
        session: playbackSession,
        revision: startupPrepared.graph.revision,
        epoch: nextEpoch,
        ordinary: ordinarySources,
        prepared: preparedSourceEvents,
      })
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      if (runTransport) {
        if (
          !Number.isSafeInteger(requestedFrame)
          || requestedFrame < startupPrepared.scheduleRange.startFrame
          || requestedFrame >= startupPrepared.scheduleRange.endFrame
        ) throw new Error("Portable browser playback requested transport is outside its prepared schedule.")
        await playbackSession.setTransport(nextEpoch, true, requestedFrame)
      }
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      if (sessionFault.error) throw sessionFault.error
      playbackSession.onTransportPosition?.((position) => {
        if (
          active !== playbackSession
          || position.epoch !== nextEpoch
          || position.sequence <= positionSequence
        ) return
        if (position.frame < positionFrame && position.running) return
        positionSequence = position.sequence
        positionFrame = position.frame
        void releaseExpiredPreparations(playbackSession, position.frame, nextEpoch).catch(() => undefined)
      })
      playbackSession.onGraphContinuity?.((message) => input.onGraphContinuity?.(message))
      if (runTransport) playbackSession.markActive()
      const runtime = {
        session: playbackSession,
        prepared: startupPrepared,
        projectGeneration,
        epoch: nextEpoch,
        transport: { ...transport },
        requestedFrame,
        unsubscribeFault: unsubscribeSessionFault,
        sessionFault,
        preparedStretchAssets,
        ordinaryDescriptors,
        preparations,
        ordinarySources,
        preparedSources: preparedSourceEvents.map((event) => ({
          ...event,
          preparation: preparations.find((preparation) => preparation.id === event.preparationId)
            ?? (() => { throw new Error(`Portable preparation ${event.preparationId} is missing.`) })(),
        })),
        released: false,
      }
      transferredStretchOwnership = true
      return runtime
    } catch (error) {
      unsubscribeSessionFault?.()
      await Promise.all(runtimePreparations.map(async (preparation) => {
        if (!preparation.released) {
          const result = await session?.releaseAssetPreparation?.(preparation.id, nextEpoch)
          if (result === "released") preparation.released = true
        }
      }))
      session?.dispose()
      if (!cancelled()) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not start.")
      }
      return undefined
    } finally {
      if (startupAbortController === preparationAbortController) {
        startupAbortController = undefined
      }
      if (!transferredStretchOwnership) await releasePreparedStretchAssets(preparedStretchAssets)
    }
  }

  const commitRuntime = (runtime: PreparedRuntime, runTransport: boolean) => {
    active = runtime.session
    activeProjectGeneration = runtime.projectGeneration
    activeTransport = runtime.transport
    activeScheduleRange = runtime.prepared.scheduleRange
    activeFrameSchedule = runtime.prepared.schedule
    activeRevision = runtime.prepared.graph.revision
    activeGraph = runtime.prepared.graph
    activeOrdinarySources = runtime.ordinarySources
    activeOrdinaryDescriptors = runtime.ordinaryDescriptors
    activePreparedSources = runtime.preparedSources
    activePreparedStretchAssets = runtime.preparedStretchAssets
    activePreparations = runtime.preparations
    playing = runTransport
    epoch = runtime.epoch
    positionFrame = runTransport ? runtime.requestedFrame : runtime.prepared.schedule.timeOrigin.frame
    positionSequence = 0
    unsubscribeFault = runtime.unsubscribeFault
    activeSourceSequence = runtime.prepared.sources.length === 0
      ? 0
      : runtime.prepared.sources[runtime.prepared.sources.length - 1]?.sequence ?? 0
    failedRefreshEndFrame = undefined
  }

  const startAttempt = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
    compileContext?: LivePlaybackCompileContext,
  ): Promise<PortableStartResult> => {
    const context = input.getAudioContext()
    if (!context) return "unavailable"
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
    const requestedFrame = Math.round(transport.playheadSec * context.sampleRate)
    const horizonSec = input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC
    const requestedScheduleEndFrame = requestedFrame
      + Math.round(horizonSec * context.sampleRate)
    // Portable schedules currently have no loop-reset semantics, so an
    // enabled loop must never promote an existing schedule.
    const compatibleWithActiveSchedule = activeTransport !== undefined
      && activeScheduleRange !== undefined
      && !activeTransport.loopEnabled
      && !transport.loopEnabled
      && Number.isSafeInteger(requestedFrame)
      && requestedFrame >= activeScheduleRange.startFrame
      && Number.isSafeInteger(requestedScheduleEndFrame)
      && requestedScheduleEndFrame <= activeScheduleRange.endFrame
    if (active && activeProjectGeneration === projectGeneration && compatibleWithActiveSchedule) {
      try {
        await active.setTransport(epoch, runTransport, requestedFrame)
        positionFrame = requestedFrame
        if (cancelled()) {
          void teardownSession()
          return "unavailable"
        }
        if (runTransport) active.markActive()
        playing = runTransport
        return "started"
      } catch (error) {
        if (!cancelled()) {
          input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not resume.")
        }
        void teardownSession()
        return "unavailable"
      }
    }
    if (active) {
      void teardownSession()
    }
    const nextEpoch = epoch + 1
    const runtime = await prepareRuntime(
      transport,
      generation,
      projectGeneration,
      runTransport,
      nextEpoch,
      1,
      compileContext,
    )
    if (!runtime || cancelled()) {
      if (runtime) await releaseRuntime(runtime)
      return "unavailable"
    }
    commitRuntime(runtime, runTransport)
    return "started"
  }

  const refreshSchedule = (): Promise<PortableStartResult> => {
    if (!playing || !active || refreshPromise) return refreshPromise ?? Promise.resolve<PortableStartResult>("started")
    const context = input.getAudioContext()
    if (!context || activeTransport?.loopEnabled) return Promise.resolve("started")
    const horizonSec = input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC
    const leadSec = Math.min(5, Math.max(0.05, horizonSec * 0.25))
    const currentFrame = positionFrame
    const endFrame = activeScheduleRange?.endFrame
    if (failedRefreshEndFrame !== undefined && currentFrame >= failedRefreshEndFrame) {
      const session = active
      playing = false
      failedRefreshEndFrame = undefined
      activeTransport = activeTransport ? { ...activeTransport, state: "paused" } : undefined
      void session?.setTransport(epoch, false, currentFrame).catch(() => undefined)
      input.reportFault?.("Portable playback reached the end of its active schedule after refresh failed.")
      return Promise.resolve("unavailable")
    }
    if (endFrame === undefined || endFrame - currentFrame > Math.round(leadSec * context.sampleRate)) {
      return Promise.resolve("started")
    }
    const previousSession = active
    const previousUnsubscribeFault = unsubscribeFault
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const intent = transportIntent
    const transport: LivePlaybackTransport = {
      ...(activeTransport ?? {
        state: "playing",
        playheadSec: currentFrame / context.sampleRate,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
      state: "playing",
      playheadSec: currentFrame / context.sampleRate,
    }
    const refreshAbortController = new AbortController()
    startupAbortController = refreshAbortController
    const request: Promise<PortableStartResult> = (async (): Promise<PortableStartResult> => {
      if (recording) {
        const nextEpoch = epoch
        await releaseExpiredPreparations(previousSession, currentFrame, nextEpoch)
        activeOrdinarySources = activeOrdinarySources.filter((source) => source.stopFrame > currentFrame)
        activePreparedSources = activePreparedSources.filter((source) => !source.preparation.released)
        const baselineOrdinarySources = activeOrdinarySources
        const baselinePreparedSources = activePreparedSources
        const baselineSchedule = activeFrameSchedule
        const baselineScheduleRange = activeScheduleRange
        const baselinePreparations = activePreparations
        const baselineEndFrame = activeScheduleRange?.endFrame ?? currentFrame
        const compilation = await input.compileSnapshot(transport)
        if (
          generation !== lifecycleGeneration
          || intent !== transportIntent
          || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
          || active !== previousSession
          || !playing
          || !compilation.supported
          || compilation.snapshot.transport.loopEnabled
          || compilation.snapshot.revision !== activeRevision
        ) return "unavailable"
        const extensionStartFrame = baselineEndFrame
        const pageSec = portableWasmPagedPageFrames / context.sampleRate
        const requestedExtensionSec = horizonSec + (extensionStartFrame - currentFrame) / context.sampleRate
        const restoreBaseline = async () => {
          if (!baselineSchedule) throw new Error("Portable scheduler cannot roll back a failed refresh.")
          await replaceSourcesAtomically({
            session: previousSession,
            revision: baselineSchedule.revision,
            epoch: nextEpoch,
            ordinary: baselineOrdinarySources,
            prepared: baselinePreparedSources,
          })
          await previousSession.installSchedule(baselineSchedule)
        }
        let prepared: Extract<PreparedPortableSession, { supported: true }> | undefined
        let paged: Awaited<ReturnType<typeof preparePagedSources>> | undefined
        let extensionSources: Extract<PreparedPortableSession, { supported: true }>["sources"] = []
        let candidateHorizonSec = requestedExtensionSec
        try {
          while (candidateHorizonSec >= pageSec) {
            const candidate = preparedSession(
              compilation.snapshot,
              context.sampleRate,
              nextEpoch,
              safeProjectGeneration(projectGeneration),
              candidateHorizonSec,
              activeSourceSequence + 1,
              activePreparedStretchAssets,
              extensionStartFrame / context.sampleRate,
              activeOrdinaryDescriptors,
            )
            if (!candidate.supported
              || candidate.graph.revision !== activeRevision
              || candidate.graph.assets.some((asset) => !activeGraph?.assets.some((current) => current.assetId === asset.assetId))) {
              return "unavailable"
            }
            const candidateSources = candidate.sources.filter((source) => source.startFrame >= extensionStartFrame)
            try {
              const candidatePaged = await preparePagedSources({
                session: previousSession,
                sources: candidateSources,
                preparedStretchAssets: activePreparedStretchAssets,
                ordinaryDescriptors: activeOrdinaryDescriptors,
                repository: stretchRepository,
                generation: nextEpoch,
                preparationCapacity: previousSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
                baselinePreparationCount: baselinePreparations.length,
                signal: refreshAbortController.signal,
                pinnedPageKeys: new Set(baselinePreparations.flatMap((preparation) => preparation.pageKeys)),
              })
              prepared = candidate
              paged = candidatePaged
              extensionSources = candidateSources
              break
            } catch (error) {
              if (!(error instanceof Error) || !error.message.includes("requires ")) throw error
              candidateHorizonSec -= pageSec
            }
          }
          if (!prepared || !paged) throw new Error("Portable schedule refresh could not fit the pinned page horizon.")
          const ordinarySources = extensionSources.filter((source) => (
            !activePreparedStretchAssets.some((candidate) => isPagedStretchAsset(candidate) && candidate.asset.assetId === source.assetId)
            && !activeOrdinaryDescriptors.has(source.assetId)
          ))
          await replaceSourcesAtomically({
            session: previousSession,
            revision: prepared.graph.revision,
            epoch: nextEpoch,
            ordinary: [...baselineOrdinarySources, ...ordinarySources],
            prepared: [...baselinePreparedSources.map((source) => ({
              ...source,
              preparationId: source.preparation.id,
            })), ...paged.events],
          })
          await previousSession.installSchedule(prepared.schedule)
          if (
            generation !== lifecycleGeneration
            || intent !== transportIntent
            || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
            || active !== previousSession
            || !playing
          ) throw new Error("Portable schedule refresh was cancelled.")
          activeScheduleRange = prepared.scheduleRange
          activeFrameSchedule = prepared.schedule
          activePreparations = [...baselinePreparations, ...paged.preparations]
          activeOrdinarySources = [...baselineOrdinarySources, ...ordinarySources]
          activePreparedSources = [
            ...baselinePreparedSources,
            ...paged.events.map((event) => ({
              ...event,
              preparation: paged?.preparations.find((preparation) => preparation.id === event.preparationId)
                ?? (() => { throw new Error(`Portable preparation ${event.preparationId} is missing.`) })(),
            })),
          ]
          activeSourceSequence = extensionSources.length === 0
            ? activeSourceSequence
            : extensionSources[extensionSources.length - 1]?.sequence ?? activeSourceSequence
          activeTransport = { ...transport }
          return "started"
        } catch (error) {
          try {
            await restoreBaseline()
            activePreparations = baselinePreparations
            activeOrdinarySources = baselineOrdinarySources
            activePreparedSources = baselinePreparedSources
            activeScheduleRange = baselineScheduleRange
            activeFrameSchedule = baselineSchedule
          } catch (rollbackError) {
            void teardownSession()
            input.reportFault?.(rollbackError instanceof Error ? rollbackError.message : "Portable schedule refresh rollback failed.")
            return "unavailable"
          }
          if (paged) {
            await Promise.all(paged.preparations.map(async (preparation) => {
              if (!preparation.released) {
                const result = await previousSession.releaseAssetPreparation?.(preparation.id, nextEpoch)
                if (result === "released") preparation.released = true
              }
            }))
          }
          failedRefreshEndFrame = activeScheduleRange?.endFrame
          input.reportFault?.(error instanceof Error ? error.message : "Portable schedule refresh failed.")
          return "unavailable"
        }
      }

      const stillCurrent = () => generation === lifecycleGeneration
        && intent === transportIntent
        && projectGeneration === (input.getProjectGeneration?.() ?? 0)
      const preservesActiveGraph = (runtime: PreparedRuntime | undefined) => runtime !== undefined
        && runtime.prepared.graph.revision === activeRevision
        && runtime.prepared.graph.assets.length === (activeGraph?.assets.length ?? 0)
        && runtime.prepared.graph.assets.every((asset) => (
          activeGraph?.assets.some((current) => current.assetId === asset.assetId)
        ))
      const hasPagedSources = (runtime: PreparedRuntime) => (
        runtime.ordinaryDescriptors.size > 0
        || runtime.preparedStretchAssets.some(isPagedStretchAsset)
      )
      const hasContinuationCoverage = (runtime: PreparedRuntime, frame: number) => {
        const requiredEndFrame = frame + (
          hasPagedSources(runtime)
            ? portableWasmPagedPageFrames
            : Math.round(horizonSec * context.sampleRate)
        )
        return Number.isSafeInteger(frame)
          && frame >= runtime.prepared.scheduleRange.startFrame
          && frame < runtime.prepared.scheduleRange.endFrame
          && Number.isSafeInteger(requiredEndFrame)
          && requiredEndFrame <= runtime.prepared.scheduleRange.endFrame
      }
      const replacementTransport = (frame: number): LivePlaybackTransport => ({
        ...transport,
        playheadSec: frame / context.sampleRate,
      })

      let runtime = await prepareRuntime(
        transport,
        generation,
        projectGeneration,
        false,
        epoch + 1,
        1,
      )
      let latestFrame = positionFrame
      let valid = runtime !== undefined
        && preservesActiveGraph(runtime)
        && runtime.sessionFault.error === undefined
        && stillCurrent()
        && active === previousSession
        && playing
      if (valid && runtime && !hasContinuationCoverage(runtime, latestFrame)) {
        await releaseRuntime(runtime)
        runtime = await prepareRuntime(
          replacementTransport(positionFrame),
          generation,
          projectGeneration,
          false,
          epoch + 1,
          1,
        )
        latestFrame = positionFrame
        valid = runtime !== undefined
          && preservesActiveGraph(runtime)
          && runtime.sessionFault.error === undefined
          && stillCurrent()
          && active === previousSession
          && playing
          && runtime !== undefined
          && hasContinuationCoverage(runtime, latestFrame)
      }
      if (!valid || !runtime) {
        if (runtime && !preservesActiveGraph(runtime)) {
          input.reportFault?.("Portable schedule refresh changed the active graph.")
        }
        if (runtime?.sessionFault.error) {
          input.reportFault?.(runtime.sessionFault.error.message)
        }
        if (
          (!runtime
            || !preservesActiveGraph(runtime)
            || runtime.sessionFault.error !== undefined
            || !hasContinuationCoverage(runtime, latestFrame))
          && stillCurrent()
          && active === previousSession
          && playing
        ) failedRefreshEndFrame = activeScheduleRange?.endFrame
        await releaseRuntime(runtime)
        return "unavailable"
      }

      // The old session remains audible during preparation. Once all checks
      // pass, make the handoff a hard boundary before starting the prepared
      // replacement so two sessions can never run at once.
      latestFrame = positionFrame
      if (!hasContinuationCoverage(runtime, latestFrame) || runtime.sessionFault.error !== undefined || !stillCurrent()
        || active !== previousSession || !playing) {
        await releaseRuntime(runtime)
        if (stillCurrent() && active === previousSession && playing) {
          failedRefreshEndFrame = activeScheduleRange?.endFrame
        }
        return "unavailable"
      }
      previousUnsubscribeFault?.()
      unsubscribeFault = undefined
      clearActiveSessionState()
      try {
        previousSession.dispose()
      } catch (error) {
        await releaseRuntime(runtime)
        if (stillCurrent()) {
          input.reportFault?.(error instanceof Error ? error.message : "Portable schedule refresh could not dispose the old session.")
        }
        return "unavailable"
      }
      try {
        await runtime.session.setTransport(runtime.epoch, true, latestFrame)
        if (!stillCurrent() || runtime.sessionFault.error) {
          throw runtime.sessionFault.error ?? new Error("Portable schedule refresh was cancelled.")
        }
        runtime.session.markActive()
        if (!stillCurrent() || runtime.sessionFault.error) {
          throw runtime.sessionFault.error ?? new Error("Portable schedule refresh was cancelled.")
        }
        commitRuntime(runtime, true)
        positionFrame = latestFrame
        activeTransport = {
          ...runtime.transport,
          state: "playing",
          playheadSec: latestFrame / context.sampleRate,
        }
        return "started"
      } catch (error) {
        await releaseRuntime(runtime)
        if (stillCurrent()) {
          input.reportFault?.(
            error instanceof Error && error.message !== "Portable schedule refresh was cancelled."
              ? error.message
              : "Portable schedule refresh could not start the replacement.",
          )
        }
        return "unavailable"
      }
    })().catch((cause: unknown): PortableStartResult => {
      failedRefreshEndFrame = activeScheduleRange?.endFrame
      input.reportFault?.(cause instanceof Error ? cause.message : "Portable schedule refresh failed.")
      return "unavailable"
    }).finally(() => {
      if (startupAbortController === refreshAbortController) {
        startupAbortController = undefined
      }
    })
    refreshPromise = request
    void request.finally(() => {
      if (refreshPromise === request) refreshPromise = undefined
    })
    return request
  }

  const start = (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (playing) return Promise.resolve("started")
    if (pendingStart) {
      if (pendingStartMode === "play") return pendingStart
      const previewRequest = pendingStart
      const generation = lifecycleGeneration
      const projectGeneration = input.getProjectGeneration?.() ?? 0
      const request = previewRequest.then((result) => result === "started"
        ? startAttempt(transport, generation, projectGeneration, true, compileContext)
        : result)
      pendingStart = request
      pendingStartMode = "play"
      void request.finally(() => {
        if (pendingStart === request) {
          pendingStart = undefined
          pendingStartMode = undefined
        }
      })
      return request
    }
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt(transport, generation, projectGeneration, true, compileContext)
    pendingStart = request
    pendingStartMode = "play"
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
      }
    })
    return request
  }

  const ensurePrepared = (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (pendingStart) return pendingStart
    if (active && !playing && activeProjectGeneration === (input.getProjectGeneration?.() ?? 0)) {
      return Promise.resolve("started")
    }
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt(transport, generation, projectGeneration, false, compileContext)
    pendingStart = request
    pendingStartMode = "preview"
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
      }
    })
    return request
  }

  const rebuildPrepared = async (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (!active) return "unavailable"
    lifecycleGeneration += 1
    transportIntent += 1
    pendingStart = undefined
    pendingStartMode = undefined
    refreshPromise = undefined
    startupAbortController?.abort()
    startupAbortController = undefined
    await teardownSession()
    return ensurePrepared(transport, compileContext)
  }

  const pause = async (playheadSec: number) => {
    transportIntent += 1
    startupAbortController?.abort()
    startupAbortController = undefined
    const session = active
    if (!session || !playing) return
    if (recording) throw new Error("Portable recording must stop before playback can pause.")
    const context = input.getAudioContext()
    if (!context) throw new Error("Portable audio context is unavailable.")
    try {
      await session.setTransport(epoch, false, Math.round(playheadSec * context.sampleRate))
      positionFrame = Math.round(playheadSec * context.sampleRate)
      if (active === session) playing = false
    } catch (error) {
      if (active === session) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not pause.")
        await teardownSession()
      }
      throw error
    }
  }

  const ensureRecordingRefreshCapacity = async (playbackSession: PortableSession) => {
    if (activePreparations.length === 0) return
    const context = input.getAudioContext()
    const baselineSchedule = activeFrameSchedule
    const baselineScheduleRange = activeScheduleRange
    if (!context || !baselineSchedule || !baselineScheduleRange || activeRevision === undefined || !activeGraph) {
      throw new Error("Portable recording requires an active schedule.")
    }
    await releaseExpiredPreparations(playbackSession, positionFrame, epoch)
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const transport: LivePlaybackTransport = {
      ...(activeTransport ?? {
        state: "playing",
        playheadSec: positionFrame / context.sampleRate,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
      state: "playing",
      playheadSec: positionFrame / context.sampleRate,
    }
    const compilation = await input.compileSnapshot(transport)
    if (
      !compilation.supported
      || compilation.snapshot.transport.loopEnabled
      || compilation.snapshot.revision !== activeRevision
    ) {
      throw new Error("Portable recording is unavailable because playback requires a schedule rebuild.")
    }
    const pageFrames = portableWasmPagedPageFrames
    const extensionStartFrame = baselineScheduleRange.endFrame
    const minimum = preparedSession(
      compilation.snapshot,
      context.sampleRate,
      epoch,
      safeProjectGeneration(projectGeneration),
      (extensionStartFrame - positionFrame + pageFrames) / context.sampleRate,
      activeSourceSequence + 1,
      activePreparedStretchAssets,
      extensionStartFrame / context.sampleRate,
      activeOrdinaryDescriptors,
    )
    if (!minimum.supported) {
      throw new Error("Portable recording is unavailable because its minimum continuation horizon is unsupported.")
    }
    const continuationSources = minimum.sources.filter((source) => source.startFrame >= extensionStartFrame)
    const plan = requiredPagedPagePlan(
      continuationSources,
      activePreparedStretchAssets,
      activeOrdinaryDescriptors,
    )
    if (!plan) throw new Error("Portable recording is unavailable because a continuation source range is invalid.")
    const capacityError = pagedCapacityError({
      pageCount: new Set([
        ...activePreparations.flatMap((preparation) => preparation.pageKeys),
        ...plan.pageKeys,
      ]).size,
      pageCapacity: playbackSession.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
      preparationCount: plan.preparationCount,
      preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
      baselinePreparationCount: activePreparations.length,
    })
    if (capacityError) {
      throw new Error(`Portable recording is unavailable: ${capacityError.message}`)
    }
  }

  const startRecording = async (recordingInput: {
    appSessionId: string
    stream: MediaStream
    layout: "mono" | "stereo"
    inputChannel: number
    gain: number
    polarity: 1 | -1
    monitoring: boolean
    punchStartFrame: number
    punchEndFrame?: number
    onDiagnostics?: (diagnostics: PortableRecordingDiagnostics) => void
    onFailure?: (error: Error) => void
  }) => {
    const playbackSession = active
    const context = input.getAudioContext()
    if (!playbackSession || !playing || !context || recording) throw new Error("Portable playback is not active for recording.")
    const track = recordingInput.stream.getAudioTracks()[0]
    if (!track || track.readyState === "ended") throw new Error("Portable recording input is unavailable.")
    const channelCount = recordingInput.layout === "stereo" ? 2 : 1
    const inputChannels = channelCount === 2
      ? [recordingInput.inputChannel, recordingInput.inputChannel + 1]
      : [recordingInput.inputChannel]
    const availableChannels = Math.min(track.getSettings().channelCount ?? 1, 2)
    if (inputChannels.some((channel) => channel < 0 || channel >= availableChannels)) {
      throw new Error("Selected portable recording input channels are unavailable.")
    }
    await ensureRecordingRefreshCapacity(playbackSession)
    const numericSessionId = nextRecordingSessionId
    nextRecordingSessionId += 1
    let latestDiagnostics: PortableRecordingDiagnostics | undefined
    let writerQueuedFrames = 0
    let coreDrainPending = false
    let requestNextDrain = () => {}
    const writer = (input.createRecordingWriter ?? createPortableRecordingWriter)({
      generation: epoch,
      sessionId: recordingInput.appSessionId,
      sampleRate: context.sampleRate,
      channelCount,
      onQueuedFrames: (queuedFrames) => {
        writerQueuedFrames = queuedFrames
        recordingInput.onDiagnostics?.({
          version: portableWasmProtocolVersion,
          type: "recording-capture-diagnostics",
          generation: epoch,
          sessionId: numericSessionId,
          capturedFrames: latestDiagnostics?.capturedFrames ?? 0,
          droppedFrames: latestDiagnostics?.droppedFrames ?? 0,
          droppedBlocks: latestDiagnostics?.droppedBlocks ?? 0,
          availableBlocks: latestDiagnostics?.availableBlocks ?? 0,
          queuedBlocks: Math.ceil(queuedFrames / RECORDER_BLOCK_FRAMES),
          rms: latestDiagnostics?.rms ?? 0,
          peak: latestDiagnostics?.peak ?? 0,
          fatal: false,
          active: true,
        })
        requestNextDrain()
      },
    })
    const source = context.createMediaStreamSource(recordingInput.stream)
    const configured = deferred<number>()
    const finalized = deferred<void>()
    const cancelled = deferred<void>()
    const session: PortableRecordingSession = {
      numericSessionId,
      source,
      disconnectInput: () => undefined,
      unsubscribeStatus: () => undefined,
      unsubscribeTrack: () => undefined,
      writer,
      configured,
      finalized,
      cancelled,
      onFailure: recordingInput.onFailure,
      phase: "configuring",
      configurationPending: false,
      terminal: false,
    }
    requestNextDrain = () => {
      if (recording === session && session.phase !== "cancelling" && coreDrainPending
        && writerQueuedFrames < RECORDER_BLOCK_FRAMES * RECORDER_MAX_QUEUED_BLOCKS) {
        coreDrainPending = false
        playbackSession.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-drain" })
      }
    }
    session.unsubscribeStatus = playbackSession.onRecordingStatus((message) => {
      if (!("generation" in message) || !("sessionId" in message)
        || message.generation !== epoch || message.sessionId !== numericSessionId) return
      if (message.type === "recording-capture-available") {
        coreDrainPending = true
        requestNextDrain()
        return
      }
      if (message.type === "recording-capture-block") {
        try {
          writer.write(message)
        } catch (error) {
          failRecording(session, error instanceof Error ? error : new Error("Portable recording writer failed."))
        }
        return
      }
      if (message.type === "recording-capture-diagnostics") {
        latestDiagnostics = message
        coreDrainPending = message.queuedBlocks > 0
        session.diagnostics = message
        recordingInput.onDiagnostics?.(message)
        if (message.fatal) failRecording(session, new Error("Portable recording capture overflowed."))
        else requestNextDrain()
        return
      }
      if (message.type !== "recording-capture-applied") return
      if (message.action === "configured") configured.resolve(message.frame)
      else if (message.action === "finalized") finalized.resolve()
      else cancelled.resolve()
    })
    const onEnded = () => failRecording(session, new Error("Portable recording device ended."))
    track.addEventListener("ended", onEnded, { once: true })
    session.unsubscribeTrack = () => track.removeEventListener("ended", onEnded)
    recording = session
    try {
      await writer.ready
      session.disconnectInput = playbackSession.connectInput(source)
      session.configurationPending = true
      playbackSession.postRecordingControl({
        version: portableWasmProtocolVersion,
        type: "recording-capture-configure",
        generation: epoch,
        sessionId: numericSessionId,
        channelCount,
        inputChannels,
        gain: recordingInput.gain,
        polarity: recordingInput.polarity,
        monitoring: recordingInput.monitoring,
        punchStartFrame: recordingInput.punchStartFrame,
        punchEndFrame: recordingInput.punchEndFrame ?? null,
      })
      const startFrame = await boundedControl(configured.promise, "Portable recording configuration timed out.")
      session.configurationPending = false
      session.phase = "recording"
      return { sampleRate: context.sampleRate, channelCount, startFrame }
    } catch (error) {
      session.configurationPending = false
      failRecording(session, error instanceof Error ? error : new Error("Portable recording could not start."))
      throw error
    }
  }

  const stopRecording = async () => {
    const session = recording
    const playbackSession = active
    if (!session || !playbackSession || session.terminal) throw new Error("Portable recording is not active.")
    session.terminal = true
    session.phase = "finalizing"
    playbackSession.postRecordingControl({
      version: portableWasmProtocolVersion,
      type: "recording-capture-finalize",
      stopFrame: null,
    })
    try {
      await boundedControl(session.finalized.promise, "Portable recording finalization timed out.")
      const capturedFrames = session.diagnostics?.capturedFrames ?? 0
      const result = await session.writer.finalize(capturedFrames)
      clearRecording(session)
      return result
    } catch (error) {
      session.terminal = false
      failRecording(session, error instanceof Error ? error : new Error("Portable recording finalization failed."))
      throw error
    }
  }

  const cancelRecording = async () => {
    const session = recording
    const playbackSession = active
    if (!session || !playbackSession || session.terminal) return
    session.terminal = true
    session.phase = "cancelling"
    playbackSession.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-cancel" })
    try {
      await boundedControl(session.cancelled.promise, "Portable recording cancellation timed out.")
    } finally {
      void session.writer.abort().catch(() => undefined)
      session.writer.terminate()
      clearRecording(session)
    }
  }

  const queueLiveProcessorControl = async (
    request: LiveProcessorControlRequest,
  ): Promise<LiveProcessorControlResult> => {
    if (!active || !active.queueProcessorEvents || activeRevision === undefined || activeGraph === undefined) {
      return { accepted: false, reason: "unprepared" }
    }
    if (request.revision !== undefined && request.revision !== activeRevision
      || request.epoch !== undefined && request.epoch !== epoch) {
      return { accepted: false, reason: "stale" }
    }
    const processor = resolveGraphProcessor(activeGraph, request.instanceId)
    if (!processor) return { accepted: false, reason: "unsupported" }
    const events = request.values.map((value) => {
      const target = processor.parameterTargets.get(value.parameterId)
      return target === undefined || !Number.isFinite(value.value)
        ? undefined
        : {
            processorInstanceId: processor.processor.instanceId,
            parameterTarget: target,
            frameOffset: 0,
            value: value.value,
          }
    })
    if (events.some((event) => event === undefined)) return { accepted: false, reason: "unsupported" }
    const sequence = Math.max(nextLiveProcessorSequence + 1, request.sequence ?? 0)
    nextLiveProcessorSequence = sequence
    try {
      await active.queueProcessorEvents(
        activeRevision,
        epoch,
        sequence,
        events.flatMap((event) => event === undefined ? [] : [event]),
      )
      return { accepted: true, sequence, appliedSequence: sequence }
    } catch (error) {
      return { accepted: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) }
    }
  }

  const liveProcessorControl: LiveProcessorControl = {
    preview: queueLiveProcessorControl,
    flush: queueLiveProcessorControl,
    reenableAutomation: async (instanceId, parameterIds, revision, transportEpoch) => {
      if (revision !== activeRevision || transportEpoch !== epoch) return { accepted: false, reason: "stale" }
      if (!active || !active.reenableProcessorAutomation) return { accepted: false, reason: "unsupported" }
      const processor = activeGraph === undefined ? undefined : resolveGraphProcessor(activeGraph, instanceId)
      if (!processor || parameterIds.some((parameterId) => !processor.parameterTargets.has(parameterId))) {
        return { accepted: false, reason: "unsupported" }
      }
      const targets = parameterIds.map((parameterId) => processor.parameterTargets.get(parameterId))
        .filter((target): target is number => target !== undefined)
      const sequence = ++nextLiveProcessorSequence
      try {
        await active.reenableProcessorAutomation(revision, transportEpoch, processor.processor.instanceId, targets)
        return { accepted: true, sequence, appliedSequence: sequence }
      } catch (error) {
        return { accepted: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
  const reenableProcessorAutomation = async (
    instanceId: string,
    parameterIds: readonly string[],
  ): Promise<LiveProcessorControlResult> => {
    if (activeRevision === undefined || activeGraph === undefined) {
      return { accepted: false, reason: "unprepared" }
    }
    return liveProcessorControl.reenableAutomation(instanceId, parameterIds, activeRevision, epoch)
  }

  return {
    start,
    pause,
    dispose,
    startRecording,
    stopRecording,
    cancelRecording,
    isActive: () => playing,
    isPrepared: () => active !== undefined,
    isPreparing: () => pendingStart !== undefined,
    liveProcessorControl,
    reenableProcessorAutomation,
    isRecording: () => recording !== undefined,
    ensurePrepared,
    rebuildPrepared,
    refreshSchedule,
    currentPositionSec: () => {
      const context = input.getAudioContext()
      return context ? positionFrame / context.sampleRate : undefined
    },
  }
}
