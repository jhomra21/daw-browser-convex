import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'bun:test'

import { collectTimelineMarkerIndices } from './TimelineRuler'
import { musicalBarLabelAtTime } from '~/lib/timeline-view'

describe('TimelineRuler marker slots', () => {
  test('uses primitive Index slots so zoom updates retain marker DOM identity', async () => {
    const source = await readFile(new URL('./TimelineRuler.tsx', import.meta.url), 'utf8')

    expect(source).toContain('<Index each={minorMarkerIndices()}>')
    expect(source).toContain('<Index each={majorMarkerIndices()}>')
    expect(source).not.toContain('type Marker =')
    expect(source).not.toContain('<For each={minorMarkers()}>')
    expect(source).not.toContain('<For each={majorMarkers()}>')
  })

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

  test('derives positions and labels from the current slot interval', () => {
    const timeToX = (timeSec: number) => timeSec * 100
    const indices = collectTimelineMarkerIndices(0, 4, 2, 450, timeToX)
    const positions = indices.map(index => timeToX(index * 2))
    const labels = indices.map(index => musicalBarLabelAtTime(index * 2, 120))

    expect(indices).toEqual([0, 1, 2])
    expect(positions).toEqual([0, 200, 400])
    expect(labels).toEqual([1, 2, 3])
  })
})
