import { normalizeClipGain } from '@daw-browser/shared'
import type { AudioAssetRef, AudioCoreSampleSourceEventDto } from '../../audio-core-contract/src/index'
import { audioCoreContractVersion } from '../../audio-core-contract/src/index'
import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { normalizeClipFades } from '@daw-browser/timeline-core/clip-fades'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import {
  validatePortablePreparedStretchAsset,
  type PortablePreparedStretchAsset,
  type PortableStretchDiagnostic,
} from './portable-stretch-preparation'

export type PortableClipProject = {
  tracks: readonly Track[]
  assets: ReadonlyMap<string, AudioAssetRef>
  preparedStretchAssets?: ReadonlyMap<string, PortablePreparedStretchAsset>
  projectGeneration?: number
  warpContext?: 'realtime' | 'offline'
  bpm: number
  sampleRateHz: number
  rangeStartSec: number
  rangeEndSec?: number
  emitStartFrame?: { start: number; end: number }
  epoch: number
  firstSequence: number
  allowInstruments?: boolean
  includeStableIdentity?: boolean
}

export type PortableProjectedSourceEvent = AudioCoreSampleSourceEventDto & {
  sourceIdentity?: string
}

export type PortableClipProjection =
  | { supported: true; events: readonly PortableProjectedSourceEvent[] }
  | {
    supported: false
    reasons: readonly string[]
    diagnostics: readonly PortableStretchDiagnostic[]
  }

const frameAt = (seconds: number, sampleRateHz: number) => Math.round(seconds * sampleRateHz)

const finitePositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0

const unsupported = (
  reasons: string[],
  diagnostics: readonly PortableStretchDiagnostic[] = [],
): PortableClipProjection => ({
  supported: false,
  reasons,
  diagnostics,
})

const stretchDiagnostic = (
  clipId: string,
  code: PortableStretchDiagnostic['code'],
  message: string,
): PortableStretchDiagnostic => ({ code, clipId, message })

