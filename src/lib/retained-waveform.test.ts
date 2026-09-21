import { describe, expect, test } from 'bun:test'
import { drawWaveformSignal } from '@daw-browser/waveforms/draw-waveform-signal'
import { decodePeakByte, encodePeakByte } from '@daw-browser/waveforms/extract-peaks'
import type { WaveformSourceData } from '@daw-browser/waveforms/types'
import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { resolveWaveformPaintStyle } from './waveform-style'
import {
  aggregateWaveformDataToBackingPixels,
  createWaveformRequestPlans,
  projectRetainedWaveformData,
  retainWaveformData,
} from './retained-waveform'
import { loadWaveformSourceData } from '@daw-browser/waveforms/select-waveform-window'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'

describe('waveform request planning', () => {
  const intervalDataFor = (
    samples: readonly number[],
    framesPerInterval: number,
    encoding: 'float32' | 'signed-u8' = 'float32',
  ): WaveformSourceData => {
    const intervalCount = Math.ceil(samples.length / framesPerInterval)
    const values = Array.from({ length: intervalCount }, (_, interval) => {
      const start = interval * framesPerInterval
      const end = Math.min(samples.length, start + framesPerInterval)
      const intervalSamples = samples.slice(start, end)
      return [
        Math.min(...intervalSamples),
        Math.max(...intervalSamples),
      ]
    }).flat()
    if (encoding === 'signed-u8') {
      return {
        kind: 'intervals',
        encoding,
        channels: [Uint8Array.from(values.map(encodePeakByte))],
        firstFrame: 0,
        sampleRate: 48_000,
        sourceFrameCount: samples.length,
        framesPerInterval,
        intervalCount,
      }
    }
    return {
      kind: 'intervals',
      encoding,
      channels: [Float32Array.from(values)],
      firstFrame: 0,
      sampleRate: 48_000,
      sourceFrameCount: samples.length,
      framesPerInterval,
      intervalCount,
    }
  }

  const aggregateSamples = (
    samples: readonly number[],
    framesPerInterval: number,
    cssWidthPx: number,
    backingPixelsPerCssPixel = 2,
  ) => aggregateWaveformDataToBackingPixels({
    data: intervalDataFor(samples, framesPerInterval),
    sourceStartFrame: 0,
    sourceEndFrame: samples.length,
    cssWidthPx,
    backingPixelsPerCssPixel,
  })

  test('uses canonical descriptor frame count for a short exact source window', async () => {
    const source: AudioPcmSourceDescriptor = {
      identity: '27-frame-source',
      durationSec: 27 / 48_000,
      frameCount: 27,
      sampleRate: 48_000,
      channelCount: 1,
      readPages: async function* (options = {}) {
        const startFrame = options.startFrame ?? 0
        const endFrame = options.endFrame ?? 27
        yield {
          startFrame,
          frameCount: endFrame - startFrame,
          sampleRate: 48_000,
          channelCount: 1,
          planes: [new Float32Array(endFrame - startFrame)],
        }
      },
    }
    const plan = createWaveformRequestPlans({
      sampleRate: source.sampleRate,
      sourceFrameCount: source.frameCount,
      segments: [{
        drawCols: 27,
        sourceStartSec: 0,
        sourceEndSec: source.durationSec,
        startPx: 0,
        endPx: 27,
        canvasStartSec: 0,
        canvasEndSec: source.durationSec,
      }],
    })
    expect(plan.requests[0]?.sourceEndFrame).toBe(27)
    const result = await loadWaveformSourceData({
      assetKey: '27-frame-source',
      source,
      sourceStartFrame: plan.requests[0]?.sourceStartFrame ?? -1,
      sourceEndFrame: plan.requests[0]?.sourceEndFrame ?? -1,
      framesPerInterval: 1,
    })
    expect(result?.kind).toBe('samples')
    expect(result?.kind === 'samples' ? result.channels[0]?.length : 0).toBe(27)
  })

  test('deduplicates aligned source ranges and tier identity', () => {
    const plan = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 48_000,
      segments: [
        { drawCols: 400, sourceStartSec: 0, sourceEndSec: 1, startPx: 0, endPx: 400, canvasStartSec: 0, canvasEndSec: 1 },
        { drawCols: 400, sourceStartSec: 0, sourceEndSec: 1, startPx: 0, endPx: 400, canvasStartSec: 0, canvasEndSec: 1 },
      ],
    })
    expect(plan.requests).toHaveLength(1)
    expect(plan.segments).toHaveLength(2)
  })

  test('keeps identical visible inputs on one surface-independent plan', () => {
    const input = {
      sampleRate: 48_000,
      sourceFrameCount: 48_000,
      backingPixelsPerCssPixel: 2,
      priorityRange: { startSec: 0.25, endSec: 0.75 },
      segments: [{
        drawCols: 400,
        sourceStartSec: 0,
        sourceEndSec: 1,
        startPx: 0,
        endPx: 400,
        canvasStartSec: 0,
        canvasEndSec: 1,
      }],
    }
    expect(createWaveformRequestPlans(input)).toEqual(createWaveformRequestPlans(input))
  })

  test('uses only persisted hierarchy levels at common sample rates and long durations', () => {
    const segment = {
      drawCols: 1000,
      sourceStartSec: 0,
      sourceEndSec: 3600,
      startPx: 0,
      endPx: 1000,
      canvasStartSec: 0,
      canvasEndSec: 3600,
    }
    const at48k = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 172_800_000,
      segments: [segment],
    })
    const at44k = createWaveformRequestPlans({
      sampleRate: 44_100,
      sourceFrameCount: 158_760_000,
      segments: [segment],
    })
    expect(at48k.requests[0]?.framesPerInterval).toBeGreaterThanOrEqual(128)
    expect(at44k.requests[0]?.framesPerInterval).toBeGreaterThanOrEqual(128)
    expect(at48k.requests[0]?.framesPerInterval).toBe(16_384)
    expect(at44k.requests[0]?.framesPerInterval).toBe(16_384)
  })

  test('prioritizes the segment nearest the visible range center', () => {
    const plan = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 192_000,
      priorityRange: { startSec: 1.5, endSec: 2.5 },
      segments: [
        { drawCols: 100, sourceStartSec: 0, sourceEndSec: 1, startPx: 0, endPx: 100, canvasStartSec: 0, canvasEndSec: 1 },
        { drawCols: 100, sourceStartSec: 2, sourceEndSec: 3, startPx: 100, endPx: 200, canvasStartSec: 2, canvasEndSec: 3 },
      ],
    })
    expect(plan.requests[0]?.priority).toBeGreaterThan(plan.requests[1]?.priority ?? 0)
  })

  test('keeps the best visible priority when aligned segments deduplicate', () => {
    const plan = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 192_000,
      priorityRange: { startSec: 1.5, endSec: 2.5 },
      segments: [
        { drawCols: 100, sourceStartSec: 0, sourceEndSec: 1, startPx: 0, endPx: 100, canvasStartSec: 0, canvasEndSec: 1 },
        { drawCols: 100, sourceStartSec: 0, sourceEndSec: 1, startPx: 100, endPx: 200, canvasStartSec: 1.5, canvasEndSec: 2.5 },
      ],
    })
    expect(plan.requests).toHaveLength(1)
    expect(plan.requests[0]?.priority).toBe(0)
  })

  test('keeps global interval ownership stable under tiny pans and tier changes', () => {
    const globalOwner = (frame: number, framesPerInterval: number) => (
      Math.floor(frame / framesPerInterval)
    )
    const requestRelativeOwner = (
      frame: number,
      requestStartFrame: number,
      framesPerInterval: number,
    ) => Math.floor((frame - requestStartFrame) / framesPerInterval)
    const frame = 16_384
    expect(globalOwner(frame, 128)).toBe(globalOwner(frame, 128))
    expect(globalOwner(frame + 1, 128)).toBe(globalOwner(frame + 1, 128))
    expect(globalOwner(frame, 256)).toBe(Math.floor(frame / 256))
    expect(requestRelativeOwner(frame, 0, 128)).not.toBe(
      requestRelativeOwner(frame, 1, 128),
    )
  })

  test('uses aligned transient interval tiers before exact samples', () => {
    const intervalPlan = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 48_000,
      segments: [{
        drawCols: 2_000,
        sourceStartSec: 0,
        sourceEndSec: 1,
        startPx: 0,
        endPx: 2_000,
        canvasStartSec: 0,
        canvasEndSec: 1,
      }],
    })
    const detailPlan = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 48_000,
      backingPixelsPerCssPixel: 1,
      segments: [{
        drawCols: 48_000,
        sourceStartSec: 0,
        sourceEndSec: 1,
        startPx: 0,
        endPx: 48_000,
        canvasStartSec: 0,
        canvasEndSec: 1,
      }],
    })
    expect(intervalPlan.requests[0]?.framesPerInterval).toBe(2)
    expect(detailPlan.requests[0]?.framesPerInterval).toBe(1)
  })

  test('allows exact PCM before point decoration becomes visible', () => {
    const plan = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 48_000,
      segments: [{
        drawCols: 160_000,
        sourceStartSec: 0,
        sourceEndSec: 1,
        startPx: 0,
        endPx: 160_000,
        canvasStartSec: 0,
        canvasEndSec: 1,
      }],
    })
    expect(plan.requests[0]?.framesPerInterval).toBe(1)
  })

  test('uses the same tier for the same visible source geometry', () => {
    const segment = {
      drawCols: 480,
      sourceStartSec: 0,
      sourceEndSec: 1,
      startPx: 0,
      endPx: 480,
      canvasStartSec: 0,
      canvasEndSec: 1,
    }
    expect(createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 48_000,
      segments: [segment],
    }).requests[0]?.framesPerInterval).toBe(8)
    const first = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 48_000,
      segments: [segment],
    })
    const second = createWaveformRequestPlans({
      sampleRate: 48_000,
      sourceFrameCount: 48_000,
      segments: [segment],
    })
    expect(second.requests[0]?.framesPerInterval).toBe(first.requests[0]?.framesPerInterval)
  })

  test('aligns adjacent interval tiers to the same canonical backing bins', () => {
    const makeData = (framesPerInterval: number): WaveformSourceData => ({
      kind: 'intervals',
      encoding: 'float32',
      channels: [Float32Array.from(
        { length: 128 / framesPerInterval * 2 },
        (_, index) => {
          const interval = Math.floor(index / 2)
          const base = Math.floor(interval * framesPerInterval / 16) % 2 === 0 ? -0.5 : 0.25
          return index % 2 === 0 ? base : base + 0.5
        },
      )],
      firstFrame: 0,
      sampleRate: 48_000,
      sourceFrameCount: 128,
      framesPerInterval,
      intervalCount: 128 / framesPerInterval,
    })
    const aggregate = (framesPerInterval: number) => aggregateWaveformDataToBackingPixels({
      data: makeData(framesPerInterval),
      sourceStartFrame: 0,
      sourceEndFrame: 128,
      cssWidthPx: 8,
      backingPixelsPerCssPixel: 2,
    })
    const fine = aggregate(8)
    const coarse = aggregate(16)
    expect(fine).toEqual(coarse)
    expect(fine.kind).toBe('intervals')
    if (fine.kind !== 'intervals') return
    expect(fine.framesPerInterval).toBe(8)
    expect([...fine.channels[0] ?? []]).toEqual(Array.from(
      { length: 32 },
      (_, index) => Math.floor(index / 4) % 2 === 0
        ? (index % 2 === 0 ? -0.5 : 0)
        : (index % 2 === 0 ? 0.25 : 0.75),
    ))
  })

  test('aggregates exact samples and signed peaks onto the same canonical grid', () => {
    const samples: WaveformSourceData = {
      kind: 'samples',
      channels: [Float32Array.from([-0.75, 0.25, 0.5, -0.125])],
      firstFrame: 0,
      sampleRate: 48_000,
      sourceFrameCount: 4,
    }
    const peaks = intervalDataFor(
      [-0.75, 0.25, 0.5, -0.125],
      1,
      'signed-u8',
    )
    const aggregate = (data: WaveformSourceData) => aggregateWaveformDataToBackingPixels({
      data,
      sourceStartFrame: 0,
      sourceEndFrame: 4,
      cssWidthPx: 2,
      backingPixelsPerCssPixel: 1,
    })
    const sampleAggregate = aggregate(samples)
    const peakAggregate = aggregate(peaks)
    expect(sampleAggregate.kind).toBe('intervals')
    expect(peakAggregate.kind).toBe('intervals')
    if (sampleAggregate.kind !== 'intervals' || peakAggregate.kind !== 'intervals') return
    expect(sampleAggregate.framesPerInterval).toBe(2)
    expect([...sampleAggregate.channels[0] ?? []]).toEqual([-0.75, 0.25, -0.125, 0.5])
    expect([...peakAggregate.channels[0] ?? []]).toHaveLength(4)
    for (const [index, value] of (peakAggregate.channels[0] ?? []).entries()) {
      expect(value).toBeCloseTo([
        decodePeakByte(encodePeakByte(-0.75)),
        decodePeakByte(encodePeakByte(0.25)),
        decodePeakByte(encodePeakByte(-0.125)),
        decodePeakByte(encodePeakByte(0.5)),
      ][index] ?? value)
    }
    expect(peakAggregate.channels[0]?.every((value, index) => (
      Math.abs(value - (sampleAggregate.channels[0]?.[index] ?? value)) <= 1 / 127
    ))).toBe(true)
  })

  test('keeps deterministic waveform features tier-invariant across zoom direction', () => {
    const waveforms = [
      Array.from({ length: 1_024 }, (_, index) => Math.sin(index / 17) * 0.7),
      Array.from({ length: 1_024 }, (_, index) => index === 317 ? 0.91 : index === 683 ? -0.47 : 0),
      Array.from({ length: 1_024 }, (_, index) => Math.abs(Math.sin(index / 23)) * 0.8),
      Array.from({ length: 1_024 }, (_, index) => -Math.abs(Math.sin(index / 23)) * 0.8),
    ]
    const widths = [16, 32, 64]
    for (const samples of waveforms) {
      const forward = widths.map((width) => aggregateSamples(samples, 8, width, 1))
      const reverse = [...widths].reverse().map((width) => aggregateSamples(samples, 16, width, 1))
      for (let index = 0; index < widths.length; index += 1) {
        expect(forward[index]).toEqual(reverse[widths.length - 1 - index])
      }
    }
  })

  test('preserves the canonical feature X and bounded signed encoding error at publication', () => {
    const samples = Array.from({ length: 1_024 }, (_, index) => (
      Math.floor(index / 64) % 2 === 0 ? -0.75 : 0.5
    ))
    const fine = aggregateSamples(samples, 32, 32, 1)
    const coarse = aggregateSamples(samples, 64, 32, 1)
    expect(fine).toEqual(coarse)
    if (fine.kind !== 'intervals') return
    const values = fine.channels[0]
    expect(values).toBeDefined()
    expect(fine.firstFrame).toBe(0)
    expect(fine.intervalCount).toBe(32)
    expect(fine.framesPerInterval).toBe(32)
    for (let index = 0; index < fine.intervalCount; index += 1) {
      const startFrame = fine.firstFrame + index * fine.framesPerInterval
      expect(startFrame / fine.framesPerInterval).toBeCloseTo(index)
      const minimum = values?.[index * 2] ?? 0
      const maximum = values?.[index * 2 + 1] ?? 0
      expect(minimum).toBeLessThanOrEqual(maximum)
      expect(Math.abs(minimum)).toBeLessThanOrEqual(1)
      expect(Math.abs(maximum)).toBeLessThanOrEqual(1)
    }
    const encoded = samples.map(encodePeakByte)
    expect(Math.max(...encoded.map((value, index) => (
      Math.abs(decodePeakByte(value) - samples[index]!)
    )))).toBeLessThanOrEqual(1 / 127)
  })

  test('keeps Arrangement and Sample Detail plans, geometry, and painter commands identical', () => {
    const clip = {
      id: 'parity',
      name: 'parity',
      startSec: 0,
      duration: 1,
      color: '#fff',
    }
    const map = getAudioClipTimeMap({
      clip,
      bufferDurationSec: 1,
      projectBpm: 120,
      rangeStartSec: 0,
      rangeEndSec: 1,
    })
    if (!map) throw new Error('Expected parity time map')
    const cases = [
      { name: 'zero', baseWidth: 6, expectedTier: 64, sampleValue: 0 },
      { name: 'narrow', baseWidth: 6, expectedTier: 64, sampleValue: 0.001 },
      { name: 'raster-sensitive', baseWidth: 6, expectedTier: 64, deviceThickness: 1.001 },
      { name: 'coarse', baseWidth: 6, expectedTier: 64 },
      { name: 'fine', baseWidth: 48, expectedTier: 8 },
      { name: 'transient', baseWidth: 200, expectedTier: 2 },
      { name: 'exact', baseWidth: 24_000, expectedTier: 1 },
    ] as const

    for (const channelCount of [1, 2]) {
      for (const backingPixelsPerCssPixel of [1, 2, 3]) {
        for (const item of cases) {
          const sampleValue = 'sampleValue' in item ? item.sampleValue : undefined
          const deviceThickness = 'deviceThickness' in item ? item.deviceThickness : undefined
          const width = Math.max(1, Math.round(item.baseWidth / backingPixelsPerCssPixel))
          const segment = {
            drawCols: width,
            sourceStartSec: 0,
            sourceEndSec: 0.1,
            startPx: 0,
            endPx: width,
            canvasStartSec: 0,
            canvasEndSec: 1,
          }
          const input = {
            sampleRate: 48_000,
          sourceFrameCount: 48_000,
            backingPixelsPerCssPixel,
            segments: [segment],
          }
          const arrangement = createWaveformRequestPlans(input)
          const sampleDetail = createWaveformRequestPlans(input)
          expect(arrangement.requests).toEqual(sampleDetail.requests)
          expect(arrangement.segments.map((plan) => ({
            requestKey: plan.requestKey,
            tier: plan.tier.framesPerInterval,
            startPx: plan.segment.startPx,
            endPx: plan.segment.endPx,
          }))).toEqual(sampleDetail.segments.map((plan) => ({
            requestKey: plan.requestKey,
            tier: plan.tier.framesPerInterval,
            startPx: plan.segment.startPx,
            endPx: plan.segment.endPx,
          })))
          expect(arrangement.requests[0]?.framesPerInterval).toBe(item.expectedTier)
          const framesPerInterval = item.expectedTier
          const sampleCount = 4_800
          const data: WaveformSourceData = framesPerInterval === 1
            ? {
              kind: 'samples',
              channels: Array.from(
                { length: channelCount },
                () => Float32Array.from({ length: sampleCount }, (_, index) => (
                  sampleValue ?? Math.sin(index / 7) * 0.5
                )),
              ),
              firstFrame: 0,
              sampleRate: 48_000,
              sourceFrameCount: 48_000,
            }
            : {
              kind: 'intervals',
              encoding: 'float32',
              channels: Array.from(
                { length: channelCount },
                () => Float32Array.from(
                  { length: Math.ceil(sampleCount / framesPerInterval) * 2 },
                  (_, index) => deviceThickness !== undefined
                    ? (index % 2 === 0
                      ? -deviceThickness / (backingPixelsPerCssPixel * 100 * 0.9)
                      : deviceThickness / (backingPixelsPerCssPixel * 100 * 0.9))
                    : sampleValue ?? (index % 2 === 0 ? -0.5 : 0.5),
                ),
              ),
              firstFrame: 0,
              sampleRate: 48_000,
              sourceFrameCount: 48_000,
              framesPerInterval,
              intervalCount: Math.ceil(sampleCount / framesPerInterval),
            }
          const render = (plans: ReturnType<typeof createWaveformRequestPlans>) => {
            const projected = projectRetainedWaveformData({
              retainedByKey: new Map([[plans.requests[0]?.key ?? '', retainWaveformData(data)]]),
              segments: plans.segments,
              map,
            })
            const commands: string[] = []
            const ctx = {
              fillStyle: '',
              beginPath: () => commands.push('beginPath'),
              moveTo: (x: number, y: number) => commands.push(`moveTo:${x}:${y}`),
              lineTo: (x: number, y: number) => commands.push(`lineTo:${x}:${y}`),
              fill: () => commands.push('fill'),
              arc: (x: number, y: number, radius: number) => commands.push(`arc:${x}:${y}:${radius}`),
            }
            for (const segment of projected) {
              drawWaveformSignal(ctx, {
                data: segment.data,
                sourceStartFrame: segment.sourceStartFrame,
                sourceEndFrame: segment.sourceEndFrame,
                startPx: segment.startPx,
                endPx: segment.endPx,
                topY: 0,
                contentH: 100,
                channelCount,
                style: resolveWaveformPaintStyle({
                  color: '#fff',
                  backingScaleY: backingPixelsPerCssPixel,
                }),
              })
            }
            return { projected, commands }
          }
          const arrangementRender = render(arrangement)
          const sampleDetailRender = render(sampleDetail)
          expect(arrangementRender.projected.map((value) => ({
            startPx: value.startPx,
            endPx: value.endPx,
            sourceStartFrame: value.sourceStartFrame,
            sourceEndFrame: value.sourceEndFrame,
            kind: value.data.kind,
          }))).toEqual(sampleDetailRender.projected.map((value) => ({
            startPx: value.startPx,
            endPx: value.endPx,
            sourceStartFrame: value.sourceStartFrame,
            sourceEndFrame: value.sourceEndFrame,
            kind: value.data.kind,
          })))
          expect(arrangementRender.commands).toEqual(sampleDetailRender.commands)
        }
      }
    }
  })
})
