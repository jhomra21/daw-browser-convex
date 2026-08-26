import { isJsonObject, isJsonString, type ExportAudioFormat, type JsonValue } from '@daw-browser/shared'

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
}

const readCloudExportUpload = (value: JsonValue): CloudExportUpload => {
  if (!isJsonObject(value)) {
    throw new Error('Invalid upload response')
  }
  const url = isJsonString(value.url) ? value.url : ''
  if (!url) throw new Error('Invalid upload response')
  return { url }
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
