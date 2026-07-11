import { describe, expect, test } from 'bun:test'
import { createMixerRoutingPlan } from './graph-contract'
import { resolveMixerGraph } from './resolve-routing'
import { createMixerChannels } from './channels'

describe('mixer routing plan', () => {
  test('preserves resolved channel order, gains, targets, sends, and master volume', () => {
    const graph = resolveMixerGraph({
      masterVolume: 0.8,
      channels: createMixerChannels([
        { id: 'audio', kind: 'audio', name: 'Audio', clips: [], volume: 0.5, muted: false, soloed: false, outputTargetId: 'group', sends: [{ targetId: 'return', amount: 0.25 }] },
        { id: 'group', channelRole: 'group', name: 'Group', clips: [], volume: 0.75, muted: false, soloed: false },
        { id: 'return', channelRole: 'return', name: 'Return', clips: [], volume: 1, muted: false, soloed: false },
      ]),
    })

    expect(createMixerRoutingPlan(graph)).toEqual({
      channels: [
        {
          channelId: 'audio',
          gain: 0.5,
          outputGain: 1,
          outputTargetId: 'group',
          sends: [{ targetId: 'return', amount: 0.25 }],
        },
        { channelId: 'group', gain: 0.75, outputGain: 1, outputTargetId: undefined, sends: [] },
        { channelId: 'return', gain: 1, outputGain: 1, outputTargetId: undefined, sends: [] },
      ],
      masterVolume: 0.8,
    })
  })
})
