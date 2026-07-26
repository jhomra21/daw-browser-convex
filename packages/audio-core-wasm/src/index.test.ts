import { expect, test } from 'bun:test'
import { audioCoreContractVersion } from '../../audio-core-contract/src/index'
import { processorContractHash } from '../../audio-core-contract/src/generated/processor-contract-metadata'
import { audioCoreWasmAbiVersion, loadAudioCoreWasmArtifact } from './index'

const manifest = {
  version: 1,
  abiVersion: audioCoreWasmAbiVersion,
  contractVersion: audioCoreContractVersion,
  contractHash: processorContractHash,
  fixedMemory: true,
  memoryBytes: 16_777_216,
  sha256: '0'.repeat(64),
  wasmUrl: '/audio-core.wasm',
}

const fetchFrom = (responses: Map<string, { ok: boolean; json?: unknown; bytes?: ArrayBuffer }>) =>
  async (url: string) => {
    const response = responses.get(url)
    if (!response) throw new Error('missing')
    return {
      ok: response.ok,
      json: async () => response.json,
      arrayBuffer: async () => response.bytes ?? new ArrayBuffer(0),
    }
  }

test('rejects a missing portable Wasm manifest before selection', async () => {
  const result = await loadAudioCoreWasmArtifact('/manifest.json', fetchFrom(new Map()))
  expect(result).toEqual({ available: false, reason: 'artifact-unavailable', message: 'Portable audio-core Wasm manifest is unavailable.' })
})

test('rejects incompatible portable Wasm contract and ABI manifests', async () => {
  const incompatibleContract = await loadAudioCoreWasmArtifact('/manifest.json', fetchFrom(new Map([
    ['/manifest.json', { ok: true, json: { ...manifest, contractHash: 'wrong' } }],
  ])))
  expect(incompatibleContract).toMatchObject({ available: false, reason: 'contract-mismatch' })

  const incompatibleAbi = await loadAudioCoreWasmArtifact('/manifest.json', fetchFrom(new Map([
    ['/manifest.json', { ok: true, json: { ...manifest, abiVersion: 2 } }],
  ])))
  expect(incompatibleAbi).toMatchObject({ available: false, reason: 'abi-mismatch' })
})

test('accepts a fixed-memory artifact only when its hash matches', async () => {
  const bytes = new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    5, 4, 1, 1, 1, 1,
  ]).buffer
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const result = await loadAudioCoreWasmArtifact('/manifest.json', fetchFrom(new Map([
    ['/manifest.json', { ok: true, json: { ...manifest, memoryBytes: 65_536, sha256 } }],
    ['/audio-core.wasm', { ok: true, bytes }],
  ])))

  expect(result.available).toBe(true)
})

test('rejects corrupt portable Wasm bytes even when the manifest hash matches', async () => {
  const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d]).buffer
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const result = await loadAudioCoreWasmArtifact('/manifest.json', fetchFrom(new Map([
    ['/manifest.json', { ok: true, json: { ...manifest, memoryBytes: 65_536, sha256 } }],
    ['/audio-core.wasm', { ok: true, bytes }],
  ])))

  expect(result).toMatchObject({ available: false, reason: 'wasm-invalid' })
})

test('rejects Wasm binaries that do not declare the manifest fixed memory size', async () => {
  const bytes = new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    5, 3, 1, 0, 1,
  ]).buffer
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const result = await loadAudioCoreWasmArtifact('/manifest.json', fetchFrom(new Map([
    ['/manifest.json', { ok: true, json: { ...manifest, memoryBytes: 65_536, sha256 } }],
    ['/audio-core.wasm', { ok: true, bytes }],
  ])))

  expect(result).toMatchObject({ available: false, reason: 'memory-not-fixed' })
})

test('shares one validated Wasm artifact across concurrent and repeated loads', async () => {
  const bytes = new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    5, 4, 1, 1, 1, 1,
  ]).buffer
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  let manifestFetches = 0
  let binaryFetches = 0
  const fetchArtifact = async (url: string) => {
    if (url === '/cached.manifest.json') {
      manifestFetches += 1
      return {
        ok: true,
        json: async () => ({ ...manifest, memoryBytes: 65_536, sha256, wasmUrl: '/cached.wasm' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }
    binaryFetches += 1
    return {
      ok: true,
      json: async () => undefined,
      arrayBuffer: async () => bytes,
    }
  }

  const first = loadAudioCoreWasmArtifact('/cached.manifest.json', fetchArtifact)
  const second = loadAudioCoreWasmArtifact('/cached.manifest.json', fetchArtifact)
  const [firstResult, secondResult] = await Promise.all([first, second])
  const repeatedResult = await loadAudioCoreWasmArtifact('/cached.manifest.json', fetchArtifact)
  if (!firstResult.available || !secondResult.available || !repeatedResult.available) {
    throw new Error('Expected cached portable Wasm artifacts.')
  }

  expect(manifestFetches).toBe(3)
  expect(binaryFetches).toBe(1)
  expect(secondResult.artifact.module).toBe(firstResult.artifact.module)
  expect(repeatedResult.artifact.module).toBe(firstResult.artifact.module)
})

test('invalidates the artifact cache when the manifest hash or version changes', async () => {
  const firstBytes = new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    5, 4, 1, 1, 1, 1,
  ]).buffer
  const secondBytes = new Uint8Array([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    5, 4, 1, 1, 1, 1,
    0, 1, 0,
  ]).buffer
  const hash = async (bytes: ArrayBuffer) => Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const firstHash = await hash(firstBytes)
  const secondHash = await hash(secondBytes)
  let currentHash = firstHash
  let binaryFetches = 0
  const fetchArtifact = async (url: string) => {
    if (url === '/changing.manifest.json') {
      return {
        ok: true,
        json: async () => ({ ...manifest, memoryBytes: 65_536, sha256: currentHash, wasmUrl: '/changing.wasm' }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }
    binaryFetches += 1
    return {
      ok: true,
      json: async () => undefined,
      arrayBuffer: async () => currentHash === firstHash ? firstBytes : secondBytes,
    }
  }

  const first = await loadAudioCoreWasmArtifact('/changing.manifest.json', fetchArtifact)
  currentHash = secondHash
  const second = await loadAudioCoreWasmArtifact('/changing.manifest.json', fetchArtifact)
  if (!first.available || !second.available) throw new Error('Expected changing portable Wasm artifacts.')
  expect(binaryFetches).toBe(2)
  expect(second.artifact.module).not.toBe(first.artifact.module)

  const incompatibleVersion = await loadAudioCoreWasmArtifact('/changing.manifest.json', async () => ({
    ok: true,
    json: async () => ({ ...manifest, version: 2, memoryBytes: 65_536, sha256: secondHash }),
    arrayBuffer: async () => secondBytes,
  }))
  expect(incompatibleVersion).toMatchObject({ available: false, reason: 'manifest-invalid' })
})
