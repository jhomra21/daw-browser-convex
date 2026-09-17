import { createRoot, createSignal, indexArray } from 'solid-js'
import { describe, expect, test } from 'bun:test'

describe('TimelineRuler indexed marker slots', () => {
  test('keeps slots stable while zoom changes primitive marker values', () => {
    createRoot((dispose) => {
      const [indices, setIndices] = createSignal([0, 1, 2])
      let mappedCount = 0
      const slots = indexArray(indices, (index) => {
        mappedCount += 1
        return { index }
      })

      const initial = slots()
      setIndices([1, 2, 3, 4])
      const expanded = slots()
      setIndices([2, 3])
      const shortened = slots()

      expect(mappedCount).toBe(4)
      expect(expanded[0]).toBe(initial[0])
      expect(expanded[2]).toBe(initial[2])
      expect(shortened[0]).toBe(initial[0])
      expect(shortened[1]).toBe(initial[1])
      dispose()
    })
  })
})
