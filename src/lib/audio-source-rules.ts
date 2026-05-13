export type AudioSourceKind = 'upload' | 'url' | 'recording'

export type AudioSourceMetadataPatchInput = {
  assetKey?: string
  sourceKind?: string
  durationSec?: number
  sampleRate?: number
  channelCount?: number
}

export type AudioSourceMetadataPatch = {
  assetKey?: string
  sourceKind?: AudioSourceKind
  durationSec?: number
  sampleRate?: number
  channelCount?: number
}

export type ClipAudioSourceFields = {
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  sourceDurationSec?: number
  sourceSampleRate?: number
  sourceChannelCount?: number
}

export function sanitizePositiveNumber(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

export function sanitizePositiveInt(value: number | undefined) {
  const normalized = sanitizePositiveNumber(value)
  if (normalized === undefined) return undefined
  return Math.max(1, Math.round(normalized))
}

export function sanitizeAudioAssetKey(value: string | undefined) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function sanitizeAudioSourceKind(value: string | undefined): AudioSourceKind | undefined {
  if (value === 'upload' || value === 'url' || value === 'recording') return value
  return undefined
}

export function normalizeAudioSourceMetadataPatch(
  input: AudioSourceMetadataPatchInput,
): AudioSourceMetadataPatch {
  return {
    assetKey: sanitizeAudioAssetKey(input.assetKey),
    sourceKind: sanitizeAudioSourceKind(input.sourceKind),
    durationSec: sanitizePositiveNumber(input.durationSec),
    sampleRate: sanitizePositiveInt(input.sampleRate),
    channelCount: sanitizePositiveInt(input.channelCount),
  }
}

export function buildClipAudioSourceFields(metadata: AudioSourceMetadataPatch): ClipAudioSourceFields {
  const patch: ClipAudioSourceFields = {}
  if (metadata.assetKey !== undefined) patch.sourceAssetKey = metadata.assetKey
  if (metadata.sourceKind !== undefined) patch.sourceKind = metadata.sourceKind
  if (metadata.durationSec !== undefined) patch.sourceDurationSec = metadata.durationSec
  if (metadata.sampleRate !== undefined) patch.sourceSampleRate = metadata.sampleRate
  if (metadata.channelCount !== undefined) patch.sourceChannelCount = metadata.channelCount
  return patch
}
