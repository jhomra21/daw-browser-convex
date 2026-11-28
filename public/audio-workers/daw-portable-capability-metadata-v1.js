// The processor kind list is generated from the processor contract (packages/audio-core-contract). The remaining
// fields mirror packages/audio-engine/src/backends/portable-wasm-capabilities.ts; a worker test compares them.
export const portableWasmCapabilityMatrix = Object.freeze({
  version: 1,
  processorKinds: Object.freeze([
    // generated:processor-kinds:start
    'utility',
    'saturator',
    'eq',
    'chorus',
    'flanger',
    'phaser',
    'tremolo',
    'autopan',
    'ensemble',
    'gate',
    'compressor',
    'limiter',
    'delay',
    'reverb',
    'spectral',
    'autofilter',
    'lofi',
    // generated:processor-kinds:end
  ]),
  sidechains: true,
  synthMidi: true,
  mixerAutomation: true,
  fullBlockAutomation: true,
  processorEvents: true,
  chains: true,
  variableBlocks: true,
  nonfiniteInputSanitization: true,
  sampledInstruments: true,
  sampleRatesHz: Object.freeze([44100, 48000, 96000]),
  maxInputBuses: 2,
  maxChannels: 2,
  maxReverbProcessors: 32,
})
