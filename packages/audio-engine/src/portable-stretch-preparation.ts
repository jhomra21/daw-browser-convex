import {
  audioCoreContractVersion,
  isPlanarPcmForAsset,
  type AudioAssetRef,
  type PlanarPcm,
} from '../../audio-core-contract/src/index'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import {
  createAudioStretchCache,
  type StretchedAudioRender,
} from './audio-stretch-cache'
import type { AudioAssetRegistration, AudioAssetRelease } from './audio-asset-types'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'
import {
  createAudioPcmSourceDescriptor,
  defaultDecodedAudioPageFrames,
  type AudioPcmSourceDescriptor,
} from './media-pages'
import { createAudioStretchReadPlan, type AudioStretchReadPlan } from './audio-stretch-read-plan'
import type { PortableAssetRegistryEntry } from './portable-session-compiler'
import { WSOLA_MAX_PIPELINE_WORKING_MEMORY_BYTES } from './audio-stretching'

export type PortableStretchDiagnosticCode =
  | 'stretch-realtime-unsupported'
  | 'warp-mode-unsupported'
  | 'stretch-prepared-asset-required'
  | 'stretch-render-cancelled'
  | 'stretch-render-failed'
  | 'stretch-invalid-sample-rate'
  | 'stretch-invalid-channel-count'
  | 'stretch-invalid-frame-count'
  | 'stretch-invalid-frame-capacity'
  | 'stretch-frame-capacity-exceeded'
  | 'stretch-invalid-asset-count'
  | 'stretch-asset-count-exceeded'
  | 'stretch-invalid-preparation-bytes'
  | 'stretch-preparation-bytes-exceeded'
  | 'stretch-metadata-mismatch'
  | 'stretch-asset-stale-generation'
  | 'stretch-registration-capacity-exceeded'
  | 'stretch-registration-stale-generation'
  | 'stretch-registration-invalid-pcm'
  | 'stretch-release-stale-generation'

export type PortableStretchDiagnostic = {
  code: PortableStretchDiagnosticCode
  clipId: string
  message: string
}

export type PortablePreparedStretchAsset = {
  clipId: string
  sourceAssetKey?: string
  sourceDurationSec: number
  projectGeneration: number
  projectAssetId: string
  portableAssetId: string
  asset: AudioAssetRef
  pcm: PlanarPcm
  transferables: readonly ArrayBuffer[]
  timelineStartSec: number
  timelineDurationSec: number
  sourceStartSec: number
}

export type PortableStretchPreparation =
  | { supported: true; asset: PortablePreparedStretchAsset }
  | { supported: false; diagnostics: readonly PortableStretchDiagnostic[] }

export type PortableStretchAssetPreparation =
  | { supported: true; assets: readonly PortablePreparedStretchAsset[] }
  | { supported: false; diagnostics: readonly PortableStretchDiagnostic[] }

export type PortableStretchAssetRegistry = {
  register: (asset: AudioAssetRef, pcm: PlanarPcm, generation: number) => Promise<AudioAssetRegistration>
  release: (assetId: string, generation: number) => Promise<AudioAssetRelease>
}

export type PortableRegisteredStretchAsset = {
  prepared: PortablePreparedStretchAsset
  entry: PortableAssetRegistryEntry
  release: () => Promise<
    | { released: true }
    | { released: false; diagnostic: PortableStretchDiagnostic }
  >
}

export type PortableStretchRegistration =
  | { supported: true; registered: PortableRegisteredStretchAsset }
  | { supported: false; diagnostics: readonly PortableStretchDiagnostic[] }

type PreparePortableStretchInput = {
  clip: AudioStretchRuntimeClip
  projectBpm: number
  projectGeneration: number
  signal?: AbortSignal
  renderStretch: (
    clip: AudioStretchRuntimeClip,
    projectBpm: number,
    signal?: AbortSignal,
  ) => Promise<StretchedAudioRender>
}

const positiveSafeInteger = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0

export const isPortableStretchClip = (clip: Clip<AudioBuffer>) =>
  clip.midi === undefined
  && clip.audioWarp?.enabled === true
  && clip.audioWarp.mode === 'stretch'

const diagnostic = (
  clipId: string,
  code: PortableStretchDiagnosticCode,
  message: string,
): PortableStretchDiagnostic => ({ code, clipId, message })

