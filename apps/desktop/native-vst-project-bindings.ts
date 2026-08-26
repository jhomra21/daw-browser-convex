export type NativeVstProjectBindings = {
  stage(instanceIds: readonly string[], projectId: string, transactionToken?: string): void
  stageEmpty(transactionToken?: string): void
  commit(transactionToken?: string): void
  rollback(transactionToken?: string): void
  remove(instanceId: string, transactionToken?: string): void
  clear(): void
  projectFor(instanceId: string): string | undefined
  matches(instanceId: string, projectId: string): boolean
}

export const createNativeVstProjectBindings = (): NativeVstProjectBindings => {
  const committed = new Map<string, string>()
  let staged: Map<string, string> | undefined
  let stagedToken: string | undefined

  const assertToken = (transactionToken: string | undefined) => {
    if (stagedToken !== undefined && stagedToken !== transactionToken) {
      throw new Error("The staged native VST project binding transaction token is invalid.")
    }
  }

  return {
    stage(instanceIds, projectId, transactionToken) {
      staged = new Map(instanceIds.map((instanceId) => [instanceId, projectId]))
      stagedToken = transactionToken
    },
    stageEmpty(transactionToken) {
      staged = new Map()
      stagedToken = transactionToken
    },
    commit(transactionToken) {
      if (staged === undefined) return
      assertToken(transactionToken)
      committed.clear()
      for (const [instanceId, projectId] of staged) committed.set(instanceId, projectId)
      staged = undefined
      stagedToken = undefined
    },
    rollback(transactionToken) {
      assertToken(transactionToken)
      staged = undefined
      stagedToken = undefined
    },
    remove(instanceId, transactionToken) {
      assertToken(transactionToken)
      committed.delete(instanceId)
      staged?.delete(instanceId)
    },
    clear() {
      committed.clear()
      staged = undefined
      stagedToken = undefined
    },
    projectFor(instanceId) {
      return committed.get(instanceId)
    },
    matches(instanceId, projectId) {
      return committed.get(instanceId) === projectId
    },
  }
}
