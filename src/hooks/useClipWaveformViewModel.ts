import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import { getWaveformSlice } from '@daw-browser/waveforms/select-waveform-window'
import { resolveClipSampleUrl } from '@daw-browser/shared'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

type ClipWaveformViewModelOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
}

export function useClipWaveformViewModel(options: ClipWaveformViewModelOptions) {
  const [peaks, setPeaks] = createSignal<Uint8Array | null>(null)
  let requestId = 0

  const view = createMemo(() => {
    const clip = options.clip()
    const midi = clip.midi
    const buffer = clip.buffer ?? null
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey
    const sampleUrl = resolveClipSampleUrl(clip)
    const layout = getAudioWaveformLayout(clip, options.cssWidthPx(), buffer?.duration)
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
      layout,
      midi,
      sampleUrl,
      sourceIdentity: assetKey && metadata ? { assetKey, ...metadata } : undefined,
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
    if (!current.buffer && !current.sampleUrl) {
      if (!current.clip.mediaStatus) {
        void options.ensureClipBuffer?.(current.clip.id)
      }
      setPeaks(null)
      return
    }

    void getWaveformSlice({
      assetKey: current.assetKey,
      sourceIdentity: current.sourceIdentity,
      sampleUrl: current.sampleUrl,
      buffer: current.buffer,
      sourceStartSec: current.layout.sourceStartSec,
      sourceEndSec: current.layout.sourceEndSec,
      bins: current.layout.drawCols,
    })
      .then((next) => {
        if (currentRequestId !== requestId) return
        setPeaks(next)
      })
      .catch(() => {
        if (currentRequestId !== requestId) return
        setPeaks(null)
      })
  })

  onCleanup(() => {
    requestId += 1
  })

  return {
    layout: () => view().layout,
    peaks,
  }
}
