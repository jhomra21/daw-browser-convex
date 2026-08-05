import type { DesktopAudioLifecycle, DesktopBridge } from "../types/desktop-bridge"

type DesktopAudioHostBridge = Pick<
  NonNullable<DesktopBridge["audioHost"]>,
  "getLifecycle" | "onLifecycle"
>
export type { DesktopAudioLifecycle }

export type DesktopAudioRecoveryResult = "ready" | "failed"

export const isNativeRecordingLifecycleEligible = (
  state: DesktopAudioLifecycle["state"],
  nativeRecordingEnabled: boolean,
) => nativeRecordingEnabled && state === "ready"

export const shouldCancelRecordingForLifecycle = (
  state: DesktopAudioLifecycle["state"],
  nativeCaptureActive: boolean,
) => state === "suspended" || (nativeCaptureActive && state !== "ready")

export const completeDesktopAudioRecovery = (
  lifecycle: DesktopAudioLifecycle,
  generation: number,
  result: DesktopAudioRecoveryResult,
): { accepted: boolean; lifecycle: DesktopAudioLifecycle } => {
  if (lifecycle.state !== "recovering" || lifecycle.powerGeneration !== generation) {
    return { accepted: false, lifecycle }
  }
  return {
    accepted: true,
    lifecycle: {
      state: result,
      powerGeneration: generation,
    },
  }
}

export const createDesktopAudioLifecycleReconciler = (
  bridge: DesktopAudioHostBridge,
  onLifecycle: (lifecycle: DesktopAudioLifecycle) => void,
) => {
  let latestGeneration = -1
  let latestState: DesktopAudioLifecycle["state"] | undefined
  const stateRank = (state: DesktopAudioLifecycle["state"]) => (
    state === "suspended" ? 0 : state === "recovering" ? 1 : 2
  )
  const apply = (next: DesktopAudioLifecycle) => {
    if (
      next.powerGeneration < latestGeneration
      || (
        next.powerGeneration === latestGeneration
        && latestState !== undefined
        && stateRank(next.state) <= stateRank(latestState)
      )
    ) return
    latestGeneration = next.powerGeneration
    latestState = next.state
    onLifecycle(next)
  }
  const remove = bridge.onLifecycle(apply)
  void bridge.getLifecycle().then(apply).catch(() => undefined)
  return remove
}
