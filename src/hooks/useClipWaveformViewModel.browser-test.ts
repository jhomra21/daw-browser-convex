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

const createSource = (
  identity: string,
  readGates: Array<Deferred<void>>,
  impulseFrame?: number,
): AudioPcmSourceDescriptor => ({
  identity,
  durationSec: 1,
  frameCount: 1_000,
  sampleRate: 1_000,
  channelCount: 1,
  readPages: async function* (options = {}) {
    const gate = readGates.shift()
    if (gate) await gate.promise
    options.signal?.throwIfAborted()
    const samples = new Float32Array(Math.max(
      1,
      (options.endFrame ?? 1_000) - (options.startFrame ?? 0),
    ))
    if (impulseFrame !== undefined) {
      const impulseIndex = impulseFrame - (options.startFrame ?? 0)
      if (impulseIndex >= 0 && impulseIndex < samples.length) samples[impulseIndex] = 1
    }
    yield {
      startFrame: options.startFrame ?? 0,
      frameCount: samples.length,
      sampleRate: 1_000,
      channelCount: 1,
      planes: [samples],
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
        setWidth(600)
        await flushEffects()

        expect(rerenders.count - rerendersBeforeZoom).toBeGreaterThan(0)
        expect(resolverCalls).toBe(1)
        expect(loadingStarts).toBe(1)
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
      const source = createSource('pan-source', [firstGate, secondGate], 300)
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
        const initial = waveform.renderSegments()
        expect(initial).toHaveLength(1)
        if (initial[0]?.mode !== 'samples') throw new Error('Expected sample rendering')
        expect(initial[0].drawStartPx).toBeCloseTo(0, 5)
        expect(initial[0].drawCols).toBeCloseTo(1_000, 5)
        expect(initial[0].samples.firstFrame).toBe(0)
        setRange({ startSec: 0.2, endSec: 0.8 })
        await flushEffects()
        expect(waveform.loading()).toBe(true)
        const retained = waveform.renderSegments()
        expect(retained).toHaveLength(1)
        if (retained[0]?.mode !== 'samples') throw new Error('Expected retained sample rendering')
        expect(retained[0].drawStartPx).toBeCloseTo(0, 5)
        expect(retained[0].drawCols).toBeCloseTo(667, 0)
        expect(retained[0].samples.firstFrame).toBe(200)
        const retainedImpulseIndex = retained[0].samples.channels[0]?.findIndex((value) => value === 1) ?? -1
        expect(retainedImpulseIndex).toBe(100)
        expect(retained[0].drawStartPx
          + ((retained[0].samples.firstFrame + retainedImpulseIndex) / 1_000
            - retained[0].samples.sourceStartSec)
            / (retained[0].samples.sourceEndSec - retained[0].samples.sourceStartSec)
            * retained[0].drawCols)
          .toBeCloseTo(167, 0)
        const replacement = waitForReady(waveform)
        secondGate.resolve()
        await replacement
        const replaced = waveform.renderSegments()
        expect(replaced).toHaveLength(1)
        if (replaced[0]?.mode !== 'samples') throw new Error('Expected replacement sample rendering')
        expect(replaced[0].drawStartPx).toBeCloseTo(0, 5)
        expect(replaced[0].drawCols).toBeCloseTo(1_000, 5)
        expect(replaced[0].samples.firstFrame).toBe(200)
        const replacedImpulseIndex = replaced[0].samples.channels[0]?.findIndex((value) => value === 1) ?? -1
        expect(replacedImpulseIndex).toBe(100)
        expect(replaced[0].drawStartPx
          + ((replaced[0].samples.firstFrame + replacedImpulseIndex) / 1_000
            - replaced[0].samples.sourceStartSec)
            / (replaced[0].samples.sourceEndSec - replaced[0].samples.sourceStartSec)
            * replaced[0].drawCols)
          .toBeCloseTo(167, 0)
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
        setWidth(1_200)
        await flushEffects()
        expect(waveform.renderSegments()[0]).toMatchObject({ mode: 'peaks' })
        expect(waveform.loading()).toBe(true)
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('requests verified source identity for waveform resolution', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      let receivedOptions: { verifyContentHash?: boolean } | undefined
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal, options?) => {
        receivedOptions = options
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: () => 500,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
      })
      void (async () => {
        await waitForReady(waveform)
        expect(receivedOptions).toEqual({ verifyContentHash: true })
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('does not restart verified source resolution during viewport motion', async () => {
    const pending: Array<{ resolve: (value: AudioPcmSourceDescriptor) => void }> = []
    const [width, setWidth] = createSignal(500)
    const [range, setRange] = createSignal({ startSec: 0, endSec: 1 })
    const [currentClip, setClip] = createSignal(clip)
    let resolverCalls = 0
    let aborts = 0
    const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
      resolverCalls += 1
      signal?.addEventListener('abort', () => {
        aborts += 1
      }, { once: true })
      return new Promise<AudioPcmSourceDescriptor>((resolve) => {
        pending.push({ resolve })
      })
    }
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const waveform = useClipWaveformViewModel({
        clip: currentClip,
        cssWidthPx: width,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: range,
      })
      void (async () => {
        for (let index = 0; index < 20; index += 1) {
          setWidth(500 + index * 20)
          setRange({ startSec: index * 0.001, endSec: 1 + index * 0.001 })
          await flushEffects()
        }
        expect(resolverCalls).toBe(1)
        expect(aborts).toBe(0)
        setClip({ ...clip, sourceAssetKey: 'asset:source-changed' })
        await flushEffects()
        expect(resolverCalls).toBe(2)
        expect(aborts).toBe(1)
        pending[1]?.resolve(source)
        await flushEffects()
        expect(waveform.error()).toBeUndefined()
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })

  test('exposes non-abort first-load failures but keeps superseded failures quiet', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: () => 500,
        projectBpm: () => 120,
        resolveAudioSource: () => (async () => {
          throw new Error('decoder failed')
        }),
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
      })
      void (async () => {
        await new Promise<void>((settle) => {
          createEffect(() => {
            if (waveform.error()) settle()
          })
        })
        expect(waveform.error()).toBe('Waveform loading failed.')
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))

    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(500)
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        await new Promise<void>((_, rejectPromise) => {
          signal?.addEventListener('abort', () => rejectPromise(new DOMException('aborted', 'AbortError')), { once: true })
        })
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: width,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
      })
      void (async () => {
        await flushEffects()
        setWidth(600)
        await flushEffects()
        expect(waveform.error()).toBeUndefined()
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })
})
