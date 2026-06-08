import { loadLocalProjectState, saveLocalProjectState } from '~/lib/local-project-state'
import { isExportAudioFormat, type ExportAudioFormat } from '@daw-browser/shared'

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

const isExportMetadata = (value: unknown): value is LocalExportMetadata => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return (
    'id' in value
    && 'name' in value
    && 'format' in value
    && 'durationSec' in value
    && 'sampleRate' in value
    && 'sizeBytes' in value
    && 'createdAt' in value
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.format === 'string'
    && isExportAudioFormat(value.format)
    && typeof value.durationSec === 'number'
    && typeof value.sampleRate === 'number'
    && typeof value.sizeBytes === 'number'
    && typeof value.createdAt === 'number'
  )
}

const readExports = async (projectId: string): Promise<LocalExportMetadata[]> => {
  const rows = await loadLocalProjectState<unknown>(projectId, EXPORTS_KEY)
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
