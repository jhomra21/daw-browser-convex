import {
  audioCoreContractVersion,
  isPlanarPcmForAsset,
  type AudioAssetRef,
  type PlanarPcm,
} from '../../audio-core-contract/src/index'
import type { Track } from '@daw-browser/timeline-core/types'
import {
  createAudioStretchCache,
  type StretchedAudioRender,
} from './audio-stretch-cache'
import type { AudioAssetRegistration, AudioAssetRelease } from './audio-asset-types'
import type { AudioStretchRuntimeClip } from './audio-stretch-rendering'
import type { PortableAssetRegistryEntry } from './portable-session-compiler'

export type PortableStretchDiagnosticCode =
  | 'stretch-realtime-unsupported'
  | 'warp-mode-unsupported'
  | 'stretch-prepared-asset-required'
  | 'stretch-render-cancelled'
  | 'stretch-render-failed'
  | 'stretch-invalid-sample-rate'
  | 'stretch-invalid-channel-count'
  | 'stretch-invalid-frame-count'
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
  ) => Promise<StretchedAudioRender>
}

const positiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0

const diagnostic = (
  clipId: string,
  code: PortableStretchDiagnosticCode,
  message: string,
): PortableStretchDiagnostic => ({ code, clipId, message })

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

const isAbortError = (error: unknown) => (
  error instanceof DOMException && error.name === 'AbortError'
) || (
  error instanceof Error && error.name === 'AbortError'
)

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
    if (!input.clip.buffer) {
      return {
        supported: false,
        diagnostics: [diagnostic(
          input.clip.id,
          'stretch-render-failed',
          `${input.clip.id}: Stretch preparation requires decoded source audio.`,
        )],
      }
    }
    const render = await input.renderStretch(input.clip, input.projectBpm)
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
        sourceDurationSec: input.clip.buffer.duration,
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
    return {
      supported: false,
      diagnostics: [diagnostic(
        input.clip.id,
        isAbortError(error) ? 'stretch-render-cancelled' : 'stretch-render-failed',
        isAbortError(error)
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
  createBuffer: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  signal?: AbortSignal
}): Promise<PortableStretchAssetPreparation> => {
  const cache = createAudioStretchCache({ createBuffer: input.createBuffer })
  const assets: PortablePreparedStretchAsset[] = []
  for (const track of input.tracks) {
    for (const clip of track.clips) {
      if (clip.midi || clip.audioWarp?.enabled !== true || clip.audioWarp.mode !== 'stretch') continue
      const prepared = await preparePortableStretchAsset({
        clip,
        projectBpm: input.projectBpm,
        projectGeneration: input.projectGeneration,
        signal: input.signal,
        renderStretch: cache.renderNow,
      })
      if (!prepared.supported) return prepared
      if (input.requiredSampleRateHz !== undefined
        && prepared.asset.asset.sampleRateHz !== input.requiredSampleRateHz) {
        return {
          supported: false,
          diagnostics: [diagnostic(
            clip.id,
            'stretch-invalid-sample-rate',
            `${clip.id}: pre-rendered Stretch audio must match the portable session sample rate.`,
          )],
        }
      }
      assets.push(prepared.asset)
    }
  }
  return { supported: true, assets }
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
    return {
      supported: false,
      diagnostics: [diagnostic(
        prepared.clipId,
        isAbortError(error) ? 'stretch-render-cancelled' : 'stretch-render-failed',
        isAbortError(error)
          ? `${prepared.clipId}: portable Stretch preparation was cancelled.`
          : `${prepared.clipId}: portable Stretch asset registration failed: ${error instanceof Error ? error.message : String(error)}`,
      )],
    }
  }
}
