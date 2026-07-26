import { removeLocalAssetFileUnlocked } from '~/lib/local-assets'
import { assetCloudIdMappingKey, isAssetCloudMappingRow } from '~/lib/local-cloud-id-map'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import type { LocalControlAssetGcRow } from '~/lib/local-project-db'
import { withLocalProjectAssetLock } from '~/lib/local-project-asset-lock'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import { parseLocalControlRecoveryRow } from './local-control-rows'
import { withLocalControlTransaction, withLocalControlTransactionOptions } from './local-control-state'

const maxJobsPerPass = 100
export const localControlAssetGcLeaseMs = 5 * 60 * 1_000

const claimToken = () => Array.from(
  crypto.getRandomValues(new Uint8Array(32)),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('')

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isBoundedText = (value: unknown, maximum: number): value is string => (
  isText(value) && value.length <= maximum
)
const isLocalAssetStoragePath = (value: unknown): value is string => (
  isBoundedText(value, 2_048)
  && value !== '.'
  && value !== '..'
  && !/[\\/:]/u.test(value)
)
const isTime = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
)
const isClaimToken = (value: unknown): value is string => (
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
)

const parseAssetGcRow = (value: unknown): LocalControlAssetGcRow | undefined => {
  if (!isRecord(value)) return undefined
  const {
    id, version, projectId, assetId, eligibleAt, storagePath, recoveryId,
    cloudAssetKey, claimToken: rowClaimToken, claimedAt,
  } = value
  if (
    version !== 1
    || !isBoundedText(id, 512)
    || !isBoundedText(projectId, 256)
    || !isBoundedText(assetId, 256)
    || !isTime(eligibleAt)
    || !isLocalAssetStoragePath(storagePath)
    || !isBoundedText(recoveryId, 256)
    || id !== `local-asset-gc:${recoveryId}`
    || cloudAssetKey !== undefined && !isBoundedText(cloudAssetKey, 256)
    || rowClaimToken !== undefined && !isClaimToken(rowClaimToken)
    || claimedAt !== undefined && !isTime(claimedAt)
    || rowClaimToken === undefined && claimedAt !== undefined
    || rowClaimToken !== undefined && claimedAt === undefined
  ) return undefined
  return {
    id,
    version: 1,
    projectId,
    assetId,
    eligibleAt,
    storagePath,
    recoveryId,
    ...(cloudAssetKey === undefined ? {} : { cloudAssetKey }),
    ...(rowClaimToken === undefined ? {} : { claimToken: rowClaimToken }),
    ...(claimedAt === undefined ? {} : { claimedAt }),
  }
}

const hasLiveAssetReference = (
  rows: readonly { id: string; storagePath: string }[],
  job: LocalControlAssetGcRow,
) => rows.some((asset) => asset.id === job.assetId || asset.storagePath === job.storagePath)

const inactiveRecoveryFor = (
  job: LocalControlAssetGcRow,
  rows: readonly unknown[],
  now: number,
) => {
  const row = rows.find((candidate) => isRecord(candidate) && candidate.id === job.recoveryId)
  const recovery = parseLocalControlRecoveryRow(row)
  if (!recovery || recovery.recovery.kind !== 'asset.delete') return undefined
  const payload = recovery.recovery
  if (
    recovery.projectId !== job.projectId
    || recovery.kind !== payload.kind
    || recovery.expiresAt !== job.eligibleAt
    || payload.data.assetId !== job.assetId
    || !('storagePath' in payload.data.asset)
    || payload.data.asset.storagePath !== job.storagePath
  ) return undefined
  return recovery.consumedAt !== undefined || recovery.expiresAt <= now ? recovery : undefined
}

export const runLocalControlAssetGc = async (
  projectId: string,
  options: {
    notify?: boolean
    removeAssetFile?: typeof removeLocalAssetFileUnlocked
  } = {},
) => {
  const now = Date.now()
  const due = await withLocalControlTransaction(projectId, 'readwrite', (context) => (
    context.rows.assetGc
      .map(parseAssetGcRow)
      .flatMap((row) => row === undefined ? [] : [row])
      .filter((row) => row.projectId === projectId && row.eligibleAt <= now)
      .filter((row) => row.claimedAt === undefined || row.claimedAt <= now - localControlAssetGcLeaseMs)
      .filter((row) => !hasLiveAssetReference(context.rows.assets, row))
      .filter((row) => inactiveRecoveryFor(row, context.rows.recoveries, now) !== undefined)
      .sort((left, right) => left.eligibleAt - right.eligibleAt || left.id.localeCompare(right.id))
      .slice(0, maxJobsPerPass)
      .map((row) => {
        const claim = claimToken()
        const claimed = { ...row, claimToken: claim, claimedAt: now }
        context.write.assetGc(claimed)
        return claimed
      })
  ))
  let finalized = false
  try {
    for (const job of due) {
      try {
        await flushLocalProjectPendingWrites(projectId)
        const completed = await withLocalProjectAssetLock(projectId, async () => {
          const stillEligible = await withLocalControlTransactionOptions(projectId, (context) => {
            const current = context.rows.assetGc
              .map(parseAssetGcRow)
              .find((row) => row?.id === job.id)
            return current !== undefined
              && sameJob(current, job)
              && current.eligibleAt <= Date.now()
              && !hasLiveAssetReference(context.rows.assets, current)
              && inactiveRecoveryFor(current, context.rows.recoveries, Date.now()) !== undefined
          }, { pendingWritesFlushedUnderAssetLock: true })
          if (!stillEligible) return false
          const removal = await (options.removeAssetFile ?? removeLocalAssetFileUnlocked)(projectId, job.storagePath)
          if (removal.status !== 'deleted' && removal.status !== 'already-missing') return false
          return withLocalControlTransactionOptions(projectId, (context) => {
            const current = context.rows.assetGc
              .map(parseAssetGcRow)
              .find((row) => row?.id === job.id)
            if (!current || !sameJob(current, job)) return false
            if (current.eligibleAt > Date.now()) return false
            if (hasLiveAssetReference(context.rows.assets, current)) return false
            const recovery = inactiveRecoveryFor(current, context.rows.recoveries, Date.now())
            if (!recovery) return false
            const mapping = context.rows.syncState.find((row) => row.key === assetCloudIdMappingKey(current.assetId))
            if (mapping && isAssetCloudMappingRow(mapping)) {
              context.write.syncState({
                key: `cloud-delete:asset:${current.assetId}`,
                value: mapping.value.cloudId,
                updatedAt: Date.now(),
              })
            }
            context.remove.assetGc(current.id)
            context.remove.recovery(recovery.id)
            return true
          }, { pendingWritesFlushedUnderAssetLock: true })
        })
        finalized = finalized || completed
      } catch {}
    }
  } finally {
    if (finalized && options.notify !== false) notifyLocalProjectChanged(projectId)
  }
  return { finalized }
}

const sameJob = (
  left: LocalControlAssetGcRow | undefined,
  right: LocalControlAssetGcRow,
) => left !== undefined
  && left.id === right.id
  && left.version === right.version
  && left.projectId === right.projectId
  && left.assetId === right.assetId
  && left.storagePath === right.storagePath
  && left.recoveryId === right.recoveryId
  && left.eligibleAt === right.eligibleAt
  && left.cloudAssetKey === right.cloudAssetKey
  && left.claimToken === right.claimToken
  && left.claimedAt === right.claimedAt
