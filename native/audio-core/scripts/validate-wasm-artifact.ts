import { computePortableWasmSourceHash } from './portable-wasm-source-hash'

const artifactPath = Bun.argv[2]
const manifestPath = Bun.argv[3]

if (!artifactPath || !manifestPath) {
  throw new Error('Usage: bun validate-wasm-artifact.ts <artifact.wasm> <artifact.manifest.json>')
}

const manifest: unknown = await Bun.file(manifestPath).json()
if (typeof manifest !== 'object' || manifest === null
  || !('artifactKind' in manifest) || manifest.artifactKind !== 'production'
  || !('buildType' in manifest) || manifest.buildType !== 'Release'
  || !('lto' in manifest) || manifest.lto !== true
  || !('fixedMemory' in manifest) || manifest.fixedMemory !== true
  || !('sizeBytes' in manifest) || typeof manifest.sizeBytes !== 'number'
  || !('maximumBytes' in manifest) || typeof manifest.maximumBytes !== 'number'
  || !('sha256' in manifest) || typeof manifest.sha256 !== 'string'
  || !('sourceHash' in manifest) || typeof manifest.sourceHash !== 'string'
  || !/^[a-f0-9]{64}$/.test(manifest.sha256)
  || !/^[a-f0-9]{64}$/.test(manifest.sourceHash)) {
  throw new Error(`Production Wasm manifest is invalid: ${manifestPath}`)
}

const sourceHash = await computePortableWasmSourceHash(process.cwd())
if (sourceHash !== manifest.sourceHash) {
  throw new Error(`Production Wasm source hash does not match the current audio-core sources: ${manifestPath}`)
}

const bytes = await Bun.file(artifactPath).arrayBuffer()
if (bytes.byteLength !== manifest.sizeBytes) {
  throw new Error(`Production Wasm size does not match its manifest: ${artifactPath}`)
}
if (bytes.byteLength > manifest.maximumBytes) {
  throw new Error(
    `Production Wasm artifact exceeds its ${manifest.maximumBytes}-byte budget: ${bytes.byteLength}`,
  )
}

const sha256 = Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('')
if (sha256 !== manifest.sha256) {
  throw new Error(`Production Wasm hash does not match its manifest: ${artifactPath}`)
}

const module = await WebAssembly.compile(bytes)
const exports = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name))
for (const fixtureExport of [
  'daw_audio_core_wasm_harness_abi_version',
  'daw_audio_core_wasm_fixture_protocol_version',
  'daw_audio_core_graph_fixture_protocol_version',
  'daw_audio_core_run_utility_fixture',
  'daw_audio_core_run_graph_fixture',
]) {
  if (exports.has(fixtureExport)) {
    throw new Error(`Production Wasm artifact contains fixture export ${fixtureExport}.`)
  }
}
for (const requiredExport of [
  'memory',
  'malloc',
  'free',
  'daw_audio_core_get_abi_version',
  'daw_audio_core_wasm_graph_initialize_planar',
  'daw_audio_core_wasm_graph_prepare',
  'daw_audio_core_wasm_graph_publish',
  'daw_audio_core_wasm_graph_process_planar',
  'daw_audio_core_wasm_recording_capture_initialize',
  'daw_audio_core_wasm_recording_capture_process_monitor',
]) {
  if (!exports.has(requiredExport)) {
    throw new Error(`Production Wasm artifact is missing ABI export ${requiredExport}.`)
  }
}
