import { describe, expect, test } from 'bun:test'
import { applyLiveMixerGraph, clearLiveMixerEdges } from './apply-live-routing'
import { resolveMixerGraph } from './resolve-routing'
import { createMixerChannels } from './channels'

type TestAudioNode = Record<never, never>

const createParam = (value = 0) => ({
  value,
  events: Array<readonly [string, number, number]>(),
  cancelScheduledValues(time: number) { this.events.push(['cancel', 0, time]) },
  setValueAtTime(next: number, time: number) {
    this.value = next
    this.events.push(['set', next, time])
  },
  linearRampToValueAtTime(next: number, time: number) {
    this.value = next
    this.events.push(['ramp', next, time])
  },
})

const createNode = () => {
  const node = Object.create(null)
  node.connections = new Set()
  node.disconnectCount = 0
  node.connect = (target: TestAudioNode) => node.connections.add(target)
  node.disconnect = (target?: TestAudioNode) => {
    node.disconnectCount += 1

    if (target) node.connections.delete(target)
    else node.connections.clear()
  }

  return node
}

const createGain = () => Object.assign(createNode(), { gain: createParam(1) })
const createDelay = () => Object.assign(createNode(), { delayTime: createParam() })

type FakeRetirementSource = {
  onended: ((event: Event) => void) | null
  stopTime?: number
  start: (time: number) => void
  stop: (time?: number) => void
  disconnect: () => void
}

const createFakeAudioClock = () => {
  const sources: FakeRetirementSource[] = []

  return {
    createSource: () => {
      const source: FakeRetirementSource = {
        onended: null,
        stopTime: undefined,
        start: (_time: number) => {},
        stop: (time?: number) => { source.stopTime = time },
        disconnect: () => {},
      }

      sources.push(source)

      return source
    },
    advanceTo: (time: number) => {
      for (const source of sources) {
        if (source.stopTime === undefined || source.stopTime > time) continue
        source.stopTime = undefined
        source.onended?.(new Event('ended'))
      }
    },
    sources,
  }
}

const createRoutingFixture = () => {
  const graph = resolveMixerGraph({
    channels: createMixerChannels([
      { id: 'dry', name: 'Dry', clips: [], volume: 1, sends: [{ targetId: 'return', amount: 0.5 }] },
      { id: 'return', name: 'Return', channelRole: 'return', clips: [], volume: 1 },
    ]),
  })

  const withoutSend = resolveMixerGraph({
    channels: createMixerChannels([
      { id: 'dry', name: 'Dry', clips: [], volume: 1 },
      { id: 'return', name: 'Return', channelRole: 'return', clips: [], volume: 1 },
    ]),
  })

  const masterInput = createGain()

  const trackNodes = new Map([
    ['dry', { input: createGain(), postFx: createGain(), gain: createGain(), output: createGain() }],
    ['return', { input: createGain(), postFx: createGain(), gain: createGain(), output: createGain() }],
  ])

  const edgeRuntimes = new Map()
  const clock = createFakeAudioClock()

  const apply = (nextGraph = graph, currentTime = 2) => applyLiveMixerGraph({
    graph: nextGraph,
    masterInput,
    trackNodes,
    edgeRuntimes,
    createGain,
    createDelay,
    createRetirementSource: clock.createSource,
    currentTime,
    sampleRate: 48_000,
    reconnectTrackMeters: () => {},
  })

  return { apply, clock, edgeRuntimes, graph, withoutSend }
}

