export type OptimisticGrantScope = {
  projectId: string
  userId: string
}

export type OptimisticGrantWrite = (
  id: string,
  scope?: OptimisticGrantScope | null,
) => void

export function readOptimisticGrantScope(input: {
  projectId: string | null | undefined
  userId: string | null | undefined
}) {
  if (!input.projectId || !input.userId) return null
  return {
    projectId: input.projectId,
    userId: input.userId,
  }
}

export function buildOptimisticGrantScopeKey(scope: OptimisticGrantScope) {
  return `${scope.projectId}:${scope.userId}`
}

export function isOptimisticGrantScopeCurrent(
  currentScopeKey: string,
  scope: OptimisticGrantScope | null | undefined,
) {
  return !scope || buildOptimisticGrantScopeKey(scope) === currentScopeKey
}

export function didOptimisticGrantScopeChange(
  previousScope: OptimisticGrantScope,
  nextScope: OptimisticGrantScope,
) {
  return buildOptimisticGrantScopeKey(previousScope) !== buildOptimisticGrantScopeKey(nextScope)
}
