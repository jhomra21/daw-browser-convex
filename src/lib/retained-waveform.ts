import { ARRANGEMENT_PCM_TILE_FRAMES } from '@daw-browser/waveforms/arrangement-waveform-pcm'
import { selectWaveformLod, type WaveformLod } from '@daw-browser/waveforms/lod'
import {
  cropWaveformDataToSourceRange,
  type AudioWaveformLayoutSegment,
  type CroppedWaveformData,
  type ProjectedWaveformData,
} from './audio-waveform-layout'
import type { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { MAX_WAVEFORM_RASTER_WIDTH_PX } from './waveform-canvas'

export const MAX_WAVEFORM_DENSITY_BUCKET = 4_096
const WAVEFORM_DENSITY_BUCKET_FACTOR = 1.5

export type WaveformRequestPlan = {
  key: string
  sourceStartSec: number
  sourceEndSec: number
  lod: WaveformLod
  bins: number
  exactRange: boolean
}

export type WaveformSegmentPlan = {
  requestKey: string
  segment: AudioWaveformLayoutSegment
}

export const projectRetainedWaveformData = (input: {
  retainedByKey: ReadonlyMap<string, CroppedWaveformData>
  segments: readonly WaveformSegmentPlan[]
  map: ReturnType<typeof getAudioClipTimeMap>
}): ProjectedWaveformData[] => {
  if (!input.map) return []
  const projected: ProjectedWaveformData[] = []
  for (const plan of input.segments) {
    const retained = input.retainedByKey.get(plan.requestKey)
    if (!retained) continue
    const segment = plan.segment
    const overlapStart = Math.max(segment.sourceStartSec, retained.sourceStartSec)
    const overlapEnd = Math.min(segment.sourceEndSec, retained.sourceEndSec)
    const cropped = cropWaveformDataToSourceRange({
      data: retained.data,
      sourceStartSec: overlapStart,
      sourceEndSec: overlapEnd,
    })
    if (!cropped) continue
    const timelineStartSec = Math.max(
      segment.canvasStartSec,
      input.map.sourceToTimelineSec(cropped.sourceStartSec),
    )
    const timelineEndSec = Math.min(
      segment.canvasEndSec,
      input.map.sourceToTimelineSec(cropped.sourceEndSec),
    )
    if (timelineEndSec <= timelineStartSec) continue
    const segmentTimelineDuration = Math.max(1e-9, segment.canvasEndSec - segment.canvasStartSec)
    const segmentWidth = segment.endPx - segment.startPx
    const startPx = segment.startPx
      + ((timelineStartSec - segment.canvasStartSec) / segmentTimelineDuration) * segmentWidth
    const endPx = segment.startPx
      + ((timelineEndSec - segment.canvasStartSec) / segmentTimelineDuration) * segmentWidth
    projected.push({
      ...cropped,
      requestKey: plan.requestKey,
      startPx,
      endPx,
      canvasStartSec: timelineStartSec,
      canvasEndSec: timelineEndSec,
    })
  }
  return projected
}

export type WaveformRequestPlans = {
  requests: readonly WaveformRequestPlan[]
  segments: readonly WaveformSegmentPlan[]
}

type RetainedRasterCanonicalSegment = Pick<
  AudioWaveformLayoutSegment,
  'sourceStartSec' | 'sourceEndSec' | 'canvasStartSec' | 'canvasEndSec'
>

const createRetainedCoverageSegments = (input: {
  plan: WaveformRequestPlans
  map: NonNullable<ReturnType<typeof getAudioClipTimeMap>>
  coverageByKey: ReadonlyMap<string, {
    sourceStartSec: number
    sourceEndSec: number
  }>
  canonicalSegments: readonly RetainedRasterCanonicalSegment[]
}) => {
  const seenKeys = new Set<string>()
  return input.plan.segments.flatMap((item) => {
    if (seenKeys.has(item.requestKey)) return []
    seenKeys.add(item.requestKey)
    const coverage = input.coverageByKey.get(item.requestKey)
    if (!coverage) return [item]
    return input.canonicalSegments.flatMap((canonical) => {
      const sourceStartSec = Math.max(coverage.sourceStartSec, canonical.sourceStartSec)
      const sourceEndSec = Math.min(coverage.sourceEndSec, canonical.sourceEndSec)
      if (sourceEndSec <= sourceStartSec) return []
      const canvasStartSec = input.map.sourceToTimelineSec(sourceStartSec)
      const canvasEndSec = input.map.sourceToTimelineSec(sourceEndSec)
      if (canvasEndSec <= canvasStartSec) return []
      return [{
        requestKey: item.requestKey,
        segment: {
          drawCols: 1,
          sourceStartSec,
          sourceEndSec,
          startPx: 0,
          endPx: 0,
          canvasStartSec,
          canvasEndSec,
        },
      }]
    })
  })
}

export const createRetainedRasterLayout = (input: {
  plan: WaveformRequestPlans
  map: ReturnType<typeof getAudioClipTimeMap>
  pixelsPerSecond: number
  coverageByKey?: ReadonlyMap<string, {
    sourceStartSec: number
    sourceEndSec: number
  }>
  canonicalSegments?: readonly RetainedRasterCanonicalSegment[]
}) => {
  if (!input.map || input.plan.segments.length === 0) return null
  const canonicalSegments = input.canonicalSegments ?? input.plan.segments.map((item) => ({
    sourceStartSec: item.segment.sourceStartSec,
    sourceEndSec: item.segment.sourceEndSec,
    canvasStartSec: input.map?.sourceToTimelineSec(item.segment.sourceStartSec) ?? 0,
    canvasEndSec: input.map?.sourceToTimelineSec(item.segment.sourceEndSec) ?? 0,
  }))
  const coverageSegments = input.coverageByKey
    ? createRetainedCoverageSegments({
      plan: input.plan,
      map: input.map,
      coverageByKey: input.coverageByKey,
      canonicalSegments,
    })
    : input.plan.segments
  if (coverageSegments.length === 0) return null
  const timelineStartSec = Math.min(
    ...coverageSegments.map((item) => item.segment.canvasStartSec),
  )
  const timelineEndSec = Math.max(
    ...coverageSegments.map((item) => item.segment.canvasEndSec),
  )
  if (timelineEndSec <= timelineStartSec) return null
  const boundedPixelsPerSecond = Math.min(
    input.pixelsPerSecond,
    MAX_WAVEFORM_RASTER_WIDTH_PX / Math.max(1e-6, timelineEndSec - timelineStartSec),
  )
  return {
    timelineStartSec,
    timelineEndSec,
    pixelsPerSecond: boundedPixelsPerSecond,
    segments: coverageSegments.map((item) => {
      const canvasStartSec = item.segment.canvasStartSec
      const canvasEndSec = item.segment.canvasEndSec
      return {
        requestKey: item.requestKey,
        segment: {
          ...item.segment,
          canvasStartSec,
          canvasEndSec,
          startPx: (canvasStartSec - timelineStartSec) * boundedPixelsPerSecond,
          endPx: (canvasEndSec - timelineStartSec) * boundedPixelsPerSecond,
          drawCols: Math.max(1, Math.ceil((canvasEndSec - canvasStartSec) * boundedPixelsPerSecond)),
        },
      }
    }),
  }
}

const quantizeRequestRange = (input: {
  startSec: number
  endSec: number
  sampleRate: number
  sourceDurationSec: number
}) => {
  const startFrame = Math.max(0, Math.floor(input.startSec * input.sampleRate))
  const endFrame = Math.min(
    Math.ceil(input.sourceDurationSec * input.sampleRate),
    Math.ceil(input.endSec * input.sampleRate),
  )
  const firstTile = Math.floor(startFrame / ARRANGEMENT_PCM_TILE_FRAMES)
  const lastTile = Math.max(
    firstTile,
    Math.floor(Math.max(startFrame, endFrame - 1) / ARRANGEMENT_PCM_TILE_FRAMES),
  )
  return {
    sourceStartSec: firstTile * ARRANGEMENT_PCM_TILE_FRAMES / input.sampleRate,
    sourceEndSec: Math.min(
      input.sourceDurationSec,
      (lastTile + 1) * ARRANGEMENT_PCM_TILE_FRAMES / input.sampleRate,
    ),
  }
}

export const densityBucketFor = (requestedBins: number, currentBucket = 0) => {
  const bounded = Math.max(1, Math.min(MAX_WAVEFORM_DENSITY_BUCKET, Math.ceil(requestedBins)))
  if (currentBucket > 0) {
    if (bounded < currentBucket * WAVEFORM_DENSITY_BUCKET_FACTOR
      && bounded > currentBucket / WAVEFORM_DENSITY_BUCKET_FACTOR) return currentBucket
    if (bounded >= currentBucket) {
      return bounded
    }
    return bounded
  }
  return bounded
}

const requestKeyFor = (input: {
  sourceStartSec: number
  sourceEndSec: number
  lod: WaveformLod
  bins: number
  exactRange: boolean
  densityBucket: number
}) => [
  input.sourceStartSec,
  input.sourceEndSec,
  input.lod.mode,
  input.exactRange ? 'exact' : 'tile',
  input.bins,
  input.densityBucket,
].join(':')

const lodRank = (lod: WaveformLod) => (
  lod.mode === 'cached-peaks' ? 0 : lod.mode === 'pcm-envelope' ? 1 : 2
)

export const createWaveformRequestPlans = (input: {
  segments: readonly AudioWaveformLayoutSegment[]
  sampleRate: number
  sourceDurationSec: number
  sampleDetail: boolean
  densityBucket?: number
}): WaveformRequestPlans => {
  if (input.segments.length === 0) return { requests: [], segments: [] }
  const densityBucket = input.densityBucket ?? densityBucketFor(
    Math.max(...input.segments.map((segment) => segment.drawCols)),
  )
  const candidatesByRange = new Map<string, {
    sourceStartSec: number
    sourceEndSec: number
    lod: WaveformLod
    bins: number
    exactRange: boolean
  }>()
  const segmentRanges: Array<{ rangeKey: string; segment: AudioWaveformLayoutSegment }> = []

  for (const segment of input.segments) {
    const lod = selectWaveformLod({
      sampleRate: input.sampleRate,
      sourceStartSec: segment.sourceStartSec,
      sourceEndSec: segment.sourceEndSec,
      widthPx: segment.drawCols,
    })
    if (!lod) continue
    const range = input.sampleDetail
      ? {
        sourceStartSec: Math.max(0, segment.sourceStartSec),
        sourceEndSec: Math.min(input.sourceDurationSec, segment.sourceEndSec),
      }
      : quantizeRequestRange({
        startSec: segment.sourceStartSec,
        endSec: segment.sourceEndSec,
        sampleRate: input.sampleRate,
        sourceDurationSec: input.sourceDurationSec,
      })
    if (range.sourceEndSec <= range.sourceStartSec) continue
    const exactRange = input.sampleDetail
    const bins = exactRange
      ? Math.max(1, segment.drawCols)
      : Math.max(
        1,
        lod.mode === 'cached-peaks'
          ? Math.min(
            densityBucket,
            Math.ceil((range.sourceEndSec - range.sourceStartSec) * 400),
          )
          : densityBucket,
      )
    const densityKey = exactRange || lod.mode === 'cached-peaks' ? bins : densityBucket
    const rangeKey = [
      range.sourceStartSec,
      range.sourceEndSec,
      exactRange ? 'exact' : 'tile',
      densityKey,
    ].join(':')
    const existing = candidatesByRange.get(rangeKey)
    if (!existing) {
      candidatesByRange.set(rangeKey, {
        sourceStartSec: range.sourceStartSec,
        sourceEndSec: range.sourceEndSec,
        lod,
        bins,
        exactRange,
      })
    } else {
      if (lodRank(lod) > lodRank(existing.lod)) existing.lod = lod
      existing.bins = Math.max(existing.bins, bins)
    }
    segmentRanges.push({ rangeKey, segment })
  }

  const requestsByKey = new Map<string, WaveformRequestPlan>()
  const keyByRange = new Map<string, string>()
  for (const [rangeKey, candidate] of candidatesByRange) {
    const key = requestKeyFor({
      ...candidate,
      densityBucket: candidate.exactRange || candidate.lod.mode === 'cached-peaks'
        ? candidate.bins
        : densityBucket,
    })
    keyByRange.set(rangeKey, key)
    requestsByKey.set(key, {
      key,
      sourceStartSec: candidate.sourceStartSec,
      sourceEndSec: candidate.sourceEndSec,
      lod: candidate.lod,
      bins: candidate.bins,
      exactRange: candidate.exactRange,
    })
  }

  return {
    requests: [...requestsByKey.values()],
    segments: segmentRanges.flatMap(({ rangeKey, segment }) => {
      const requestKey = keyByRange.get(rangeKey)
      return requestKey ? [{ requestKey, segment }] : []
    }),
  }
}
