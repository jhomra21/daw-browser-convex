import { describe, expect, test } from 'bun:test'
import { createEffect, createRoot, createSignal, untrack } from 'solid-js'

import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import { createWaveformRequestPlans } from '~/lib/retained-waveform'
import { useClipWaveformViewModel } from './useClipWaveformViewModel'

type Deferred<Value> = { promise: Promise<Value>; resolve: (value: Value) => void }
type ReadCounters = { reads: number; aborts: number; ranges: string[] }

const deferred = <Value>(): Deferred<Value> => {
  let resolve: (value: Value) => void = () => {}
  const promise = new Promise<Value>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}
const flushEffects = async () => { await Promise.resolve(); await Promise.resolve() }
const createReadCounters = (): ReadCounters => ({ reads: 0, aborts: 0, ranges: [] })
const waitForReady = (waveform: ReturnType<typeof useClipWaveformViewModel>) => new Promise<void>((resolve) => {
  let sawLoading = false
  createEffect(() => { if (waveform.loading()) sawLoading = true; else if (sawLoading) resolve() })
})
const createSource = (input: {
  identity: string
  durationSec?: number
  sampleRate?: number
  gate?: Deferred<void>
  counters?: ReadCounters
}): AudioPcmSourceDescriptor => {
  const durationSec = input.durationSec ?? 1
  const sampleRate = input.sampleRate ?? 48_000
  const frameCount = Math.ceil(durationSec * sampleRate)
  return {
    identity: input.identity, durationSec, frameCount, sampleRate, channelCount: 1,
    readPages: async function* (options = {}) {
      if (input.counters) input.counters.reads += 1
      const startFrame = options.startFrame ?? 0
      const endFrame = options.endFrame ?? frameCount
      options.signal?.addEventListener('abort', () => { if (input.counters) input.counters.aborts += 1 }, { once: true })
      input.counters?.ranges.push(`${startFrame}:${endFrame}`)
      if (input.gate) await input.gate.promise
      options.signal?.throwIfAborted()
      const samples = new Float32Array(Math.max(1, endFrame - startFrame))
      yield { startFrame, frameCount: samples.length, sampleRate, channelCount: 1, planes: [samples] }
    },
  }
}
const clip: RuntimeClip = {
  id: 'clip:waveform-browser-regression', name: 'Waveform browser regression', startSec: 0, duration: 1,
  sourceAssetKey: 'asset:waveform-browser-regression', sourceDurationSec: 1, sourceSampleRate: 48_000,
  sourceChannelCount: 1, color: '#ffffff',
}
const slicedClip: RuntimeClip = {
  ...clip,
  id: 'clip:waveform-render-segment-timing',
  startSec: 4,
  duration: 4,
  sourceAssetKey: 'asset:waveform-render-segment-timing',
  sourceDurationSec: 4,
}

