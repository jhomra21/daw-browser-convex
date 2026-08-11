import { expect, test } from 'bun:test'
import { parsePortableWasmControlMessage, portableWasmMaxGraphNodes, portableWasmMaxInstrumentEvents, portableWasmMaxPendingEvents, portableWasmProtocolVersion, readPortableWasmGraphContinuityMessage, readPortableWasmRecordingStatusMessage, readPortableWasmTransportPositionMessage } from './portable-wasm-protocol'
import { audioCoreContractVersion, audioCoreMaxProcessorParameterTargets, encodeAudioCoreProcessorStateEnvelope, encodeEqProcessorState, encodeSaturatorProcessorState, encodeUtilityProcessorState, type UtilityProcessorState } from '../../audio-core-contract/src/index'

const utilityState: UtilityProcessorState = {
  enabled: true,
  gainDb: 0,
  polarity: 'normal',
  inputMode: 'stereo',
  pan: 0,
  balance: 0,
  width: 1,
  matrix: 'stereo',
  swap: false,
  dcBlock: true,
}

test('keeps the validated Wasm module outside portable control messages', () => {
  const parsed = parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'initialize',
    abiVersion: 1,
    contractHash: 'test',
    maxFramesPerBlock: 128,
    wasmBytes: new ArrayBuffer(0),
  })
  expect(parsed).toEqual({
    version: portableWasmProtocolVersion,
    type: 'initialize',
    abiVersion: 1,
    contractHash: 'test',
    maxFramesPerBlock: 128,
  })
})

test('accepts only monotonic-shaped portable transport positions', () => {
  expect(readPortableWasmTransportPositionMessage({
    version: portableWasmProtocolVersion,
    type: 'transport-position',
    sessionId: 2,
    epoch: 4,
    sequence: 8,
    running: true,
    frame: 128,
  })).toEqual({
    version: portableWasmProtocolVersion,
    type: 'transport-position',
    sessionId: 2,
    epoch: 4,
    sequence: 8,
    running: true,
    frame: 128,
  })
  expect(readPortableWasmTransportPositionMessage({
    version: portableWasmProtocolVersion,
    type: 'transport-position',
    sessionId: 2,
    epoch: 4,
    sequence: 0,
    running: true,
    frame: 128,
  })).toBeNull()
})

test('preserves portable capacity continuity results', () => {
  expect(readPortableWasmGraphContinuityMessage({
    version: portableWasmProtocolVersion,
    type: 'graph-continuity',
    revision: 9,
    result: 'capacity',
  })).toEqual({
    version: portableWasmProtocolVersion,
    type: 'graph-continuity',
    revision: 9,
    result: 'capacity',
  })
})

test('validates bounded portable recording capture controls', () => {
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'recording-capture-configure',
    generation: 3,
    sessionId: 8,
    channelCount: 2,
    inputChannels: [0, 1],
    gain: 1,
    polarity: -1,
    monitoring: true,
    punchStartFrame: 32,
    punchEndFrame: 64,
  })).toMatchObject({ type: 'recording-capture-configure', sessionId: 8 })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'recording-capture-configure',
    generation: 3,
    sessionId: 8,
    channelCount: 1,
    inputChannels: [64],
    gain: 1,
    polarity: 1,
    monitoring: false,
    punchStartFrame: 32,
    punchEndFrame: null,
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'recording-capture-finalize',
    stopFrame: 64,
  })).toMatchObject({ type: 'recording-capture-finalize', stopFrame: 64 })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'recording-capture-finalize',
    stopFrame: null,
  })).toMatchObject({ type: 'recording-capture-finalize', stopFrame: null })
  expect(readPortableWasmRecordingStatusMessage({
    version: portableWasmProtocolVersion,
    type: 'recording-capture-applied',
    generation: 3,
    sessionId: 8,
    action: 'configured',
    frame: 48,
  })).toMatchObject({ action: 'configured', frame: 48 })
})

