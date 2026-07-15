export type ClipFades = {
  fadeInStartSec?: number
  fadeInSec: number
  fadeOutSec: number
  fadeOutEndSec?: number
  fadeInCurve: number
  fadeOutCurve: number
  fadeInCurvePosition?: number
  fadeOutCurvePosition?: number
}

export type ClipFadeSide = 'fadeIn' | 'fadeOut'
export type NormalizedClipFades = Required<ClipFades>

const finite = (value: number | undefined, fallback = 0) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
)

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.min(maximum, Math.max(minimum, value))
)

export const normalizeClipFades = (
  fades: Partial<ClipFades> | undefined,
  duration: number,
  editedSide?: ClipFadeSide,
): NormalizedClipFades => {
  const maxDuration = Math.max(0, finite(duration))
  let fadeInStartSec = clamp(finite(fades?.fadeInStartSec), 0, maxDuration)
  let fadeInSec = clamp(finite(fades?.fadeInSec), fadeInStartSec, maxDuration)
  let fadeOutEndSec = clamp(finite(fades?.fadeOutEndSec), 0, maxDuration)
  let fadeOutSec = clamp(finite(fades?.fadeOutSec), fadeOutEndSec, maxDuration)
  if (fadeInSec + fadeOutSec > maxDuration) {
    if (editedSide === 'fadeIn') {
      fadeInSec = Math.max(0, maxDuration - fadeOutSec)
      fadeInStartSec = Math.min(fadeInStartSec, fadeInSec)
    } else if (editedSide === 'fadeOut') {
      fadeOutSec = Math.max(0, maxDuration - fadeInSec)
      fadeOutEndSec = Math.min(fadeOutEndSec, fadeOutSec)
    } else {
      fadeOutSec = Math.max(0, maxDuration - fadeInSec)
      fadeOutEndSec = Math.min(fadeOutEndSec, fadeOutSec)
    }
  }
  return {
    fadeInStartSec,
    fadeInSec,
    fadeOutSec,
    fadeOutEndSec,
    fadeInCurve: clamp(finite(fades?.fadeInCurve), -1, 1),
    fadeOutCurve: clamp(finite(fades?.fadeOutCurve), -1, 1),
    fadeInCurvePosition: clamp(finite(fades?.fadeInCurvePosition, 0.5), 0, 1),
    fadeOutCurvePosition: clamp(finite(fades?.fadeOutCurvePosition, 0.5), 0, 1),
  }
}

export const clipFadesEqual = (
  left: Partial<ClipFades> | undefined,
  right: Partial<ClipFades> | undefined,
  duration: number,
) => {
  const normalizedLeft = normalizeClipFades(left, duration)
  const normalizedRight = normalizeClipFades(right, duration)
  return normalizedLeft.fadeInStartSec === normalizedRight.fadeInStartSec
    && normalizedLeft.fadeInSec === normalizedRight.fadeInSec
    && normalizedLeft.fadeOutSec === normalizedRight.fadeOutSec
    && normalizedLeft.fadeOutEndSec === normalizedRight.fadeOutEndSec
    && normalizedLeft.fadeInCurve === normalizedRight.fadeInCurve
    && normalizedLeft.fadeOutCurve === normalizedRight.fadeOutCurve
    && normalizedLeft.fadeInCurvePosition === normalizedRight.fadeInCurvePosition
    && normalizedLeft.fadeOutCurvePosition === normalizedRight.fadeOutCurvePosition
}

export type FadePoint = { x: number; y: number }

const quadraticPoint = (start: FadePoint, control: FadePoint, end: FadePoint, t: number): FadePoint => {
  const inverse = 1 - t
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  }
}

export const getClipFadeBezierControlPoint = (
  fades: Partial<ClipFades> | undefined,
  duration: number,
  side: ClipFadeSide,
): FadePoint => {
  const normalized = normalizeClipFades(fades, duration)
  return getNormalizedClipFadeBezierControlPoint(normalized, duration, side)
}

