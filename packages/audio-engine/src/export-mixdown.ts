import type { AutomationEnvelope, AudioPcmSourceDescriptor } from '@daw-browser/shared'
import type { ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import type { ResolvedMixerGraph } from './mixer/types'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { getExportRangeBounds, type ExportRange } from './export-range'
import { convertStereoToMonoSample } from './mixer/channel-layout'
import { scanTruePeakAsync } from './true-peak-scanner'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
import { resolveExportMixerGraph } from './export-mixer-graph'
import type { ExportFx } from './export-types'
import type { PlanarPcm } from '../../audio-core-contract/src/index'
import { loadAudioCoreWasmArtifact, type AudioCoreWasmArtifact, type AudioCoreWasmArtifactResult } from '../../audio-core-wasm/src/index'
import { compilePortableExportSnapshot, type PortableExportSnapshot } from './portable-export-snapshot'
import { PortableExportWorker } from './portable-export-worker'
import { portableExportWorkerMaxAssets, portableExportWorkerMaxEvents, portableExportWorkerMaxGraphEdges, portableExportWorkerMaxGraphNodes } from './portable-export-worker-protocol'
import { resolvePortableWasmManifestUrl } from './worklet-manifest'
import { preparePortablePagedStretchAssets } from './portable-stretch-paging'
import { createAudioPcmSourceDescriptor, getAudioBufferSessionIdentity } from './media-pages'
import type { PreparedStretchArtifactRepository } from './prepared-stretch-store'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'

export { encodeAudioBuffer, encodeAudioChunks, type EncodeAudioBufferOptions, type EncodeAudioBufferTarget } from './export-encoding'

export type { AudioEffectRuntimeInstance }

export type { ExportRange } from './export-range'

export type { ExportFx } from './export-types'

export { resolveExportMixerGraph } from './export-mixer-graph'

export type ExportRequest = {
  tracks: Track<AudioBuffer>[]
  bpm: number
  range: ExportRange
  sourceEndSec?: number
  sampleRate?: number
  numberOfChannels?: number
  signal?: AbortSignal
  fx?: ExportFx
  automationEnvelopes?: AutomationEnvelope[]
  sidechainRoutes?: ExternalSidechainRoute[]
  cueTrackIds?: readonly string[]
  resourceObserver?: ResourceObserver
  onRenderProgress?: (completedFrames: number, totalFrames: number) => void
  resolveAudioSource?: (clip: AudioStretchRuntimeClip, signal?: AbortSignal) => Promise<AudioPcmSourceDescriptor>
  preparedStretchRepository?: PreparedStretchArtifactRepository
  projectGeneration?: number
  mixerGraph?: ResolvedMixerGraph
  trackIds?: ReadonlySet<string>
}


type PortableMixdownSelection =
  | {
    selected: true
    artifact: AudioCoreWasmArtifact
    snapshot: Extract<PortableExportSnapshot, { supported: true }>
    readPage: (input: { assetId: string; startFrame: number; frameCount: number; signal?: AbortSignal }) => Promise<readonly Float32Array[]>
    cleanup: () => Promise<void>
  }
  | { selected: false }

type PreparedExportRange = {
  startSec: number
  endSec: number
  sourceEndSec: number
  durationSec: number
}

type PreparedExportRender = {
  bpm: number
  range: PreparedExportRange
  sampleRate: number
  numberOfChannels: number
  mixerGraph: ResolvedMixerGraph
  automationEnvelopes: AutomationEnvelope[]
  sidechainRoutes: ExternalSidechainRoute[]
  resourceObserver?: ResourceObserver
}

export function resolveExportLimiterCeilingDbtp(
  graph: ResolvedMixerGraph,
): number | undefined {
  const ceilings: number[] = []

  for (const instance of graph.master.instances) {
    if (instance.kind === 'limiter' && instance.params.state.enabled) {
      ceilings.push(instance.params.state.ceilingDbtp)
    }
  }

  return ceilings.length === 0 ? undefined : Math.min(...ceilings)
}

export async function assertExportTruePeakWithinLimiterCeiling(
  buffer: {
    numberOfChannels: number
    length: number
    getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
  },
  ceilingDbtp: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (ceilingDbtp === undefined) return
  const measured = await scanTruePeakAsync(buffer, signal)

  if (measured.peakDbtp > ceilingDbtp + 0.1) {
    throw new Error(
      `Export true peak ${measured.peakDbtp.toFixed(2)} dBTP exceeds the reachable limiter ceiling ${ceilingDbtp.toFixed(2)} dBTP (+0.10 dB tolerance).`,
    )
  }
}


type AudioSampleBuffer = Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData'>

type StereoSampleBuffer = Pick<AudioBuffer, 'numberOfChannels' | 'length' | 'sampleRate' | 'getChannelData'>

export const getAudioBufferPeak = (buffer: AudioSampleBuffer): number => {
  let peak = 0

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)

    for (let index = 0; index < data.length; index += 1) {
      const sample = Math.abs(data[index])

      if (Number.isFinite(sample)) peak = Math.max(peak, sample)
    }
  }

  return peak
}

