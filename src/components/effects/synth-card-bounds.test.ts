import { describe, expect, test } from 'bun:test'
import {
  clampSynthCardBounds,
  createInitialSynthCardBounds,
} from './synth-card-bounds'

describe('synth card bounds', () => {
  test('keeps desktop bounds within the viewport', () => {
    expect(clampSynthCardBounds({ x: 1300, y: 800, w: 900, h: 700 }, 1440, 900)).toEqual({
      x: 540,
      y: 200,
      w: 900,
      h: 700,
    })
  })

  test('uses available tablet dimensions', () => {
    const bounds = createInitialSynthCardBounds(768, 600)
    expect(bounds.w).toBe(640)
    expect(bounds.h).toBe(560)
    expect(bounds.x + bounds.w).toBeLessThanOrEqual(768)
    expect(bounds.y + bounds.h).toBeLessThanOrEqual(600)
  })

  test('permits narrow viewports below the desktop card minimum', () => {
    expect(clampSynthCardBounds({ x: 20, y: 20, w: 640, h: 560 }, 320, 568)).toEqual({
      x: 12,
      y: 20,
      w: 308,
      h: 544,
    })
  })

  test('reclamps a bottom-right card after the viewport shrinks', () => {
    expect(clampSynthCardBounds({ x: 800, y: 420, w: 640, h: 560 }, 768, 600)).toEqual({
      x: 128,
      y: 40,
      w: 640,
      h: 560,
    })
  })

  test('repairs oversized persisted bounds', () => {
    expect(clampSynthCardBounds({ x: -40, y: 1000, w: 2000, h: 2000 }, 768, 600)).toEqual({
      x: 0,
      y: 24,
      w: 756,
      h: 576,
    })
  })
})
