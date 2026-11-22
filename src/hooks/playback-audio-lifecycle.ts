import { createSignal, untrack } from 'solid-js'

import { createDesktopAudioLifecycleReconciler, type DesktopAudioLifecycle } from '~/lib/desktop-audio-lifecycle'
import type { createNativePlaybackController } from '~/lib/desktop/native-playback-controller'
import type { createPortableBrowserPlaybackController } from '~/lib/portable-browser-playback-controller'
import type { DesktopBridge } from '~/types/desktop-bridge'
import type { createDeferredStretch } from './deferred-stretch'
import type {
  ActiveAudioBackend,
  NativePlaybackOptions,
  PortableBrowserPlaybackOptions,
  RecoveryAttempt,
  TimelinePlaybackAudioEngine,
} from './timeline-playback-types'

type AudioLifecycleInput = {
  // Present only when the host reports a lifecycle.
  audioHostBridge: NonNullable<DesktopBridge["audioHost"]> | undefined
  requiresNativeAudio: boolean
  externalNativeSession: boolean
  nativeOptions?: NativePlaybackOptions
  portableBrowserOptions?: PortableBrowserPlaybackOptions
  audioEngine: TimelinePlaybackAudioEngine
  nativePlayback: ReturnType<typeof createNativePlaybackController>
  portableBrowserPlayback: ReturnType<typeof createPortableBrowserPlaybackController>
  deferredStretchQueue: ReturnType<typeof createDeferredStretch>["deferredStretchQueue"]
  isPlaying: () => boolean
  setIsPlaying: (next: boolean) => void
  isRebuildingPlayback: () => boolean
  setIsRebuildingPlayback: (next: boolean) => void
  setActiveBackend: (next: ActiveAudioBackend) => void
  // The hook's transport state and teardown, which a lifecycle change moves.
  host: {
    mounted: () => boolean
    lastPublishedPlayheadSec: () => number
    playAttemptPhase: () => { backend: 'native' | 'fallback'; state: 'startup' | 'prepared' | 'active' } | undefined
    lastNativeFault: () => string | undefined
    setLastNativeFault: (message: string) => void
    advanceTransportIntent: () => void
    cancelRaf: () => void
    clearRebuildHostLoss: () => void
    invalidatePlayAttempt: () => void
    publishPlayhead: (sec: number) => void
    prepareLegacyPaused: () => void
    reportNativeStopped: (message: string) => void
    reportNativeStateCaptureFailure: (error: Error) => void
    disposePreparedBackends: (options: undefined, reason: string) => Promise<void>
  }
}