describe('useClipWaveformViewModel browser reactivity', () => {
  test('does not recurse or resolve the source again during zoom', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(400)
      const counters = createReadCounters()
      const source = createSource({ identity: 'browser-source', counters })
      let resolverCalls = 0
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => { resolverCalls += 1; signal?.throwIfAborted(); return source }
      const waveform = useClipWaveformViewModel({ clip: () => clip, cssWidthPx: width, projectBpm: () => 120, resolveAudioSource: () => resolveAudioSource, visibleRange: () => ({ startSec: 0, endSec: 1 }), mode: 'sample-detail' })
      void (async () => {
        const ready = waitForReady(waveform)
        await ready
        expect(resolverCalls).toBe(1)
        expect(waveform.renderSegments()).not.toHaveLength(0)
        const renderSegment = waveform.renderSegments()[0]
        expect(renderSegment?.mode).toBe('peaks')
        if (renderSegment?.mode === 'peaks') {
          expect(renderSegment.canvasStartSec).toBe(0)
          expect(renderSegment.canvasEndSec).toBe(1)
          expect(renderSegment.drawCols).toBe(400)
        }
        setWidth(500)
        await flushEffects()
        expect(waveform.layout().drawCols).toBe(500)
        expect(resolverCalls).toBe(1)
        expect(waveform.renderSegments()).not.toHaveLength(0)
        dispose(); resolve()
      })().catch((error) => { dispose(); reject(error) })
    }))
  })

  test('changes render revision when async waveform data becomes drawable', async () => {
    const gate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const source = createSource({ identity: 'revision-source', gate })
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: () => 400,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
        mode: 'sample-detail',
      })
      let redraws = 0
      createEffect(() => {
        waveform.renderRevision()
        untrack(() => {
          waveform.renderSegments()
          redraws += 1
        })
      })
      void (async () => {
        await flushEffects()
        const initialRevision = waveform.renderRevision()
        const initialRedraws = redraws
        const ready = waitForReady(waveform)
        gate.resolve()
        await ready
        expect(waveform.renderRevision()).toBeGreaterThan(initialRevision)
        expect(redraws).toBeGreaterThan(initialRedraws)
        dispose()
        resolve()
      })().catch((error) => { dispose(); reject(error) })
    }))
  })

  test('changes render revision when PCM refinement becomes drawable', async () => {
    const refinementGate = deferred<void>()
    let reads = 0
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const source = createSource({
        identity: 'revision-refinement-source',
        durationSec: 0.2,
        counters: { reads: 0, aborts: 0, ranges: [] },
      })
      const gatedSource: AudioPcmSourceDescriptor = {
        ...source,
        readPages: async function* (options = {}) {
          reads += 1
          if (reads > 1) await refinementGate.promise
          yield* source.readPages(options)
        },
      }
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        return gatedSource
      }
      const waveform = useClipWaveformViewModel({
        clip: () => ({ ...clip, id: 'clip:revision-refinement', duration: 0.2, sourceDurationSec: 0.2 }),
        cssWidthPx: () => 6_500,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 0.2 }),
      })
      let revisions: number[] = []
      createEffect(() => { revisions = [...revisions, waveform.renderRevision()] })
      void (async () => {
        const ready = waitForReady(waveform)
        await flushEffects()
        const initialRevision = waveform.renderRevision()
        await ready
        const envelopeRevision = waveform.renderRevision()
        expect(envelopeRevision).toBeGreaterThan(initialRevision)
        const envelopeSegments = waveform.renderSegments()
        expect(envelopeSegments.some((segment) => segment.mode === 'peaks')).toBe(true)
        refinementGate.resolve()
        for (let index = 0; index < 10 && waveform.renderRevision() === envelopeRevision; index += 1) {
          await flushEffects()
        }
        expect(waveform.renderRevision()).toBeGreaterThan(envelopeRevision)
        expect(revisions.at(-1)).toBe(waveform.renderRevision())
        const refinedSegments = waveform.renderSegments()
        expect(refinedSegments.some((segment) => segment.mode === 'peaks')).toBe(true)
        expect(refinedSegments.some((segment) => (
          segment.mode === 'samples' && segment.presentation.lineOpacity > 0
        ))).toBe(true)
        dispose()
        resolve()
      })().catch((error) => { dispose(); reject(error) })
    }))
  })

  test('bounds retained waveform generations across distinct range plans', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [range, setRange] = createSignal({ startSec: 0, endSec: 0.5 })
      const source = createSource({ identity: 'bounded-generation-source', durationSec: 3 })
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => ({ ...clip, id: 'clip:bounded-generation', duration: 3, sourceDurationSec: 3 }),
        cssWidthPx: () => 1_000,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: range,
        mode: 'sample-detail',
      })
      void (async () => {
        const initialReady = waitForReady(waveform)
        await initialReady
        expect(waveform.retainedResultCounts()).toEqual({ current: 1, previous: 0 })
        for (const nextRange of [
          { startSec: 1, endSec: 1.5 },
          { startSec: 2, endSec: 2.5 },
          { startSec: 0.5, endSec: 1 },
          { startSec: 1.5, endSec: 2 },
        ]) {
          const ready = waitForReady(waveform)
          setRange(nextRange)
          await ready
          const counts = waveform.retainedResultCounts()
          expect(counts.current).toBeLessThanOrEqual(2)
          expect(counts.previous).toBeLessThanOrEqual(2)
        }
        dispose()
        resolve()
      })().catch((error) => { dispose(); reject(error) })
    }))
  })

  test('keeps canonical timing on peak render segments for fade projection', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const source = createSource({ identity: 'render-segment-timing-source', durationSec: 4 })
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => slicedClip,
        cssWidthPx: () => 400,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 5, endSec: 7 }),
        mode: 'sample-detail',
      })
      void (async () => {
        const ready = waitForReady(waveform)
        await ready
        const renderSegment = waveform.renderSegments()[0]
        expect(renderSegment?.mode).toBe('peaks')
        if (renderSegment?.mode === 'peaks') {
          expect(renderSegment.canvasStartSec).toBe(5)
          expect(renderSegment.canvasEndSec).toBe(7)
          expect(renderSegment.drawCols).toBe(400)
        }
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('keeps overlapping source coverage through uninterrupted forward and reverse zoom', async () => {
    const firstGate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(1_000)
      const counters = createReadCounters()
      const source = createSource({ identity: 'zoom-source', gate: firstGate, counters })
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => { signal?.throwIfAborted(); return source }
      const waveform = useClipWaveformViewModel({ clip: () => clip, cssWidthPx: width, projectBpm: () => 120, resolveAudioSource: () => resolveAudioSource, visibleRange: () => ({ startSec: 0, endSec: 1 }), mode: 'sample-detail' })
      void (async () => {
        const initial = waitForReady(waveform)
        firstGate.resolve()
        await initial
        expect(waveform.renderSegments()).not.toHaveLength(0)
        for (const nextWidth of [1_200, 1_500, 2_000, 1_500, 1_200]) {
          setWidth(nextWidth)
          await flushEffects()
          expect(waveform.renderSegments()).not.toHaveLength(0)
        }
        expect(counters.reads).toBeGreaterThan(0)
        expect(new Set(counters.ranges).size).toBeLessThanOrEqual(counters.reads)
        expect(counters.aborts).toBeLessThanOrEqual(counters.reads)
        dispose(); resolve()
      })().catch((error) => { dispose(); reject(error) })
    }))
  })

  test('projects current layout before a pending replacement completes', async () => {
    const gate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(400)
      const source = createSource({ identity: 'projection-source', gate })
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => { signal?.throwIfAborted(); return source }
      const waveform = useClipWaveformViewModel({ clip: () => clip, cssWidthPx: width, projectBpm: () => 120, resolveAudioSource: () => resolveAudioSource, visibleRange: () => ({ startSec: 0, endSec: 1 }), mode: 'sample-detail' })
      void (async () => {
        await flushEffects()
        setWidth(800)
        await flushEffects()
        expect(waveform.layout().drawCols).toBe(800)
        const plan = createWaveformRequestPlans({ segments: [{ drawCols: 800, sourceStartSec: 0, sourceEndSec: 1, startPx: 0, endPx: 800, canvasStartSec: 0, canvasEndSec: 1 }], sampleRate: 48_000, sourceDurationSec: 1, sampleDetail: true })
        expect(plan.requests[0]?.key).toContain('pcm-envelope')
        const ready = waitForReady(waveform)
        gate.resolve()
        await ready
        expect(waveform.renderSegments()).not.toHaveLength(0)
        dispose(); resolve()
      })().catch((error) => { dispose(); reject(error) })
    }))
  })
})
