import { AUDIO_EFFECT_CONTRACTS, type CompressorParams, type EqParams } from '@daw-browser/shared'
import { createLiveWorkletBudget } from './effects/live-worklet-budget'
import { createLiveMixerRuntime } from './live-mixer-runtime'
import { createMasterFxRuntime } from './master-fx-runtime'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'

// Fake audio objects for the live and master effect-runtime tests. A worklet port records what was posted to it, so a
// test reads what the "node" holds instead of what the runtime believes it installed.

type PostedMessage = { type: string; params?: { thresholdDb: number } }
type ConnectionTarget = AudioNode | AudioParam
type FakeWorkletPort = {
  postMessage: (message: PostedMessage) => void
  close: () => void
  onmessage: ((event: MessageEvent) => void) | null
}

export const captureFxTransitions = () => {
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')
  const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>()
  const all: Array<() => void> = []
  const scheduler = {
    schedule: (callback: () => void) => {
      const handle = originalSet(() => {}, 60_000)
      pending.set(handle, callback)
      all.push(callback)
      return handle
    },
    clear: (handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle)
      originalClear(handle)
    },
  }
  const interceptGlobalTimers = process.env.DV01_CAPTURE_GLOBAL_TRANSITIONS === '1'
  if (interceptGlobalTimers) {
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: scheduler.schedule })
    Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, value: scheduler.clear })
  }
  return {
    pending,
    all,
    run: () => {
      const entry = pending.entries().next().value
      if (!entry) throw new Error('No captured reconnect.')
      pending.delete(entry[0])
      originalClear(entry[0])
      entry[1]()
    },
    restore: () => {
      for (const handle of pending.keys()) originalClear(handle)
      pending.clear()
      if (interceptGlobalTimers) {
        if (setDescriptor) Object.defineProperty(globalThis, 'setTimeout', setDescriptor)
        if (clearDescriptor) Object.defineProperty(globalThis, 'clearTimeout', clearDescriptor)
      }
    },
    scheduler,
  }
}

let gainRampCount = 0
let failNextConnection = false
let failRampValue: number | undefined
const createParam = (value = 0) => ({
  value,
  cancelScheduledValues: () => {},
  setValueAtTime: () => {},
  linearRampToValueAtTime: (target: number) => {
    gainRampCount += 1
    if (failRampValue === target) {
      failRampValue = undefined
      throw new Error(`Audio ramp to ${target} failed.`)
    }
  },
  setTargetAtTime: () => {},
})
const connections: Array<{ source: object; target: object }> = []
const createNode = () => {
  const node = Object.create(null)
  return Object.assign(node, {
    connect: (target: ConnectionTarget) => {
      if (failNextConnection) {
        failNextConnection = false
        throw new Error('Audio connection failed.')
      }
      connections.push({ source: node, target })
    },
    disconnect: (target?: ConnectionTarget) => {
      for (let index = connections.length - 1; index >= 0; index -= 1) {
        const connection = connections[index]
        if (connection?.source === node && (!target || connection.target === target)) connections.splice(index, 1)
      }
    },
  })
}
const createGain = () => Object.assign(createNode(), { gain: createParam(1) })
const createBiquad = () => Object.assign(createNode(), {
  type: 'peaking',
  frequency: createParam(),
  Q: createParam(),
  gain: createParam(),
})

const WORKLET_PARAMETER_IDS = [
  'gate.thresholdDb', 'gate.ratio',
  'reverb.wet', 'reverb.preDelayMs', 'reverb.lowCutHz', 'reverb.highCutHz', 'reverb.stereoWidth',
]

class FakeWorkletNode {
  readonly posted: PostedMessage[] = []
  closed = false
  closeCalls = 0
  readonly parameters = new Map(WORKLET_PARAMETER_IDS.map((id) => [id, createParam()]))
  readonly port: FakeWorkletPort = {
    postMessage: (message: PostedMessage) => {
      if (failNextParamsPost && message.type === 'params') {
        failNextParamsPost = false
        throw new Error('Worklet parameter post failed.')
      }
      this.posted.push(message)
    },
    close: () => {
      this.closeCalls += 1
      this.closed = true
    },
    onmessage: null,
  }
  onprocessorerror: (() => void) | null = null
  connect = (target: ConnectionTarget) => {
    if (failNextConnection) {
      failNextConnection = false
      throw new Error('Audio connection failed.')
    }
    connections.push({ source: this, target })
  }
  disconnect = (target?: ConnectionTarget) => {
    for (let index = connections.length - 1; index >= 0; index -= 1) {
      const connection = connections[index]
      if (connection?.source === this && (!target || connection.target === target)) connections.splice(index, 1)
    }
  }
  constructor() {
    if (failNextConstruction) {
      failNextConstruction = false
      throw new Error('Worklet node construction failed.')
    }
    created.push(this)
  }
}

const created: FakeWorkletNode[] = []
let failNextParamsPost = false
let failNextConstruction = false
let failNextCurveWrite = false

