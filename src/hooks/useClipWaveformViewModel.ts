import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import {
  decodeAudioPages,
  type DecodeAudioPageSource,
  type DecodedAudioPage,
} from '@daw-browser/audio-engine/media-pages'
import { selectWaveformLod } from '@daw-browser/waveforms/lod'
import { createPcmEnvelopeAccumulator } from '@daw-browser/waveforms/pcm-envelope'
import { createPcmSampleWindowCollector } from '@daw-browser/waveforms/pcm-samples'
import { getWaveformChannelSlice } from '@daw-browser/waveforms/select-waveform-window'
import type {
  WaveformPeakChannelSlice,
  WaveformSampleChannelSlice,
} from '@daw-browser/waveforms/types'
import { isLocalId, resolveClipSampleUrl } from '@daw-browser/shared'
import { getAudioWaveformLayout, type AudioWaveformVisibleRange } from '~/lib/audio-waveform-layout'
import {
  getArrangementWaveformVisibleSegments,
  selectArrangementWaveformRoute,
} from '~/lib/arrangement-waveform-window'
import { arrangementWaveformPcmScheduler } from '~/lib/arrangement-waveform-pcm'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import { readLocalAssetBytes } from '~/lib/local-assets'
import { resolveSamplePlaybackUrlForRuntime } from '~/lib/renderer-api-url'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

type ViewModelMode = 'arrangement' | 'sample-detail'

type ClipWaveformViewModelOptions = {
  projectId: Accessor<string | undefined>
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  mode: ViewModelMode
  visibleRange: Accessor<AudioWaveformVisibleRange>
  pixelsPerSecond?: Accessor<number>
}

type WaveformSourceSegment = {
  drawStartPx: number
  drawCols: number
  timelineStartSec: number
  timelineEndSec: number
  sourceStartSec: number
  sourceEndSec: number
}

type WaveformRequestView = {
  clip: RuntimeClip
  assetKey?: string
  sourceAssetKey?: string
  buffer: AudioBuffer | null
  sampleRate: number
  channelCount: number
  sourceIdentity?: {
    assetKey: string
    durationSec: number
    sampleRate: number
    channelCount: number
  }
  sampleUrl?: string
  segments: WaveformSourceSegment[]
  layout: ReturnType<typeof getAudioWaveformLayout>
}

type RenderPeakSegment = WaveformSourceSegment & {
  mode: 'peaks'
  peaks: WaveformPeakChannelSlice
}

type RenderSampleSegment = WaveformSourceSegment & {
  mode: 'samples'
  samples: WaveformSampleChannelSlice
  showPoints: boolean
}

export type ClipWaveformRenderSegment = RenderPeakSegment | RenderSampleSegment

const frameBounds = (segment: WaveformSourceSegment, sampleRate: number) => {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0
    || !Number.isFinite(segment.sourceStartSec) || segment.sourceStartSec < 0
    || !Number.isFinite(segment.sourceEndSec) || segment.sourceEndSec <= segment.sourceStartSec) {
    return null
  }
  const startFrame = Math.floor(segment.sourceStartSec * sampleRate)
  const endFrame = Math.max(startFrame + 1, Math.ceil(segment.sourceEndSec * sampleRate))
  if (!Number.isSafeInteger(startFrame) || startFrame < 0
    || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) return null
  return { startFrame, endFrame }
}

const bufferPage = (buffer: AudioBuffer): DecodedAudioPage => ({
  startFrame: 0,
  frameCount: buffer.length,
  sampleRate: buffer.sampleRate,
  channelCount: buffer.numberOfChannels,
  planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
})

const validateDecodedPage = (page: DecodedAudioPage, view: WaveformRequestView) => {
  if (page.sampleRate !== view.sampleRate || page.channelCount !== view.channelCount) {
    throw new Error('Decoded waveform media metadata changed during the request.')
  }
}

const resolvePcmSource = async (
  projectId: string | undefined,
  view: WaveformRequestView,
): Promise<DecodeAudioPageSource | null> => {
  if (projectId && isLocalId('project', projectId) && view.sourceAssetKey) {
    const local = await readLocalAssetBytes(projectId, view.sourceAssetKey)
    if (local.status === 'ready') return local.file
  }
  return view.sampleUrl ?? null
}