const sourceForBuffer = (clip: AudioStretchRuntimeClip): AudioPcmSourceDescriptor | undefined => {
  if (!clip.buffer) return undefined
  return createAudioPcmSourceDescriptor({
    identity: clip.sourceAssetKey ? `buffer:${clip.sourceAssetKey}` : `buffer:${clip.id}`,
    durationSec: clip.buffer.duration,
    frameCount: clip.buffer.length,
    sampleRate: clip.buffer.sampleRate,
    channelCount: clip.buffer.numberOfChannels,
    source: clip.buffer,
  })
}

const normalizedFrameCount = (frameCount: number, sourceSampleRateHz: number, requiredSampleRateHz: number | undefined) =>
  requiredSampleRateHz === undefined
    ? frameCount
    : Math.max(1, Math.round(frameCount * requiredSampleRateHz / sourceSampleRateHz))

const multiplyBytes = (frameCount: number, channelCount: number): number | undefined => {
  const elements = frameCount * channelCount
  const bytes = elements * Float32Array.BYTES_PER_ELEMENT
  return Number.isSafeInteger(elements)
    && Number.isSafeInteger(bytes)
    && bytes >= 0
    ? bytes
    : undefined
}

type PreparationMemoryEstimate = {
  retainedBytes: number
  transientBytes: number
}

const preparationMemory = (
  plan: AudioStretchReadPlan,
  source: AudioPcmSourceDescriptor,
  requiredSampleRateHz: number | undefined,
  eagerSource: AudioBuffer | null | undefined,
): PreparationMemoryEstimate | undefined => {
  const finalFrameCount = normalizedFrameCount(plan.frameCount, source.sampleRate, requiredSampleRateHz)
  const sourceBytes = eagerSource
    ? multiplyBytes(eagerSource.length, eagerSource.numberOfChannels)
    : 0
  const sourcePageBytes = eagerSource
    ? sourceBytes
    : multiplyBytes(defaultDecodedAudioPageFrames, source.channelCount)
  const renderedBytes = multiplyBytes(plan.frameCount, source.channelCount)
  const finalBytes = multiplyBytes(finalFrameCount, source.channelCount)
  if (
    sourceBytes === undefined
    || sourcePageBytes === undefined
    || renderedBytes === undefined
    || finalBytes === undefined
  ) return undefined
  const resampling = requiredSampleRateHz !== undefined && requiredSampleRateHz !== source.sampleRate
  const retainedBytes = finalBytes
  const sourceResidentBytes = eagerSource ? sourceBytes : sourcePageBytes
  const currentAssetBytes = sourceResidentBytes
    + renderedBytes
    + (resampling ? renderedBytes : 0)
  const workspaceBytes = sourceResidentBytes + WSOLA_MAX_PIPELINE_WORKING_MEMORY_BYTES
  const transientBytes = Math.max(workspaceBytes, currentAssetBytes)
  return Number.isSafeInteger(retainedBytes)
    && Number.isSafeInteger(transientBytes)
    && retainedBytes >= 0
    && transientBytes >= 0
    ? { retainedBytes, transientBytes }
    : undefined
}

const preparedPcmByteLength = (prepared: PortablePreparedStretchAsset): number => (
  prepared.pcm.planes.reduce((total, plane) => total + plane.byteLength, 0)
)