export const normalizeAudioBufferInPlace = (buffer: AudioSampleBuffer): number => {
  const peak = getAudioBufferPeak(buffer)

  if (peak === 0 || peak === 1) return 1
  const gain = 1 / peak

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)

    for (let index = 0; index < data.length; index += 1) {
      data[index] *= gain
    }
  }

  return gain
}

export const downmixStereoBufferToMono = <Buffer extends StereoSampleBuffer>(
  buffer: StereoSampleBuffer,
  createBuffer: (channels: number, length: number, sampleRate: number) => Buffer,
): Buffer => {
  if (buffer.numberOfChannels === 1) {
    const mono = createBuffer(1, buffer.length, buffer.sampleRate)
    mono.getChannelData(0).set(buffer.getChannelData(0))

    return mono
  }

  const mono = createBuffer(1, buffer.length, buffer.sampleRate)
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  const output = mono.getChannelData(0)

  for (let index = 0; index < output.length; index += 1) {
    output[index] = convertStereoToMonoSample(left[index], right[index])
  }

  return mono
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted()
}

const portableSnapshotRange = (range: PreparedExportRange): ExportRange => ({
  mode: 'custom',
  startSec: range.startSec,
  endSec: range.sourceEndSec,
})

function prepareExportRender(req: ExportRequest): PreparedExportRender {
  throwIfAborted(req.signal)
  const { startSec, endSec } = getExportRangeBounds(req.tracks, req.range)

  return {
    bpm: req.bpm,
    range: {
      startSec,
      endSec,
      sourceEndSec: Math.min(endSec, req.sourceEndSec ?? endSec),
      durationSec: endSec - startSec,
    },
    sampleRate: req.sampleRate ?? 44100,
    numberOfChannels: req.numberOfChannels ?? 2,
    mixerGraph: req.mixerGraph ?? resolveExportMixerGraph({ tracks: req.tracks, fx: req.fx }),
    automationEnvelopes: req.automationEnvelopes ?? [],
    sidechainRoutes: req.sidechainRoutes ?? [],
    resourceObserver: req.resourceObserver,
  }
}

const supportsPortableExport = (
  environment: typeof globalThis,
): environment is typeof globalThis & { Worker: typeof Worker; AudioBuffer: typeof AudioBuffer } =>
  typeof environment.Worker === 'function'
  && typeof environment.AudioBuffer === 'function'

