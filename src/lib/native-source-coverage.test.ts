import { expect, test } from 'bun:test'
import { nativeMappedSourceCoverage } from './native-source-coverage'

test('hydrates both interpolation neighbors and clamps the final source frame', () => {
  expect(nativeMappedSourceCoverage(1.25, 2, 5)).toEqual({
    startFrame: 1,
    frameCount: 3,
  })
  expect(nativeMappedSourceCoverage(4.25, 1, 5)).toEqual({
    startFrame: 4,
    frameCount: 1,
  })
})

test('keeps zero-length coverage at the source edge', () => {
  expect(nativeMappedSourceCoverage(5, 0, 5)).toEqual({
    startFrame: 5,
    frameCount: 0,
  })
  expect(nativeMappedSourceCoverage(6, 0, 5)).toBeUndefined()
})