export const validatePortablePreparedStretchAsset = (
  prepared: PortablePreparedStretchAsset,
): PortableStretchDiagnostic | undefined => {
  if (!positiveSafeInteger(prepared.asset.sampleRateHz)) {
    return diagnostic(
      prepared.clipId,
      'stretch-invalid-sample-rate',
      `${prepared.clipId}: pre-rendered Stretch audio has an invalid sample rate.`,
    )
  }
  if (!positiveSafeInteger(prepared.asset.channelCount) || prepared.asset.channelCount > 2) {
    return diagnostic(
      prepared.clipId,
      'stretch-invalid-channel-count',
      `${prepared.clipId}: pre-rendered Stretch audio must be mono or stereo.`,
    )
  }
  if (!positiveSafeInteger(prepared.asset.frameCount)
    || !isPlanarPcmForAsset(prepared.asset, prepared.pcm)) {
    return diagnostic(
      prepared.clipId,
      'stretch-invalid-frame-count',
      `${prepared.clipId}: pre-rendered Stretch PCM does not match its frame metadata.`,
    )
  }
  if (!prepared.clipId
    || !positiveSafeInteger(prepared.projectGeneration)
    || prepared.projectAssetId !== prepared.portableAssetId
    || prepared.asset.assetId !== prepared.portableAssetId
    || !Number.isFinite(prepared.sourceDurationSec)
    || prepared.sourceDurationSec <= 0
    || !Number.isFinite(prepared.timelineStartSec)
    || !Number.isFinite(prepared.timelineDurationSec)
    || prepared.timelineDurationSec <= 0
    || Math.abs(
      prepared.timelineDurationSec - prepared.asset.frameCount / prepared.asset.sampleRateHz,
    ) > 0.5 / prepared.asset.sampleRateHz
    || prepared.sourceStartSec !== 0
    || prepared.transferables.length !== prepared.pcm.planes.length
    || prepared.transferables.some((buffer, index) => buffer !== prepared.pcm.planes[index].buffer)) {
    return diagnostic(
      prepared.clipId,
      'stretch-metadata-mismatch',
      `${prepared.clipId}: pre-rendered Stretch identity or timing metadata is invalid.`,
    )
  }
  return undefined
}

const fingerprintPcm = (
  planes: readonly Float32Array[],
  sampleRateHz: number,
): string => {
  let hash = 2_166_136_261
  hash = Math.imul(hash ^ sampleRateHz, 16_777_619) >>> 0
  hash = Math.imul(hash ^ planes.length, 16_777_619) >>> 0
  hash = Math.imul(hash ^ (planes[0]?.length ?? 0), 16_777_619) >>> 0
  for (const plane of planes) {
    const bits = new Uint32Array(plane.buffer, plane.byteOffset, plane.length)
    for (let frame = 0; frame < bits.length; frame += 1) {
      hash = Math.imul(hash ^ bits[frame], 16_777_619) >>> 0
    }
  }
  return hash.toString(36)
}

const portableAssetId = (
  clipId: string,
  projectGeneration: number,
  pcmFingerprint: string,
) => `portable-stretch:${projectGeneration}:${clipId}:${pcmFingerprint}`

const resamplePcm = (
  planes: readonly Float32Array<ArrayBufferLike>[],
  sourceFrameCount: number,
  targetFrameCount: number,
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): Float32Array<ArrayBuffer>[] => planes.map((source) => {
  const target = new Float32Array(targetFrameCount)
  if (sourceFrameCount === 1) {
    target.fill(Number.isFinite(source[0]) ? source[0] : 0)
    return target
  }
  if (targetSampleRateHz > sourceSampleRateHz) {
    const sourcePositionScale = sourceSampleRateHz / targetSampleRateHz
    for (let frame = 0; frame < targetFrameCount; frame += 1) {
      const sourcePosition = Math.min(
        sourceFrameCount - 1,
        frame * sourcePositionScale,
      )
      const sourceFrame = Math.floor(sourcePosition)
      const fraction = sourcePosition - sourceFrame
      const first = source[sourceFrame] ?? 0
      const second = source[Math.min(sourceFrame + 1, sourceFrameCount - 1)] ?? first
      const value = first + (second - first) * fraction
      target[frame] = Number.isFinite(value) ? value : 0
    }
    return target
  }
  const sourceTimePerTargetFrame = sourceSampleRateHz / targetSampleRateHz
  let sourceFrame = 0
  for (let frame = 0; frame < targetFrameCount; frame += 1) {
    const intervalStart = frame * sourceTimePerTargetFrame
    const intervalEnd = Math.min(
      sourceFrameCount,
      (frame + 1) * sourceTimePerTargetFrame,
    )
    sourceFrame = Math.min(sourceFrame, Math.max(0, sourceFrameCount - 1))
    while (sourceFrame + 1 < sourceFrameCount && sourceFrame + 1 <= intervalStart) {
      sourceFrame += 1
    }
    let cursor = intervalStart
    let weightedSum = 0
    while (cursor < intervalEnd) {
      const overlapEnd = Math.min(intervalEnd, sourceFrame + 1)
      const weight = overlapEnd - cursor
      const value = source[sourceFrame] ?? 0
      weightedSum += (Number.isFinite(value) ? value : 0) * weight
      cursor = overlapEnd
      if (sourceFrame + 1 >= sourceFrameCount) break
      if (cursor >= sourceFrame + 1) sourceFrame += 1
      else break
    }
    const value = intervalEnd > intervalStart
      ? weightedSum / (intervalEnd - intervalStart)
      : source[sourceFrame] ?? 0
    target[frame] = Number.isFinite(value) ? value : 0
  }
  return target
})

