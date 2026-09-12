import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js'

import { getCachedWaveformSlice, getWaveformSlice } from '@daw-browser/waveforms/select-waveform-window'
import { arrangementWaveformPcmScheduler } from '@daw-browser/waveforms/arrangement-waveform-pcm'
import type { WaveformPeakChannelSlice, WaveformPcmResult } from '@daw-browser/waveforms/types'
import {
  getAudioClipTimeMap,
  getMarkerWarpTimelineSegments,
} from '@daw-browser/timeline-core/audio-clip-time-map'
import {
  getAudioWaveformLayout,
} from '~/lib/audio-waveform-layout'
import {
  createWaveformRequestPlans,
  createRetainedRasterLayout,
  densityBucketFor,
  projectRetainedWaveformData,
  type WaveformRequestPlans,
  type WaveformSegmentPlan,
} from '~/lib/retained-waveform'
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
  waveformVisible?: Accessor<boolean>
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

type RetainedWaveform = {
  data: WaveformPcmResult
  sourceStartSec: number
  sourceEndSec: number
  showPoints: boolean
}

export type ClipWaveformRaster = {
  timelineStartSec: number
  timelineEndSec: number
  pixelsPerSecond: number
  widthPx: number
  timingSignature: string
  dataRevision: number
}

type WaveformSnapshot = {
  resultsByKey: ReadonlyMap<string, RetainedWaveform>
  rasterLayout: readonly WaveformSegmentPlan[]
  raster: ClipWaveformRaster | null
  revision: number
}

const sourceIdentityKey = (assetKey: string, clip: RuntimeClip) => [
  clip.id,
  clip.sourceAssetKey ?? '',
  clip.sampleUrl ?? '',
  clip.sourceDurationSec ?? '',
  clip.sourceSampleRate ?? '',
  clip.sourceChannelCount ?? '',
  assetKey,
  'verified',
].join('|')

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

const timingSignatureFor = (clip: RuntimeClip, projectBpm: number, sourceDurationSec: number) => JSON.stringify([
  clip.startSec,
  clip.duration,
  clip.bufferOffsetSec ?? 0,
  clip.leftPadSec ?? 0,
  clip.audioWarp?.enabled ?? false,
  clip.audioWarp?.mode ?? 'repitch',
  clip.audioWarp?.sourceBpm ?? projectBpm,
  clip.audioWarp?.sourceBeatOffset ?? 0,
  clip.audioWarp?.markers ?? [],
  projectBpm,
  sourceDurationSec,
])

const createRasterGeometry = (input: {
  plan: WaveformRequestPlans
  retainedByKey?: ReadonlyMap<string, RetainedWaveform>
  clip: RuntimeClip
  sourceDurationSec: number
  projectBpm: number
  pixelsPerSecond: number
}) => {
  const map = getAudioClipTimeMap({
    clip: input.clip,
    bufferDurationSec: input.sourceDurationSec,
    projectBpm: input.projectBpm,
    rangeStartSec: input.clip.startSec,
    rangeEndSec: input.clip.startSec + input.clip.duration,
  })
  const markerSegments = map
    ? getMarkerWarpTimelineSegments({
      clip: input.clip,
      map,
      projectBpm: input.projectBpm,
      timelineEndSec: map.timelineEndSec,
    })
    : []
  const canonicalSegments = markerSegments.length > 0
    ? markerSegments.map((segment) => ({
      ...segment,
      canvasStartSec: segment.timelineStartSec,
      canvasEndSec: segment.timelineEndSec,
    }))
    : map
      ? [{
        sourceStartSec: map.sourceStartSec,
        sourceEndSec: map.sourceEndSec,
        canvasStartSec: map.sourceToTimelineSec(map.sourceStartSec),
        canvasEndSec: map.sourceToTimelineSec(map.sourceEndSec),
      }]
      : []
  const rasterWindow = createRetainedRasterLayout({
    plan: input.plan,
    map,
    pixelsPerSecond: input.pixelsPerSecond,
    coverageByKey: input.retainedByKey,
    canonicalSegments,
  })
  if (!rasterWindow) return null
  return {
    timelineStartSec: rasterWindow.timelineStartSec,
    timelineEndSec: rasterWindow.timelineEndSec,
    pixelsPerSecond: rasterWindow.pixelsPerSecond,
    widthPx: Math.max(
      1,
      Math.ceil((rasterWindow.timelineEndSec - rasterWindow.timelineStartSec) * rasterWindow.pixelsPerSecond),
    ),
    rasterLayout: rasterWindow.segments,
  }
}