export const createFxTestAudio = () => {
  gainRampCount = 0
  created.length = 0
  connections.length = 0
  failNextParamsPost = false
  failNextConstruction = false
  failNextCurveWrite = false
  failNextConnection = false
  failRampValue = undefined
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: FakeWorkletNode })
  let failNextModuleLoad = false
  const biquads: ReturnType<typeof createBiquad>[] = []
  const delays: Array<{ delayTime: ReturnType<typeof createParam> }> = []
  const context = Object.assign(Object.create(null), {
    currentTime: 0,
    sampleRate: 48_000,
    destination: Object.assign(createNode(), { maxChannelCount: 2 }),
    audioWorklet: {
      addModule: async () => {
        if (!failNextModuleLoad) return
        failNextModuleLoad = false
        throw new Error('Worklet module failed to load.')
      },
    },
    createGain,
    createDelay: () => {
      const delay = Object.assign(createNode(), { delayTime: createParam() })
      delays.push(delay)
      return delay
    },
    createChannelSplitter: createNode,
    createChannelMerger: createNode,
    ['createWaveShaper']: () => {
      let curve: Float32Array | null = null
      return Object.defineProperty(createNode(), 'curve', {
        get: () => curve,
        set: (next: Float32Array | null) => {
          if (failNextCurveWrite) {
            failNextCurveWrite = false
            throw new Error('Wave shaper curve write failed.')
          }
          curve = next
        },
      })
    },
    createBiquadFilter: () => {
      const filter = createBiquad()
      biquads.push(filter)
      return filter
    },
  })
  return {
    context,
    masterInput: createGain(),
    connections: () => [...connections],
    gainRampCount: () => gainRampCount,
    workletNode: (index: number) => created[index],
    biquads,
    delays,
    failNextModuleLoad: () => { failNextModuleLoad = true },
    // The next parameter message to a worklet throws after the runtime decided to send it: a write that may not have landed.
    failNextParamsPost: () => { failNextParamsPost = true },
    failNextConstruction: () => { failNextConstruction = true },
    // The next saturator curve assignment throws after the drive gain already changed.
    failNextCurveWrite: () => { failNextCurveWrite = true },
    failNextConnection: () => { failNextConnection = true },
    failNextRampToValue: (value: number) => { failRampValue = value },
    failNextParameterWrite: (parameter: { value?: number } | undefined) => failNextWrite(parameter),
    // Worklet nodes (compressor or reverb) that were built and not yet released.
    liveWorkletCount: () => created.filter((node) => !node.closed).length,
    workletCloseCount: () => created.reduce((total, node) => total + node.closeCalls, 0),
    workletCloseCounts: () => created.map((node) => node.closeCalls),
    // The most recently built reverb worklet's parameter.
    reverbParameter: (id: string) => created.findLast((node) => node.parameters.has(id))?.parameters.get(id),
    workletParameter: (id: string) => created.findLast((node) => node.parameters.has(id))?.parameters.get(id),
    // The threshold the most recent compressor worklet was last told to use.
    compressorThreshold: (index = 0) => created[index]?.posted.findLast((message) => message.type === 'params')?.params?.thresholdDb,
    compressorNodeCount: () => created.length,
    postedCount: () => created.reduce((total, node) => total + node.posted.length, 0),
    faultCompressor: (index = 0) => created[index]?.onprocessorerror?.(),
    restore: () => {
      if (original) Object.defineProperty(globalThis, 'AudioWorkletNode', original)
      else Reflect.deleteProperty(globalThis, 'AudioWorkletNode')
    },
  }
}

export const createFxTransitionHarness = (
  owner: 'track' | 'master',
  onGraphLatencyChange: () => void = () => {},
) => {
  const timers = captureFxTransitions()
  const audio = createFxTestAudio()
  let hasContext = true
  const budget = createLiveWorkletBudget(8)
  const track = createLiveMixerRuntime({
    ensureAudio: () => {},
    getAudioContext: () => hasContext ? audio.context : null,
    getMasterInput: () => audio.masterInput,
    getDestination: () => null,
    reconnectTrackMeters: () => {},
    disposeTrackMeters: () => {},
    disposeSynthTrack: () => {},
    getMasterFx: () => ({}),
    getFaultGeneration: () => 0,
    workletBudget: budget,
    transitionScheduler: timers.scheduler,
    onGraphLatencyChange,
  })
  const master = createMasterFxRuntime({
    getFaultGeneration: () => 0,
    workletBudget: budget,
    transitionScheduler: timers.scheduler,
  })
  if (owner === 'track') track.updateTrackGains([{ id: 't', name: 't', volume: 1, clips: [] }])
  return {
    timers,
    audio,
    track,
    master,
    setContext: (value: boolean) => { hasContext = value },
    set: async (instances: AudioEffectRuntimeInstance[]) => owner === 'track'
      ? { disposition: await track.setTrackFxInstances('t', instances) }
      : master.setFxInstances(
        hasContext ? audio.context : null,
        hasContext ? audio.masterInput : null,
        audio.context.destination,
        instances,
      ),
    close: () => {
      track.clear()
      master.close()
      timers.restore()
      audio.restore()
    },
  }
}

