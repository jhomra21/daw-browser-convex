// Renders one effect through the production audio-core wasm: external planar input -> source node -> processor -> master.
// The source node reads input bus 0, the entry the portable host uses for live input (see graph envelope node field +20).
import { audioCoreContractVersion, processorSchemaVersion } from '../../packages/audio-core-contract/src'
import type { AudioCoreGraphEdgeDto, AudioCoreGraphSnapshot } from '../../packages/audio-core-contract/src'
import { processorContractHash } from '../../packages/audio-core-contract/src/generated/processor-contract-metadata'
import { graphEnvelope } from '../../public/audio-worklets/daw-portable-graph-envelope-v3.js'
import { declaredLatencyFrames, encodeSpec, kindIds, parameterTargets, withEnabled } from './effects'
import type { EffectSpec } from './effects'
import { getPath } from './state-path'
import type { Planar, RenderOptions, Rendered } from './types'

export const wasmPath = new URL('../../public/audio-core/daw-audio-core.wasm', import.meta.url).pathname
export const wasmManifestPath = new URL('../../public/audio-core/daw-audio-core.manifest.json', import.meta.url).pathname

const blockFrames = 128
const processorInstanceId = 1
const nodeBytes = 132
const sourceBusOffset = 24 + 20
const scratchBytes = 1 << 16

let compiled: Promise<WebAssembly.Module> | undefined
const wasmModule = () => compiled ??= Bun.file(wasmPath).arrayBuffer().then((bytes) => WebAssembly.compile(bytes))

type Exports = {
  memory: WebAssembly.Memory
  malloc: (...args: unknown[]) => number
  initialize: (...args: unknown[]) => number
  prepare: (...args: unknown[]) => number
  publish: (...args: unknown[]) => number
  transport: (...args: unknown[]) => number
  process: (...args: unknown[]) => number
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- wasm instance exports are untyped
const fn = (value: unknown, name: string) => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the export must be a function before it is called
  if (typeof value !== 'function') throw new Error(`audio-core wasm export ${name} is missing`)

  return (...args: unknown[]): number => Number(value(...args))
}

const bind = (instance: WebAssembly.Instance): Exports => {
  const e = instance.exports
  const memory = e.memory

  if (!(memory instanceof WebAssembly.Memory)) throw new Error('audio-core wasm export memory is missing')

  return {
    memory,
    malloc: fn(e.malloc, 'malloc'),
    initialize: fn(e.daw_audio_core_wasm_graph_initialize_planar, 'initialize_planar'),
    prepare: fn(e.daw_audio_core_wasm_graph_prepare, 'prepare'),
    publish: fn(e.daw_audio_core_wasm_graph_publish, 'publish'),
    transport: fn(e.daw_audio_core_wasm_graph_set_transport, 'set_transport'),
    process: fn(e.daw_audio_core_wasm_graph_process_planar, 'process_planar'),
  }
}

const keyEdge: AudioCoreGraphEdgeDto = {
  version: audioCoreContractVersion, id: 'key', fromNodeId: 'k', toNodeId: 's', targetProcessorId: 'p', gain: 1, kind: 'output', tap: 'post-fader', sidechain: true, pdcDelayFrames: 0,
}

const snapshot = (spec: EffectSpec | null, rate: number, targets: readonly number[], keyed: boolean, revision: number): AudioCoreGraphSnapshot => ({
  version: audioCoreContractVersion,
  revision,
  contractHash: processorContractHash,
  masterNodeId: 'm',
  assets: [],
  nodes: [
    {
      id: 's', kind: 'source', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: spec === null ? 0 : declaredLatencyFrames(spec, rate),
      processorOrder: spec === null ? [] : [{
        id: 'p', kind: spec.kind, kindId: kindIds[spec.kind], instanceId: processorInstanceId, stateVersion: processorSchemaVersion(spec.kind),
        state: encodeSpec(spec), parameterTargets: targets.map((target) => ({ id: String(target), target })),
        latencyFrames: declaredLatencyFrames(spec, rate), tailFrames: 0, bypassed: false,
      }],
    },
    { id: 'm', kind: 'master', inputLayout: 'stereo', outputLayout: 'stereo', latencyFrames: 0, processorOrder: [] },
    ...keyed ? [{ id: 'k', kind: 'source' as const, inputLayout: 'stereo' as const, outputLayout: 'stereo' as const, latencyFrames: 0, processorOrder: [] }] : [],
  ],
  edges: [
    { version: audioCoreContractVersion, id: 'e', fromNodeId: 's', toNodeId: 'm', gain: 1, kind: 'output', tap: 'post-fader', sidechain: false, pdcDelayFrames: 0 },
    ...keyed ? [keyEdge] : [],
  ],
})

/** Per-block parameter envelope: u32 count, then (u64 id, u32 frames, u32 targets, targets, target-major f32 values). */
const writeParameterBlock = (
  view: DataView, targets: readonly number[], values: readonly Float32Array[], frames: number,
) => {
  view.setUint32(0, 1, true)
  view.setBigUint64(4, BigInt(processorInstanceId), true)
  view.setUint32(12, frames, true)
  view.setUint32(16, targets.length, true)
  targets.forEach((target, index) => view.setUint32(20 + index * 4, target, true))
  const valuesOffset = 20 + targets.length * 4

  values.forEach((plane, index) => plane.subarray(0, frames).forEach((value, frame) =>
    view.setFloat32(valuesOffset + (index * frames + frame) * 4, value, true)))

  return valuesOffset + targets.length * frames * 4
}

