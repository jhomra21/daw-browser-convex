import { sanitizeAudioSourceKind, type AudioSourceKind } from '@daw-browser/shared'

export const SAMPLE_DRAG_DATA_TYPE = 'application/x-mediabunny-sample'

export type SampleDragData = {
  url: string
  name?: string
  duration: number
  assetKey: string
  sourceKind: AudioSourceKind
  source: {
    durationSec: number
    sampleRate: number
    channelCount: number
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

export function serializeSampleDragData(sample: SampleDragData): string {
  return JSON.stringify({
    url: sample.url,
    name: sample.name,
    duration: sample.duration,
    assetKey: sample.assetKey,
    sourceKind: sample.sourceKind,
    source: sample.source,
  })
}

export function parseSampleDragData(raw: string): SampleDragData | null {
  try {
    const input = JSON.parse(raw)
    if (!isRecord(input)) return null
    const duration = input.duration
    const assetKey = input.assetKey
    const sourceKind = typeof input.sourceKind === 'string' ? sanitizeAudioSourceKind(input.sourceKind) : undefined
    const source = input.source
    if (!(typeof duration === 'number' && duration > 0)) return null
    if (typeof input.url !== 'string' || !input.url) return null
    if (typeof assetKey !== 'string' || !assetKey) return null
    if (!sourceKind) return null
    if (!isRecord(source)) return null
    const durationSec = source.durationSec
    const sampleRate = source.sampleRate
    const channelCount = source.channelCount
    if (!(typeof durationSec === 'number' && durationSec > 0)) return null
    if (!(typeof sampleRate === 'number' && sampleRate > 0)) return null
    if (!(typeof channelCount === 'number' && channelCount > 0)) return null
    return {
      url: input.url,
      name: typeof input.name === 'string' ? input.name : undefined,
      duration,
      assetKey,
      sourceKind,
      source: { durationSec, sampleRate, channelCount },
    }
  } catch {
    return null
  }
}
