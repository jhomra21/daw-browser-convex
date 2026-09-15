import { ARRANGEMENT_PCM_TILE_FRAMES } from '@daw-browser/waveforms/arrangement-waveform'
import { pointStartPixelsPerSample, selectWaveformTier, type WaveformTier } from '@daw-browser/waveforms/lod'
import { createWaveformRequestTierFrames } from '@daw-browser/waveforms/extract-peaks'
import type { WaveformSourceData } from '@daw-browser/waveforms/types'
import {
  cropWaveformDataToSourceRange,
  type AudioWaveformLayoutSegment,
  type CroppedWaveformData,
  type ProjectedWaveformData,
} from './audio-waveform-layout'
import type { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'

export type WaveformRequestPlan = {
  readonly key: string
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
  readonly framesPerInterval: number
  readonly priority: number
}

export type WaveformSegmentPlan = {
  readonly requestKey: string
  readonly tier: WaveformTier
  readonly segment: AudioWaveformLayoutSegment
}

export type WaveformRequestPlans = {
  readonly requests: readonly WaveformRequestPlan[]
  readonly segments: readonly WaveformSegmentPlan[]
}

export const waveformDataEndFrame = (data: WaveformSourceData) => (
  data.firstFrame + (
    data.kind === 'samples'
      ? data.channels[0]?.length ?? 0
      : data.intervalCount * data.framesPerInterval
  )
)

export const retainWaveformData = (data: WaveformSourceData): CroppedWaveformData => ({
  data,
  sourceStartFrame: data.firstFrame,
  sourceEndFrame: waveformDataEndFrame(data),
})

const quantizeRange = (
  start: number,
  end: number,
  sampleRate: number,
  sourceFrameCount: number,
) => {
  const startFrame = Math.max(0, Math.min(sourceFrameCount, Math.floor(start * sampleRate)))
  if (startFrame >= sourceFrameCount) return null
  const endFrame = Math.min(
    sourceFrameCount,
    Math.max(startFrame + 1, Math.ceil(end * sampleRate)),
  )
  if (endFrame <= startFrame) return null
  const firstTile = Math.floor(startFrame / ARRANGEMENT_PCM_TILE_FRAMES)
  const lastTile = Math.floor((endFrame - 1) / ARRANGEMENT_PCM_TILE_FRAMES)
  return {
    startFrame: firstTile * ARRANGEMENT_PCM_TILE_FRAMES,
    endFrame: Math.min(sourceFrameCount, (lastTile + 1) * ARRANGEMENT_PCM_TILE_FRAMES),
  }
}

const keyFor = (startFrame: number, endFrame: number, framesPerInterval: number) => (
  `${startFrame}:${endFrame}:${framesPerInterval}`
)

export const createWaveformRequestPlans = (input: {
  readonly segments: readonly AudioWaveformLayoutSegment[]
  readonly sampleRate: number
  readonly sourceDurationSec: number
  readonly sourceFrameCount: number
  readonly backingPixelsPerCssPixel?: number
  readonly priorityRange?: { startSec: number; endSec: number }
}): WaveformRequestPlans => {
  const sourceFrameCount = input.sourceFrameCount
  if (!Number.isSafeInteger(sourceFrameCount) || sourceFrameCount < 0) {
    return { requests: [], segments: [] }
  }
  if (sourceFrameCount <= 0) return { requests: [], segments: [] }
  const requests = new Map<string, WaveformRequestPlan>()
  const segments: WaveformSegmentPlan[] = []
  for (const segment of input.segments) {
    if (!Number.isFinite(segment.sourceStartSec) || !Number.isFinite(segment.sourceEndSec)) continue
    const sourceStartFrame = Math.max(
      0,
      Math.min(sourceFrameCount, Math.floor(segment.sourceStartSec * input.sampleRate)),
    )
    const sourceEndFrame = Math.min(
      sourceFrameCount,
      Math.max(sourceStartFrame + 1, Math.ceil(segment.sourceEndSec * input.sampleRate)),
    )
    const density = input.backingPixelsPerCssPixel ?? 1
    if (sourceStartFrame >= sourceEndFrame) continue
    const tiers = createWaveformRequestTierFrames(sourceFrameCount, input.sampleRate)
    const sourceFramesPerBackingPixel = (sourceEndFrame - sourceStartFrame)
      / (Math.max(1, segment.endPx - segment.startPx) * density)
    const tiersWithSamples = sourceFramesPerBackingPixel <= 1 / pointStartPixelsPerSample
      ? [1, ...tiers]
      : tiers
    const tier = selectWaveformTier({
      sourceFrameSpan: sourceEndFrame - sourceStartFrame,
      cssSegmentWidth: Math.max(1, segment.endPx - segment.startPx),
      backingPixelsPerCssPixel: density,
      tiers: tiersWithSamples,
    })
    if (!tier) continue
    const range = quantizeRange(
      segment.sourceStartSec,
      segment.sourceEndSec,
      input.sampleRate,
      sourceFrameCount,
    )
    if (!range) continue
    const key = keyFor(range.startFrame, range.endFrame, tier.framesPerInterval)
    const priorityCenter = input.priorityRange
      ? (input.priorityRange.startSec + input.priorityRange.endSec) / 2
      : (segment.canvasStartSec + segment.canvasEndSec) / 2
    const existing = requests.get(key)
    if (!existing) {
      requests.set(key, {
        key,
        sourceStartFrame: range.startFrame,
        sourceEndFrame: range.endFrame,
        framesPerInterval: tier.framesPerInterval,
        priority: Math.abs((segment.canvasStartSec + segment.canvasEndSec) / 2 - priorityCenter),
      })
    } else {
      requests.set(key, {
        ...existing,
        priority: Math.min(
          existing.priority,
          Math.abs((segment.canvasStartSec + segment.canvasEndSec) / 2 - priorityCenter),
        ),
      })
    }
    segments.push({ requestKey: key, tier, segment })
  }
  return { requests: [...requests.values()], segments }
}

export const projectRetainedWaveformData = (input: {
  readonly retainedByKey: ReadonlyMap<string, CroppedWaveformData>
  readonly segments: readonly WaveformSegmentPlan[]
  readonly map: ReturnType<typeof getAudioClipTimeMap>
}): ProjectedWaveformData[] => {
  if (!input.map) return []
  const coverage = [...input.retainedByKey.values()]
    .map((retained) => {
      const start = retained.data.firstFrame
      const end = waveformDataEndFrame(retained.data)
      return { retained, start, end, sampleRate: retained.data.sampleRate }
    })
    .sort((left, right) => left.start - right.start)
    .reduce<Array<{
      readonly retained: CroppedWaveformData
      readonly start: number
      readonly end: number
      readonly sampleRate: number
      readonly maxEnd: number
      readonly maxEndIndex: number
    }>>((entries, entry, index) => {
      const previous = entries[index - 1]
      const maxEnd = previous && previous.maxEnd >= entry.end ? previous.maxEnd : entry.end
      const maxEndIndex = previous && previous.maxEnd >= entry.end
        ? previous.maxEndIndex
        : index
      entries.push({ ...entry, maxEnd, maxEndIndex })
      return entries
    }, [])
  const findCoverage = (start: number, end: number) => {
    let upperBoundLow = 0
    let upperBoundHigh = coverage.length
    while (upperBoundLow < upperBoundHigh) {
      const middle = Math.floor((upperBoundLow + upperBoundHigh) / 2)
      if ((coverage[middle]?.start ?? 0) <= start) upperBoundLow = middle + 1
      else upperBoundHigh = middle
    }
    let low = 0
    let high = upperBoundLow
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if ((coverage[middle]?.maxEnd ?? -Infinity) >= end) high = middle
      else low = middle + 1
    }
    const candidate = coverage[low]
    const covering = candidate ? coverage[candidate.maxEndIndex] : undefined
    return covering && covering.start <= start && covering.end >= end ? covering.retained : undefined
  }
  const projected: ProjectedWaveformData[] = []
  for (const plan of input.segments) {
    const direct = input.retainedByKey.get(plan.requestKey)
    const retained = direct ?? findCoverage(
      Math.floor(plan.segment.sourceStartSec * (coverage[0]?.sampleRate ?? 1)),
      Math.ceil(plan.segment.sourceEndSec * (coverage[0]?.sampleRate ?? 1)),
    )
    if (!retained) continue
    const cropped = cropWaveformDataToSourceRange({
      data: retained.data,
      sourceStartSec: plan.segment.sourceStartSec,
      sourceEndSec: plan.segment.sourceEndSec,
    })
    if (!cropped) continue
    const sourceStartSec = cropped.sourceStartFrame / cropped.data.sampleRate
    const sourceEndSec = cropped.sourceEndFrame / cropped.data.sampleRate
    const timelineStartSec = Math.max(plan.segment.canvasStartSec, input.map.sourceToTimelineSec(sourceStartSec))
    const timelineEndSec = Math.min(plan.segment.canvasEndSec, input.map.sourceToTimelineSec(sourceEndSec))
    if (timelineEndSec <= timelineStartSec) continue
    const width = plan.segment.endPx - plan.segment.startPx
    const duration = Math.max(1e-9, plan.segment.canvasEndSec - plan.segment.canvasStartSec)
    projected.push({
      ...cropped,
      requestKey: plan.requestKey,
      startPx: plan.segment.startPx + (timelineStartSec - plan.segment.canvasStartSec) / duration * width,
      endPx: plan.segment.startPx + (timelineEndSec - plan.segment.canvasStartSec) / duration * width,
      canvasStartSec: timelineStartSec,
      canvasEndSec: timelineEndSec,
    })
  }
  return projected
}

export type { WaveformSourceData }
