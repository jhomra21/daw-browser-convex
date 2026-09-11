import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'

import { getCachedWaveformSlice, getWaveformSlice } from '@daw-browser/waveforms/select-waveform-window'
import { arrangementWaveformPcmScheduler } from '@daw-browser/waveforms/arrangement-waveform-pcm'
import { selectWaveformLod } from '@daw-browser/waveforms/lod'
import type { WaveformPeakChannelSlice, WaveformPcmResult } from '@daw-browser/waveforms/types'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

type ClipWaveformViewModelOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  resolveAudioSource: Accessor<AudioPcmSourceResolver>
  visibleRange?: Accessor<{ startSec: number; endSec: number }>
  priorityRange?: Accessor<{ startSec: number; endSec: number }>
  mode?: 'arrangement' | 'sample-detail'
}

export type ClipWaveformSegment = {
  startPx: number
  endPx: number
  canvasStartSec: number
  canvasEndSec: number
  sourceStartSec: number
  sourceEndSec: number
  peaks: WaveformPeakChannelSlice | null
  pcm: WaveformPcmResult | null
  showPoints: boolean
}

export type ClipWaveformRenderSegment =
  | {
    mode: 'peaks'
    drawStartPx: number
    drawCols: number
    peaks: WaveformPeakChannelSlice
  }
  | {
    mode: 'samples'
    drawStartPx: number
    drawCols: number
    samples: Extract<WaveformPcmResult, { mode: 'pcm-line' }>
    showPoints: boolean
  }

