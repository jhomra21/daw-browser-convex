import {
  FlacOutputFormat,
  Mp3OutputFormat,
  OggOutputFormat,
  WavOutputFormat,
  canEncodeAudio,
  type AudioCodec,
  type OutputFormat,
} from 'mediabunny'
import { exportAudioFormats, type ExportAudioFormat } from '@daw-browser/shared'

type ExportAudioSupportRequest = {
  sampleRate?: number
  numberOfChannels?: number
}

type ExportAudioEncodingDescriptor = {
  codec: AudioCodec
  createOutputFormat: () => OutputFormat
  defaultBitrate?: number
}

const exportAudioEncodingDescriptors: Record<ExportAudioFormat, ExportAudioEncodingDescriptor> = {
  wav: {
    codec: 'pcm-s16',
    createOutputFormat: () => new WavOutputFormat(),
  },
  mp3: {
    codec: 'mp3',
    createOutputFormat: () => new Mp3OutputFormat(),
    defaultBitrate: 192000,
  },
  'ogg-opus': {
    codec: 'opus',
    createOutputFormat: () => new OggOutputFormat(),
    defaultBitrate: 128000,
  },
  flac: {
    codec: 'flac',
    createOutputFormat: () => new FlacOutputFormat(),
    defaultBitrate: 128000,
  },
}

export const getExportAudioCodec = (format: ExportAudioFormat): AudioCodec => {
  return exportAudioEncodingDescriptors[format].codec
}

export const getExportAudioDefaultBitrate = (format: ExportAudioFormat): number | undefined => {
  return exportAudioEncodingDescriptors[format].defaultBitrate
}

export const createExportAudioOutputFormat = (format: ExportAudioFormat): OutputFormat => {
  return exportAudioEncodingDescriptors[format].createOutputFormat()
}

export async function getSupportedExportAudioFormats(req: ExportAudioSupportRequest = {}): Promise<ExportAudioFormat[]> {
  const sampleRate = req.sampleRate ?? 44100
  const numberOfChannels = req.numberOfChannels ?? 2
  const supportChecks = exportAudioFormats.map(async (format): Promise<ExportAudioFormat | undefined> => {
    const codec = getExportAudioCodec(format)
    if (format === 'wav') return format
    const canEncode = await canEncodeAudio(codec, {
      sampleRate,
      numberOfChannels,
      bitrate: getExportAudioDefaultBitrate(format),
    })
    return canEncode ? format : undefined
  })
  const checkedFormats = await Promise.all(supportChecks)
  return checkedFormats.filter((format) => format !== undefined)
}
