import { assertNever } from './assert'
import { isModulationOperationKind, type ModulationOperationKind } from './audio-effect-registry'
import type { NormalizedAudioEffectRow } from './audio-effect-normalization'
import type { SharedTimelineOperation } from './shared-timeline-operations'

const isModulationRow = (row: NormalizedAudioEffectRow): row is NormalizedAudioEffectRow<ModulationOperationKind> =>
  isModulationOperationKind(row.effect)

// The operation that persists one effect's params on a track, or on the master when no track is given. The
// modulation kinds share one operation that carries the kind; every other kind has its own.
export const buildEffectParamsOperation = (
  row: NormalizedAudioEffectRow,
  instanceId: string,
  trackId?: string,
): SharedTimelineOperation => {
  if (isModulationRow(row)) {
    return trackId === undefined
      ? { kind: 'effects.setMasterModulationParams', payload: { ...row, instanceId } }
      : { kind: 'effects.setModulationParams', payload: { ...row, instanceId, trackId } }
  }

  switch (row.effect) {
    case 'utility':
      return trackId === undefined
        ? { kind: 'effects.setMasterUtilityParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setUtilityParams', payload: { trackId, params: row.params, instanceId } }
    case 'eq':
      return trackId === undefined
        ? { kind: 'effects.setMasterEqParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setEqParams', payload: { trackId, params: row.params, instanceId } }
    case 'gate':
      return trackId === undefined
        ? { kind: 'effects.setMasterGateParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setGateParams', payload: { trackId, params: row.params, instanceId } }
    case 'limiter':
      return trackId === undefined
        ? { kind: 'effects.setMasterLimiterParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setLimiterParams', payload: { trackId, params: row.params, instanceId } }
    case 'compressor':
      return trackId === undefined
        ? { kind: 'effects.setMasterCompressorParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setCompressorParams', payload: { trackId, params: row.params, instanceId } }
    case 'saturator':
      return trackId === undefined
        ? { kind: 'effects.setMasterSaturatorParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setSaturatorParams', payload: { trackId, params: row.params, instanceId } }
    case 'delay':
      return trackId === undefined
        ? { kind: 'effects.setMasterDelayParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setDelayParams', payload: { trackId, params: row.params, instanceId } }
    case 'reverb':
      return trackId === undefined
        ? { kind: 'effects.setMasterReverbParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setReverbParams', payload: { trackId, params: row.params, instanceId } }
    case 'spectral':
      return trackId === undefined
        ? { kind: 'effects.setMasterSpectralParams', payload: { params: row.params, instanceId } }
        : { kind: 'effects.setSpectralParams', payload: { trackId, params: row.params, instanceId } }
    default:
      return assertNever(row)
  }
}
