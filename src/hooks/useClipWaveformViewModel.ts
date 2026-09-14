import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from 'solid-js'

import { getCachedWaveformSlice, getWaveformSlice } from '@daw-browser/waveforms/select-waveform-window'
import { arrangementWaveformPcmScheduler } from '@daw-browser/waveforms/arrangement-waveform-pcm'
import type { WaveformPeakChannelSlice, WaveformPcmResult } from '@daw-browser/waveforms/types'
import {
  lineBlendStartSamplesPerPixel,
  waveformVisualMixFor,
  type WaveformVisualMix,
} from '@daw-browser/waveforms/lod'
import {
  getAudioClipTimeMap,
} from '@daw-browser/timeline-core/audio-clip-time-map'
import {
  getAudioWaveformLayout,
} from '~/lib/audio-waveform-layout'
import {
  createWaveformRequestPlans,
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
  presentation: WaveformVisualMix
  opacity: number
}

export type ClipWaveformRenderSegment =
  | {
    mode: 'peaks'
    drawStartPx: number
    drawCols: number
    peaks: WaveformPeakChannelSlice
    canvasStartSec: number
    canvasEndSec: number
    opacity: number
  }
  | {
    mode: 'samples'
    drawStartPx: number
    drawCols: number
    samples: Extract<WaveformPcmResult, { mode: 'pcm-line' }>
    canvasStartSec: number
    canvasEndSec: number
    presentation: WaveformVisualMix
  }

type RetainedWaveform = {
  data: WaveformPcmResult
  sourceStartSec: number
  sourceEndSec: number
}

type WaveformGeneration = {
  resultsByKey: ReadonlyMap<string, RetainedWaveform>
  sourceIdentity: string
  timingSignature: string
  revision: number
}

