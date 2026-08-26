import { expect, test } from 'bun:test'
import {
  controlActionSchemaV1,
  controlCapabilitiesV1,
  type ContextualRefV1,
} from '@daw-browser/control'
import {
  destructiveControlActionKindsV1,
  projectControlSnapshotV1,
  resolveControlMidiActionV1,
} from './index'

const persisted = (id: string): ContextualRefV1 => ({ source: 'persisted', id })

test('preserves expanded MIDI for legacy actions and replaces it when supplied', () => {
  const current = {
    wave: 'sine',
    gain: 0.5,
    inputChannel: 2,
    notes: [{ id: 'old-note', beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 2 }],
    cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 2 }],
    pitchBends: [],
    channelPressure: [],
    polyPressure: [],
    mappings: [{ id: 'mapping-1', source: { kind: 'cc' as const, controller: 1, channel: 2 }, target: { parameterId: 'gain' }, outputMin: 0, outputMax: 1 }],
  }
  expect(resolveControlMidiActionV1({
    wave: 'sine',
    gain: 0.5,
    notes: [{ beat: 0, length: 1, pitch: 60, velocity: 0.5 }],
  }, current)).toMatchObject(current)
  expect(resolveControlMidiActionV1({
    wave: 'sine',
    notes: [],
    cc: [],
  }, current)).toEqual({
    wave: 'sine',
    notes: [],
    cc: [],
    pitchBends: [],
    channelPressure: [],
    polyPressure: [],
    mappings: [],
  })
  expect(resolveControlMidiActionV1({
    wave: 'sine',
    notes: [{ id: 'replacement-note', beat: 0, length: 1, pitch: 61 }],
  }, current)).toMatchObject({
    wave: 'sine',
    inputChannel: current.inputChannel,
    cc: current.cc,
    pitchBends: current.pitchBends,
    channelPressure: current.channelPressure,
    polyPressure: current.polyPressure,
    mappings: current.mappings,
    notes: [{ id: 'replacement-note', beat: 0, length: 1, pitch: 61, channel: 1 }],
  })
  expect(resolveControlMidiActionV1({
    wave: 'sine',
    notes: [{ beat: 0, length: 1, pitch: 61, channel: 3 }],
  }, current).notes).toMatchObject([{ beat: 0, length: 1, pitch: 61, channel: 3 }])
})

test('reconciles identical idless notes one-to-one and preserves omitted channels', () => {
  const current = {
    wave: 'sine',
    notes: [
      { id: 'first', beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 2 },
      { id: 'second', beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 3 },
    ],
  }
  expect(resolveControlMidiActionV1({
    wave: 'sine',
    notes: [
      { beat: 0, length: 1, pitch: 60, velocity: 0.5 },
      { beat: 0, length: 1, pitch: 60, velocity: 0.5 },
    ],
  }, current).notes).toMatchObject(current.notes)
  expect(resolveControlMidiActionV1({
    wave: 'sine',
    notes: [{ beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 4 }],
  }, current).notes).toMatchObject([{
    beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 4,
  }])
})

test('edits one legacy MIDI note without rewriting unrelated historical state', () => {
  const notes = Array.from({ length: 501 }, (_, index) => ({
    id: `note-${index}`,
    beat: index,
    length: 1,
    pitch: 60,
    velocity: 0.5,
    channel: 1,
  }))
  notes[0] = { id: 'invalid-note', beat: -2, length: -1, pitch: 200, velocity: 2, channel: 1 }
  const current = {
    wave: 'custom-legacy',
    gain: 7,
    notes,
    cc: [{ id: 'cc-1', beat: 0, controller: 1, value: 0.5, channel: 1 }],
    mappings: [{ id: 'mapping-1', source: { kind: 'cc' as const, controller: 1, channel: 1 }, target: { parameterId: 'gain' }, outputMin: 0, outputMax: 1 }],
  }
  const action = {
    kind: 'clip.midi.set' as const,
    clip: persisted('clip-1'),
    wave: 'custom-legacy',
    gain: 7,
    notes: notes.map((note) => note.id === 'invalid-note'
      ? { ...note, beat: 0, length: 1, pitch: 60, velocity: 0.5 }
      : note),
  }
  const parsedAction = controlActionSchemaV1.parse(action)
  if (parsedAction.kind !== 'clip.midi.set') throw new Error('Expected MIDI set action.')
  expect(parsedAction.notes).toHaveLength(501)
  const resolved = resolveControlMidiActionV1(action, current)
  expect(resolved).toMatchObject({
    wave: 'custom-legacy',
    gain: 7,
    cc: current.cc,
    mappings: current.mappings,
  })
  expect(resolved.notes).toHaveLength(501)
  expect(resolved.notes.find((note) => note.id === 'invalid-note')).toMatchObject({
    id: 'invalid-note', beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 1,
  })
  expect(() => resolveControlMidiActionV1({
    ...action,
    notes: [...action.notes, { id: 'new-invalid', beat: 0, length: -1, pitch: 200, velocity: 2 }],
  }, current)).toThrow()
  expect(() => resolveControlMidiActionV1({
    ...action,
    notes: action.notes.map((note) => note.id === 'invalid-note' ? { ...note, length: -2 } : note),
  }, current)).toThrow()
  expect(() => resolveControlMidiActionV1({ ...action, wave: 'unsupported-new-wave' }, current)).toThrow()
  expect(() => resolveControlMidiActionV1({ ...action, gain: 8 }, current)).toThrow()
  expect(() => resolveControlMidiActionV1({
    ...action,
    notes: [...action.notes, { id: 'new-valid', beat: 600, length: 1, pitch: 60, velocity: 0.5 }],
  }, current)).toThrow()
})

test('projects only canonical, bounded external parameter overrides', () => {
  const projected = projectControlSnapshotV1({
    project: {
      projectId: 'project-1',
      name: 'Project',
      revision: 1,
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      loopEnabled: false,
      loopStartSec: 0,
      loopEndSec: 8,
      updatedAt: 1,
    },
    tracks: [],
    clips: [],
    masterVolume: 1,
    effects: [],
    externalProcessors: [{
      instanceId: 'instance-1',
      targetId: 'master',
      index: 0,
      manifest: {
        identity: { name: 'Fixture', vendor: 'Vendor', classId: 'class-1' },
        role: 'effect',
        parameters: [{ id: 1, readOnly: false }, { id: 2, readOnly: false }],
      },
      bypassed: false,
      parameterOverrides: { '01': -0.5, '2.0': 1.5, '999': 0.5 },
    }],
    automationEnvelopes: [],
    sidechainRoutes: [],
    assets: [],
    assetFolders: [],
  })
  const external = projected.processors.find((processor) => processor.id === 'external-plugin:instance-1')
  expect(external?.processor).toMatchObject({
    kind: 'external-vst3',
    params: { parameterOverrides: { '1': 0, '2': 1 } },
  })
})

test('defines the exhaustive destructive action policy', () => {
  expect(destructiveControlActionKindsV1).toEqual([
    'track.delete',
    'track.ungroup',
    'clip.delete',
    'effect.remove',
    'instrument.remove',
    'arpeggiator.remove',
    'automation.delete',
    'sidechain.remove',
    'asset.delete',
    'timeline.range.delete',
  ])
  expect(destructiveControlActionKindsV1.every((kind) => controlCapabilitiesV1.actionKinds.includes(kind))).toBe(true)
})
