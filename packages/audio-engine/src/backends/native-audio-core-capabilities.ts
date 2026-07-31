import { processorRegistry } from '../../../audio-core-contract/src/generated/processor-contract-metadata'

/**
 * Native support is defined by the generated audio-core contract registry.
 * The native core's processor implementation table covers every registered
 * processor; browser/Wasm fixture coverage remains a separate capability.
 */
export const nativeAudioCoreProcessorKinds = new Set(
  processorRegistry.map((processor) => processor.name),
)
