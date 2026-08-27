import { normalizeClipGain } from '@daw-browser/shared'
import { audioCoreContractVersion, type AudioAssetRef, type AudioCoreSampleSourceEventDto } from '../../audio-core-contract/src/index'
import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { normalizeClipFades } from '@daw-browser/timeline-core/clip-fades'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { stableSourceIdentity } from './portable-clip-projector'

export type PortableMediaPage = {
  sourceAssetId: string
  sourceStartFrame: number
  asset: AudioAssetRef
}

export type PortableMediaPageProjectInput = {
  tracks: readonly Track[]
  pagesBySourceAssetId: ReadonlyMap<string, readonly PortableMediaPage[]>
  bpm: number
  sampleRateHz: number
  rangeStartSec: number
  rangeEndSec: number
  epoch: number
  firstSequence: number
  includeStableIdentity?: boolean
}

export type PortableMediaPageProjection =
  | {
    supported: true
    events: readonly AudioCoreSampleSourceEventDto[]
    handledClipIds: ReadonlySet<string>
  }
  | {
    supported: false
    reasons: readonly string[]
    handledClipIds: ReadonlySet<string>
  }

const frameAt = (seconds: number, sampleRateHz: number) => Math.round(seconds * sampleRateHz)
const finitePositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0
const sourceFrameEpsilon = 1e-6

const clipSourceMetadata = (clip: Clip) => {
  if (!clip.sourceAssetKey
    || !Number.isFinite(clip.sourceDurationSec) || (clip.sourceDurationSec ?? 0) <= 0
    || !finitePositiveInteger(clip.sourceSampleRate ?? 0)
    || !finitePositiveInteger(clip.sourceChannelCount ?? 0)) return undefined
  return {
    sourceAssetKey: clip.sourceAssetKey,
    durationSec: clip.sourceDurationSec!,
    sampleRateHz: clip.sourceSampleRate!,
    channelCount: clip.sourceChannelCount!,
  }
}

const pageReason = (clip: Clip, reason: string) => `${clip.id}: ${reason}`

