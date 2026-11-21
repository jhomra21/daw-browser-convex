
import { describe, expect, test } from 'bun:test'
import { collectTimelineMarkerIndices } from './TimelineRuler'

describe('TimelineRuler marker slots', () => {
  test('updates primitive marker slots when interval and visible length change', () => {
    const timeToX = (timeSec: number) => timeSec * 10
    const initial = collectTimelineMarkerIndices(0, 10, 1, 25, timeToX)
    const zoomed = collectTimelineMarkerIndices(0, 20, 0.5, 25, timeToX)
    const shortened = collectTimelineMarkerIndices(0, 4, 1, 25, timeToX)

    expect(initial).toEqual([0, 1, 2])
    expect(zoomed).toEqual([0, 1, 2, 3, 4, 5])
    expect(shortened).toEqual([0, 1, 2])
    expect(initial.every(index => Number.isInteger(index))).toBe(true)
  })

  test('stops collecting markers past the viewport width', () => {
    const timeToX = (timeSec: number) => timeSec * 100

    expect(collectTimelineMarkerIndices(0, 4, 2, 450, timeToX)).toEqual([0, 1, 2])
    expect(collectTimelineMarkerIndices(0, 4, 2, 350, timeToX)).toEqual([0, 1])
  })
})
