import { describe, expect, test } from 'bun:test'
import {
  applyExportNormalization,
  findAutomaticTailEndFrame,
  limitTruePeakInPlace,
  normalizeExportNormalization,
  normalizeExportTailPolicy,
  normalizeWavEncodingSettings,
  quantizeWavInPlace,
} from './export-fidelity'
import { scanTruePeak } from './true-peak-scanner'

const buffer = (samples: number[], sampleRate = 10) => {
  const data = Float32Array.from(samples)
  return {
    numberOfChannels: 1,
    length: data.length,
    sampleRate,
    getChannelData: (_channel: number) => data,
  }
}

describe('export fidelity contracts', () => {
  test('migrates defaults and clamps bounded settings', () => {
    expect(normalizeWavEncodingSettings({ codec: 'pcm-f32', dither: 'tpdf' })).toEqual({ codec: 'pcm-f32', dither: 'none' })
    expect(normalizeExportNormalization({
      mode: 'loudness',
      targetLufs: -50,
      truePeakCeilingDbtp: 4,
      limiting: 'true-peak',
    })).toEqual({
      mode: 'loudness',
      targetLufs: -36,
      truePeakCeilingDbtp: 0,
      limiting: 'true-peak',
    })
    expect(normalizeExportTailPolicy({
      mode: 'automatic',
      thresholdDbfs: -200,
      holdSec: 0,
      maximumSec: 500,
    })).toEqual({
      mode: 'automatic',
      thresholdDbfs: -120,
      holdSec: 0.1,
      maximumSec: 120,
    })
  })

  test('trims an automatic tail only after the hold duration', () => {
    const audio = buffer([1, 0.5, 0.2, 0, 0, 0, 0], 10)
    expect(findAutomaticTailEndFrame(audio, 2, {
      mode: 'automatic',
      thresholdDbfs: -20,
      holdSec: 0.2,
      maximumSec: 1,
    })).toBe(5)
  })

  test('uses deterministic TPDF immediately with integer quantization', () => {
    const first = buffer([0.1, -0.1, 0, 0])
    const second = buffer([0.1, -0.1, 0, 0])
    quantizeWavInPlace(first, { codec: 'pcm-s16', dither: 'tpdf' }, 42)
    quantizeWavInPlace(second, { codec: 'pcm-s16', dither: 'tpdf' }, 42)
    expect([...first.getChannelData(0)]).toEqual([...second.getChannelData(0)])
    for (const sample of first.getChannelData(0)) expect(sample * 32768).toBeCloseTo(Math.round(sample * 32768), 5)
  })
})

describe('offline true-peak limiter', () => {
  const audioBuffer = (channels: number[][], sampleRate = 48_000) => {
    const data = channels.map((values) => Float32Array.from(values))
    return {
      numberOfChannels: data.length,
      length: data[0]?.length ?? 0,
      sampleRate,
      getChannelData(channel: number) {
        const samples = data[channel]
        if (!samples) throw new Error('Missing channel')
        return samples
      },
    }
  }

  test('limits intersample peaks while input samples remain below the ceiling', () => {
    const samples = Array.from({ length: 4_096 }, (_, frame) => 0.88 * Math.sin(2 * Math.PI * 19_000 * frame / 48_000))
    const audio = audioBuffer([samples])
    expect(Math.max(...samples.map(Math.abs))).toBeLessThan(0.9)
    expect(limitTruePeakInPlace(audio, -1)).toBe(true)
    expect(scanTruePeak(audio).peakDbtp).toBeLessThanOrEqual(-0.9)
  })

  test('uses a linked gain envelope for stereo and releases after a transient', () => {
    const left = Array.from<number>({ length: 8_192 }).fill(0.2)
    const right = Array.from<number>({ length: 8_192 }).fill(0.2)
    left[1_000] = 1
    const audio = audioBuffer([left, right])
    limitTruePeakInPlace(audio, -3)
    const delayedTransient = 1_000
    expect(audio.getChannelData(1)[0]).toBeCloseTo(0.2, 6)
    expect(audio.getChannelData(1)[delayedTransient]).toBeLessThan(0.2)
    expect(audio.getChannelData(1).at(-1) ?? 0).toBeGreaterThan(audio.getChannelData(1)[delayedTransient])
    expect(scanTruePeak(audio).peakDbtp).toBeLessThanOrEqual(-2.9)
  })

  test('reports a ceiling-constrained result for incompatible high-crest loudness targets', () => {
    const samples = Array.from<number>({ length: 48_000 * 4 }).fill(0.001)
    samples[48_000 * 2] = 1
    const audio = audioBuffer([samples])
    const report = applyExportNormalization(audio, {
      mode: 'loudness',
      targetLufs: -5,
      truePeakCeilingDbtp: -6,
      limiting: 'true-peak',
    })
    expect(report.ceilingConstrained).toBe(true)
    expect(report.integratedLufs).not.toBeNull()
    expect(report.truePeakDbtp ?? 0).toBeLessThanOrEqual(-5.9)
  })

  test('reports measured peaks without enforcing a true-peak ceiling when limiting is disabled', () => {
    const audio = audioBuffer([Array.from<number>({ length: 48_000 }).fill(1)])
    expect(() => applyExportNormalization(audio, {
      mode: 'loudness',
      targetLufs: -36,
      truePeakCeilingDbtp: -12,
      limiting: 'off',
    })).not.toThrow()
  })

  test('supports mono and cancellation', () => {
    const audio = audioBuffer([[0, 1, 0]])
    expect(() => limitTruePeakInPlace(audio, -1)).not.toThrow()
    const controller = new AbortController()
    controller.abort()
    expect(() => limitTruePeakInPlace(audio, -1, controller.signal)).toThrow()
  })
})
