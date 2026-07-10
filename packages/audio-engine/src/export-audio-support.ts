import {
  FlacOutputFormat,
  Mp3OutputFormat,
  OggOutputFormat,
  WavOutputFormat,
  canEncodeAudio,
  type AudioCodec,
  type OutputFormat,
} from 'mediabunny'
import {
  exportAudioFormats,
  getExportAudioBitrate,
  isLossyExportAudioFormat,
  type ExportAudioFormat,
  type LossyExportAudioFormat,
} from '@daw-browser/shared'

export type ExportAudioSupportRequest = {
  sampleRate?: number
  numberOfChannels?: number
  bitrateByFormat?: Partial<Record<LossyExportAudioFormat, number>>
}

type ExportAudioEncodingDescriptor = {
  codec: AudioCodec
  createOutputFormat: () => OutputFormat
  requiredBitrate?: number
}

const exportAudioEncodingDescriptors: Record<ExportAudioFormat, ExportAudioEncodingDescriptor> = {
  wav: {
    codec: 'pcm-s16',
    createOutputFormat: () => new WavOutputFormat(),
  },
  mp3: {
    codec: 'mp3',
    createOutputFormat: () => new Mp3OutputFormat(),
  },
  'ogg-opus': {
    codec: 'opus',
    createOutputFormat: () => new OggOutputFormat(),
  },
  flac: {
    codec: 'flac',
    createOutputFormat: () => new FlacOutputFormat(),
    requiredBitrate: 1411200,
  },
}

export const getExportAudioCodec = (format: ExportAudioFormat): AudioCodec => {
  return exportAudioEncodingDescriptors[format].codec
}

export const getExportAudioDefaultBitrate = (format: ExportAudioFormat): number | undefined => {
  return getExportAudioBitrate(format) ?? exportAudioEncodingDescriptors[format].requiredBitrate
}

export const getExportAudioEncodingConfig = (
  format: ExportAudioFormat,
  request: ExportAudioSupportRequest = {},
) => ({
  sampleRate: request.sampleRate ?? 44100,
  numberOfChannels: request.numberOfChannels ?? 2,
  bitrate: (isLossyExportAudioFormat(format) ? request.bitrateByFormat?.[format] : undefined)
    ?? getExportAudioDefaultBitrate(format),
})

export const createExportAudioOutputFormat = (format: ExportAudioFormat): OutputFormat => {
  return exportAudioEncodingDescriptors[format].createOutputFormat()
}

export async function getSupportedExportAudioFormats(req: ExportAudioSupportRequest = {}): Promise<ExportAudioFormat[]> {
  const supportChecks = exportAudioFormats.map(async (format): Promise<ExportAudioFormat | undefined> => {
    const codec = getExportAudioCodec(format)
    if (format === 'wav') return format
    const canEncode = await canEncodeAudio(codec, getExportAudioEncodingConfig(format, req))
    return canEncode ? format : undefined
  })
  const checkedFormats = await Promise.all(supportChecks)
  return checkedFormats.filter((format) => format !== undefined)
}