export const getNormalizedClipFadeBezierControlPoint = (
  normalized: NormalizedClipFades,
  duration: number,
  side: ClipFadeSide,
): FadePoint => {
  const fadeStart = side === 'fadeIn'
    ? normalized.fadeInStartSec
    : Math.max(0, finite(duration)) - normalized.fadeOutSec
  const fadeEnd = side === 'fadeIn'
    ? normalized.fadeInSec
    : Math.max(0, finite(duration)) - normalized.fadeOutEndSec
  const startGain = side === 'fadeIn' ? 0 : 1
  const endGain = side === 'fadeIn' ? 1 : 0
  const position = side === 'fadeIn'
    ? normalized.fadeInCurvePosition
    : normalized.fadeOutCurvePosition
  const curve = side === 'fadeIn' ? normalized.fadeInCurve : normalized.fadeOutCurve
  const linearGain = startGain + (endGain - startGain) * position
  const gain = curve >= 0
    ? linearGain + (1 - linearGain) * curve
    : linearGain + linearGain * curve
  return {
    x: fadeStart + (fadeEnd - fadeStart) * position,
    y: clamp(gain, 0, 1),
  }
}

const fadeGainForSideAtClipTime = (
  normalized: NormalizedClipFades,
  duration: number,
  time: number,
  side: ClipFadeSide,
) => {
  const start = side === 'fadeIn'
    ? normalized.fadeInStartSec
    : duration - normalized.fadeOutSec
  const end = side === 'fadeIn'
    ? normalized.fadeInSec
    : duration - normalized.fadeOutEndSec
  const startGain = side === 'fadeIn' ? 0 : 1
  const endGain = side === 'fadeIn' ? 1 : 0
  if (end <= start) {
    if (side === 'fadeIn') return time < end ? 0 : 1
    return time < start ? 1 : 0
  }
  if (time <= start) return startGain
  if (time >= end) return endGain
  const curve = side === 'fadeIn' ? normalized.fadeInCurve : normalized.fadeOutCurve
  if (curve === 0) return startGain + (endGain - startGain) * ((time - start) / (end - start))
  const control = getNormalizedClipFadeBezierControlPoint(normalized, duration, side)
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const mid = (low + high) / 2
    if (quadraticPoint({ x: start, y: startGain }, control, { x: end, y: endGain }, mid).x < time) low = mid
    else high = mid
  }
  return quadraticPoint({ x: start, y: startGain }, control, { x: end, y: endGain }, (low + high) / 2).y
}

export const fadeGainAtClipTime = (
  fades: Partial<ClipFades> | undefined,
  duration: number,
  clipTimeSec: number,
) => {
  const normalized = normalizeClipFades(fades, duration)
  return normalizedFadeGainAtClipTime(normalized, duration, clipTimeSec)
}

export const normalizedFadeGainAtClipTime = (
  normalized: NormalizedClipFades,
  duration: number,
  clipTimeSec: number,
) => {
  const normalizedDuration = Math.max(0, finite(duration))
  const time = clamp(finite(clipTimeSec), 0, normalizedDuration)
  return fadeGainForSideAtClipTime(normalized, normalizedDuration, time, 'fadeIn')
    * fadeGainForSideAtClipTime(normalized, normalizedDuration, time, 'fadeOut')
}

export const transformClipFadesForDuration = (
  fades: Partial<ClipFades> | undefined,
  previousDuration: number,
  nextDuration: number,
  leftTrimSec = 0,
): ClipFades => {
  const normalized = normalizeClipFades(fades, previousDuration)
  return normalizeClipFades({
    ...normalized,
    fadeInStartSec: Math.max(0, normalized.fadeInStartSec - Math.max(0, finite(leftTrimSec))),
    fadeInSec: Math.max(0, normalized.fadeInSec - Math.max(0, finite(leftTrimSec))),
  }, nextDuration)
}

export const clipFadesForFragment = (
  fades: Partial<ClipFades> | undefined,
  sourceDuration: number,
  fragmentDuration: number,
  startsInsideSource: boolean,
  endsInsideSource: boolean,
): ClipFades => {
  const normalized = normalizeClipFades(fades, sourceDuration)
  return normalizeClipFades({
    ...normalized,
    fadeInStartSec: startsInsideSource ? 0 : normalized.fadeInStartSec,
    fadeInSec: startsInsideSource ? 0 : normalized.fadeInSec,
    fadeOutSec: endsInsideSource ? 0 : normalized.fadeOutSec,
    fadeOutEndSec: endsInsideSource ? 0 : normalized.fadeOutEndSec,
  }, fragmentDuration)
}
