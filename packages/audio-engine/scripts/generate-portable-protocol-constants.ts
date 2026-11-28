import { resolve } from 'node:path'
import {
  portableWasmMaxAssets,
  portableWasmMaxFramesPerBlock,
  portableWasmMaxGraphEdges,
  portableWasmMaxGraphNodes,
  portableWasmMaxPendingEvents,
  portableWasmPagedPageFrames,
  portableWasmPagedPreparationCount,
  portableWasmPagedSlotCount,
  portableWasmProtocolVersion,
} from '../src/portable-wasm-protocol'

const outputPath = resolve(import.meta.dir, '../../../public/audio-workers/daw-portable-protocol-constants-v1.js')

const contents = `// Generated from packages/audio-engine/src/portable-wasm-protocol.ts: run \`bun run --filter @daw-browser/audio-engine generate\`.
// The portable export Worker imports these so the TypeScript protocol stays the only place the numbers are written.
export const portableProtocolConstants = Object.freeze({
  version: ${portableWasmProtocolVersion},
  maxAssets: ${portableWasmMaxAssets},
  maxEvents: ${portableWasmMaxPendingEvents},
  maxGraphNodes: ${portableWasmMaxGraphNodes},
  maxGraphEdges: ${portableWasmMaxGraphEdges},
  maxFramesPerBlock: ${portableWasmMaxFramesPerBlock},
  pageFrames: ${portableWasmPagedPageFrames},
  pageSlotCount: ${portableWasmPagedSlotCount},
  preparationCount: ${portableWasmPagedPreparationCount},
})
`

if (Bun.argv.includes('--check')) {
  const current = await Bun.file(outputPath).exists() ? await Bun.file(outputPath).text() : undefined

  if (current !== contents) {
    console.error(`${outputPath} is stale. Run: bun run --filter @daw-browser/audio-engine generate`)
    process.exitCode = 1
  }
} else {
  await Bun.write(outputPath, contents)
}