const normalizePreparedStretchAsset = (
  prepared: PortablePreparedStretchAsset,
  requiredSampleRateHz: number,
): PortablePreparedStretchAsset => {
  const frameCount = Math.max(
    1,
    Math.round(prepared.asset.frameCount * requiredSampleRateHz / prepared.asset.sampleRateHz),
  )
  const planes = resamplePcm(
    prepared.pcm.planes,
    prepared.asset.frameCount,
    frameCount,
    prepared.asset.sampleRateHz,
    requiredSampleRateHz,
  )
  const assetId = portableAssetId(
    prepared.clipId,
    prepared.projectGeneration,
    fingerprintPcm(planes, requiredSampleRateHz),
  )
  const asset: AudioAssetRef = {
    ...prepared.asset,
    assetId,
    frameCount,
    sampleRateHz: requiredSampleRateHz,
  }
  return {
    ...prepared,
    projectAssetId: assetId,
    portableAssetId: assetId,
    asset,
    pcm: { frameCount, planes },
    transferables: planes.map((plane) => plane.buffer),
  }
}

const validateRender = (
  clip: AudioStretchRuntimeClip,
  render: StretchedAudioRender,
): PortableStretchDiagnostic | undefined => {
  const buffer = render.buffer
  if (!positiveSafeInteger(buffer.sampleRate)) {
    return diagnostic(
      clip.id,
      'stretch-invalid-sample-rate',
      `${clip.id}: pre-rendered Stretch audio has an invalid sample rate.`,
    )
  }
  if (!positiveSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels > 2) {
    return diagnostic(
      clip.id,
      'stretch-invalid-channel-count',
      `${clip.id}: pre-rendered Stretch audio must be mono or stereo.`,
    )
  }
  if (!positiveSafeInteger(buffer.length)) {
    return diagnostic(
      clip.id,
      'stretch-invalid-frame-count',
      `${clip.id}: pre-rendered Stretch audio has an invalid frame count.`,
    )
  }
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    if (buffer.getChannelData(channel).length !== buffer.length) {
      return diagnostic(
        clip.id,
        'stretch-invalid-frame-count',
        `${clip.id}: pre-rendered Stretch channel lengths do not match.`,
      )
    }
  }
  const exactDurationSec = buffer.length / buffer.sampleRate
  const toleranceSec = 0.5 / buffer.sampleRate
  if (!Number.isFinite(render.timelineStartSec)
    || !Number.isFinite(render.timelineDurationSec)
    || !Number.isFinite(render.sourceStartSec)
    || render.sourceStartSec !== 0
    || Math.abs(render.timelineDurationSec - exactDurationSec) > toleranceSec) {
    return diagnostic(
      clip.id,
      'stretch-metadata-mismatch',
      `${clip.id}: pre-rendered Stretch timing metadata does not match its PCM.`,
    )
  }
  return undefined
}