type WaveformSnapshot = {
  current: WaveformGeneration | null
  previous: WaveformGeneration | null
  timingSignature: string
  sourceIdentity: string
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

const isLine = (data: RetainedWaveform) => data.data.mode === 'pcm-line'

const retainedEntries = (snapshot: WaveformSnapshot) => {
  const entries: Array<[string, RetainedWaveform]> = []
  const seen = new Set<string>()
  for (const generation of [snapshot.current, snapshot.previous]) {
    if (!generation) continue
    for (const entry of generation.resultsByKey) {
      if (seen.has(entry[0])) continue
      seen.add(entry[0])
      entries.push(entry)
    }
  }
  return entries
}

const fallbackEntryFor = (input: {
  segment: WaveformSegmentPlan
  mode: 'pcm-envelope' | 'pcm-line'
  snapshot: WaveformSnapshot
}) => {
  const exact = retainedEntries(input.snapshot).find(([key, retained]) => (
    key === input.segment.requestKey && (input.mode === 'pcm-line' ? isLine(retained) : !isLine(retained))
  ))
  if (exact) return exact
  const overlapping = retainedEntries(input.snapshot).find(([, retained]) => (
    (input.mode === 'pcm-line' ? isLine(retained) : !isLine(retained))
      && retained.sourceStartSec < input.segment.segment.sourceEndSec
      && retained.sourceEndSec > input.segment.segment.sourceStartSec
  ))
  if (overlapping) return overlapping
  return retainedEntries(input.snapshot).find(([, retained]) => (
    retained.sourceStartSec < input.segment.segment.sourceEndSec
      && retained.sourceEndSec > input.segment.segment.sourceStartSec
  ))
}

const projectRetainedEntry = (input: {
  entry: [string, RetainedWaveform]
  segment: WaveformSegmentPlan
  map: ReturnType<typeof getAudioClipTimeMap>
}) => projectRetainedWaveformData({
  retainedByKey: new Map([input.entry]),
  segments: [{ ...input.segment, requestKey: input.entry[0] }],
  map: input.map,
})[0]

const retainResultsForPlan = (input: {
  plan: WaveformRequestPlans
  base: ReadonlyMap<string, RetainedWaveform>
  additions: ReadonlyMap<string, RetainedWaveform>
}) => {
  const retained = new Map<string, RetainedWaveform>()
  const requestKeys = new Set(input.plan.requests.map((request) => request.key))
  for (const request of input.plan.requests) {
    const result = input.additions.get(request.key) ?? input.base.get(request.key)
    if (result) retained.set(request.key, result)
  }
  const refinement = [...input.additions, ...input.base].find(([key, result]) => (
    !requestKeys.has(key)
      && isLine(result)
      && input.plan.segments.some((segment) => (
        result.sourceStartSec < segment.segment.sourceEndSec
        && result.sourceEndSec > segment.segment.sourceStartSec
      ))
  ))
  if (refinement) retained.set(refinement[0], refinement[1])
  return retained
}

export function useClipWaveformViewModel(options: ClipWaveformViewModelOptions) {
  const [resolvedSource, setResolvedSource] = createSignal<Awaited<ReturnType<AudioPcmSourceResolver>> | null>(null)
  const [snapshot, setSnapshot] = createSignal<WaveformSnapshot>({
    current: null,
    previous: null,
    timingSignature: '',
    sourceIdentity: '',
    revision: 0,
  })
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let sourceRequestId = 0
  let dataRequestId = 0
  let sourceCleanup: (() => void) | undefined
  let dataCleanup: (() => void) | undefined
  let refinementCleanup: (() => void) | undefined
  let refinementState: {
    sourceIdentity: string
    timingSignature: string
    sourceStartSec: number
    sourceEndSec: number
    controller: AbortController
  } | undefined
  let resolvedSourceKey: string | undefined
  let resolvedSourceValue: Awaited<ReturnType<AudioPcmSourceResolver>> | undefined

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

  createEffect(on(
    () => ({
      source: resolvedSource(),
      planKey: requestPlanKey(),
      revision: snapshot().revision,
    }),
    ({ source }) => {
      const current = untrack(view)
      const timingSignature = timingSignatureFor(
        current.clip,
        untrack(options.projectBpm),
        current.layout.sourceDurationSec,
      )
      if (!source || options.mode === 'sample-detail') {
        refinementCleanup?.()
        refinementCleanup = undefined
        refinementState = undefined
        return
      }
      const plan = requestPlan()
      const target = plan.requests.find((request) => (
        request.lod.mode !== 'pcm-line'
          && request.lod.samplesPerPixel <= lineBlendStartSamplesPerPixel
      ))
      if (!target) return
      const tileSpan = Math.ceil(
        (target.sourceEndSec - target.sourceStartSec) * source.sampleRate / 16_384,
      )
      if (tileSpan > 2) return
      if (refinementState) {
        const invalid = refinementState.sourceIdentity !== source.identity
          || refinementState.timingSignature !== timingSignature
          || refinementState.sourceEndSec <= target.sourceStartSec
          || refinementState.sourceStartSec >= target.sourceEndSec
        if (invalid) {
          refinementCleanup?.()
          refinementCleanup = undefined
          refinementState = undefined
        } else {
          return
        }
      }
      const currentSnapshot = untrack(snapshot)
      const hasEnvelope = retainedEntries(currentSnapshot).some(([, retained]) => (
        !isLine(retained)
          && retained.sourceStartSec < target.sourceEndSec
          && retained.sourceEndSec > target.sourceStartSec
      ))
      if (!hasEnvelope) return
      const hasLine = retainedEntries(currentSnapshot).some(([, retained]) => (
        isLine(retained)
          && retained.sourceStartSec < target.sourceEndSec
          && retained.sourceEndSec > target.sourceStartSec
      ))
      if (hasLine) return
      const controller = new AbortController()
      refinementCleanup = () => controller.abort()
      refinementState = {
        sourceIdentity: source.identity,
        timingSignature,
        sourceStartSec: target.sourceStartSec,
        sourceEndSec: target.sourceEndSec,
        controller,
      }
      void arrangementWaveformPcmScheduler.request({
        assetKey: view().assetKey,
        sourceIdentity: source.identity,
        source: async () => source,
        sourceStartSec: target.sourceStartSec,
        sourceEndSec: target.sourceEndSec,
        columns: 1,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
        mode: 'pcm-line',
        exactRange: false,
        priority: 0,
        signal: controller.signal,
      }).then((result) => {
        if (refinementState?.controller === controller) {
          refinementState = undefined
          refinementCleanup = undefined
        }
        if (!result || controller.signal.aborted) return
        const current = untrack(view)
        const latest = untrack(snapshot)
        const timingSignature = timingSignatureFor(
          current.clip,
          untrack(options.projectBpm),
          current.layout.sourceDurationSec,
        )
        const stillVisible = untrack(displaySegments).some((segment) => (
          segment.sourceStartSec < target.sourceEndSec
          && segment.sourceEndSec > target.sourceStartSec
        ))
        if (latest.sourceIdentity !== source.identity
          || latest.timingSignature !== timingSignature
          || !stillVisible
          || !latest.current) return
        const key = [
          target.sourceStartSec,
          target.sourceEndSec,
          'pcm-line',
          'tile',
          1,
          untrack(densityBucket),
        ].join(':')
        const additions = new Map<string, RetainedWaveform>([[key, {
          data: result,
          sourceStartSec: result.sourceStartSec,
          sourceEndSec: result.sourceEndSec,
        }]])
        const latestPlan = untrack(requestPlan)
        setSnapshot((previous) => {
          if (!previous.current) return previous
          const revision = previous.revision + 1
          const resultsByKey = retainResultsForPlan({
            plan: latestPlan,
            base: previous.current.resultsByKey,
            additions,
          })
          return {
            ...previous,
            revision,
            current: {
              ...previous.current,
              resultsByKey,
              revision,
            },
          }
        })
      }).catch(() => {
        if (refinementState?.controller === controller) {
          refinementState = undefined
          refinementCleanup = undefined
        }
      })
    },
  ))

  createEffect(on(
    () => ({
      key: sourceKey(),
      visible: options.waveformVisible?.() !== false,
    }),
    ({ key, visible }) => {
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
    () => ({
      source: resolvedSource(),
      planKey: requestPlanKey(),
    }),
    ({ source }) => {
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
      const currentSnapshot = untrack(snapshot)
      const timingChanged = currentSnapshot.timingSignature !== ''
        && currentSnapshot.timingSignature !== timingSignature
      const sourceChanged = currentSnapshot.sourceIdentity !== ''
        && source?.identity !== currentSnapshot.sourceIdentity
      if (timingChanged || sourceChanged) {
        refinementCleanup?.()
        refinementCleanup = undefined
        refinementState = undefined
        setSnapshot((previous) => ({
          current: null,
          previous: null,
          timingSignature,
          sourceIdentity: source?.identity ?? '',
          revision: previous.revision + 1,
        }))
      }
      const currentDataRequestId = ++dataRequestId
      dataCleanup?.()
      if (!source || plan.requests.length === 0) {
        setLoading(false)
        if (!source) {
          setSnapshot((previous) => ({
            current: null,
            previous: null,
            timingSignature,
            sourceIdentity: '',
            revision: previous.revision + 1,
          }))
        }
        return
      }
      const sourceIdentity = source.identity
      const baseGenerationCandidate = untrack(snapshot).current
      const baseGeneration = timingChanged
        || (baseGenerationCandidate && baseGenerationCandidate.sourceIdentity !== source.identity)
        ? null
        : baseGenerationCandidate
      const reusableResults = new Map(baseGeneration?.resultsByKey ?? [])
      const previousGeneration = untrack(snapshot).previous
      if (previousGeneration
        && previousGeneration.sourceIdentity === source.identity
        && previousGeneration.timingSignature === timingSignature) {
        for (const [key, retained] of previousGeneration.resultsByKey) {
          if (!reusableResults.has(key)) reusableResults.set(key, retained)
        }
      }
      const missingRequests = plan.requests.filter((item) => !reusableResults.has(item.key))
      const needsPublication = plan.requests.some((item) => !baseGeneration?.resultsByKey.has(item.key))
      if (missingRequests.length === 0 && !needsPublication) {
        setLoading(false)
        return
      }
      const controller = new AbortController()
      dataCleanup = () => controller.abort()
      const midpointByKey = new Map(plan.segments.map((segment) => [
        segment.requestKey,
        (segment.segment.canvasStartSec + segment.segment.canvasEndSec) / 2,
      ]))
      setLoading(true)
      setError(undefined)
      void Promise.all(missingRequests.map(async (item) => {
        const identity = {
          assetKey: currentAssetKey,
          identity: source.identity,
          durationSec: source.durationSec,
          sampleRate: source.sampleRate,
          channelCount: source.channelCount,
        }
        if (item.lod.mode === 'cached-peaks') {
          const request = {
            assetKey: currentAssetKey,
            sourceIdentity: identity,
            sourceStartSec: item.sourceStartSec,
            sourceEndSec: item.sourceEndSec,
            bins: item.bins,
            signal: controller.signal,
          }
          const result = await getWaveformSlice({ ...request, source })
            ?? await getCachedWaveformSlice(request).catch(() => null)
          return result ? { key: item.key, data: result } : null
        }
        const result = await arrangementWaveformPcmScheduler.request({
          assetKey: currentAssetKey,
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
        return result ? { key: item.key, data: result } : null
      })).then((results) => {
        if (currentDataRequestId !== dataRequestId || controller.signal.aborted) return
        const additions = new Map<string, RetainedWaveform>()
        for (const result of results) {
          if (!result) continue
          additions.set(result.key, {
            data: result.data,
            sourceStartSec: result.data.sourceStartSec,
            sourceEndSec: result.data.sourceEndSec,
          })
        }
        const resultsByKey = retainResultsForPlan({
          plan,
          base: reusableResults,
          additions,
        })
        if (resultsByKey.size > 0) {
          const latest = untrack(view)
          const latestTimingSignature = timingSignatureFor(
            latest.clip,
            projectBpm,
            latest.layout.sourceDurationSec,
          )
          setSnapshot((previous) => {
            const revision = previous.revision + 1
            return {
              current: {
                resultsByKey,
                sourceIdentity,
                timingSignature: latestTimingSignature,
                revision,
              },
              previous: previous.current,
              timingSignature: latestTimingSignature,
              sourceIdentity,
              revision,
            }
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
    refinementCleanup?.()
  })

  const projectedSegments = createMemo<ClipWaveformSegment[]>(() => {
    const current = view()
    const currentSnapshot = snapshot()
    if (current.midi || !currentSnapshot.current || currentSnapshot.sourceIdentity === '') return []
    const map = getAudioClipTimeMap({
      clip: current.clip,
      bufferDurationSec: current.layout.sourceDurationSec,
      projectBpm: options.projectBpm(),
      rangeStartSec: current.clip.startSec,
      rangeEndSec: current.clip.startSec + current.clip.duration,
    })
    if (!map) return []
    const plan = requestPlan()
    const lodByKey = new Map(plan.requests.map((request) => [request.key, request.lod]))
    const projected: ClipWaveformSegment[] = []
    for (const segment of plan.segments) {
      const lod = lodByKey.get(segment.requestKey)
      if (!lod) continue
      const sampleRate = resolvedSource()?.sampleRate
        ?? current.clip.sourceSampleRate
        ?? 48_000
      const sourceDuration = Math.max(0, segment.segment.sourceEndSec - segment.segment.sourceStartSec)
      const screenWidth = Math.max(1e-9, segment.segment.endPx - segment.segment.startPx)
      const samplesPerPixel = sourceDuration * sampleRate / screenWidth
      const mix = waveformVisualMixFor({
        samplesPerPixel,
        pixelsPerSample: 1 / samplesPerPixel,
      })
      const lineEntry = fallbackEntryFor({ segment, mode: 'pcm-line', snapshot: currentSnapshot })
      const envelopeEntry = fallbackEntryFor({ segment, mode: 'pcm-envelope', snapshot: currentSnapshot })
      const line = lineEntry && isLine(lineEntry[1])
        ? projectRetainedEntry({ entry: lineEntry, segment, map })
        : undefined
      const envelope = envelopeEntry && !isLine(envelopeEntry[1])
        ? projectRetainedEntry({ entry: envelopeEntry, segment, map })
        : undefined
      if (envelope?.data.mode === 'pcm-envelope') {
        projected.push({
          startPx: envelope.startPx,
          endPx: envelope.endPx,
          canvasStartSec: envelope.canvasStartSec,
          canvasEndSec: envelope.canvasEndSec,
          sourceStartSec: envelope.sourceStartSec,
          sourceEndSec: envelope.sourceEndSec,
          peaks: envelope.data,
          pcm: null,
          presentation: mix,
          opacity: line ? mix.envelopeOpacity : 1,
        })
      }
      if (line?.data.mode === 'pcm-line') {
        projected.push({
          startPx: line.startPx,
          endPx: line.endPx,
          canvasStartSec: line.canvasStartSec,
          canvasEndSec: line.canvasEndSec,
          sourceStartSec: line.sourceStartSec,
          sourceEndSec: line.sourceEndSec,
          peaks: null,
          pcm: line.data,
          presentation: mix,
          opacity: line ? (envelope ? mix.lineOpacity : 1) : 0,
        })
      }
    }
    return projected
  })

  const renderSegments = createMemo<ClipWaveformRenderSegment[]>(() => {
    const rendered: ClipWaveformRenderSegment[] = []
    for (const segment of projectedSegments()) {
      if (segment.pcm?.mode === 'pcm-line' && segment.opacity > 0) {
        rendered.push({
        mode: 'samples',
        drawStartPx: segment.startPx,
        drawCols: segment.endPx - segment.startPx,
        samples: segment.pcm,
        canvasStartSec: segment.canvasStartSec,
        canvasEndSec: segment.canvasEndSec,
        presentation: {
          ...segment.presentation,
          lineOpacity: segment.opacity,
        },
        })
        continue
      }
      if (segment.peaks && segment.opacity > 0) {
        rendered.push({
        mode: 'peaks',
        drawStartPx: segment.startPx,
        drawCols: Math.max(1, Math.ceil(segment.endPx - segment.startPx)),
        peaks: segment.peaks,
        canvasStartSec: segment.canvasStartSec,
        canvasEndSec: segment.canvasEndSec,
        opacity: segment.opacity,
        })
      }
    }
    return rendered
  })

  const peaks = createMemo(() => {
    const segments = projectedSegments()
    return segments.length === 1 ? segments[0]?.peaks ?? null : null
  })
  const pcm = createMemo(() => {
    const segments = projectedSegments()
    return segments.length === 1 ? segments[0]?.pcm ?? null : null
  })

  return {
    layout: () => view().layout,
    peaks,
    pcm,
    segments: projectedSegments,
    renderSegments,
    renderRevision: () => snapshot().revision,
    retainedResultCounts: () => ({
      current: snapshot().current?.resultsByKey.size ?? 0,
      previous: snapshot().previous?.resultsByKey.size ?? 0,
    }),
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