describe('live mixer edge runtime', () => {
  test('creates stable delay edges, ramps timing updates, and disposes removed sends after their fade', () => {
    const { apply, clock, edgeRuntimes, withoutSend } = createRoutingFixture()

    apply()
    expect(edgeRuntimes.size).toBe(3)
    const originalEdges = [...edgeRuntimes.values()]
    apply()
    expect([...edgeRuntimes.values()]).toEqual(originalEdges)
    expect(originalEdges.every((edge) => edge.delay.delayTime.events.some((event: readonly [string, number, number]) => event[0] === 'ramp' && event[2] === 2.01))).toBe(true)

    const sendEdge = originalEdges.find((edge) => edge.gain)
    apply(withoutSend)
    expect(edgeRuntimes.size).toBe(3)
    expect(sendEdge?.delay.disconnectCount).toBe(0)
    clock.advanceTo(2.01)
    expect(edgeRuntimes.size).toBe(2)
    expect(sendEdge?.delay.disconnectCount).toBeGreaterThan(0)
    expect(sendEdge?.gain?.disconnectCount).toBeGreaterThan(0)

    clearLiveMixerEdges(edgeRuntimes)
    expect(edgeRuntimes.size).toBe(0)
  })

  test('re-adding a send during its fade cancels its scheduled disconnection', () => {
    const { apply, clock, edgeRuntimes, graph, withoutSend } = createRoutingFixture()
    apply()
    const sendEdgeId = JSON.stringify(['dry', 'return', 'send', 'post-fader'])
    const sendEdge = edgeRuntimes.get(sendEdgeId)

    apply(withoutSend)
    apply(graph)
    expect(clock.sources).toHaveLength(1)
    expect(clock.sources[0]?.onended).toBeNull()
    clock.advanceTo(2.01)

    expect(edgeRuntimes.get(sendEdgeId)).toBe(sendEdge)
    expect(sendEdge?.gain?.disconnectCount).toBe(0)
    expect(sendEdge?.delay.disconnectCount).toBe(0)
  })

  test('disposing edges cancels pending retirement callbacks', () => {
    const { apply, clock, edgeRuntimes, withoutSend } = createRoutingFixture()
    apply()
    apply(withoutSend)
    const sendEdge = [...edgeRuntimes.values()].find((edge) => edge.gain)
    expect(clock.sources).toHaveLength(1)

    clearLiveMixerEdges(edgeRuntimes)
    expect(clock.sources[0]?.onended).toBeNull()
    const gainDisconnects = sendEdge?.gain?.disconnectCount
    const delayDisconnects = sendEdge?.delay.disconnectCount
    clock.advanceTo(2.01)

    expect(edgeRuntimes.size).toBe(0)
    expect(sendEdge?.gain?.disconnectCount).toBe(gainDisconnects)
    expect(sendEdge?.delay.disconnectCount).toBe(delayDisconnects)
  })

  test('connects sends from the exact named tap nodes', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([
        {
          id: 'dry',
          name: 'Dry',
          clips: [],
          volume: 0.25,
          sends: [
            { targetId: 'pre-fx', amount: 1, tap: 'pre-fx' },
            { targetId: 'pre-fader', amount: 1, tap: 'pre-fader' },
            { targetId: 'post-fader', amount: 1, tap: 'post-fader' },
          ],
        },
        { id: 'pre-fx', name: 'Pre FX', channelRole: 'return', clips: [], volume: 1 },
        { id: 'pre-fader', name: 'Pre Fader', channelRole: 'return', clips: [], volume: 1 },
        { id: 'post-fader', name: 'Post Fader', channelRole: 'return', clips: [], volume: 1 },
      ]),
    })

    const dry = { input: createGain(), postFx: createGain(), gain: createGain(), output: createGain() }

    const trackNodes = new Map([
      ['dry', dry],
      ['pre-fx', { input: createGain(), postFx: createGain(), gain: createGain(), output: createGain() }],
      ['pre-fader', { input: createGain(), postFx: createGain(), gain: createGain(), output: createGain() }],
      ['post-fader', { input: createGain(), postFx: createGain(), gain: createGain(), output: createGain() }],
    ])

    const edgeRuntimes = new Map()
    applyLiveMixerGraph({
      graph,
      masterInput: createGain(),
      trackNodes,
      edgeRuntimes,
      createGain,
      createDelay,
      createRetirementSource: createFakeAudioClock().createSource,
      currentTime: 0,
      sampleRate: 48_000,
      reconnectTrackMeters: () => {},
    })

    expect(edgeRuntimes.get(JSON.stringify(['dry', 'pre-fx', 'send', 'pre-fx']))?.source).toBe(dry.input)
    expect(edgeRuntimes.get(JSON.stringify(['dry', 'pre-fader', 'send', 'pre-fader']))?.source).toBe(dry.postFx)
    expect(edgeRuntimes.get(JSON.stringify(['dry', 'post-fader', 'send', 'post-fader']))?.source).toBe(dry.output)
  })
})
