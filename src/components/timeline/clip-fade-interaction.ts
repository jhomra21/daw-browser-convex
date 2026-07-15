import { normalizeClipFades, type ClipFadeSide, type FadePoint, type NormalizedClipFades } from '@daw-browser/timeline-core/clip-fades'

export type FadeInteractionMode = 'fadeInStart' | 'fadeInEnd' | 'fadeOutStart' | 'fadeOutEnd' | 'curve'

type FadeInteractionStart = {
  canEdit: boolean
  isMidi: boolean
  button: number
  overlayWidth: number
  overlayHeight: number
}

export type FadeDraftUpdate = {
  baseline: NormalizedClipFades
  side: ClipFadeSide
  mode: FadeInteractionMode
  duration: number
  overlayWidth: number
  overlayHeight: number
  currentX: number
  currentY: number
}

export const fadeKeyboardStepSec = 0.05
export const fadeKeyboardLargeStepSec = 0.5
export const fadeCurveKeyboardStep = 0.05
export const fadeCurveKeyboardLargeStep = 0.2

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.min(maximum, Math.max(minimum, value))
)

type FadeHoverRegionTarget = {
  closest: (selector: string) => {
    getAttribute: (qualifiedName: string) => string | null
  } | null
}

const isFadeHoverRegionTarget = (target: unknown): target is FadeHoverRegionTarget => (
  typeof target === 'object'
  && target !== null
  && 'closest' in target
  && typeof target.closest === 'function'
)

export const canStartFadeInteraction = (start: FadeInteractionStart) => (
  start.canEdit
  && !start.isMidi
  && start.button === 0
  && start.overlayWidth > 0
  && start.overlayHeight > 0
)

export const relatedTargetStaysWithinFadeHoverRegion = (
  side: ClipFadeSide,
  relatedTarget: unknown,
) => (
  isFadeHoverRegionTarget(relatedTarget)
  && relatedTarget.closest('[data-fade-hover-side]')?.getAttribute('data-fade-hover-side') === side
)

export const updateFadeDraft = (update: FadeDraftUpdate): NormalizedClipFades => {
  if (update.mode === 'curve') {
    const curveKey = update.side === 'fadeIn' ? 'fadeInCurve' : 'fadeOutCurve'
    const positionKey = update.side === 'fadeIn' ? 'fadeInCurvePosition' : 'fadeOutCurvePosition'
    const fadeStart = update.side === 'fadeIn'
      ? update.baseline.fadeInStartSec
      : update.duration - update.baseline.fadeOutSec
    const fadeEnd = update.side === 'fadeIn'
      ? update.baseline.fadeInSec
      : update.duration - update.baseline.fadeOutEndSec
    const span = fadeEnd - fadeStart
    const position = span > 0
      ? Math.min(1, Math.max(0, ((update.currentX / update.overlayWidth) * update.duration - fadeStart) / span))
      : 0.5
    const linearGain = update.side === 'fadeIn' ? position : 1 - position
    const gain = Math.min(1, Math.max(0, 1 - update.currentY / update.overlayHeight))
    const curve = gain >= linearGain
      ? (gain - linearGain) / Math.max(0.000001, 1 - linearGain)
      : (gain - linearGain) / Math.max(0.000001, linearGain)
    return normalizeClipFades({
      ...update.baseline,
      [curveKey]: curve,
      [positionKey]: position,
    }, update.duration)
  }

  const time = Math.min(update.duration, Math.max(0, (update.currentX / update.overlayWidth) * update.duration))
  const patch = update.mode === 'fadeInStart'
    ? { fadeInStartSec: time }
    : update.mode === 'fadeInEnd'
      ? { fadeInSec: time }
      : update.mode === 'fadeOutStart'
        ? { fadeOutSec: update.duration - time }
        : { fadeOutEndSec: update.duration - time }
  return normalizeClipFades({
    ...update.baseline,
    ...patch,
  }, update.duration, update.side)
}

export const updateFadeDraftForKeyboard = (
  baseline: NormalizedClipFades,
  side: ClipFadeSide,
  mode: FadeInteractionMode,
  duration: number,
  key: string,
): NormalizedClipFades | null => {
  if (mode === 'curve') {
    const positionKey = side === 'fadeIn' ? 'fadeInCurvePosition' : 'fadeOutCurvePosition'
    const curveKey = side === 'fadeIn' ? 'fadeInCurve' : 'fadeOutCurve'
    const isLarge = key === 'PageUp' || key === 'PageDown'
    const positionStep = isLarge ? fadeCurveKeyboardLargeStep : fadeCurveKeyboardStep
    const curveStep = isLarge ? fadeCurveKeyboardLargeStep : fadeCurveKeyboardStep
    if (key === 'ArrowLeft' || key === 'PageDown') {
      return normalizeClipFades({ ...baseline, [positionKey]: baseline[positionKey] - positionStep }, duration, side)
    }
    if (key === 'ArrowRight' || key === 'PageUp') {
      return normalizeClipFades({ ...baseline, [positionKey]: baseline[positionKey] + positionStep }, duration, side)
    }
    if (key === 'ArrowDown') {
      return normalizeClipFades({ ...baseline, [curveKey]: baseline[curveKey] - curveStep }, duration, side)
    }
    if (key === 'ArrowUp') {
      return normalizeClipFades({ ...baseline, [curveKey]: baseline[curveKey] + curveStep }, duration, side)
    }
    if (key === 'Home') return normalizeClipFades({ ...baseline, [positionKey]: 0 }, duration, side)
    if (key === 'End') return normalizeClipFades({ ...baseline, [positionKey]: 1 }, duration, side)
    return null
  }

  const field = mode === 'fadeInStart'
    ? 'fadeInStartSec'
    : mode === 'fadeInEnd'
      ? 'fadeInSec'
      : mode === 'fadeOutStart'
        ? 'fadeOutSec'
        : 'fadeOutEndSec'
  const direction = key === 'ArrowRight' || key === 'ArrowUp' || key === 'PageUp' ? 1
    : key === 'ArrowLeft' || key === 'ArrowDown' || key === 'PageDown' ? -1
      : 0
  const step = key === 'PageUp' || key === 'PageDown' ? fadeKeyboardLargeStepSec : fadeKeyboardStepSec
  const next = key === 'Home' ? 0
    : key === 'End' ? duration
      : direction === 0 ? null
        : clamp(baseline[field] + direction * step, 0, duration)
  return next === null
    ? null
    : normalizeClipFades({ ...baseline, [field]: next }, duration, side)
}

export const clipFadeControlValueText = (
  fades: NormalizedClipFades,
  mode: FadeInteractionMode,
): string => {
  if (mode === 'curve') return ''
  const value = mode === 'fadeInStart'
    ? fades.fadeInStartSec
    : mode === 'fadeInEnd'
      ? fades.fadeInSec
      : mode === 'fadeOutStart'
        ? fades.fadeOutSec
        : fades.fadeOutEndSec
  return `${value.toFixed(2)} seconds`
}

export const curveFadeControlValueText = (point: FadePoint): string => (
  `Curve position ${(point.x * 100).toFixed(0)}%, gain ${(point.y * 100).toFixed(0)}%`
)

export const pointerPositionInFadeOverlay = (
  snapshot: { left: number; top: number },
  pointer: { clientX: number; clientY: number },
) => ({
  x: pointer.clientX - snapshot.left,
  y: pointer.clientY - snapshot.top,
})