// The desktop audio host's lifecycle as this hook sees it: the state it is in, the waits that a rebuild holds for it to be
// ready, and the paused recovery that follows a suspend.
export const createAudioLifecycle = (input: AudioLifecycleInput) => {
  const {
    audioHostBridge, requiresNativeAudio, externalNativeSession, nativeOptions, portableBrowserOptions, audioEngine,
    nativePlayback, portableBrowserPlayback, deferredStretchQueue, isPlaying, setIsPlaying, isRebuildingPlayback,
    setIsRebuildingPlayback, setActiveBackend, host,
  } = input

  const {
    cancelRaf, clearRebuildHostLoss, invalidatePlayAttempt, publishPlayhead, prepareLegacyPaused, reportNativeStopped,
    reportNativeStateCaptureFailure, disposePreparedBackends,
  } = host

  const hasAudioLifecycle = audioHostBridge !== undefined

  // Recovery and rebuild paths read the state they just set, so it is a plain variable; the signal publishes it.
  let lifecycleState: DesktopAudioLifecycle["state"] = hasAudioLifecycle ? "recovering" : "ready"
  const [audioLifecycleState, publishAudioLifecycleState] = createSignal(lifecycleState)

  let audioLifecycleGeneration = -1
  let recoveryAttempt: RecoveryAttempt | undefined
  let recoveryToken = 0

  const lifecycleReadyWaiters = new Set<{
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  const setLifecycleState = (state: DesktopAudioLifecycle["state"]) => {
    lifecycleState = state
    publishAudioLifecycleState(state)

    if (state === "ready") {
      for (const waiter of lifecycleReadyWaiters) {
        clearTimeout(waiter.timer)
        waiter.resolve()
      }

      lifecycleReadyWaiters.clear()
    } else if (state === "failed") {
      for (const waiter of lifecycleReadyWaiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(host.lastNativeFault() ?? "Native audio recovery failed."))
      }

      lifecycleReadyWaiters.clear()
    }
  }

  const waitForLifecycleReady = async () => {
    if (!hasAudioLifecycle || lifecycleState === "ready") return

    if (lifecycleState === "failed") {
      throw new Error(host.lastNativeFault() ?? "Native audio recovery failed.")
    }

    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!lifecycleReadyWaiters.delete(waiter)) return
          reject(new Error("Native audio recovery did not become ready before the rebuild deadline."))
        }, 10_000),
      }

      lifecycleReadyWaiters.add(waiter)

      if (lifecycleState === "ready") {
        lifecycleReadyWaiters.delete(waiter)
        clearTimeout(waiter.timer)
        resolve()
      }
    })
  }

  const acknowledgeRecovery = async (generation: number, result: "ready" | "failed") => {
    if (!audioHostBridge || audioHostBridge.completeRecovery === undefined) return true
    const acknowledgement = await audioHostBridge.completeRecovery(generation, result)

    if (!acknowledgement.accepted) throw new Error("Audio recovery acknowledgement was stale.")

    return true
  }

  const recoverPausedAudio = async (lifecycle: DesktopAudioLifecycle) => {
    if (lifecycle.state !== "recovering" || lifecycle.powerGeneration < audioLifecycleGeneration) return

    if (recoveryAttempt) {
      if (lifecycle.powerGeneration <= recoveryAttempt.generation) return
      recoveryAttempt.cancelled = true
      void recoveryAttempt.promise?.then(() => {
        if (
          untrack(() => host.mounted()) && lifecycleState === "recovering"
          && audioLifecycleGeneration === lifecycle.powerGeneration
        ) {
          void recoverPausedAudio(lifecycle)
        }
      }, () => {
        if (
          untrack(() => host.mounted()) && lifecycleState === "recovering"
          && audioLifecycleGeneration === lifecycle.powerGeneration
        ) {
          void recoverPausedAudio(lifecycle)
        }
      })

      return
    }

    setLifecycleState("recovering")
    audioLifecycleGeneration = lifecycle.powerGeneration
    const recoveryGeneration = lifecycle.powerGeneration
    const token = recoveryToken + 1
    recoveryToken = token
    const attempt: RecoveryAttempt = { generation: recoveryGeneration, token, cancelled: false }
    recoveryAttempt = attempt

    const isCurrent = () => (
      host.mounted()
      && recoveryAttempt === attempt
      && token === recoveryToken
      && !attempt.cancelled
      && lifecycleState === "recovering"
      && audioLifecycleGeneration === recoveryGeneration
    )

    const recovery = (async () => {
      if (externalNativeSession) {
        // The session's owner recovers it; this renderer has no native graph to rebuild.
        await acknowledgeRecovery(recoveryGeneration, "ready")

        if (!isCurrent()) return
        setLifecycleState("ready")

        return
      }

      const sec = host.lastPublishedPlayheadSec()

      const preserveBrowserFallback = !requiresNativeAudio
        && isPlaying()
        && !nativePlayback.isActive()
        && !nativePlayback.isPrepared()

      if (preserveBrowserFallback) {
        await acknowledgeRecovery(recoveryGeneration, "ready")

        if (!isCurrent()) return
        setLifecycleState("ready")

        return
      }

      await disposePreparedBackends(undefined, "audio-recovery-start")

      if (!isCurrent()) return

      if (isPlaying() && !nativePlayback.isActive() && !nativePlayback.isPrepared()) {
        await acknowledgeRecovery(recoveryGeneration, "ready")

        if (!isCurrent()) return
        setLifecycleState("ready")

        return
      }

      setIsPlaying(false)
      cancelRaf()

      let prepared = false

      if (!requiresNativeAudio && portableBrowserOptions) {
        audioEngine.ensureAudio({ applyCachedTrackGains: false })
        await audioEngine.resume()

        if (!isCurrent()) {
          await disposePreparedBackends(undefined, "audio-recovery-superseded")

          return
        }

        const result = await portableBrowserPlayback.ensurePrepared({
          state: "paused",
          playheadSec: sec,
          loopEnabled: false,
          loopStartSec: 0,
          loopEndSec: 0,
        })

        if (!isCurrent()) {
          await disposePreparedBackends(undefined, "audio-recovery-superseded")

          return
        }

        prepared = result === "started"

        if (prepared) setActiveBackend("portable-browser")
      }

      if (!prepared && (requiresNativeAudio || nativeOptions?.enabled?.())) {
        const result = await nativePlayback.ensureLivePreview(sec)

        if (!isCurrent()) {
          await disposePreparedBackends(undefined, "audio-recovery-superseded")

          return
        }

        if (result === "blocked") throw new Error("Native audio recovery is unavailable for the current project.")
        prepared = result === "started"

        if (prepared) setActiveBackend("native")
      }

      if (!prepared && !requiresNativeAudio) prepareLegacyPaused()

      if (!prepared && requiresNativeAudio) {
        throw new Error("Native audio recovery did not prepare a native playback graph.")
      }

      if (!isCurrent()) return
      await acknowledgeRecovery(recoveryGeneration, "ready")

      if (!isCurrent()) return
      setLifecycleState("ready")
    })()

    attempt.promise = recovery

    try {
      await recovery
    } catch (error) {
      if (!isCurrent()) return
      await disposePreparedBackends(undefined, "audio-recovery-failed")

      if (!isCurrent()) return
      setLifecycleState("failed")
      await acknowledgeRecovery(recoveryGeneration, "failed").catch(() => undefined)

      if (!isCurrent()) return
      const message = error instanceof Error ? error.message : "Audio recovery failed."
      host.setLastNativeFault(message)
      reportNativeStopped(message)
    } finally {
      if (recoveryAttempt === attempt) recoveryAttempt = undefined
    }
  }

  const handleAudioLifecycle = (lifecycle: DesktopAudioLifecycle) => {
    if (!host.mounted()) return

    if (lifecycle.powerGeneration < audioLifecycleGeneration) return

    const lifecycleChanged = lifecycle.powerGeneration !== audioLifecycleGeneration
      || lifecycle.state !== lifecycleState

    if (lifecycleChanged && isRebuildingPlayback()
      && (lifecycle.state === "suspended" || lifecycle.state === "failed")) {
      clearRebuildHostLoss()
      setIsRebuildingPlayback(false)
      host.advanceTransportIntent()
      invalidatePlayAttempt()
    }

    const nativePlaybackInProgress = host.playAttemptPhase()?.backend === 'native'
      || nativePlayback.isActive()
      || nativePlayback.isPrepared()

    const shouldInvalidateNativePlayback = lifecycleChanged
      && lifecycle.state !== "ready"
      && nativePlaybackInProgress

    if (shouldInvalidateNativePlayback) {
      invalidatePlayAttempt()

      if (isPlaying()) {
        setIsPlaying(false)
        cancelRaf()
      }

      void disposePreparedBackends(undefined, "audio-lifecycle-change")
    }

    audioLifecycleGeneration = lifecycle.powerGeneration
    setLifecycleState(lifecycle.state)

    if (lifecycle.state === "suspended") {
      invalidatePlayAttempt()
      recoveryToken += 1

      if (recoveryAttempt) recoveryAttempt.cancelled = true
      cancelRaf()

      const frozenSec = nativePlayback.currentPositionSec()
        ?? (requiresNativeAudio ? undefined : portableBrowserPlayback.currentPositionSec())
        ?? (requiresNativeAudio ? undefined : audioEngine.currentTimelineSec)
        ?? host.lastPublishedPlayheadSec()

      publishPlayhead(frozenSec)
      setIsPlaying(false)

      if (!requiresNativeAudio) {
        audioEngine.stopAllSources()
        audioEngine.cancelAutomationSchedules()
      }

      deferredStretchQueue.clear()
      void disposePreparedBackends(undefined, "audio-host-suspended")

      return
    }

    if (lifecycle.state === "recovering") {
      nativePlayback.resetNativeHostConnectionLoss()
      const attemptPhase = host.playAttemptPhase()

      if (attemptPhase?.backend === 'fallback' && attemptPhase.state === 'startup') {
        void acknowledgeRecovery(lifecycle.powerGeneration, "ready")
          .then(() => {
            if (
              untrack(() => host.mounted()) && lifecycleState === "recovering"
              && audioLifecycleGeneration === lifecycle.powerGeneration
            ) setLifecycleState("ready")
          })
          .catch(() => undefined)

        return
      }

      void recoverPausedAudio({
        state: lifecycle.state,
        powerGeneration: lifecycle.powerGeneration,
      })

      return
    }

    if (lifecycle.state === "failed" && (nativePlayback.isActive() || nativePlayback.isPrepared())) {
      recoveryToken += 1

      if (recoveryAttempt) recoveryAttempt.cancelled = true
      cancelRaf()
      setIsPlaying(false)
      void disposePreparedBackends(undefined, "audio-host-failed").catch(reportNativeStateCaptureFailure)
      setActiveBackend("idle")
    }
  }

  const removeAudioLifecycle = hasAudioLifecycle
    ? untrack(() => createDesktopAudioLifecycleReconciler(audioHostBridge, handleAudioLifecycle))
    : undefined

  // Ends what a mounted hook left waiting: the recovery in flight and every rebuild held for a ready host.
  const releaseLifecycle = () => {
    recoveryToken += 1

    if (recoveryAttempt) recoveryAttempt.cancelled = true

    for (const waiter of lifecycleReadyWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }

    lifecycleReadyWaiters.clear()
  }

  return { audioLifecycleState, audioLifecycleGeneration: () => audioLifecycleGeneration, waitForLifecycleReady, releaseLifecycle, removeAudioLifecycle }
}