test('accepts only versioned schedules with explicit ramp endpoints and restore values', () => {
  const schedule = {
    revision: 2,
    transportEpoch: 3,
    sampleRateHz: 48_000,
    bpm: 120,
    timeOrigin: { timelineSec: 0, frame: 0 },
    events: [{
      frame: 16,
      sequence: 1,
      type: 'parameter-ramp',
      target: { kind: 'parameter', scope: 'track', trackId: 'track', parameterId: 'mixer.gain' },
      startFrame: 16,
      endFrame: 32,
      startValue: 0,
      endValue: 1,
      interpolation: 'linear',
    }, {
      frame: 32,
      sequence: 2,
      type: 'parameter-restore',
      target: { kind: 'parameter', scope: 'track', trackId: 'track', parameterId: 'mixer.gain' },
      value: 0.5,
    }],
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'install-schedule',
    requestId: 1,
    schedule,
  })).toMatchObject({ type: 'install-schedule', requestId: 1 })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'install-schedule',
    requestId: 1,
    schedule: { ...schedule, events: [{ ...schedule.events[0], endFrame: 16 }] },
  })).toBeNull()
})

test('accepts only versioned bounded portable worklet control messages', () => {
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'utility-state',
    revision: 1,
    state: utilityState,
  })).toMatchObject({ type: 'utility-state', revision: 1 })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'publish-graph',
    requestId: 1,
    revision: 0,
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion + 1,
    type: 'diagnostics',
  })).toBeNull()
  expect(portableWasmMaxPendingEvents).toBe(256)
})

test('accepts exact planar PCM only for versioned portable asset registration', () => {
  const asset = {
    version: portableWasmProtocolVersion,
    assetId: 'asset:one',
    frameCount: 2,
    sampleRateHz: 48_000,
    channelCount: 2,
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'register-asset',
    requestId: 1,
    generation: 1,
    asset,
    planes: [new Float32Array(2), new Float32Array(2)],
  })).toMatchObject({ type: 'register-asset', asset })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'register-asset',
    requestId: 1,
    generation: 1,
    asset,
    planes: [new Float32Array(1), new Float32Array(1)],
  })).toBeNull()
})

test('requires ordered source-targeted schedules in one transport epoch', () => {
  const event = {
    version: audioCoreContractVersion,
    epoch: 2,
    sequence: 1,
    sourceNodeId: 'track-1',
    assetId: 'asset:one',
    startFrame: 0,
    stopFrame: 128,
    sourceOffsetFrame: 0,
    sourceFrameCount: 128,
    gain: 1,
    fadeInStartFrame: 0,
    fadeInEndFrame: 0,
    fadeOutStartFrame: 128,
    fadeOutEndFrame: 128,
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'schedule-sources',
    requestId: 1,
    revision: 1,
    epoch: 2,
    events: [event],
  })).toMatchObject({ type: 'schedule-sources', events: [event] })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'schedule-sources', requestId: 1, revision: 1, epoch: 2,
    events: [{ ...event, fadeInCurve: 1.1 }],
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'schedule-sources', requestId: 1, revision: 1, epoch: 2,
    events: [{ ...event, fadeInCurvePosition: -0.1 }],
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'schedule-sources', requestId: 1, revision: 1, epoch: 2,
    events: [{ ...event, fadeOutCurve: -1.1 }],
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'schedule-sources', requestId: 1, revision: 1, epoch: 2,
    events: [{ ...event, fadeOutCurvePosition: 1.1 }],
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'schedule-sources',
    requestId: 1,
    revision: 1,
    epoch: 2,
    events: [{
      ...event,
      fadeInCurve: 1,
      fadeInCurvePosition: 0,
      fadeOutCurve: -1,
      fadeOutCurvePosition: 1,
    }],
  })).not.toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'schedule-sources',
    requestId: 1,
    revision: 1,
    epoch: 2,
    events: [{ ...event, sourceNodeId: '' }],
  })).toBeNull()
})