const projectClipPages = (input: {
  clip: Clip
  trackId: string
  pages: readonly PortableMediaPage[]
  bpm: number
  sampleRateHz: number
  rangeStartSec: number
  rangeEndSec: number
  epoch: number
  firstSequence: number
  includeStableIdentity: boolean
}): { events?: AudioCoreSampleSourceEventDto[]; reason?: string } => {
  const metadata = clipSourceMetadata(input.clip)
  if (!metadata) return { reason: pageReason(input.clip, 'persisted source metadata is required for paged playback.') }
  if (input.clip.audioWarp?.enabled === true) {
    return { reason: pageReason(input.clip, 'paged playback does not yet support warped audio.') }
  }
  const map = getAudioClipTimeMap({
    clip: input.clip,
    bufferDurationSec: metadata.durationSec,
    projectBpm: input.bpm,
    rangeStartSec: input.rangeStartSec,
    rangeEndSec: input.rangeEndSec,
  })
  if (!map) return { events: [] }
  if (map.mode !== 'raw') return { reason: pageReason(input.clip, 'paged playback requires raw source timing.') }

  const orderedPages = [...input.pages].sort((left, right) => left.sourceStartFrame - right.sourceStartFrame)
  if (orderedPages.length === 0) return { reason: pageReason(input.clip, 'requested source pages are not prepared.') }
  for (const page of orderedPages) {
    if (page.sourceAssetId !== metadata.sourceAssetKey
      || !Number.isSafeInteger(page.sourceStartFrame) || page.sourceStartFrame < 0
      || page.asset.sampleRateHz !== metadata.sampleRateHz
      || page.asset.channelCount !== metadata.channelCount
      || !finitePositiveInteger(page.asset.frameCount)) {
      return { reason: pageReason(input.clip, 'prepared source page metadata is inconsistent.') }
    }
  }

  const sourceStartPosition = map.sourceStartSec * metadata.sampleRateHz
  const sourceEndPosition = map.sourceEndSec * metadata.sampleRateHz
  if (!(sourceEndPosition > sourceStartPosition)) return { events: [] }

  const fades = normalizeClipFades(input.clip.fades, input.clip.duration)
  const events: AudioCoreSampleSourceEventDto[] = []
  let coveredThrough = sourceStartPosition
  for (const page of orderedPages) {
    const pageStart = page.sourceStartFrame
    const pageEnd = pageStart + page.asset.frameCount
    if (pageEnd <= sourceStartPosition + sourceFrameEpsilon) continue
    if (pageStart >= sourceEndPosition - sourceFrameEpsilon) break
    if (pageStart > coveredThrough + sourceFrameEpsilon) {
      return { reason: pageReason(input.clip, `prepared source pages contain a gap at source frame ${Math.floor(coveredThrough)}.`) }
    }

    const overlapStart = Math.max(sourceStartPosition, coveredThrough, pageStart)
    const overlapEnd = Math.min(sourceEndPosition, pageEnd)
    if (overlapEnd <= overlapStart + sourceFrameEpsilon) continue

    const timelineStartSec = map.sourceToTimelineSec(overlapStart / metadata.sampleRateHz)
    const timelineEndSec = map.sourceToTimelineSec(overlapEnd / metadata.sampleRateHz)
    const startFrame = frameAt(timelineStartSec, input.sampleRateHz)
    const stopFrame = frameAt(timelineEndSec, input.sampleRateHz)
    if (stopFrame <= startFrame) {
      coveredThrough = Math.max(coveredThrough, overlapEnd)
      continue
    }

    const pagePosition = overlapStart - pageStart
    const sourceOffsetFrame = Math.floor(pagePosition)
    const sourceOffsetFraction = pagePosition - sourceOffsetFrame
    const sourceFrameCount = Math.min(
      page.asset.frameCount - sourceOffsetFrame,
      Math.max(1, Math.ceil(overlapEnd - overlapStart)),
    )
    if (sourceFrameCount <= 0) continue

    events.push({
      version: audioCoreContractVersion,
      epoch: input.epoch,
      sequence: input.firstSequence + events.length,
      sourceNodeId: input.trackId,
      assetId: page.asset.assetId,
      startFrame,
      stopFrame,
      sourceOffsetFrame,
      sourceOffsetFraction: sourceOffsetFraction === 0 ? undefined : sourceOffsetFraction,
      sourceFrameCount,
      gain: normalizeClipGain(input.clip.gain ?? 1),
      fadeInStartFrame: frameAt(input.clip.startSec + fades.fadeInStartSec, input.sampleRateHz),
      fadeInEndFrame: frameAt(input.clip.startSec + fades.fadeInSec, input.sampleRateHz),
      fadeOutStartFrame: frameAt(input.clip.startSec + input.clip.duration - fades.fadeOutSec, input.sampleRateHz),
      fadeOutEndFrame: frameAt(input.clip.startSec + input.clip.duration - fades.fadeOutEndSec, input.sampleRateHz),
      fadeInCurve: fades.fadeInCurve === 0 ? undefined : fades.fadeInCurve,
      fadeInCurvePosition: fades.fadeInCurve === 0 ? undefined : fades.fadeInCurvePosition,
      fadeOutCurve: fades.fadeOutCurve === 0 ? undefined : fades.fadeOutCurve,
      fadeOutCurvePosition: fades.fadeOutCurve === 0 ? undefined : fades.fadeOutCurvePosition,
      sourceIdentity: input.includeStableIdentity
        ? `${stableSourceIdentity(input.trackId, input.clip.id)}:page:${page.sourceStartFrame}`
        : undefined,
    })
    coveredThrough = Math.max(coveredThrough, overlapEnd)
    if (coveredThrough >= sourceEndPosition - sourceFrameEpsilon) break
  }

  if (coveredThrough < sourceEndPosition - sourceFrameEpsilon) {
    return { reason: pageReason(input.clip, `prepared source pages end before source frame ${Math.ceil(sourceEndPosition)}.`) }
  }
  return { events }
}

export const projectPortableMediaPageEvents = (
  input: PortableMediaPageProjectInput,
): PortableMediaPageProjection => {
  const handledClipIds = new Set<string>()
  const reasons: string[] = []
  const events: AudioCoreSampleSourceEventDto[] = []
  if (!finitePositiveInteger(input.sampleRateHz)) {
    return { supported: false, reasons: ['The portable sample rate is invalid.'], handledClipIds }
  }
  if (!finitePositiveInteger(input.epoch) || !finitePositiveInteger(input.firstSequence)) {
    return { supported: false, reasons: ['The portable transport epoch or event sequence is invalid.'], handledClipIds }
  }
  if (!Number.isFinite(input.bpm) || input.bpm <= 0
    || !Number.isFinite(input.rangeStartSec)
    || !Number.isFinite(input.rangeEndSec)
    || input.rangeEndSec <= input.rangeStartSec) {
    return { supported: false, reasons: ['The paged media scheduling range is invalid.'], handledClipIds }
  }

  for (const track of input.tracks) {
    if (track.kind === 'instrument') continue
    for (const clip of track.clips) {
      if (clip.midi || !clip.sourceAssetKey) continue
      const pages = input.pagesBySourceAssetId.get(clip.sourceAssetKey)
      if (!pages) continue
      handledClipIds.add(clip.id)
      const projected = projectClipPages({
        clip,
        trackId: track.id,
        pages,
        bpm: input.bpm,
        sampleRateHz: input.sampleRateHz,
        rangeStartSec: input.rangeStartSec,
        rangeEndSec: input.rangeEndSec,
        epoch: input.epoch,
        firstSequence: input.firstSequence + events.length,
        includeStableIdentity: input.includeStableIdentity === true,
      })
      if (projected.reason) reasons.push(projected.reason)
      else if (projected.events) events.push(...projected.events)
    }
  }

  return reasons.length > 0
    ? { supported: false, reasons, handledClipIds }
    : { supported: true, events, handledClipIds }
}
