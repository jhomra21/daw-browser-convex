import { describe, expect, test } from 'bun:test'
import { createLiveWorkletBudget } from './live-worklet-budget'

describe('live worklet budget', () => {
  test('accepts exactly 64 worklets across track and master owners, then rejects a 65th', () => {
    const budget = createLiveWorkletBudget()
    budget.reserve('track:drums', 40)
    budget.reserve('master', 24)

    expect(budget.reservedCount()).toBe(64)
    expect(() => budget.reserve('track:bass', 1)).toThrow('64 static worklets')
  })

  test('replaces an owner reservation instead of accumulating its old count', () => {
    const budget = createLiveWorkletBudget(4)
    budget.reserve('track:drums', 3)
    budget.reserve('track:drums', 1)
    budget.reserve('master', 3)

    expect(budget.reservedCount()).toBe(4)
  })

  test('makes sequential reservations contend synchronously', () => {
    const budget = createLiveWorkletBudget(2)
    budget.reserve('master', 1)

    expect(() => budget.reserve('track:drums', 2)).toThrow('2 static worklets')
    budget.reserve('track:drums', 1)
    expect(budget.reservedCount()).toBe(2)
  })

  test('rolls back a failed reservation without overwriting a newer one', () => {
    const budget = createLiveWorkletBudget(4)
    budget.reserve('track:drums', 1)
    const failed = budget.reserve('track:drums', 3)
    budget.reserve('track:drums', 2)

    budget.rollback(failed)

    expect(budget.reservedCount()).toBe(2)
  })

  test('releases track capacity for empty, disposed, and cleared chains', () => {
    const budget = createLiveWorkletBudget(3)
    budget.reserve('track:empty', 0)
    budget.reserve('track:dispose', 1)
    budget.reserve('track:clear', 2)
    budget.releaseOwner('track:empty')
    budget.releaseOwner('track:dispose')
    budget.releaseOwner('track:clear')

    expect(budget.reservedCount()).toBe(0)
  })

  test('releases master capacity for empty and closed chains', () => {
    const budget = createLiveWorkletBudget(2)
    budget.reserve('master', 2)
    budget.releaseOwner('master')
    budget.reserve('master', 0)
    budget.releaseOwner('master')

    expect(budget.reservedCount()).toBe(0)
  })

  test('rejects either owner when the other consumed remaining capacity', () => {
    const masterFirst = createLiveWorkletBudget(2)
    masterFirst.reserve('master', 2)
    expect(() => masterFirst.reserve('track:drums', 1)).toThrow('2 static worklets')

    const trackFirst = createLiveWorkletBudget(2)
    trackFirst.reserve('track:drums', 2)
    expect(() => trackFirst.reserve('master', 1)).toThrow('2 static worklets')
  })

  test('releases failed pending creation and processor-fault capacity', () => {
    const budget = createLiveWorkletBudget(2)
    const failed = budget.reserve('track:pending', 2)
    budget.rollback(failed)
    budget.reserve('track:faulted', 2)
    budget.releaseOwner('track:faulted')

    expect(budget.reservedCount()).toBe(0)
  })
})
