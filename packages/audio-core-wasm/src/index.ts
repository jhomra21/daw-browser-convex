import { audioCoreContractVersion } from '../../audio-core-contract/src/index'
import { processorContractHash } from '../../audio-core-contract/src/generated/processor-contract-metadata'

export const audioCoreWasmAbiVersion = 3
export const audioCoreWasmArtifactVersion = 2

export type AudioCoreWasmArtifactManifest = {
  version: typeof audioCoreWasmArtifactVersion
  abiVersion: typeof audioCoreWasmAbiVersion
  contractVersion: typeof audioCoreContractVersion
  contractHash: string
  fixedMemory: true
  memoryBytes: number
  sha256: string
  wasmUrl: string
}

export type AudioCoreWasmArtifact = {
  manifest: AudioCoreWasmArtifactManifest
  bytes: ArrayBuffer
  module: WebAssembly.Module
}

export type AudioCoreWasmArtifactFailure =
  | 'artifact-unavailable'
  | 'manifest-invalid'
  | 'abi-mismatch'
  | 'contract-mismatch'
  | 'memory-not-fixed'
  | 'wasm-invalid'

export type AudioCoreWasmArtifactResult =
  | { available: true; artifact: AudioCoreWasmArtifact }
  | { available: false; reason: AudioCoreWasmArtifactFailure; message: string }

type ArtifactFetch = (input: string) => Promise<{ ok: boolean; json: () => Promise<JsonValue>; arrayBuffer: () => Promise<ArrayBuffer> }>
type AvailableAudioCoreWasmArtifact = Extract<AudioCoreWasmArtifactResult, { available: true }>

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
type JsonObject = { [key: string]: JsonValue }

const isObject = (value: JsonValue): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const isNumber = (value: JsonValue): value is number => typeof value === 'number'
const isString = (value: JsonValue): value is string => typeof value === 'string'
const isBoolean = (value: JsonValue): value is boolean => typeof value === 'boolean'

const artifactCache = new Map<string, Promise<AvailableAudioCoreWasmArtifact>>()

const isRecord = isObject

const readUnsignedLeb128 = (bytes: Uint8Array, offset: number) => {
  let value = 0
  let shift = 0
  let index = offset
  while (index < bytes.length && shift < 35) {
    const byte = bytes[index]
    if (byte === undefined) return null
    value += (byte & 0x7f) * 2 ** shift
    index += 1
    if ((byte & 0x80) === 0) return { value, nextOffset: index }
    shift += 7
  }
  return null
}

const hasFixedDeclaredMemory = (bytes: ArrayBuffer, memoryBytes: number) => {
  const wasm = new Uint8Array(bytes)
  if (wasm.length < 8
    || wasm[0] !== 0
    || wasm[1] !== 0x61
    || wasm[2] !== 0x73
    || wasm[3] !== 0x6d) return false
  let offset = 8
  while (offset < wasm.length) {
    const sectionId = wasm[offset]
    if (sectionId === undefined) return false
    const sectionSize = readUnsignedLeb128(wasm, offset + 1)
    if (!sectionSize) return false
    const sectionStart = sectionSize.nextOffset
    const sectionEnd = sectionStart + sectionSize.value
    if (sectionEnd > wasm.length) return false
    if (sectionId === 5) {
      const count = readUnsignedLeb128(wasm, sectionStart)
      if (!count || count.value !== 1) return false
      const limits = readUnsignedLeb128(wasm, count.nextOffset)
      if (!limits || limits.value !== 1) return false
      const minimum = readUnsignedLeb128(wasm, limits.nextOffset)
      const maximum = minimum && readUnsignedLeb128(wasm, minimum.nextOffset)
      return minimum !== null
        && maximum !== null
        && minimum.value === maximum.value
        && minimum.value * 65_536 === memoryBytes
        && maximum.nextOffset === sectionEnd
    }
    offset = sectionEnd
  }
  return false
}

const readCachedArtifact = async (
  cacheKey: string,
  pending: Promise<AvailableAudioCoreWasmArtifact>,
): Promise<AudioCoreWasmArtifactResult> => {
  try {
    return await pending
  } catch (error) {
    if (artifactCache.get(cacheKey) === pending) artifactCache.delete(cacheKey)
    const reason = error instanceof Error ? error.message : 'wasm-invalid'
    if (reason === 'artifact-unavailable') {
      return { available: false, reason, message: 'Portable audio-core Wasm binary is unavailable.' }
    }
    if (reason === 'memory-not-fixed') {
      return { available: false, reason, message: 'Portable audio-core Wasm memory must be fixed.' }
    }
    return { available: false, reason: 'wasm-invalid', message: 'Portable audio-core Wasm binary is invalid.' }
  }
}

