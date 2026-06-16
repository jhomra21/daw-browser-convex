import type { PeakAssetRecord, WaveformSourceIdentity } from './types'

const IDENTITY_EPSILON = 1e-3

function nearlyEqual(left: number | undefined, right: number | undefined) {
  if (left === undefined || right === undefined) return true
  return Math.abs(left - right) <= IDENTITY_EPSILON
}

export function createWaveformSourceIdentity(input: WaveformSourceIdentity): WaveformSourceIdentity {
  return {
    assetKey: input.assetKey,
    durationSec: input.durationSec,
    sampleRate: input.sampleRate,
    channelCount: input.channelCount,
  }
}

export function peakAssetMatchesSourceIdentity(
  record: PeakAssetRecord,
  identity: WaveformSourceIdentity | undefined,
) {
  if (!identity) return true
  if (record.assetKey !== identity.assetKey) return false
  if (!nearlyEqual(record.durationSec, identity.durationSec)) return false
  if (identity.sampleRate !== undefined && record.sampleRate !== identity.sampleRate) return false
  if (identity.channelCount !== undefined && record.channelCount !== identity.channelCount) return false
  return true
}
