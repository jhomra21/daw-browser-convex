import { expect, test } from 'bun:test'
import { createSampledInstrumentRegionBudget } from './sampled-instrument-region-budget'

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1
  readonly length = 1
  readonly numberOfChannels = 1
  readonly sampleRate = 1
  copyFromChannel(): void {}
  copyToChannel(): void {}
  getChannelData(): Float32Array<ArrayBuffer> {
    return new Float32Array(1)
  }
}

test('reservations are ownership-aware and stale release cannot release a replacement', () => {
  const budget = createSampledInstrumentRegionBudget(10)
  const first = budget.reserve('region', 10)
  first.commit()
  budget.set('region', 10, () => undefined)
  budget.release('region')

  const replacement = budget.reserve('region', 10)
  first.release()
  expect(budget.reservedBytes()).toBe(10)
  replacement.release()
  expect(budget.reservedBytes()).toBe(0)
})

test('touch moves a frequently reused region behind newer entries in the LRU', () => {
  const evicted: string[] = []
  const budget = createSampledInstrumentRegionBudget(2)
  budget.set('first', 1, () => evicted.push('first'))
  budget.set('second', 1, () => evicted.push('second'))
  budget.touch('first')
  budget.set('third', 1, () => evicted.push('third'))
  expect(evicted).toEqual(['second'])
  expect(budget.keys()).toEqual(['first', 'third'])
})

test('scoped entries stay retained until the scope is released', () => {
  const budget = createSampledInstrumentRegionBudget(1)
  const scope = budget.createScope('export:job')
  scope.set('region', 1, () => undefined)
  expect(() => budget.set('other', 1, () => undefined)).toThrow('aggregate limit')
  expect(budget.keys()).toEqual(['export:job\u0000region'])
  scope.release()
  budget.set('other', 1, () => undefined)
  expect(budget.keys()).toEqual(['other'])
})

test('leases pin live physical buffers without double counting aliases', () => {
  const budget = createSampledInstrumentRegionBudget(4)
  const live = new TestAudioBuffer()
  budget.set('live', 4, () => undefined, live)
  const scope = budget.createScope('export')
  const lease = scope.lease([
    { key: 'same-region', buffer: live, bytes: 4 },
  ])
  expect(budget.totalBytes()).toBe(4)
  expect(() => budget.set('other', 4, () => undefined, new TestAudioBuffer())).toThrow('aggregate limit')
  lease.release()
  budget.set('other', 4, () => undefined, new TestAudioBuffer())
  expect(budget.totalBytes()).toBe(4)
})

test('leases account distinct physical allocations separately', () => {
  const budget = createSampledInstrumentRegionBudget(8)
  const first = new TestAudioBuffer()
  const second = new TestAudioBuffer()
  const scope = budget.createScope('export')
  const lease = scope.lease([
    { key: 'same-descriptor', buffer: first, bytes: 4 },
    { key: 'same-descriptor', buffer: second, bytes: 4 },
  ])
  expect(budget.totalBytes()).toBe(8)
  lease.release()
  expect(budget.totalBytes()).toBe(0)
})

test('live replacement remains accounted while a prepared lease pins the old buffer', () => {
  const budget = createSampledInstrumentRegionBudget(8)
  const oldBuffer = new TestAudioBuffer()
  const newBuffer = new TestAudioBuffer()
  budget.set('region', 4, () => undefined, oldBuffer)
  const scope = budget.createScope('export')
  const lease = scope.lease([{ key: 'region', buffer: oldBuffer, bytes: 4 }])
  budget.release('region')
  budget.set('region', 4, () => undefined, newBuffer)
  expect(budget.totalBytes()).toBe(8)
  lease.release()
  expect(budget.totalBytes()).toBe(4)
})

test('same-key replacement cannot exceed a cap while the old physical buffer is pinned', () => {
  const budget = createSampledInstrumentRegionBudget(4)
  const oldBuffer = new TestAudioBuffer()
  const newBuffer = new TestAudioBuffer()
  budget.set('region', 4, () => undefined, oldBuffer)
  const pin = budget.pin('region')
  expect(pin).toBeDefined()
  expect(() => budget.set('region', 4, () => undefined, newBuffer)).toThrow('aggregate limit')
  pin?.release()
  budget.set('region', 4, () => undefined, newBuffer)
  expect(budget.totalBytes()).toBe(4)
})