const projectClip = (
  clip: Clip,
  input: PortableClipProject,
  sequence: number,
  sourceNodeId: string,
): {
  event: PortableProjectedSourceEvent
} | {
  reason: string
  diagnostic?: PortableStretchDiagnostic
} => {
  if (clip.midi) return { reason: `${clip.id}: MIDI clips are not supported.` }
  const preparedStretch = clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch'
    ? input.preparedStretchAssets?.get(clip.id)
    : undefined
  if (clip.audioWarp?.enabled === true && clip.audioWarp.mode !== 'stretch') {
    const message = input.warpContext === 'offline'
      ? `${clip.id}: ${clip.audioWarp.mode} warp is not supported by portable export.`
      : `${clip.id}: realtime ${clip.audioWarp.mode} warp is not supported by the portable core.`
    return {
      reason: message,
      diagnostic: stretchDiagnostic(clip.id, 'warp-mode-unsupported', message),
    }
  }
  if (clip.audioWarp?.enabled === true && !preparedStretch) {
    const realtime = input.warpContext !== 'offline'
    const message = realtime
      ? `${clip.id}: realtime Stretch warp is not supported by the portable core.`
      : `${clip.id}: portable export requires a pre-rendered Stretch asset.`
    return {
      reason: message,
      diagnostic: stretchDiagnostic(
        clip.id,
        realtime ? 'stretch-realtime-unsupported' : 'stretch-prepared-asset-required',
        message,
      ),
    }
  }
  if (!clip.sourceAssetKey && !preparedStretch) {
    return { reason: `${clip.id}: no decoded source asset is available.` }
  }
  if (preparedStretch) {
    const invalid = validatePortablePreparedStretchAsset(preparedStretch)
    if (invalid) return { reason: invalid.message, diagnostic: invalid }
  }
  if (preparedStretch
    && input.projectGeneration !== undefined
    && preparedStretch.projectGeneration !== input.projectGeneration) {
    const message = `${clip.id}: pre-rendered Stretch asset belongs to a stale project generation.`
    return {
      reason: message,
      diagnostic: stretchDiagnostic(clip.id, 'stretch-asset-stale-generation', message),
    }
  }
  if (preparedStretch && preparedStretch.asset.sampleRateHz !== input.sampleRateHz) {
    const message = `${clip.id}: pre-rendered Stretch audio must match the portable session sample rate.`
    return {
      reason: message,
      diagnostic: stretchDiagnostic(clip.id, 'stretch-invalid-sample-rate', message),
    }
  }
  const asset = preparedStretch?.asset ?? (
    clip.sourceAssetKey ? input.assets.get(clip.sourceAssetKey) : undefined
  )
  if (!asset) return { reason: `${clip.id}: source asset is not registered.` }
  if (asset.channelCount > 2) return { reason: `${clip.id}: only mono and stereo assets are supported.` }
  const fades = normalizeClipFades(clip.fades, clip.duration)
  const map = getAudioClipTimeMap({
    clip,
    bufferDurationSec: preparedStretch?.sourceDurationSec ?? asset.frameCount / asset.sampleRateHz,
    projectBpm: input.bpm,
    rangeStartSec: input.rangeStartSec,
    rangeEndSec: input.rangeEndSec,
  })
  if (!map) return { reason: `${clip.id}: has no playable audio in the requested range.` }
  if (map.mode !== 'raw' && !preparedStretch) return { reason: `${clip.id}: non-raw playback is not supported.` }
  const sourceOffsetSec = preparedStretch === undefined
    ? map.sourceStartSec
    : map.timelineStartSec - preparedStretch.timelineStartSec + preparedStretch.sourceStartSec
  if (preparedStretch) {
    const preparedEndSec = preparedStretch.timelineStartSec + preparedStretch.timelineDurationSec
    if (sourceOffsetSec < -0.5 / asset.sampleRateHz
      || map.timelineEndSec > preparedEndSec + 0.5 / asset.sampleRateHz) {
      const message = `${clip.id}: pre-rendered Stretch timing does not cover the requested schedule.`
      return {
        reason: message,
        diagnostic: stretchDiagnostic(clip.id, 'stretch-metadata-mismatch', message),
      }
    }
  }
  const sourcePosition = Math.max(0, sourceOffsetSec * asset.sampleRateHz)
  const sourceOffsetFrame = Math.floor(sourcePosition)
  const sourceOffsetFraction = sourcePosition - sourceOffsetFrame
  const sourceFrameCount = Math.min(
    asset.frameCount - sourceOffsetFrame,
    Math.max(0, Math.ceil(
      (preparedStretch ? map.timelineDurationSec : map.sourceDurationSec) * asset.sampleRateHz,
    )),
  )
  const startFrame = frameAt(map.timelineStartSec, input.sampleRateHz)
  const stopFrame = frameAt(map.timelineEndSec, input.sampleRateHz)
  if (sourceFrameCount < 1 || stopFrame <= startFrame) return { reason: `${clip.id}: resolves to an empty sample range.` }
  return {
    event: {
      version: audioCoreContractVersion,
      epoch: input.epoch,
      sequence,
      sourceNodeId,
      ...(input.includeStableIdentity
        ? { sourceIdentity: stableSourceIdentity(sourceNodeId, clip.id) }
        : {}),
      assetId: asset.assetId,
      startFrame,
      stopFrame,
      sourceOffsetFrame,
      ...(sourceOffsetFraction === 0 ? {} : { sourceOffsetFraction }),
      sourceFrameCount,
      gain: normalizeClipGain(clip.gain ?? 1),
      fadeInStartFrame: frameAt(clip.startSec + fades.fadeInStartSec, input.sampleRateHz),
      fadeInEndFrame: frameAt(clip.startSec + fades.fadeInSec, input.sampleRateHz),
      fadeOutStartFrame: frameAt(clip.startSec + clip.duration - fades.fadeOutSec, input.sampleRateHz),
      fadeOutEndFrame: frameAt(clip.startSec + clip.duration - fades.fadeOutEndSec, input.sampleRateHz),
      ...(fades.fadeInCurve === 0 ? {} : {
        fadeInCurve: fades.fadeInCurve,
        fadeInCurvePosition: fades.fadeInCurvePosition,
      }),
      ...(fades.fadeOutCurve === 0 ? {} : {
        fadeOutCurve: fades.fadeOutCurve,
        fadeOutCurvePosition: fades.fadeOutCurvePosition,
      }),
    },
  }
}

