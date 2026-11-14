// Page side of the AE-08 portable campaign (driver: ae-08-portable-campaign.ts). It runs the real portable controller over
// the real WasmAudioWorkletBackend, worklet and WASM core on a real AudioContext, plays two synth tracks (U panned hard
// left and never edited, E panned hard right and edited), captures the post-master output, and returns raw measurements.
// It judges nothing: the driver does.
import { resolveLiveMixerGraph } from "@daw-browser/audio-engine/live-mixer-runtime"
import { WasmAudioWorkletBackend, detectPortableWasmCapability } from "@daw-browser/audio-engine/wasm-audio-worklet-backend"
import { encodeUtilityProcessorState, mixerParameterRegistry, type AudioCoreGraphEdgeDto, type AudioCoreGraphSnapshot, type AudioCoreSampleSourceEventDto } from "@daw-browser/audio-core-contract"
import { processorContractHash } from "../../packages/audio-core-contract/src/generated/processor-contract-metadata"
import type { PortableFrameSchedule } from "@daw-browser/audio-engine/portable-frame-scheduling"
import { createDefaultSpectralParams, createDefaultSynthParams, createDefaultUtilityParams, getSpectralLatencyFrames, type SynthParams, type TrackInstrumentParams } from "@daw-browser/shared"
import type { AudioEffectRuntimeInstance } from "@daw-browser/audio-engine/audio-engine"
import type { LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "../../src/lib/live-playback-snapshot"
import { createPortableBrowserPlaybackController } from "../../src/lib/portable-browser-playback-controller"
import type { RuntimeTrack } from "../../src/lib/timeline-runtime-types"

const SAMPLE_RATE = 48_000
const BLOCK = 128
const ePitches = [64, 71]
const uPitch = 57
const pitchHz = (pitch: number) => 440 * 2 ** ((pitch - 69) / 12)
// Back-to-back one-beat notes (0.5 s at 120 bpm): a note edit reaches every note that starts after its seam. A steady window
// sits 300 ms into a note, well after its 5 ms attack, the 0.12 s release of the note before it and any latency delay.
const noteSec = 0.5
const noteCount = 200
const noteFrames = noteSec * SAMPLE_RATE
const settleFrames = 14_400
const windowFrames = 3_000
// The first steady window of a note that starts at or after `frame`.
const steadyStart = (frame: number) => Math.ceil(frame / noteFrames) * noteFrames + settleFrames

type State = { volume: number; pitch: number; fx: AudioEffectRuntimeInstance[] }
const spectral = (fftSize: 512 | 1024): AudioEffectRuntimeInstance => ({ id: "spectral:e", kind: "spectral", params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize } } })
const base: State = { volume: 0.8, pitch: 64, fx: [] }
const states = new Map<string, State>([
  ["base", base],
  ["gain", { ...base, volume: 0.4 }],
  ["note", { ...base, pitch: 71 }],
  ["effect", { ...base, fx: [{ id: "utility:e", kind: "utility", params: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: -6 } } }] }],
  ["spec512", { ...base, fx: [spectral(512)] }],
  ["spec1024", { ...base, fx: [spectral(1024)] }],
])
const stateOf = (name: string) => {
  const state = states.get(name)
  if (!state) throw new Error(`Unknown portable campaign state ${name}`)
  return state
}
const latencyOf = (name: string) => {
  const fft = stateOf(name).fx.find((fx) => fx.kind === "spectral")
  return fft && fft.kind === "spectral" ? getSpectralLatencyFrames(fft.params.state.fftSize, fft.params.state.overlap) : 0
}

// One steady sine per synth: the second oscillator and the filter are off, so a window of output is a stationary tone.
const synthParams = (pan: number): SynthParams => {
  const defaults = createDefaultSynthParams()
  return {
    ...defaults,
    oscillators: [{ enabled: true, wave: "sine", octave: 0, semitone: 0, detuneCents: 0, level: 1 }, { ...defaults.oscillators[1], enabled: false }],
    ampEnvelope: { ...defaults.ampEnvelope, sustain: 1 },
    filter: { ...defaults.filter, enabled: false },
    pan,
  }
}
// U holds one note for the whole run; E plays the note grid.
const track = (id: string, volume: number, pitch: number, notes: number): RuntimeTrack => ({
  id, kind: "instrument", name: id, volume,
  clips: [{ id: `${id}:clip`, name: id, color: "#fff", startSec: 0, duration: noteCount * noteSec, midiOffsetBeats: 0,
    midi: { wave: "sine", notes: Array.from({ length: notes }, (_, index) => ({ id: `${id}:note${index}`, beat: index * noteSec * 2 * (noteCount / notes), length: noteSec * 2 * (noteCount / notes), pitch, velocity: 1 })), cc: [], mappings: [] } }],
})
const compile = (transport: LivePlaybackTransport, state: State): LivePlaybackSnapshotCompilation => {
  const tracks = [track("u", 0.8, uPitch, 1), track("e", state.volume, state.pitch, noteCount)]
  const synth = (instanceId: string, pan: number): TrackInstrumentParams => ({ kind: "synth", instanceId, params: synthParams(pan) })
  const trackFx = {
    u: { instances: [], instrument: synth("u:1", -1) },
    e: { instances: state.fx, instrument: synth("e:1", 1) },
  }
  return { supported: true, snapshot: { revision: 1, bpm: 120, transport, tracks, assets: [],
    mixer: { graph: resolveLiveMixerGraph(tracks, trackFx), fx: { masterFxInstances: [], trackFx }, automationEnvelopes: [], sidechainRoutes: [] } } }
}
const fingerprint = (snapshot: { revision: number; transport: LivePlaybackTransport }) =>
  JSON.stringify({ ...snapshot, revision: undefined, transport: { ...snapshot.transport, playheadSec: undefined, state: undefined } })

