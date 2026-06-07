import type { ExportAudioFormat } from '@daw-browser/shared'
import { isExportAudioFormat } from '@daw-browser/shared'

type SaveCloudExportInput = {
  projectId: string
  blob: Blob
  name: string
  format: ExportAudioFormat
  durationSec: number
  sampleRate: number
  signal?: AbortSignal
}

type CloudExportUpload = {
  url: string
  key: string
  name: string
  format: ExportAudioFormat
  mimeType: string
  sizeBytes?: number
  exportId?: string
}

const readCloudExportUpload = (value: unknown): CloudExportUpload => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid upload response')
  }
  const url = 'url' in value && typeof value.url === 'string' ? value.url : ''
  const key = 'key' in value && typeof value.key === 'string' ? value.key : ''
  const name = 'name' in value && typeof value.name === 'string' ? value.name : ''
  const format = 'format' in value && typeof value.format === 'string' && isExportAudioFormat(value.format) ? value.format : undefined
  const mimeType = 'mimeType' in value && typeof value.mimeType === 'string' ? value.mimeType : ''
  const sizeBytes = 'sizeBytes' in value && typeof value.sizeBytes === 'number' ? value.sizeBytes : undefined
  const exportId = 'exportId' in value && typeof value.exportId === 'string' ? value.exportId : undefined
  if (!url || !key || !name || !format || !mimeType) throw new Error('Invalid upload response')
  return { url, key, name, format, mimeType, sizeBytes, exportId }
}

export const saveCloudExport = async (input: SaveCloudExportInput): Promise<CloudExportUpload> => {
  const form = new FormData()
  form.append('projectId', input.projectId)
  form.append('duration', String(input.durationSec))
  form.append('sampleRate', String(input.sampleRate))
  form.append('format', input.format)
  form.append('name', input.name)
  form.append('file', input.blob, input.name)

  const response = await fetch('/api/exports', { method: 'POST', body: form, signal: input.signal })
  if (!response.ok) throw new Error('Upload failed')
  return readCloudExportUpload(await response.json().catch(() => null))
}
