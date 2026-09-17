import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import type { WaveformSourceData } from '@daw-browser/waveforms/types'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import {
  getAudioWaveformLayout,
  type AudioWaveformLayoutSegment,
} from '~/lib/audio-waveform-layout'
import {
  createWaveformRequestPlans,
  projectRetainedWaveformData,
  retainWaveformData,
} from '~/lib/retained-waveform'
import { requestWaveformData } from '~/lib/waveform-scheduler-request'

export type OverviewRenderSegment = {
  drawStartPx: number
  drawCols: number
  sourceStartFrame: number
  sourceEndFrame: number
  data: WaveformSourceData
}

type SampleDetailWaveformOverviewOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  source: Accessor<AudioPcmSourceDescriptor | null>
  backingPixelsPerCssPixel: Accessor<number>
}

type OverviewView = {
  clip: RuntimeClip
  assetKey: string
}

export function useSampleDetailWaveformOverview(options: SampleDetailWaveformOverviewOptions) {
  const [renderSegments, setRenderSegments] = createSignal<OverviewRenderSegment[]>([])
  let requestId = 0

  const view = createMemo<OverviewView | null>(() => {
    const clip = options.clip()
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey
    if (!assetKey || clip.midi) return null
    return { clip, assetKey }
  })

  createEffect(() => {
    const current = view()
    const cssWidthPx = options.cssWidthPx()
    const projectBpm = options.projectBpm()
    const backingPixelsPerCssPixel = options.backingPixelsPerCssPixel()
    const currentRequestId = ++requestId
    const controller = new AbortController()
    if (!current) {
      setRenderSegments([])
      return
    }
    const source = options.source()
    if (!source) {
      setRenderSegments([])
      onCleanup(() => controller.abort())
      return
    }
    void Promise.resolve(source)
      .then(async (source) => {
        const layout = getAudioWaveformLayout(
          current.clip,
          cssWidthPx,
          source.durationSec,
          projectBpm,
        )
        const segments: readonly AudioWaveformLayoutSegment[] = layout.segments
          ?? (layout.drawCols > 0
            ? [{
              drawCols: layout.drawCols,
              sourceStartSec: layout.sourceStartSec,
              sourceEndSec: layout.sourceEndSec,
              startPx: layout.padPx,
              endPx: layout.padPx + layout.drawCols,
              canvasStartSec: layout.canvasStartSec ?? current.clip.startSec,
              canvasEndSec: layout.canvasEndSec ?? current.clip.startSec + current.clip.duration,
            }]
            : [])
        const plans = createWaveformRequestPlans({
          segments,
          sampleRate: source.sampleRate,
          sourceDurationSec: source.durationSec,
          sourceFrameCount: source.frameCount,
          backingPixelsPerCssPixel,
        })
        const results = await Promise.all(plans.requests.map(async (request) => {
          const data = await requestWaveformData({
            assetKey: current.assetKey,
            source,
            sourceStartFrame: request.sourceStartFrame,
            sourceEndFrame: request.sourceEndFrame,
            framesPerInterval: request.framesPerInterval,
            priority: request.priority,
            signal: controller.signal,
          })
          return data ? { key: request.key, data: retainWaveformData(data) } : null
        }))
        const retainedByKey = new Map(
          results.flatMap((result) => result ? [[result.key, result.data]] : []),
        )
        const map = getAudioClipTimeMap({
          clip: current.clip,
          bufferDurationSec: source.durationSec,
          projectBpm,
          rangeStartSec: current.clip.startSec,
          rangeEndSec: current.clip.startSec + current.clip.duration,
        })
        if (!map) return []
        return projectRetainedWaveformData({
          retainedByKey,
          segments: plans.segments,
          map,
        }).map((segment) => ({
          drawStartPx: segment.startPx,
          drawCols: Math.max(0, segment.endPx - segment.startPx),
          sourceStartFrame: segment.sourceStartFrame,
          sourceEndFrame: segment.sourceEndFrame,
          data: segment.data,
        }))
      })
      .then((next) => {
        if (currentRequestId !== requestId) return
        setRenderSegments(next.flatMap((segment) => segment ? [segment] : []))
      })
      .catch(() => {
        if (currentRequestId !== requestId) return
        setRenderSegments([])
      })
    onCleanup(() => controller.abort())
  })

  onCleanup(() => {
    requestId += 1
  })

  return { renderSegments }
}
