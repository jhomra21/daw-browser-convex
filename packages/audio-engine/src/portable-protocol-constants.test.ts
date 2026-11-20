import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  portableWasmMaxPendingEvents,
  portableWasmPagedPageFrames,
  portableWasmProtocolVersion,
} from './portable-wasm-protocol'
import { audioCoreWasmAbiVersion } from '../../audio-core-wasm/src/index'

const publicRoot = resolve(import.meta.dir, '../../../public')

test('the generated portable protocol constants module is current', () => {
  const output = Bun.spawnSync({
    cmd: ['bun', 'packages/audio-engine/scripts/generate-portable-protocol-constants.ts', '--check'],
    cwd: resolve(import.meta.dir, '../../..'),
    stderr: 'pipe',
  })

  expect(output.stderr.toString()).toBe('')
  expect(output.exitCode).toBe(0)
})

// The worklet host is a certification-pinned file that cannot import the generated module, so its literals are compared here.
test('the portable worklet host keeps the TypeScript protocol numbers', async () => {
  const source = await Bun.file(resolve(publicRoot, 'audio-worklets/daw-portable-audio-core-host-v2.js')).text()
  const literal = (name: string) => Number(new RegExp(`^const ${name} = (\\d+)$`, 'm').exec(source)?.[1])

  expect(literal('PROTOCOL_VERSION')).toBe(portableWasmProtocolVersion)
  expect(literal('ABI_VERSION')).toBe(audioCoreWasmAbiVersion)
  expect(literal('PAGED_PAGE_FRAMES')).toBe(portableWasmPagedPageFrames)
  expect(literal('MAX_PROCESSOR_EVENTS')).toBe(portableWasmMaxPendingEvents)
})