export const preparePortableStretchAsset = async (
  input: PreparePortableStretchInput,
): Promise<PortableStretchPreparation> => {
  try {
    input.signal?.throwIfAborted()
    if (!positiveSafeInteger(input.projectGeneration)) {
      return {
        supported: false,
        diagnostics: [diagnostic(
          input.clip.id,
          'stretch-asset-stale-generation',
          `${input.clip.id}: portable Stretch asset generation is invalid.`,
        )],
      }
    }
    const render = await input.renderStretch(input.clip, input.projectBpm, input.signal)
    input.signal?.throwIfAborted()
    const invalid = validateRender(input.clip, render)
    if (invalid) return { supported: false, diagnostics: [invalid] }
    const planes = Array.from(
      { length: render.buffer.numberOfChannels },
      (_, channel) => new Float32Array(render.buffer.getChannelData(channel)),
    )
    const assetId = portableAssetId(
      input.clip.id,
      input.projectGeneration,
      fingerprintPcm(planes, render.buffer.sampleRate),
    )
    const asset: AudioAssetRef = {
      version: audioCoreContractVersion,
      assetId,
      frameCount: render.buffer.length,
      sampleRateHz: render.buffer.sampleRate,
      channelCount: render.buffer.numberOfChannels,
    }
    return {
      supported: true,
      asset: {
        clipId: input.clip.id,
        sourceAssetKey: input.clip.sourceAssetKey,
        sourceDurationSec: input.clip.sourceDurationSec ?? input.clip.buffer?.duration ?? 0,
        projectGeneration: input.projectGeneration,
        projectAssetId: assetId,
        portableAssetId: assetId,
        asset,
        pcm: { frameCount: render.buffer.length, planes },
        transferables: planes.map((plane) => plane.buffer),
        timelineStartSec: render.timelineStartSec,
        timelineDurationSec: render.timelineDurationSec,
        sourceStartSec: render.sourceStartSec,
      },
    }
  } catch (error) {
    const aborted = (error instanceof DOMException || error instanceof Error)
      && error.name === 'AbortError'
    return {
      supported: false,
      diagnostics: [diagnostic(
        input.clip.id,
        aborted ? 'stretch-render-cancelled' : 'stretch-render-failed',
        aborted
          ? `${input.clip.id}: portable Stretch preparation was cancelled.`
          : `${input.clip.id}: portable Stretch preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      )],
    }
  }
}

export const preparePortableStretchAssets = async (input: {
  tracks: readonly Track<AudioBuffer>[]
  projectBpm: number
  projectGeneration: number
  requiredSampleRateHz?: number
  maximumFrameCount?: number | ((channelCount: number) => number)
  maximumAssetCount?: number
  /**
   * Already-installed assets counted by the target capacity. Stretch assets
   * are checked against the remaining capacity, while callers that omit this
   * value retain the standalone preparation limit.
   */
  existingAssetCount?: number
  maximumPreparationBytes?: number
  createBuffer: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  resolveSource?: (clip: AudioStretchRuntimeClip, signal?: AbortSignal) => Promise<AudioPcmSourceDescriptor>
  signal?: AbortSignal
}): Promise<PortableStretchAssetPreparation> => {
  if (input.maximumFrameCount !== undefined
    && !(input.maximumFrameCount instanceof Function)
    && !positiveSafeInteger(input.maximumFrameCount)) {
    return {
      supported: false,
      diagnostics: [diagnostic(
        'portable-stretch',
        'stretch-invalid-frame-capacity',
        'portable Stretch maximumFrameCount must be a positive safe integer.',
      )],
    }
  }
  if (input.maximumAssetCount !== undefined
    && (!Number.isSafeInteger(input.maximumAssetCount) || input.maximumAssetCount < 0)) {
    return {
      supported: false,
      diagnostics: [diagnostic(
        'portable-stretch',
        'stretch-invalid-asset-count',
        'portable Stretch maximumAssetCount must be a positive safe integer.',
      )],
    }
  }
  if (input.existingAssetCount !== undefined
    && (!Number.isSafeInteger(input.existingAssetCount) || input.existingAssetCount < 0)) {
    return {
      supported: false,
      diagnostics: [diagnostic(
        'portable-stretch',
        'stretch-invalid-asset-count',
        'portable Stretch existingAssetCount must be a nonnegative safe integer.',
      )],
    }
  }
  if (input.maximumPreparationBytes !== undefined && !positiveSafeInteger(input.maximumPreparationBytes)) {
    return {
      supported: false,
      diagnostics: [diagnostic(
        'portable-stretch',
        'stretch-invalid-preparation-bytes',
        'portable Stretch maximumPreparationBytes must be a positive safe integer.',
      )],
    }
  }
  const eligibleClips = input.tracks.flatMap((track) => (
    track.clips.filter(isPortableStretchClip)
  ))
  const availableAssetCount = input.maximumAssetCount === undefined
    ? undefined
    : input.maximumAssetCount - (input.existingAssetCount ?? 0)
  if (availableAssetCount !== undefined && (
    availableAssetCount < 0 || eligibleClips.length > availableAssetCount
  )) {
    return {
      supported: false,
      diagnostics: [diagnostic(
        'portable-stretch',
        'stretch-asset-count-exceeded',
        `portable Stretch preparation would exceed the installed audio asset capacity of ${input.maximumAssetCount} assets.`,
      )],
    }
  }
  const sources = new Map<string, AudioPcmSourceDescriptor>()
  const plans = new Map<string, AudioStretchReadPlan>()
  let estimatedRetainedBytes = 0
  for (const clip of eligibleClips) {
    try {
      input.signal?.throwIfAborted()
      const source = clip.buffer
        ? sourceForBuffer(clip)
        : input.resolveSource
          ? await input.resolveSource(clip, input.signal)
          : undefined
      if (!source) {
        return {
          supported: false,
          diagnostics: [diagnostic(
            clip.id,
            'stretch-render-failed',
            `${clip.id}: Stretch preparation requires a decoded source resolver.`,
          )],
        }
      }
      if (!positiveSafeInteger(source.channelCount) || source.channelCount > 2) {
        return {
          supported: false,
          diagnostics: [diagnostic(
            clip.id,
            'stretch-invalid-channel-count',
            `${clip.id}: Stretch source audio must be mono or stereo.`,
          )],
        }
      }
      const plan = createAudioStretchReadPlan({ clip, source, projectBpm: input.projectBpm })
      sources.set(clip.id, source)
      plans.set(clip.id, plan)
      if (input.maximumPreparationBytes !== undefined) {
        const estimate = preparationMemory(plan, source, input.requiredSampleRateHz, clip.buffer)
        if (
          estimate === undefined
          || estimatedRetainedBytes > Number.MAX_SAFE_INTEGER - estimate.retainedBytes
        ) {
          return {
            supported: false,
            diagnostics: [diagnostic(
              clip.id,
              'stretch-preparation-bytes-exceeded',
              `${clip.id}: Stretch preparation memory estimate is unsafe or non-finite.`,
            )],
          }
        }
        const nextRetainedBytes = estimatedRetainedBytes + estimate.retainedBytes
        if (
          nextRetainedBytes > Number.MAX_SAFE_INTEGER - estimate.transientBytes
          || nextRetainedBytes + estimate.transientBytes > input.maximumPreparationBytes
        ) {
          return {
            supported: false,
            diagnostics: [diagnostic(
              clip.id,
              'stretch-preparation-bytes-exceeded',
              `${clip.id}: Stretch preparation would exceed the memory budget of ${input.maximumPreparationBytes} bytes.`,
            )],
          }
        }
        estimatedRetainedBytes = nextRetainedBytes
      }
    } catch (error) {
      const aborted = (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError'
      return {
        supported: false,
        diagnostics: [diagnostic(
          clip.id,
          aborted ? 'stretch-render-cancelled' : 'stretch-render-failed',
          aborted
            ? `${clip.id}: portable Stretch preparation was cancelled.`
            : `${clip.id}: portable Stretch preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        )],
      }
    }
  }
  const cache = createAudioStretchCache({
    createBuffer: input.createBuffer,
    resolveSource: input.resolveSource,
    materializationPolicy: {
      maximumBytes: input.maximumPreparationBytes ?? 256 * 1024 * 1024,
      maximumChannels: 32,
    },
  })
  const assets: PortablePreparedStretchAsset[] = []
  let actualRetainedBytes = 0
  try {
    for (const clip of eligibleClips) {
      const source = sources.get(clip.id)
      const maximumFrameCount = input.maximumFrameCount === undefined
        ? undefined
        : input.maximumFrameCount instanceof Function
          ? input.maximumFrameCount(source?.channelCount ?? 0)
          : input.maximumFrameCount
      if (input.maximumFrameCount !== undefined) {
        if (maximumFrameCount === undefined || !positiveSafeInteger(maximumFrameCount)) {
          return {
            supported: false,
            diagnostics: [diagnostic(
              clip.id,
              'stretch-invalid-frame-capacity',
              `${clip.id}: portable Stretch maximumFrameCount is invalid for its source channel count.`,
            )],
          }
        }
        const plan = plans.get(clip.id)
        if (!plan || !source) {
          return {
            supported: false,
            diagnostics: [diagnostic(
              clip.id,
              'stretch-render-failed',
              `${clip.id}: Stretch preparation source metadata is unavailable.`,
            )],
          }
        }
        const requiredFrameCount = normalizedFrameCount(
          plan.frameCount,
          source.sampleRate,
          input.requiredSampleRateHz,
        )
        if (!Number.isSafeInteger(requiredFrameCount) || requiredFrameCount > maximumFrameCount) {
          return {
            supported: false,
            diagnostics: [diagnostic(
              clip.id,
              'stretch-frame-capacity-exceeded',
              `${clip.id}: prepared Stretch audio exceeds the native frame capacity of ${maximumFrameCount} frames.`,
            )],
          }
        }
      }
      const prepared = await preparePortableStretchAsset({
        clip,
        projectBpm: input.projectBpm,
        projectGeneration: input.projectGeneration,
        signal: input.signal,
        renderStretch: (runtimeClip, projectBpm, signal) => cache.renderNow(
          runtimeClip,
          projectBpm,
          signal,
          sources.get(runtimeClip.id),
        ),
      })
      if (!prepared.supported) return prepared
      if (maximumFrameCount !== undefined
        && (input.requiredSampleRateHz === undefined
          || prepared.asset.asset.sampleRateHz === input.requiredSampleRateHz)
        && prepared.asset.asset.frameCount > maximumFrameCount) {
        return {
          supported: false,
          diagnostics: [diagnostic(
            clip.id,
            'stretch-frame-capacity-exceeded',
            `${clip.id}: prepared Stretch audio exceeds the native frame capacity of ${maximumFrameCount} frames.`,
          )],
        }
      }
      let finalAsset = prepared.asset
      if (input.requiredSampleRateHz !== undefined
        && prepared.asset.asset.sampleRateHz !== input.requiredSampleRateHz) {
        if (input.signal?.aborted) {
          return {
            supported: false,
            diagnostics: [diagnostic(
              clip.id,
              'stretch-render-cancelled',
              `${clip.id}: portable Stretch preparation was cancelled.`,
            )],
          }
        }
        finalAsset = normalizePreparedStretchAsset(
          prepared.asset,
          input.requiredSampleRateHz,
        )
      }
      const finalMaximumFrameCount = input.maximumFrameCount === undefined
        ? undefined
        : input.maximumFrameCount instanceof Function
          ? input.maximumFrameCount(finalAsset.asset.channelCount)
          : input.maximumFrameCount
      if (input.maximumFrameCount !== undefined
        && (finalMaximumFrameCount === undefined || !positiveSafeInteger(finalMaximumFrameCount))) {
        return {
          supported: false,
          diagnostics: [diagnostic(
            clip.id,
            'stretch-invalid-frame-capacity',
            `${clip.id}: portable Stretch maximumFrameCount is invalid for its source channel count.`,
          )],
        }
      }
      if (finalMaximumFrameCount !== undefined && finalAsset.asset.frameCount > finalMaximumFrameCount) {
        return {
          supported: false,
          diagnostics: [diagnostic(
            clip.id,
            'stretch-frame-capacity-exceeded',
            `${clip.id}: prepared Stretch audio exceeds the native frame capacity of ${finalMaximumFrameCount} frames.`,
          )],
        }
      }
      if (input.maximumPreparationBytes !== undefined) {
        const renderedBytes = multiplyBytes(
          prepared.asset.asset.frameCount,
          prepared.asset.asset.channelCount,
        )
        const finalBytes = preparedPcmByteLength(finalAsset)
        const resampling = finalAsset !== prepared.asset
        const sourceBytes = clip.buffer
          ? multiplyBytes(clip.buffer.length, clip.buffer.numberOfChannels)
          : multiplyBytes(defaultDecodedAudioPageFrames, prepared.asset.asset.channelCount)
        const retainedBytes = finalBytes
        const currentAssetBytes = sourceBytes !== undefined
          && renderedBytes !== undefined
          && finalBytes !== undefined
          ? sourceBytes
            + renderedBytes
            + (resampling ? renderedBytes : 0)
          : undefined
        const transientBytes = currentAssetBytes === undefined || sourceBytes === undefined
          ? undefined
          : Math.max(
            sourceBytes + WSOLA_MAX_PIPELINE_WORKING_MEMORY_BYTES,
            currentAssetBytes,
          )
        if (
          retainedBytes === undefined
          || transientBytes === undefined
          || !Number.isSafeInteger(retainedBytes)
          || !Number.isSafeInteger(transientBytes)
          || actualRetainedBytes > Number.MAX_SAFE_INTEGER - transientBytes
          || actualRetainedBytes + transientBytes > input.maximumPreparationBytes
        ) {
          return {
            supported: false,
            diagnostics: [diagnostic(
              clip.id,
              'stretch-preparation-bytes-exceeded',
              `${clip.id}: prepared Stretch PCM would exceed the memory budget of ${input.maximumPreparationBytes} bytes.`,
            )],
          }
        }
        actualRetainedBytes += retainedBytes
      }
      assets.push(finalAsset)
    }
    return { supported: true, assets }
  } finally {
    cache.dispose()
  }
}

