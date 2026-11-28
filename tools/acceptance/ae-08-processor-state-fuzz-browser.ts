import { resolveLiveMixerGraph } from "@daw-browser/audio-engine/live-mixer-runtime"
import type { PortableWasmBackendSelection } from "@daw-browser/audio-engine/wasm-audio-worklet-backend"
import { audioCoreContractVersion } from "@daw-browser/audio-core-contract"
import { audioCoreWasmAbiVersion, audioCoreWasmArtifactVersion, audioCoreWasmPagedAbiVersion } from "@daw-browser/audio-core-wasm"
import { createDefaultSynthParams } from "@daw-browser/shared"
import type { LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "../../src/lib/live-playback-snapshot"
import { createPortableBrowserPlaybackController } from "../../src/lib/portable-browser-playback-controller"
import type { RuntimeTrack } from "../../src/lib/timeline-runtime-types"

// The portable browser backend (`requiresNativeAudio: false`) answers synchronously from its own session and has no
// processor-state owner: a flush whose epoch moved on while it was out keeps answering `stale`, never `cancelled`.
// Pause keeps the browser's epoch, so a flush across a pause is still applied.
const track: RuntimeTrack = {
  id: "synth", kind: "instrument", name: "Synth", volume: 0.8,
  clips: [{ id: "clip", name: "MIDI", color: "#fff", startSec: 0, duration: 1, midiOffsetBeats: 0,
    midi: { wave: "sine", notes: [{ id: "note", beat: 0, length: 1, pitch: 60, velocity: 0.8 }], cc: [], mappings: [] } }],
}
const transport: LivePlaybackTransport = { state: "playing", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 }
const compilation = async (next: LivePlaybackTransport): Promise<LivePlaybackSnapshotCompilation> => ({
  supported: true,
  snapshot: {
    revision: 1, bpm: 120, transport: next, tracks: [track], assets: [],
    mixer: {
      graph: resolveLiveMixerGraph([track], {}),
      fx: { masterFxInstances: [], trackFx: { synth: { instances: [], instrument: { kind: "synth", instanceId: "synth:1", params: createDefaultSynthParams() } } } },
      automationEnvelopes: [], sidechainRoutes: [],
    },
  },
})
const selected: PortableWasmBackendSelection = {
  selected: true,
  capability: {
    available: true,
    artifact: {
      bytes: new ArrayBuffer(0),
      module: new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])),
      manifest: { version: audioCoreWasmArtifactVersion, abiVersion: audioCoreWasmAbiVersion, pagedAbi: audioCoreWasmPagedAbiVersion,
        contractVersion: audioCoreContractVersion, contractHash: "fuzz", fixedMemory: true, memoryBytes: 1, sha256: "fuzz", wasmUrl: "fuzz" },
    },
    sharedQueue: "available",
  },
}
const context: AudioContext = Object.assign(Object.create(null), { sampleRate: 48_000 })

type Held = { release?: () => void }
type Backend = NonNullable<Parameters<typeof createPortableBrowserPlaybackController>[0]["backend"]>
const createSession = (held: Held): Awaited<ReturnType<Backend["createPlaybackSession"]>> => ({
  connectInput: () => () => undefined,
  dispose: () => undefined,
  markActive: () => undefined,
  onFault: () => () => true,
  onRecordingStatus: () => () => true,
  postRecordingControl: () => undefined,
  prepareGraph: async () => undefined,
  publishGraph: async () => undefined,
  registerAsset: async () => ({ status: "registered", handle: { slot: 0, generation: 1 } }),
  installSchedule: async () => undefined,
  scheduleSources: async () => undefined,
  setTransport: async () => undefined,
  // The flush's bridge reply is held until the scenario releases it, after the transport action.
  queueInstrumentEvents: () => new Promise<void>((resolve) => { held.release = resolve }),
})

const flushRequest = { instanceId: "synth:1", values: [{ parameterId: "synth.filterCutoffHz", value: 4000 }] }

export default async function browserReceipts() {
  const held: Held = {}
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: compilation,
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => createSession(held) },
    select: async () => selected,
  })
  const control = controller.liveProcessorControl
  if (await controller.start(transport) !== "started") throw new Error("Browser witness could not start portable playback")
  const acrossPause = control.flush(flushRequest)
  await controller.pause(0)
  held.release?.()
  const acrossRestart = (async () => {
    await controller.start(transport)
    const flush = control.flush(flushRequest)
    // A loop changes the schedule's compatibility: the restart after a pause prepares a new session and a new epoch.
    await controller.pause(0)
    await controller.start({ ...transport, loopEnabled: true, loopStartSec: 0, loopEndSec: 1 })
    held.release?.()
    return flush
  })()
  const results = { acrossPause: await acrossPause, acrossRestart: await acrossRestart }
  controller.dispose()
  return results
}
