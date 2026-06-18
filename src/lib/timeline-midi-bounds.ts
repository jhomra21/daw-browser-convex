export type TimelineMidiBounds = {
  x: number
  y: number
  w: number
  h: number
}

type Point = {
  x: number
  y: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const clampTimelineMidiBounds = (
  bounds: TimelineMidiBounds,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
): TimelineMidiBounds => {
  const minW = Math.max(320, Math.min(720, viewportWidth - 40))
  const minH = Math.max(200, Math.min(360, viewportHeight - 80))
  const w = clamp(bounds.w, minW, Math.max(minW, viewportWidth))
  const h = clamp(bounds.h, minH, Math.max(minH, viewportHeight))

  return {
    x: clamp(bounds.x, 0, Math.max(0, viewportWidth - w)),
    y: clamp(bounds.y, 0, Math.max(0, viewportHeight - h)),
    w,
    h,
  }
}

export const timelineMidiBoundsEqual = (a: TimelineMidiBounds, b: TimelineMidiBounds) => (
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
)

export const createTimelineMidiBoundsDrag = (
  bounds: TimelineMidiBounds,
  pointer: Point,
) => ({
  moveTo: (nextPointer: Point) => clampTimelineMidiBounds({
    x: bounds.x + nextPointer.x - pointer.x,
    y: bounds.y + nextPointer.y - pointer.y,
    w: bounds.w,
    h: bounds.h,
  }),
  resizeTo: (nextPointer: Point) => clampTimelineMidiBounds({
    x: bounds.x,
    y: bounds.y,
    w: bounds.w + nextPointer.x - pointer.x,
    h: bounds.h + nextPointer.y - pointer.y,
  }),
})
