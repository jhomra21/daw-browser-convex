import { computePortableWasmSourceHash } from './portable-wasm-source-hash'
import { z } from 'zod'

const artifactPath = Bun.argv[2]
const manifestPath = Bun.argv[3]

if (!artifactPath || !manifestPath) {
  throw new Error('Usage: bun validate-wasm-artifact.ts <artifact.wasm> <artifact.manifest.json>')
}

const manifestSchema = z.object({
  artifactKind: z.literal('production'),
  buildType: z.literal('Release'),
  lto: z.literal(true),
  fixedMemory: z.literal(true),
  sizeBytes: z.number(),
  maximumBytes: z.number(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough()

const manifestResult = manifestSchema.safeParse(await Bun.file(manifestPath).json())
if (!manifestResult.success) throw new Error(`Production Wasm manifest is invalid: ${manifestPath}`)
const manifest = manifestResult.data

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
