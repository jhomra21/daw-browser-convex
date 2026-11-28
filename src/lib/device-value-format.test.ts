import { expect, test } from 'bun:test'
import { formatDeviceLatency } from '~/lib/device-value-format'

test('the latency label uses the real sample rate', () => {
  expect(formatDeviceLatency(2048, 48000)).toBe('42.7 ms @ 48 kHz')
  expect(formatDeviceLatency(2048, 44100)).toBe('46.4 ms @ 44.1 kHz')
  expect(formatDeviceLatency(2048, 96000)).toBe('21.3 ms @ 96 kHz')
  expect(formatDeviceLatency(4096, 88200)).toBe('46.4 ms @ 88.2 kHz')
})

test('the same frames last the time the rate says, not the time at 48 kHz', () => {
  for (const rate of [44100, 48000, 96000]) {
    expect(Number.parseFloat(formatDeviceLatency(1024, rate))).toBeCloseTo(1024 / rate * 1000, 1)
  }
})

test('without an engine rate the label is the frame count', () => {
  expect(formatDeviceLatency(2048, null)).toBe('2048 samples')
})
