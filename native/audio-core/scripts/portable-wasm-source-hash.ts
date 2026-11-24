import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const portableWasmBuildInputPaths = [
  'native/CMakeLists.txt',
  'native/audio-core/CMakeLists.txt',
  'native/audio-core/include/daw/audio_core.h',
  'native/audio-core/include/daw/graph_latency.h',
  'native/audio-core/generated/processor_contract_generated.h',
  'native/audio-core/src/audio_core_internal.h',
  'native/audio-core/src/audio_core.cpp',
  'native/audio-core/src/audio_core_assets.cpp',
  'native/audio-core/src/audio_core_graph_prepare.cpp',
  'native/audio-core/src/audio_core_graph_render.cpp',
  'native/audio-core/src/audio_core_instruments.cpp',
  'native/audio-core/src/audio_core_mixer.cpp',
  'native/audio-core/src/audio_core_native_hooks.cpp',
  'native/audio-core/src/audio_core_parameters.cpp',
  'native/audio-core/src/audio_core_prepare.cpp',
  'native/audio-core/src/audio_core_process.cpp',
  'native/audio-core/src/audio_core_publication.cpp',
  'native/audio-core/src/audio_core_recording.cpp',
  'native/audio-core/src/audio_core_slots.cpp',
  'native/audio-core/src/audio_core_sources.cpp',
  'native/audio-core/src/audio_core_validation.cpp',
  'native/audio-core/src/audio_core_wasm.cpp',
  'native/audio-core/src/autofilter_kernel.h',
  'native/audio-core/src/dsp/adaa.h',
  'native/audio-core/src/dsp/half_band_oversampler.h',
  'native/audio-core/src/dsp/latency.h',
  'native/audio-core/src/dsp/numeric_safety.h',
  'native/audio-core/src/dsp/parameter_smoother.h',
  'native/audio-core/src/processor_autofilter.cpp',
  'native/audio-core/src/processor_delay.cpp',
  'native/audio-core/src/processor_dynamics.cpp',
  'native/audio-core/src/processor_eq.cpp',
  'native/audio-core/src/processor_lofi.cpp',
  'native/audio-core/src/processor_modulation.cpp',
  'native/audio-core/src/processor_registry.cpp',
  'native/audio-core/src/processor_reverb.cpp',
  'native/audio-core/src/processor_saturator.cpp',
  'native/audio-core/src/processor_spectral.cpp',
  'native/audio-core/src/processor_utility.cpp',
  'native/audio-core/src/wasm_entry.cpp',
] as const

export const computePortableWasmSourceHash = async (
  repositoryRoot: string,
): Promise<string> => {
  const hash = createHash('sha256')

  for (const sourcePath of portableWasmBuildInputPaths) {
    const bytes = await readFile(path.join(repositoryRoot, sourcePath))
    hash.update(`path:${sourcePath.length}:${sourcePath}\n`)
    hash.update(`bytes:${bytes.byteLength}\n`)
    hash.update(bytes)
    hash.update('\n')
  }

  return hash.digest('hex')
}

if (import.meta.main) {
  console.log(await computePortableWasmSourceHash(process.cwd()))
}
