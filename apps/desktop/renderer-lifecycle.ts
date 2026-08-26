export type RendererLifecycleInvalidation = {
  previousGeneration: number
  generation: number
}

export type RendererLifecycleOwner = {
  generation(): number
  invalidateActiveDocument(): RendererLifecycleInvalidation | undefined
  beginMainFrameNavigation(identity: string): RendererLifecycleInvalidation | undefined
  commitMainFrameNavigation(identity: string): void
  failMainFrameNavigation(identity: string): boolean
  confirmMainFrameNavigation(): boolean
  invalidateAfterCrash(): RendererLifecycleInvalidation | undefined
  acceptsPrivilegedRequests(): boolean
}

const MAX_RETIRED_NAVIGATION_IDENTITIES = 128

export const createRendererLifecycleOwner = (initialGeneration = 0): RendererLifecycleOwner => {
  type NavigationAttempt = {
    identity: string
    status: "pending" | "committed" | "failed" | "stale"
  }

  let currentGeneration = initialGeneration
  let activeGeneration: number | undefined
  let hasCommittedDocument = false
  let navigationSequence = 0
  let pendingMainFrameNavigations: Array<NavigationAttempt & { sequence: number }> = []
  let navigationBoundaryObserved = false
  let restoreAfterNavigationFailure = false
  let ambiguousNavigationOutcome = false
  let hadOverlappingNavigation = false
  const retiredNavigationIdentities = new Set<string>()
  let retiredNavigationOverflow = false
  let crashed = false

  const activateCurrentDocument = () => {
    activeGeneration = currentGeneration
    hasCommittedDocument = true
  }
  const pendingNavigations = () => pendingMainFrameNavigations.filter(({ status }) => status === "pending")
  const matchingNavigation = (identity: string) => {
    if (retiredNavigationOverflow) {
      return { attempt: undefined, ambiguous: false }
    }
    const pending = pendingNavigations()
    if (retiredNavigationIdentities.has(identity)) {
      return { attempt: undefined, ambiguous: false }
    }
    if (pending.length === 1 && retiredNavigationIdentities.has(pending[0].identity)) {
      return { attempt: undefined, ambiguous: false }
    }
    const matches = pending.filter((attempt) => attempt.identity === identity)
    if (matches.length === 1) return { attempt: matches[0], ambiguous: false }
    if (matches.length > 1) return { attempt: undefined, ambiguous: true }
    // Electron 43 exposes only the URL for completion/failure events. With one
    // pending attempt, a redirected completion is still unambiguous.
    if (!hadOverlappingNavigation && pending.length === 1) {
      return { attempt: pending[0], ambiguous: false }
    }
    return { attempt: undefined, ambiguous: false }
  }
  const newestNavigation = () => pendingMainFrameNavigations.reduce<NavigationAttempt & { sequence: number } | undefined>(
    (newest, attempt) => newest === undefined || attempt.sequence > newest.sequence ? attempt : newest,
    undefined,
  )
  const markOlderNavigationsStale = (sequence: number) => {
    for (const attempt of pendingMainFrameNavigations) {
      if (attempt.sequence < sequence && attempt.status === "pending") attempt.status = "stale"
    }
  }
  const settleOverlappingNavigation = () => {
    if (!navigationBoundaryObserved) return false
    if (ambiguousNavigationOutcome) {
      // The boundary retires an untrusted batch but does not activate it.
      for (const { identity } of pendingMainFrameNavigations) {
        if (retiredNavigationIdentities.size >= MAX_RETIRED_NAVIGATION_IDENTITIES) {
          retiredNavigationIdentities.clear()
          retiredNavigationOverflow = true
          break
        }
        retiredNavigationIdentities.add(identity)
      }
      pendingMainFrameNavigations = []
      navigationBoundaryObserved = false
      restoreAfterNavigationFailure = false
      ambiguousNavigationOutcome = false
      hadOverlappingNavigation = false
      return false
    }
    if (pendingNavigations().length > 0) return false
    const newest = newestNavigation()
    navigationBoundaryObserved = false
    if (newest?.status === "committed") {
      pendingMainFrameNavigations = []
      hadOverlappingNavigation = false
      retiredNavigationIdentities.clear()
      retiredNavigationOverflow = false
      activateCurrentDocument()
      return true
    }
    if (newest?.status === "failed") {
      pendingMainFrameNavigations = []
      restoreAfterNavigationFailure = false
      hadOverlappingNavigation = false
      retiredNavigationIdentities.clear()
      retiredNavigationOverflow = false
    }
    return false
  }

  return {
    generation: () => currentGeneration,
    invalidateActiveDocument() {
      if (activeGeneration === undefined) return undefined
      const previousGeneration = activeGeneration
      currentGeneration += 1
      activeGeneration = undefined
      return { previousGeneration, generation: currentGeneration }
    },
    beginMainFrameNavigation(identity) {
      crashed = false
      if (retiredNavigationOverflow) return undefined
      const hadPendingNavigation = pendingNavigations().length > 0
      if (hadPendingNavigation) hadOverlappingNavigation = true
      pendingMainFrameNavigations.push({
        sequence: navigationSequence,
        identity,
        status: "pending",
      })
      navigationSequence += 1
      navigationBoundaryObserved = false
      if (hadPendingNavigation) return undefined
      if (activeGeneration === undefined) {
        return undefined
      }
      restoreAfterNavigationFailure = true
      const previousGeneration = activeGeneration
      currentGeneration += 1
      activeGeneration = undefined
      return { previousGeneration, generation: currentGeneration }
    },
    commitMainFrameNavigation(identity) {
      if (crashed) return
      const matchResult = matchingNavigation(identity)
      if (matchResult.ambiguous) {
        ambiguousNavigationOutcome = true
        return
      }
      const match = matchResult.attempt
      if (!match) {
        if (
          !hasCommittedDocument
          && navigationSequence === 0
          && pendingMainFrameNavigations.length === 0
        ) activateCurrentDocument()
        return
      }
      if (match.status !== "pending") return
      if (newestNavigation()?.sequence === match.sequence) markOlderNavigationsStale(match.sequence)
      match.status = "committed"
      if (pendingNavigations().length === 0 && pendingMainFrameNavigations.length === 1) {
        pendingMainFrameNavigations = []
        restoreAfterNavigationFailure = false
        hadOverlappingNavigation = false
        retiredNavigationIdentities.clear()
        retiredNavigationOverflow = false
        activateCurrentDocument()
      }
    },
    failMainFrameNavigation(identity) {
      if (crashed) return false
      const matchResult = matchingNavigation(identity)
      if (matchResult.ambiguous) {
        ambiguousNavigationOutcome = true
        return false
      }
      const match = matchResult.attempt
      if (!match || match.status !== "pending") return false
      if (newestNavigation()?.sequence === match.sequence) markOlderNavigationsStale(match.sequence)
      match.status = "failed"
      const newest = newestNavigation()
      const shouldRestore = restoreAfterNavigationFailure
        && activeGeneration === undefined
        && !hadOverlappingNavigation
        && pendingNavigations().length === 0
        && newest?.sequence === match.sequence
      if (shouldRestore) {
        pendingMainFrameNavigations = []
        restoreAfterNavigationFailure = false
        hadOverlappingNavigation = false
        retiredNavigationIdentities.clear()
        retiredNavigationOverflow = false
        activateCurrentDocument()
        return true
      }
      return false
    },
    confirmMainFrameNavigation() {
      if (crashed || pendingMainFrameNavigations.length === 0) return false
      navigationBoundaryObserved = true
      return settleOverlappingNavigation()
    },
    invalidateAfterCrash() {
      if (crashed) return undefined
      crashed = true
      pendingMainFrameNavigations = []
      navigationBoundaryObserved = false
      restoreAfterNavigationFailure = false
      ambiguousNavigationOutcome = false
      hadOverlappingNavigation = false
      retiredNavigationIdentities.clear()
      retiredNavigationOverflow = false
      if (activeGeneration === undefined) {
        const previousGeneration = currentGeneration
        currentGeneration += 1
        return { previousGeneration, generation: currentGeneration }
      }
      const previousGeneration = activeGeneration
      currentGeneration += 1
      activeGeneration = undefined
      return { previousGeneration, generation: currentGeneration }
    },
    acceptsPrivilegedRequests: () => activeGeneration === currentGeneration,
  }
}
