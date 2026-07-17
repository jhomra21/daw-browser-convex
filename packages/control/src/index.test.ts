import { expect, test } from 'bun:test'

import {
  canonicalJson,
  controlCapabilitiesV1,
  controlCommitRequestSchemaV1,
  controlLimitsV1,
  parseControlCommitRequestV1,
  projectSnapshotSchemaV1,
} from './index'

const commit = (actions: unknown[]) => ({
  version: 'v1',
  expectedRevision: 0,
  idempotencyKey: 'request-1',
  actions,
})

test('parses a curated atomic commit request', () => {
  const request = parseControlCommitRequestV1(commit([{
    kind: 'track.create',
    projectId: 'project-1',
    client: { clientId: 'new-track' },
    name: 'Bass',
    trackKind: 'instrument',
  }]))
  expect(request.actions).toHaveLength(1)
})

test('rejects unknown versions, actions, and malformed actions', () => {
  expect(() => parseControlCommitRequestV1({
    ...commit([]),
    version: 'v2',
  })).toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'timeline.patch',
    projectId: 'project-1',
  }]))).toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'clip.midi.create',
    trackId: 'track-1',
    startSec: 0,
    duration: 1,
    wave: 'sine',
    notes: [{ beat: 0, length: 1, pitch: 128 }],
  }]))).toThrow()
})

test('canonical JSON is key-order deterministic', () => {
  expect(canonicalJson({ b: [true, { z: 1, a: 'value' }], a: null }))
    .toBe(canonicalJson({ a: null, b: [true, { a: 'value', z: 1 }] }))
})

test('canonical JSON rejects unsupported values and sparse arrays', () => {
  const sparse = Array<string>(2)
  sparse[1] = 'value'
  expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow()
  expect(() => canonicalJson(new Date())).toThrow()
  expect(() => canonicalJson(new Map())).toThrow()
  expect(() => canonicalJson(sparse)).toThrow()
})

test('enforces aggregate MIDI point limits', () => {
  const midiNotes = Array.from({ length: controlLimitsV1.maxMidiNotesPerCommit }, (_, index) => ({
    beat: index / 4,
    length: 0.25,
    pitch: 48 + index % 36,
    velocity: 0.8,
  }))
  const midiAction = {
    kind: 'clip.midi.create',
    trackId: 'track-1',
    startSec: 0,
    duration: 128,
    wave: 'sine',
    notes: midiNotes,
  }
  const midiCommit = commit([midiAction])
  expect(() => parseControlCommitRequestV1(midiCommit)).not.toThrow()
  expect(() => parseControlCommitRequestV1(commit([
    { ...midiAction, notes: midiNotes.slice(0, 250) },
    { ...midiAction, notes: midiNotes.slice(250) },
  ]))).not.toThrow()
  const fixtureBytes = new TextEncoder().encode(canonicalJson(midiCommit)).byteLength
  expect(fixtureBytes).toBeLessThan(controlLimitsV1.maxSerializedBodyBytes)
})

test('excludes deferred effects, automation, and sidechain actions', () => {
  expect(controlCapabilitiesV1.actionKinds).not.toContain('effect.add')
  expect(controlCapabilitiesV1.actionKinds).not.toContain('instrument.add')
  expect(controlCapabilitiesV1.actionKinds).not.toContain('automation.set')
  expect(controlCapabilitiesV1.actionKinds).not.toContain('sidechain.set')
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'effect.add',
    target: { master: true },
    effectKind: 'eq',
  }]))).toThrow()
})

