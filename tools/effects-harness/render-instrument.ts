// Renders one instrument through the production audio-core wasm the way the AudioWorklet does: the portable host class publishes a
// graph with the instrument node, receives registered PCM assets, a note schedule and live parameter events, and renders 128-frame blocks.
import { mixerParameterRegistry } from '../../packages/audio-core-contract/src'
import type { AudioCoreGraphSnapshot, AudioCoreInstrumentState } from '../../packages/audio-core-contract/src'
import type { PortableFrameScheduleEvent } from '../../packages/audio-engine/src/portable-frame-scheduling'
import type { PortableWasmControlMessage, PortableWasmInstrumentEvent } from '../../packages/audio-engine/src/portable-wasm-protocol'
import { processorContractHash } from '../../packages/audio-core-contract/src/generated/processor-contract-metadata'
import { wasmPath } from './render-wasm'
import type { Planar } from './types'

const hostUrl = new URL('../../public/audio-worklets/daw-portable-audio-core-host-v2.js', import.meta.url).href
const blockFrames = 128
const protocolVersion = 2
const nodeId = 'track'

/** PCM the instrument's zones or grain source refer to, registered with the core before the graph is prepared. */
export type InstrumentAsset = { assetId: string; sampleRateHz: number; planes: readonly Float32Array[] }

export type Instrument = { state: AudioCoreInstrumentState; assets: readonly InstrumentAsset[] }

/** A note from `frame`; without `offFrame` no note-off is sent (one-shot samples end on their own). */
export type InstrumentNote = { frame: number; pitch: number; velocity: number; offFrame?: number }

/** A live instrument parameter event (target ids: `synthParameterRegistry`), applied sample-accurately at `frame`. */
export type InstrumentParameter = { frame: number; target: number; value: number }

export type InstrumentRenderOptions = {
  frames: number
  notes: readonly InstrumentNote[]
  parameters?: readonly InstrumentParameter[]
}

type HostMessage = { type: string; result?: string; code?: string }

type Host = {
  initialize: (options: { wasmBytes: ArrayBuffer; contractHash: string; maxFramesPerBlock: number }) => Promise<boolean>
  handleMessage: (message: PortableWasmControlMessage) => void
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
}

type HostConstructor = new (options: { sampleRate: number; postMessage: (message: HostMessage) => void; close: () => void }) => Host

const graph = (instrument: AudioCoreInstrumentState): AudioCoreGraphSnapshot => ({
  version: 1,
  revision: 1,
  contractHash: processorContractHash,
  masterNodeId: 'master',
  assets: [],
  nodes: [
    {
      id: nodeId, kind: 'instrument', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [], instrument,
      mixer: { instanceId: 100, gain: 1, pan: 0, muted: false, soloed: false, parameterTargets: mixerParameterRegistry },
    },
    {
      id: 'master', kind: 'master', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [],
      mixer: { instanceId: 900, gain: 1, pan: 0, muted: false, soloed: false, parameterTargets: mixerParameterRegistry },
    },
  ],
  edges: [{ version: 1, id: 'track-master', fromNodeId: nodeId, toNodeId: 'master', gain: 1, kind: 'output', tap: 'post-fader', sidechain: false, pdcDelayFrames: 0 }],
})

/** Schedule events in frame order, a note-off before a note-on at the same frame, sequenced as the host requires. */
const noteSchedule = (notes: readonly InstrumentNote[]): PortableFrameScheduleEvent[] => notes
  .flatMap((note, index) => [
    { frame: note.frame, off: false, noteId: index + 1, pitch: note.pitch, velocity: note.velocity },
    ...note.offFrame === undefined ? [] : [{ frame: note.offFrame, off: true, noteId: index + 1, pitch: note.pitch, velocity: 0 }],
  ])
  .toSorted((a, b) => a.frame - b.frame || Number(b.off) - Number(a.off))
  .map(({ frame, off, noteId, pitch, velocity }, index) => off
    ? { frame, sequence: index + 1, type: 'note-off', target: { kind: 'instrument', trackId: nodeId }, noteId, pitch }
    : { frame, sequence: index + 1, type: 'note-on', target: { kind: 'instrument', trackId: nodeId }, noteId, pitch, velocity })

/** Renders the instrument for `options.frames` frames and returns the stereo output. */
export const renderInstrument = async (instrument: Instrument, rate: number, options: InstrumentRenderOptions): Promise<Planar> => {
  const { DawPortableAudioCoreHost }: { DawPortableAudioCoreHost: HostConstructor } = await import(hostUrl)
  const messages: HostMessage[] = []
  const host = new DawPortableAudioCoreHost({ sampleRate: rate, postMessage: (message) => messages.push(message), close: () => undefined })

  if (!await host.initialize({ wasmBytes: await Bun.file(wasmPath).arrayBuffer(), contractHash: processorContractHash, maxFramesPerBlock: blockFrames })) {
    throw new Error('audio-core host initialize failed')
  }

  const expectReply = (type: string, result: string) => {
    const fault = messages.find((message) => message.type === 'fault')
    const reply = messages.findLast((message) => message.type === type)

    if (fault !== undefined || reply?.result !== result) throw new Error(`audio-core host ${type}: ${fault?.code ?? reply?.result ?? 'no reply'}`)
  }

  instrument.assets.forEach(({ assetId, sampleRateHz, planes }, index) => {
    host.handleMessage({
      version: protocolVersion, type: 'register-asset', requestId: 10 + index, generation: 0,
      asset: { version: 1, assetId, frameCount: planes[0].length, sampleRateHz, channelCount: planes.length }, planes,
    })
    expectReply('asset-registered', 'registered')
  })

  host.handleMessage({ version: protocolVersion, type: 'prepare-graph', requestId: 1, snapshot: graph(instrument.state) })
  expectReply('graph-prepared', 'prepared')
  host.handleMessage({ version: protocolVersion, type: 'publish-graph', requestId: 2, revision: 1 })
  expectReply('graph-published', 'published')
  host.handleMessage({ version: protocolVersion, type: 'transport', requestId: 3, epoch: 1, running: true, frame: 0 })
  host.handleMessage({
    version: protocolVersion, type: 'install-schedule', requestId: 4,
    schedule: { revision: 1, transportEpoch: 1, sampleRateHz: rate, bpm: 120, timeOrigin: { timelineSec: 0, frame: 0 }, events: noteSchedule(options.notes) },
  })
  expectReply('schedule-installed', 'installed')

  const output: Planar = [new Float32Array(options.frames), new Float32Array(options.frames)]
  const parameters = options.parameters ?? []

  for (let offset = 0; offset < options.frames; offset += blockFrames) {
    const events = parameters.filter(({ frame }) => frame >= offset && frame < offset + blockFrames).map(({ frame, target, value }, index): PortableWasmInstrumentEvent => ({
      nodeId, noteId: offset + index + 1, sequence: offset + index + 1, frameOffset: frame - offset, type: 'parameter', channel: 0, note: target, value,
    }))

    if (events.length > 0) host.handleMessage({ version: protocolVersion, type: 'instrument-events', epoch: 1, events })
    const block: Planar = [new Float32Array(blockFrames), new Float32Array(blockFrames)]
    host.process([], [block])
    const count = Math.min(blockFrames, options.frames - offset)
    output[0].set(block[0].subarray(0, count), offset)
    output[1].set(block[1].subarray(0, count), offset)
  }

  const fault = messages.find((message) => message.type === 'fault')

  if (fault !== undefined) throw new Error(`audio-core host fault: ${fault.code}`)
  host.handleMessage({ version: protocolVersion, type: 'dispose' })

  return output
}
