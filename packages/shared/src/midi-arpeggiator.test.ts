import { describe, expect, test } from 'bun:test'

import { arpeggiatorParamsEqual } from './midi-arpeggiator'

const params = {
  enabled: true,
  pattern: 'up' as const,
  rate: '1/8' as const,
  octaves: 1,
  gate: 0.5,
  hold: true,
}

describe('arpeggiatorParamsEqual', () => {
  test('compares equivalent values structurally', () => {
    expect(arpeggiatorParamsEqual(params, { ...params })).toBe(true)
    expect(arpeggiatorParamsEqual(params, { ...params, gate: 0.75 })).toBe(false)
    expect(arpeggiatorParamsEqual(params, undefined)).toBe(false)
    expect(arpeggiatorParamsEqual(undefined, undefined)).toBe(true)
  })
})
