import { describe, expect, test } from 'bun:test'

import { clampBpm, DEFAULT_BPM, DEFAULT_GRID, DEFAULT_LOOP, MAX_BPM, MIN_BPM } from './project-defaults'

describe('project defaults', () => {
  test('equal the literals they replaced', () => {
    expect(DEFAULT_BPM).toBe(120)
    expect([MIN_BPM, MAX_BPM]).toEqual([30, 300])
    expect(DEFAULT_GRID).toEqual({ enabled: true, denominator: 4 })
    expect(DEFAULT_LOOP).toEqual({ enabled: false, startSec: 0, endSec: 8 })
  })

  test('clampBpm rounds and clamps like the copies it replaced', () => {
    expect(clampBpm(10)).toBe(30)
    expect(clampBpm(999)).toBe(300)
    expect(clampBpm(120.4)).toBe(120)
    expect(clampBpm(120.5)).toBe(121)
    expect(clampBpm(Number.NaN)).toBeNaN()
  })
})
