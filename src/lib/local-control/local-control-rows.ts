import { hashRecoveryPayloadSyncV1, parseStoredRecoveryPayload, type RecoveryPayload } from '@daw-browser/control'
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
): (LocalControlRecoveryRow & { recovery: RecoveryPayload }) | undefined => {
  if (
    !isRecord(value) || value.version !== 1 || typeof value.id !== 'string'
    || typeof value.projectId !== 'string' || !isTime(value.expiresAt) || !isTime(value.createdAt)
    || typeof value.actorSubject !== 'string' || !isTime(value.sourceActionIndex)
    || typeof value.kind !== 'string' || typeof value.payload !== 'string' || !isHash(value.payloadHash)
    || value.localSampleUrls !== undefined && (
      !isRecord(value.localSampleUrls)
      || !Object.values(value.localSampleUrls).every((sampleUrl) => typeof sampleUrl === 'string')
    )
    || value.consumedAt !== undefined && !isTime(value.consumedAt)
    || value.sourceCommitId !== undefined && typeof value.sourceCommitId !== 'string'
  ) return undefined
  try {
    if (hashRecoveryPayloadSyncV1(value.payload) !== value.payloadHash) return undefined
    const recovery = parseStoredRecoveryPayload(value.payload)
    return recovery.kind === value.kind
      ? { ...value, recovery } as LocalControlRecoveryRow & { recovery: RecoveryPayload }
      : undefined
  } catch {
    return undefined
  }
}