import { describe, expect, test } from 'bun:test'
import type { AudioPcmSourceDescriptor, DecodedAudioPage } from '@daw-browser/audio-engine/media-pages'
import {
  createPeakLevels,
  decodePeakByte,
  encodePeakByte,
  extractPeakAsset,
  type ExtractedPeakChunk,
} from './extract-peaks'
import {
  ARRANGEMENT_PCM_TILE_FRAMES,
  createArrangementWaveformScheduler,
  type ArrangementWaveformRequest,
} from './arrangement-waveform'
import { drawWaveformSignal, waveformRibbonGeometry } from './draw-waveform-signal'
import { selectWaveformTier } from './lod'
import type { WaveformSourceData } from './types'

const sourceFromPages = (input: {
  readonly frameCount: number
  readonly sampleRate: number
  readonly channelCount: number
  readonly pages: readonly DecodedAudioPage[]
}): AudioPcmSourceDescriptor => ({
  identity: 'test-source',
  durationSec: input.frameCount / input.sampleRate,
  frameCount: input.frameCount,
  sampleRate: input.sampleRate,
  channelCount: input.channelCount,
  readPages: async function* (options = {}) {
    options.signal?.throwIfAborted()
    for (const page of input.pages) {
      yield page
    }
  },
})

const collectChunks = async (
  source: AudioPcmSourceDescriptor,
  assetKey = 'test-asset',
  signal?: AbortSignal,
) => {
  const chunks: ExtractedPeakChunk[] = []
  const record = await extractPeakAsset(source, assetKey, {
    signal,
    onChunk: async (chunk) => { chunks.push(chunk) },
  })
  return { record, chunks }
}

const intervalData = (
  firstFrame: number,
  intervalCount: number,
  framesPerInterval: number,
  encoding: 'float32' | 'signed-u8' = 'float32',
): WaveformSourceData => encoding === 'float32'
  ? {
    kind: 'intervals',
    encoding,
    channels: [new Float32Array(intervalCount * 2).fill(0)],
    firstFrame,
    sampleRate: 48_000,
    sourceFrameCount: 96_000,
    framesPerInterval,
    intervalCount,
  }
  : {
    kind: 'intervals',
    encoding,
    channels: [new Uint8Array(intervalCount * 2).fill(128)],
    firstFrame,
    sampleRate: 48_000,
    sourceFrameCount: 96_000,
    framesPerInterval,
    intervalCount,
  }

const request = (assetKey: string, overrides: Partial<ArrangementWaveformRequest> = {}): ArrangementWaveformRequest => ({
  assetKey,
  sourceIdentity: assetKey,
  source: async () => null,
  sourceStartFrame: 0,
  sourceEndFrame: ARRANGEMENT_PCM_TILE_FRAMES,
  framesPerInterval: 128,
  ...overrides,
})