const resolvePcmEnvelope = async (
  view: WaveformRequestView,
  source: DecodeAudioPageSource | null,
  segment: WaveformSourceSegment,
  signal: AbortSignal,
): Promise<WaveformPeakChannelSlice | null> => {
  const bounds = frameBounds(segment, view.sampleRate)
  if (!bounds) return null
  const accumulator = createPcmEnvelopeAccumulator({
    startFrame: bounds.startFrame,
    endFrame: bounds.endFrame,
    columns: segment.drawCols,
    channelCount: view.channelCount,
  })

  if (view.buffer) {
    accumulator.append(bufferPage(view.buffer))
  } else {
    if (!source) return null
    for await (const page of decodeAudioPages(source, {
      startSec: segment.sourceStartSec,
      endSec: segment.sourceEndSec,
      signal,
    })) {
      validateDecodedPage(page, view)
      accumulator.append(page)
    }
  }
  return accumulator.finish()
}

const resolvePcmSamples = async (
  view: WaveformRequestView,
  source: DecodeAudioPageSource | null,
  segment: WaveformSourceSegment,
  signal: AbortSignal,
): Promise<WaveformSampleChannelSlice | null> => {
  const bounds = frameBounds(segment, view.sampleRate)
  if (!bounds) return null
  const collector = createPcmSampleWindowCollector({
    startFrame: bounds.startFrame,
    endFrame: bounds.endFrame,
    sampleRate: view.sampleRate,
    channelCount: view.channelCount,
    sourceStartSec: segment.sourceStartSec,
    sourceEndSec: segment.sourceEndSec,
  })

  if (view.buffer) {
    collector.append(bufferPage(view.buffer))
  } else {
    if (!source) return null
    for await (const page of decodeAudioPages(source, {
      startSec: segment.sourceStartSec,
      endSec: segment.sourceEndSec,
      signal,
    })) {
      validateDecodedPage(page, view)
      collector.append(page)
    }
  }
  return collector.finish()
}

const detailSegments = (
  layout: ReturnType<typeof getAudioWaveformLayout>,
  widthPx: number,
): WaveformSourceSegment[] => (
  layout.segments ?? (layout.drawCols > 0
    ? [{
      drawStartPx: layout.padPx,
      drawCols: layout.drawCols,
      timelineStartSec: layout.visibleTimelineStartSec
        + layout.padPx * (layout.visibleTimelineEndSec - layout.visibleTimelineStartSec)
          / Math.max(1, widthPx),
      timelineEndSec: layout.visibleTimelineStartSec
        + (layout.padPx + layout.drawCols)
          * (layout.visibleTimelineEndSec - layout.visibleTimelineStartSec)
          / Math.max(1, widthPx),
      sourceStartSec: layout.sourceStartSec,
      sourceEndSec: layout.sourceEndSec,
    }]
    : [])
)

const getRequestView = (options: ClipWaveformViewModelOptions): WaveformRequestView => {
  const clip = options.clip()
  const buffer = clip.buffer ?? null
  const metadata = getPersistableAudioSourceMetadata({
    buffer,
    sourceDurationSec: clip.sourceDurationSec,
    sourceSampleRate: clip.sourceSampleRate,
    sourceChannelCount: clip.sourceChannelCount,
  })
  const sampleRate = metadata?.sampleRate ?? 0
  const channelCount = metadata?.channelCount ?? 0
  const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey
  const unresolvedSampleUrl = resolveClipSampleUrl(clip)
  const sampleUrl = unresolvedSampleUrl
    ? resolveSamplePlaybackUrlForRuntime(unresolvedSampleUrl) ?? undefined
    : undefined
  const visibleRange = options.visibleRange()

  if (options.mode === 'arrangement') {
    const pixelsPerSecond = options.pixelsPerSecond?.() ?? 0
    const visibleSegments = getArrangementWaveformVisibleSegments({
      clip,
      cssWidthPx: options.cssWidthPx(),
      pixelsPerSecond,
      projectBpm: options.projectBpm(),
      visibleRange,
      bufferDurationSec: buffer?.duration,
    })
    const layout = getAudioWaveformLayout(
      clip,
      clip.duration * pixelsPerSecond,
      buffer?.duration,
      options.projectBpm(),
    )
    return {
      clip,
      assetKey,
      sourceAssetKey: clip.sourceAssetKey,
      buffer,
      sampleRate,
      channelCount,
      sampleUrl,
      sourceIdentity: assetKey && metadata ? { assetKey, ...metadata } : undefined,
      segments: visibleSegments,
      layout,
    }
  }

  const layout = getAudioWaveformLayout(
    clip,
    options.cssWidthPx(),
    buffer?.duration,
    options.projectBpm(),
    visibleRange,
  )
  return {
    clip,
    assetKey,
    sourceAssetKey: clip.sourceAssetKey,
    buffer,
    sampleRate,
    channelCount,
    sampleUrl,
    sourceIdentity: assetKey && metadata ? { assetKey, ...metadata } : undefined,
    segments: detailSegments(layout, options.cssWidthPx()),
    layout,
  }
}

