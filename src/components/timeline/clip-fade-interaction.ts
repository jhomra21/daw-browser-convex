import { normalizeClipFades, type ClipFadeSide, type NormalizedClipFades } from '@daw-browser/timeline-core/clip-fades'

export type FadeInteractionMode = 'fadeInStart' | 'fadeInEnd' | 'fadeOutStart' | 'fadeOutEnd' | 'curve'

type FadeInteractionStart = {
  canEdit: boolean
  isMidi: boolean
  button: number
  mode: FadeInteractionMode
  overlayWidth: number
  overlayHeight: number
}

type FadeDraftUpdate = {
  baseline: NormalizedClipFades
  side: ClipFadeSide
  mode: FadeInteractionMode
  duration: number
  overlayWidth: number
  overlayHeight: number
  currentX: number
  currentY: number
}

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
  && Number.isFinite(start.overlayWidth)
  && start.overlayWidth > 0
  && Number.isFinite(start.overlayHeight)
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
