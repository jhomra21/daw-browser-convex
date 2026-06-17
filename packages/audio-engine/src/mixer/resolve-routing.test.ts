import { describe, expect, test } from 'bun:test'
import { resolveMixerGraph } from './resolve-routing'

describe('resolveMixerGraph', () => {
  test('carries canonical master volume into the resolved graph', () => {
    const graph = resolveMixerGraph({
      masterVolume: 0.42,
      channels: [],
    })

    expect(graph.master.volume).toBe(0.42)
  })
})
