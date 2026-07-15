import { expect, test } from 'bun:test'

import {
  canStartFadeInteraction,
  relatedTargetStaysWithinFadeHoverRegion,
  updateFadeDraft,
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
    mode: 'fadeInStart',
    overlayWidth: 160,
    overlayHeight: 40,
  })).toBe(true)
  expect(canStartFadeInteraction({
    canEdit: true,
    isMidi: false,
    button: 0,
    mode: 'fadeInStart',
    overlayWidth: 0,
    overlayHeight: 40,
  })).toBe(false)
  expect(canStartFadeInteraction({
    canEdit: false,
    isMidi: false,
    button: 0,
    mode: 'fadeInStart',
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
    mode: 'curve',
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
