import { describe, expect, test } from 'bun:test'

import {
  fadeGainAtClipTime,
  clipFadesForFragment,
  getClipFadeBezierControlPoint,
  getNormalizedClipFadeBezierControlPoint,
  normalizeClipFades,
  normalizedFadeGainAtClipTime,
  transformClipFadesForDuration,
} from './clip-fades'

describe('clip fades', () => {
  const fades = {
    fadeInStartSec: 0,
    fadeInSec: 2,
    fadeOutSec: 2,
    fadeOutEndSec: 0,
    fadeInCurve: 0,
    fadeOutCurve: 0,
    fadeInCurvePosition: 0.5,
    fadeOutCurvePosition: 0.5,
  }

  test('evaluates linear fades at endpoints and midpoint', () => {
    expect(fadeGainAtClipTime(fades, 10, 0)).toBe(0)
    expect(fadeGainAtClipTime(fades, 10, 1)).toBe(0.5)
    expect(fadeGainAtClipTime(fades, 10, 5)).toBe(1)
    expect(fadeGainAtClipTime(fades, 10, 10)).toBe(0)
  })

  test('positive curve bends a fade in upward', () => {
    const linear = fadeGainAtClipTime({ ...fades, fadeOutSec: 0 }, 4, 1)
    const upward = fadeGainAtClipTime({ ...fades, fadeOutSec: 0, fadeInCurve: 1 }, 4, 1)
    const downward = fadeGainAtClipTime({ ...fades, fadeOutSec: 0, fadeInCurve: -1 }, 4, 1)
    expect(upward).toBeGreaterThan(linear)
    expect(downward).toBeLessThan(linear)
  })

  test('normalizes malformed and overlapping values with edited-side precedence', () => {
    expect(normalizeClipFades({
      fadeInSec: Number.NaN,
      fadeOutSec: 10,
      fadeInCurve: 2,
      fadeOutCurve: -2,
    }, 4)).toEqual({
      fadeInStartSec: 0,
      fadeInSec: 0,
      fadeOutSec: 4,
      fadeOutEndSec: 0,
      fadeInCurve: 1,
      fadeOutCurve: -1,
      fadeInCurvePosition: 0.5,
      fadeOutCurvePosition: 0.5,
    })
    expect(normalizeClipFades({
      fadeInSec: 3,
      fadeOutSec: 3,
      fadeInCurve: 0,
      fadeOutCurve: 0,
    }, 4, 'fadeIn')).toEqual({
      fadeInStartSec: 0,
      fadeInSec: 1,
      fadeOutSec: 3,
      fadeOutEndSec: 0,
      fadeInCurve: 0,
      fadeOutCurve: 0,
      fadeInCurvePosition: 0.5,
      fadeOutCurvePosition: 0.5,
    })
  })

  test('defaults legacy fields and preserves all endpoint positions through trimming', () => {
    expect(normalizeClipFades({ fadeInSec: 3, fadeOutSec: 3, fadeInCurve: 0, fadeOutCurve: 0 }, 10)).toMatchObject({
      fadeInStartSec: 0,
      fadeOutEndSec: 0,
      fadeInCurvePosition: 0.5,
      fadeOutCurvePosition: 0.5,
    })
    expect(transformClipFadesForDuration({ ...fades, fadeInStartSec: 1 }, 10, 6, 2)).toMatchObject({
      fadeInStartSec: 0,
      fadeInSec: 0,
      fadeOutSec: 2,
    })
  })

  test('uses a straight default bezier and honors movable curve positions', () => {
    expect(getClipFadeBezierControlPoint(fades, 10, 'fadeIn')).toEqual({ x: 1, y: 0.5 })
    expect(fadeGainAtClipTime(fades, 10, 1)).toBeCloseTo(0.5)
    const moved = { ...fades, fadeInCurvePosition: 0.25, fadeInCurve: 1 }
    expect(getClipFadeBezierControlPoint(moved, 10, 'fadeIn')).toEqual({ x: 0.5, y: 1 })
    expect(fadeGainAtClipTime(moved, 10, 1)).toBeGreaterThan(0.5)
  })

  test('fragment boundaries clear newly-created cut fades', () => {
    expect(clipFadesForFragment({ ...fades, fadeInStartSec: 1, fadeOutEndSec: 1 }, 10, 4, false, true)).toMatchObject({
      fadeInStartSec: 1,
      fadeInSec: 2,
      fadeOutSec: 0,
      fadeOutEndSec: 0,
    })
    expect(clipFadesForFragment(fades, 10, 4, true, false)).toMatchObject({
      fadeInStartSec: 0,
      fadeInSec: 0,
      fadeOutSec: 2,
    })
  })

  test('normalized evaluators match public evaluators for canonical and legacy inputs', () => {
    const cases = [
      fades,
      { ...fades, fadeInCurve: 0.8, fadeOutCurve: -0.8, fadeInCurvePosition: 0.2, fadeOutCurvePosition: 0.8 },
      { fadeInSec: 2, fadeOutSec: 3, fadeInCurve: 0, fadeOutCurve: 0 },
      { fadeInSec: Number.NaN, fadeOutSec: 20, fadeInCurve: 2, fadeOutCurve: -2 },
      { ...fades, fadeInSec: 8, fadeOutSec: 8 },
    ]
    for (const input of cases) {
      const normalized = normalizeClipFades(input, 10)
      for (const time of [0, 1, 5, 10]) {
        expect(normalizedFadeGainAtClipTime(normalized, 10, time)).toBeCloseTo(fadeGainAtClipTime(input, 10, time))
      }
      const sides: Array<'fadeIn' | 'fadeOut'> = ['fadeIn', 'fadeOut']
      for (const side of sides) {
        expect(getNormalizedClipFadeBezierControlPoint(normalized, 10, side))
          .toEqual(getClipFadeBezierControlPoint(input, 10, side))
      }
    }
  })
})
