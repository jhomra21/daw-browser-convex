import { expect, test } from 'bun:test'

import {
  canStartFadeInteraction,
  clipFadeControlValueText,
  curveFadeControlValueText,
  pointerPositionInFadeOverlay,
  relatedTargetStaysWithinFadeHoverRegion,
  updateFadeDraft,
  updateFadeDraftForKeyboard,
} from './clip-fade-interaction'

const baseline = {
  fadeInStartSec: 0,
  fadeInSec: 1,
  fadeOutSec: 2,
  fadeOutEndSec: 0,
  fadeInCurve: 0,
  fadeOutCurve: 0,
  fadeInCurvePosition: 0.5,
  fadeOutCurvePosition: 0.5,
}

test('accepts editable fade controls only with usable overlay dimensions', () => {
  expect(canStartFadeInteraction({
    canEdit: true,
    isMidi: false,
    button: 0,
    overlayWidth: 160,
    overlayHeight: 40,
  })).toBe(true)
  expect(canStartFadeInteraction({
    canEdit: true,
    isMidi: false,
    button: 0,
    overlayWidth: 0,
    overlayHeight: 40,
  })).toBe(false)
  expect(canStartFadeInteraction({
    canEdit: false,
    isMidi: false,
    button: 0,
    overlayWidth: 160,
    overlayHeight: 40,
  })).toBe(false)
})

test('preserves curve hover only within the exiting side hover region', () => {
  const hoverTarget = (side: 'fadeIn' | 'fadeOut') => ({
    closest: (selector: string) => selector === '[data-fade-hover-side]'
      ? { getAttribute: (attribute: string) => attribute === 'data-fade-hover-side' ? side : null }
      : null,
  })

  expect(relatedTargetStaysWithinFadeHoverRegion('fadeIn', hoverTarget('fadeIn'))).toBe(true)
  expect(relatedTargetStaysWithinFadeHoverRegion('fadeIn', hoverTarget('fadeOut'))).toBe(false)
  expect(relatedTargetStaysWithinFadeHoverRegion('fadeIn', null)).toBe(false)
})

test('updates all endpoint and curve controls from a local baseline', () => {
  expect(canStartFadeInteraction({
    canEdit: true,
    isMidi: false,
    button: 0,
    overlayWidth: 160,
    overlayHeight: 40,
  })).toBe(true)

  expect(updateFadeDraft({
    baseline,
    side: 'fadeIn',
    mode: 'fadeInStart',
    duration: 8,
    overlayWidth: 160,
    overlayHeight: 40,
    currentX: 20,
    currentY: 0,
  }).fadeInStartSec).toBe(1)
  expect(updateFadeDraft({
    baseline,
    side: 'fadeOut',
    mode: 'fadeOutEnd',
    duration: 8,
    overlayWidth: 160,
    overlayHeight: 40,
    currentX: 120,
    currentY: 20,
  }).fadeOutEndSec).toBe(2)
  const curve = updateFadeDraft({
    baseline,
    side: 'fadeIn',
    mode: 'curve',
    duration: 8,
    overlayWidth: 160,
    overlayHeight: 40,
    currentX: 10,
    currentY: 0,
  })
  expect(curve.fadeInCurvePosition).toBeCloseTo(0.5)
  expect(curve.fadeInCurve).toBe(1)
})

test('uses deterministic keyboard adjustments and accessible values', () => {
  expect(updateFadeDraftForKeyboard(baseline, 'fadeIn', 'fadeInEnd', 8, 'ArrowRight')?.fadeInSec).toBe(1.05)
  expect(updateFadeDraftForKeyboard(baseline, 'fadeIn', 'fadeInEnd', 8, 'PageUp')?.fadeInSec).toBe(1.5)
  expect(updateFadeDraftForKeyboard(baseline, 'fadeIn', 'fadeInEnd', 8, 'Home')?.fadeInSec).toBe(0)
  expect(updateFadeDraftForKeyboard(baseline, 'fadeIn', 'fadeInEnd', 8, 'End')?.fadeInSec).toBe(6)
  const curve = updateFadeDraftForKeyboard(baseline, 'fadeIn', 'curve', 8, 'ArrowUp')
  expect(curve?.fadeInCurve).toBe(0.05)
  expect(updateFadeDraftForKeyboard(curve ?? baseline, 'fadeIn', 'curve', 8, 'ArrowRight')?.fadeInCurvePosition).toBe(0.55)
  expect(clipFadeControlValueText(baseline, 'fadeInEnd')).toBe('1.00 seconds')
  expect(curveFadeControlValueText({ x: 0.25, y: 0.8 })).toBe('Curve position 25%, gain 80%')
})

test('maps pointer movement against the initial overlay geometry', () => {
  const snapshot = { left: 100, top: 50 }
  expect(pointerPositionInFadeOverlay(snapshot, { clientX: 140, clientY: 70 })).toEqual({ x: 40, y: 20 })
  expect(pointerPositionInFadeOverlay(snapshot, { clientX: 140, clientY: 70 })).toEqual({ x: 40, y: 20 })
})
