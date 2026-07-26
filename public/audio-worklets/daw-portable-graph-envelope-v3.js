const GRAPH_ENVELOPE_VERSION = 3

const graphNodeKind = (kind) => kind === 'source' ? 1 : kind === 'instrument' ? 2 : kind === 'master' ? 6 : 3
const instrumentKind = (kind) => kind === 'synth' ? 1 : kind === 'sampler' ? 2 : kind === 'drum-rack' ? 3 : kind === 'granular' ? 4 : 0

export const stableId = (value) => {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash === 0n ? 1n : hash
}

export const writeId = (view, offset, id) => view.setBigUint64(offset, stableId(id), true)
const writeOptionalProcessorId = (view, offset, id) => view.setBigUint64(offset, id ? stableId(id) : 0n, true)

export const graphEnvelope = (snapshot) => {
  const processors = snapshot.nodes.flatMap((node) => node.processorOrder.map((processor) => ({ node, processor })))
  let bytes = 24 + snapshot.nodes.length * 132 + snapshot.edges.length * 48
  for (const { processor } of processors) bytes += 48 + processor.state.byteLength + processor.parameterTargets.length * 4
  const output = new Uint8Array(bytes)
  const view = new DataView(output.buffer)
  view.setUint32(0, GRAPH_ENVELOPE_VERSION, true)
  view.setUint32(4, snapshot.revision, true)
  view.setUint32(8, snapshot.nodes.length, true)
  view.setUint32(12, snapshot.edges.length, true)
  view.setUint32(16, processors.length, true)
  let offset = 24
  let sourceBus = 0
  for (const node of snapshot.nodes) {
    writeId(view, offset, node.id)
    view.setUint32(offset + 8, graphNodeKind(node.kind), true)
    view.setUint32(offset + 12, node.inputLayout === 'mono' ? 1 : 2, true)
    view.setUint32(offset + 16, node.outputLayout === 'mono' ? 1 : 2, true)
    view.setUint32(offset + 20, node.kind === 'source' ? sourceBus++ : 0, true)
    view.setUint32(offset + 24, node.latencyFrames, true)
    const instrument = node.kind === 'instrument' ? node.instrument : null
    view.setUint32(offset + 28, instrument ? instrumentKind(instrument.kind) : 0, true)
    view.setUint32(offset + 32, instrument ? instrument.version : 0, true)
    view.setUint32(offset + 36, instrument ? instrument.voiceCapacity : 0, true)
    view.setUint32(offset + 40, instrument && instrument.kind === 'synth' ? instrument.parameterTargets.length : 0, true)
    for (let target = 0; target < 16; target += 1) {
      view.setUint32(offset + 44 + target * 4, instrument && instrument.kind === 'synth' && target < instrument.parameterTargets.length ? instrument.parameterTargets[target].target : 0, true)
    }
    const mixer = node.mixer
    view.setBigUint64(offset + 108, BigInt(mixer ? mixer.instanceId : 0), true)
    view.setFloat32(offset + 116, mixer ? mixer.gain : 0, true)
    view.setFloat32(offset + 120, mixer ? mixer.pan : 0, true)
    view.setUint32(offset + 124, mixer && mixer.muted ? 1 : 0, true)
    view.setUint32(offset + 128, mixer && mixer.soloed ? 1 : 0, true)
    offset += 132
  }
  for (const edge of snapshot.edges) {
    writeId(view, offset, edge.id)
    writeId(view, offset + 8, edge.fromNodeId)
    writeId(view, offset + 16, edge.toNodeId)
    writeOptionalProcessorId(view, offset + 24, edge.targetProcessorId)
    view.setFloat32(offset + 32, edge.gain, true)
    view.setUint32(offset + 36, edge.tap === 'pre-fx' ? 1 : edge.tap === 'pre-fader' ? 2 : 3, true)
    view.setUint32(offset + 40, edge.sidechain ? 1 : 0, true)
    view.setUint32(offset + 44, edge.pdcDelayFrames, true)
    offset += 48
  }
  for (const { node, processor } of processors) {
    writeId(view, offset, node.id)
    view.setUint32(offset + 8, processor.kindId, true)
    view.setUint32(offset + 12, processor.stateVersion, true)
    view.setUint32(offset + 16, processor.state.byteLength, true)
    view.setUint32(offset + 20, processor.instanceId, true)
    view.setUint32(offset + 24, processor.bypassed ? 1 : 0, true)
    view.setUint32(offset + 28, node.inputLayout === 'mono' ? 1 : 2, true)
    view.setUint32(offset + 32, node.outputLayout === 'mono' ? 1 : 2, true)
    view.setUint32(offset + 36, processor.parameterTargets.length, true)
    view.setUint32(offset + 40, processor.latencyFrames, true)
    view.setUint32(offset + 44, processor.tailFrames, true)
    output.set(processor.state, offset + 48)
    offset += 48 + processor.state.byteLength
    for (const target of processor.parameterTargets) {
      view.setUint32(offset, target.target, true)
      offset += 4
    }
  }
  return output
}
