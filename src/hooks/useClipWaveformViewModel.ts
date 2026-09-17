import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js'
import { pointRadiusForPixelsPerSample } from '@daw-browser/waveforms/lod'
import type { WaveformSourceData } from '@daw-browser/waveforms/types'
import { getAudioBufferSessionIdentity } from '@daw-browser/audio-engine/media-pages'
import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import {
  createWaveformRequestPlans,
  projectRetainedWaveformData,
  retainWaveformData,
  type WaveformRequestPlans,
} from '~/lib/retained-waveform'
import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import { requestWaveformData } from '~/lib/waveform-scheduler-request'

type ClipWaveformViewModelOptions = {
  readonly clip: Accessor<RuntimeClip>
  readonly cssWidthPx: Accessor<number>
  readonly projectBpm: Accessor<number>
  readonly resolveAudioSource: Accessor<AudioPcmSourceResolver>
  readonly visibleRange?: Accessor<{ startSec: number; endSec: number }>
  readonly priorityRange?: Accessor<{ startSec: number; endSec: number }>
  readonly waveformVisible?: Accessor<boolean>
  readonly backingPixelsPerCssPixel?: Accessor<number>
}

export type ClipWaveformSegment = {
  readonly startPx: number
  readonly endPx: number
  readonly canvasStartSec: number
  readonly canvasEndSec: number
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
  readonly data: WaveformSourceData
  readonly pointRadius: number
}

type Retained = {
  readonly data: WaveformSourceData
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
}

type Generation = {
  readonly entries: ReadonlyMap<string, Retained>
  readonly sourceIdentity: string
  readonly timingSignature: string
  readonly revision: number
}

type WaveformState = {
  readonly visible: Generation | null
  readonly replacement: Generation | null
}

const sourceIdentityFor = (assetKey: string, clip: RuntimeClip) => [
  clip.id,
  clip.sourceAssetKey ?? '',
  clip.sampleUrl ?? '',
  clip.sourceDurationSec ?? '',
  clip.sourceSampleRate ?? '',
  clip.sourceChannelCount ?? '',
  clip.buffer ? getAudioBufferSessionIdentity(clip.buffer) : '',
  assetKey,
].join('|')

const timingSignatureFor = (clip: RuntimeClip, bpm: number, duration: number) => JSON.stringify([
  clip.startSec,
  clip.duration,
  clip.bufferOffsetSec ?? 0,
  clip.leftPadSec ?? 0,
  clip.audioWarp?.enabled ?? false,
  clip.audioWarp?.mode ?? 'repitch',
  clip.audioWarp?.sourceBpm ?? bpm,
  clip.audioWarp?.sourceBeatOffset ?? 0,
  clip.audioWarp?.markers ?? [],
  bpm,
  duration,
])

const layoutSegmentsFor = (layout: ReturnType<typeof getAudioWaveformLayout>, clip: RuntimeClip) => (
  layout.segments ?? (layout.drawCols > 0
    ? [{
      drawCols: layout.drawCols,
      sourceStartSec: layout.sourceStartSec,
      sourceEndSec: layout.sourceEndSec,
      startPx: layout.padPx,
      endPx: layout.audioEndPx,
      canvasStartSec: layout.canvasStartSec ?? clip.startSec,
      canvasEndSec: layout.canvasEndSec ?? clip.startSec + clip.duration,
    }]
    : [])
)

