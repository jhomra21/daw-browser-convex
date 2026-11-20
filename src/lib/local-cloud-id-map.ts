import type { LocalProjectStoredValue, LocalProjectSyncStateRow } from '~/lib/local-project-db'
import { isJsonNumber, isJsonObject, isJsonString, parseJsonValue, type JsonValue } from '@daw-browser/shared'

type CloudMappedEntityKind = 'track' | 'clip' | 'asset'

type CloudIdMapping = {
  kind: CloudMappedEntityKind
  localId: string
  cloudId: string
  historyRef: string
  updatedAt?: number
}

const keyFor = (kind: CloudMappedEntityKind, localId: string) => `cloud-id:${kind}:${localId}`
const indexKeyFor = (kind: CloudMappedEntityKind, cloudId: string) => `local-id:${kind}:${cloudId}`
const now = () => Date.now()

const isCloudMappedEntityKind = (value: JsonValue | undefined): value is CloudMappedEntityKind => (
  value === 'track' || value === 'clip' || value === 'asset'
)

const createCloudIdMapping = (
  kind: CloudMappedEntityKind,
  mapping: {
    localId: string
    cloudId: string
    historyRef?: string
  },
  updatedAt: number,
): CloudIdMapping => ({
  kind,
  localId: mapping.localId,
  cloudId: mapping.cloudId,
  historyRef: mapping.historyRef ?? mapping.localId,
  updatedAt,
})

export const assetCloudIdMappingKey = (assetId: string) => keyFor('asset', assetId)

export const isCloudIdMappingMetadataKey = (key: string) => (
  key.startsWith('cloud-id:') || key.startsWith('local-id:')
)

const cloudIdMappingRows = (
  kind: CloudMappedEntityKind,
  mappings: Iterable<{
    localId: string
    cloudId: string
    historyRef?: string
  }>,
  updatedAt = now(),
): LocalProjectSyncStateRow[] => {
  const rows: LocalProjectSyncStateRow[] = []

  for (const mapping of mappings) {
    rows.push({
      key: keyFor(kind, mapping.localId),
      value: createCloudIdMapping(kind, mapping, updatedAt),
      updatedAt,
    })
    rows.push({
      key: indexKeyFor(kind, mapping.cloudId),
      value: mapping.localId,
      updatedAt,
    })
  }

  return rows
}

export const assetCloudIdMappingRows = (
  mappings: Iterable<{
    localId: string
    cloudId: string
    historyRef?: string
  }>,
  updatedAt = now(),
) => cloudIdMappingRows('asset', mappings, updatedAt)

const isMapping = (value: LocalProjectStoredValue | undefined): value is CloudIdMapping => {
  const parsed = parseJsonValue(value)

  if (!isJsonObject(parsed)) return false

  return (
    isCloudMappedEntityKind(parsed.kind)
    && isJsonString(parsed.localId)
    && isJsonString(parsed.cloudId)
    && isJsonString(parsed.historyRef)
    && (parsed.updatedAt === undefined || isJsonNumber(parsed.updatedAt))
  )
}

export const isCloudIdMappingValue = isMapping

export const isAssetCloudMappingRow = (
  row: LocalProjectSyncStateRow,
): row is LocalProjectSyncStateRow & { value: CloudIdMapping } => (
  isMapping(row.value)
  && row.value.kind === 'asset'
  && row.key === assetCloudIdMappingKey(row.value.localId)
)