test('projects core mixer and clip control state', () => {
  const snapshot = projectSnapshotSchemaV1.parse({
    version: 'v1',
    project: {
      id: 'project-1',
      name: 'Project',
      revision: 1,
      tempoBpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      loop: { enabled: false, startSec: 0, endSec: 8 },
      masterVolume: 0.8,
      updatedAt: 1,
    },
    tracks: [],
    clips: [{
      id: 'clip-1',
      trackId: 'track-1',
      name: 'MIDI',
      startSec: 0,
      duration: 1,
      gain: 0.9,
      leftPadSec: 0,
      bufferOffsetSec: 0,
      midiOffsetBeats: 0,
      fades: {
        fadeInStartSec: 0.05,
        fadeInSec: 0.1,
        fadeOutSec: 0.2,
        fadeOutEndSec: 0.95,
        fadeInCurve: 0.5,
        fadeOutCurve: -0.5,
        fadeInCurvePosition: 0.3,
        fadeOutCurvePosition: 0.7,
      },
      midi: {
        wave: 'sine',
        notes: [{ beat: 0, length: 1, pitch: 60 }],
      },
    }],
  })
  expect(snapshot.project.masterVolume).toBe(0.8)
  expect(snapshot.clips[0]?.midi?.notes).toHaveLength(1)
})

const routingCommitOfByteLength = (byteLength: number) => {
  const actions = Array.from({ length: controlLimitsV1.maxActions }, () => ({
    kind: 'track.routing.set' satisfies 'track.routing.set',
    trackId: 'track-1',
    sends: Array.from({ length: 64 }, () => ({ targetTrackId: 'x', amount: 1 })),
  }))
  const request = commit(actions)
  const baseline = new TextEncoder().encode(canonicalJson(request)).byteLength
  let remaining = byteLength - baseline
  for (const action of actions) {
    for (const send of action.sends) {
      const extension = Math.min(255, Math.max(0, remaining))
      send.targetTrackId = `x${'x'.repeat(extension)}`
      remaining -= extension
    }
  }
  if (remaining !== 0) throw new Error('Requested routing fixture size is unavailable.')
  return request
}

test('accepts the serialized request boundary and rejects one byte over', () => {
  const exactLimit = routingCommitOfByteLength(controlLimitsV1.maxSerializedBodyBytes)
  const overLimit = routingCommitOfByteLength(controlLimitsV1.maxSerializedBodyBytes + 1)
  expect(new TextEncoder().encode(canonicalJson(exactLimit)).byteLength).toBe(controlLimitsV1.maxSerializedBodyBytes)
  expect(() => parseControlCommitRequestV1(exactLimit)).not.toThrow()
  expect(new TextEncoder().encode(canonicalJson(overLimit)).byteLength).toBe(controlLimitsV1.maxSerializedBodyBytes + 1)
  expect(() => parseControlCommitRequestV1(overLimit)).toThrow()
})

test('rejects deferred processor actions and snapshots', () => {
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'effect.add',
    target: { trackId: 'track-1' },
    effectInstanceId: 'effect-1',
    effectKind: 'delay',
    params: { enabled: true, mode: 'sync', timeMs: 1, syncDivision: '1/4', feedback: 0, dryWet: 1, pingPong: false, filterEnabled: false, lowCutHz: 20, highCutHz: 1000, unexpected: true },
  }]))).toThrow()
  expect(() => parseControlCommitRequestV1(commit([{
    kind: 'instrument.add',
    trackId: 'track-1',
    instrumentKind: 'synth',
    instanceId: 'instrument-1',
    params: { unexpected: true },
  }]))).toThrow()
  expect(() => projectSnapshotSchemaV1.parse({
    version: 'v1',
    project: {
      id: 'project-1', name: 'Project', revision: 0, tempoBpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      loop: { enabled: false, startSec: 0, endSec: 0 },
      masterVolume: 0.8,
      updatedAt: 0,
    },
    tracks: [],
    clips: [],
    effects: [{
      target: { master: true }, instanceId: 'arp-1', kind: 'arpeggiator', index: 0,
      params: { enabled: true, pattern: 'up', rate: '1/8', octaves: 2, gate: 0.8, hold: false },
    }, {
      target: { trackId: 'track-1' }, instanceId: 'synth-1', kind: 'synth', index: 0,
      params: { wave1: 'sine', wave2: 'square', gain: 0.8 },
    }],
    automation: [],
    sidechains: [],
  })).toThrow()
})

test('rejects more actions than the atomic contract allows', () => {
  const actions = Array.from({ length: controlLimitsV1.maxActions + 1 }, () => ({
    kind: 'track.delete',
    trackId: 'track-1',
  }))
  expect(() => controlCommitRequestSchemaV1.parse(commit(actions))).toThrow()
})
