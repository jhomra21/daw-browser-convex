import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import { SILENCE_BYTE } from '@daw-browser/waveforms/extract-peaks'
import { getWaveformChannelSlice } from '@daw-browser/waveforms/select-waveform-window'
import type { WaveformPeakChannelSlice } from '@daw-browser/waveforms/types'
import { resolveClipSampleUrl } from '@daw-browser/shared'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import {
  resolveSamplePlaybackUrlForRuntime,
} from '~/lib/renderer-api-url'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

type ClipWaveformViewModelOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
  ensureClipBuffer?: (clipId: string, sampleUrl?: string) => Promise<void>
}

export type ClipWaveformPeakSegment = {
  drawStartPx: number
  drawCols: number
  peaks: WaveformPeakChannelSlice | null
}

const collapsePeakChannels = (slice: WaveformPeakChannelSlice) => {
  const output = new Uint8Array(slice.columns * 2)
  for (let column = 0; column < slice.columns; column += 1) {
    let min = 255
    let max = 0
    for (const channel of slice.channels) {
      const channelMin = channel[column * 2] ?? SILENCE_BYTE
      const channelMax = channel[column * 2 + 1] ?? SILENCE_BYTE
      if (channelMin < min) min = channelMin
      if (channelMax > max) max = channelMax
    }
    output[column * 2] = min
    output[column * 2 + 1] = max
  }
  return output
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
  const [peakSegments, setPeakSegments] = createSignal<ClipWaveformPeakSegment[]>([])
  let requestId = 0

  const view = createMemo(() => {
    const clip = options.clip()
    const midi = clip.midi
    const buffer = clip.buffer ?? null
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey
    const unresolvedSampleUrl = resolveClipSampleUrl(clip)
    const sampleUrl = unresolvedSampleUrl ? resolveSamplePlaybackUrlForRuntime(unresolvedSampleUrl) ?? undefined : undefined
    const layout = getAudioWaveformLayout(clip, options.cssWidthPx(), buffer?.duration, options.projectBpm())
    const metadata = getPersistableAudioSourceMetadata({
      buffer,
      sourceDurationSec: clip.sourceDurationSec,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannelCount: clip.sourceChannelCount,
    })
    const segments = layout.segments ?? (layout.drawCols > 0
      ? [{
        drawStartPx: layout.padPx,
        drawCols: layout.drawCols,
        sourceStartSec: layout.sourceStartSec,
        sourceEndSec: layout.sourceEndSec,
      }]
      : [])

    return {
      assetKey,
      buffer,
      clip,
      layout,
      midi,
      sampleUrl,
      segments,
      sourceIdentity: assetKey && metadata ? { assetKey, ...metadata } : undefined,
    }
  })

  createEffect(() => {
    const currentRequestId = ++requestId
    const current = view()

    if (current.midi) {
      setPeakSegments([])
      return
    }
    if (current.segments.length === 0 || !current.assetKey) {
      setPeakSegments([])
      return
    }
    const assetKey = current.assetKey
    if (!current.buffer && !current.sampleUrl) {
      if (!current.clip.mediaStatus) {
        void options.ensureClipBuffer?.(current.clip.id)
      }
      setPeakSegments(current.segments.map((segment) => ({
        drawStartPx: segment.drawStartPx,
        drawCols: segment.drawCols,
        peaks: null,
      })))
      return
    }

    void Promise.all(current.segments.map(async (segment): Promise<ClipWaveformPeakSegment> => ({
      drawStartPx: segment.drawStartPx,
      drawCols: segment.drawCols,
      peaks: await getWaveformChannelSlice({
        assetKey,
        sourceIdentity: current.sourceIdentity,
        sampleUrl: current.sampleUrl,
        buffer: current.buffer,
        sourceStartSec: segment.sourceStartSec,
        sourceEndSec: segment.sourceEndSec,
        bins: segment.drawCols,
      }),
    })))
      .then((next) => {
        if (currentRequestId !== requestId) return
        setPeakSegments(next)
      })
      .catch(() => {
        if (currentRequestId !== requestId) return
        setPeakSegments(current.segments.map((segment) => ({
          drawStartPx: segment.drawStartPx,
          drawCols: segment.drawCols,
          peaks: null,
        })))
      })
  })

  const peaks = createMemo(() => {
    const segments = peakSegments()
    if (segments.length === 0 || segments.some((segment) => !segment.peaks)) return null
    return concatPeakSegments(segments.map((segment) => collapsePeakChannels(segment.peaks!)))
  })

  onCleanup(() => {
    requestId += 1
  })

  return {
    layout: () => view().layout,
    peakSegments,
    peaks,
  }
}
