import { describe, expect, test } from 'bun:test'
import { createCueBus } from './cue-routing'

type TestAudioNode = Record<never, never>

const createNode = () => {
  const node = Object.create(null)
  node.connections = []
  node.connect = (target: TestAudioNode) => node.connections.push(target)
  return node
}

describe('cue routing', () => {
  test('connects only to an explicitly owned destination and rejects the main destination', () => {
    const main = createNode()
    const cue = createNode()
    const bus = createNode()
    const context = { destination: main, createGain: () => bus }

    expect(createCueBus(context, cue)).toBe(bus)
    expect(bus.connections).toEqual([cue])
    expect(bus.connections).not.toContain(main)
    expect(() => createCueBus(context, main)).toThrow('Cue destination must be distinct from the main audio destination.')
    expect(bus.connections).toEqual([cue])
  })
})
