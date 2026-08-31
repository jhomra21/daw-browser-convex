import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'

import { createPcmEnvelopeAccumulator } from '@daw-browser/waveforms/pcm-envelope'
import { getWaveformChannelSlice } from '@daw-browser/waveforms/select-waveform-window'
import type { WaveformPeakChannelSlice } from '@daw-browser/waveforms/types'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

type OverviewRenderSegment = {
  drawStartPx: number
  drawCols: number
  peaks: WaveformPeakChannelSlice
}

type SampleDetailWaveformOverviewOptions = {
  clip: Accessor<RuntimeClip>
  cssWidthPx: Accessor<number>
  projectBpm: Accessor<number>
}

type OverviewSourceSegment = {
  drawStartPx: number
  drawCols: number
  sourceStartSec: number
  sourceEndSec: number
}

type OverviewView = {
  assetKey?: string
  buffer: AudioBuffer | null
  sourceIdentity?: {
    assetKey: string
    durationSec: number
    sampleRate: number
    channelCount: number
  }
  sampleRate: number
  channelCount: number
  segments: OverviewSourceSegment[]
}

const bufferEnvelope = (
  buffer: AudioBuffer,
  segment: OverviewSourceSegment,
  channelCount: number,
): WaveformPeakChannelSlice | null => {
  const rawStartFrame = segment.sourceStartSec * buffer.sampleRate
  const rawEndFrame = segment.sourceEndSec * buffer.sampleRate
  if (!Number.isFinite(rawStartFrame) || !Number.isFinite(rawEndFrame)) return null
  const startFrame = Math.max(0, Math.floor(rawStartFrame))
  const endFrame = Math.min(buffer.length, Math.ceil(rawEndFrame))
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) return null

  const accumulator = createPcmEnvelopeAccumulator({
    startFrame,
    endFrame,
    columns: Math.max(1, segment.drawCols),
    channelCount,
  })
  accumulator.append({
    startFrame: 0,
    frameCount: buffer.length,
    planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
  })
  return accumulator.finish()
}

export function useSampleDetailWaveformOverview(options: SampleDetailWaveformOverviewOptions) {
  const [renderSegments, setRenderSegments] = createSignal<OverviewRenderSegment[]>([])
  let requestId = 0

  const view = createMemo<OverviewView | null>(() => {
    const clip = options.clip()
    const buffer = clip.buffer ?? null
    const metadata = getPersistableAudioSourceMetadata({
      buffer,
      sourceDurationSec: clip.sourceDurationSec,
      sourceSampleRate: clip.sourceSampleRate,
      sourceChannelCount: clip.sourceChannelCount,
    })
    if (!metadata || clip.midi
      || !Number.isSafeInteger(metadata.sampleRate) || metadata.sampleRate <= 0
      || !Number.isSafeInteger(metadata.channelCount) || metadata.channelCount <= 0) return null

    const layout = getAudioWaveformLayout(
      clip,
      options.cssWidthPx(),
      buffer?.duration,
      options.projectBpm(),
    )
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey
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
      sourceIdentity: assetKey ? { assetKey, ...metadata } : undefined,
      sampleRate: metadata.sampleRate,
      channelCount: metadata.channelCount,
      segments,
    }
  })

  createEffect(() => {
    const current = view()
    const currentRequestId = ++requestId
    if (!current || current.segments.length === 0) {
      setRenderSegments([])
      return
    }

    void Promise.all(current.segments.map(async (segment) => {
      if (current.assetKey) {
        const peaks = await getWaveformChannelSlice({
          assetKey: current.assetKey,
          sourceIdentity: current.sourceIdentity,
          sampleUrl: undefined,
          buffer: current.buffer,
          sourceStartSec: segment.sourceStartSec,
          sourceEndSec: segment.sourceEndSec,
          bins: segment.drawCols,
        })
        if (peaks) return { drawStartPx: segment.drawStartPx, drawCols: segment.drawCols, peaks }
      }

      if (!current.buffer) return null
      const peaks = bufferEnvelope(current.buffer, segment, current.channelCount)
      return peaks ? { drawStartPx: segment.drawStartPx, drawCols: segment.drawCols, peaks } : null
    }))
      .then((next) => {
        if (currentRequestId !== requestId) return
        setRenderSegments(next.flatMap((segment) => segment ? [segment] : []))
      })
      .catch(() => {
        if (currentRequestId !== requestId) return
        setRenderSegments([])
      })
  })

  onCleanup(() => {
    requestId += 1
  })

  return { renderSegments }
}