export function useClipWaveformViewModel(options: ClipWaveformViewModelOptions) {
  const [resolvedSource, setResolvedSource] = createSignal<Awaited<ReturnType<AudioPcmSourceResolver>> | null>(null)
  const [snapshot, setSnapshot] = createSignal<WaveformSnapshot>({
    resultsByKey: new Map(),
    rasterLayout: [],
    raster: null,
    revision: 0,
  })
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let sourceRequestId = 0
  let dataRequestId = 0
  let sourceCleanup: (() => void) | undefined
  let dataCleanup: (() => void) | undefined
  let resolvedSourceKey: string | undefined
  let resolvedSourceValue: Awaited<ReturnType<AudioPcmSourceResolver>> | undefined
  let dataRevision = 0

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
    return { assetKey, clip, layout, midi: clip.midi }
  })

  const displaySegments = createMemo(() => layoutSegmentsFor(view().layout, view().clip))
  const desiredDensity = createMemo(() => Math.max(
    1,
    ...displaySegments().map((segment) => segment.drawCols),
  ))
  const [densityBucket, setDensityBucket] = createSignal(0)
  createEffect(on(
    desiredDensity,
    (requested) => setDensityBucket((current) => densityBucketFor(requested, current)),
  ))

  const requestPlan = createMemo<WaveformRequestPlans>(() => {
    const current = view()
    if (current.midi || current.layout.sourceDurationSec <= 0 || options.waveformVisible?.() === false) {
      return { requests: [], segments: [] }
    }
    const sampleRate = current.clip.sourceSampleRate ?? 48_000
    return createWaveformRequestPlans({
      segments: displaySegments(),
      sampleRate,
      sourceDurationSec: current.layout.sourceDurationSec,
      sampleDetail: options.mode === 'sample-detail',
      densityBucket: densityBucket() || densityBucketFor(desiredDensity()),
    })
  })
  const requestPlanKey = createMemo(() => JSON.stringify([
    requestPlan().requests.map((item) => item.key),
    timingSignatureFor(view().clip, options.projectBpm(), view().layout.sourceDurationSec),
  ]))
  const sourceKey = createMemo(() => {
    const clip = options.clip()
    const assetKey = clip.waveformAssetKey ?? clip.sourceAssetKey ?? `clip:${clip.id}`
    return sourceIdentityKey(assetKey, clip)
  })
  const rasterGeometryKey = createMemo(() => JSON.stringify(
    requestPlan().segments.map((item) => [
      item.requestKey,
      item.segment.sourceStartSec,
      item.segment.sourceEndSec,
      item.segment.canvasStartSec,
      item.segment.canvasEndSec,
      item.segment.startPx,
      item.segment.endPx,
    ]),
  ))

  createEffect(on(
    rasterGeometryKey,
    () => {
      const current = view()
      const plan = requestPlan()
      const previous = untrack(snapshot)
      const currentRaster = previous.raster
      if (!currentRaster
        || previous.resultsByKey.size === 0
        || plan.requests.some((request) => !previous.resultsByKey.has(request.key))
        || plan.segments.length === 0) return
      const map = getAudioClipTimeMap({
        clip: current.clip,
        bufferDurationSec: current.layout.sourceDurationSec,
        projectBpm: options.projectBpm(),
        rangeStartSec: current.clip.startSec,
        rangeEndSec: current.clip.startSec + current.clip.duration,
      })
      if (!map) return
      const displayStartSec = Math.min(
        ...plan.segments.map((item) => map.sourceToTimelineSec(item.segment.sourceStartSec)),
      )
      const displayEndSec = Math.max(
        ...plan.segments.map((item) => map.sourceToTimelineSec(item.segment.sourceEndSec)),
      )
      if (displayStartSec >= currentRaster.timelineStartSec
        && displayEndSec <= currentRaster.timelineEndSec) return
      const currentStart = current.layout.canvasStartSec ?? current.clip.startSec
      const currentEnd = current.layout.canvasEndSec
        ?? current.clip.startSec + current.clip.duration
      const geometry = createRasterGeometry({
        plan,
        retainedByKey: previous.resultsByKey,
        clip: current.clip,
        sourceDurationSec: current.layout.sourceDurationSec,
        projectBpm: options.projectBpm(),
        pixelsPerSecond: options.cssWidthPx() / Math.max(1e-6, currentEnd - currentStart),
      })
      if (!geometry) return
      setSnapshot((latest) => {
        if (!latest.raster || latest.raster.dataRevision !== currentRaster.dataRevision) return latest
        return {
          ...latest,
          rasterLayout: geometry.rasterLayout,
          raster: {
            timelineStartSec: geometry.timelineStartSec,
            timelineEndSec: geometry.timelineEndSec,
            pixelsPerSecond: geometry.pixelsPerSecond,
            widthPx: geometry.widthPx,
            timingSignature: latest.raster.timingSignature,
            dataRevision: latest.raster.dataRevision,
          },
        }
      })
    },
  ))
  createEffect(on(
    () => [sourceKey(), options.waveformVisible?.() !== false] as const,
    ([key, visible]) => {
    const currentRequestId = ++sourceRequestId
    sourceCleanup?.()
    if (!visible) {
      setResolvedSource(null)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    sourceCleanup = () => controller.abort()
    const current = untrack(view)
    if (resolvedSourceKey !== key) setResolvedSource(null)
    const source = resolvedSourceKey === key && resolvedSourceValue
      ? Promise.resolve(resolvedSourceValue)
      : options.resolveAudioSource()(current.clip, controller.signal, { verifyContentHash: true })
    void source.then((next) => {
      if (currentRequestId !== sourceRequestId) return
      resolvedSourceKey = key
      resolvedSourceValue = next
      setResolvedSource(next)
    }).catch((cause) => {
      if (currentRequestId !== sourceRequestId
        || controller.signal.aborted
        || isAbortError(cause instanceof Error ? cause : new Error())) return
      setResolvedSource(null)
      setError(sanitizeWaveformError(cause instanceof Error ? cause : new Error('Waveform loading failed.')))
    })
    },
  ))

  createEffect(on(
    () => [resolvedSource(), requestPlanKey()] as const,
    ([source]) => {
      const plan = requestPlan()
      const current = view()
      const currentAssetKey = current.assetKey
      const waveformMode = options.mode
      const priorityRange = options.priorityRange?.()
      const projectBpm = options.projectBpm()
      const timingSignature = timingSignatureFor(
        current.clip,
        projectBpm,
        current.layout.sourceDurationSec,
      )
      if (untrack(snapshot).raster?.timingSignature !== timingSignature) {
        setSnapshot((previous) => ({
          ...previous,
          resultsByKey: new Map(),
          raster: null,
          rasterLayout: [],
          revision: previous.revision + 1,
        }))
      }
      const currentDataRequestId = ++dataRequestId
      dataCleanup?.()
      if (!source || plan.requests.length === 0) {
        setLoading(false)
        if (!source) {
          setSnapshot((previous) => ({
            ...previous,
            resultsByKey: new Map(),
            rasterLayout: [],
            raster: null,
            revision: previous.revision + 1,
          }))
        }
        return
      }
      const controller = new AbortController()
      dataCleanup = () => controller.abort()
      const assetKey = currentAssetKey
      const midpointByKey = new Map(plan.segments.map((segment) => [
        segment.requestKey,
        (segment.segment.canvasStartSec + segment.segment.canvasEndSec) / 2,
      ]))
      setLoading(true)
      setError(undefined)
      void Promise.all(plan.requests.map(async (item) => {
        const identity = {
          assetKey,
          identity: source.identity,
          durationSec: source.durationSec,
          sampleRate: source.sampleRate,
          channelCount: source.channelCount,
        }
        if (item.lod.mode === 'cached-peaks') {
          const request = {
            assetKey,
            sourceIdentity: identity,
            sourceStartSec: item.sourceStartSec,
            sourceEndSec: item.sourceEndSec,
            bins: item.bins,
            signal: controller.signal,
          }
          const result = await getWaveformSlice({ ...request, source })
            ?? await getCachedWaveformSlice(request).catch(() => null)
          return result
            ? { key: item.key, data: result, showPoints: false }
            : null
        }
        const result = await arrangementWaveformPcmScheduler.request({
          assetKey,
          sourceIdentity: source.identity,
          source: async () => source,
          sourceStartSec: item.sourceStartSec,
          sourceEndSec: item.sourceEndSec,
          columns: item.bins,
          sampleRate: source.sampleRate,
          channelCount: source.channelCount,
            mode: item.lod.mode,
          exactRange: waveformMode === 'sample-detail',
          priority: waveformMode === 'sample-detail'
            ? 0
            : Math.abs(
              (midpointByKey.get(item.key)
                ?? current.clip.startSec + current.clip.duration / 2)
                - (
                  (priorityRange?.startSec ?? current.clip.startSec)
                  + (priorityRange?.endSec ?? current.clip.startSec + current.clip.duration)
                ) / 2,
            ),
          signal: controller.signal,
        })
        return result
          ? { key: item.key, data: result, showPoints: item.lod.mode === 'pcm-line' && item.lod.showPoints }
          : null
      })).then((results) => {
        if (currentDataRequestId !== dataRequestId || controller.signal.aborted) return
        const resultsByKey = new Map<string, RetainedWaveform>()
        for (const result of results) {
          if (!result) continue
          resultsByKey.set(result.key, {
            data: result.data,
            sourceStartSec: result.data.sourceStartSec,
            sourceEndSec: result.data.sourceEndSec,
            showPoints: result.showPoints,
          })
        }
        if (resultsByKey.size > 0) {
          const latest = untrack(view)
          const currentStart = latest.layout.canvasStartSec ?? latest.clip.startSec
          const currentEnd = latest.layout.canvasEndSec
            ?? latest.clip.startSec + latest.clip.duration
          const currentDuration = Math.max(1e-6, currentEnd - currentStart)
          const currentPixelsPerSecond = options.cssWidthPx() / currentDuration
          const rasterGeometry = createRasterGeometry({
            plan,
            retainedByKey: resultsByKey,
            clip: latest.clip,
            sourceDurationSec: latest.layout.sourceDurationSec,
            projectBpm,
            pixelsPerSecond: currentPixelsPerSecond,
          })
          if (!rasterGeometry) return
          dataRevision += 1
          setSnapshot({
            resultsByKey,
            rasterLayout: rasterGeometry.rasterLayout,
            raster: {
            timelineStartSec: rasterGeometry.timelineStartSec,
            timelineEndSec: rasterGeometry.timelineEndSec,
            pixelsPerSecond: rasterGeometry.pixelsPerSecond,
            widthPx: rasterGeometry.widthPx,
            timingSignature: timingSignatureFor(
              latest.clip,
              projectBpm,
              latest.layout.sourceDurationSec,
            ),
              dataRevision,
            },
            revision: dataRevision,
          })
        }
        setLoading(false)
      }).catch((cause) => {
        if (currentDataRequestId !== dataRequestId
          || controller.signal.aborted
          || isAbortError(cause instanceof Error ? cause : new Error())) return
        setLoading(false)
        setError(sanitizeWaveformError(cause instanceof Error ? cause : new Error('Waveform loading failed.')))
      })
    },
  ))

  onCleanup(() => {
    sourceRequestId += 1
    dataRequestId += 1
    sourceCleanup?.()
    dataCleanup?.()
  })

  const projectedSegments = createMemo<ClipWaveformSegment[]>(() => {
    const current = view()
    if (current.midi || snapshot().resultsByKey.size === 0) return []
    const map = getAudioClipTimeMap({
      clip: current.clip,
      bufferDurationSec: current.layout.sourceDurationSec,
      projectBpm: options.projectBpm(),
      rangeStartSec: current.clip.startSec,
      rangeEndSec: current.clip.startSec + current.clip.duration,
    })
    const plan = requestPlan()
    const projectionSegments = options.mode === 'sample-detail'
      ? plan.segments.map((item) => {
        if (snapshot().resultsByKey.has(item.requestKey)) return item
        const retainedKey = [...snapshot().resultsByKey.entries()].find(([, retained]) => (
          retained.sourceStartSec < item.segment.sourceEndSec
          && retained.sourceEndSec > item.segment.sourceStartSec
        ))?.[0]
        return retainedKey ? { ...item, requestKey: retainedKey } : item
      })
      : plan.segments
    const projected = projectRetainedWaveformData({
      retainedByKey: snapshot().resultsByKey,
      segments: projectionSegments,
      map,
    })
    return projected.map((item) => {
      const showPoints = item.requestKey
        ? snapshot().resultsByKey.get(item.requestKey)?.showPoints ?? false
        : false
      return {
        startPx: item.startPx,
        endPx: item.endPx,
        canvasStartSec: item.canvasStartSec,
        canvasEndSec: item.canvasEndSec,
        sourceStartSec: item.sourceStartSec,
        sourceEndSec: item.sourceEndSec,
        peaks: item.data.mode === 'pcm-envelope' ? item.data : null,
        pcm: item.data.mode === 'pcm-line' ? item.data : null,
        showPoints,
      }
    })
  })

  const rasterSegments = createMemo<ClipWaveformSegment[]>(() => {
    const currentRaster = snapshot().raster
    if (!currentRaster) return []
    const current = view()
    const map = getAudioClipTimeMap({
      clip: current.clip,
      bufferDurationSec: current.layout.sourceDurationSec,
      projectBpm: options.projectBpm(),
      rangeStartSec: current.clip.startSec,
      rangeEndSec: current.clip.startSec + current.clip.duration,
    })
    const layoutSegments = snapshot().rasterLayout
    const projected = projectRetainedWaveformData({
      retainedByKey: snapshot().resultsByKey,
      segments: layoutSegments,
      map,
    })
    return projected.map((item) => ({
      startPx: (item.canvasStartSec - currentRaster.timelineStartSec) * currentRaster.pixelsPerSecond,
      endPx: (item.canvasEndSec - currentRaster.timelineStartSec) * currentRaster.pixelsPerSecond,
      canvasStartSec: item.canvasStartSec,
      canvasEndSec: item.canvasEndSec,
      sourceStartSec: item.sourceStartSec,
      sourceEndSec: item.sourceEndSec,
      peaks: item.data.mode === 'pcm-envelope' ? item.data : null,
      pcm: item.data.mode === 'pcm-line' ? item.data : null,
      showPoints: item.requestKey
        ? snapshot().resultsByKey.get(item.requestKey)?.showPoints ?? false
        : false,
    }))
  })

  const renderSegments = createMemo<ClipWaveformRenderSegment[]>(() => (
    (options.mode === 'sample-detail'
      ? projectedSegments()
      : rasterSegments().length > 0 ? rasterSegments() : projectedSegments())
      .flatMap<ClipWaveformRenderSegment>((segment) => {
      if (segment.pcm?.mode === 'pcm-line') {
        return [{
          mode: 'samples' as const,
          drawStartPx: segment.startPx,
          drawCols: segment.endPx - segment.startPx,
          samples: segment.pcm,
          showPoints: segment.showPoints,
        }]
      }
      if (segment.peaks) {
        return [{
          mode: 'peaks' as const,
          drawStartPx: segment.startPx,
          drawCols: Math.max(1, Math.ceil(segment.endPx - segment.startPx)),
          peaks: segment.peaks,
        }]
      }
      return []
      })
  ))

  const peaks = createMemo(() => {
    const segments = projectedSegments()
    return segments.length === 1 ? segments[0]?.peaks ?? null : null
  })
  const pcm = createMemo(() => {
    const segments = projectedSegments()
    return segments.length === 1 ? segments[0]?.pcm ?? null : null
  })
  const rasterDataRevision = createMemo(() => snapshot().raster?.dataRevision)

  return {
    layout: () => view().layout,
    peaks,
    pcm,
    segments: projectedSegments,
    raster: () => snapshot().raster,
    rasterDataRevision,
    rasterSegments,
    renderSegments,
    loading,
    error,
  }
}

const sanitizeWaveformError = (error: Error) => {
  const message = error.message
  if (message.includes('incomplete or malformed')) return 'Waveform peak storage is incomplete or malformed.'
  if (message.toLowerCase().includes('permission')) return 'Waveform source permission was denied.'
  if (message.toLowerCase().includes('missing')) return 'Waveform source is unavailable.'
  return 'Waveform loading failed.'
}

const isAbortError = (error: Error) => error.name === 'AbortError'
