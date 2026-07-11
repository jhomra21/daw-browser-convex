import { describe, expect, test } from 'bun:test'
import { scanTruePeak } from './true-peak-scanner'
import {
  assertExportTruePeakWithinLimiterCeiling,
  resolveExportLimiterCeilingDbtp,
} from './export-mixdown'
import type { ResolvedMixerGraph } from './mixer/types'

const createBuffer = (channels: readonly Float32Array[]) => ({
  numberOfChannels: channels.length,
  length: channels[0]?.length ?? 0,
  getChannelData(channel: number) {
    const data = channels[channel]
    if (!data) throw new Error('Missing channel')
    return data
  },
})

const limiter = (id: string, ceilingDbtp: number, enabled = true) => ({
  id,
  kind: 'limiter' as const,
  params: {
    version: 1 as const,
    state: {
      enabled,
      ceilingDbtp,
      releaseMs: 100,
      lookaheadMs: 5,
      link: 1,
      detectorOversampling: 4 as const,
    },
  },
})

describe('independent true-peak scanner', () => {
  test('detects intersample peaks in mono and stereo at export sample rates', () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      const samples = Float32Array.from(
        { length: Math.ceil(sampleRate * 0.01) },
        (_, frame) => 0.9 * Math.sin(2 * Math.PI * 0.3 * frame + Math.PI / 4),
      )
      const mono = scanTruePeak(createBuffer([samples]))
      const stereo = scanTruePeak(createBuffer([samples, Float32Array.from(samples, (sample) => -sample)]))
      expect(mono.peak).toBeGreaterThan(Math.max(...samples.map(Math.abs)))
      expect(stereo.peak).toBeCloseTo(mono.peak, 10)
    }
  })

  test('accepts and rejects against the configured tolerance', () => {
    const samples = Float32Array.from([0, 0.9, -0.9, 0.9, -0.9, 0])
    const buffer = createBuffer([samples])
    const peakDbtp = scanTruePeak(buffer).peakDbtp
    expect(() => assertExportTruePeakWithinLimiterCeiling(buffer, peakDbtp - 0.1)).not.toThrow()
    expect(() => assertExportTruePeakWithinLimiterCeiling(buffer, peakDbtp - 0.11)).toThrow(
      /exceeds the reachable limiter ceiling/,
    )
    expect(() => assertExportTruePeakWithinLimiterCeiling(buffer, undefined)).not.toThrow()
  })

  test('honors cancellation', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => scanTruePeak(createBuffer([new Float32Array(8)]), controller.signal)).toThrow()
  })
})

describe('reachable limiter ceiling', () => {
  const graph = (channels: ResolvedMixerGraph['channels'], masterInstances = [limiter('master', -1)]): ResolvedMixerGraph => ({
    channels,
    master: {
      volume: 1,
      instances: masterInstances,
      inputLayout: 'stereo',
      outputLayout: 'stereo',
    },
  })
  const channel = (
    id: string,
    options: {
      outputTargetId?: string
      outputGain?: number
      sends?: { targetId: string; amount: number }[]
      instances?: ReturnType<typeof limiter>[]
    } = {},
  ): ResolvedMixerGraph['channels'][number] => ({
    channel: { id, name: id, role: 'track', volume: 1, muted: false, soloed: false, sends: options.sends ?? [] },
    gain: 1,
    outputGain: options.outputGain ?? 1,
    outputTargetId: options.outputTargetId,
    sends: options.sends ?? [],
    fx: { instances: options.instances },
    inputLayout: 'stereo',
    outputLayout: 'stereo',
  })

  test('uses only enabled limiters on the final master bus', () => {
    expect(resolveExportLimiterCeilingDbtp(graph([
      channel('source', { outputTargetId: 'group', instances: [limiter('source-limiter', -2)] }),
      channel('group', { instances: [limiter('group-limiter', -3)] }),
    ]))).toBe(-1)
    expect(resolveExportLimiterCeilingDbtp(graph([
      channel('source', { instances: [limiter('track-limiter', -12)] }),
      channel('second'),
    ], [limiter('master-limiter', -1)]))).toBe(-1)
  })

  test('ignores disabled and unreachable limiters', () => {
    expect(resolveExportLimiterCeilingDbtp(graph([
      channel('disabled', { instances: [limiter('disabled-limiter', -8, false)] }),
      channel('unreachable', {
        outputTargetId: 'cycle',
        outputGain: 0,
        instances: [limiter('unreachable-limiter', -10)],
      }),
      channel('cycle', { outputTargetId: 'unreachable', outputGain: 0 }),
    ], []))).toBeUndefined()
  })
})
