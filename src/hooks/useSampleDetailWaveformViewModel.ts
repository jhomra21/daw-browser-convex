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
import { resolveClipSampleUrl } from '@daw-browser/shared'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import { readLocalAssetBytes } from '~/lib/local-assets'
import { resolveSamplePlaybackUrlForRuntime } from '~/lib/renderer-api-url'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import type { SampleDetailWaveformViewport } from '~/lib/sample-detail-waveform-viewport'

type RenderPeakSegment = {
  mode: 'peaks'
  drawStartPx: number
  drawCols: number
  peaks: WaveformPeakChannelSlice
}

type RenderSampleSegment = {
  mode: 'samples'
  drawStartPx: number
  drawCols: number
  samples: WaveformSampleChannelSlice
  showPoints: boolean
}

export type SampleDetailWaveformRenderSegment = RenderPeakSegment | RenderSampleSegment

type SampleDetailWaveformViewModelOptions = {
  projectId: Accessor<string | undefined>
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  viewport: Accessor<SampleDetailWaveformViewport>
}

type SourceSegment = {
  drawStartPx: number
  drawCols: number
  sourceStartSec: number
  sourceEndSec: number
}

type WaveformRequestView = {
  clip: RuntimeClip
  assetKey?: string
  buffer: AudioBuffer | null
  sampleUrl?: string
  sourceAssetKey?: string
  sourceIdentity?: {
    assetKey: string
    durationSec: number
    sampleRate: number
    channelCount: number
  }
  sampleRate: number
  channelCount: number
  segments: SourceSegment[]
  layout: ReturnType<typeof getAudioWaveformLayout>
}

type PcmSourceResolver = () => Promise<DecodeAudioPageSource | null>