describe('waveform hierarchy and quantization', () => {
  test('builds globally aligned power-of-two levels', () => {
    const levels = createPeakLevels(48_000, 48_000)
    expect(levels.map((level) => level.framesPerInterval)).toEqual([128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536])
    expect(levels.map((level) => level.intervalCount)).toEqual([375, 188, 94, 47, 24, 12, 6, 3, 2, 1])
    expect(levels.every((level) => level.chunkCount === 1)).toBe(true)
  })

  test('round-trips signed extrema monotonically, including zero', () => {
    const values = [-1, -0.75, -0.01, 0, 0.01, 0.75, 1]
    const bytes = values.map(encodePeakByte)
    expect(bytes).toEqual([0, 32, 127, 128, 129, 223, 255])
    expect(bytes.every((value, index) => index === 0 || value >= bytes[index - 1]!)).toBe(true)
    expect(values.map((value) => decodePeakByte(encodePeakByte(value)))).toEqual([
      -1, -0.75, -0.0078125, 0, 0.007874015748031496, 0.7480314960629921, 1,
    ])
  })

  test('extracts signed stereo extrema and odd hierarchy tails', async () => {
    const source = sourceFromPages({
      frameCount: 5,
      sampleRate: 400,
      channelCount: 2,
      pages: [{
        startFrame: 0,
        frameCount: 5,
        sampleRate: 400,
        channelCount: 2,
        planes: [
          new Float32Array([1, 0.5, -0.5, -0.25, 0.25]),
          new Float32Array([0, -1, 0.25, 0.75, 0]),
        ],
      }],
    })
    const { record, chunks } = await collectChunks(source, 'tails')
    expect(record.levels[0]?.framesPerInterval).toBe(1)
    expect(chunks).toHaveLength(record.levels.reduce((sum, level) => sum + level.chunkCount, 0))
    expect(chunks.every((chunk) => chunk.data.length === 2)).toBe(true)
    const firstLevelChunks = chunks.filter((chunk) => (
      chunk.meta.generationId === record.generationId
      && chunk.meta.intervalCount === 5
    ))
    expect(firstLevelChunks[0]?.meta.intervalCount).toBe(5)
    expect(firstLevelChunks[0]?.data[0]?.length).toBe(10)
    const levelTwo = chunks.find((chunk) => (
      chunk.meta.generationId === record.generationId
      && chunk.meta.framesPerInterval === 2
    ))
    expect(decodePeakByte(levelTwo?.data[0]?.[0] ?? 128)).toBeCloseTo(0.5, 2)
    expect(decodePeakByte(levelTwo?.data[0]?.[1] ?? 128)).toBeCloseTo(1, 2)
    expect(decodePeakByte(levelTwo?.data[0]?.[4] ?? 128)).toBeCloseTo(0.25, 2)
    expect(decodePeakByte(levelTwo?.data[0]?.[5] ?? 128)).toBeCloseTo(0.25, 2)
    const levelThree = chunks.find((chunk) => (
      chunk.meta.generationId === record.generationId
      && chunk.meta.framesPerInterval === 4
    ))
    expect(decodePeakByte(levelThree?.data[0]?.[0] ?? 128)).toBeCloseTo(-0.5, 2)
    expect(decodePeakByte(levelThree?.data[0]?.[1] ?? 128)).toBeCloseTo(1, 2)
    expect(decodePeakByte(levelThree?.data[0]?.[2] ?? 128)).toBeCloseTo(0.25, 2)
    expect(decodePeakByte(levelThree?.data[0]?.[3] ?? 128)).toBeCloseTo(0.25, 2)
  })

  test('turns missing page ranges into silence without materializing source-sized arrays', async () => {
    const { record, chunks } = await collectChunks(sourceFromPages({
      frameCount: 4,
      sampleRate: 400,
      channelCount: 1,
      pages: [
        {
          startFrame: 0,
          frameCount: 1,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array([1])],
        },
        {
          startFrame: 3,
          frameCount: 1,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array([-1])],
        },
      ],
    }))
    const first = chunks.find((chunk) => (
      chunk.meta.generationId === record.generationId
      && chunk.meta.framesPerInterval === 1
      && chunk.meta.chunkIndex === 0
      && chunk.meta.intervalStart === 0
    ))
    expect(first?.data[0]?.slice(0, 8)).toEqual(new Uint8Array([
      encodePeakByte(1), encodePeakByte(1),
      128, 128,
      128, 128,
      encodePeakByte(-1), encodePeakByte(-1),
    ]))
  })

  test('rejects overlapping or malformed pages', async () => {
    const source = sourceFromPages({
      frameCount: 4,
      sampleRate: 400,
      channelCount: 1,
      pages: [{
        startFrame: 0,
        frameCount: 2,
        sampleRate: 400,
        channelCount: 1,
        planes: [new Float32Array([0, 0])],
      }, {
        startFrame: 1,
        frameCount: 2,
        sampleRate: 400,
        channelCount: 1,
        planes: [new Float32Array([0, 0])],
      }],
    })
    await expect(collectChunks(source)).rejects.toThrow('unordered or malformed')
  })

  test('honors cancellation between pages', async () => {
    const controller = new AbortController()
    const source: AudioPcmSourceDescriptor = {
      ...sourceFromPages({
        frameCount: 2,
        sampleRate: 400,
        channelCount: 1,
        pages: [],
      }),
      readPages: async function* () {
        yield {
          startFrame: 0,
          frameCount: 1,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array([1])],
        }
        controller.abort()
        yield {
          startFrame: 1,
          frameCount: 1,
          sampleRate: 400,
          channelCount: 1,
          planes: [new Float32Array([1])],
        }
      },
    }
    await expect(collectChunks(source, 'cancelled', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('waveform LOD and source scheduler', () => {
  test('selects the finest tier at the 0.75 interval-width threshold', () => {
    expect(selectWaveformTier({
      sourceFrameSpan: 48_000,
      cssSegmentWidth: 480,
      backingPixelsPerCssPixel: 2,
      tiers: [1, 2, 4, 8, 16, 32, 64, 128],
    })?.framesPerInterval).toBe(32)
    expect(selectWaveformTier({
      sourceFrameSpan: 48_000,
      cssSegmentWidth: 480,
      backingPixelsPerCssPixel: 1,
      tiers: [1, 2, 4, 8, 16, 32, 64, 128],
    })?.framesPerInterval).toBe(64)
  })

  test('deduplicates tiles, clones cached data, and retries null results', async () => {
    let calls = 0
    const scheduler = createArrangementWaveformScheduler({
      decode: async () => {
        calls += 1
        if (calls === 1) return null
        return intervalData(0, 1, 128)
      },
    })
    expect(await scheduler.request(request('retry'))).toBeNull()
    const first = scheduler.request(request('retry'))
    const second = scheduler.request(request('retry'))
    const [one, two] = await Promise.all([first, second])
    expect(calls).toBe(2)
    expect(one).not.toBeNull()
    expect(two).not.toBeNull()
    if (!one || !two || one.kind !== 'intervals' || two.kind !== 'intervals') throw new Error('Expected intervals')
    one.channels[0]![0] = 255
    expect(two.channels[0]![0]).toBe(0)
    expect(scheduler.getDiagnostics().dedupeCount).toBe(1)
  })

  test('limits active work and honors priority before FIFO order', async () => {
    const gates: Array<{ resolve: (value: WaveformSourceData | null) => void }> = []
    const starts: string[] = []
    const scheduler = createArrangementWaveformScheduler({
      maxConcurrent: 1,
      decode: async (input) => {
        starts.push(input.assetKey)
        const gate = new Promise<WaveformSourceData | null>((resolve) => { gates.push({ resolve }) })
        return await gate
      },
    })
    const first = scheduler.request(request('first'))
    const second = scheduler.request(request('second'))
    const urgent = scheduler.request(request('urgent', { priority: -1 }))
    expect(starts).toEqual(['first'])
    gates[0]?.resolve(intervalData(0, 1, 128))
    await first
    await Promise.resolve()
    expect(starts).toEqual(['first', 'urgent'])
    gates[1]?.resolve(intervalData(0, 1, 128))
    await urgent
    await Promise.resolve()
    expect(starts).toEqual(['first', 'urgent', 'second'])
    gates[2]?.resolve(intervalData(0, 1, 128))
    await Promise.all([second, urgent])
  })

  test('isolates subscriber cancellation and aborts only the final subscriber', async () => {
    let decodeSignal: AbortSignal | undefined
    let resolveDecode: (value: WaveformSourceData | null) => void = () => {}
    const scheduler = createArrangementWaveformScheduler({
      decode: async (_input, signal) => {
        decodeSignal = signal
        return await new Promise<WaveformSourceData | null>((resolve) => { resolveDecode = resolve })
      },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = scheduler.request(request('shared', { signal: firstController.signal }))
    const second = scheduler.request(request('shared', { signal: secondController.signal }))
    firstController.abort()
    expect(await first).toBeNull()
    expect(decodeSignal?.aborted).toBe(false)
    resolveDecode(intervalData(0, 1, 128))
    expect(await second).not.toBeNull()
    secondController.abort()
    expect(decodeSignal?.aborted).toBe(false)
  })

  test('assembles exact samples spanning multiple bounded tiles', async () => {
    let calls = 0
    const scheduler = createArrangementWaveformScheduler({
      decode: async (input) => {
        calls += 1
        return {
          kind: 'samples',
          channels: [new Float32Array(input.tileEndFrame - input.tileStartFrame)],
          firstFrame: input.tileStartFrame,
          sampleRate: 48_000,
          sourceFrameCount: ARRANGEMENT_PCM_TILE_FRAMES * 3,
        }
      },
    })
    const result = await scheduler.request(request('samples', {
      sourceStartFrame: 0,
      sourceEndFrame: ARRANGEMENT_PCM_TILE_FRAMES * 3,
      framesPerInterval: 1,
    }))
    expect(result?.kind).toBe('samples')
    expect(result?.kind === 'samples' ? result.channels[0]?.length : 0)
      .toBe(ARRANGEMENT_PCM_TILE_FRAMES * 3)
    expect(calls).toBe(3)
  })
})

describe('unified waveform painter', () => {
  const recordingContext = () => {
    const commands: Array<readonly [string, ...number[]]> = []
    const ctx = {
      fillStyle: '',
      beginPath() { commands.push(['beginPath']) },
      moveTo(x: number, y: number) { commands.push(['moveTo', x, y]) },
      lineTo(x: number, y: number) { commands.push(['lineTo', x, y]) },
      fill() { commands.push(['fill']) },
      arc(x: number, y: number, radius: number) { commands.push(['arc', x, y, radius]) },
    }
    return { ctx, commands }
  }

  test('aligns minimum ribbons to one backing row at common backing scales', () => {
    for (const backingScaleY of [1, 1.5, 2, 3]) {
      for (const deviceCenter of [10, 10.25, 10.5, 10.75]) {
        const centerY = deviceCenter / backingScaleY
        const ribbon = waveformRibbonGeometry({
          upperY: centerY,
          lowerY: centerY,
          minimumThicknessCssPx: 1 / backingScaleY,
          backingScaleY,
        })
        const upperBackingY = ribbon.upperY * backingScaleY
        const lowerBackingY = ribbon.lowerY * backingScaleY
        expect(upperBackingY).toBe(Math.floor(upperBackingY))
        expect(lowerBackingY).toBe(Math.floor(lowerBackingY))
        expect(ribbon.thickness * backingScaleY).toBeGreaterThanOrEqual(1)
        expect(ribbon.centerY * backingScaleY - 0.5).toBe(
          Math.floor(ribbon.centerY * backingScaleY),
        )
      }
    }
  })

  test('releases snapped centers continuously through the safe backing-thickness range', () => {
    for (const backingScaleY of [1, 2, 3]) {
      for (const deviceThickness of [
        0.9, 0.999, 1, 1.001, 1.25, 1.5, 1.999, 2, 2.001, 2.01,
        2.1, 2.25, 2.5, 2.75, 2.999, 3, 3.001, 3.5, 3.999, 4, 4.001,
      ]) {
        for (const deviceCenter of [10, 10.25, 10.5, 10.75, 10.999, 11]) {
          const centerY = deviceCenter / backingScaleY
          const thickness = deviceThickness / backingScaleY
          const ribbon = waveformRibbonGeometry({
            upperY: centerY - thickness / 2,
            lowerY: centerY + thickness / 2,
            minimumThicknessCssPx: 1 / backingScaleY,
            backingScaleY,
          })
          const upperBackingY = ribbon.upperY * backingScaleY
          const lowerBackingY = ribbon.lowerY * backingScaleY
          expect(ribbon.thickness * backingScaleY).toBeGreaterThanOrEqual(1)
          expect(Math.floor(lowerBackingY) - Math.ceil(upperBackingY)).toBeGreaterThanOrEqual(0)
          if (deviceThickness >= 4) {
            expect(ribbon.upperY).toBe(centerY - thickness / 2)
            expect(ribbon.lowerY).toBe(centerY + thickness / 2)
          }
        }
      }
    }
  })

  test('does not jump when raw thickness crosses the snapped-center release', () => {
    for (const backingScaleY of [1, 1.5, 2, 3]) {
      for (const deviceCenter of [10, 10.25, 10.5, 10.75]) {
        const centers: number[] = []
        for (const deviceThickness of [2, 2.0001, 2.001, 2.01, 2.1, 2.5, 3, 3.5, 3.999, 4]) {
          const centerY = deviceCenter / backingScaleY
          const thickness = deviceThickness / backingScaleY
          centers.push(waveformRibbonGeometry({
            upperY: centerY - thickness / 2,
            lowerY: centerY + thickness / 2,
            minimumThicknessCssPx: 1 / backingScaleY,
            backingScaleY,
          }).centerY * backingScaleY)
        }
        const jumps = centers.slice(1).map((value, index) => Math.abs(value - (centers[index] ?? value)))
        expect(Math.max(...jumps)).toBeLessThan(0.5)
        expect(centers.at(-1)).toBe(deviceCenter)
      }
    }
  })

  test('preserves thick raw bands and uses the same minimum for zero intervals and samples', () => {
    const thick = waveformRibbonGeometry({
      upperY: 4,
      lowerY: 12,
      minimumThicknessCssPx: 1,
      backingScaleY: 2,
    })
    expect(thick).toEqual({
      upperY: 4,
      lowerY: 12,
      centerY: 8,
      thickness: 8,
    })

    const render = (data: Parameters<typeof drawWaveformSignal>[1]['data']) => {
      const commands: Array<readonly [string, ...number[]]> = []
      const ctx = {
        fillStyle: '',
        beginPath() { commands.push(['beginPath']) },
        moveTo(x: number, y: number) { commands.push(['moveTo', x, y]) },
        lineTo(x: number, y: number) { commands.push(['lineTo', x, y]) },
        fill() { commands.push(['fill']) },
        arc() {},
      }
      drawWaveformSignal(ctx, {
        data,
        sourceStartFrame: 0,
        sourceEndFrame: 1,
        startPx: 0,
        endPx: 1,
        topY: 0.25,
        contentH: 20,
        channelCount: 1,
        style: { minimumThicknessCssPx: 0.5, backingScaleY: 2 },
      })
      return commands
        .filter((command) => command[0] === 'moveTo' || command[0] === 'lineTo')
        .map((command) => command[2])
    }
    const intervalY = render({
      kind: 'intervals',
      encoding: 'float32',
      channels: [new Float32Array([0, 0])],
      firstFrame: 0,
      sampleRate: 1,
      sourceFrameCount: 1,
      framesPerInterval: 1,
      intervalCount: 1,
    })
    const sampleY = render({
      kind: 'samples',
      channels: [new Float32Array([0])],
      firstFrame: 0,
      sampleRate: 1,
      sourceFrameCount: 1,
    })
    expect([Math.min(...intervalY), Math.max(...intervalY)]).toEqual([
      Math.min(...sampleY),
      Math.max(...sampleY),
    ])
    expect(Math.max(...intervalY) - Math.min(...intervalY)).toBe(0.5)
  })

  test('renders valid zero data but no data remains empty', () => {
    const fills: string[] = []
    const ctx = {
      fillStyle: '',
      beginPath() {},
      moveTo() {},
      lineTo() {},
      fill() { fills.push('fill') },
      arc() {},
    }
    drawWaveformSignal(ctx, {
      data: {
        kind: 'intervals',
        encoding: 'float32',
        channels: [new Float32Array([0, 0])],
        firstFrame: 0,
        sampleRate: 1,
        sourceFrameCount: 1,
        framesPerInterval: 1,
        intervalCount: 1,
      },
      sourceStartFrame: 0,
      sourceEndFrame: 1,
      startPx: 0,
      endPx: 1,
      topY: 0,
      contentH: 10,
      channelCount: 1,
      style: { minimumThicknessCssPx: 1, backingScaleY: 1 },
    })
    drawWaveformSignal(ctx, {
      data: {
        kind: 'intervals',
        encoding: 'float32',
        channels: [],
        firstFrame: 0,
        sampleRate: 1,
        sourceFrameCount: 1,
        framesPerInterval: 1,
        intervalCount: 0,
      },
      sourceStartFrame: 0,
      sourceEndFrame: 1,
      startPx: 0,
      endPx: 1,
      topY: 0,
      contentH: 10,
      channelCount: 1,
    })
    expect(fills).toEqual(['fill'])
  })

  test('uses the same fill-only style contract for persisted and exact data', () => {
    const persisted = recordingContext()
    const exact = recordingContext()
    const common = {
      sourceStartFrame: 0,
      sourceEndFrame: 2,
      startPx: 0,
      endPx: 20,
      topY: 0,
      contentH: 20,
      channelCount: 1,
      style: { fillStyle: '#4ade80', minimumThicknessCssPx: 0.5, backingScaleY: 2 },
    }
    drawWaveformSignal(persisted.ctx, {
      ...common,
      data: {
        kind: 'intervals',
        encoding: 'float32',
        channels: [new Float32Array([-.5, .5])],
        firstFrame: 0,
        sampleRate: 2,
        sourceFrameCount: 2,
        framesPerInterval: 2,
        intervalCount: 1,
      },
    })
    drawWaveformSignal(exact.ctx, {
      ...common,
      data: {
        kind: 'samples',
        channels: [new Float32Array([-.5, .5])],
        firstFrame: 0,
        sampleRate: 2,
        sourceFrameCount: 2,
      },
    })
    expect(persisted.ctx.fillStyle).toBe('#4ade80')
    expect(exact.ctx.fillStyle).toBe('#4ade80')
    expect(persisted.commands.filter(([kind]) => kind === 'fill')).toHaveLength(1)
    expect(exact.commands.filter(([kind]) => kind === 'fill')).toHaveLength(1)
  })

  test('expands collapsed exact samples to a constant requested thickness', () => {
    const recorded = recordingContext()
    drawWaveformSignal(recorded.ctx, {
      data: {
        kind: 'samples',
        channels: [new Float32Array([0, 0])],
        firstFrame: 0,
        sampleRate: 2,
        sourceFrameCount: 2,
      },
      sourceStartFrame: 0,
      sourceEndFrame: 2,
      startPx: 0,
      endPx: 20,
      topY: 0,
      contentH: 20,
      channelCount: 1,
      style: { fillStyle: '#4ade80', minimumThicknessCssPx: 0.5, backingScaleY: 2 },
    })
    const yValues = recorded.commands
      .filter((command) => command[0] === 'moveTo' || command[0] === 'lineTo')
      .map((command) => command[2])
      .filter((value): value is number => typeof value === 'number')
    expect(Math.max(...yValues) - Math.min(...yValues)).toBe(0.5)
  })

  test('renders signed interval geometry through one painter', () => {
    let fillCount = 0
    const ctx = {
      fillStyle: '',
      beginPath() {},
      moveTo() {},
      lineTo() {},
      fill() { fillCount += 1 },
      arc() {},
    }
    drawWaveformSignal(ctx, {
      data: {
        kind: 'intervals',
        encoding: 'float32',
        channels: [new Float32Array([-.5, .5])],
        firstFrame: 0,
        sampleRate: 100,
        sourceFrameCount: 10,
        framesPerInterval: 10,
        intervalCount: 1,
      },
      sourceStartFrame: 0,
      sourceEndFrame: 10,
      startPx: 0,
      endPx: 100,
      topY: 0,
      contentH: 40,
      channelCount: 1,
    })
    expect(fillCount).toBe(1)
  })

  test('draws exact points with the shared fill style', () => {
    let arcCount = 0
    const ctx = {
      fillStyle: '',
      beginPath() {},
      moveTo() {},
      lineTo() {},
      fill() {},
      arc() { arcCount += 1 },
    }
    drawWaveformSignal(ctx, {
      data: {
        kind: 'samples',
        channels: [new Float32Array([-.5, .5])],
        firstFrame: 0,
        sampleRate: 2,
        sourceFrameCount: 2,
      },
      sourceStartFrame: 0,
      sourceEndFrame: 2,
      startPx: 0,
      endPx: 20,
      topY: 0,
      contentH: 40,
      channelCount: 1,
      style: { pointRadius: 1 },
    })
    expect(arcCount).toBe(2)
  })

  test('uses exact sample-frame x coordinates for line and point vertices', () => {
    const moves: number[] = []
    const arcs: number[] = []
    const ctx = {
      fillStyle: '',
      beginPath() {},
      moveTo(x: number) { moves.push(x) },
      lineTo(x: number) { moves.push(x) },
      fill() {},
      arc(x: number) { arcs.push(x) },
    }
    drawWaveformSignal(ctx, {
      data: {
        kind: 'samples',
        channels: [new Float32Array([-.5, 0, .5])],
        firstFrame: 10,
        sampleRate: 3,
        sourceFrameCount: 20,
      },
      sourceStartFrame: 10,
      sourceEndFrame: 13,
      startPx: 0,
      endPx: 30,
      topY: 0,
      contentH: 40,
      channelCount: 1,
      style: { pointRadius: 1 },
    })
    expect(arcs).toEqual([0, 10, 20])
    expect(moves).toContain(0)
    expect(moves).toContain(10)
    expect(moves).toContain(20)
  })

  test('connects adjacent exact samples into one non-degenerate ribbon', () => {
    const recorded = recordingContext()
    drawWaveformSignal(recorded.ctx, {
      data: {
        kind: 'samples',
        channels: [new Float32Array([-1, 0, 1])],
        firstFrame: 0,
        sampleRate: 3,
        sourceFrameCount: 3,
      },
      sourceStartFrame: 0,
      sourceEndFrame: 3,
      startPx: 0,
      endPx: 30,
      topY: 0,
      contentH: 30,
      channelCount: 1,
      style: { minimumThicknessCssPx: 1 },
    })
    const path = recorded.commands.slice(0, recorded.commands.findIndex(([kind]) => kind === 'fill'))
      .filter((command) => command[0] === 'moveTo' || command[0] === 'lineTo')
    const vertices = path.map((command) => [command[1] ?? 0, command[2] ?? 0])
    const area = vertices.reduce((total, [x, y], index) => {
      const next = vertices[(index + 1) % vertices.length]
      if (!next) return total
      return total + x * next[1] - next[0] * y
    }, 0) / 2
    const pixelX = 15.1
    const pixelY = 8
    const filledPixel = vertices.reduce((inside, [x0, y0], index) => {
      const next = vertices[(index + 1) % vertices.length]
      if (!next) return inside
      const [x1, y1] = next
      const crosses = (y0 > pixelY) !== (y1 > pixelY)
        && pixelX < (x1 - x0) * (pixelY - y0) / (y1 - y0) + x0
      return crosses ? !inside : inside
    }, false)
    expect(path.some(([, x, y]) => x === 10 && y < 15.5)).toBe(true)
    expect(path.some(([, x, y]) => x === 10 && y > 15.5)).toBe(true)
    expect(path.filter(([, x]) => x === 10)).toHaveLength(2)
    expect(Math.abs(area)).toBeGreaterThan(0)
    expect(filledPixel).toBe(true)
    expect(recorded.commands.filter(([kind]) => kind === 'fill')).toHaveLength(1)
  })

  test('clips signed bands, applies fades per channel, and bounds canvas operations', () => {
    let fills = 0
    let moves = 0
    let lines = 0
    const fadeFrames: number[] = []
    const ctx = {
      fillStyle: '',
      beginPath() {},
      moveTo() { moves += 1 },
      lineTo() { lines += 1 },
      fill() { fills += 1 },
      arc() {},
    }
    drawWaveformSignal(ctx, {
      data: {
        kind: 'intervals',
        encoding: 'float32',
        channels: [
          new Float32Array([-.5, .5, -.25, .25]),
          new Float32Array([-.25, .25, -.1, .1]),
        ],
        firstFrame: 0,
        sampleRate: 100,
        sourceFrameCount: 40,
        framesPerInterval: 10,
        intervalCount: 2,
      },
      sourceStartFrame: 5,
      sourceEndFrame: 15,
      startPx: 0,
      endPx: 100,
      topY: 0,
      contentH: 80,
      channelCount: 2,
      fadeScaleAtSourceFrame: (frame) => {
        fadeFrames.push(frame)
        return 0.5
      },
    })
    expect(fills).toBe(2)
    expect(fadeFrames).toEqual([5, 15])
    expect(moves + lines).toBeLessThanOrEqual(20)
  })
})
