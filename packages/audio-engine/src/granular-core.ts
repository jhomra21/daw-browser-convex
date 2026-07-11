import type { GranularWindowShape } from '@daw-browser/shared'

export const createGranularPrng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export function granularWindow(shape: GranularWindowShape, phase: number): number {
  const x = Math.max(0, Math.min(1, phase))
  if (shape === 'tukey') {
    if (x < 0.25) return 0.5 * (1 - Math.cos(4 * Math.PI * x))
    if (x > 0.75) return 0.5 * (1 - Math.cos(4 * Math.PI * (1 - x)))
    return 1
  }
  if (shape === 'gaussian') {
    const normalized = (x - 0.5) / 0.18
    return Math.exp(-0.5 * normalized * normalized)
  }
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * x)
}

export const granularWindowEnergy = (shape: GranularWindowShape, frames = 4096) => {
  let energy = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const value = granularWindow(shape, frame / Math.max(1, frames - 1))
    energy += value * value
  }
  return energy / frames
}

export function createGranularSchedule(input: { durationSec: number; densityHz: number; seed: number }) {
  const count = Math.max(0, Math.floor(input.durationSec * input.densityHz))
  const interval = 1 / input.densityHz
  const random = createGranularPrng(input.seed)
  return Array.from({ length: count }, (_, index) => ({
    timeSec: index * interval,
    random: random(),
  }))
}
