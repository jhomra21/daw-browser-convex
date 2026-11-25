import { describe, expect, test } from 'bun:test'
import { automationEnvelopeFromRow, automationTargetKey, type AutomationEnvelope } from '@daw-browser/shared'
import {
  comparisonDurationSec,
  comparisonKickBursts,
  comparisonSampleRate,
  comparisonToneHz,
  createComparisonProject,
  PlanarAudioBuffer,
} from './portable-export-comparison-project'
import { compilePortableExportSnapshot } from './portable-export-snapshot'
import { renderThroughExportWorker } from './portable-export-render-harness'

type ProjectOptions = { effects: readonly ('delay' | 'comp')[]; volume?: boolean; delayWet?: boolean; sidechain?: boolean }

const project = (options: ProjectOptions) => {
  const base = createComparisonProject((planes, sampleRate) => new PlanarAudioBuffer(planes.map((plane) => new Float32Array(plane)), sampleRate))

  return {
    ...base,
    fx: {
      ...base.fx,
      trackFx: {
        tone: { instances: (base.fx.trackFx?.tone?.instances ?? []).filter((instance) => options.effects.includes(instance.id === 'delay' ? 'delay' : 'comp')) },
      },
    },
    automationEnvelopes: base.automationEnvelopes.filter((envelope) => (
      envelope.parameterId === 'volume' ? options.volume === true : options.delayWet === true
    )),
    sidechainRoutes: options.sidechain === true ? base.sidechainRoutes : [],
  }
}

const render = async (input: ReturnType<typeof project>) => {
  const snapshot = compilePortableExportSnapshot({
    tracks: input.tracks,
    bpm: 120,
    range: { mode: 'custom', startSec: 0, endSec: comparisonDurationSec },
    sampleRateHz: comparisonSampleRate,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    fx: input.fx,
    automationEnvelopes: input.automationEnvelopes,
    sidechainRoutes: input.sidechainRoutes,
  })

  if (!snapshot.supported) throw new Error(snapshot.reasons.join('\n'))

  const rendered = await renderThroughExportWorker(snapshot, {
    sampleRateHz: comparisonSampleRate,
    frameCount: comparisonSampleRate * comparisonDurationSec + snapshot.graphLatencyFrames,
  })

  expect(rendered.failures).toEqual([])

  // Drop the graph latency pre-roll exactly as the export job does.
  return { snapshot, left: rendered.planes[0].subarray(snapshot.graphLatencyFrames) }
}

/** Amplitude of the tone's frequency in a Hann-windowed span, so the 60 Hz kick and delay tails do not read as tone. */
const toneAmplitude = (samples: Float32Array, startSec: number, endSec: number) => {
  const start = Math.round(startSec * comparisonSampleRate)
  const length = Math.round(endSec * comparisonSampleRate) - start
  let real = 0
  let imaginary = 0
  let windowSum = 0

  for (let index = 0; index < length; index += 1) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1))
    const phase = 2 * Math.PI * comparisonToneHz * (start + index) / comparisonSampleRate
    real += window * (samples[start + index] ?? 0) * Math.cos(phase)
    imaginary += window * (samples[start + index] ?? 0) * Math.sin(phase)
    windowSum += window
  }

  return 2 * Math.hypot(real, imaginary) / windowSum
}

const timeout = 120_000

