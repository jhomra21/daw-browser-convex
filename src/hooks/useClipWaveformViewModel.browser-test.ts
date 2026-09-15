import { beforeEach, describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import { arrangementWaveformScheduler } from '@daw-browser/waveforms/arrangement-waveform'
import { clearWaveformAssetCache } from '@daw-browser/waveforms/asset-store'
import { drawWaveformSignal } from '@daw-browser/waveforms/draw-waveform-signal'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import { useClipWaveformViewModel } from './useClipWaveformViewModel'
import { useSampleDetailWaveformOverview } from './useSampleDetailWaveformOverview'

beforeEach(() => {
  arrangementWaveformScheduler.clear()
  clearWaveformAssetCache()
})

type Deferred<Value> = {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
}

type SourceControls = {
  readonly gate: Deferred<void>
  readonly replacementGate: Deferred<void>
  readonly reads: () => number
  readonly aborts: () => number
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve: (value: Value) => void = () => {}
  const promise = new Promise<Value>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const settle = async (waveform: ReturnType<typeof useClipWaveformViewModel>) => {
  for (let index = 0; index < 20 && waveform.loading(); index += 1) await flush()
}

const settleOverview = async (
  overview: ReturnType<typeof useSampleDetailWaveformOverview>,
) => {
  for (let index = 0; index < 20 && overview.renderSegments().length === 0; index += 1) {
    await flush()
  }
}

type SourceFixture = {
  readonly source: AudioPcmSourceDescriptor
  readonly controls: SourceControls
}

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1
  readonly length = 48_000
  readonly numberOfChannels = 1
  readonly sampleRate = 48_000

  copyFromChannel(destination: Float32Array) {
    destination.fill(0)
  }

  copyToChannel() {}

  getChannelData() {
    return new Float32Array(this.length)
  }
}

const createSource = (
  identity: string,
  value: number,
  gate = deferred<void>(),
  replacementGate = deferred<void>(),
  failOnRead?: number,
): SourceFixture => {
  let abortCount = 0
  let readCount = 0
  const source: AudioPcmSourceDescriptor = {
    identity,
    durationSec: 1,
    frameCount: 48_000,
    sampleRate: 48_000,
    channelCount: 1,
    readPages: async function* (options = {}) {
      readCount += 1
      const onAbort = () => { abortCount += 1 }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (failOnRead === readCount) throw new Error('waveform read failed')
      await (readCount === 1
        ? gate.promise
        : readCount === 4
          ? replacementGate.promise
          : Promise.resolve())
      options.signal?.throwIfAborted()
      yield {
        startFrame: options.startFrame ?? 0,
        frameCount: Math.max(1, (options.endFrame ?? 48_000) - (options.startFrame ?? 0)),
        sampleRate: 48_000,
        channelCount: 1,
        planes: [new Float32Array(
          Math.max(1, (options.endFrame ?? 48_000) - (options.startFrame ?? 0)),
        ).fill(value)],
      }
    },
  }
  return {
    source,
    controls: {
      gate,
      replacementGate,
      reads: () => readCount,
      aborts: () => abortCount,
    },
  }
}

const createClip = (assetKey = 'asset-a'): RuntimeClip => ({
  id: 'waveform-view-model-test',
  name: 'waveform',
  startSec: 0,
  duration: 1,
  sourceAssetKey: assetKey,
  sourceDurationSec: 1,
  sourceSampleRate: 48_000,
  sourceChannelCount: 1,
  color: '#fff',
})

const createWaveform = (input: {
  readonly clip: () => RuntimeClip
  readonly width: () => number
  readonly resolve: AudioPcmSourceResolver
  readonly waveformVisible?: () => boolean
}) => useClipWaveformViewModel({
  clip: input.clip,
  cssWidthPx: input.width,
  projectBpm: () => 120,
  resolveAudioSource: () => input.resolve,
  visibleRange: () => ({ startSec: 0, endSec: 1 }),
  waveformVisible: input.waveformVisible,
})

const waitForReads = async (reads: () => number, minimum: number) => {
  for (let index = 0; index < 20 && reads() < minimum; index += 1) await flush()
}

const resolveWhen = (sources: ReadonlyMap<string, AudioPcmSourceDescriptor>): AudioPcmSourceResolver => (
  async (clip, signal) => {
    signal?.throwIfAborted()
    const source = sources.get(clip.sourceAssetKey ?? '')
    if (!source) throw new Error('missing source')
    return source
  }
)

const waveformCommands = (waveform: ReturnType<typeof useClipWaveformViewModel>) => (
  waveform.segments().flatMap((segment) => {
    const commands: string[] = []
    const ctx = {
      fillStyle: '',
      beginPath: () => commands.push('beginPath'),
      moveTo: (x: number, y: number) => commands.push(`moveTo:${x}:${y}`),
      lineTo: (x: number, y: number) => commands.push(`lineTo:${x}:${y}`),
      fill: () => commands.push('fill'),
      arc: (x: number, y: number, radius: number) => commands.push(`arc:${x}:${y}:${radius}`),
    }
    drawWaveformSignal(ctx, {
      data: segment.data,
      sourceStartFrame: segment.sourceStartFrame,
      sourceEndFrame: segment.sourceEndFrame,
      startPx: segment.startPx,
      endPx: segment.endPx,
      topY: 0,
      contentH: 100,
      channelCount: segment.data.channels.length,
      style: {
        fillStyle: '#fff',
        pointRadius: segment.pointRadius,
        backingScaleY: 1,
        minimumThicknessCssPx: 1,
      },
    })
    return commands
  })
)

describe('useClipWaveformViewModel unified generation publication', () => {
  test('shares source, scheduler, tier, geometry, and painter commands across surfaces', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const source = createSource('source-a', 0.25)
      const input = {
        clip: () => createClip(),
        width: () => 400,
        resolve: resolveWhen(new Map([['asset-a', source.source]])),
      }
      const arrangement = createWaveform(input)
      const sampleDetail = createWaveform(input)
      const sampleDetailOverview = useSampleDetailWaveformOverview({
        clip: input.clip,
        cssWidthPx: input.width,
        projectBpm: () => 120,
        source: arrangement.source,
        backingPixelsPerCssPixel: () => 1,
      })
      void (async () => {
        source.controls.gate.resolve()
        await settle(arrangement)
        await settle(sampleDetail)
        await settleOverview(sampleDetailOverview)
        expect(arrangement.source()).toBe(source.source)
        expect(arrangement.segments().map((segment) => ({
          startPx: segment.startPx,
          endPx: segment.endPx,
          sourceStartFrame: segment.sourceStartFrame,
          sourceEndFrame: segment.sourceEndFrame,
          data: segment.data.kind,
        }))).toEqual(sampleDetail.segments().map((segment) => ({
          startPx: segment.startPx,
          endPx: segment.endPx,
          sourceStartFrame: segment.sourceStartFrame,
          sourceEndFrame: segment.sourceEndFrame,
          data: segment.data.kind,
        })))
        expect(sampleDetailOverview.renderSegments().map((segment) => ({
          startPx: segment.drawStartPx,
          endPx: segment.drawStartPx + segment.drawCols,
          sourceStartFrame: segment.sourceStartFrame,
          sourceEndFrame: segment.sourceEndFrame,
          data: segment.data.kind,
        }))).toEqual(arrangement.segments().map((segment) => ({
          startPx: segment.startPx,
          endPx: segment.endPx,
          sourceStartFrame: segment.sourceStartFrame,
          sourceEndFrame: segment.sourceEndFrame,
          data: segment.data.kind,
        })))
        expect(waveformCommands(arrangement)).toEqual(waveformCommands(sampleDetail))
        expect(arrangementWaveformScheduler.getDiagnostics().dedupeCount).toBeGreaterThan(0)
        dispose()
        resolve()
      })().catch((cause: unknown) => {
        dispose()
        reject(cause instanceof Error ? cause : new Error('production waveform parity test failed'))
      })
    }))
  })

  test('keeps same-source fallback visible until a complete replacement is ready', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(400)
      const source = createSource('source-a', 0.25)
      const waveform = createWaveform({
        clip: () => createClip(),
        width,
        resolve: resolveWhen(new Map([
          ['asset-a', source.source],
        ])),
      })
      void (async () => {
        source.controls.gate.resolve()
        await flush()
        await settle(waveform)
        expect(waveform.segments()).not.toHaveLength(0)
        expect(waveform.segments()[0]?.data.kind).toBe('intervals')
        setWidth(200_000)
        await flush()
        expect(waveform.segments()).not.toHaveLength(0)
        expect(waveform.segments()[0]?.data.kind).toBe('intervals')
        expect(waveform.retainedResultCounts().previous).toBeLessThanOrEqual(1)
        source.controls.replacementGate.resolve()
        await settle(waveform)
        expect(waveform.segments()[0]?.data.kind).toBe('samples')
        expect(waveform.retainedResultCounts().previous).toBe(0)
        dispose()
        resolve()
      })().catch((cause: unknown) => {
        dispose()
        reject(cause instanceof Error ? cause : new Error('view-model fallback test failed'))
      })
    }))
  })

  test('never renders stale data after source identity changes', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [clip, setClip] = createSignal(createClip('asset-a'))
      const sourceA = createSource('source-a', 0.25)
      const sourceB = createSource('source-b', 0.75)
      const waveform = createWaveform({
        clip,
        width: () => 400,
        resolve: resolveWhen(new Map([
          ['asset-a', sourceA.source],
          ['asset-b', sourceB.source],
        ])),
      })
      void (async () => {
        sourceA.controls.gate.resolve()
        await flush()
        await settle(waveform)
        expect(waveform.segments()).not.toHaveLength(0)
        setClip(createClip('asset-b'))
        await flush()
        expect(waveform.segments()).toHaveLength(0)
        sourceB.controls.gate.resolve()
        await settle(waveform)
        expect(waveform.segments()).not.toHaveLength(0)
        dispose()
        resolve()
      })().catch((cause: unknown) => {
        dispose()
        reject(cause instanceof Error ? cause : new Error('view-model stale-source test failed'))
      })
    }))
  })

  test('reloads when a same-metadata buffer source is replaced', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const initialBuffer = new TestAudioBuffer()
      const [clip, setClip] = createSignal({
        ...createClip(),
        buffer: initialBuffer,
      })
      const sourceA = createSource('source-a', 0.25)
      const sourceB = createSource('source-b', 0.75)
      const waveform = createWaveform({
        clip,
        width: () => 400,
        resolve: async (nextClip, signal) => {
          signal?.throwIfAborted()
          return nextClip.buffer === initialBuffer ? sourceA.source : sourceB.source
        },
      })
      void (async () => {
        sourceA.controls.gate.resolve()
        await flush()
        await settle(waveform)
        expect(waveform.segments()[0]?.data.kind).toBe('intervals')
        setClip((current) => ({ ...current, buffer: new TestAudioBuffer() }))
        await flush()
        expect(waveform.segments()).toHaveLength(0)
        sourceB.controls.gate.resolve()
        await settle(waveform)
        expect(waveform.segments()).not.toHaveLength(0)
        expect(sourceB.controls.reads()).toBeGreaterThan(0)
        dispose()
        resolve()
      })().catch((cause: unknown) => {
        dispose()
        reject(cause instanceof Error ? cause : new Error('buffer replacement test failed'))
      })
    }))
  })

  test('cancels obsolete replacement work and retains bounded generations', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(400)
      const source = createSource('source-a', 0.25)
      const waveform = createWaveform({
        clip: () => createClip(),
        width,
        resolve: resolveWhen(new Map([['asset-a', source.source]])),
      })
      void (async () => {
        source.controls.gate.resolve()
        await flush()
        await settle(waveform)
        setWidth(200_000)
        await waitForReads(source.controls.reads, 4)
        setWidth(400)
        await flush()
        expect(source.controls.aborts()).toBeGreaterThan(0)
        expect(waveform.retainedResultCounts().current).toBeLessThanOrEqual(1)
        expect(waveform.retainedResultCounts().previous).toBeLessThanOrEqual(1)
        dispose()
        resolve()
      })().catch((cause: unknown) => {
        dispose()
        reject(cause instanceof Error ? cause : new Error('view-model cancellation test failed'))
      })
    }))
  })

  test('publishes errors without discarding the last complete generation', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(400)
      const source = createSource('source-a', 0.25, undefined, undefined, 4)
      const waveform = createWaveform({
        clip: () => createClip(),
        width,
        resolve: resolveWhen(new Map([['asset-a', source.source]])),
      })
      void (async () => {
        source.controls.gate.resolve()
        await flush()
        await settle(waveform)
        const before = waveform.segments()
        setWidth(200_000)
        await waitForReads(source.controls.reads, 4)
        await settle(waveform)
        expect(waveform.error()).toBe('waveform read failed')
        expect(waveform.segments().length).toBeGreaterThanOrEqual(before.length)
        expect(waveform.retainedResultCounts().previous).toBeLessThanOrEqual(1)
        dispose()
        resolve()
      })().catch((cause: unknown) => {
        dispose()
        reject(cause instanceof Error ? cause : new Error('view-model error test failed'))
      })
    }))
  })

  test('cancels and clears while hidden, then reloads when visible again', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [visible, setVisible] = createSignal(true)
      const source = createSource('source-a', 0.25)
      const waveform = createWaveform({
        clip: () => createClip(),
        width: () => 400,
        resolve: resolveWhen(new Map([['asset-a', source.source]])),
        waveformVisible: visible,
      })
      void (async () => {
        source.controls.gate.resolve()
        await flush()
        await settle(waveform)
        expect(waveform.segments()).not.toHaveLength(0)
        setVisible(false)
        await flush()
        expect(waveform.segments()).toHaveLength(0)
        source.controls.replacementGate.resolve()
        setVisible(true)
        await flush()
        await settle(waveform)
        expect(waveform.segments()).not.toHaveLength(0)
        dispose()
        resolve()
      })().catch((cause: unknown) => {
        dispose()
        reject(cause instanceof Error ? cause : new Error('waveform visibility test failed'))
      })
    }))
  })
})
