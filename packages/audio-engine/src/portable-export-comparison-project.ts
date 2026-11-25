import { automationTargetKey, createDefaultCompressorParams, createDefaultDelayParams, type AutomationEnvelope } from '@daw-browser/shared'
import type { ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import type { ExportFx } from './export-types'

export type ComparisonVariant = 'automation' | 'full'

export const comparisonSampleRate = 48_000
export const comparisonDurationSec = 3
export const comparisonToneHz = 1_000
export const comparisonKickBursts = [{ startSec: 0.6, endSec: 0.9 }, { startSec: 1.8, endSec: 2.1 }] as const

/** A planar PCM `AudioBuffer` for runtimes without the Web Audio constructor. */
export class PlanarAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number

  constructor(private readonly channels: Float32Array<ArrayBuffer>[], readonly sampleRate: number) {
    this.numberOfChannels = channels.length
    this.length = channels[0]?.length ?? 0
    this.duration = this.length / sampleRate
  }

  copyFromChannel(destination: Float32Array, channel: number, offset = 0) {
    destination.set(this.channels[channel].subarray(offset, offset + destination.length))
  }

  copyToChannel(source: Float32Array, channel: number, offset = 0) {
    this.channels[channel].set(source, offset)
  }

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    return this.channels[channel]
  }
}

const planes = (generate: (timeSec: number) => number): Float32Array[] => {
  const samples = Float32Array.from(
    { length: comparisonSampleRate * comparisonDurationSec },
    (_, frame) => generate(frame / comparisonSampleRate),
  )

  return [samples, samples]
}

const envelope = (
  trackId: string,
  parameterId: string,
  points: readonly (readonly [number, number, 'linear' | 'hold'])[],
  effectInstanceId?: string,
): AutomationEnvelope => {
  const target = { kind: 'track', trackId, effectInstanceId } as const

  return {
    id: `${trackId}:${parameterId}`,
    projectId: 'project',
    target,
    targetKey: automationTargetKey(target, parameterId),
    parameterId,
    enabled: true,
    points: points.map(([timeSec, value, interpolation], index) => ({ id: `${parameterId}:${index}`, timeSec, value, interpolation })),
    updatedAt: 1,
  }
}

/**
 * One project that exercises every export feature the portable Worker must
 * match against the legacy OfflineAudioContext render: mixer volume
 * automation, an automated delay parameter, and (in the `full` variant) a
 * compressor sidechained to a second track.
 */
export const createComparisonProject = (
  createBuffer: (planes: Float32Array[], sampleRate: number) => AudioBuffer,
  variant: ComparisonVariant = 'full',
) => {
  const clip = (id: string, buffer: AudioBuffer): Track<AudioBuffer>['clips'][number] => ({
    id,
    name: id,
    color: '#fff',
    startSec: 0,
    duration: comparisonDurationSec,
    sourceAssetKey: id,
    buffer,
  })

  const tracks: Track<AudioBuffer>[] = [
    {
      id: 'tone',
      name: 'tone',
      volume: 1,
      clips: [clip('tone-clip', createBuffer(planes((t) => 0.4 * Math.sin(2 * Math.PI * comparisonToneHz * t)), comparisonSampleRate))],
    },
    {
      id: 'kick',
      name: 'kick',
      volume: 1,
      clips: [clip('kick-clip', createBuffer(planes((t) => (
        comparisonKickBursts.some((burst) => t >= burst.startSec && t < burst.endSec)
          ? 0.9 * Math.sin(2 * Math.PI * 60 * t)
          : 0
      )), comparisonSampleRate))],
    },
  ]

  const compressor = {
    id: 'comp',
    kind: 'compressor',
    params: { ...createDefaultCompressorParams(), thresholdDb: -30, ratio: 8, attackMs: 2, releaseMs: 80, lookaheadMs: 10 },
  } as const

  const fx: ExportFx = {
    masterFxInstances: [],
    trackFx: {
      tone: {
        instances: [
          // 100.5 ms is a whole number of tone periods plus half of one, so the wet copy is in antiphase and a quarter-wet mix halves the tone.
          { id: 'delay', kind: 'delay', params: { ...createDefaultDelayParams(), mode: 'time', timeMs: 100.5, feedback: 0, dryWet: 0 } },
          ...(variant === 'full' ? [compressor] : []),
        ],
      },
    },
  }

  const automationEnvelopes = [
    envelope('tone', 'volume', [[0.5, 1, 'linear'], [2.5, 0.5, 'linear']]),
    envelope('tone', 'delay.dryWet', [[1, 0, 'linear'], [1.2, 0.25, 'linear']], 'delay'),
  ]

  const sidechainRoutes: ExternalSidechainRoute[] = variant === 'full'
    ? [{ sourceTrackId: 'kick', targetTrackId: 'tone', effectInstanceId: 'comp' }]
    : []

  return { tracks, fx, automationEnvelopes, sidechainRoutes }
}
