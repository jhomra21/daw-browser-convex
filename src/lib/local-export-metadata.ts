import { loadLocalProjectState, saveLocalProjectState } from '~/lib/local-project-state'

type LocalExportMetadata = {
  id: string
  name: string
  format: 'wav'
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
    && value.format === 'wav'
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

export const saveLocalExportMetadata = async (
  projectId: string,
  input: Omit<LocalExportMetadata, 'id' | 'createdAt'>,
): Promise<void> => {
  const createdAt = Date.now()
  const next = [{
    ...input,
    id: `export:${crypto.randomUUID()}`,
    createdAt,
  }, ...(await readExports(projectId))].slice(0, MAX_LOCAL_EXPORTS)
  await saveLocalProjectState(projectId, EXPORTS_KEY, next)
}