export const stableSourceIdentity = (trackId: string, clipId: string) =>
  `source:${trackId.length}:${trackId}:${clipId.length}:${clipId}`

export const projectPortableClipEvents = (input: PortableClipProject): PortableClipProjection => {
  if (!finitePositiveInteger(input.sampleRateHz)) return unsupported(['The portable sample rate is invalid.'])
  if (!finitePositiveInteger(input.epoch) || !finitePositiveInteger(input.firstSequence)) return unsupported(['The portable transport epoch or event sequence is invalid.'])
  if (!Number.isFinite(input.bpm) || input.bpm <= 0) return unsupported(['The project tempo is invalid.'])
  if (!Number.isFinite(input.rangeStartSec) || (input.rangeEndSec !== undefined && (!Number.isFinite(input.rangeEndSec) || input.rangeEndSec <= input.rangeStartSec))) {
    return unsupported(['The portable scheduling range is invalid.'])
  }
  const reasons: string[] = []
  const diagnostics: PortableStretchDiagnostic[] = []
  const events: AudioCoreSampleSourceEventDto[] = []
  let sequence = input.firstSequence
  for (const track of input.tracks) {
    if (track.kind === 'instrument') {
      if (!input.allowInstruments) reasons.push(`${track.id}: instrument tracks are not supported.`)
      continue
    }
    for (const clip of track.clips) {
      const result = projectClip(clip, input, sequence, track.id)
      if ('reason' in result) {
        reasons.push(result.reason)
        if (result.diagnostic) diagnostics.push(result.diagnostic)
      }
      else {
        const emitRange = input.emitStartFrame
        if (emitRange === undefined) {
          events.push(result.event)
          sequence += 1
        } else if (result.event.startFrame >= emitRange.start && result.event.startFrame < emitRange.end) {
          events.push(result.event)
          sequence += 1
        } else if (result.event.startFrame < emitRange.start && result.event.stopFrame > emitRange.start) {
          const timelineFrames = result.event.stopFrame - result.event.startFrame
          const elapsedFrames = emitRange.start - result.event.startFrame
          const sourceOffsetDelta = Math.min(
            result.event.sourceFrameCount,
            Math.max(0, result.event.sourceFrameCount * elapsedFrames / timelineFrames),
          )
          const sourcePosition = result.event.sourceOffsetFrame
            + (result.event.sourceOffsetFraction ?? 0)
            + sourceOffsetDelta
          const sourceOffsetFrame = Math.floor(sourcePosition)
          const sourceOffsetFraction = sourcePosition - sourceOffsetFrame
          const sourceEndPosition = result.event.sourceOffsetFrame
            + (result.event.sourceOffsetFraction ?? 0)
            + result.event.sourceFrameCount
          const sourceFrameCount = Math.ceil(sourceEndPosition - sourcePosition)
          if (sourceFrameCount > 0) {
            events.push({
              ...result.event,
              startFrame: emitRange.start,
              sourceOffsetFrame,
              sourceOffsetFraction,
              sourceFrameCount,
            })
            sequence += 1
          }
        }
      }
    }
  }
  return reasons.length === 0 ? { supported: true, events } : unsupported(reasons, diagnostics)
}
