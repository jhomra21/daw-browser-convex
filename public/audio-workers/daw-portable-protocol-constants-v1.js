// Generated from packages/audio-engine/src/portable-wasm-protocol.ts: run `bun run --filter @daw-browser/audio-engine generate`.
// The portable export Worker imports these so the TypeScript protocol stays the only place the numbers are written.
export const portableProtocolConstants = Object.freeze({
  version: 2,
  maxAssets: 64,
  maxEvents: 256,
  maxGraphNodes: 64,
  maxGraphEdges: 256,
  maxFramesPerBlock: 8192,
  pageFrames: 16384,
  pageSlotCount: 128,
  preparationCount: 64,
})
