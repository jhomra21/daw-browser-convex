import { expect, test } from "bun:test"

import { shouldUseNativeLiveMidi } from "~/lib/midi/live-midi-backend"
import { createAuditionReleaseTimerOwnership } from "~/lib/audition-release-timer-ownership"

const nativeLiveMidi = (active: boolean, available: boolean) => ({
  isActive: () => active,
  isAvailable: () => available,
  start: () => undefined,
  stop: () => undefined,
})

test("keeps native live MIDI selected while native startup is pending", () => {
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(false, false))).toBeFalse()
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(false, true))).toBeTrue()
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(true, false))).toBeTrue()
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(true, true))).toBeTrue()
})

test("keeps browser live MIDI as the fallback when native is unavailable", () => {
  expect(shouldUseNativeLiveMidi(nativeLiveMidi(false, false))).toBeFalse()
  expect(shouldUseNativeLiveMidi(undefined)).toBeFalse()
})

test("owns audition release timers by pitch when source IDs collide", () => {
  const callbacks = new Map<number, () => void>()
  const cleared: number[] = []
  let nextTimer = 1

  const ownership = createAuditionReleaseTimerOwnership({
    schedule: (callback) => {
      const timer = nextTimer
      nextTimer += 1
      callbacks.set(timer, callback)

      return timer
    },
    clear: (timer) => {
      cleared.push(timer)
      callbacks.delete(timer)
    },
  })

  const releases: string[] = []
  const firstArpeggiator = { noteOff: (handle: number) => releases.push(`first:${handle}`) }
  const secondArpeggiator = { noteOff: (handle: number) => releases.push(`second:${handle}`) }
  ownership.schedule(60, 100, () => firstArpeggiator.noteOff(1))
  ownership.schedule(64, 200, () => secondArpeggiator.noteOff(1))

  callbacks.get(1)?.()
  expect(releases).toEqual(["first:1"])
  expect(ownership.has(60)).toBeFalse()
  expect(ownership.has(64)).toBeTrue()

  callbacks.get(2)?.()
  expect(releases).toEqual(["first:1", "second:1"])
  expect(ownership.size()).toBe(0)
  expect(cleared).toEqual([])
})

test("replacing an audition pitch cancels its prior bounded release", () => {
  const callbacks = new Map<number, () => void>()
  const cleared: number[] = []
  let nextTimer = 1

  const ownership = createAuditionReleaseTimerOwnership({
    schedule: (callback) => {
      const timer = nextTimer
      nextTimer += 1
      callbacks.set(timer, callback)

      return timer
    },
    clear: (timer) => {
      cleared.push(timer)
      callbacks.delete(timer)
    },
  })

  const releases: string[] = []
  ownership.schedule(60, 100, () => releases.push("first"))
  ownership.cancel(60)
  ownership.schedule(60, 100, () => releases.push("second"))
  callbacks.get(1)?.()
  expect(releases).toEqual([])
  callbacks.get(2)?.()
  expect(releases).toEqual(["second"])
  expect(cleared).toEqual([1])
  expect(ownership.size()).toBe(0)
})
