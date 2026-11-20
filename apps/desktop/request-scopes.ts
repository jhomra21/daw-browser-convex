import { bestEffort } from "@daw-browser/shared"
import type { createFileCapabilityManager } from "./file-capabilities"

/** The renderer-request scopes a desktop control request holds capability grants under, until its job reaches a terminal state. */
export const createRequestScopes = (fileCapabilities: Pick<ReturnType<typeof createFileCapabilityManager>, "revokeRequest">) => {
  const exportScopes = new Map<string, { requestId: string; rendererGeneration: number }>()
  const importScopes = new Map<string, { requestId: string; rendererGeneration: number }>()
  const importCandidates = new Map<string, { requestId: string; rendererGeneration: number }>()
  const terminalExportsAwaitingScope = new Set<string>()
  const terminalImportsAwaitingScope = new Set<string>()

  const exportScopesHasScope = (scope: { requestId: string; rendererGeneration: number }) => (
    [...exportScopes.values()].some((exportScope) => (
      exportScope.requestId === scope.requestId
      && exportScope.rendererGeneration === scope.rendererGeneration
    ))
  )

  const importScopesHasScope = (scope: { requestId: string; rendererGeneration: number }) => (
    [...importScopes.values()].some((importScope) => (
      importScope.requestId === scope.requestId
      && importScope.rendererGeneration === scope.rendererGeneration
    ))
  )

  const settleCapabilityRevocation = (operation: Promise<void>) => {
    bestEffort(operation, 'revocation runs during invalidation and has no caller to report a failure to')
  }

  // A terminal event can arrive before the reply that names its job; the job id waits (bounded) for its scope.
  const exportTerminal = (jobId: string) => {
    const scope = exportScopes.get(jobId)

    if (scope) {
      exportScopes.delete(jobId)
      settleCapabilityRevocation(fileCapabilities.revokeRequest(scope))
    } else if (terminalExportsAwaitingScope.size < 1024) terminalExportsAwaitingScope.add(jobId)
  }

  const importTerminal = (jobId: string) => {
    const scope = importScopes.get(jobId)

    if (scope) {
      importScopes.delete(jobId)
      settleCapabilityRevocation(fileCapabilities.revokeRequest(scope))
    } else if (terminalImportsAwaitingScope.size < 1024) {
      terminalImportsAwaitingScope.add(jobId)
    }
  }

  const releaseImports = () => {
    for (const scope of importScopes.values()) settleCapabilityRevocation(fileCapabilities.revokeRequest(scope))

    for (const scope of importCandidates.values()) settleCapabilityRevocation(fileCapabilities.revokeRequest(scope))
    importScopes.clear()
    importCandidates.clear()
    terminalImportsAwaitingScope.clear()
  }

  return {
    exportTerminal,
    importTerminal,
    releaseImports,
    exportScopes,
    importScopes,
    importCandidates,
    terminalExportsAwaitingScope,
    terminalImportsAwaitingScope,
    exportScopesHasScope,
    importScopesHasScope,
    settleCapabilityRevocation,
  }
}

export type RequestScopes = ReturnType<typeof createRequestScopes>
