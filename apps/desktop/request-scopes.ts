import { bestEffort } from "@daw-browser/shared"

/** The renderer-request scopes a desktop control request holds capability grants under, until its job reaches a terminal state. */
export const createRequestScopes = () => {
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

  return {
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
