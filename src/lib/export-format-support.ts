import { exportAudioFormats, getExportAudioBitrate, type ExportAudioFormat } from '@daw-browser/shared'
import type { ExportAudioSupportRequest } from '@daw-browser/audio-engine/export-audio-support'

const supportedFormatsByConfiguration = new Map<string, ExportAudioFormat[]>()
const supportPromisesByConfiguration = new Map<string, Promise<ExportAudioFormat[]>>()

const getSupportKey = (request: ExportAudioSupportRequest): string => JSON.stringify([
  request.sampleRate ?? 44100,
  request.numberOfChannels ?? 2,
  ...exportAudioFormats.map((format) => request.bitrateByFormat?.[format] ?? getExportAudioBitrate(format)),
])

export const getCachedSupportedExportAudioFormats = (
  request: ExportAudioSupportRequest,
): ExportAudioFormat[] | undefined => supportedFormatsByConfiguration.get(getSupportKey(request))

export const probeSupportedExportAudioFormats = (
  request: ExportAudioSupportRequest,
): Promise<ExportAudioFormat[]> => {
  const key = getSupportKey(request)
  const cached = supportedFormatsByConfiguration.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = supportPromisesByConfiguration.get(key)
  if (pending) return pending
  const supportPromise = import('@daw-browser/audio-engine/export-audio-support').then((exportAudioSupport) => (
    exportAudioSupport.getSupportedExportAudioFormats(request)
  )).then((formats) => {
    supportedFormatsByConfiguration.set(key, formats)
    return formats
  }).catch(() => (
    ['wav'] satisfies ExportAudioFormat[]
  )).finally(() => {
    supportPromisesByConfiguration.delete(key)
  })
  supportPromisesByConfiguration.set(key, supportPromise)
  return supportPromise
}
