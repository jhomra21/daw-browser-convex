import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const portableWasmBuildInputPaths = [
  'native/CMakeLists.txt',
  'native/audio-core/CMakeLists.txt',
  'native/audio-core/include/daw/audio_core.h',
  'native/audio-core/generated/processor_contract_generated.h',
  'native/audio-core/src/audio_core.cpp',
  'native/audio-core/src/wasm_entry.cpp',
] as const

const defaultRepositoryRoot = path.resolve(import.meta.dir, '../../..')

export const computePortableWasmSourceHash = async (
  repositoryRoot = defaultRepositoryRoot,
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
  console.log(await computePortableWasmSourceHash())
}