test('accepts bounded scalar and a-rate parameter blocks with frame-ordered processor events', () => {
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'parameter-blocks',
    revision: 1,
    blocks: [{
      processorInstanceId: 3,
      frameCount: 1,
      parameterTargets: [1],
      values: Float32Array.of(-6),
    }],
  })).toMatchObject({ type: 'parameter-blocks' })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'processor-events',
    requestId: 4,
    revision: 1,
    epoch: 4,
    sequence: 8,
    events: [
      { processorInstanceId: 3, parameterTarget: 1, frameOffset: 0, value: -6 },
      { processorInstanceId: 3, parameterTarget: 1, frameOffset: 1, value: 0 },
    ],
  })).toMatchObject({ type: 'processor-events', requestId: 4 })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'reenable-processor-automation',
    requestId: 5,
    revision: 1,
    epoch: 4,
    processorInstanceId: 3,
    parameterTargets: [1],
  })).toMatchObject({ type: 'reenable-processor-automation', requestId: 5 })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'processor-events',
    requestId: 4,
    revision: 1,
    epoch: 4,
    sequence: 9,
    events: [{ processorInstanceId: 3, parameterTarget: 1, frameOffset: 0, value: -3 }],
  })).toMatchObject({ type: 'processor-events', epoch: 4, sequence: 9 })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'processor-events',
    revision: 1,
    epoch: 4,
    sequence: 9,
    events: [{ processorInstanceId: 3, parameterTarget: 1, frameOffset: 0, value: -3 }],
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'processor-events',
    requestId: 4,
    revision: 1,
    epoch: 0,
    sequence: 9,
    events: [{ processorInstanceId: 3, parameterTarget: 1, frameOffset: 0, value: -3 }],
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'processor-events',
    revision: 1,
    epoch: 0,
    sequence: 9,
    events: [{ processorInstanceId: 3, parameterTarget: 1, frameOffset: 0, value: -3 }],
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'parameter-blocks',
    revision: 1,
    blocks: [{
      processorInstanceId: 3,
      frameCount: 2,
      parameterTargets: [1],
      values: Float32Array.of(-6, 0),
    }],
  })).toMatchObject({ type: 'parameter-blocks' })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'parameter-blocks',
    revision: 1,
    blocks: [{
      processorInstanceId: 3,
      frameCount: 2,
      parameterTargets: [1],
      values: Float32Array.of(-6),
    }],
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'parameter-blocks',
    revision: 1,
    blocks: [{
      processorInstanceId: 3,
      frameCount: 8193,
      parameterTargets: [1],
      values: new Float32Array(8193),
    }],
  })).toBeNull()
})

test('accepts bounded versioned processor chains and rejects duplicate instances', () => {
  const snapshot = {
    version: audioCoreContractVersion,
    revision: 2,
    contractHash: 'graph-contract',
    masterNodeId: 'master',
    edges: [],
    assets: [],
    nodes: [{
      id: 'master',
      kind: 'master',
      inputLayout: 'stereo',
      outputLayout: 'stereo',
      latencyFrames: 0,
      processorOrder: [{
        id: 'utility-1',
        kind: 'utility',
        kindId: 1,
        instanceId: 1,
        stateVersion: audioCoreContractVersion,
        state: encodeUtilityProcessorState(utilityState),
        parameterTargets: [{ id: 'utility.gainDb', target: 1 }],
        latencyFrames: 0,
        tailFrames: 0,
        bypassed: false,
      }],
    }],
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot,
  })).toMatchObject({ type: 'prepare-graph' })
  const maximumTargetSnapshot = {
    ...snapshot,
    nodes: [{
      ...snapshot.nodes[0],
      processorOrder: [{
        ...snapshot.nodes[0].processorOrder[0],
        parameterTargets: Array.from(
          { length: audioCoreMaxProcessorParameterTargets },
          () => ({ id: 'utility.gainDb', target: 1 }),
        ),
      }],
    }],
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: maximumTargetSnapshot,
  })).toMatchObject({ type: 'prepare-graph' })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: {
      ...maximumTargetSnapshot,
      nodes: [{
        ...maximumTargetSnapshot.nodes[0],
        processorOrder: [{
          ...maximumTargetSnapshot.nodes[0].processorOrder[0],
          parameterTargets: [
            ...maximumTargetSnapshot.nodes[0].processorOrder[0].parameterTargets,
            { id: 'utility.gainDb', target: 1 },
          ],
        }],
      }],
    },
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: { ...snapshot, nodes: [{ ...snapshot.nodes[0], processorOrder: [...snapshot.nodes[0].processorOrder, { ...snapshot.nodes[0].processorOrder[0] }] }] },
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: {
      ...snapshot,
      nodes: Array.from({ length: portableWasmMaxGraphNodes + 1 }, (_, index) => ({
        ...snapshot.nodes[0],
        id: `master-${index}`,
        processorOrder: [],
      })),
      masterNodeId: 'master-0',
    },
  })).toBeNull()
  const saturatorState = encodeSaturatorProcessorState({
    enabled: true, driveDb: 6, curve: 'soft', color: false,
    colorFrequencyHz: 1200, colorAmount: 0, outputDb: 0, dryWet: 1,
  })
  const saturatorSnapshot = {
    ...snapshot,
    nodes: [{
      ...snapshot.nodes[0],
      processorOrder: [{
        id: 'saturator-1',
        kind: 'saturator',
        kindId: 2,
        instanceId: 2,
        stateVersion: 1,
        state: saturatorState,
        parameterTargets: [],
        latencyFrames: 0,
        tailFrames: 0,
        bypassed: false,
      }],
    }],
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: saturatorSnapshot,
  })).toMatchObject({ type: 'prepare-graph' })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: {
      ...saturatorSnapshot,
      nodes: [{ ...saturatorSnapshot.nodes[0], processorOrder: [{ ...saturatorSnapshot.nodes[0].processorOrder[0], kindId: 999 }] }],
    },
  })).toBeNull()
})

