import {
  completeDesktopAudioRecovery,
  createDesktopAudioLifecycleReconciler,
  isNativeRecordingLifecycleEligible,
  shouldCancelRecordingForLifecycle,
} from "../../src/lib/desktop-audio-lifecycle"
import type { DesktopAudioLifecycle, DesktopBridge } from "../../src/types/desktop-bridge"
import { expect, test } from "bun:test"

type LifecycleBridge = Pick<
  NonNullable<DesktopBridge["audioHost"]>,
  "getLifecycle" | "onLifecycle"
>

const bridgeFixture = (snapshot: DesktopAudioLifecycle) => {
  let listener: ((lifecycle: DesktopAudioLifecycle) => void) | undefined
  const calls: string[] = []
  const bridge: LifecycleBridge = {
    onLifecycle: (next) => {
      calls.push("subscribe")
      listener = next
      return () => {
        calls.push("unsubscribe")
        listener = undefined
      }
    },
    getLifecycle: async () => {
      calls.push("query")
      return snapshot
    },
  }
  return {
    bridge,
    calls,
    emit: (lifecycle: DesktopAudioLifecycle) => listener?.(lifecycle),
  }
}

test("subscribes before reconciling a mount snapshot while suspended", async () => {
  const fixture = bridgeFixture({ state: "suspended", powerGeneration: 7 })
  const received: DesktopAudioLifecycle[] = []
  const remove = createDesktopAudioLifecycleReconciler(fixture.bridge, (lifecycle) => {
    received.push(lifecycle)
  })

  await Promise.resolve()
  expect(fixture.calls).toEqual(["subscribe", "query"])
  expect(received).toEqual([{ state: "suspended", powerGeneration: 7 }])
  remove()
})

test("ignores stale and duplicate lifecycle records", async () => {
  const fixture = bridgeFixture({ state: "ready", powerGeneration: 4 })
  const received: DesktopAudioLifecycle[] = []
  createDesktopAudioLifecycleReconciler(fixture.bridge, (lifecycle) => {
    received.push(lifecycle)
  })
  await Promise.resolve()
  fixture.emit({ state: "suspended", powerGeneration: 3 })
  fixture.emit({ state: "ready", powerGeneration: 4 })
  fixture.emit({ state: "recovering", powerGeneration: 4 })
  fixture.emit({ state: "recovering", powerGeneration: 5 })
  fixture.emit({ state: "recovering", powerGeneration: 5 })
  fixture.emit({ state: "failed", powerGeneration: 5 })
  fixture.emit({ state: "recovering", powerGeneration: 6 })

  expect(received).toEqual([
    { state: "ready", powerGeneration: 4 },
    { state: "recovering", powerGeneration: 5 },
    { state: "failed", powerGeneration: 5 },
    { state: "recovering", powerGeneration: 6 },
  ])
})

test("requires the matching recovery acknowledgement before becoming ready", () => {
  const recovering = { state: "recovering" as const, powerGeneration: 12 }
  expect(completeDesktopAudioRecovery(recovering, 11, "ready")).toEqual({
    accepted: false,
    lifecycle: recovering,
  })
  expect(completeDesktopAudioRecovery(recovering, 12, "ready")).toEqual({
    accepted: true,
    lifecycle: { state: "ready", powerGeneration: 12 },
  })
  expect(completeDesktopAudioRecovery(
    { state: "ready", powerGeneration: 12 },
    12,
    "ready",
  )).toEqual({
    accepted: false,
    lifecycle: { state: "ready", powerGeneration: 12 },
  })
})

test("supports explicit retry on a new generation after failure", () => {
  const failed = { state: "failed" as const, powerGeneration: 12 }
  const retry = { state: "recovering" as const, powerGeneration: 13 }
  expect(failed.powerGeneration).toBeLessThan(retry.powerGeneration)
  expect(completeDesktopAudioRecovery(retry, 13, "ready")).toEqual({
    accepted: true,
    lifecycle: { state: "ready", powerGeneration: 13 },
  })
})

test("only native recording is interrupted by recovering or failed lifecycle states", () => {
  expect(isNativeRecordingLifecycleEligible("recovering", true)).toBe(false)
  expect(isNativeRecordingLifecycleEligible("failed", true)).toBe(false)
  expect(isNativeRecordingLifecycleEligible("ready", true)).toBe(true)
  expect(isNativeRecordingLifecycleEligible("ready", false)).toBe(false)
  expect(shouldCancelRecordingForLifecycle("recovering", false)).toBe(false)
  expect(shouldCancelRecordingForLifecycle("failed", false)).toBe(false)
  expect(shouldCancelRecordingForLifecycle("recovering", true)).toBe(true)
  expect(shouldCancelRecordingForLifecycle("failed", true)).toBe(true)
  expect(shouldCancelRecordingForLifecycle("ready", true)).toBe(false)
  expect(shouldCancelRecordingForLifecycle("suspended", false)).toBe(true)
  expect(shouldCancelRecordingForLifecycle("suspended", true)).toBe(true)
})
