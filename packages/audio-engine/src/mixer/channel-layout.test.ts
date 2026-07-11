import { describe, expect, test } from 'bun:test'
import {
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultEqParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
} from '@daw-browser/shared'
import { convertStereoToMonoSample, duplicateMonoSample, getSourceChannelLayout } from './channel-layout'
import { resolveMixerGraph } from './resolve-routing'
import type { MixerChannel } from './channels'
import type { MixerTrackFx } from './types'

const channel = (id: string, role: MixerChannel['role'] = 'track'): MixerChannel => ({
  id,
  name: id,
  role,
  volume: 1,
  muted: false,
  soloed: false,
  sends: [],
})

describe('runtime channel layouts', () => {
  test('preserves mono sources and treats mixed mono/stereo clips as stereo', () => {
    const graph = resolveMixerGraph({
      channels: [channel('mono'), channel('mixed')],
      sourceChannelCounts: { mono: [1, 1], mixed: [1, 2] },
    })
    expect(graph.channels[0]?.sourceLayout).toBe('mono')
    expect(graph.channels[0]?.inputLayout).toBe('mono')
    expect(graph.channels[0]?.outputLayout).toBe('mono')
    expect(graph.channels[1]?.sourceLayout).toBe('stereo')
    expect(graph.channels[1]?.inputLayout).toBe('stereo')
  })

  test('keeps gain, EQ, compressor, and saturator mono until an effect explicitly expands', () => {
    const baseFx: MixerTrackFx = {
      instances: [
        { id: 'eq', kind: 'eq', params: createDefaultEqParams() },
        { id: 'compressor', kind: 'compressor', params: createDefaultCompressorParams() },
        { id: 'saturator', kind: 'saturator', params: createDefaultSaturatorParams() },
      ],
    }
    const mono = resolveMixerGraph({
      channels: [channel('mono')],
      sourceChannelCounts: { mono: [1] },
      trackFx: { mono: baseFx },
    })
    expect(mono.channels[0]?.outputLayout).toBe('mono')

    const delay = resolveMixerGraph({
      channels: [channel('delay')],
      sourceChannelCounts: { delay: [1] },
      trackFx: {
        delay: {
          instances: [
            ...(baseFx.instances ?? []),
            { id: 'delay', kind: 'delay', params: { ...createDefaultDelayParams(), enabled: true, pingPong: true } },
          ],
        },
      },
    })
    expect(delay.channels[0]?.inputLayout).toBe('mono')
    expect(delay.channels[0]?.outputLayout).toBe('stereo')

    const reverb = resolveMixerGraph({
      channels: [channel('reverb')],
      sourceChannelCounts: { reverb: [1] },
      trackFx: {
        reverb: {
          instances: [
            { id: 'reverb', kind: 'reverb', params: { ...createDefaultReverbParams(), enabled: true, stereoWidth: 0.5 } },
          ],
        },
      },
    })
    expect(reverb.channels[0]?.outputLayout).toBe('stereo')
  })

  test('propagates stereo expansion through sends, groups, returns, and master', () => {
    const source = channel('source')
    source.outputTargetId = 'group'
    source.sends = [{ targetId: 'return', amount: 1 }]
    const graph = resolveMixerGraph({
      channels: [source, channel('group', 'group'), channel('return', 'return')],
      sourceChannelCounts: { source: [1] },
      trackFx: {
        source: { instances: [{ id: 'delay', kind: 'delay', params: { ...createDefaultDelayParams(), enabled: true, pingPong: true } }] },
      },
    })
    expect(graph.channels.map((entry) => entry.outputLayout)).toEqual(['stereo', 'stereo', 'stereo'])
    expect(graph.master.inputLayout).toBe('stereo')
    expect(graph.master.outputLayout).toBe('stereo')
  })

  test('merges nested groups, sends, and returns into master exactly once', () => {
    const mono = channel('mono')
    mono.outputTargetId = 'inner'
    mono.sends = [{ targetId: 'return', amount: 1 }]
    const stereo = channel('stereo')
    stereo.outputTargetId = 'inner'
    const inner = channel('inner', 'group')
    inner.outputTargetId = 'outer'
    const graph = resolveMixerGraph({
      channels: [mono, stereo, inner, channel('outer', 'group'), channel('return', 'return')],
      sourceChannelCounts: { mono: [1], stereo: [2] },
    })

    expect(graph.channels.map((entry) => [entry.channel.id, entry.inputLayout, entry.outputLayout])).toEqual([
      ['mono', 'mono', 'mono'],
      ['stereo', 'stereo', 'stereo'],
      ['inner', 'stereo', 'stereo'],
      ['outer', 'stereo', 'stereo'],
      ['return', 'mono', 'mono'],
    ])
    expect(graph.master.inputLayout).toBe('stereo')
  })

  test('handles routing cycles consistently with routing normalization', () => {
    const first = channel('first')
    const second = channel('second')
    first.outputTargetId = 'second'
    second.outputTargetId = 'first'
    const graph = resolveMixerGraph({ channels: [first, second] })
    expect(graph.channels.map((entry) => entry.outputTargetId)).toEqual([undefined, undefined])
  })

  test('duplicates mono without attenuation and downmixes with equal weights', () => {
    expect(duplicateMonoSample(0.75)).toEqual([0.75, 0.75])
    expect(convertStereoToMonoSample(1, -1)).toBe(0)
    expect(convertStereoToMonoSample(1, 1)).toBe(1)
  })

  test('leaves unsupported source channel counts unresolved', () => {
    expect(getSourceChannelLayout([0])).toBeUndefined()
    expect(getSourceChannelLayout([6])).toBeUndefined()
  })
})