export const readPortableDescriptorPage = async (
  descriptor: AudioPcmSourceDescriptor,
  input: { assetId: string; startFrame: number; frameCount: number; signal?: AbortSignal },
): Promise<readonly Float32Array[]> => {
  const endFrame = input.startFrame + input.frameCount

  if (
    !Number.isSafeInteger(input.startFrame)
    || input.startFrame < 0
    || !Number.isSafeInteger(input.frameCount)
    || input.frameCount <= 0
    || !Number.isSafeInteger(endFrame)
    || endFrame > descriptor.frameCount
  ) {
    throw new Error(`Portable export source page "${input.assetId}" has invalid requested bounds.`)
  }

  const planes = Array.from(
    { length: descriptor.channelCount },
    () => new Float32Array(input.frameCount),
  )

  let nextFrame = input.startFrame
  let hasAcceptedPage = false

  for await (const page of descriptor.readPages({
    startFrame: input.startFrame,
    endFrame,
    signal: input.signal,
  })) {
    const pageEndFrame = page.startFrame + page.frameCount

    if (
      !Number.isSafeInteger(page.startFrame)
      || page.startFrame < 0
      || !Number.isSafeInteger(page.frameCount)
      || page.frameCount <= 0
      || !Number.isSafeInteger(pageEndFrame)
      || pageEndFrame > descriptor.frameCount
      || page.sampleRate !== descriptor.sampleRate
      || page.channelCount !== descriptor.channelCount
      || page.planes.length !== descriptor.channelCount
      || page.planes.some((plane) => plane.length !== page.frameCount)
    ) {
      throw new Error(`Portable export source page "${input.assetId}" has invalid metadata or bounds.`)
    }

    const coveredStart = Math.max(input.startFrame, page.startFrame)
    const coveredEnd = Math.min(endFrame, pageEndFrame)

    if (coveredStart > nextFrame) {
      throw new Error(`Portable export source page "${input.assetId}" has a gap before frame ${nextFrame}.`)
    }

    if (coveredEnd <= nextFrame || (hasAcceptedPage && page.startFrame < nextFrame)) {
      throw new Error(`Portable export source page "${input.assetId}" overlaps or misses frame ${nextFrame}.`)
    }

    const sourceOffset = nextFrame - page.startFrame
    const copyFrameCount = coveredEnd - nextFrame
    const destinationOffset = nextFrame - input.startFrame

    for (let channel = 0; channel < descriptor.channelCount; channel += 1) {
      const sourcePlane = page.planes[channel]
      const destinationPlane = planes[channel]

      if (!sourcePlane || !destinationPlane) {
        throw new Error(`Portable export source page "${input.assetId}" has invalid channel data.`)
      }

      destinationPlane.set(
        sourcePlane.subarray(sourceOffset, sourceOffset + copyFrameCount),
        destinationOffset,
      )
    }

    nextFrame = coveredEnd
    hasAcceptedPage = true

    if (nextFrame === endFrame) break
  }

  if (nextFrame !== endFrame) {
    throw new Error(`Portable export source page "${input.assetId}" is missing coverage through frame ${endFrame}.`)
  }

  return planes
}

