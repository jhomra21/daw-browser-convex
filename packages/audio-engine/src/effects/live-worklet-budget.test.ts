import { describe, expect, test } from 'bun:test'
import { createLiveWorkletBudget } from './live-worklet-budget'

describe('live worklet budget', () => {
  test('accepts exactly 64 worklets across track and master owners, then rejects a 65th', () => {
    const budget = createLiveWorkletBudget()
    const track = budget.begin('track:drums', 40)
    const master = budget.begin('master', 24)

    expect(budget.reservedCount()).toBe(64)
    expect(() => budget.begin('track:bass', 1)).toThrow('64 static worklets')
    expect(budget.commit(track, 40)).toBe(true)
    expect(budget.commit(master, 24)).toBe(true)
  })

  test('counts committed ownership and multiple pending revisions together', () => {
    const budget = createLiveWorkletBudget(4)
    const committed = budget.begin('track:drums', 3)
    budget.commit(committed, 3)
    const first = budget.begin('track:drums', 1)

    expect(budget.reservedCount()).toBe(4)
    expect(() => budget.begin('master', 1)).toThrow('4 static worklets')
    budget.rollback(first)
  })

  test('makes sequential reservations contend synchronously', () => {
    const budget = createLiveWorkletBudget(2)
    const master = budget.begin('master', 1)
    budget.commit(master, 1)

    expect(() => budget.begin('track:drums', 2)).toThrow('2 static worklets')
    budget.begin('track:drums', 1)
    expect(budget.reservedCount()).toBe(2)
  })

  test('rolls back a failed reservation without overwriting a newer one', () => {
    const budget = createLiveWorkletBudget(4)
    const initial = budget.begin('track:drums', 1)
    budget.commit(initial, 1)
    const failed = budget.begin('track:drums', 3)
    const current = budget.begin('track:drums', 0)
    budget.commit(current, 2)

    budget.rollback(failed)

    expect(budget.reservedCount()).toBe(2)
  })

  test('releases track capacity for empty, disposed, and cleared chains', () => {
    const budget = createLiveWorkletBudget(3)
    budget.begin('track:empty', 0)
    const dispose = budget.begin('track:dispose', 1)
    const clear = budget.begin('track:clear', 2)
    budget.commit(dispose, 1)
    budget.commit(clear, 2)
    budget.releaseOwner('track:empty')
    budget.releaseOwner('track:dispose')
    budget.releaseOwner('track:clear')

    expect(budget.reservedCount()).toBe(0)
  })

  test('releases master capacity for empty and closed chains', () => {
    const budget = createLiveWorkletBudget(2)
    const master = budget.begin('master', 2)
    budget.commit(master, 2)
    budget.releaseOwner('master')
    budget.begin('master', 0)
    budget.releaseOwner('master')

    expect(budget.reservedCount()).toBe(0)
  })

  test('rejects either owner when the other consumed remaining capacity', () => {
    const masterFirst = createLiveWorkletBudget(2)
    masterFirst.begin('master', 2)
    expect(() => masterFirst.begin('track:drums', 1)).toThrow('2 static worklets')

    const trackFirst = createLiveWorkletBudget(2)
    trackFirst.begin('track:drums', 2)
    expect(() => trackFirst.begin('master', 1)).toThrow('2 static worklets')
  })

  test('releases failed pending creation and processor-fault capacity', () => {
    const budget = createLiveWorkletBudget(2)
    const failed = budget.begin('track:pending', 2)
    budget.rollback(failed)
    const faulted = budget.begin('track:faulted', 2)
    budget.commit(faulted, 2)
    budget.releaseOwner('track:faulted')

    expect(budget.reservedCount()).toBe(0)
  })

  test('allows a zero-allocation reorder at the exact committed limit', () => {
    const budget = createLiveWorkletBudget(2)
    const initial = budget.begin('track:drums', 2)
    expect(budget.commit(initial, 2)).toBe(true)

    const reorder = budget.begin('track:drums', 0)
    expect(budget.isCurrent(reorder)).toBe(true)
    expect(budget.commit(reorder, 2)).toBe(true)
    expect(budget.reservedCount()).toBe(2)
  })

  test('reserves replacement overlap and rejects construction beyond the limit', () => {
    const budget = createLiveWorkletBudget(64)
    const initial = budget.begin('master', 64)
    budget.commit(initial, 64)

    expect(() => budget.begin('master', 1)).toThrow('64 static worklets')
  })

  test('only the latest owner transaction can publish', () => {
    const budget = createLiveWorkletBudget(4)
    const first = budget.begin('track:drums', 1)
    const winner = budget.begin('track:drums', 1)

    expect(budget.isCurrent(first)).toBe(false)
    expect(budget.commit(first, 1)).toBe(false)
    expect(budget.isCurrent(winner)).toBe(true)
    expect(budget.commit(winner, 1)).toBe(true)
  })
})
