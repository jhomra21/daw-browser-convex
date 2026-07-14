import type { AudioEffectRuntimeInstance } from './runtime-instance'
import { PROCESSOR_RESOURCE_LIMITS } from './processor-release-contract'
import type { StaticWorkletKind } from './static-worklet-chain'

export type LiveWorkletTransaction = {
  owner: string
  id: number
}

export const isStaticWorkletKind = (kind: AudioEffectRuntimeInstance['kind']): kind is StaticWorkletKind =>
  kind === 'utility' || kind === 'autofilter' || kind === 'gate' || kind === 'limiter' || kind === 'lofi' ||
  kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo' || kind === 'autopan' || kind === 'ensemble' ||
  kind === 'spectral'

export const countStaticWorklets = (instances: readonly AudioEffectRuntimeInstance[]) =>
  instances.filter((instance) => isStaticWorkletKind(instance.kind)).length

export function createLiveWorkletBudget(limit: number = PROCESSOR_RESOURCE_LIMITS.liveOwnedWorklets) {
  const committed = new Map<string, number>()
  const pending = new Map<number, LiveWorkletTransaction & { count: number }>()
  const latestTransactionByOwner = new Map<string, number>()
  let nextId = 0

  const committedCount = () => [...committed.values()].reduce((count, value) => count + value, 0)
  const pendingCount = () => [...pending.values()].reduce((count, transaction) => count + transaction.count, 0)

  return {
    begin: (owner: string, candidateConstructionCount: number): LiveWorkletTransaction => {
      if (!Number.isInteger(candidateConstructionCount) || candidateConstructionCount < 0) {
        throw new Error('Live worklet construction count must be a non-negative integer.')
      }
      if (committedCount() + pendingCount() + candidateConstructionCount > limit) {
        throw new Error(`Live processing is limited to ${limit} static worklets.`)
      }
      const transaction = { owner, id: ++nextId }
      pending.set(transaction.id, { ...transaction, count: candidateConstructionCount })
      latestTransactionByOwner.set(owner, transaction.id)
      return transaction
    },
    commit: (transaction: LiveWorkletTransaction, nextCommittedCount: number) => {
      if (!Number.isInteger(nextCommittedCount) || nextCommittedCount < 0) {
        throw new Error('Committed live worklet count must be a non-negative integer.')
      }
      const current = pending.get(transaction.id)
      if (!current || current.owner !== transaction.owner) return false
      pending.delete(transaction.id)
      if (latestTransactionByOwner.get(transaction.owner) !== transaction.id) return false
      latestTransactionByOwner.delete(transaction.owner)
      if (nextCommittedCount === 0) committed.delete(transaction.owner)
      else committed.set(transaction.owner, nextCommittedCount)
      return true
    },
    isCurrent: (transaction: LiveWorkletTransaction) => {
      const current = pending.get(transaction.id)
      return current?.owner === transaction.owner &&
        latestTransactionByOwner.get(transaction.owner) === transaction.id
    },
    rollback: (transaction: LiveWorkletTransaction) => {
      const current = pending.get(transaction.id)
      if (!current || current.owner !== transaction.owner) return
      pending.delete(transaction.id)
      if (latestTransactionByOwner.get(transaction.owner) === transaction.id) {
        latestTransactionByOwner.delete(transaction.owner)
      }
    },
    releaseOwner: (owner: string) => {
      committed.delete(owner)
      latestTransactionByOwner.delete(owner)
      for (const [id, transaction] of pending) {
        if (transaction.owner === owner) pending.delete(id)
      }
    },
    reservedCount: () => committedCount() + pendingCount(),
    committedCount,
    pendingCount,
  }
}