export async function loadAudioCoreWasmArtifact(
  manifestUrl: string,
  fetchArtifact: ArtifactFetch = (input) => fetch(input),
): Promise<AudioCoreWasmArtifactResult> {
  let manifestResponse: Awaited<ReturnType<ArtifactFetch>>
  try {
    manifestResponse = await fetchArtifact(manifestUrl)
  } catch {
    return { available: false, reason: 'artifact-unavailable', message: 'Portable audio-core Wasm manifest is unavailable.' }
  }
  if (!manifestResponse.ok) return { available: false, reason: 'artifact-unavailable', message: 'Portable audio-core Wasm manifest is unavailable.' }

  let unknownManifest: JsonValue
  try {
    unknownManifest = await manifestResponse.json()
  } catch {
    return { available: false, reason: 'manifest-invalid', message: 'Portable audio-core Wasm manifest is invalid.' }
  }
  if (!isRecord(unknownManifest)
    || unknownManifest.version !== audioCoreWasmArtifactVersion
    || !isNumber(unknownManifest.abiVersion)
    || !isNumber(unknownManifest.contractVersion)
    || !isString(unknownManifest.contractHash)
    || !isBoolean(unknownManifest.fixedMemory)
    || !isNumber(unknownManifest.memoryBytes)
    || !Number.isSafeInteger(unknownManifest.memoryBytes)
    || unknownManifest.memoryBytes <= 0
    || !isString(unknownManifest.sha256)
    || !/^[0-9a-f]{64}$/.test(unknownManifest.sha256)
    || !isString(unknownManifest.wasmUrl)
    || unknownManifest.wasmUrl.length === 0) {
    return { available: false, reason: 'manifest-invalid', message: 'Portable audio-core Wasm manifest is invalid.' }
  }
  if (unknownManifest.abiVersion !== audioCoreWasmAbiVersion) return { available: false, reason: 'abi-mismatch', message: 'Portable audio-core Wasm ABI is incompatible.' }
  if (unknownManifest.contractVersion !== audioCoreContractVersion || unknownManifest.contractHash !== processorContractHash) return { available: false, reason: 'contract-mismatch', message: 'Portable audio-core Wasm contract hash is incompatible.' }
  if (!unknownManifest.fixedMemory) return { available: false, reason: 'memory-not-fixed', message: 'Portable audio-core Wasm memory must be fixed.' }
  const manifest: AudioCoreWasmArtifactManifest = {
    version: audioCoreWasmArtifactVersion,
    abiVersion: audioCoreWasmAbiVersion,
    contractVersion: audioCoreContractVersion,
    contractHash: unknownManifest.contractHash,
    fixedMemory: true,
    memoryBytes: unknownManifest.memoryBytes,
    sha256: unknownManifest.sha256,
    wasmUrl: unknownManifest.wasmUrl,
  }

  const cacheKey = [
    manifestUrl,
    manifest.version,
    manifest.abiVersion,
    manifest.contractVersion,
    manifest.contractHash,
    manifest.memoryBytes,
    manifest.sha256,
    manifest.wasmUrl,
  ].join(':')
  const cached = artifactCache.get(cacheKey)
  if (cached) return readCachedArtifact(cacheKey, cached)

  const pending = (async (): Promise<AvailableAudioCoreWasmArtifact> => {
    let wasmResponse: Awaited<ReturnType<ArtifactFetch>>
    try {
      wasmResponse = await fetchArtifact(manifest.wasmUrl)
    } catch {
      throw new Error('artifact-unavailable')
    }
    if (!wasmResponse.ok) throw new Error('artifact-unavailable')
    const bytes = await wasmResponse.arrayBuffer()
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    if (hash !== manifest.sha256) throw new Error('wasm-invalid')
    const module = await WebAssembly.compile(bytes)
    if (!hasFixedDeclaredMemory(bytes, manifest.memoryBytes)) throw new Error('memory-not-fixed')
    return {
      available: true,
      artifact: { manifest, bytes, module },
    }
  })()
  artifactCache.set(cacheKey, pending)
  return readCachedArtifact(cacheKey, pending)
}