const selectPortableMixdown = async (
  req: ExportRequest,
  prepared: PreparedExportRender,
  loadArtifact: (manifestUrl: string) => Promise<AudioCoreWasmArtifactResult> = loadAudioCoreWasmArtifact,
): Promise<PortableMixdownSelection> => {
  if (!supportsPortableExport(globalThis)) return { selected: false }

  const artifact = await loadArtifact(resolvePortableWasmManifestUrl())

  if (!artifact.available) return { selected: false }
  throwIfAborted(req.signal)
  const projectGeneration = req.projectGeneration ?? 1

  if (!req.preparedStretchRepository) return { selected: false }

  const tracks = req.trackIds
    ? req.tracks.filter((track) => req.trackIds?.has(track.id))
    : req.tracks

  const preparedStretchAssets = await preparePortablePagedStretchAssets({
    tracks,
    projectBpm: req.bpm,
    projectGeneration,
    repository: req.preparedStretchRepository,
    signal: req.signal,
    resolveSource: req.resolveAudioSource,
  })

  if (!preparedStretchAssets.supported) return { selected: false }
  let leasesReleased = false

  const releasePreparedLeases = async () => {
    if (leasesReleased) return
    leasesReleased = true
    const leases = new Set(preparedStretchAssets.assets.map((asset) => asset.lease))
    await Promise.all([...leases].map((lease) => lease.release()))
  }

  try {
    throwIfAborted(req.signal)
    const descriptors = new Map<string, AudioPcmSourceDescriptor>()

    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.midi || !clip.sourceAssetKey || clip.audioWarp?.enabled === true) continue

        const descriptor = req.resolveAudioSource
          ? await req.resolveAudioSource(clip, req.signal)
          : clip.buffer
            ? createAudioPcmSourceDescriptor({
              identity: getAudioBufferSessionIdentity(clip.buffer),
              durationSec: clip.buffer.duration,
              frameCount: clip.buffer.length,
              sampleRate: clip.buffer.sampleRate,
              channelCount: clip.buffer.numberOfChannels,
              source: clip.buffer,
            })
            : undefined

        if (!descriptor) {
          await releasePreparedLeases()

          return { selected: false }
        }

        descriptors.set(clip.sourceAssetKey, descriptor)
      }
    }

    throwIfAborted(req.signal)

    const snapshot = compilePortableExportSnapshot({
    tracks,
    bpm: req.bpm,
    range: portableSnapshotRange(prepared.range),
    sampleRateHz: prepared.sampleRate,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    fx: req.fx,
    automationEnvelopes: prepared.automationEnvelopes,
    sidechainRoutes: prepared.sidechainRoutes,
    hasExternalPlugins: false,
    projectGeneration,
    preparedStretchAssets: preparedStretchAssets.assets,
    mixerGraph: prepared.mixerGraph,
    retainOrdinaryPcm: false,
    metadataSourceAssets: [...descriptors].map(([sourceAssetKey, descriptor]) => ({
      sourceAssetKey,
      frameCount: descriptor.frameCount,
      sampleRateHz: descriptor.sampleRate,
      channelCount: descriptor.channelCount,
    })),
  })

    if (!snapshot.supported
      || snapshot.assets.length > portableExportWorkerMaxAssets
      || snapshot.events.length > portableExportWorkerMaxEvents
      || snapshot.graph.nodes.length > portableExportWorkerMaxGraphNodes
      || snapshot.graph.edges.length > portableExportWorkerMaxGraphEdges) {
      await releasePreparedLeases()

      return { selected: false }
    }

    const pagedAssets = new Map(
      preparedStretchAssets.assets.map((asset) => [asset.asset.assetId, asset]),
    )

    const repository = req.preparedStretchRepository

    if (!repository) {
      await releasePreparedLeases()

      return { selected: false }
    }

    const readPage = async (input: { assetId: string; startFrame: number; frameCount: number; signal?: AbortSignal }) => {
      const preparedAsset = pagedAssets.get(input.assetId)
      const descriptor = descriptors.get(input.assetId.replace('portable-export:', ''))

      if (preparedAsset) {
        for await (const page of repository.read(preparedAsset.artifactId, input.startFrame, input.startFrame + input.frameCount)) {
          if (page.startFrame === input.startFrame && page.frameCount === input.frameCount) return page.planes
        }

        throw new Error(`Prepared Stretch page "${input.assetId}" was not found.`)
      }

      if (!descriptor) throw new Error(`Portable export source "${input.assetId}" is unavailable.`)

      return readPortableDescriptorPage(descriptor, input)
    }

    let cleanupStarted = false

    const cleanup = async () => {
      if (cleanupStarted) return
      cleanupStarted = true
      await releasePreparedLeases()
    }

    return { selected: true, artifact: artifact.artifact, snapshot, readPage, cleanup }
  } catch (error) {
    await releasePreparedLeases()
    throw error
  }
}

