import { expect, test } from 'bun:test'
import { createMidiTimestampConverter } from './audio-clock'

test('maps Web MIDI timestamps from the output timestamp timeline', () => {
  const convert = createMidiTimestampConverter({
    context: () => ({
      currentTime: 5,
      state: 'running',
      getOutputTimestamp: () => ({ contextTime: 4, performanceTime: 1_000 }),
    }),
    performanceNow: () => 0,
    contextTimeToTimeline: (time) => time + 10,
  })
  expect(convert(1_250)).toEqual({
    contextTime: 4.25,
    timelineTime: 14.25,
    scheduledContextTime: 5,
  })
})

test('falls back to the captured performance and context pair', () => {
  const convert = createMidiTimestampConverter({
    context: () => ({ currentTime: 3, state: 'running' }),
    performanceNow: () => 1_000,
    contextTimeToTimeline: (time) => time,
  })
  expect(convert(1_500)).toEqual({
    contextTime: 3.5,
    timelineTime: 3.5,
    scheduledContextTime: 3.5,
  })
})

test('uses the frozen audio clock when audio is closed', () => {
  const convert = createMidiTimestampConverter({
    context: () => ({ currentTime: 3, state: 'closed' }),
    performanceNow: () => 1_000,
    contextTimeToTimeline: (time) => time,
  })
  expect(convert(1_000)).toEqual({
    contextTime: 3,
    timelineTime: 3,
    scheduledContextTime: 3,
  })
})

test('does not extrapolate timestamps while audio is suspended', () => {
  let state: AudioContextState = 'running'
  let currentTime = 1
  let performanceNow = 1_000
  const convert = createMidiTimestampConverter({
    context: () => ({ currentTime, state }),
    performanceNow: () => performanceNow,
    contextTimeToTimeline: (time) => time,
  })
  expect(convert(1_500)?.contextTime).toBe(1.5)
  state = 'suspended'
  currentTime = 3
  performanceNow = 9_000
  expect(convert(12_000)).toEqual({
    contextTime: 3,
    timelineTime: 3,
    scheduledContextTime: 3,
  })
  state = 'running'
  expect(convert(9_250)?.contextTime).toBe(3.25)
})

test('resets fallback anchors before converting events for a replacement context', () => {
  let currentTime = 3
  let performanceNow = 1_000
  const convert = createMidiTimestampConverter({
    context: () => ({ currentTime, state: 'running' }),
    performanceNow: () => performanceNow,
    contextTimeToTimeline: (time) => time,
  })
  expect(convert(1_500)?.contextTime).toBe(3.5)

  currentTime = 40
  performanceNow = 9_000
  convert.reset()

  expect(convert(9_250)?.contextTime).toBe(40.25)
})
