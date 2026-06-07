import type { ExportAudioFormat } from '@daw-browser/shared'

let cachedSupportedExportAudioFormats: ExportAudioFormat[] | undefined
let supportedExportAudioFormatsPromise: Promise<ExportAudioFormat[]> | undefined

export const getCachedSupportedExportAudioFormats = (): ExportAudioFormat[] | undefined => (
  cachedSupportedExportAudioFormats
)

export const probeSupportedExportAudioFormats = (): Promise<ExportAudioFormat[]> => {
  if (cachedSupportedExportAudioFormats) return Promise.resolve(cachedSupportedExportAudioFormats)
  if (supportedExportAudioFormatsPromise) return supportedExportAudioFormatsPromise
  const supportPromise = import('@daw-browser/audio-engine/export-audio-support').then((exportAudioSupport) => (
    exportAudioSupport.getSupportedExportAudioFormats()
  )).then((formats) => {
    cachedSupportedExportAudioFormats = formats
    return formats
  }).catch(() => {
    const fallbackFormats = ['wav'] satisfies ExportAudioFormat[]
    cachedSupportedExportAudioFormats = fallbackFormats
    supportedExportAudioFormatsPromise = undefined
    return fallbackFormats
  })
  supportedExportAudioFormatsPromise = supportPromise
  return supportPromise
}

export const retrySupportedExportAudioFormats = (): Promise<ExportAudioFormat[]> => {
  supportedExportAudioFormatsPromise = undefined
  cachedSupportedExportAudioFormats = undefined
  return probeSupportedExportAudioFormats()
}
