import { expect, test } from 'bun:test'

import { recordingStorageLimitExceeded } from './recording-temp-storage'

const oldFourGiBCeiling = 4 * 1024 * 1024 * 1024

test('does not impose the former four GiB recording ceiling by default', () => {
  expect(recordingStorageLimitExceeded(oldFourGiBCeiling, 16_388)).toBe(false)
  expect(recordingStorageLimitExceeded(oldFourGiBCeiling * 128, 16_388)).toBe(false)
})

test('retains an explicit injectable storage bound for failure tests', () => {
  expect(recordingStorageLimitExceeded(oldFourGiBCeiling - 1, 1, oldFourGiBCeiling)).toBe(false)
  expect(recordingStorageLimitExceeded(oldFourGiBCeiling, 1, oldFourGiBCeiling)).toBe(true)
})