describe('portable export automation, sidechains and graph latency', () => {
  test('mixer volume automation follows the envelope in timeline time', async () => {
    const { snapshot, left } = await render(project({ effects: [], volume: true }))

    expect(snapshot.automation.length).toBeGreaterThan(0)
    // Volume ramps 1 -> 0.5 between 0.5 s and 2.5 s; the tone amplitude is 0.4.
    expect(toneAmplitude(left, 0.1, 0.4)).toBeCloseTo(0.4, 2)
    expect(toneAmplitude(left, 1.4, 1.6)).toBeCloseTo(0.4 * 0.75, 2)
    expect(toneAmplitude(left, 2.6, 2.9)).toBeCloseTo(0.2, 2)
  }, timeout)

  test('keeps automation on the timeline when graph latency delays the output', async () => {
    const { snapshot, left } = await render(project({ effects: ['comp'], volume: true, sidechain: true }))

    expect(snapshot.graphLatencyFrames).toBeGreaterThan(0)
    expect(toneAmplitude(left, 1.4, 1.6)).toBeCloseTo(0.4 * 0.75, 2)
  }, timeout)

  test('an automated processor parameter changes the render only from its automation', async () => {
    const automated = await render(project({ effects: ['delay'], delayWet: true }))
    const held = await render(project({ effects: ['delay'] }))

    // delay.dryWet ramps 0 -> 0.25 from 1.0 s; the copy is in antiphase, so the tone falls to |0.75 - 0.25| of its level.
    expect(toneAmplitude(held.left, 1.5, 1.9)).toBeCloseTo(0.4, 2)
    expect(toneAmplitude(automated.left, 1.5, 1.9)).toBeCloseTo(0.4 * 0.5, 2)
    expect(toneAmplitude(automated.left, 0.2, 0.8)).toBeCloseTo(0.4, 2)
  }, timeout)

  test('a fader and a processor parameter automated in the same blocks both apply', async () => {
    const faderOnly = await render(project({ effects: ['delay'], volume: true }))
    const both = await render(project({ effects: ['delay'], volume: true, delayWet: true }))

    expect(toneAmplitude(both.left, 1.5, 1.9) / toneAmplitude(faderOnly.left, 1.5, 1.9)).toBeCloseTo(0.5, 2)
  }, timeout)

  test('a sidechained compressor ducks the tone while the source track plays, and only then', async () => {
    const routed = await render(project({ effects: ['comp'], sidechain: true }))
    const selfDetected = await render(project({ effects: ['comp'] }))
    const burst = comparisonKickBursts[0]

    expect(toneAmplitude(routed.left, 0.1, 0.5)).toBeCloseTo(0.4, 2)
    expect(toneAmplitude(routed.left, burst.startSec + 0.1, burst.endSec - 0.05)).toBeLessThan(0.4 * 0.6)
    // Without the route the detector hears the tone itself, which is what the route replaces.
    expect(toneAmplitude(selfDetected.left, 0.1, 0.5)).toBeLessThan(0.4 * 0.5)
  }, timeout)

  test('dense automation is split across windows and the held value survives each reinstall', async () => {
    const points = Array.from({ length: 600 }, (_, index) => ({
      id: `p${index}`,
      timeSec: 0.5 + index * 0.0002,
      value: index % 2 === 0 ? 1 : 0.5,
      interpolation: 'hold' as const,
    }))

    const target = { kind: 'track', trackId: 'tone' } as const

    const dense: AutomationEnvelope = {
      id: 'dense',
      projectId: 'project',
      target,
      targetKey: automationTargetKey(target, 'volume'),
      parameterId: 'volume',
      enabled: true,
      points: [...points, { id: 'end', timeSec: 1, value: 0.25, interpolation: 'hold' }],
      updatedAt: 1,
    }

    const { left } = await render({ ...project({ effects: [] }), automationEnvelopes: [dense] })

    expect(toneAmplitude(left, 1.2, 1.9)).toBeCloseTo(0.4 * 0.25, 2)
  }, timeout)

  test('a saved cloud lane for a retired parameter does not make the session unsupported', () => {
    const base = project({ effects: ['delay'], delayWet: true })
    const retired = automationEnvelopeFromRow({
      _id: 'retired',
      projectId: 'project',
      targetKind: 'track',
      trackId: 'tone',
      effectInstanceId: 'delay',
      parameterId: 'gate.lookaheadMs',
      enabled: true,
      points: [{ id: 'p', timeSec: 0, value: 1, interpolation: 'linear' }],
      updatedAt: 1,
    })
    const compile = (automationEnvelopes: readonly AutomationEnvelope[]) => compilePortableExportSnapshot({
      tracks: base.tracks,
      bpm: 120,
      range: { mode: 'custom', startSec: 0, endSec: comparisonDurationSec },
      sampleRateHz: comparisonSampleRate,
      revision: 1,
      epoch: 1,
      firstSequence: 1,
      fx: base.fx,
      automationEnvelopes,
    })

    expect(retired).toBeNull()
    expect(compile([...base.automationEnvelopes, ...retired === null ? [] : [retired]]).supported).toBe(true)
    expect(compile([...base.automationEnvelopes, {
      id: 'retired',
      projectId: 'project',
      target: { kind: 'track', trackId: 'tone', effectInstanceId: 'delay' },
      targetKey: 'retired',
      parameterId: 'gate.lookaheadMs',
      enabled: true,
      points: [{ id: 'p', timeSec: 0, value: 1, interpolation: 'linear' }],
      updatedAt: 1,
    }]).supported).toBe(false)
  })

  test('automation that targets a parameter the graph does not expose is refused', () => {
    const base = project({ effects: ['delay'], delayWet: true })

    const result = compilePortableExportSnapshot({
      tracks: base.tracks,
      bpm: 120,
      range: { mode: 'custom', startSec: 0, endSec: comparisonDurationSec },
      sampleRateHz: comparisonSampleRate,
      revision: 1,
      epoch: 1,
      firstSequence: 1,
      fx: base.fx,
      automationEnvelopes: base.automationEnvelopes.map((envelope) => ({ ...envelope, parameterId: 'delay.nope' })),
    })

    expect(result.supported).toBe(false)
  })
})
