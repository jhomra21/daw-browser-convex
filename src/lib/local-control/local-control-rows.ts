import { hashRecoveryPayloadSyncV1, parseStoredRecoveryPayload, type RecoveryPayload } from '@daw-browser/control'
import { z } from 'zod'
import type { LocalControlRecoveryRow, LocalExternalProcessorRecoveryBundle } from '~/lib/local-project-db'
import {
  hashLocalExternalProcessorRecoveryBundles,
  localExternalRecoveryUsage,
  validateLocalExternalProcessorRecoveryBundles,
} from './local-control-recovery'

const localControlRecoveryRowSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  projectId: z.string(),
  expiresAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  actorSubject: z.string(),
  sourceActionIndex: z.number().int().nonnegative(),
  sourceCommitId: z.string().optional(),
  kind: z.string(),
  payload: z.string(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/u),
  externalProcessors: z.custom<LocalExternalProcessorRecoveryBundle[]>().optional(),
  externalProcessorsHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  localSampleUrls: z.record(z.string(), z.string()).optional(),
  consumedAt: z.number().int().nonnegative().optional(),
}).passthrough()

export const parseLocalControlRecoveryRow = <Value>(
  value: Value,
): (LocalControlRecoveryRow & { recovery: RecoveryPayload }) | undefined => {
  try {
    const row = localControlRecoveryRowSchema.parse(value)
    if (hashRecoveryPayloadSyncV1(row.payload) !== row.payloadHash) return undefined
    const externalProcessors = row.externalProcessors === undefined
      ? undefined
      : validateLocalExternalProcessorRecoveryBundles(row.externalProcessors)
    if (externalProcessors !== undefined) localExternalRecoveryUsage(externalProcessors)
    if (
      externalProcessors !== undefined
      && (
        row.externalProcessorsHash === undefined
        || hashLocalExternalProcessorRecoveryBundles(externalProcessors) !== row.externalProcessorsHash
      )
    ) return undefined
    const recovery = parseStoredRecoveryPayload(row.payload)
    return recovery.kind === row.kind
      ? {
          id: row.id,
          version: 1,
          projectId: row.projectId,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          actorSubject: row.actorSubject,
          sourceActionIndex: row.sourceActionIndex,
          sourceCommitId: row.sourceCommitId,
          kind: row.kind,
          payload: row.payload,
          payloadHash: row.payloadHash,
          externalProcessors,
          externalProcessorsHash: row.externalProcessorsHash,
          localSampleUrls: row.localSampleUrls,
          consumedAt: row.consumedAt,
          recovery,
        }
      : undefined
  } catch {
    return undefined
  }
}