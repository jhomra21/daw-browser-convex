import { describe, expect, test } from 'bun:test'
import { createEffect, createRoot, createSignal } from 'solid-js'

import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import { useClipWaveformViewModel } from './useClipWaveformViewModel'

const source: AudioPcmSourceDescriptor = {
  identity: 'waveform-reactivity-test-source',
  durationSec: 1,
  frameCount: 1_000,
  sampleRate: 1_000,
  channelCount: 1,
  readPages: async function* (options = {}) {
    const startFrame = options.startFrame ?? 0
    const endFrame = options.endFrame ?? source.frameCount
    const frameCount = endFrame - startFrame
    if (frameCount <= 0) return
    yield {
      startFrame,
      frameCount,
      sampleRate: source.sampleRate,
      channelCount: source.channelCount,
      planes: [new Float32Array(frameCount)],
    }
  },
}

const clip: RuntimeClip = {
  id: 'clip:waveform-reactivity',
  name: 'Waveform reactivity',
  startSec: 0,
  duration: 1,
  sourceAssetKey: 'asset:waveform-reactivity',
  sourceDurationSec: source.durationSec,
  sourceSampleRate: source.sampleRate,
  sourceChannelCount: source.channelCount,
  color: '#ffffff',
}

type Deferred<Value> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve: (value: Value) => void = () => {}
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const createSource = (identity: string, readGates: Array<Deferred<void>>): AudioPcmSourceDescriptor => ({
  identity,
  durationSec: 1,
  frameCount: 1_000,
  sampleRate: 1_000,
  channelCount: 1,
  readPages: async function* (options = {}) {
    const gate = readGates.shift()
    if (gate) await gate.promise
    options.signal?.throwIfAborted()
    yield {
      startFrame: options.startFrame ?? 0,
      frameCount: Math.max(1, (options.endFrame ?? 1_000) - (options.startFrame ?? 0)),
      sampleRate: 1_000,
      channelCount: 1,
      planes: [new Float32Array(Math.max(1, (options.endFrame ?? 1_000) - (options.startFrame ?? 0)))],
    }
  },
})

const waitForReady = (waveform: ReturnType<typeof useClipWaveformViewModel>) => (
  new Promise<void>((resolve) => {
    let sawLoading = false
    createEffect(() => {
      if (waveform.loading()) {
        sawLoading = true
      } else if (sawLoading) {
        resolve()
      }
    })
  })
)

