import { describe, expect, test } from 'bun:test'
import { createSourceAutomationScope, getAudioBufferPeak, isAutomationEnvelopeInSourceScope, normalizeAudioBufferInPlace } from './export-mixdown'
import { automationTargetKey, type AutomationEnvelope } from '@daw-browser/shared'
import type { ResolvedMixerChannel, ResolvedMixerGraph } from './mixer/types'

const channel = (
  id: string,
  options: {
    outputTargetId?: string
    sends?: { targetId: string; amount: number }[]
    role?: 'track' | 'group' | 'return'
  } = {},
): ResolvedMixerChannel => ({
  channel: {
    id,
    name: id,
    role: options.role ?? 'track',
    volume: 1,
    muted: false,
    soloed: false,
    sends: options.sends ?? [],
    outputTargetId: options.outputTargetId,
  },
  gain: 1,
  outputGain: 1,
  outputTargetId: options.outputTargetId,
  sends: options.sends ?? [],
})

describe('createSourceAutomationScope', () => {
  test('includes sends reachable through output ancestors', () => {
    const graph: ResolvedMixerGraph = {
      channels: [
        channel('source', { outputTargetId: 'group' }),
        channel('group', {
          sends: [{ targetId: 'return', amount: 1 }],
        }),
        channel('return'),
        channel('unrelated'),
      ],
      master: { volume: 1 },
    }

    const scope = createSourceAutomationScope(graph, {
      sourceTrackIds: new Set(['source']),
      includeMasterFx: false,
    })

    expect(scope.includeMasterFx).toBe(false)
    expect(scope.trackIds).toEqual(new Set(['source', 'group', 'return']))
  })

  test('follows send targets through their output paths and sends', () => {
    const graph: ResolvedMixerGraph = {
      channels: [
        channel('source', {
          sends: [{ targetId: 'return-a', amount: 1 }],
        }),
        channel('return-a', {
          outputTargetId: 'group',
          sends: [{ targetId: 'return-b', amount: 1 }],
        }),
        channel('group'),
        channel('return-b'),
      ],
      master: { volume: 1 },
    }

    const scope = createSourceAutomationScope(graph, {
      sourceTrackIds: new Set(['source']),
      includeMasterFx: true,
    })

    expect(scope.trackIds).toEqual(new Set(['source', 'return-a', 'group', 'return-b']))
  })
})

describe('isAutomationEnvelopeInSourceScope', () => {
  const envelope = (target: AutomationEnvelope['target'], parameterId: string): AutomationEnvelope => ({
    id: `${parameterId}-automation`,
    projectId: 'project-1',
    target,
    targetKey: automationTargetKey(target, parameterId),
    parameterId,
    enabled: true,
    points: [{ id: 'point-1', timeSec: 0, value: 0.5, interpolation: 'linear' }],
    updatedAt: 1,
  })

  test('keeps master volume automation for source-isolated stems without master FX', () => {
    const graph: ResolvedMixerGraph = {
      channels: [channel('source'), channel('unrelated')],
      master: { volume: 1 },
    }
    const scope = createSourceAutomationScope(graph, {
      sourceTrackIds: new Set(['source']),
      includeMasterFx: false,
    })

    expect(isAutomationEnvelopeInSourceScope(scope, envelope({ kind: 'master' }, 'volume'))).toBe(true)
    expect(isAutomationEnvelopeInSourceScope(scope, envelope({ kind: 'master' }, 'reverb:mix'))).toBe(false)
    expect(isAutomationEnvelopeInSourceScope(scope, envelope({ kind: 'track', trackId: 'source' }, 'volume'))).toBe(true)
    expect(isAutomationEnvelopeInSourceScope(scope, envelope({ kind: 'track', trackId: 'unrelated' }, 'volume'))).toBe(false)
  })
})

describe('normalizeAudioBufferInPlace', () => {
  const createBuffer = (channels: number[][]) => {
    const data = channels.map((channelData) => new Float32Array(channelData))
    return {
      numberOfChannels: data.length,
      getChannelData(channel: number) {
        const channelData = data[channel]
        if (!channelData) throw new Error('Missing channel')
        return channelData
      },
    }
  }

  test('normalizes all channels once to full scale', () => {
    const buffer = createBuffer([[0.25, -0.5], [0.1, 0.4]])
    expect(normalizeAudioBufferInPlace(buffer)).toBe(2)
    expect(getAudioBufferPeak(buffer)).toBe(1)
    expect(Array.from(buffer.getChannelData(1))).toEqual([0.20000000298023224, 0.800000011920929])
  })

  test('does not amplify silence, clipped audio, or non-finite samples', () => {
    const silence = createBuffer([[0, 0]])
    expect(normalizeAudioBufferInPlace(silence)).toBe(1)
    const clipped = createBuffer([[1.2, -0.5]])
    expect(normalizeAudioBufferInPlace(clipped)).toBe(1)
    const nonFinite = createBuffer([[Number.NaN, Number.POSITIVE_INFINITY]])
    expect(normalizeAudioBufferInPlace(nonFinite)).toBe(1)
    expect(Number.isNaN(nonFinite.getChannelData(0)[0])).toBe(true)
  })
})
