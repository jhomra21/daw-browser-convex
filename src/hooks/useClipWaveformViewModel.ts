import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import type { DecodeAudioPageSource, DecodedAudioPage } from '@daw-browser/audio-engine/media-pages'
import { createPcmEnvelopeAccumulator } from '@daw-browser/waveforms/pcm-envelope'
import { getWaveformChannelSlice } from '@daw-browser/waveforms/select-waveform-window'
import type { WaveformPeakChannelSlice } from '@daw-browser/waveforms/types'
import { isLocalId, resolveClipSampleUrl } from '@daw-browser/shared'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import {
  getArrangementWaveformVisibleSegments,
  selectArrangementWaveformRoute,
  type ArrangementWaveformTimelineRange,
  type ArrangementWaveformVisibleSegment,
} from '~/lib/arrangement-waveform-window'
import {
  arrangementWaveformPcmScheduler,
} from '~/lib/arrangement-waveform-pcm'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import { readLocalAssetBytes } from '~/lib/local-assets'
import {
  resolveSamplePlaybackUrlForRuntime,
} from '~/lib/renderer-api-url'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

type ClipWaveformViewModelOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  pixelsPerSecond: Accessor<number>
  projectId: Accessor<string | undefined>
  visibleRange: Accessor<ArrangementWaveformTimelineRange>
}

type WaveformRequestView = {
  assetKey?: string
  buffer: AudioBuffer | null
  clip: RuntimeClip
  sampleRate?: number
  channelCount?: number
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

const validRange = (
  range: ArrangementWaveformTimelineRange | undefined,
): range is ArrangementWaveformTimelineRange => Boolean(
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

const resolvePcmSource = async (
  projectId: string | undefined,
  view: WaveformRequestView,
): Promise<DecodeAudioPageSource | null> => {
  if (projectId && isLocalId('project', projectId) && view.sourceAssetKey) {
    const local = await readLocalAssetBytes(projectId, view.sourceAssetKey)
    if (local.status === 'ready') return local.file
  }
  const sampleUrl = resolveClipSampleUrl(view.clip)
  return sampleUrl
    ? resolveSamplePlaybackUrlForRuntime(sampleUrl) ?? null
    : null
}

const resolveBufferEnvelope = (
  buffer: AudioBuffer,
  segment: ArrangementWaveformVisibleSegment,
  channelCount: number,
): WaveformPeakChannelSlice | null => {
  if (buffer.numberOfChannels !== channelCount || !Number.isSafeInteger(buffer.sampleRate) || buffer.sampleRate <= 0) {
    return null
  }
  const startFrame = Math.max(0, Math.floor(segment.sourceStartSec * buffer.sampleRate))
  const endFrame = Math.min(buffer.length, Math.ceil(segment.sourceEndSec * buffer.sampleRate))
  if (!Number.isSafeInteger(startFrame) || startFrame >= buffer.length
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
    const metadata = getPersistableAudioSourceMetadata({
      buffer,
      sourceDurationSec: clip.sourceDurationSec,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannelCount: clip.sourceChannelCount,
    })
    return {
      assetKey,
      buffer,
      clip,
      sampleRate: metadata?.sampleRate,
      channelCount: metadata?.channelCount,
      sourceAssetKey: clip.sourceAssetKey,
      sourceIdentity: assetKey && metadata ? { assetKey, ...metadata } : undefined,
    }
  })

  createEffect(() => {
    const currentRequestId = ++requestId
    const current = view()
    const requestedRange = options.visibleRange()
    const hasViewportRange = validRange(requestedRange)
    const projectId = options.projectId()
    const abortController = new AbortController()
    onCleanup(() => abortController.abort())

    const assetKey = current.assetKey
    if (current.clip.midi || (!current.buffer && !assetKey) || !hasViewportRange) {
      setPeakSegments([])
      return
    }

    const sampleRate = current.sampleRate
    const channelCount = current.channelCount
    if (!sampleRate || !Number.isSafeInteger(sampleRate) || sampleRate <= 0
      || !channelCount || !Number.isSafeInteger(channelCount) || channelCount <= 0) {
      setPeakSegments([])
      return
    }

    const visibleSegments = getArrangementWaveformVisibleSegments({
      clip: current.clip,
      cssWidthPx: options.cssWidthPx(),
      pixelsPerSecond: options.pixelsPerSecond(),
      projectBpm: options.projectBpm(),
      visibleRange: requestedRange,
      bufferDurationSec: current.buffer?.duration,
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
    const visibleCenterSec = (requestedRange.startSec + requestedRange.endSec) / 2
    const pcmAssetKey = projectId && assetKey
      ? `${projectId}\u0000${assetKey}`
      : assetKey ?? ''

    const resolveSegmentPeaks = async (segment: ArrangementWaveformVisibleSegment) => {
      if (current.buffer) return resolveBufferEnvelope(current.buffer, segment, channelCount)

      const route = selectArrangementWaveformRoute({
        sampleRate,
        sourceStartSec: segment.sourceStartSec,
        sourceEndSec: segment.sourceEndSec,
        drawCols: segment.drawCols,
      })
      if (!route) return null

      if (route === 'cached-peaks' && assetKey) {
        const cached = await getWaveformChannelSlice({
          assetKey,
          sourceIdentity: current.sourceIdentity,
          sampleUrl: undefined,
          buffer: current.buffer,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          bins: segment.drawCols,
        })
        if (cached) return cached
      }

      return await arrangementWaveformPcmScheduler.request({
        assetKey: pcmAssetKey,
        source,
        sourceStartSec: segment.sourceStartSec,
        sourceEndSec: segment.sourceEndSec,
        columns: segment.drawCols,
        sampleRate,
        channelCount,
        priority: Math.abs((segment.timelineStartSec + segment.timelineEndSec) / 2 - visibleCenterSec),
        signal: abortController.signal,
      })
    }

    for (let index = 0; index < visibleSegments.length; index += 1) {
      const segment = visibleSegments[index]
      if (!segment) continue
      void resolveSegmentPeaks(segment)
        .then((peaks) => {
          if (currentRequestId !== requestId || abortController.signal.aborted) return
          setPeakSegments((currentSegments) => currentSegments.map((currentSegment, segmentIndex) => (
            segmentIndex === index
              ? { drawStartPx: segment.drawStartPx, drawCols: segment.drawCols, peaks }
              : currentSegment
          )))
        })
        .catch(() => undefined)
    }
  })

  onCleanup(() => {
    requestId += 1
  })

  return {
    layout: () => getAudioWaveformLayout(
      view().clip,
      view().clip.duration * options.pixelsPerSecond(),
      view().buffer?.duration,
      options.projectBpm(),
    ),
    peakSegments,
  }
}
