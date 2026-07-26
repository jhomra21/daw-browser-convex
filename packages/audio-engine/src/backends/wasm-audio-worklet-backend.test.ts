import { expect, test } from 'bun:test'
import { audioCoreContractVersion } from '../../../audio-core-contract/src'
import { audioCoreWasmAbiVersion, audioCoreWasmArtifactVersion } from '../../../audio-core-wasm/src'
import {
  selectPortableWasmAudioWorkletBackend,
  type PortableWasmCapability,
  WasmAudioWorkletBackend,
} from './wasm-audio-worklet-backend'
import { resolvePortableWasmManifestUrl } from '../worklet-manifest'

const wasmModule = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))

const capability = (): Extract<PortableWasmCapability, { available: true }> => ({
  available: true,
  artifact: {
    bytes: new ArrayBuffer(0),
    module: wasmModule,
    manifest: {
      version: audioCoreWasmArtifactVersion,
      abiVersion: audioCoreWasmAbiVersion,
      contractVersion: audioCoreContractVersion,
      contractHash: 'test',
      fixedMemory: true,
      memoryBytes: 1,
      sha256: 'test',
      wasmUrl: 'test',
    },
  },
  sharedQueue: 'available',
})

const isMessage = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

test('resolves the generated portable Wasm manifest from the production static root', () => {
  expect(resolvePortableWasmManifestUrl()).toBe('/audio-core/daw-audio-core.manifest.json')
  expect(resolvePortableWasmManifestUrl('/desktop/')).toBe('/desktop/audio-core/daw-audio-core.manifest.json')
})

test('rejects unsupported project features before attempting portable playback', async () => {
  const selection = await selectPortableWasmAudioWorkletBackend('/missing-manifest.json', {
    processorKinds: ['utility', 'saturator', 'eq'],
    trackCount: 1,
    hasClips: true,
    hasRouting: false,
    hasAutomation: false,
    hasExternalPlugins: false,
  })
  expect(selection).toEqual({
    selected: false,
    reason: 'The portable Wasm backend requires a project fully covered by the graph parity capability matrix.',
  })
})

test('rejects processor kinds that the worklet cannot execute', async () => {
  const selection = await selectPortableWasmAudioWorkletBackend('/missing-manifest.json', {
    processorKinds: ['chorus'],
    trackCount: 1,
    hasClips: false,
    hasRouting: false,
    hasAutomation: false,
    hasExternalPlugins: false,
  })

  expect(selection).toEqual({
    selected: false,
    reason: 'The portable Wasm backend requires a project fully covered by the graph parity capability matrix.',
  })
})

test('disposes failed and timed out AudioWorklet initialization attempts', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
  let mode: 'fault' | 'silent' = 'fault'
  let created: {
    messages: unknown[]
    disconnects: number
    closes: number
    options: AudioWorkletNodeOptions
    port: { onmessage: ((event: MessageEvent<unknown>) => void) | null }
  } | undefined

  const FakeAudioWorkletNode = function (
    _context: BaseAudioContext,
    _name: string,
    options: AudioWorkletNodeOptions,
  ) {
    const messages: unknown[] = []
    const state = { disconnects: 0, closes: 0 }
    const port: {
      onmessage: ((event: MessageEvent<unknown>) => void) | null
      postMessage: (message: unknown) => void
      close: () => void
    } = {
      onmessage: null,
      postMessage: (message) => {
        messages.push(message)
        if (mode === 'fault' && isMessage(message) && message.type === 'initialize') {
          port.onmessage?.(new MessageEvent('message', { data: { type: 'fault' } }))
        }
      },
      close: () => {
        state.closes += 1
      },
    }
    const node = {
      messages,
      options,
      get disconnects() {
        return state.disconnects
      },
      get closes() {
        return state.closes
      },
      port,
      onprocessorerror: null,
      disconnect: () => {
        state.disconnects += 1
      },
    }
    created = node
    return node
  }

  const context: BaseAudioContext = Object.assign(Object.create(null), {
    audioWorklet: {
      addModule: async () => undefined,
    },
  })
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    value: FakeAudioWorkletNode,
  })
  try {
    const backend = new WasmAudioWorkletBackend(5)
    const portableCapability = capability()
    await expect(backend.createNode(context, portableCapability, 128))
      .rejects.toThrow('Portable audio-core AudioWorklet initialization failed.')
    expect(created?.messages.map((message) => isMessage(message) ? message.type : undefined))
      .toEqual(['initialize', 'dispose'])
    const initialization = created?.messages[0]
    if (!isMessage(initialization)) throw new Error('Expected portable Wasm initialization message.')
    expect(initialization).not.toHaveProperty('wasmModule')
    expect(created?.options.processorOptions?.wasmModule).toBe(portableCapability.artifact.module)
    expect(created?.disconnects).toBe(1)
    expect(created?.closes).toBe(1)
    expect(created?.port.onmessage).toBeNull()

    mode = 'silent'
    await expect(backend.createNode(context, portableCapability, 128))
      .rejects.toThrow('Portable audio-core AudioWorklet initialization timed out.')
    expect(created?.messages.map((message) => isMessage(message) ? message.type : undefined))
      .toEqual(['initialize', 'dispose'])
    expect(created?.disconnects).toBe(1)
    expect(created?.closes).toBe(1)
    expect(created?.port.onmessage).toBeNull()
  } finally {
    if (original) Object.defineProperty(globalThis, 'AudioWorkletNode', original)
    else Reflect.deleteProperty(globalThis, 'AudioWorkletNode')
  }
})
