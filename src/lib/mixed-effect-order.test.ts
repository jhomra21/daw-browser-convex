import { normalizeMixedEffectEntityRows, mixedOrderFromRows } from './mixed-effect-order'
import { expect, test } from 'bun:test'
import { isJsonObject } from '@daw-browser/shared'

const external = (instanceId: string, index: number) => ({
  instanceId,
  targetId: 'track-1',
  index,
  manifest: {
    identity: {
      format: 'vst3' as const,
      classId: 'class',
      vendor: 'vendor',
      name: 'effect',
      version: '1',
      architecture: 'arm64' as const,
      binaryFingerprint: 'a'.repeat(64),
    },
    role: 'effect' as const,
    audioInputs: [{ name: 'Input', channels: 2, enabled: true }],
    audioOutputs: [{ name: 'Output', channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: true,
    supportsEditor: false,
    supportsState: true,
  },
  parameterOverrides: {},
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  health: { state: 'ready' as const, updatedAt: 1 },
  updatedAt: 1,
})

test('normalizes legacy built-in and external rows into one target order', () => {
  const rows = normalizeMixedEffectEntityRows([
    { kind: 'effect', id: 'builtin-a', value: { targetId: 'track-1', instanceId: 'builtin-a', effect: 'delay', index: 0, params: {} }, updatedAt: 1 },
    { kind: 'effect', id: 'builtin-b', value: { targetId: 'track-1', instanceId: 'builtin-b', effect: 'eq', index: 1, params: {} }, updatedAt: 1 },
    { kind: 'external-plugin', id: 'external-a', value: external('00000000-0000-4000-8000-000000000001', 0), updatedAt: 1 },
  ])

  expect(mixedOrderFromRows(rows, 'track-1')).toEqual([
    { kind: 'builtin', instanceId: 'builtin-a' },
    { kind: 'external', instanceId: '00000000-0000-4000-8000-000000000001' },
    { kind: 'builtin', instanceId: 'builtin-b' },
  ])
  expect(rows.map((row) => isJsonObject(row.value) ? row.value.index : undefined)).toEqual([0, 2, 1])
})

test('rejects duplicate instance identities across built-in and external rows', () => {
  expect(() => normalizeMixedEffectEntityRows([
    { kind: 'effect', id: 'builtin-a', value: { targetId: 'track-1', instanceId: '00000000-0000-4000-8000-000000000002', effect: 'delay', params: {} }, updatedAt: 1 },
    { kind: 'external-plugin', id: 'external-a', value: external('00000000-0000-4000-8000-000000000002', 0), updatedAt: 1 },
  ])).toThrow('Duplicate effect identity')
})

test('assigns deterministic instance IDs to legacy built-in rows', () => {
  const rows = normalizeMixedEffectEntityRows([
    { kind: 'effect', id: 'legacy-row', value: { targetId: 'track-1', effect: 'delay', params: {} }, updatedAt: 1 },
  ])
  expect(rows[0]?.value).toMatchObject({ instanceId: 'legacy:legacy-row', index: 0 })
})

test('leaves instrument, synth, arp, and non-audio rows out of mixed effect migration', () => {
  const rows = normalizeMixedEffectEntityRows([
    { kind: 'effect', id: 'delay-row', value: { targetId: 'track-1', instanceId: 'delay', effect: 'delay', index: 5, params: {} }, updatedAt: 1 },
    { kind: 'effect', id: 'instrument-row', value: { targetId: 'track-1', effect: 'instrument', index: 0, params: { kind: 'sampler' } }, updatedAt: 1 },
    { kind: 'effect', id: 'synth-row', value: { targetId: 'track-1', effect: 'synth', index: 1, params: {} }, updatedAt: 1 },
    { kind: 'effect', id: 'arp-row', value: { targetId: 'track-1', effect: 'arp', index: 2, params: {} }, updatedAt: 1 },
    { kind: 'effect', id: 'other-row', value: { targetId: 'track-1', effect: 'not-audio', index: 3, params: {} }, updatedAt: 1 },
    { kind: 'external-plugin', id: 'external-a', value: external('00000000-0000-4000-8000-000000000003', 0), updatedAt: 1 },
  ])

  expect(mixedOrderFromRows(rows, 'track-1')).toEqual([
    { kind: 'external', instanceId: '00000000-0000-4000-8000-000000000003' },
    { kind: 'builtin', instanceId: 'delay' },
  ])
  expect(rows.find((row) => row.id === 'delay-row')?.value).toMatchObject({ index: 1 })
  expect(rows.filter((row) => row.id !== 'delay-row' && row.kind === 'effect').map((row) => (
    isJsonObject(row.value) ? row.value.index : undefined
  ))).toEqual([0, 1, 2, 3])
})
