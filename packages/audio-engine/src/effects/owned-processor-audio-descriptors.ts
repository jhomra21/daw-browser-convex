import {
  normalizeOwnedProcessorParams,
  OWNED_PROCESSOR_PARAMETER_IDS,
  type OwnedProcessorKind,
} from '@daw-browser/shared'

const AUDIO_PARAM_STATE_PATHS = {
  'limiter.ceiling': ['ceilingDbtp'],
  'limiter.release': ['releaseMs'],
  'autofilter.envelope.amountOctaves': ['envelope', 'amountOctaves'],
  'autofilter.envelope.attackMs': ['envelope', 'attackMs'],
  'autofilter.envelope.releaseMs': ['envelope', 'releaseMs'],
  'autofilter.lfo.rateHz': ['lfo', 'rateHz'],
  'autofilter.lfo.depthOctaves': ['lfo', 'depthOctaves'],
  'autofilter.lfo.phaseOffset': ['lfo', 'phaseOffset'],
  'autofilter.lfo.stereoPhase': ['lfo', 'stereoPhase'],
} satisfies Record<string, readonly string[]>

const defaultStatePath = (parameterId: string) => {
  const separator = parameterId.indexOf('.')
  return [parameterId.slice(separator + 1)]
}

const statePath = (parameterId: string) =>
  parameterId in AUDIO_PARAM_STATE_PATHS
    ? Reflect.get(AUDIO_PARAM_STATE_PATHS, parameterId)
    : defaultStatePath(parameterId)

const readPath = (value: object, path: readonly string[]) => {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return typeof current === 'number' ? current : undefined
}

export const normalizeOwnedProcessorAudioState = (kind: OwnedProcessorKind, params: unknown) =>
  normalizeOwnedProcessorParams(kind, params).state

export const ownedProcessorAudioParamValues = (kind: OwnedProcessorKind, params: unknown) => {
  const state = normalizeOwnedProcessorAudioState(kind, params)
  return OWNED_PROCESSOR_PARAMETER_IDS[kind].map((parameterId) => ({
    parameterId,
    value: readPath(state, statePath(parameterId)),
  }))
}
