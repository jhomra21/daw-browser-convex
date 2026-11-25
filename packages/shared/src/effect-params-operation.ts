import { assertNever } from './assert'
import { isModulationOperationKind, type ModulationOperationKind } from './audio-effect-registry'
import type { NormalizedAudioEffectRow } from './audio-effect-normalization'
import type { SharedTimelineOperation } from './shared-timeline-operations'

const isModulationRow = (row: NormalizedAudioEffectRow): row is NormalizedAudioEffectRow<ModulationOperationKind> =>
  isModulationOperationKind(row.effect)

// The operation that persists one effect's params on a track, or on the master when no track is given. The
// modulation kinds share one operation that carries the kind; every other kind has its own. `paramsVersion` is the
// version the params were written at; a client passes its own AUDIO_EFFECT_PARAMS_VERSION for the kind.
export const buildEffectParamsOperation = (
  row: NormalizedAudioEffectRow,
  instanceId: string,
  trackId?: string,
  paramsVersion?: number,
): SharedTimelineOperation => {
  if (isModulationRow(row)) {
    return trackId === undefined
      ? { kind: 'effects.setMasterModulationParams', payload: { ...row, instanceId, paramsVersion } }
      : { kind: 'effects.setModulationParams', payload: { ...row, instanceId, trackId, paramsVersion } }
  }

  switch (row.effect) {
    case 'utility':
      return trackId === undefined
        ? { kind: 'effects.setMasterUtilityParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setUtilityParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    case 'eq':
      return trackId === undefined
        ? { kind: 'effects.setMasterEqParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setEqParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    case 'gate':
      return trackId === undefined
        ? { kind: 'effects.setMasterGateParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setGateParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    case 'limiter':
      return trackId === undefined
        ? { kind: 'effects.setMasterLimiterParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setLimiterParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    case 'compressor':
      return trackId === undefined
        ? { kind: 'effects.setMasterCompressorParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setCompressorParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    case 'saturator':
      return trackId === undefined
        ? { kind: 'effects.setMasterSaturatorParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setSaturatorParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    case 'delay':
      return trackId === undefined
        ? { kind: 'effects.setMasterDelayParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setDelayParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    case 'reverb':
      return trackId === undefined
        ? { kind: 'effects.setMasterReverbParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setReverbParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    case 'spectral':
      return trackId === undefined
        ? { kind: 'effects.setMasterSpectralParams', payload: { params: row.params, instanceId, paramsVersion } }
        : { kind: 'effects.setSpectralParams', payload: { trackId, params: row.params, instanceId, paramsVersion } }
    default:
      return assertNever(row)
  }
}