// A pass-through tap: the worklet copies each block's left and right input and its frame, and posts them in batches.
const captureModule = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0; this.left = new Float32Array(${BLOCK * 64}); this.right = new Float32Array(${BLOCK * 64}); this.frames = []; this.times = []
    this.port.onmessage = () => { this.post(true) } }
  post(done) { this.port.postMessage({ left: this.left.slice(0, this.n * ${BLOCK}), right: this.right.slice(0, this.n * ${BLOCK}), frames: this.frames, times: this.times, done }); this.n = 0; this.frames = []; this.times = [] }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0]
    for (let channel = 0; channel < output.length; channel++) if (input[channel]) output[channel].set(input[channel])
    this.left.set(input[0] ?? new Float32Array(${BLOCK}), this.n * ${BLOCK}); this.right.set(input[1] ?? new Float32Array(${BLOCK}), this.n * ${BLOCK})
    this.frames.push(currentFrame); this.times.push(Date.now()); this.n += 1
    if (this.n === 64) this.post(false)
    return true
  }
}
registerProcessor("ae08-tap", Tap)`

type Chunk = { left: Float32Array; right: Float32Array; frames: number[]; times: number[]; done: boolean }
const createTap = async (context: AudioContext) => {
  const url = URL.createObjectURL(new Blob([captureModule], { type: "text/javascript" }))
  try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
  const node = new AudioWorkletNode(context, "ae08-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
  const chunks: Chunk[] = []
  let finished: (() => void) | undefined
  node.port.onmessage = (event: MessageEvent<Chunk>) => {
    chunks.push(event.data)
    if (event.data.done) finished?.()
  }
  node.connect(context.destination)
  const finish = async () => {
    const done = new Promise<void>((resolve) => { finished = resolve })
    node.port.postMessage(null)
    await done
    node.disconnect()
    const join = (pick: (chunk: Chunk) => Float32Array) => {
      const out = new Float32Array(chunks.reduce((total, chunk) => total + pick(chunk).length, 0))
      let offset = 0
      for (const chunk of chunks) { out.set(pick(chunk), offset); offset += pick(chunk).length }
      return out
    }
    return { left: join((chunk) => chunk.left), right: join((chunk) => chunk.right), frames: chunks.flatMap((chunk) => chunk.frames), times: chunks.flatMap((chunk) => chunk.times) }
  }
  return { node, finish }
}

// Joint least-squares amplitude of known tones in one window. Phases are free, so a window need not hold whole cycles; a
// delay is read from the unaffected channel, not from a phase, which drifts with the synth's own phase increment.
const fitAmplitudes = (samples: Float32Array, start: number, length: number, hz: readonly number[]) => {
  const columns = hz.flatMap((frequency) => [(n: number) => Math.cos(2 * Math.PI * frequency * n / SAMPLE_RATE), (n: number) => Math.sin(2 * Math.PI * frequency * n / SAMPLE_RATE)])
  const size = columns.length
  const normal = Array.from({ length: size }, () => new Float64Array(size + 1))
  for (let n = 0; n < length; n++) {
    const row = columns.map((column) => column(n))
    const y = samples[start + n] ?? 0
    for (let i = 0; i < size; i++) {
      const line = normal[i]
      if (!line) continue
      for (let j = 0; j < size; j++) line[j] = (line[j] ?? 0) + (row[i] ?? 0) * (row[j] ?? 0)
      line[size] = (line[size] ?? 0) + (row[i] ?? 0) * y
    }
  }
  for (let pivot = 0; pivot < size; pivot++) {
    const line = normal[pivot]
    if (!line) continue
    const lead = line[pivot] ?? 1
    for (let j = pivot; j <= size; j++) line[j] = (line[j] ?? 0) / lead
    for (let other = 0; other < size; other++) {
      const target = normal[other]
      if (other === pivot || !target) continue
      const factor = target[pivot] ?? 0
      for (let j = pivot; j <= size; j++) target[j] = (target[j] ?? 0) - factor * (line[j] ?? 0)
    }
  }
  return hz.map((_, index) => Math.hypot(normal[index * 2]?.[size] ?? 0, normal[index * 2 + 1]?.[size] ?? 0))
}

const firstSound = (left: Float32Array) => left.findIndex((value) => Math.abs(value) > 1e-6)
// Runs of 16 or more silent samples after the first settle, as transport frames and lengths.
const silentRuns = (samples: Float32Array, origin: number) => {
  const runs: { frame: number; length: number }[] = []
  let start = -1
  for (let n = origin + settleFrames; n <= samples.length; n++) {
    const silent = n < samples.length && Math.abs(samples[n] ?? 0) < 1e-6
    if (silent && start < 0) start = n
    if (!silent && start >= 0) {
      if (n - start >= 16) runs.push({ frame: start - origin, length: n - start })
      start = -1
    }
  }
  return runs
}
const scan = (...channels: Float32Array[]) => {
  let nonFinite = 0, maxAbs = 0
  for (const channel of channels) for (const value of channel) {
    if (!Number.isFinite(value)) nonFinite += 1
    else maxAbs = Math.max(maxAbs, Math.abs(value))
  }
  return { nonFinite, maxAbs }
}
const integrity = (capture: { left: Float32Array; right: Float32Array; frames: number[] }, origin: number) => {
  const originBlock = Math.floor(origin / BLOCK)
  const first = capture.frames[originBlock] ?? 0
  return {
    blocks: capture.frames.length,
    // The transport frame of every capture block that does not follow its predecessor by one block.
    gaps: capture.frames.flatMap((frame, index) => index > 0 && frame - (capture.frames[index - 1] ?? 0) !== BLOCK ? [frame - first + origin % BLOCK] : []),
    ...scan(capture.left, capture.right),
    leftSilence: silentRuns(capture.left, origin),
    rightSilence: silentRuns(capture.right, origin),
  }
}

type Event = { event: string; wallMs: number; pid: 1; cause?: string; frame?: number; revision?: number; requestedRevision?: number; publicationFrame?: number; transportEpoch?: number; sampleRate?: number; blockSize?: number }
type Adoption = { prepareMs: number; installMs: number; publishMs: number; publicationFrame: number; revision: number }
type Session = Awaited<ReturnType<WasmAudioWorkletBackend["createPlaybackSession"]>>

// The context is shared by every run of a page, as the product's one context is.
const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" })
const wall = () => performance.timeOrigin + performance.now()
const noLoop = { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 }
const transport: LivePlaybackTransport = { state: "playing", playheadSec: 0, ...noLoop }

const play = async (initial: string, body: (run: {
  adopt: (state: string) => Promise<string>
  waitFrame: (frame: number) => Promise<void>
  edits: { state: string; result: string; requestWall: number; publishWall: number; adoption: Adoption | undefined }[]
}) => Promise<void>) => {
  await context.resume()
  const tap = await createTap(context)
  const events: Event[] = []
  const adoptions: Adoption[] = []
  const waiters: { frame: number; resolve: () => void }[] = []
  const faults: string[] = []
  let lastFrame = 0, activeRevision = 1, sessions = 0
  let draft: Partial<Adoption> = {}
  let state = initial
  const real = new WasmAudioWorkletBackend()
  const instrument = (session: Session): Session => {
    session.onTransportPosition((message) => {
      lastFrame = message.frame
      void controller.refreshSchedule()
      for (const waiter of waiters.splice(0)) {
        if (message.frame >= waiter.frame) waiter.resolve()
        else waiters.push(waiter)
      }
    })
    // The session's own methods run unchanged on the wrapper (the class keeps its state in TS-private fields, so the prototype chain reaches them).
    return Object.assign(Object.create(session), {
      prepareGraph: async (graph: Parameters<Session["prepareGraph"]>[0]) => {
        const started = performance.now()
        events.push({ event: "graph-prepare", wallMs: wall(), pid: 1, frame: lastFrame, revision: activeRevision, requestedRevision: graph.revision, transportEpoch: 1 })
        await session.prepareGraph(graph)
        draft = { prepareMs: performance.now() - started, revision: graph.revision }
      },
      installSchedule: async (schedule: Parameters<Session["installSchedule"]>[0]) => {
        const started = performance.now()
        await session.installSchedule(schedule)
        draft = { ...draft, installMs: performance.now() - started }
      },
      publishGraph: async (revision: number, options?: Parameters<Session["publishGraph"]>[1]) => {
        const started = performance.now()
        events.push({ event: "graph-publish-request", wallMs: wall(), pid: 1, frame: lastFrame, revision: activeRevision, requestedRevision: revision, transportEpoch: 1 })
        await session.publishGraph(revision, options)
        const publicationFrame = options?.publicationFrame ?? lastFrame
        events.push({ event: "graph-publish", cause: "block-boundary", wallMs: wall(), pid: 1, frame: publicationFrame, publicationFrame, revision, requestedRevision: 0, transportEpoch: 1 })
        activeRevision = revision
        adoptions.push({ prepareMs: draft.prepareMs ?? 0, installMs: draft.installMs ?? 0, publishMs: performance.now() - started, publicationFrame, revision })
      },
      registerAsset: async (...args: Parameters<Session["registerAsset"]>) => {
        events.push({ event: "asset-install", wallMs: wall(), pid: 1, frame: lastFrame, transportEpoch: 1 })
        return session.registerAsset(...args)
      },
    })
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (next) => compile(next, stateOf(state)),
    fingerprintSnapshot: fingerprint,
    getAudioContext: () => context,
    reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async (target, capability, maxFrames) => {
      sessions += 1
      return instrument(await real.createPlaybackSession(target, capability, maxFrames, tap.node))
    } },
  })
  events.push({ event: "device-session", wallMs: wall(), pid: 1, sampleRate: context.sampleRate, blockSize: BLOCK })
  const edits: { state: string; result: string; requestWall: number; publishWall: number; adoption: Adoption | undefined }[] = []
  try {
    const started = await controller.start(transport)
    if (started !== "started") throw new Error(`Portable playback did not start: ${started} ${faults.join("; ")}`)
    await body({
      adopt: async (next) => {
        state = next
        const requestWall = wall()
        const before = adoptions.length
        const result = await controller.adoptSchedule(noLoop)
        edits.push({ state: next, result, requestWall, publishWall: wall(), adoption: adoptions.length > before ? adoptions[adoptions.length - 1] : undefined })
        return result
      },
      waitFrame: (frame) => lastFrame >= frame ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ frame, resolve }) }),
      edits,
    })
  } finally {
    controller.dispose()
  }
  const capture = await tap.finish()
  // The capture index of transport frame 0. The first sound of a run is delayed by the initial state's compensated latency.
  const origin = firstSound(capture.left) - latencyOf(initial)
  return { capture, origin, events, adoptions, faults, sessions, edits }
}

// ---- references: a no-edit run of one state, held for the page's later runs ----
type Reference = { left: Float32Array; origin: number }
const references = new Map<string, Reference>()
const eHz = ePitches.map(pitchHz)

const reference = async (name: string, seconds: number) => {
  const frames = Math.round(seconds * SAMPLE_RATE)
  const run = await play(name, ({ waitFrame }) => waitFrame(frames))
  // Every steady window the run holds, so the spread covers each position an edit's window can land on.
  const windows: number[][] = []
  // The first note is a startup, not a steady state: its windows are left out.
  for (let frame = noteFrames + settleFrames; frame + windowFrames <= run.capture.right.length - run.origin; frame += noteFrames)
    windows.push(fitAmplitudes(run.capture.right, run.origin + frame, windowFrames, eHz))
  const previous = references.get(name)
  const left = run.capture.left
  const compared = previous ? Math.min(previous.left.length - previous.origin, left.length - run.origin) : 0
  let duplicateMaxDiff = 0
  for (let n = 0; previous && n < compared; n++) duplicateMaxDiff = Math.max(duplicateMaxDiff, Math.abs((left[run.origin + n] ?? 0) - (previous.left[previous.origin + n] ?? 0)))
  if (!previous && run.capture.frames.length && integrity(run.capture, run.origin).gaps.length === 0) references.set(name, { left, origin: run.origin })
  return { state: name, seconds, windows, duplicate: previous ? { maxDiff: duplicateMaxDiff, frames: compared } : undefined,
    integrity: integrity(run.capture, run.origin), faults: run.faults, sessions: run.sessions }
}

// The delay, in frames, at which the run's left channel best matches the no-edit reference in one steady window.
const bestShift = (left: Float32Array, ref: Reference, origin: number, start: number) => {
  let best = 0, bestDiff = Infinity
  for (let shift = -1_536; shift <= 1_536; shift++) {
    let diff = 0
    for (let n = 0; n < windowFrames; n += 16) diff = Math.max(diff, Math.abs((left[origin + start + n] ?? 0) - (ref.left[ref.origin + start + n - shift] ?? 0)))
    if (diff < bestDiff) { best = shift; bestDiff = diff }
  }
  return best
}
const maxDiff = (left: Float32Array, origin: number, ref: Reference, start: number, length: number, shift = 0) => {
  if (ref.left.length - ref.origin < start + length) throw new Error("A reference is shorter than the burst it judges")
  let diff = 0, first: number | undefined
  for (let n = 0; n < length; n++) {
    const value = Math.abs((left[origin + start + n] ?? 0) - (ref.left[ref.origin + start + n - shift] ?? 0))
    if (value > diff) diff = value
    if (value > 0 && first === undefined) first = start + n
  }
  return { diff, first }
}

// ---- a burst: `count` adoptions alternating to/from, each followed by a steady window on the note grid ----
const burst = async (row: string, from: string, to: string, count: number) => {
  const known = (name: string) => {
    const ref = references.get(name)
    if (!ref) throw new Error(`No reference for ${name}`)
    return ref
  }
  const [fromRef, toRef] = [known(from), known(to)]
  const run = await play(from, async ({ adopt, waitFrame, edits }) => {
    await waitFrame(settleFrames)
    for (let index = 0; index < count; index++) {
      await adopt(index % 2 === 0 ? to : from)
      const published = edits[edits.length - 1]?.adoption
      await waitFrame(steadyStart((published?.publicationFrame ?? 0) + 240) + windowFrames)
    }
  })
  const left = run.capture.left
  // A raise moves the compensated latency L; a lower leaves L where it was until the transport stops (plan, latency policy), so the
  // unaffected channel stays at the highest latency any edit so far has declared.
  let compensated = latencyOf(from)
  const measured = run.edits.map((edit, index) => {
    const frame = edit.adoption?.publicationFrame
    const start = frame === undefined ? undefined : steadyStart(frame + 240)
    compensated = Math.max(compensated, latencyOf(edit.state))
    const settled = compensated === latencyOf(to) ? toRef : fromRef
    return { index, state: edit.state, result: edit.result, publicationFrame: frame, requestWall: edit.requestWall, publishWall: edit.publishWall,
      rightTones: start === undefined ? undefined : fitAmplitudes(run.capture.right, run.origin + start, windowFrames, eHz),
      // The unaffected channel is exact against the no-edit run that holds the compensated latency, and moves by the
      // compensated latency against the state it came from.
      leftMaxDiff: start === undefined ? Infinity : maxDiff(left, run.origin, settled, start, windowFrames).diff,
      declaredLatencyFrames: compensated, measuredShift: start === undefined ? undefined : bestShift(left, fromRef, run.origin, start),
      timing: edit.adoption && { prepareMs: edit.adoption.prepareMs, installMs: edit.adoption.installMs, publishMs: edit.adoption.publishMs } }
  })
  // Without a latency move the whole run holds U to the no-edit run of its first state, within what the two states' no-edit
  // runs differ by themselves: the edited track's pan-law residue in U is not the same signal in both.
  const whole = Math.min(left.length - run.origin, fromRef.left.length - fromRef.origin, toRef.left.length - toRef.origin)
  const spread = maxDiff(toRef.left, toRef.origin, fromRef, 0, whole).diff
  const full = maxDiff(left, run.origin, fromRef, 0, whole)
  return { row, from, to, fromLatencyFrames: latencyOf(from), edits: measured,
    left: { compared: whole, fullMaxDiff: full.diff, stateSpread: spread, firstDiffFrame: full.first }, integrity: integrity(run.capture, run.origin),
    events: run.events, faults: run.faults, sessions: run.sessions }
}

// ---- T:984: prepare, install and publish through the real worklet at the core's maximum graph ----
// The R1 gate (adoption at 0.55 ms p50 and 1.40 ms max against a 2.9 ms block) was measured under Bun/JSC. The worklet has no
// high-resolution clock (see workletClock), so a step is timed as the main thread sees it: from the post to the worklet's answer.
// That is an upper bound on the render-thread cost (it adds the message's wait for the next quantum), and `floor` is the same
// round trip for a one-node graph, which is what the harness itself costs.
const utilityState = encodeUtilityProcessorState({ ...createDefaultUtilityParams(), enabled: true })
type GraphNode = AudioCoreGraphSnapshot["nodes"][number]
const maximumGraph = (revision: number, nodesOnly = false): AudioCoreGraphSnapshot => {
  let instanceId = 1000
  const node = (id: string, kind: GraphNode["kind"], fx: number, mixerId: number, gain: number): GraphNode => ({ id, kind,
    inputLayout: "stereo", outputLayout: "stereo", latencyFrames: 0,
    processorOrder: Array.from({ length: fx }, (_, index) => ({ id: `${id}-fx${index}`, instanceId: instanceId++, kind: "utility", kindId: 1, stateVersion: 1,
      state: utilityState, parameterTargets: [{ id: "gainDb", target: 1 }], bypassed: false, latencyFrames: 0, tailFrames: 0 })),
    mixer: { instanceId: mixerId, gain, pan: 0, muted: false, soloed: false, parameterTargets: mixerParameterRegistry } })
  const edge = (from: string, to: string, kind: "output" | "send", gain: number): AudioCoreGraphEdgeDto => ({ version: 1, id: `${from}>${to}`, fromNodeId: from,
    toNodeId: to, gain, kind, tap: "post-fader", sidechain: false, pdcDelayFrames: 0 })
  const tracks = Array.from({ length: nodesOnly ? 0 : 60 }, (_, index) => node(`t${index}`, "source", 8, 100 + index, (revision + index) % 2 ? 1 : 0.5))
  const groups = Array.from({ length: nodesOnly ? 0 : 3 }, (_, index) => node(`group${index}`, "group", 1, 500 + index, 1))
  return { version: 1, revision, contractHash: processorContractHash, masterNodeId: "master", assets: [],
    nodes: [...tracks, ...groups, node("master", "master", 0, 900, 1)],
    edges: [...tracks.flatMap((track) => [edge(track.id, "master", "output", 1), ...groups.map((group) => edge(track.id, group.id, "send", 0.3))]),
      ...groups.map((group) => edge(group.id, "master", "output", 1))] }
}
const adoptionSchedule = (revision: number, nodesOnly: boolean): PortableFrameSchedule => ({ revision, transportEpoch: 1, sampleRateHz: SAMPLE_RATE, bpm: 120,
  timeOrigin: { timelineSec: 0, frame: 0 },
  events: nodesOnly ? [] : Array.from({ length: 256 }, (_, index) => ({ frame: index * 64, sequence: index + 1, type: "parameter-set",
    target: { kind: "parameter", scope: "track", trackId: `t${index % 60}`, parameterId: "mixer.gain" }, value: 0.25 + (index % 3) * 0.2 })) })

const adoptionTiming = async (adoptions: number) => {
  await context.resume()
  const capability = await detectPortableWasmCapability()
  if (!capability.available) throw new Error(capability.reason)
  const session = await new WasmAudioWorkletBackend().createPlaybackSession(context, capability, BLOCK)
  const faults: string[] = []
  session.onFault((error) => faults.push(error.message))
  const positionWaiters: (() => void)[] = []
  session.onTransportPosition(() => { for (const resolve of positionWaiters.splice(0)) resolve() })
  const nextPosition = () => new Promise<void>((resolve) => { positionWaiters.push(resolve) })
  const timed = async (call: () => Promise<void>) => { const started = performance.now(); await call(); return performance.now() - started }
  const series = { floor: { prepare: new Array<number>(), install: new Array<number>(), publish: new Array<number>() },
    maximum: { prepare: new Array<number>(), install: new Array<number>(), publish: new Array<number>() } }
  try {
    await session.prepareGraph(maximumGraph(1, true))
    await session.publishGraph(1)
    await session.setTransport(1, true, 0)
    await session.installSchedule(adoptionSchedule(1, true))
    let revision = 1
    for (const { steps, nodesOnly } of [{ steps: series.floor, nodesOnly: true }, { steps: series.maximum, nodesOnly: false }]) {
      for (let index = 0; index < adoptions; index++) {
        revision += 1
        steps.prepare.push(await timed(() => session.prepareGraph(maximumGraph(revision, nodesOnly))))
        steps.install.push(await timed(() => session.installSchedule(adoptionSchedule(revision, nodesOnly))))
        steps.publish.push(await timed(() => session.publishGraph(revision, { requireContinuity: true })))
        // The core renders between adoptions, as it does between a user's edits: wait for the next position report.
        await nextPosition()
      }
    }
  } finally { session.dispose() }
  const largest = maximumGraph(2)
  return { nodes: largest.nodes.length, processors: largest.nodes.reduce((count, node) => count + node.processorOrder.length, 0), edges: largest.edges.length,
    blockMs: BLOCK / SAMPLE_RATE * 1000, series, faults }
}

// ---- D3: does the render thread stall while the core's maximum graph adopts? ----
// The core renders the maximum graph with a 1 kHz carrier on one track. The worklet has only Date (1 ms), so a stall shows two ways:
// the carrier's phase (a dropped or repeated block moves it) and the lateness of each block against the audio clock (a block the render
// thread started late, past the device's buffer, is an underrun). Prepare, install and publish run on the render thread between quanta.
const carrierHz = 1_000
// A 1 s asset (a whole number of carrier periods) played back to back twenty times: one source per piece.
const carrierFrames = SAMPLE_RATE
const carrierPieces = 20
// The carrier's phase in each block, in radians: a joint least-squares fit of its cosine and sine over the block.
const carrierPhases = (samples: Float32Array) => {
  const phases: number[] = []
  const w = 2 * Math.PI * carrierHz / SAMPLE_RATE
  for (let start = 0; start + BLOCK <= samples.length; start += BLOCK) {
    let cc = 0, ss = 0, cs = 0, yc = 0, ys = 0
    for (let n = start; n < start + BLOCK; n++) {
      const c = Math.cos(w * n), s = Math.sin(w * n), y = samples[n] ?? 0
      cc += c * c; ss += s * s; cs += c * s; yc += y * c; ys += y * s
    }
    const det = cc * ss - cs * cs
    phases.push(Math.atan2(-(cc * ys - cs * yc) / det, (ss * yc - cs * ys) / det))
  }
  return phases
}
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))
const renderStall = async (adoptions: number) => {
  await context.resume()
  const capability = await detectPortableWasmCapability()
  if (!capability.available) throw new Error(capability.reason)
  const tap = await createTap(context)
  const marks: { phase: string; from: number; to: number }[] = []
  // The tap alone: how the context's audio clock runs against the wall clock with nothing of ours rendering.
  const bare = Date.now()
  await new Promise<void>((resolve) => { const source = new ConstantSourceNode(context); source.connect(tap.node); source.onended = () => resolve(); source.start(); source.stop(context.currentTime + 2) })
  marks.push({ phase: "tap-only", from: bare, to: Date.now() })
  const session = await new WasmAudioWorkletBackend().createPlaybackSession(context, capability, 8_192, tap.node)
  const faults: string[] = []
  session.onFault((error) => faults.push(error.message))
  const reports: (() => void)[] = []
  session.onTransportPosition(() => { for (const resolve of reports.splice(0)) resolve() })
  const nextReport = () => new Promise<void>((resolve) => { reports.push(resolve) })
  const carrier = Float32Array.from({ length: carrierFrames }, (_, n) => Math.sin(2 * Math.PI * carrierHz * n / SAMPLE_RATE))
  const adopt = new Array<number>()
  const windows: { from: number; to: number }[] = []
  const sessionStart = Date.now()
  try {
    await session.registerAsset({ version: 1, assetId: "carrier", frameCount: carrierFrames, sampleRateHz: SAMPLE_RATE, channelCount: 2 }, { frameCount: carrierFrames, planes: [carrier, carrier.slice()] }, 1)
    await session.prepareGraph(maximumGraph(1))
    await session.publishGraph(1)
    await session.setTransport(1, true, 0)
    await session.scheduleSources(1, 1, Array.from({ length: carrierPieces }, (_, piece): AudioCoreSampleSourceEventDto => ({ version: 1, epoch: 1, sequence: piece + 1, sourceNodeId: "t0", assetId: "carrier",
      startFrame: piece * carrierFrames, stopFrame: (piece + 1) * carrierFrames, sourceOffsetFrame: 0, sourceFrameCount: carrierFrames, gain: 1,
      fadeInStartFrame: piece * carrierFrames, fadeInEndFrame: piece * carrierFrames, fadeOutStartFrame: (piece + 1) * carrierFrames, fadeOutEndFrame: (piece + 1) * carrierFrames })))
    await session.installSchedule(adoptionSchedule(1, false))
    // The carrier settles for a second, then the idle phase is what the render thread does with nothing to adopt.
    for (let report = 0; report < 20; report++) await nextReport()
    let from = Date.now()
    for (let report = 0; report < 60; report++) await nextReport()
    marks.push({ phase: "idle", from, to: Date.now() })
    from = Date.now()
    for (let revision = 2; revision < adoptions + 2; revision++) {
      const started = performance.now(), wallFrom = Date.now()
      await session.prepareGraph(maximumGraph(revision))
      await session.installSchedule(adoptionSchedule(revision, false))
      await session.publishGraph(revision, { requireContinuity: true })
      adopt.push(performance.now() - started)
      windows.push({ from: wallFrom, to: Date.now() })
      for (let report = 0; report < 3; report++) await nextReport()
    }
    marks.push({ phase: "adopting", from, to: Date.now() })
  } finally { session.dispose() }
  const capture = await tap.finish()
  const phases = carrierPhases(capture.left)
  const lateness = capture.frames.map((frame, index) => (capture.times[index] ?? 0) - frame / SAMPLE_RATE * 1000)
  const settled = (index: number) => index >= Math.round(SAMPLE_RATE / BLOCK)
  const within = (index: number, from: number, to: number) => settled(index) && (capture.times[index] ?? 0) >= from && (capture.times[index] ?? 0) <= to
  // The audio clock does not run at the wall clock's rate (a headless device paces itself), so lateness is read against its straight-line trend over the whole run.
  const run = capture.times.flatMap((_, index) => marks.some((mark) => within(index, mark.from, mark.to)) ? [index] : [])
  const meanFrame = run.reduce((total, index) => total + (capture.frames[index] ?? 0), 0) / run.length
  const meanLate = run.reduce((total, index) => total + (lateness[index] ?? 0), 0) / run.length
  const slope = run.reduce((total, index) => total + ((capture.frames[index] ?? 0) - meanFrame) * ((lateness[index] ?? 0) - meanLate), 0)
    / run.reduce((total, index) => total + ((capture.frames[index] ?? 0) - meanFrame) ** 2, 0)
  const residual = (index: number) => (lateness[index] ?? 0) - meanLate - slope * ((capture.frames[index] ?? 0) - meanFrame)
  const gaps = capture.frames.flatMap((frame, index) => index > 0 && frame - (capture.frames[index - 1] ?? 0) !== BLOCK ? [index] : [])
  return { faults, adoptMs: adopt, gaps: gaps.map((index) => ({ block: index, phase: marks.find((mark) => within(index, mark.from, mark.to))?.phase ?? "outside", frames: (capture.frames[index] ?? 0) - (capture.frames[index - 1] ?? 0) })),
    nonFinite: scan(capture.left, capture.right).nonFinite, silentRuns: silentRuns(capture.left, (capture.times.findIndex((time) => time >= sessionStart)) * BLOCK).length, driftMsPerSec: slope * SAMPLE_RATE,
    phases: [...marks, ...windows.map((window) => ({ phase: "in-adoption", ...window }))].map(({ phase, from, to }) => {
      const blocks = capture.times.flatMap((_, index) => within(index, from, to) ? [index] : [])
      return { phase, blocks }
    }).reduce<{ phase: string; blocks: number[] }[]>((merged, entry) => {
      const existing = merged.find((candidate) => candidate.phase === entry.phase)
      if (existing) existing.blocks.push(...entry.blocks)
      else merged.push(entry)
      return merged
    }, []).map(({ phase, blocks }) => {
      const steps = phase === "tap-only" ? [] : blocks.flatMap((index) => settled(index - 1) && index > 0 ? [Math.abs(wrap((phases[index] ?? 0) - (phases[index - 1] ?? 0)))] : [])
      const late = blocks.map(residual)
      // Wall time between a block and the one before it: a render thread held for a message shows as a long one.
      const waits = blocks.flatMap((index) => index > 0 ? [(capture.times[index] ?? 0) - (capture.times[index - 1] ?? 0)] : []).sort((a, b) => a - b)
      const first = blocks[0] ?? 0, last = blocks[blocks.length - 1] ?? 0
      return { phase, driftMsPerSec: ((lateness[last] ?? 0) - (lateness[first] ?? 0)) / (((capture.frames[last] ?? 0) - (capture.frames[first] ?? 0)) / SAMPLE_RATE), blocks: blocks.length,
        phaseStepMaxRad: steps.length ? Math.max(...steps) : undefined, phaseStepOver: steps.filter((step) => step > 0.05).length,
        waitP99Ms: waits[Math.min(waits.length - 1, Math.ceil(0.99 * waits.length) - 1)] ?? 0, waitMaxMs: waits[waits.length - 1] ?? 0,
        latenessResidualMinMs: Math.min(...late), latenessResidualMaxMs: Math.max(...late), latenessResidualRangeMs: Math.max(...late) - Math.min(...late) }
    }) }
}

// What clocks the worklet global scope has: it decides whether a step's cost can be read on the render thread.
const workletClock = async () => {
  const url = URL.createObjectURL(new Blob([`registerProcessor("ae08-probe", class extends AudioWorkletProcessor { constructor() { super(); this.port.postMessage(JSON.stringify({ performance: typeof performance, date: typeof Date, atomics: typeof Atomics })) } process() { return false } })`], { type: "text/javascript" }))
  try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
  const node = new AudioWorkletNode(context, "ae08-probe")
  return new Promise<string>((resolve) => { node.port.onmessage = (event: MessageEvent<string>) => resolve(event.data) })
}

// A run outlasts what one agent-browser eval can wait for, so a call returns at once and the page posts its result to the
// fixture server, where the driver is waiting on it.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined }
type Posted = { id: string; value: Json } | { id: string; error: string }
const dispatch = (id: string, run: () => Promise<Json>): boolean => {
  const post = (body: Posted) => void fetch("/result", { method: "POST", body: JSON.stringify(body) })
  void run().then((value) => post({ id, value }), (error: Error) => post({ id, error: error.stack ?? error.message }))
  return true
}

Object.assign(window, { portableCampaign: { reference, burst, adoptionTiming, renderStall, workletClock, dispatch } })
