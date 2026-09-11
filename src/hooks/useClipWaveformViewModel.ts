import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import { getWaveformSlice } from '@daw-browser/waveforms/select-waveform-window'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

type ClipWaveformViewModelOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  resolveAudioSource: Accessor<AudioPcmSourceResolver>
}

const concatPeakSegments = (segments: Uint8Array[]) => {
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const segment of segments) {
    result.set(segment, offset)
    offset += segment.length
  }
  return result
}

export function useClipWaveformViewModel(options: ClipWaveformViewModelOptions) {
  const [peaks, setPeaks] = createSignal<Uint8Array | null>(null)
  let requestId = 0

  const view = createMemo(() => {
    const clip = options.clip()
    const midi = clip.midi
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey
    const metadata = getPersistableAudioSourceMetadata({
      buffer: clip.buffer,
      sourceDurationSec: clip.sourceDurationSec,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannelCount: clip.sourceChannelCount,
    })
    const layout = getAudioWaveformLayout(clip, options.cssWidthPx(), metadata?.durationSec, options.projectBpm())

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
      setPeaks(null)
      return
    }
    if (current.layout.drawCols <= 0 || current.layout.sourceDurationSec <= 0 || !current.assetKey) {
      setPeaks(null)
      return
    }
    const assetKey = current.assetKey

    const segments = current.layout.segments
      ? current.layout.segments
      : [{
        drawCols: current.layout.drawCols,
        sourceStartSec: current.layout.sourceStartSec,
        sourceEndSec: current.layout.sourceEndSec,
      }]

    const controller = new AbortController()
    void options.resolveAudioSource()(current.clip, controller.signal)
      .then((source) => Promise.all(segments.map((segment) => getWaveformSlice({
        assetKey,
        source: source,
        sourceIdentity: {
          assetKey,
          identity: source.identity,
          durationSec: source.durationSec,
          sampleRate: source.sampleRate,
          channelCount: source.channelCount,
        },
        sourceStartSec: segment.sourceStartSec,
        sourceEndSec: segment.sourceEndSec,
        bins: segment.drawCols,
        signal: controller.signal,
      }))))
      .then((next) => {
        if (currentRequestId !== requestId) return
        const complete = next.flatMap((segment) => segment ? [segment] : [])
        if (complete.length !== next.length) {
          setPeaks(null)
          return
        }
        setPeaks(complete.length === 1 ? complete[0] : concatPeakSegments(complete))
      })
      .catch(() => {
        if (currentRequestId !== requestId) return
        setPeaks(null)
      })
    onCleanup(() => controller.abort())
  })

  onCleanup(() => {
    requestId += 1
  })

  return {
    layout: () => view().layout,
    peaks,
  }
}
