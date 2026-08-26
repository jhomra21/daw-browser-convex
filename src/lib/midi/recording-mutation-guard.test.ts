import { expect, test } from 'bun:test'

import { runTimelineMutationAfterRecordingSettlement } from './recording-mutation-guard'

test('settles recording before a range mutation and aborts when settlement fails', async () => {
  const events: string[] = []
  let recording = true
  await expect(runTimelineMutationAfterRecordingSettlement({
    isRecording: () => recording,
    stopRecording: async () => {
      events.push('settle')
      recording = false
    },
    provisionalClipId: () => null,
    mutate: async () => { events.push('range-delete') },
  })).resolves.toBe(true)
  expect(events).toEqual(['settle', 'range-delete'])

  recording = true
  await expect(runTimelineMutationAfterRecordingSettlement({
    isRecording: () => recording,
    stopRecording: async () => { events.push('failed-settle') },
    provisionalClipId: () => null,
    mutate: async () => { events.push('should-not-delete') },
  })).resolves.toBe(false)
  expect(events).toEqual(['settle', 'range-delete', 'failed-settle'])
})

test('protects provisional clips from timeline mutations until finalization clears the protection', async () => {
  let provisionalClipId: string | null = 'provisional-midi-clip'
  let mutations = 0
  await expect(runTimelineMutationAfterRecordingSettlement({
    isRecording: () => false,
    stopRecording: async () => {},
    provisionalClipId: () => provisionalClipId,
    mutate: async () => { mutations += 1 },
  })).resolves.toBe(false)
  expect(mutations).toBe(0)

  provisionalClipId = null
  await expect(runTimelineMutationAfterRecordingSettlement({
    isRecording: () => false,
    stopRecording: async () => {},
    provisionalClipId: () => provisionalClipId,
    mutate: async () => { mutations += 1 },
  })).resolves.toBe(true)
  expect(mutations).toBe(1)
})
