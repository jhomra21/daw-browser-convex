export const PROCESSOR_RESOURCE_LIMITS = {
  effectsPerChain: 16,
  liveOwnedWorklets: 64,
  offlineOwnedWorklets: 256,
} as const

export function assertEffectChainResourceLimit(effectCount: number): void {
  if (!Number.isInteger(effectCount) || effectCount < 0 || effectCount > PROCESSOR_RESOURCE_LIMITS.effectsPerChain) {
    throw new RangeError(`Effect chain exceeds the ${PROCESSOR_RESOURCE_LIMITS.effectsPerChain} effect limit.`)
  }
}