export function useClipWaveformViewModel(options: ClipWaveformViewModelOptions) {
  const [renderSegments, setRenderSegments] = createSignal<ClipWaveformRenderSegment[]>([])
  const [loading, setLoading] = createSignal(false)
  let requestId = 0

  const view = createMemo(() => getRequestView(options))

  createEffect(() => {
    const current = view()
    const projectId = options.projectId()
    const currentRequestId = ++requestId
    const abortController = new AbortController()
    onCleanup(() => abortController.abort())

    if (current.clip.midi || current.segments.length === 0
      || (!current.buffer && !current.assetKey && !current.sampleUrl)
      || current.sampleRate <= 0 || current.channelCount <= 0) {
      setRenderSegments([])
      setLoading(false)
      return
    }

    let sourcePromise: Promise<DecodeAudioPageSource | null> | undefined
    const source = () => {
      sourcePromise ??= resolvePcmSource(projectId, current)
      return sourcePromise
    }
    setLoading(true)
    void Promise.all(current.segments.map(async (segment): Promise<ClipWaveformRenderSegment | null> => {
      const lod = selectWaveformLod({
        sampleRate: current.sampleRate,
        sourceStartSec: segment.sourceStartSec,
        sourceEndSec: segment.sourceEndSec,
        widthPx: segment.drawCols,
      })
      if (!lod) return null

      const arrangementRoute = options.mode === 'arrangement'
        ? selectArrangementWaveformRoute({
          sampleRate: current.sampleRate,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          drawCols: segment.drawCols,
        })
        : undefined

      if ((arrangementRoute ?? lod.mode) === 'cached-peaks' && current.assetKey) {
        const peaks = await getWaveformChannelSlice({
          assetKey: current.assetKey,
          sourceIdentity: current.sourceIdentity,
          sampleUrl: undefined,
          buffer: options.mode === 'sample-detail' ? current.buffer : undefined,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          bins: segment.drawCols,
        })
        if (peaks) return { mode: 'peaks', ...segment, peaks }
      }

      if (options.mode === 'arrangement'
        && (arrangementRoute === 'cached-peaks' || arrangementRoute === 'pcm-envelope')) {
        if (current.buffer) {
          const peaks = await resolvePcmEnvelope(
            current,
            null,
            segment,
            abortController.signal,
          )
          return peaks ? { mode: 'peaks', ...segment, peaks } : null
        }
        const peaks = await arrangementWaveformPcmScheduler.request({
          assetKey: `${projectId ?? ''}\u0000${current.assetKey ?? current.sampleUrl ?? ''}`,
          source,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          columns: segment.drawCols,
          sampleRate: current.sampleRate,
          channelCount: current.channelCount,
          priority: Math.abs(
            (segment.timelineStartSec + segment.timelineEndSec) / 2
              - (current.layout.visibleTimelineStartSec + current.layout.visibleTimelineEndSec) / 2,
          ),
          signal: abortController.signal,
        })
        return peaks ? { mode: 'peaks', ...segment, peaks } : null
      }

      if (lod.mode === 'cached-peaks' || lod.mode === 'pcm-envelope') {
        const peaks = await resolvePcmEnvelope(
          current,
          await source(),
          segment,
          abortController.signal,
        )
        return peaks ? { mode: 'peaks', ...segment, peaks } : null
      }

      const samples = await resolvePcmSamples(
        current,
        await source(),
        segment,
        abortController.signal,
      )
      return samples
        ? { mode: 'samples', ...segment, samples, showPoints: lod.showPoints }
        : null
    })).then((next) => {
      if (currentRequestId !== requestId || abortController.signal.aborted) return
      setRenderSegments(next.flatMap((segment) => segment ? [segment] : []))
    }).catch(() => {
      if (currentRequestId !== requestId || abortController.signal.aborted) return
      setRenderSegments([])
    }).finally(() => {
      if (currentRequestId === requestId && !abortController.signal.aborted) setLoading(false)
    })
  })

  onCleanup(() => {
    requestId += 1
  })

  return {
    layout: () => view().layout,
    renderSegments,
    loading,
  }
}
