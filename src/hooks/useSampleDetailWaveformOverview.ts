import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import { getWaveformSlice } from '@daw-browser/waveforms/select-waveform-window'
import type { WaveformPeakChannelSlice } from '@daw-browser/waveforms/types'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'

type OverviewRenderSegment = {
  drawStartPx: number
  drawCols: number
  peaks: WaveformPeakChannelSlice
}

type SampleDetailWaveformOverviewOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  resolveAudioSource: Accessor<AudioPcmSourceResolver>
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
    const currentRequestId = ++requestId
    if (!current) {
      setRenderSegments([])
      return
    }
    const controller = new AbortController()
    void options.resolveAudioSource()(current.clip, controller.signal, { verifyContentHash: true })
      .then(async (source) => {
        const layout = getAudioWaveformLayout(
          current.clip,
          cssWidthPx,
          source.durationSec,
          projectBpm,
        )
        const segments = layout.segments?.map((segment) => ({
          drawStartPx: segment.startPx,
          drawCols: segment.drawCols,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
        })) ?? (layout.drawCols > 0
          ? [{
            drawStartPx: layout.padPx,
            drawCols: layout.drawCols,
            sourceStartSec: layout.sourceStartSec,
            sourceEndSec: layout.sourceEndSec,
          }]
          : [])
        return await Promise.all(segments.map(async (segment) => {
          const durationSec = Math.max(0, segment.sourceEndSec - segment.sourceStartSec)
          const bins = Math.max(1, Math.min(
            segment.drawCols,
            Math.ceil(durationSec * 400),
          ))
          const peaks = await getWaveformSlice({
            assetKey: current.assetKey,
            sourceIdentity: {
              assetKey: current.assetKey,
              identity: source.identity,
              durationSec: source.durationSec,
              sampleRate: source.sampleRate,
              channelCount: source.channelCount,
            },
            source,
            sourceStartSec: segment.sourceStartSec,
            sourceEndSec: segment.sourceEndSec,
            bins,
            signal: controller.signal,
          })
          return peaks
            ? { drawStartPx: segment.drawStartPx, drawCols: bins, peaks }
            : null
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
