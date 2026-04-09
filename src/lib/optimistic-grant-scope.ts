export type OptimisticGrantScope = {
  roomId: string
  userId: string
}

export type OptimisticGrantWrite = (
  id: string,
  scope?: OptimisticGrantScope | null,
) => void

export function readOptimisticGrantScope(input: {
  roomId: string | null | undefined
  userId: string | null | undefined
}) {
  if (!input.roomId || !input.userId) return null
  return {
    roomId: input.roomId,
    userId: input.userId,
  }
}

export function buildOptimisticGrantScopeKey(scope: OptimisticGrantScope) {
  return `${scope.roomId}:${scope.userId}`
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
