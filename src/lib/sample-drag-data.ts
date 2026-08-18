import { isJsonNumber, isJsonObject, isJsonString, sanitizeAudioSourceKind, type AudioSourceKind, type JsonValue } from '@daw-browser/shared'

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
    const input: JsonValue = JSON.parse(raw)
    if (!isJsonObject(input)) return null
    const duration = input.duration
    const assetKey = input.assetKey
    const sourceKind = isJsonString(input.sourceKind) ? sanitizeAudioSourceKind(input.sourceKind) : undefined
    const source = input.source
    if (!(isJsonNumber(duration) && duration > 0)) return null
    if (!isJsonString(input.url) || !input.url) return null
    if (!isJsonString(assetKey) || !assetKey) return null
    if (!sourceKind) return null
    if (!isJsonObject(source)) return null
    const durationSec = source.durationSec
    const sampleRate = source.sampleRate
    const channelCount = source.channelCount
    if (!(isJsonNumber(durationSec) && durationSec > 0)) return null
    if (!(isJsonNumber(sampleRate) && sampleRate > 0)) return null
    if (!(isJsonNumber(channelCount) && channelCount > 0)) return null
    return {
      url: input.url,
      name: isJsonString(input.name) ? input.name : undefined,
      duration,
      assetKey,
      sourceKind,
      source: { durationSec, sampleRate, channelCount },
    }
  } catch {
    return null
  }
}
