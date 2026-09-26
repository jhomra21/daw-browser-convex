import { expect, test } from 'bun:test'
import { benchmarkSabRecordingEnabled } from './benchmark-sab-recording'

test('SAB capture requires both a desktop bridge and explicit benchmark opt-in', () => {
  expect(benchmarkSabRecordingEnabled(undefined)).toBe(false)
  expect(benchmarkSabRecordingEnabled({ benchmarkSabRecording: false })).toBe(false)
  expect(benchmarkSabRecordingEnabled({ benchmarkSabRecording: true })).toBe(true)
})
