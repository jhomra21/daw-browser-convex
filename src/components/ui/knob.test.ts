import { describe, expect, test } from 'bun:test'
import { quantizeSteppedValue } from '~/hooks/useSteppedValueControl'
import { knobValueFromDrag, valueToKnobFraction } from './knob'

describe('knob value mapping', () => {
  test('anchors step quantization to the minimum', () => {
    expect(quantizeSteppedValue(0.31, 0.05, 1, 0.1)).toBe(0.35)
    expect(quantizeSteppedValue(0.29, 0.05, 1, 0.1)).toBe(0.25)
  })

  test('uses 240 pixels for a full linear traversal and 10% sensitivity in fine mode', () => {
    expect(knobValueFromDrag(0, 240, 0, 100, false, false)).toBe(100)
    expect(knobValueFromDrag(50, 24, 0, 100, false, false)).toBe(60)
    expect(knobValueFromDrag(50, 24, 0, 100, false, true)).toBe(51)
  })

  test('traverses multiple integer values during one Bits drag', () => {
    const values = [0, 24, 48, 72].map((deltaY) => (
      quantizeSteppedValue(knobValueFromDrag(11, deltaY, 2, 24, false, false), 2, 24, 1)
    ))

    expect(values).toEqual([11, 13, 15, 18])
    expect(values.every(Number.isInteger)).toBe(true)
  })

  test('keeps logarithmic starts stable and moves through log space', () => {
    expect(knobValueFromDrag(10, 0, 1, 1000, true, false)).toBeCloseTo(10)
    expect(knobValueFromDrag(10, 80, 1, 1000, true, false)).toBeCloseTo(100)
    expect(knobValueFromDrag(10, 8, 1, 1000, true, true)).toBeCloseTo(10 ** 1.01)
  })

  test('uses the logarithmic fraction for visual arcs', () => {
    expect(valueToKnobFraction(10, 1, 1000, true)).toBeCloseTo(1 / 3)
    expect(valueToKnobFraction(100, 1, 1000, true)).toBeCloseTo(2 / 3)
    expect(valueToKnobFraction(500, 0, 1000, false)).toBe(0.5)
  })

  test('falls back to linear mapping for invalid logarithmic domains', () => {
    expect(valueToKnobFraction(50, 0, 100, true)).toBe(0.5)
    expect(knobValueFromDrag(50, 24, 0, 100, true, false)).toBe(60)
  })

  test('preserves zero while mapping zero-inclusive envelope times perceptually', () => {
    expect(valueToKnobFraction(0, 0, 60, true, true)).toBe(0)
    expect(valueToKnobFraction(0.001, 0, 60, true, true)).toBeCloseTo(0.08)
    expect(valueToKnobFraction(1, 0, 60, true, true)).toBeLessThan(0.7)
    expect(knobValueFromDrag(0, 0, 0, 60, true, false, true)).toBe(0)
    expect(knobValueFromDrag(0, 24, 0, 60, true, false, true)).toBeGreaterThan(0)
    expect(knobValueFromDrag(1, 0, 0, 60, true, false, true)).toBeCloseTo(1)
  })
})