export const registerPortableStretchAsset = async (input: {
  prepared: PortablePreparedStretchAsset
  projectGeneration: number
  registry: PortableStretchAssetRegistry
  signal?: AbortSignal
}): Promise<PortableStretchRegistration> => {
  const { prepared } = input
  if (prepared.projectGeneration !== input.projectGeneration) {
    return {
      supported: false,
      diagnostics: [diagnostic(
        prepared.clipId,
        'stretch-asset-stale-generation',
        `${prepared.clipId}: pre-rendered Stretch asset belongs to a stale project generation.`,
      )],
    }
  }
  try {
    input.signal?.throwIfAborted()
    const result = await input.registry.register(prepared.asset, prepared.pcm, input.projectGeneration)
    if (result.status !== 'registered') {
      const code = result.status === 'capacity-exceeded'
        ? 'stretch-registration-capacity-exceeded'
        : result.status === 'invalid-pcm'
          ? 'stretch-registration-invalid-pcm'
          : 'stretch-registration-stale-generation'
      return {
        supported: false,
        diagnostics: [diagnostic(
          prepared.clipId,
          code,
          `${prepared.clipId}: portable Stretch asset registration was rejected (${result.status}).`,
        )],
      }
    }
    let released = false
    const release = async (): Promise<
      | { released: true }
      | { released: false; diagnostic: PortableStretchDiagnostic }
    > => {
      if (released) return { released: true }
      const releaseResult = await input.registry.release(prepared.portableAssetId, input.projectGeneration)
      if (releaseResult.status !== 'released') {
        return {
          released: false,
          diagnostic: diagnostic(
            prepared.clipId,
            'stretch-release-stale-generation',
            `${prepared.clipId}: portable Stretch asset release used a stale project generation.`,
          ),
        }
      }
      released = true
      return { released: true }
    }
    if (input.signal?.aborted) {
      const releaseResult = await release()
      return {
        supported: false,
        diagnostics: [
          diagnostic(
            prepared.clipId,
            'stretch-render-cancelled',
            `${prepared.clipId}: portable Stretch preparation was cancelled.`,
          ),
          ...(!releaseResult.released ? [releaseResult.diagnostic] : []),
        ],
      }
    }
    return {
      supported: true,
      registered: {
        prepared,
        entry: {
          projectAssetId: prepared.projectAssetId,
          portableAssetId: prepared.portableAssetId,
          projectGeneration: input.projectGeneration,
          handle: result.handle,
          decoded: {
            sampleRateHz: prepared.asset.sampleRateHz,
            channelCount: prepared.asset.channelCount,
            frameCount: prepared.asset.frameCount,
          },
        },
        release,
      },
    }
  } catch (error) {
    const aborted = (error instanceof DOMException || error instanceof Error)
      && error.name === 'AbortError'
    return {
      supported: false,
      diagnostics: [diagnostic(
        prepared.clipId,
        aborted ? 'stretch-render-cancelled' : 'stretch-render-failed',
        aborted
          ? `${prepared.clipId}: portable Stretch preparation was cancelled.`
          : `${prepared.clipId}: portable Stretch asset registration failed: ${error instanceof Error ? error.message : String(error)}`,
      )],
    }
  }
}
