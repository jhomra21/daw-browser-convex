import { hashRecoveryPayloadSyncV1, parseRecoveryPayloadV1, type RecoveryPayloadV1 } from '@daw-browser/control'
import type { LocalControlRecoveryRow } from '~/lib/local-project-db'

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const isTime = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
)
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export const parseLocalControlRecoveryRow = (
  value: unknown,
): (LocalControlRecoveryRow & { recovery: RecoveryPayloadV1 }) | undefined => {
  if (
    !isRecord(value) || value.version !== 1 || typeof value.id !== 'string'
    || typeof value.projectId !== 'string' || !isTime(value.expiresAt) || !isTime(value.createdAt)
    || typeof value.actorSubject !== 'string' || !isTime(value.sourceActionIndex)
    || typeof value.kind !== 'string' || typeof value.payload !== 'string' || !isHash(value.payloadHash)
    || value.consumedAt !== undefined && !isTime(value.consumedAt)
    || value.sourceCommitId !== undefined && typeof value.sourceCommitId !== 'string'
  ) return undefined
  try {
    const recovery = parseRecoveryPayloadV1(value.payload)
    return recovery.kind === value.kind && hashRecoveryPayloadSyncV1(value.payload) === value.payloadHash
      ? { ...value, recovery } as LocalControlRecoveryRow & { recovery: RecoveryPayloadV1 }
      : undefined
  } catch {
    return undefined
  }
}