test('requires sidechain edges to target a processor in their destination chain', () => {
  const processor = {
    id: 'compressor-1',
    kind: 'saturator',
    kindId: 2,
    instanceId: 2,
    stateVersion: audioCoreContractVersion,
    state: encodeSaturatorProcessorState({
      enabled: true, driveDb: 6, curve: 'soft', color: false,
      colorFrequencyHz: 1200, colorAmount: 0, outputDb: 0, dryWet: 1,
    }),
    parameterTargets: [],
    latencyFrames: 0,
    tailFrames: 0,
    bypassed: false,
  }
  const snapshot = {
    version: audioCoreContractVersion,
    revision: 1,
    contractHash: 'graph-contract',
    masterNodeId: 'target',
    assets: [],
    nodes: [
      { id: 'source', kind: 'source', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [] },
      { id: 'target', kind: 'master', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [processor] },
    ],
    edges: [{
      version: audioCoreContractVersion,
      id: 'sidechain',
      fromNodeId: 'source',
      toNodeId: 'target',
      targetProcessorId: 'compressor-1',
      gain: 1,
      kind: 'send',
      tap: 'post-fader',
      sidechain: true,
      pdcDelayFrames: 0,
    }],
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot,
  })).toMatchObject({ type: 'prepare-graph' })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: { ...snapshot, edges: [{ ...snapshot.edges[0], targetProcessorId: 'missing' }] },
  })).toBeNull()
})

test('transports registered Saturator and EQ envelopes without utility parsing', () => {
  const envelope = encodeAudioCoreProcessorStateEnvelope({
    kindId: 2,
    schemaVersion: 1,
    state: encodeSaturatorProcessorState({
      enabled: true, driveDb: 6, curve: 'soft', color: false,
      colorFrequencyHz: 1200, colorAmount: 0, outputDb: 0, dryWet: 1,
    }),
    instanceId: 9,
    bypassed: false,
    inputLayout: 'stereo',
    outputLayout: 'stereo',
    latencyFrames: 0,
    tailFrames: 0,
    parameterTargets: [],
  })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'processor-state',
    revision: 1,
    envelope,
  })).toMatchObject({ type: 'processor-state', revision: 1 })
  const eqEnvelope = encodeAudioCoreProcessorStateEnvelope({
    kindId: 3,
    schemaVersion: 1,
    state: encodeEqProcessorState({
      enabled: true,
      channelMode: 'stereo',
      bands: Array.from({ length: 8 }, () => ({ enabled: true, type: 'peaking', frequency: 1000, gainDb: 0, q: 1 })),
    }),
    instanceId: 10,
    bypassed: false,
    inputLayout: 'stereo',
    outputLayout: 'stereo',
    latencyFrames: 0,
    tailFrames: 0,
    parameterTargets: [],
  })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'processor-state',
    revision: 1,
    envelope: eqEnvelope,
  })).toMatchObject({ type: 'processor-state', revision: 1 })
  envelope[8] = 65
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'processor-state',
    revision: 1,
    envelope,
  })).toBeNull()
})

