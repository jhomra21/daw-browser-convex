import { loadLocalProjectState, saveLocalProjectState } from '~/lib/local-project-state'
import { isExportAudioFormat, isJsonNumber, isJsonObject, isJsonString, type ExportAudioFormat, type JsonValue } from '@daw-browser/shared'

type LocalExportMetadata = {
  id: string
  name: string
  format: ExportAudioFormat
  durationSec: number
  sampleRate: number
  sizeBytes: number
  createdAt: number
}

const EXPORTS_KEY = 'exports'
const MAX_LOCAL_EXPORTS = 25

const isExportMetadata = (value: JsonValue): value is LocalExportMetadata => {
  if (!isJsonObject(value)) return false
  return (
    isJsonString(value.id)
    && isJsonString(value.name)
    && isJsonString(value.format)
    && isExportAudioFormat(value.format)
    && isJsonNumber(value.durationSec)
    && isJsonNumber(value.sampleRate)
    && isJsonNumber(value.sizeBytes)
    && isJsonNumber(value.createdAt)
  )
}

const readExports = async (projectId: string): Promise<LocalExportMetadata[]> => {
  const rows = await loadLocalProjectState<JsonValue>(projectId, EXPORTS_KEY)
  return Array.isArray(rows) ? rows.filter(isExportMetadata) : []
}

export const listLocalExportMetadata = readExports

export type LocalExportMetadataInput = Omit<LocalExportMetadata, 'id' | 'createdAt'>

export const saveLocalExportMetadataBatch = async (
  projectId: string,
  inputs: readonly LocalExportMetadataInput[],
): Promise<void> => {
  if (inputs.length === 0) return
  const createdAt = Date.now()
  const rows = inputs.map((input) => ({
    ...input,
    id: `export:${crypto.randomUUID()}`,
    createdAt,
  }))
  const next = [...rows, ...(await readExports(projectId))].slice(0, MAX_LOCAL_EXPORTS)
  await saveLocalProjectState(projectId, EXPORTS_KEY, next)
}
