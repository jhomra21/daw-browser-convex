import { describe, expect, test } from 'bun:test'
import { createSourceAutomationScope } from './export-mixdown'
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
