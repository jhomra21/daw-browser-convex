/**
 * Numerical acceptance bounds used by production DSP characterization.
 *
 * These values centralize thresholds that were already enforced by the
 * characterization/parity suites. Moving a value here does not loosen or
 * tighten an existing acceptance gate.
 */
export const OWNED_DSP_NUMERICAL_TOLERANCES = {
  sampleAbsolute: 1e-6,
  graphParityAbsolute: 1e-4,
  legacyBridgeAbsolute: 5e-4,
} as const

/**
 * Browser-native Web Audio nodes vary by browser implementation, so their
 * acceptance policy is expressed as bounded invariants instead of bit parity.
 */
export const BROWSER_AUDIO_NUMERICAL_TOLERANCES = {
  scalarPeakAbsolute: 1e-3,
  silentChannelPeakMaximum: 1e-6,
  workletPassthroughAbsolute: 1e-6,
  sampleRateConversion: {
    gainErrorDbMaximum: 0.25,
    passbandRippleDbMaximum: 0.5,
    aliasLevelDbMaximum: -60,
    phaseDelayFramesMaximum: 1,
    isolationDbMaximum: -120,
  },
} as const
