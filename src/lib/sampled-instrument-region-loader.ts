import {
  decodeAudioPages,
  type DecodeAudioPageSource,
  type DecodeAudioPagesOptions,
  type DecodedAudioPage,
} from '@daw-browser/audio-engine/media-pages'
import {
  sampledInstrumentRegion,
  sampledInstrumentRegionBytes,
  sampledInstrumentRegionFrameCount,
  sampledInstrumentRegionIdentity,
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

export const DEFAULT_SAMPLED_INSTRUMENT_REMOTE_LOAD_DEADLINE_MS = 10 * 60 * 1000

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
): Promise<DecodeAudioPageSource | null> => {
  const id = localAssetId(input.url)
  if (id) {
    const projectId = options.projectId?.()
    if (!projectId) return null
    const result = options.readLocalAsset
      ? await options.readLocalAsset(projectId, id)
      : await (await import('~/lib/local-assets')).readLocalAssetBytes(projectId, id)
    throwIfAborted(signal)
    return result.status === 'ready' ? result.file : null
  }
  const url = (options.resolveUrl ?? resolveSamplePlaybackUrlForRuntime)(input.url)
  return url
}

const validatePage = (
  page: DecodedAudioPage,
  source: SampledInstrumentSource,
  expectedStartFrame: number,
  expectedEndFrame: number,
  nextFrame: number,
) => {
  if (page.startFrame !== nextFrame
    || page.startFrame < expectedStartFrame
    || page.startFrame + page.frameCount > expectedEndFrame
    || !Number.isSafeInteger(page.frameCount)
    || page.frameCount <= 0
    || page.sampleRate !== source.sampleRate
    || page.channelCount !== source.channelCount
    || page.planes.length !== source.channelCount
    || page.planes.some((plane) => plane.length !== page.frameCount)) {
    throw new Error('Decoded sampled instrument page coverage or metadata is invalid.')
  }
}

export const loadSampledInstrumentRegion = async (
  input: SampledInstrumentRegionLoadInput,
  bounds: SampledInstrumentRegion,
  maxDecodedBytes: number,
  signal?: AbortSignal,
  options: SampledInstrumentRegionLoaderOptions = {},
): Promise<SampledInstrumentBuffer | null> => {
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
  const source = await resolveSource(input, options, signal)
  if (!source) return null
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
      validatePage(page, input.source, region.sourceStartFrame, region.sourceEndFrame, nextFrame)
      if (!buffer) {
        buffer = (options.createBuffer ?? defaultCreateBuffer)(
          input.source.channelCount,
          frameCount,
          input.source.sampleRate,
        )
      }
      const localOffset = page.startFrame - region.sourceStartFrame
      for (let channel = 0; channel < input.source.channelCount; channel += 1) {
        const plane = page.planes[channel]
        if (!plane) throw new Error('Decoded sampled instrument page is missing a channel plane.')
        buffer.getChannelData(channel).set(plane, localOffset)
      }
      nextFrame += page.frameCount
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
    return sampled
  } finally {
    deadline?.dispose()
  }
}
