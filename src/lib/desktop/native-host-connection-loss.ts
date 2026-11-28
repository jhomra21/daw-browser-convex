type NativePlaybackDiagnosticFailure = Error | string | null | undefined

export const sanitizeNativeVst3DiagnosticError = (error: NativePlaybackDiagnosticFailure) => {
  const message = error instanceof Error
    ? error.message
    : error ?? "Native playback could not start."

  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g, "<path>").slice(0, 256)
}

export const indicatesNativeHostConnectionLoss = (error: NativePlaybackDiagnosticFailure) => {
  const message = sanitizeNativeVst3DiagnosticError(error).toLowerCase()

  return message.includes("native playback host connection was lost")
    || message.includes("native audio host is unavailable")
    || message.includes("native audio host stopped")
    || message.includes("host connection was lost")
    || message.includes("host connection closed")
}

// Whether the native host connection is lost, for which project generation, and whether the one recovery it allows
// is spent. A loss belongs to the project generation it happened in: a later generation starts clean.
export const createNativeHostConnectionLoss = (host: {
  projectGeneration: () => number
  reportStopped: (message: string) => void
}) => {
  let lost = false
  let lossProjectGeneration: number | undefined
  let lossReason: string | undefined
  let recoveryAvailable = false
  let recoveryUsed = false
  let lossReported = false
  let intentionalTransitionDepth = 0

  const forget = () => {
    lost = false
    lossProjectGeneration = undefined
    lossReason = undefined
    recoveryAvailable = false
    recoveryUsed = false
    lossReported = false
  }

  const isLost = () => {
    if (!lost) return false
    const projectGeneration = host.projectGeneration()

    if (lossProjectGeneration !== undefined && projectGeneration !== lossProjectGeneration) {
      forget()

      return false
    }

    return true
  }

  const message = () => lossReason ?? "Native playback host connection was lost."

  return {
    isLost,
    message,
    reported: () => lossReported,
    reportBlockedStart: () => {
      const text = `Native playback start was skipped: ${message()}`
      console.error("[native-vst3] native start unavailable", {
        result: "unavailable",
        error: text,
      })
      host.reportStopped(text)
    },
    markLost: (reason?: string) => {
      if (lost) return false
      lost = true
      lossProjectGeneration = host.projectGeneration()
      lossReason = reason ?? message()
      recoveryAvailable = !recoveryUsed
      lossReported = false

      return true
    },
    beginRecovery: () => {
      if (!isLost() || !recoveryAvailable) return false
      recoveryAvailable = false
      recoveryUsed = true
      lost = false
      lossProjectGeneration = undefined
      lossReason = undefined
      lossReported = false

      return true
    },
    completeRecovery: () => {
      recoveryUsed = false
    },
    reportFault: (text: string) => {
      if (lossReported) return
      lossReported = true
      host.reportStopped(text)
    },
    reset: forget,
    // A host transition this controller makes itself ends the connection without being a loss.
    beginIntentionalTransition: () => { intentionalTransitionDepth += 1 },
    endIntentionalTransition: () => { intentionalTransitionDepth -= 1 },
    isIntentionalTransition: () => intentionalTransitionDepth > 0,
  }
}