test('accepts bounded epoch-scoped synth state and ordered MIDI events', () => {
  const state = {
    version: audioCoreContractVersion,
    kind: 'synth',
    voiceCapacity: 2,
    outputLayout: 'stereo',
    parameterTargets: [{ id: 'synth.outputGain', target: 1 }],
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'instrument-state', revision: 1, nodeId: 'synth-1', state,
  })).toMatchObject({ type: 'instrument-state', nodeId: 'synth-1' })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'transport', requestId: 1, epoch: 2, running: true, frame: 0,
  })).toMatchObject({ type: 'transport', epoch: 2 })
  const events = [
    { nodeId: 'synth-1', noteId: 2, sequence: 1, frameOffset: 3, type: 'note-on', channel: 0, note: 60, value: 1 },
    { nodeId: 'synth-1', noteId: 2, sequence: 2, frameOffset: 3, type: 'note-off', channel: 0, note: 60, value: 0 },
  ] as const
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'instrument-events', epoch: 2, events,
  })).toMatchObject({ type: 'instrument-events', events })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'instrument-events', epoch: 2, events: [...events].reverse(),
  })).toBeNull()
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion,
    type: 'instrument-events',
    epoch: 2,
    events: [{ nodeId: 'synth-1', noteId: 3, sequence: 3, frameOffset: 0, type: 'sustain', channel: 0, note: 0, value: Number.NaN }],
  })).toBeNull()
  expect(portableWasmMaxInstrumentEvents).toBe(256)
})

test('accepts bounded sampler and drum-rack state DTOs before the worklet', () => {
  const sampler = {
    version: 1,
    kind: 'sampler' as const,
    voiceCapacity: 1,
    outputLayout: 'stereo' as const,
    ampAttackMs: 0,
    ampDecayMs: 0,
    ampSustain: 1,
    ampReleaseMs: 1,
    filterEnabled: false,
    filterMode: 'lowpass' as const,
    filterCutoffHz: 20_000,
    filterResonance: 0.707,
    filterEnvelopeAmount: 0,
    filterAttackMs: 0,
    filterDecayMs: 0,
    filterSustain: 0,
    filterReleaseMs: 0,
    lfoEnabled: false,
    lfoRateHz: 5,
    lfoPitchCents: 0,
    lfoFilterHz: 0,
    lfoAmplitude: 0,
    lfoPan: 0,
    retrigger: true,
    zones: [{
      assetId: 'asset:1', keyLow: 36, keyHigh: 60, velocityLow: 1, velocityHigh: 127, rootNote: 48,
      tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 1, roundRobinIndex: 0, playbackMode: 'one-shot' as const,
      startFrame: 0, endFrame: 32, loopStartFrame: 0, loopEndFrame: 0, crossfadeFrameCount: 0, chokeGroup: 0,
    }],
  }
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'instrument-state', revision: 1, nodeId: 'sampler-1', state: sampler,
  })).toMatchObject({ type: 'instrument-state', nodeId: 'sampler-1' })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'instrument-state', revision: 1, nodeId: 'drum-1',
    state: { ...sampler, kind: 'drum-rack', zones: [{ ...sampler.zones[0], keyHigh: 36, roundRobinGroup: 0 }] },
  })).toMatchObject({ type: 'instrument-state', nodeId: 'drum-1' })
  expect(parsePortableWasmControlMessage({
    version: portableWasmProtocolVersion, type: 'instrument-state', revision: 1, nodeId: 'drum-1',
    state: { ...sampler, kind: 'drum-rack' },
  })).toBeNull()
})
