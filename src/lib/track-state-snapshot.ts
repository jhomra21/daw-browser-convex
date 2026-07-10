import {
  isAudioEffectKind,
  isLocalId,
  normalizeCompressorParams,
  normalizeDelayParams,
  normalizeEqParams,
  normalizeReverbParams,
  normalizeSaturatorParams,
} from '@daw-browser/shared'
import { convexApi, convexClient } from '~/lib/convex'
import { buildTrackEffectQueryArgs } from '~/lib/effect-track-args'
import { readInstrumentParamsFromEffectRow } from '~/lib/effect-row-instrument-params'
import { audioEffectKindFromLocalEffect, listLocalEffects } from '~/lib/local-effects'
import type { Track } from '@daw-browser/timeline-core/types'
import type { TrackAudioEffectSnapshot, TrackEffectSnapshot } from '~/lib/undo/types'

type EffectRowSnapshotInput = {
  effect?: unknown
  type?: unknown
  instanceId?: unknown
  index?: unknown
  params?: any
}

const snapshotAudioEffectRow = (row: EffectRowSnapshotInput): TrackAudioEffectSnapshot | null => {
  const effect = row.type ?? row.effect
  if (!isAudioEffectKind(effect)) return null
  const instanceId = typeof row.instanceId === 'string' ? row.instanceId : undefined
  const index = typeof row.index === 'number' ? row.index : undefined
  switch (effect) {
    case 'eq':
      return { effect, instanceId, index, params: normalizeEqParams(row.params) }
    case 'compressor':
      return { effect, instanceId, index, params: normalizeCompressorParams(row.params) }
    case 'saturator':
      return { effect, instanceId, index, params: normalizeSaturatorParams(row.params) }
    case 'delay':
      return { effect, instanceId, index, params: normalizeDelayParams(row.params) }
    case 'reverb':
      return { effect, instanceId, index, params: normalizeReverbParams(row.params) }
  }
}

const buildEffectSnapshot = (rows: EffectRowSnapshotInput[]): TrackEffectSnapshot => {
  const audioEffects = rows.flatMap((row) => {
    const snapshot = snapshotAudioEffectRow(row)
    return snapshot ? [snapshot] : []
  })
  const instrument = rows.find((row) => row.type === 'instrument' || row.effect === 'instrument')
  const synth = rows.find((row) => row.type === 'synth' || row.effect === 'synth')
  const arp = rows.find((row) => row.type === 'arpeggiator' || row.effect === 'arp')
  return {
    audioEffects,
    instrument: instrument ? readInstrumentParamsFromEffectRow(instrument) : undefined,
    synth: synth?.params,
    arp: arp?.params,
  }
}

export const loadTrackEffectSnapshot = async (
  projectId: string,
  trackId: Track['id'],
): Promise<TrackEffectSnapshot> => {
  if (isLocalId('project', projectId)) {
    const rows = (await listLocalEffects(projectId))
      .filter((row) => row.targetId === trackId)
      .map((row) => ({ ...row, effect: audioEffectKindFromLocalEffect(row.effect) ?? row.effect }))
    return buildEffectSnapshot(rows)
  }
  const rows = await convexClient.query(
    convexApi.effects.listByTrack,
    buildTrackEffectQueryArgs({ projectId, trackId }),
  )
  return buildEffectSnapshot(rows)
}