const frameBounds = (segment: SourceSegment, sampleRate: number) => {
  const startFrame = Math.max(0, Math.floor(segment.sourceStartSec * sampleRate))
  const endFrame = Math.max(startFrame + 1, Math.ceil(segment.sourceEndSec * sampleRate))
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

async function resolvePcmSource(
  projectId: string | undefined,
  view: WaveformRequestView,
): Promise<DecodeAudioPageSource | null> {
  if (view.buffer) return null
  if (projectId && view.sourceAssetKey) {
    const local = await readLocalAssetBytes(projectId, view.sourceAssetKey)
    if (local.status === 'ready') return local.file
  }
  return view.sampleUrl ?? null
}

async function resolvePcmEnvelope(
  view: WaveformRequestView,
  getSource: PcmSourceResolver,
  segment: SourceSegment,
  signal: AbortSignal,
): Promise<RenderPeakSegment | null> {
  const { startFrame, endFrame } = frameBounds(segment, view.sampleRate)
  const accumulator = createPcmEnvelopeAccumulator({
    startFrame,
    endFrame,
    columns: Math.max(1, segment.drawCols),
    channelCount: view.channelCount,
  })

  if (view.buffer) {
    accumulator.append(bufferPage(view.buffer))
  } else {
    const source = await getSource()
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

  return {
    mode: 'peaks',
    drawStartPx: segment.drawStartPx,
    drawCols: segment.drawCols,
    peaks: accumulator.finish(),
  }
}

async function resolvePcmSamples(
  view: WaveformRequestView,
  getSource: PcmSourceResolver,
  segment: SourceSegment,
  showPoints: boolean,
  signal: AbortSignal,
): Promise<RenderSampleSegment | null> {
  const { startFrame, endFrame } = frameBounds(segment, view.sampleRate)
  const collector = createPcmSampleWindowCollector({
    startFrame,
    endFrame,
    sampleRate: view.sampleRate,
    channelCount: view.channelCount,
    sourceStartSec: segment.sourceStartSec,
    sourceEndSec: segment.sourceEndSec,
  })

  if (view.buffer) {
    collector.append(bufferPage(view.buffer))
  } else {
    const source = await getSource()
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

  return {
    mode: 'samples',
    drawStartPx: segment.drawStartPx,
    drawCols: segment.drawCols,
    samples: collector.finish(),
    showPoints,
  }
}

async function resolveSegment(
  view: WaveformRequestView,
  getSource: PcmSourceResolver,
  segment: SourceSegment,
  signal: AbortSignal,
): Promise<SampleDetailWaveformRenderSegment | null> {
  const lod = selectWaveformLod({
    sampleRate: view.sampleRate,
    sourceStartSec: segment.sourceStartSec,
    sourceEndSec: segment.sourceEndSec,
    widthPx: segment.drawCols,
  })
  if (!lod) return null

  if (lod.mode === 'cached-peaks' && view.assetKey) {
    const peaks = await getWaveformChannelSlice({
      assetKey: view.assetKey,
      sourceIdentity: view.sourceIdentity,
      sampleUrl: view.sampleUrl,
      buffer: view.buffer,
      sourceStartSec: segment.sourceStartSec,
      sourceEndSec: segment.sourceEndSec,
      bins: segment.drawCols,
    })
    if (peaks) {
      return {
        mode: 'peaks',
        drawStartPx: segment.drawStartPx,
        drawCols: segment.drawCols,
        peaks,
      }
    }
    return resolvePcmEnvelope(view, getSource, segment, signal)
  }

  if (lod.mode === 'pcm-envelope') {
    return resolvePcmEnvelope(view, getSource, segment, signal)
  }

  return resolvePcmSamples(view, getSource, segment, lod.showPoints, signal)
}

export function useSampleDetailWaveformViewModel(options: SampleDetailWaveformViewModelOptions) {
  const [renderSegments, setRenderSegments] = createSignal<SampleDetailWaveformRenderSegment[]>([])
  const [loading, setLoading] = createSignal(false)
  let requestId = 0

  const view = createMemo<WaveformRequestView | null>(() => {
    const clip = options.clip()
    const buffer = clip.buffer ?? null
    const metadata = getPersistableAudioSourceMetadata({
      buffer,
      sourceDurationSec: clip.sourceDurationSec,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannelCount: clip.sourceChannelCount,
    })
    if (!metadata || clip.midi) return null

    const width = options.cssWidthPx()
    const viewport = options.viewport()
    const layout = getAudioWaveformLayout(
      clip,
      width,
      buffer?.duration,
      options.projectBpm(),
      {
        startSec: clip.startSec + viewport.startSec,
        endSec: clip.startSec + viewport.endSec,
      },
    )
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey
    const unresolvedSampleUrl = resolveClipSampleUrl(clip)
    const sampleUrl = unresolvedSampleUrl
      ? resolveSamplePlaybackUrlForRuntime(unresolvedSampleUrl) ?? undefined
      : undefined
    const segments = layout.segments ?? (layout.drawCols > 0
      ? [{
        drawStartPx: layout.padPx,
        drawCols: layout.drawCols,
        sourceStartSec: layout.sourceStartSec,
        sourceEndSec: layout.sourceEndSec,
      }]
      : [])

    return {
      clip,
      assetKey,
      buffer,
      sampleUrl,
      sourceAssetKey: clip.sourceAssetKey,
      sourceIdentity: assetKey ? { assetKey, ...metadata } : undefined,
      sampleRate: metadata.sampleRate,
      channelCount: metadata.channelCount,
      segments,
      layout,
    }
  })

  createEffect(() => {
    const current = view()
    const projectId = options.projectId()
    const currentRequestId = ++requestId
    const abortController = new AbortController()
    onCleanup(() => abortController.abort())

    if (!current || current.segments.length === 0) {
      setRenderSegments([])
      setLoading(false)
      return
    }

    let sourcePromise: Promise<DecodeAudioPageSource | null> | undefined
    const getSource = () => {
      sourcePromise ??= resolvePcmSource(projectId, current)
      return sourcePromise
    }

    setLoading(true)
    void Promise.all(current.segments.map((segment) => (
      resolveSegment(current, getSource, segment, abortController.signal)
    )))
      .then((next) => {
        if (currentRequestId !== requestId || abortController.signal.aborted) return
        setRenderSegments(next.flatMap((segment) => segment ? [segment] : []))
      })
      .catch(() => {
        if (currentRequestId !== requestId || abortController.signal.aborted) return
        setRenderSegments([])
      })
      .finally(() => {
        if (currentRequestId === requestId && !abortController.signal.aborted) setLoading(false)
      })
  })

  onCleanup(() => {
    requestId += 1
  })

  return {
    layout: () => view()?.layout,
    renderSegments,
    loading,
  }
}
