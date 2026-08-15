type PortableWasmCapabilityMatrix = {
  version: 1
  processorKinds: readonly string[]
  sidechains: boolean
  synthMidi: boolean
  mixerAutomation: boolean
  fullBlockAutomation: boolean
  processorEvents: boolean
  chains: boolean
  variableBlocks: boolean
  nonfiniteInputSanitization: boolean
  sampledInstruments: boolean
  sampleRatesHz: readonly number[]
  maxInputBuses: number
  maxChannels: number
  maxReverbProcessors: number
}

/* The graph fixture suite asserts every entry in this coverage input. The
 * runtime matrix is derived from it rather than maintained independently. */
const portableWasmParityFixtureCoverage = {
  version: 1,
  processorKinds: ['utility', 'saturator', 'eq', 'autofilter', 'lofi', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble', 'gate', 'compressor', 'limiter', 'delay', 'reverb', 'spectral'],
  sidechains: true,
  synthMidi: true,
  mixerAutomation: true,
  fullBlockAutomation: true,
  processorEvents: true,
  chains: true,
  variableBlocks: true,
  nonfiniteInputSanitization: true,
  sampledInstruments: true,
  sampleRatesHz: [44_100, 48_000, 96_000],
  maxInputBuses: 2,
  maxChannels: 2,
  maxReverbProcessors: 32,
} satisfies PortableWasmCapabilityMatrix

export const portableWasmCapabilityMatrix: PortableWasmCapabilityMatrix = {
  ...portableWasmParityFixtureCoverage,
}
