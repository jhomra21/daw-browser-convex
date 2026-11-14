import {
  decodeAudioPages,
  type DecodeAudioPageSource,
  type DecodeAudioPagesOptions,
} from '@daw-browser/audio-engine/media-pages'
import type { DecodedAudioPage } from '@daw-browser/shared'
import {
  sampledInstrumentRegion,
  sampledInstrumentRegionBytes,
  sampledInstrumentRegionFrameCount,
  sampledInstrumentRegionIdentity,
  sourceFrameCount,
  type SampledInstrumentBuffer,
  type SampledInstrumentRegion,
  type SampledInstrumentSource,
} from '@daw-browser/audio-engine/sampled-instrument-region'
import { resolveSamplePlaybackUrlForRuntime } from '~/lib/renderer-api-url'
import type { LocalAssetBytesResult } from '~/lib/local-assets'

const LOCAL_ASSET_PREFIX = 'local-asset:'

export type SampledInstrumentRegionLoadInput = {
  assetKey: string
  url: string
  sourceKind: 'upload' | 'url' | 'recording'
  source: SampledInstrumentSource
}

export type SampledInstrumentRegionLoaderOptions = {
  projectId?: () => string | undefined
  readLocalAsset?: (projectId: string, assetId: string) => Promise<LocalAssetBytesResult>
  resolveUrl?: (url: string) => string | null
  decodePages?: (
    source: DecodeAudioPageSource,
    options?: DecodeAudioPagesOptions,
  ) => AsyncIterable<DecodedAudioPage>
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  pageFrames?: number
  remoteLoadDeadlineMs?: number
}

export type SampledInstrumentRegionLoadResult =
  | { status: 'ready'; buffer: SampledInstrumentBuffer }
  | { status: 'missing' }

const DEFAULT_SAMPLED_INSTRUMENT_REMOTE_LOAD_DEADLINE_MS = 10 * 60 * 1000

const defaultCreateBuffer = (channels: number, frames: number, sampleRate: number) => {
  const AudioBufferConstructor = globalThis.AudioBuffer
  if (AudioBufferConstructor) {
    return new AudioBufferConstructor({ numberOfChannels: channels, length: frames, sampleRate })
  }
  const OfflineAudioContextConstructor = globalThis.OfflineAudioContext
  if (OfflineAudioContextConstructor) {
    return new OfflineAudioContextConstructor(channels, frames, sampleRate).createBuffer(channels, frames, sampleRate)
  }
  throw new Error('Sampled instrument region loading requires an AudioBuffer implementation.')
}

const throwIfAborted = (signal: AbortSignal | undefined) => {
  signal?.throwIfAborted()
}

const createLoadDeadline = (
  signal: AbortSignal | undefined,
  deadlineMs: number,
) => {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error('Sampled instrument remote load deadline is invalid.')
  }
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  // The deadline bounds remote decoders that never yield or observe cancellation.
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Sampled instrument remote load timed out.', 'TimeoutError')),
    deadlineMs,
  )
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    },
  }
}

const localAssetId = (url: string) => (
  url.startsWith(LOCAL_ASSET_PREFIX) && url.length > LOCAL_ASSET_PREFIX.length
    ? url.slice(LOCAL_ASSET_PREFIX.length)
    : undefined
)

const resolveSource = async (
  input: SampledInstrumentRegionLoadInput,
  options: SampledInstrumentRegionLoaderOptions,
  signal: AbortSignal | undefined,
): Promise<{ status: 'ready'; source: DecodeAudioPageSource } | { status: 'missing' }> => {
  const id = localAssetId(input.url)
  if (id) {
    const projectId = options.projectId?.()
    if (!projectId) {
      throw new Error(`Project context is unavailable for local audio asset "${id}". Retry to reload the sample.`)
    }
    const result = options.readLocalAsset
      ? await options.readLocalAsset(projectId, id)
      : await (await import('~/lib/local-assets')).readLocalAssetBytes(projectId, id)
    throwIfAborted(signal)
    if (result.status === 'missing') return { status: 'missing' }
    if (result.status === 'permission-denied') {
      throw new Error(`Permission to read local audio asset "${id}" was denied. Retry to reload the sample.`)
    }
    return { status: 'ready', source: result.file }
  }
  const url = (options.resolveUrl ?? resolveSamplePlaybackUrlForRuntime)(input.url)
  if (!url) throw new Error(`Sample URL "${input.url}" could not be resolved. Retry to reload the sample.`)
  return { status: 'ready', source: url }
}

const validatePage = (
  page: DecodedAudioPage,
  source: SampledInstrumentSource,
  sourceEndFrame: number,
) => {
  const pageEndFrame = page.startFrame + page.frameCount
  if (!Number.isSafeInteger(page.startFrame)
    || page.startFrame < 0
    || !Number.isSafeInteger(page.frameCount)
    || page.frameCount <= 0
    || !Number.isSafeInteger(pageEndFrame)
    || pageEndFrame > sourceEndFrame
    || page.sampleRate !== source.sampleRate
    || page.channelCount !== source.channelCount
    || page.planes.length !== source.channelCount
    || page.planes.some((plane) => !(plane instanceof Float32Array) || plane.length !== page.frameCount)) {
    throw new Error('Decoded sampled instrument page coverage or metadata is invalid.')
  }
  return pageEndFrame
}

