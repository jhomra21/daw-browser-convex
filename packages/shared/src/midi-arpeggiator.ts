import type { ArpeggiatorParams } from './effects-params'

const createSeededRandom = (seed: number) => {
  let state = (seed >>> 0) || 1
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export const arpeggiatorStepBeats = (rate: ArpeggiatorParams['rate']) => (
  rate === '1/4' ? 1 : rate === '1/8' ? 0.5 : rate === '1/32' ? 0.125 : 0.25
)

export const arpeggiatorParamsEqual = (
  left: ArpeggiatorParams | undefined,
  right: ArpeggiatorParams | undefined,
) => (
  left === right
  || (
    left !== undefined
    && right !== undefined
    && left.enabled === right.enabled
    && left.pattern === right.pattern
    && left.rate === right.rate
    && left.octaves === right.octaves
    && left.gate === right.gate
    && left.hold === right.hold
  )
)

export const arpeggiatorSequence = (
  pitches: readonly number[],
  params: Pick<ArpeggiatorParams, 'pattern' | 'octaves'>,
  seedBeat = 0,
) => {
  const basePitches = [...pitches].sort((left, right) => left - right)
  const expandedPitches: number[] = []
  const octaves = Math.max(1, Math.floor(params.octaves || 1))
  for (let octave = 0; octave < octaves; octave += 1) {
    for (const pitch of basePitches) expandedPitches.push(pitch + octave * 12)
  }
  if (expandedPitches.length === 0) return []

  if (params.pattern === 'up') return expandedPitches
  if (params.pattern === 'down') return expandedPitches.toReversed()
  if (params.pattern === 'updown') {
    return [...expandedPitches, ...expandedPitches.slice(0, -1).toReversed()]
  }

  const sequence = expandedPitches.slice()
  if (sequence.length > 1) {
    const signature = basePitches.reduce((acc, pitch, index) => {
      const mixed = (acc ^ ((pitch + index * 131) >>> 0)) >>> 0
      return ((mixed << 5) - mixed) >>> 0
    }, Math.floor(seedBeat * 10_000) >>> 0)
    const random = createSeededRandom(signature || 1)
    for (let index = sequence.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1))
      const current = sequence[index]
      const next = sequence[swapIndex]
      if (current === undefined || next === undefined) continue
      sequence[index] = next
      sequence[swapIndex] = current
    }
  }
  return sequence
}