export function useClipWaveformViewModel(options: ClipWaveformViewModelOptions) {
  const [source, setSource] = createSignal<Awaited<ReturnType<AudioPcmSourceResolver>> | null>(null)
  const [generation, setGeneration] = createSignal<WaveformState>({
    visible: null,
    replacement: null,
  })
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let sourceRequest = 0
  let dataRequest = 0
  let sourceCleanup: (() => void) | undefined
  let dataCleanup: (() => void) | undefined

  const view = createMemo(() => {
    const clip = options.clip()
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
    return { clip, assetKey, layout }
  })
  const displaySegments = createMemo(() => layoutSegmentsFor(view().layout, view().clip))
  const plans = createMemo<WaveformRequestPlans>(() => {
    const current = view()
    const currentSource = source()
    if (current.clip.midi || current.layout.sourceDurationSec <= 0 || options.waveformVisible?.() === false) {
      return { requests: [], segments: [] }
    }
    return createWaveformRequestPlans({
      segments: displaySegments(),
      sampleRate: currentSource?.sampleRate ?? current.clip.sourceSampleRate ?? 48_000,
      sourceDurationSec: current.layout.sourceDurationSec,
      sourceFrameCount: currentSource?.frameCount
        ?? Math.max(0, Math.round(current.layout.sourceDurationSec * (
          current.clip.sourceSampleRate ?? 48_000
        ))),
      backingPixelsPerCssPixel: options.backingPixelsPerCssPixel?.() ?? 1,
      priorityRange: options.priorityRange?.(),
    })
  })
  const planKey = createMemo(() => JSON.stringify(plans().requests))
  const sourceKey = createMemo(() => (
    `${sourceIdentityFor(view().assetKey, view().clip)}:${options.waveformVisible?.() ?? true}`
  ))

  createEffect(on(
    sourceKey,
    () => {
      const id = ++sourceRequest
      dataRequest += 1
      sourceCleanup?.()
      dataCleanup?.()
      if (options.waveformVisible?.() === false) {
        batch(() => {
          setSource(null)
          setGeneration({ visible: null, replacement: null })
          setLoading(false)
          setError(undefined)
        })
        return
      }
      const controller = new AbortController()
      sourceCleanup = () => controller.abort()
      batch(() => {
        setSource(null)
        setGeneration({ visible: null, replacement: null })
        setLoading(false)
        setError(undefined)
      })
      const resolver = options.resolveAudioSource()
      void resolver(view().clip, controller.signal, { verifyContentHash: true }).then((next) => {
        if (id === sourceRequest) setSource(next)
      }).catch(() => {
        if (id === sourceRequest && !controller.signal.aborted) {
          setSource(null)
          setLoading(false)
          setError('Waveform source is unavailable.')
        }
      })
    },
    { defer: false },
  ))

  createEffect(on(
    () => ({
      source: source(),
      key: JSON.stringify([
        planKey(),
        timingSignatureFor(view().clip, options.projectBpm(), view().layout.sourceDurationSec),
      ]),
    }),
    ({ source: nextSource }) => {
      const plan = plans()
      const current = view()
      if (!nextSource || plan.requests.length === 0) {
        dataRequest += 1
        dataCleanup?.()
        dataCleanup = undefined
        if (plan.requests.length === 0) setGeneration({ visible: null, replacement: null })
        setLoading(false)
        return
      }
      const timingSignature = timingSignatureFor(current.clip, options.projectBpm(), current.layout.sourceDurationSec)
      const previousState = untrack(generation)
      const visible = previousState.visible
      const seed = visible?.sourceIdentity === nextSource.identity
        ? visible.entries
        : new Map<string, Retained>()
      const targetEntries = new Map<string, Retained>()
      for (const request of plan.requests) {
        const retained = seed.get(request.key)
        if (retained) targetEntries.set(request.key, retained)
      }
      const target: Generation = {
        entries: targetEntries,
        sourceIdentity: nextSource.identity,
        timingSignature,
        revision: (visible?.revision ?? 0) + 1,
      }
      const missing = plan.requests.filter((request) => !targetEntries.has(request.key))
      if (missing.length === 0) {
        dataRequest += 1
        dataCleanup?.()
        dataCleanup = undefined
        setGeneration({ visible: target, replacement: null })
        setLoading(false)
        return
      }
      const id = ++dataRequest
      dataCleanup?.()
      const controller = new AbortController()
      dataCleanup = () => controller.abort()
      setLoading(true)
      setError(undefined)
      setGeneration({
        visible: visible?.sourceIdentity === nextSource.identity ? visible : null,
        replacement: target,
      })
      void Promise.all(missing.map(async (request) => {
        const data = await requestWaveformData({
          assetKey: current.assetKey,
          source: nextSource,
          sourceStartFrame: request.sourceStartFrame,
          sourceEndFrame: request.sourceEndFrame,
          framesPerInterval: request.framesPerInterval,
          priority: request.priority,
          signal: controller.signal,
        })
        return data ? { key: request.key, data } : null
      })).then((results) => {
        if (id !== dataRequest || controller.signal.aborted) return
        const additions = new Map(target.entries)
        for (const result of results) {
          if (!result) continue
          additions.set(result.key, {
            ...retainWaveformData(result.data),
          })
        }
        if (additions.size === 0) {
          setLoading(false)
          return
        }
        if (additions.size < plan.requests.length) {
          setLoading(false)
          setError('Waveform loading failed.')
          return
        }
        const latest = untrack(source)
        if (!latest || latest.identity !== nextSource.identity) return
        setGeneration({
          visible: {
            entries: additions,
            sourceIdentity: nextSource.identity,
            timingSignature,
            revision: target.revision,
          },
          replacement: null,
        })
        setLoading(false)
      }).catch((cause: unknown) => {
        if (id !== dataRequest || controller.signal.aborted) return
        setLoading(false)
        setError(cause instanceof Error ? cause.message : 'Waveform loading failed.')
      })
    },
    { defer: false },
  ))

  onCleanup(() => {
    sourceRequest += 1
    dataRequest += 1
    sourceCleanup?.()
    dataCleanup?.()
  })

  const segments = createMemo<ClipWaveformSegment[]>(() => {
    const current = view()
    const currentSource = source()
    const currentState = generation()
    const currentGeneration = currentState.visible
    if (!currentSource || !currentGeneration
      || currentGeneration.sourceIdentity !== currentSource.identity
      || current.clip.midi) return []
    const map = getAudioClipTimeMap({
      clip: current.clip,
      bufferDurationSec: current.layout.sourceDurationSec,
      projectBpm: options.projectBpm(),
      rangeStartSec: current.clip.startSec,
      rangeEndSec: current.clip.startSec + current.clip.duration,
    })
    if (!map) return []
    return projectRetainedWaveformData({
      retainedByKey: currentGeneration.entries,
      segments: plans().segments,
      map,
    }).map((projected) => {
      const segmentWidth = Math.max(1, projected.endPx - projected.startPx)
      const frameSpan = Math.max(1, projected.sourceEndFrame - projected.sourceStartFrame)
      return {
        startPx: projected.startPx,
        endPx: projected.endPx,
        canvasStartSec: projected.canvasStartSec,
        canvasEndSec: projected.canvasEndSec,
        sourceStartFrame: projected.sourceStartFrame,
        sourceEndFrame: projected.sourceEndFrame,
        data: projected.data,
        pointRadius: pointRadiusForPixelsPerSample(
          (segmentWidth * (options.backingPixelsPerCssPixel?.() ?? 1)) / frameSpan,
        ),
      }
    })
  })

  return {
    layout: () => view().layout,
    source,
    segments,
    renderRevision: () => generation().visible?.revision ?? 0,
    retainedResultCounts: () => ({
      current: generation().visible?.entries.size ?? 0,
      previous: generation().replacement?.entries.size ?? 0,
    }),
    loading,
    error,
  }
}
