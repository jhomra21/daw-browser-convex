export const SIDECHAIN_EFFECT_KINDS = ['compressor', 'gate', 'spectral'] as const

export const isSidechainEffectKind = (kind: string) =>
  SIDECHAIN_EFFECT_KINDS.some((candidate) => candidate === kind)

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
    || !isSidechainEffectKind(input.effectKind)
    || !input.effectInstanceId
  ) return 'Sidechain target must identify exactly one compressor, gate, or spectral instance.'
  return undefined
}