test('same-key nonphysical growth evicts inactive entries but rejects when capacity is pinned', () => {
  const evicted: string[] = []
  const evictable = createSampledInstrumentRegionBudget(8)
  evictable.set('region', 4, () => undefined)
  evictable.set('other', 4, () => evicted.push('other'))
  evictable.set('region', 8, () => undefined)
  expect(evictable.totalBytes()).toBe(8)
  expect(evicted).toEqual(['other'])

  const pinned = createSampledInstrumentRegionBudget(8)
  pinned.set('region', 4, () => undefined)
  pinned.set('other', 4, () => undefined)
  const pin = pinned.pin('other')
  expect(() => pinned.set('region', 8, () => undefined)).toThrow('aggregate limit')
  pin?.release()
})

test('same-key nonphysical shrink updates accounting for subsequent allocation', () => {
  const budget = createSampledInstrumentRegionBudget(8)
  budget.set('region', 8, () => undefined)
  budget.set('region', 4, () => undefined)
  expect(budget.totalBytes()).toBe(4)
  budget.set('other', 4, () => undefined)
  expect(budget.totalBytes()).toBe(8)
})

test('releases a retired same-key generation through its opaque pin', () => {
  const budget = createSampledInstrumentRegionBudget(8)
  const oldBuffer = new TestAudioBuffer()
  const newBuffer = new TestAudioBuffer()
  budget.set('region', 4, () => undefined, oldBuffer)
  const oldPin = budget.pin('region')
  const secondOldPin = budget.pin('region')
  budget.release('region')
  budget.set('region', 4, () => undefined, newBuffer)
  expect(budget.totalBytes()).toBe(8)
  oldPin?.release()
  oldPin?.release()
  expect(budget.totalBytes()).toBe(8)
  secondOldPin?.release()
  expect(budget.totalBytes()).toBe(4)
  expect(budget.keys()).toEqual(['region'])
})

test('physical charge follows maximum active owner weight through release permutations', () => {
  const liveThenExport = createSampledInstrumentRegionBudget(8)
  const liveBuffer = new TestAudioBuffer()
  const liveThenExportScope = liveThenExport.createScope('live-then-export')
  liveThenExport.set('live', 8, () => undefined, liveBuffer)
  const liveThenExportLease = liveThenExportScope.lease([{ key: 'export', buffer: liveBuffer, bytes: 4 }])
  expect(liveThenExport.totalBytes()).toBe(8)
  liveThenExport.release('live')
  expect(liveThenExport.totalBytes()).toBe(4)
  liveThenExportLease.release()
  expect(liveThenExport.totalBytes()).toBe(0)

  const exportThenLive = createSampledInstrumentRegionBudget(8)
  const exportThenLiveBuffer = new TestAudioBuffer()
  const exportThenLiveScope = exportThenLive.createScope('export-then-live')
  const exportThenLiveLease = exportThenLiveScope.lease([{ key: 'export', buffer: exportThenLiveBuffer, bytes: 4 }])
  exportThenLive.set('live', 8, () => undefined, exportThenLiveBuffer)
  expect(exportThenLive.totalBytes()).toBe(8)
  exportThenLiveLease.release()
  expect(exportThenLive.totalBytes()).toBe(8)
  exportThenLive.release('live')
  expect(exportThenLive.totalBytes()).toBe(0)

  const lowThenHigh = createSampledInstrumentRegionBudget(8)
  const lowThenHighBuffer = new TestAudioBuffer()
  const lowThenHighScope = lowThenHigh.createScope('low-then-high')
  const lowLease = lowThenHighScope.lease([{ key: 'low', buffer: lowThenHighBuffer, bytes: 4 }])
  const highLease = lowThenHighScope.lease([{ key: 'high', buffer: lowThenHighBuffer, bytes: 8 }])
  expect(lowThenHigh.totalBytes()).toBe(8)
  highLease.release()
  expect(lowThenHigh.totalBytes()).toBe(4)
  lowLease.release()
  expect(lowThenHigh.totalBytes()).toBe(0)

  const highThenLow = createSampledInstrumentRegionBudget(8)
  const highThenLowBuffer = new TestAudioBuffer()
  const highThenLowScope = highThenLow.createScope('high-then-low')
  const highFirstLease = highThenLowScope.lease([{ key: 'high', buffer: highThenLowBuffer, bytes: 8 }])
  const lowSecondLease = highThenLowScope.lease([{ key: 'low', buffer: highThenLowBuffer, bytes: 4 }])
  expect(highThenLow.totalBytes()).toBe(8)
  highFirstLease.release()
  expect(highThenLow.totalBytes()).toBe(4)
  lowSecondLease.release()
  expect(highThenLow.totalBytes()).toBe(0)
})