export const createPortableOutputBuffer = (
  chunks: ReadonlyMap<number, { frameCount: number; planes: readonly Float32Array[] }>,
  frameCount: number,
  sampleRate: number,
  numberOfChannels: number,
): AudioBuffer => {
  const stereo = new AudioBuffer({ numberOfChannels: 2, length: frameCount, sampleRate })
  let destinationFrame = 0

  for (let index = 0; index < chunks.size; index += 1) {
    const chunk = chunks.get(index)

    if (!chunk
      || chunk.frameCount <= 0
      || chunk.planes.length !== 2
      || chunk.planes[0]?.length !== chunk.frameCount
      || chunk.planes[1]?.length !== chunk.frameCount
      || destinationFrame + chunk.frameCount > frameCount) {
      throw new Error('Portable export Worker returned invalid PCM output.')
    }

    stereo.getChannelData(0).set(chunk.planes[0], destinationFrame)
    stereo.getChannelData(1).set(chunk.planes[1], destinationFrame)
    destinationFrame += chunk.frameCount
  }

  if (destinationFrame !== frameCount) throw new Error('Portable export Worker returned incomplete PCM output.')

  return numberOfChannels === 1
    ? downmixStereoBufferToMono(
      stereo,
      (channels, frames, outputSampleRate) => new AudioBuffer({ numberOfChannels: channels, length: frames, sampleRate: outputSampleRate }),
    )
    : stereo
}

/**
 * Renders the range plus the graph's output latency. The first `latencyFrames` frames are the
 * graph's delay: dropping them puts the range start at frame 0. `onChunk` receives the total
 * rendered `frameCount` so the caller can size its sink before the first chunk.
 */
export const renderPortableMixdownChunks = async (
  req: ExportRequest,
  onChunk: (index: number, startFrame: number, pcm: PlanarPcm, frameCount: number) => Promise<void> | void,
): Promise<{
  frameCount: number
  latencyFrames: number
  sampleRate: number
  numberOfChannels: number
  cleanup: () => Promise<void>
} | undefined> => {
  const prepared = prepareExportRender(req)
  const portable = await selectPortableMixdown(req, prepared)

  if (!portable.selected) return undefined
  const latencyFrames = portable.snapshot.graphLatencyFrames
  const frameCount = Math.ceil(prepared.range.durationSec * prepared.sampleRate) + latencyFrames
  const worker = new PortableExportWorker(undefined, undefined, portable.artifact)
  const releaseWorker = observeResource(prepared.resourceObserver, 'workers', worker)
  const cancel = () => worker.cancel()
  let workerDisposed = false
  let cleanupStarted = false
  req.signal?.addEventListener('abort', cancel, { once: true })

  try {
    await worker.render({
      snapshot: portable.snapshot,
      sampleRateHz: prepared.sampleRate,
      frameCount,
      generation: req.projectGeneration ?? 1,
      signal: req.signal,
      onProgress: req.onRenderProgress,
      onChunk: (index, startFrame, pcm) => {
        if (prepared.numberOfChannels === 2) {
          return onChunk(index, startFrame, pcm, frameCount)
        }

        const left = pcm.planes[0]
        const right = pcm.planes[1]

        if (!left || !right || pcm.planes.length !== 2) {
          throw new Error('Portable export Worker returned invalid stereo PCM output.')
        }

        const mono = new Float32Array(pcm.frameCount)

        for (let frame = 0; frame < pcm.frameCount; frame += 1) {
          mono[frame] = convertStereoToMonoSample(left[frame] ?? 0, right[frame] ?? 0)
        }

        return onChunk(index, startFrame, { frameCount: pcm.frameCount, planes: [mono] }, frameCount)
      },
      readPage: portable.readPage,
    })

    return {
      frameCount,
      latencyFrames,
      sampleRate: prepared.sampleRate,
      numberOfChannels: prepared.numberOfChannels,
      cleanup: async () => {
        if (cleanupStarted) return
        cleanupStarted = true

        try {
          await portable.cleanup()
        } finally {
          if (!workerDisposed) {
            workerDisposed = true
            worker.dispose()
            releaseWorker()
          }
        }
      },
    }
  } catch (error) {
    try {
      await portable.cleanup()
    } finally {
      worker.dispose()
      releaseWorker()
    }

    throw error
  } finally {
    req.signal?.removeEventListener('abort', cancel)
  }
}
