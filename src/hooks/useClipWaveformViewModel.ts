import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import type { DecodeAudioPageSource, DecodedAudioPage } from '@daw-browser/audio-engine/media-pages'
import { selectWaveformLod } from '@daw-browser/waveforms/lod'
import { createPcmEnvelopeAccumulator } from '@daw-browser/waveforms/pcm-envelope'
import { getWaveformChannelSlice } from '@daw-browser/waveforms/select-waveform-window'
import type { WaveformPeakChannelSlice } from '@daw-browser/waveforms/types'
import { resolveClipSampleUrl } from '@daw-browser/shared'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import {
  arrangementWaveformPcmScheduler,
} from '~/lib/arrangement-waveform-pcm'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import { readLocalAssetBytes } from '~/lib/local-assets'
import {
  resolveSamplePlaybackUrlForRuntime,
} from '~/lib/renderer-api-url'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

type TimelineRange = {
  startSec: number
  endSec: number
}

type ClipWaveformViewModelOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  projectId?: Accessor<string | undefined>
  visibleRange?: Accessor<TimelineRange>
}

type SourceSegment = {
  drawStartPx: number
  drawCols: number
  timelineStartSec: number
  timelineEndSec: number
  sourceStartSec: number
  sourceEndSec: number
}

type WaveformRequestView = {
  assetKey?: string
  buffer: AudioBuffer | null
  clip: RuntimeClip
  sampleRate?: number
  channelCount?: number
  sampleUrl?: string
  segments: SourceSegment[]
  sourceAssetKey?: string
  sourceIdentity?: {
    assetKey: string
    durationSec: number
    sampleRate: number
    channelCount: number
  }
}

export type ClipWaveformPeakSegment = {
  drawStartPx: number
  drawCols: number
  peaks: WaveformPeakChannelSlice | null
}

const validRange = (range: TimelineRange | undefined): range is TimelineRange => Boolean(
  range
  && Number.isFinite(range.startSec)
  && Number.isFinite(range.endSec)
  && range.endSec > range.startSec,
)

const bufferPage = (buffer: AudioBuffer): DecodedAudioPage => ({
  startFrame: 0,
  frameCount: buffer.length,
  sampleRate: buffer.sampleRate,
  channelCount: buffer.numberOfChannels,
  planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
})

const visibleSegment = (
  clip: RuntimeClip,
  segment: SourceSegment,
  range: TimelineRange,
  cssWidthPx: number,
): SourceSegment | null => {
  const timelineStartSec = Math.max(segment.timelineStartSec, range.startSec)
  const timelineEndSec = Math.min(segment.timelineEndSec, range.endSec)
  if (timelineEndSec <= timelineStartSec) return null

  const segmentTimelineDuration = segment.timelineEndSec - segment.timelineStartSec
  const clipDuration = Math.max(0, clip.duration)
  if (!Number.isFinite(segmentTimelineDuration) || segmentTimelineDuration <= 0
    || !Number.isFinite(clipDuration) || clipDuration <= 0
    || !Number.isFinite(cssWidthPx) || cssWidthPx <= 0) return null

  const startFraction = (timelineStartSec - segment.timelineStartSec) / segmentTimelineDuration
  const endFraction = (timelineEndSec - segment.timelineStartSec) / segmentTimelineDuration
  const sourceDuration = segment.sourceEndSec - segment.sourceStartSec
  const pixelsPerSecond = cssWidthPx / clipDuration
  const drawStartPx = Math.max(0, Math.floor((timelineStartSec - clip.startSec) * pixelsPerSecond))
  const drawEndPx = Math.min(cssWidthPx, Math.ceil((timelineEndSec - clip.startSec) * pixelsPerSecond))
  if (drawEndPx <= drawStartPx) return null

  return {
    drawStartPx,
    drawCols: drawEndPx - drawStartPx,
    timelineStartSec,
    timelineEndSec,
    sourceStartSec: segment.sourceStartSec + sourceDuration * startFraction,
    sourceEndSec: segment.sourceStartSec + sourceDuration * endFraction,
  }
}

const resolvePcmSource = async (
  projectId: string | undefined,
  view: WaveformRequestView,
): Promise<DecodeAudioPageSource | null> => {
  if (projectId && view.sourceAssetKey) {
    const local = await readLocalAssetBytes(projectId, view.sourceAssetKey)
    if (local.status === 'ready') return local.file
  }
  return view.sampleUrl ?? null
}

const resolveBufferEnvelope = (
  buffer: AudioBuffer,
  segment: SourceSegment,
  channelCount: number,
): WaveformPeakChannelSlice | null => {
  if (buffer.numberOfChannels !== channelCount || !Number.isSafeInteger(buffer.sampleRate) || buffer.sampleRate <= 0) {
    return null
  }
  const startFrame = Math.floor(segment.sourceStartSec * buffer.sampleRate)
  const endFrame = Math.max(startFrame + 1, Math.ceil(segment.sourceEndSec * buffer.sampleRate))
  if (!Number.isSafeInteger(startFrame) || startFrame < 0
    || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) return null

  const accumulator = createPcmEnvelopeAccumulator({
    startFrame,
    endFrame,
    columns: segment.drawCols,
    channelCount,
  })
  accumulator.append(bufferPage(buffer))
  return accumulator.finish()
}