// Counts the entries that walk the whole apply path: the equal-skip must happen before one.
export const createCountingBudget = (refuseCommit = false) => {
  const budget = createLiveWorkletBudget()
  let begins = 0
  return {
    budget: {
      ...budget,
      begin: (owner: string, count: number) => { begins += 1; return budget.begin(owner, count) },
      commit: (...args: Parameters<typeof budget.commit>) => !refuseCommit && budget.commit(...args),
    },
    begins: () => begins,
  }
}

export const compressorInstance = (thresholdDb: number, id = 'compressor-1', enabled = true): AudioEffectRuntimeInstance => {
  const params: CompressorParams = { ...AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams(), enabled, thresholdDb }
  return { id, kind: 'compressor', params }
}

export const reverbInstance = (enabled: boolean, wet: number, stereoWidth = 1, id = 'reverb-1'): AudioEffectRuntimeInstance => ({
  id,
  kind: 'reverb',
  params: { ...AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams(), enabled, wet, stereoWidth },
})

export const saturatorInstance = (driveDb: number, id = 'saturator-1'): AudioEffectRuntimeInstance => ({
  id,
  kind: 'saturator',
  params: { ...AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams(), enabled: true, driveDb },
})

export const delayInstance = (timeMs: number, feedback: number, id = 'delay-1'): AudioEffectRuntimeInstance => ({
  id,
  kind: 'delay',
  params: { ...AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams(), enabled: true, mode: 'time', timeMs, feedback },
})

export const syncedDelayInstance = (id = 'delay-1'): AudioEffectRuntimeInstance => ({
  id,
  kind: 'delay',
  params: { ...AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams(), enabled: true, mode: 'sync', syncDivision: '1/8' },
})

export const staticGateInstance = (thresholdDb: number, ratio: number, id = 'gate-1'): AudioEffectRuntimeInstance => {
  const defaults = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams()
  return {
    id,
    kind: 'gate',
    params: { ...defaults, state: { ...defaults.state, enabled: true, thresholdDb, ratio } },
  }
}

// The second default band is a peaking filter, so its gain is a parameter edit that keeps the node topology.
export const eqInstance = (gainDb: number, id = 'eq-1'): AudioEffectRuntimeInstance => {
  const defaults = AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams()
  const params: EqParams = { ...defaults, bands: defaults.bands.map((band, index) => index === 1 ? { ...band, gainDb } : band) }
  return { id, kind: 'eq', params }
}

export const heldEqGain = (audio: ReturnType<typeof createFxTestAudio>) => audio.biquads[1]?.gain.value

// The next assignment to the parameter's value throws.
const failNextWrite = (parameter: { value?: number } | undefined) => {
  if (!parameter) throw new Error('No parameter to fail.')
  let value = parameter.value
  let fail = true
  Object.defineProperty(parameter, 'value', {
    get: () => value,
    set: (next: number) => {
      if (fail) {
        fail = false
        throw new Error('Audio parameter write failed.')
      }
      value = next
    },
  })
}

// Effects whose parameter edit is several node writes. `arm` makes a later write of the edit throw after earlier ones
// landed; `read` is the node value an earlier write moves, `before` and `after` the values it holds for each instance.
export const partialWriteCases = (
  audio: ReturnType<typeof createFxTestAudio>,
  parameter: (parameterId: string, instanceId: string) => { value?: number } | undefined,
) => [
  {
    name: 'delay',
    before: delayInstance(100, 0.2),
    after: delayInstance(500, 0.8),
    arm: () => failNextWrite(parameter('delay.feedback', 'delay-1')),
    read: () => parameter('delay.timeMs', 'delay-1')?.value,
    heldBefore: 0.1,
    heldAfter: 0.5,
  },
  {
    name: 'saturator',
    before: saturatorInstance(0),
    after: saturatorInstance(6),
    arm: () => audio.failNextCurveWrite(),
    read: () => parameter('saturator.driveDb', 'saturator-1')?.value,
    heldBefore: 1,
    heldAfter: 10 ** (6 / 20),
  },
  {
    name: 'reverb',
    before: reverbInstance(true, 0.2),
    after: reverbInstance(true, 0.8, 0.5),
    arm: () => failNextWrite(audio.reverbParameter('reverb.stereoWidth')),
    read: () => audio.reverbParameter('reverb.wet')?.value,
    heldBefore: 0.2,
    heldAfter: 0.8,
  },
  {
    name: 'eq',
    before: eqInstance(0),
    after: eqInstance(6),
    arm: () => failNextWrite(audio.biquads[2]?.gain),
    read: () => heldEqGain(audio),
    heldBefore: 0,
    heldAfter: 6,
  },
]