/** Renders the input through the processor (null renders the empty graph, the fixed per-instance overhead). */
export const renderWasm = async (spec: EffectSpec | null, rate: number, options: RenderOptions): Promise<Rendered> => {
  const exports = bind(await WebAssembly.instantiate(await wasmModule()))
  const frames = options.input[0].length
  const steps = options.steps ?? []
  const enabledSteps = options.enabledSteps ?? []
  const paths = [...new Set(steps.flatMap((step) => Object.keys(step.set)))]

  const targetTable = spec === null ? {} : parameterTargets[spec.kind]

  const stepped = paths.map((path) => {
    const target = targetTable[path]

    if (target === undefined) throw new Error(`${spec?.kind ?? 'none'} has no parameter target for ${path}`)

    return { path, target }
  }).toSorted((a, b) => a.target - b.target)

  const targets = stepped.map((entry) => entry.target)

  const key = options.key
  const buses = key ? 2 : 1

  if (exports.initialize(rate, blockFrames, buses, 2, 1) !== 0) throw new Error('audio-core initialize failed')

  const publishGraph = (current: EffectSpec | null, revision: number) => {
    const graph = graphEnvelope(snapshot(current, rate, targets, key !== undefined, revision))
    const graphView = new DataView(graph.buffer, graph.byteOffset, graph.byteLength)

    graphView.setUint32(sourceBusOffset, 0, true)

    // The key's node is the third, after the source and the master.
    if (key) graphView.setUint32(sourceBusOffset + 2 * nodeBytes, 1, true)
    const graphPointer = exports.malloc(graph.byteLength)
    new Uint8Array(exports.memory.buffer, graphPointer, graph.byteLength).set(graph)
    const prepared = exports.prepare(graphPointer, graph.byteLength)

    if (prepared !== 0) throw new Error(`audio-core prepare failed with ${prepared}`)

    if (exports.publish(revision) !== 0) throw new Error('audio-core publish failed')
  }

  publishGraph(spec, 1)
  exports.transport(1, 1, 0n)

  const planeBytes = blockFrames * 4
  const planes = 2 * (buses + 1)
  const base = exports.malloc(planes * planeBytes + 4 * planes + scratchBytes)
  const table = base + planes * planeBytes
  const parameterPointer = table + 4 * planes
  const view = new DataView(exports.memory.buffer)

  for (let plane = 0; plane < planes; plane += 1) view.setUint32(table + plane * 4, base + plane * planeBytes, true)
  const planeAt = (plane: number) => new Float32Array(exports.memory.buffer, base + plane * planeBytes, blockFrames)
  const inputPlanes = Array.from({ length: 2 * buses }, (_, plane) => planeAt(plane))
  const outputPlanes = [2 * buses, 2 * buses + 1].map(planeAt)
  const parameterView = new DataView(exports.memory.buffer, parameterPointer, scratchBytes)
  const output: Planar = [new Float32Array(frames), new Float32Array(frames)]

  const initialValues = stepped.map(({ path }) => {
    const value = spec === null ? undefined : getPath(spec.state, path)

    if (value === undefined) throw new Error(`${path} has no numeric state value`)

    return value
  })

  let elapsedNs = 0n

  for (let offset = 0; offset < frames; offset += blockFrames) {
    const count = Math.min(blockFrames, frames - offset)
    inputPlanes[0].fill(0)
    inputPlanes[1].fill(0)
    inputPlanes[0].set(options.input[0].subarray(offset, offset + count))
    inputPlanes[1].set((options.input[1] ?? options.input[0]).subarray(offset, offset + count))

    if (key) {
      inputPlanes[2].fill(0)
      inputPlanes[3].fill(0)
      inputPlanes[2].set(key[0].subarray(offset, offset + count))
      inputPlanes[3].set((key[1] ?? key[0]).subarray(offset, offset + count))
    }

    const toggled = enabledSteps.findIndex((step) => step.frame === offset)

    if (spec !== null && toggled !== -1) publishGraph(withEnabled(spec, enabledSteps[toggled].enabled), toggled + 2)
    let parameterBytes = 0

    if (stepped.length > 0) {
      const values = stepped.map(({ path }, index) => Float32Array.from({ length: count }, (_, frame) => {
        const at = offset + frame
        const active = steps.findLast((step) => step.frame <= at && path in step.set)

        return active?.set[path] ?? initialValues[index]
      }))

      parameterBytes = writeParameterBlock(parameterView, targets, values, count)
    }

    const started = process.hrtime.bigint()
    const code = exports.process(count, buses, 2, table, table + 8 * buses, 1, parameterBytes > 0 ? parameterPointer : 0, parameterBytes, 0, 0, 0, 0)
    elapsedNs += process.hrtime.bigint() - started

    if (code !== 0) throw new Error(`audio-core process failed with ${code}`)
    output[0].set(outputPlanes[0].subarray(0, count), offset)
    output[1].set(outputPlanes[1].subarray(0, count), offset)
  }

  return { output, nsPerSample: Number(elapsedNs) / frames }
}
