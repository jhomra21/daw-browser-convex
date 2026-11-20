import { isSidechainCapableKind } from './audio-effect-registry'

export const sidechainEligibilityError = (input: {
  sourceTrackId: string
  targetTrackId: string
  effectTargetTrackId?: string
  effectKind: string
  effectInstanceId?: string
}) => {
  if (input.sourceTrackId === input.targetTrackId) return 'An effect cannot sidechain from its own track.'

  return sidechainTargetEligibilityError(input)
}

export const sidechainTargetEligibilityError = (input: {
  targetTrackId: string
  effectTargetTrackId?: string
  effectKind: string
  effectInstanceId?: string
}) => {
  if (
    input.effectTargetTrackId !== input.targetTrackId
    || !isSidechainCapableKind(input.effectKind)
    || !input.effectInstanceId
  ) return 'Sidechain target must identify exactly one compressor, gate, or spectral instance.'

  return undefined
}