export function useClipWaveformViewModel(options: ClipWaveformViewModelOptions) {
  const [peaks, setPeaks] = createSignal<WaveformPeakChannelSlice | null>(null)
  const [pcm, setPcm] = createSignal<WaveformPcmResult | null>(null)
  const [segments, setSegments] = createSignal<ClipWaveformSegment[]>([])
  const [loading, setLoading] = createSignal(false)
  let requestId = 0
  let lastSourceIdentityKey: string | undefined
  let resolvedSourceKey: string | undefined
  let resolvedSource: Awaited<ReturnType<AudioPcmSourceResolver>> | undefined

  const view = createMemo(() => {
    const clip = options.clip()
    const midi = clip.midi
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey ?? `clip:${clip.id}`
    const metadata = getPersistableAudioSourceMetadata({
      buffer: clip.buffer,
      sourceDurationSec: clip.sourceDurationSec,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannelCount: clip.sourceChannelCount,
    })
    const layout = getAudioWaveformLayout(
      clip,
      options.cssWidthPx(),
      metadata?.durationSec,
      options.projectBpm(),
      options.visibleRange?.(),
    )

    return {
      assetKey,
      clip,
      layout,
      midi,
    }
  })

  createEffect(() => {
    const currentRequestId = ++requestId
    const current = view()

    if (current.midi) {
      setLoading(false)
      setPeaks(null)
      setPcm(null)
      setSegments([])
      return
    }
    if (current.layout.drawCols <= 0 || current.layout.sourceDurationSec <= 0 || !current.assetKey) {
      setLoading(false)
      setPeaks(null)
      setPcm(null)
      setSegments([])
      return
    }
    const assetKey = current.assetKey
    const layoutSegments = current.layout.segments
      ? current.layout.segments
      : [{
        drawCols: current.layout.drawCols,
        sourceStartSec: current.layout.sourceStartSec,
        sourceEndSec: current.layout.sourceEndSec,
        startPx: current.layout.padPx,
        endPx: current.layout.audioEndPx,
        canvasStartSec: current.layout.canvasStartSec ?? current.clip.startSec,
        canvasEndSec: current.layout.canvasEndSec ?? current.clip.startSec + current.clip.duration,
      }]
    const previousSegments = untrack(segments)
    const currentCanvasStartSec = current.layout.canvasStartSec ?? current.clip.startSec
    const currentCanvasEndSec = current.layout.canvasEndSec
      ?? current.clip.startSec + current.clip.duration
    const pixelsPerCanvasSecond = options.cssWidthPx() / Math.max(
      1e-6,
      currentCanvasEndSec - currentCanvasStartSec,
    )
    const preserve = layoutSegments.map((segment) => {
      const previous = previousSegments.find((candidate) => (
        candidate.sourceStartSec < segment.sourceEndSec
        && candidate.sourceEndSec > segment.sourceStartSec
      ))
      if (!previous) {
        return {
          startPx: segment.startPx,
          endPx: segment.endPx,
          canvasStartSec: segment.canvasStartSec,
          canvasEndSec: segment.canvasEndSec,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          peaks: null,
          pcm: null,
          showPoints: false,
        }
      }
      return {
        startPx: (previous.canvasStartSec - currentCanvasStartSec) * pixelsPerCanvasSecond,
        endPx: (previous.canvasEndSec - currentCanvasStartSec) * pixelsPerCanvasSecond,
        canvasStartSec: previous.canvasStartSec,
        canvasEndSec: previous.canvasEndSec,
        sourceStartSec: previous.sourceStartSec,
        sourceEndSec: previous.sourceEndSec,
        peaks: previous?.peaks ?? null,
        pcm: previous?.pcm ?? null,
        showPoints: previous?.showPoints ?? false,
      }
    })
    setSegments([])
    setPeaks(null)
    setPcm(null)
    const controller = new AbortController()
    setLoading(true)
    const sourceKey = [
      current.clip.id,
      current.clip.sourceAssetKey ?? '',
      current.clip.sampleUrl ?? '',
      current.clip.sourceDurationSec ?? '',
      current.clip.sourceSampleRate ?? '',
      current.clip.sourceChannelCount ?? '',
      current.clip.audioWarp?.enabled === true && current.clip.audioWarp.mode === 'stretch' ? 'verified' : 'session',
    ].join('|')
    const sourcePromise = resolvedSourceKey === sourceKey && resolvedSource
      ? Promise.resolve(resolvedSource)
      : options.resolveAudioSource()(current.clip, controller.signal).then((source) => {
        resolvedSourceKey = sourceKey
        resolvedSource = source
        return source
      })
    void sourcePromise
      .then(async (source) => {
        if (currentRequestId !== requestId) return
        const sourceIdentity = {
          assetKey,
          identity: source.identity,
          durationSec: source.durationSec,
          sampleRate: source.sampleRate,
          channelCount: source.channelCount,
        }
        const sourceIdentityKey = [
          assetKey,
          source.identity,
          source.durationSec,
          source.sampleRate,
          source.channelCount,
        ].join('|')
        const preserveResolvedSource = lastSourceIdentityKey === sourceIdentityKey
        lastSourceIdentityKey = sourceIdentityKey
        const preservedSegments = preserveResolvedSource ? preserve : layoutSegments.map((segment) => ({
          startPx: segment.startPx,
          endPx: segment.endPx,
          canvasStartSec: segment.canvasStartSec,
          canvasEndSec: segment.canvasEndSec,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          peaks: null,
          pcm: null,
          showPoints: false,
        }))
        const lods = layoutSegments.map((segment) => selectWaveformLod({
          sampleRate: source.sampleRate,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          widthPx: segment.drawCols,
        }))
        const cachedPeaks = await Promise.all(layoutSegments.map((segment, index) => {
          const request = {
            assetKey,
            sourceIdentity,
            sourceStartSec: segment.sourceStartSec,
            sourceEndSec: segment.sourceEndSec,
            bins: segment.drawCols,
            signal: controller.signal,
          }
          return lods[index]?.mode === 'cached-peaks'
            ? getWaveformSlice({ ...request, source })
            : getCachedWaveformSlice(request).catch(() => null)
        }))
        if (currentRequestId !== requestId) return
        const initialSegments = layoutSegments.map((segment, index) => ({
          startPx: segment.startPx,
          endPx: segment.endPx,
          canvasStartSec: segment.canvasStartSec,
          canvasEndSec: segment.canvasEndSec,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          peaks: cachedPeaks[index] ?? null,
          pcm: preservedSegments[index]?.pcm ?? null,
          showPoints: preservedSegments[index]?.showPoints ?? false,
        }))
        setSegments(initialSegments)
        setPeaks(initialSegments.length === 1 ? initialSegments[0]?.peaks ?? null : null)
        setPcm(null)
        const pcmResults = await Promise.all(layoutSegments.map((segment, index) => {
          const lod = lods[index]
          if (!lod
            || (lod.mode === 'cached-peaks'
              && (cachedPeaks[index] !== null || options.mode !== 'sample-detail'))) {
            return Promise.resolve<WaveformPcmResult | null>(null)
          }
          return arrangementWaveformPcmScheduler.request({
            assetKey,
            sourceIdentity: source.identity,
            source: async () => source,
            sourceStartSec: segment.sourceStartSec,
            sourceEndSec: segment.sourceEndSec,
            columns: segment.drawCols,
            sampleRate: source.sampleRate,
            channelCount: source.channelCount,
            mode: lod.mode === 'pcm-line' ? 'pcm-line' : 'pcm-envelope',
            exactRange: options.mode === 'sample-detail',
            priority: options.mode === 'sample-detail'
              ? 0
              : Math.abs(
                (segment.canvasStartSec + segment.canvasEndSec) / 2
                  - (
                    (options.priorityRange?.().startSec ?? current.clip.startSec)
                    + (options.priorityRange?.().endSec ?? current.clip.startSec + current.clip.duration)
                  ) / 2,
              ),
            signal: controller.signal,
          })
        }))
        if (currentRequestId !== requestId) return
        const readySegments = layoutSegments.map((segment, index) => ({
          startPx: segment.startPx,
          endPx: segment.endPx,
          canvasStartSec: segment.canvasStartSec,
          canvasEndSec: segment.canvasEndSec,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          peaks: cachedPeaks[index] ?? null,
          pcm: pcmResults[index] ?? null,
          showPoints: lods[index]?.mode === 'pcm-line' && lods[index].showPoints === true,
        }))
        setSegments(readySegments)
        setPeaks(readySegments.length === 1 ? readySegments[0]?.peaks ?? null : null)
        setPcm(readySegments.length === 1 ? readySegments[0]?.pcm ?? null : null)
        setLoading(false)
      })
      .catch(() => {
        if (currentRequestId !== requestId) return
        setLoading(false)
      })
    onCleanup(() => controller.abort())
  })

  onCleanup(() => {
    requestId += 1
  })

  const renderSegments = createMemo<ClipWaveformRenderSegment[]>(() => {
    const render: ClipWaveformRenderSegment[] = []
    for (const segment of segments()) {
      if (segment.pcm?.mode === 'pcm-line') {
        render.push({
          mode: 'samples',
          drawStartPx: segment.startPx,
          drawCols: segment.endPx - segment.startPx,
          samples: segment.pcm,
          showPoints: segment.showPoints,
        })
      } else if (segment.pcm?.mode === 'pcm-envelope') {
        render.push({
          mode: 'peaks',
          drawStartPx: segment.startPx,
          drawCols: segment.pcm.columns,
          peaks: segment.pcm,
        })
      } else if (segment.peaks) {
        render.push({
          mode: 'peaks',
          drawStartPx: segment.startPx,
          drawCols: segment.peaks.columns,
          peaks: segment.peaks,
        })
      }
    }
    return render
  })

  return {
    layout: () => view().layout,
    peaks,
    pcm,
    segments,
    renderSegments,
    loading,
  }
}