export function useClipWaveformViewModel(options: ClipWaveformViewModelOptions) {
  const [peakSegments, setPeakSegments] = createSignal<ClipWaveformPeakSegment[]>([])
  let requestId = 0

  const view = createMemo<WaveformRequestView>(() => {
    const clip = options.clip()
    const buffer = clip.buffer ?? null
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey
    const unresolvedSampleUrl = resolveClipSampleUrl(clip)
    const sampleUrl = unresolvedSampleUrl
      ? resolveSamplePlaybackUrlForRuntime(unresolvedSampleUrl) ?? undefined
      : undefined
    const cssWidthPx = options.cssWidthPx()
    const layout = getAudioWaveformLayout(clip, cssWidthPx, buffer?.duration, options.projectBpm())
    const metadata = getPersistableAudioSourceMetadata({
      buffer,
      sourceDurationSec: clip.sourceDurationSec,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannelCount: clip.sourceChannelCount,
    })
    const pixelsPerSecond = clip.duration > 0 ? cssWidthPx / clip.duration : 0
    const segments: SourceSegment[] = layout.segments ?? (layout.drawCols > 0 && pixelsPerSecond > 0
      ? [{
        drawStartPx: layout.padPx,
        drawCols: layout.drawCols,
        timelineStartSec: clip.startSec + layout.padPx / pixelsPerSecond,
        timelineEndSec: clip.startSec + (layout.padPx + layout.drawCols) / pixelsPerSecond,
        sourceStartSec: layout.sourceStartSec,
        sourceEndSec: layout.sourceEndSec,
      }]
      : [])

    return {
      assetKey,
      buffer,
      clip,
      sampleRate: metadata?.sampleRate,
      channelCount: metadata?.channelCount,
      sampleUrl,
      segments,
      sourceAssetKey: clip.sourceAssetKey,
      sourceIdentity: assetKey && metadata ? { assetKey, ...metadata } : undefined,
    }
  })

  createEffect(() => {
    const currentRequestId = ++requestId
    const current = view()
    const range = options.visibleRange?.()
    const projectId = options.projectId?.()
    const abortController = new AbortController()
    onCleanup(() => abortController.abort())

    if (current.clip.midi || current.segments.length === 0 || !current.assetKey || !validRange(range)) {
      setPeakSegments([])
      return
    }

    const sampleRate = current.sampleRate
    const channelCount = current.channelCount
    if (!Number.isSafeInteger(sampleRate) || !sampleRate || sampleRate <= 0
      || !Number.isSafeInteger(channelCount) || !channelCount || channelCount <= 0) {
      setPeakSegments([])
      return
    }

    const cssWidthPx = options.cssWidthPx()
    const visibleSegments = current.segments.flatMap((segment) => {
      const clipped = visibleSegment(current.clip, segment, range, cssWidthPx)
      return clipped ? [clipped] : []
    })
    if (visibleSegments.length === 0) {
      setPeakSegments([])
      return
    }

    setPeakSegments(visibleSegments.map((segment) => ({
      drawStartPx: segment.drawStartPx,
      drawCols: segment.drawCols,
      peaks: null,
    })))

    let sourcePromise: Promise<DecodeAudioPageSource | null> | undefined
    const source = () => {
      sourcePromise ??= resolvePcmSource(projectId, current)
      return sourcePromise
    }
    const visibleCenterSec = (range.startSec + range.endSec) / 2

    void Promise.all(visibleSegments.map(async (segment): Promise<ClipWaveformPeakSegment> => {
      const lod = selectWaveformLod({
        sampleRate,
        sourceStartSec: segment.sourceStartSec,
        sourceEndSec: segment.sourceEndSec,
        widthPx: segment.drawCols,
      })
      if (!lod) {
        return { drawStartPx: segment.drawStartPx, drawCols: segment.drawCols, peaks: null }
      }

      if (lod.mode === 'cached-peaks') {
        const cached = await getWaveformChannelSlice({
          assetKey: current.assetKey,
          sourceIdentity: current.sourceIdentity,
          sampleUrl: undefined,
          buffer: current.buffer,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          bins: segment.drawCols,
        })
        if (cached) {
          return { drawStartPx: segment.drawStartPx, drawCols: segment.drawCols, peaks: cached }
        }
      }

      const peaks = current.buffer
        ? resolveBufferEnvelope(current.buffer, segment, channelCount)
        : await arrangementWaveformPcmScheduler.request({
          assetKey: current.assetKey,
          source,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          columns: segment.drawCols,
          sampleRate,
          channelCount,
          priority: Math.abs((segment.timelineStartSec + segment.timelineEndSec) / 2 - visibleCenterSec),
          signal: abortController.signal,
        })

      return {
        drawStartPx: segment.drawStartPx,
        drawCols: segment.drawCols,
        peaks,
      }
    }))
      .then((next) => {
        if (currentRequestId !== requestId || abortController.signal.aborted) return
        setPeakSegments(next)
      })
      .catch(() => {
        if (currentRequestId !== requestId || abortController.signal.aborted) return
        setPeakSegments(visibleSegments.map((segment) => ({
          drawStartPx: segment.drawStartPx,
          drawCols: segment.drawCols,
          peaks: null,
        })))
      })
  })

  onCleanup(() => {
    requestId += 1
  })

  return {
    layout: () => getAudioWaveformLayout(
      view().clip,
      options.cssWidthPx(),
      view().buffer?.duration,
      options.projectBpm(),
    ),
    peakSegments,
  }
}
