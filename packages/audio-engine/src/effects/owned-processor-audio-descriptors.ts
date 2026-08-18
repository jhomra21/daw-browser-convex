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
  Object.entries(AUDIO_PARAM_STATE_PATHS).find(([key]) => key === parameterId)?.[1]
    ?? defaultStatePath(parameterId)

type OwnedProcessorState = ReturnType<typeof normalizeOwnedProcessorParams>['state']
type OwnedProcessorPathValue = OwnedProcessorState | number | string | boolean | null | undefined

const isObjectValue = (value: OwnedProcessorPathValue): value is Extract<OwnedProcessorPathValue, object> =>
  typeof value === 'object' && value !== null

const isNumberValue = (value: OwnedProcessorPathValue): value is number =>
  typeof value === 'number'

const readPath = (value: OwnedProcessorState, path: readonly string[]) => {
  let current: OwnedProcessorPathValue = value
  for (const key of path) {
    if (!isObjectValue(current)) return undefined
    current = Object.entries(current).find(([candidate]) => candidate === key)?.[1]
  }
  return isNumberValue(current) ? current : undefined
}

export const normalizeOwnedProcessorAudioState = (
  kind: OwnedProcessorKind,
  params: Parameters<typeof normalizeOwnedProcessorParams>[1],
) =>
  normalizeOwnedProcessorParams(kind, params).state

const audioParamValuesFromState = <State extends object>(kind: OwnedProcessorKind, state: State) =>
  OWNED_PROCESSOR_PARAMETER_IDS[kind].map((parameterId) => ({
    parameterId,
    value: readPath(state, statePath(parameterId)),
  }))

export const ownedProcessorAudioParamValuesFromState = <State extends object>(kind: OwnedProcessorKind, state: State) =>
  audioParamValuesFromState(kind, state)

export const ownedProcessorAudioParamValues = (
  kind: OwnedProcessorKind,
  params: Parameters<typeof normalizeOwnedProcessorParams>[1],
) => {
  const state = normalizeOwnedProcessorAudioState(kind, params)
  return audioParamValuesFromState(kind, state)
}