export const loadSampledInstrumentRegion = async (
  input: SampledInstrumentRegionLoadInput,
  bounds: SampledInstrumentRegion,
  maxDecodedBytes: number,
  signal?: AbortSignal,
  options: SampledInstrumentRegionLoaderOptions = {},
): Promise<SampledInstrumentRegionLoadResult> => {
  const region = sampledInstrumentRegion(
    input.source,
    bounds.sourceStartFrame / input.source.sampleRate,
    bounds.sourceEndFrame / input.source.sampleRate,
  )
  const frameCount = sampledInstrumentRegionFrameCount(region)
  const bytes = sampledInstrumentRegionBytes(region, input.source.channelCount)
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0) {
    throw new Error('Sampled instrument decode budget is invalid.')
  }
  if (bytes > maxDecodedBytes) {
    throw new Error(`Sampled instrument region exceeds the ${maxDecodedBytes} byte limit.`)
  }
  throwIfAborted(signal)
  const resolved = await resolveSource(input, options, signal)
  if (resolved.status === 'missing') return resolved
  const source = resolved.source
  const sourceEndFrame = sourceFrameCount(input.source)
  const isRemote = !input.url.startsWith(LOCAL_ASSET_PREFIX)
  const deadline = isRemote
    ? createLoadDeadline(
      signal,
      options.remoteLoadDeadlineMs ?? DEFAULT_SAMPLED_INSTRUMENT_REMOTE_LOAD_DEADLINE_MS,
    )
    : undefined
  const decode = options.decodePages ?? decodeAudioPages
  const loadSignal = deadline?.signal ?? signal
  try {
    const pages = decode(source, {
      startSec: region.sourceStartFrame / input.source.sampleRate,
      endSec: region.sourceEndFrame / input.source.sampleRate,
      startFrame: region.sourceStartFrame,
      endFrame: region.sourceEndFrame,
      pageFrames: options.pageFrames,
      signal: loadSignal,
    })
    let buffer: AudioBuffer | undefined
    let nextFrame = region.sourceStartFrame
    for await (const page of pages) {
      throwIfAborted(loadSignal)
      const pageEndFrame = validatePage(page, input.source, sourceEndFrame)
      if (pageEndFrame <= region.sourceStartFrame) {
        if (nextFrame !== region.sourceStartFrame) {
          throw new Error('Decoded sampled instrument page coverage or metadata is invalid.')
        }
        continue
      }
      if (page.startFrame >= region.sourceEndFrame) {
        if (nextFrame < region.sourceEndFrame) {
          throw new Error('Decoded sampled instrument pages do not exactly cover the requested region.')
        }
        continue
      }
      const copyStartFrame = Math.max(page.startFrame, region.sourceStartFrame)
      const copyEndFrame = Math.min(pageEndFrame, region.sourceEndFrame)
      if (copyEndFrame <= copyStartFrame) {
        throw new Error('Decoded sampled instrument page coverage or metadata is invalid.')
      }
      if (copyStartFrame < nextFrame) {
        throw new Error('Decoded sampled instrument page coverage or metadata is invalid.')
      }
      if (copyStartFrame > nextFrame) {
        throw new Error('Decoded sampled instrument pages do not exactly cover the requested region.')
      }
      if (!buffer) {
        buffer = (options.createBuffer ?? defaultCreateBuffer)(
          input.source.channelCount,
          frameCount,
          input.source.sampleRate,
        )
      }
      const pageOffset = copyStartFrame - page.startFrame
      const localOffset = copyStartFrame - region.sourceStartFrame
      const copyFrameCount = copyEndFrame - copyStartFrame
      for (let channel = 0; channel < input.source.channelCount; channel += 1) {
        const plane = page.planes[channel]
        if (!plane) throw new Error('Decoded sampled instrument page is missing a channel plane.')
        const samples = plane.subarray(pageOffset, pageOffset + copyFrameCount)
        // An indexed loop: `every(Number.isFinite)` is about 20x slower on long regions.
        for (let frame = 0; frame < samples.length; frame += 1) {
          if (!Number.isFinite(samples[frame])) throw new Error('Decoded sampled instrument PCM contains a non-finite sample.')
        }
        buffer.getChannelData(channel).set(samples, localOffset)
      }
      nextFrame = copyEndFrame
    }
    if (!buffer || nextFrame !== region.sourceEndFrame) {
      throw new Error('Decoded sampled instrument pages do not exactly cover the requested region.')
    }
    throwIfAborted(loadSignal)
    const sampled = {
      buffer,
      sourceStartFrame: region.sourceStartFrame,
      sourceIdentity: sampledInstrumentRegionIdentity(input, region),
    }
    Object.defineProperty(sampled, 'sourceIdentity', { enumerable: false })
    return { status: 'ready', buffer: sampled }
  } finally {
    deadline?.dispose()
  }
}
