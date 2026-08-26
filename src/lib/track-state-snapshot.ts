import {
  isAudioEffectKind,
  isLocalId,
  AUDIO_EFFECT_CONTRACTS,
  normalizeArpeggiatorParams,
  normalizeSynthParams,
} from '@daw-browser/shared'
import { convexApi, convexClient } from '~/lib/convex'
import { buildTrackEffectQueryArgs } from '~/lib/effect-track-args'
import { readInstrumentParamsFromEffectRow } from '~/lib/effect-row-instrument-params'
import { audioEffectKindFromLocalEffect, listLocalEffects } from '~/lib/local-effects'
import type { Track } from '@daw-browser/timeline-core/types'
import type { TrackAudioEffectSnapshot, TrackEffectSnapshot } from '~/lib/undo/types'
import { z } from 'zod'

type EffectRowSnapshotInput = {
  effect?: unknown
  type?: unknown
  instanceId?: unknown
  index?: unknown
  params?: unknown
}
const effectRowSnapshotSchema = z.object({
  effect: z.string().optional(),
  type: z.string().optional(),
  instanceId: z.string().optional(),
  index: z.number().optional(),
  params: z.json(),
})
const normalizationInput = (value: z.infer<typeof effectRowSnapshotSchema>['params']) => (
  JSON.parse(JSON.stringify(value))
)

const snapshotAudioEffectRow = (row: EffectRowSnapshotInput): TrackAudioEffectSnapshot | null => {
  const parsed = effectRowSnapshotSchema.safeParse(row)
  if (!parsed.success) return null
  const effect = parsed.data.type ?? parsed.data.effect
  if (effect === undefined || !isAudioEffectKind(effect)) return null
  const { instanceId, index, params } = parsed.data
  switch (effect) {
    case 'utility':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.utility.normalizeParams(params) }
    case 'eq':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams(normalizationInput(params)) }
    case 'autofilter':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(params) }
    case 'gate':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.gate.normalizeParams(params) }
    case 'compressor':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams(normalizationInput(params)) }
    case 'saturator':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams(normalizationInput(params)) }
    case 'limiter':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(params) }
    case 'lofi':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(params) }
    case 'delay':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams(normalizationInput(params)) }
    case 'reverb':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams(normalizationInput(params)) }
    case 'spectral':
      return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(params) }
    case 'chorus': return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(params) }
    case 'flanger': return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(params) }
    case 'phaser': return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(params) }
    case 'tremolo': return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(params) }
    case 'autopan': return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(params) }
    case 'ensemble': return { effect, instanceId, index, params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(params) }
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
  const synthParams = z.json().safeParse(synth?.params)
  const arpParams = z.json().safeParse(arp?.params)
  return {
    audioEffects,
    instrument: instrument ? readInstrumentParamsFromEffectRow(instrument) : undefined,
    synth: synthParams.success ? normalizeSynthParams(normalizationInput(synthParams.data)) : undefined,
    arp: arpParams.success ? normalizeArpeggiatorParams(normalizationInput(arpParams.data)) : undefined,
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