const flushEffects = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useClipWaveformViewModel browser reactivity', () => {
  test('does not recurse when a renderable waveform responds to zoom', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(500)
      let resolverCalls = 0
      let loadingStarts = 0
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        resolverCalls += 1
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: width,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
      })

      createEffect(() => {
        if (waveform.loading()) loadingStarts += 1
      })

      const waitForReady = () => new Promise<void>((settle) => {
        let sawLoading = false
        createEffect(() => {
          if (waveform.loading()) {
            sawLoading = true
          } else if (sawLoading) {
            settle()
          }
        })
      })

      void (async () => {
        await waitForReady()
        expect(resolverCalls).toBe(1)
        expect(loadingStarts).toBe(1)
        expect(waveform.layout().drawCols).toBe(500)

        const rerenders = { count: 0 }
        createEffect(() => {
          if (waveform.layout().drawCols > 0) rerenders.count += 1
        })
        const rerendersBeforeZoom = rerenders.count
        const zoomComplete = waitForReady()
        setWidth(600)
        await zoomComplete

        expect(rerenders.count - rerendersBeforeZoom).toBe(1)
        expect(resolverCalls).toBe(1)
        expect(loadingStarts).toBe(2)
        expect(waveform.layout().drawCols).toBe(600)
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('keeps a ready overlapping waveform rendered during same-source pan replacement', async () => {
    const firstGate = deferred<void>()
    const secondGate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [range, setRange] = createSignal({ startSec: 0, endSec: 0.6 })
      const source = createSource('pan-source', [firstGate, secondGate])
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: () => 1_000,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: range,
        mode: 'sample-detail',
      })
      void (async () => {
        const ready = waitForReady(waveform)
        firstGate.resolve()
        await ready
        expect(waveform.renderSegments()).not.toHaveLength(0)
        const replacement = waitForReady(waveform)
        setRange({ startSec: 0.2, endSec: 0.8 })
        await flushEffects()
        expect(waveform.renderSegments()).not.toHaveLength(0)
        secondGate.resolve()
        await replacement
        expect(waveform.renderSegments()).not.toHaveLength(0)
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('keeps a ready waveform rendered during same-source zoom replacement', async () => {
    const firstGate = deferred<void>()
    const secondGate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(1_000)
      const source = createSource('zoom-source', [firstGate, secondGate])
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: width,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
        mode: 'sample-detail',
      })
      void (async () => {
        const ready = waitForReady(waveform)
        firstGate.resolve()
        await ready
        const replacement = waitForReady(waveform)
        setWidth(1_200)
        await flushEffects()
        expect(waveform.renderSegments()).not.toHaveLength(0)
        secondGate.resolve()
        await replacement
        expect(waveform.renderSegments()).not.toHaveLength(0)
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('clears stale waveform after a changed source resolves before replacement is ready', async () => {
    const firstGate = deferred<void>()
    const secondGate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [currentClip, setClip] = createSignal(clip)
      const firstSource = createSource('first-source', [firstGate])
      const secondSource = createSource('second-source', [secondGate])
      const resolveAudioSource: AudioPcmSourceResolver = async (nextClip, signal) => {
        signal?.throwIfAborted()
        return nextClip.sourceAssetKey === 'asset:second' ? secondSource : firstSource
      }
      const waveform = useClipWaveformViewModel({
        clip: currentClip,
        cssWidthPx: () => 1_000,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
        mode: 'sample-detail',
      })
      void (async () => {
        const ready = waitForReady(waveform)
        firstGate.resolve()
        await ready
        expect(waveform.renderSegments()).not.toHaveLength(0)
        const replacement = waitForReady(waveform)
        setClip({ ...clip, sourceAssetKey: 'asset:second' })
        await flushEffects()
        expect(waveform.renderSegments()).toHaveLength(0)
        secondGate.resolve()
        await replacement
        expect(waveform.renderSegments()).not.toHaveLength(0)
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('retains a ready waveform when same-source replacement resolution rejects', async () => {
    const firstGate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [currentClip, setClip] = createSignal(clip)
      const source = createSource('same-source-rejection', [firstGate])
      let rejectReplacement = false
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        if (rejectReplacement) throw new Error('replacement failed')
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: currentClip,
        cssWidthPx: () => 1_000,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
        mode: 'sample-detail',
      })
      void (async () => {
        const ready = waitForReady(waveform)
        firstGate.resolve()
        await ready
        const before = waveform.renderSegments()
        rejectReplacement = true
        const replacement = waitForReady(waveform)
        setClip({ ...clip, audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 } })
        await replacement
        expect(waveform.renderSegments()).toEqual(before)
        expect(waveform.loading()).toBe(false)
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('does not leave a ready same-source waveform empty after rapid cancellation', async () => {
    const firstGate = deferred<void>()
    const secondGate = deferred<void>()
    const thirdGate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(1_000)
      const source = createSource('rapid-source', [firstGate, secondGate, thirdGate])
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: width,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
        mode: 'sample-detail',
      })
      void (async () => {
        const ready = waitForReady(waveform)
        firstGate.resolve()
        await ready
        setWidth(1_100)
        await flushEffects()
        const third = waitForReady(waveform)
        setWidth(1_200)
        await flushEffects()
        expect(waveform.renderSegments()).not.toHaveLength(0)
        secondGate.resolve()
        await flushEffects()
        expect(waveform.renderSegments()).not.toHaveLength(0)
        thirdGate.resolve()
        await third
        expect(waveform.renderSegments()).not.toHaveLength(0)
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('atomically supersedes preserved data when the replacement is ready', async () => {
    const firstGate = deferred<void>()
    const secondGate = deferred<void>()
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(1_000)
      const source = createSource('atomic-source', [firstGate, secondGate])
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: width,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
        mode: 'sample-detail',
      })
      void (async () => {
        const ready = waitForReady(waveform)
        firstGate.resolve()
        await ready
        const previousColumns = waveform.renderSegments()[0]
        if (!previousColumns || previousColumns.mode !== 'peaks') {
          throw new Error('Expected an initial envelope waveform.')
        }
        const replacement = waitForReady(waveform)
        setWidth(1_200)
        await flushEffects()
        expect(waveform.renderSegments()[0]).toMatchObject({ mode: 'peaks', drawCols: 1_000 })
        secondGate.resolve()
        await replacement
        expect(waveform.renderSegments()[0]).toMatchObject({ mode: 'samples', drawCols: 1_200 })
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })
})
