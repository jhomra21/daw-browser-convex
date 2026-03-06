export type SynthCardBounds = {
  x: number
  y: number
  w: number
  h: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function clampSynthCardBounds(
  bounds: SynthCardBounds,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
): SynthCardBounds {
  const minW = Math.max(360, Math.min(640, viewportWidth - 40))
  const minH = Math.max(320, Math.min(420, viewportHeight - 80))
  const maxW = Math.max(minW, viewportWidth - 12)
  const maxH = Math.max(minH, viewportHeight - 24)
  const w = clamp(bounds.w, minW, maxW)
  const h = clamp(bounds.h, minH, maxH)
  const maxX = Math.max(0, viewportWidth - w)
  const maxY = Math.max(0, viewportHeight - h)

  return {
    x: clamp(bounds.x, 0, maxX),
    y: clamp(bounds.y, 0, maxY),
    w,
    h,
  }
}

export function createInitialSynthCardBounds(
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
): SynthCardBounds {
  const initialW = Math.min(640, viewportWidth - 40)
  const initialH = Math.min(420, viewportHeight - 80)

  return clampSynthCardBounds(
    {
      x: Math.round((viewportWidth - initialW) / 2),
      y: Math.round((viewportHeight - initialH) / 3),
      w: initialW,
      h: initialH,
    },
    viewportWidth,
    viewportHeight,
  )
}
