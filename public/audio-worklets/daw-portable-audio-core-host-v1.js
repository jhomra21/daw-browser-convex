const PROTOCOL_VERSION = 1
import { graphEnvelope, stableId, writeId } from './daw-portable-graph-envelope-v3.js'

const ABI_VERSION = 1
const GRAPH_ENVELOPE_VERSION = 3
const MAX_FAULTS = 4
const MAX_INPUT_BUSES = 64
const CHANNEL_COUNT = 2

const writeProcessorId = (view, offset, id) => view.setBigUint64(offset, BigInt(id), true)

const byteHash = (bytes) => {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const parameterEnvelope = (blocks) => {
  let bytes = 4
  for (const block of blocks) bytes += 16 + block.parameterTargets.length * 4 + block.values.byteLength
  const output = new Uint8Array(bytes)
  const view = new DataView(output.buffer)
  view.setUint32(0, blocks.length, true)
  let offset = 4
  for (const block of blocks) {
    writeProcessorId(view, offset, block.processorInstanceId)
    view.setUint32(offset + 8, block.frameCount, true)
    view.setUint32(offset + 12, block.parameterTargets.length, true)
    offset += 16
    for (const target of block.parameterTargets) {
      view.setUint32(offset, target, true)
      offset += 4
    }
    output.set(new Uint8Array(block.values.buffer, block.values.byteOffset, block.values.byteLength), offset)
    offset += block.values.byteLength
  }
  return output
}

const eventEnvelope = (events) => {
  const output = new Uint8Array(4 + events.length * 20)
  const view = new DataView(output.buffer)
  view.setUint32(0, events.length, true)
  let offset = 4
  for (const event of events) {
    writeProcessorId(view, offset, event.processorInstanceId)
    view.setUint32(offset + 8, event.parameterTarget, true)
    view.setUint32(offset + 12, event.frameOffset, true)
    view.setFloat32(offset + 16, event.value, true)
    offset += 20
  }
  return output
}

const instrumentEventEnvelope = (events) => {
  const output = new Uint8Array(4 + events.length * 48)
  const view = new DataView(output.buffer)
  view.setUint32(0, events.length, true)
  let offset = 4
  for (const event of events) {
    writeId(view, offset, event.nodeId)
    view.setBigUint64(offset + 8, BigInt(event.noteId), true)
    view.setBigUint64(offset + 16, BigInt(event.sequence), true)
    view.setUint32(offset + 24, event.epoch, true)
    view.setUint32(offset + 28, event.frameOffset, true)
    view.setUint32(offset + 32, event.type === 'note-on' ? 1 : event.type === 'note-off' ? 2 : event.type === 'sustain' ? 3 : 4, true)
    view.setUint32(offset + 36, event.channel, true)
    view.setUint32(offset + 40, event.note, true)
    view.setFloat32(offset + 44, event.value, true)
    offset += 48
  }
  return output
}

export class DawPortableAudioCoreHost {
  constructor({ sampleRate, postMessage, close }) {
    this.sampleRate = sampleRate
    this.postMessage = postMessage
    this.close = close
    this.ready = false
    this.disposed = false
    this.revision = 0
    this.framesProcessed = 0
    this.maxFramesPerBlock = 0
    this.coreProcess = null
    this.leftInput = null
    this.rightInput = null
    this.leftOutput = null
    this.rightOutput = null
    this.state = { enabled: true, gainDb: 0, polarity: 'normal', inputMode: 'stereo', pan: 0, balance: 0, width: 1, matrix: 'stereo', swap: false, dcBlock: true }
    this.memory = null
    this.faultCount = 0
    this.assetGeneration = 0
    this.assets = new Map()
    this.assetRegister = null
    this.assetRelease = null
    this.malloc = null
    this.free = null
    this.transportEpoch = 0
    this.transportRunning = false
    this.transportFrame = 0
    this.transportProcessOrigin = 0
    this.schedule = null
    this.scheduleCursor = 0
    this.scheduleParameterStreams = null
    this.scheduleInstrumentEvents = null
    this.scheduleInstrumentCursor = 0
    this.scheduleEventCount = 0
    this.scheduleInstrumentEventCount = 0
    this.preparedInputBusCount = 0
    this.liveInputBusCount = 0
    this.stagedInputBusCount = 0
    this.parameterOffset = 0
    this.parameterByteCount = 0
    this.eventOffset = 0
    this.eventByteCount = 0
    this.instrumentEventOffset = 0
    this.instrumentEventByteCount = 0
    this.graphPrepareDiagnostics = null
    this.preparedSnapshot = null
    this.synthConfigure = null
    this.samplerConfigure = null
    this.granularConfigure = null
    this.sourceSchedule = null
    this.recordingCaptureInitialize = null
    this.recordingCaptureProcess = null
    this.recordingCaptureProcessMonitor = null
    this.recordingCaptureDequeue = null
    this.recordingCaptureFinalize = null
    this.recordingCaptureCancel = null
    this.recordingCaptureDiagnostics = null
    this.recordingCaptureConfigOffset = 0
    this.recordingCaptureBlockOffset = 0
    this.recordingCaptureDiagnosticsOffset = 0
    this.recordingCaptureDiagnosticsView = null
    this.recordingCaptureOutputPointerOffset = 0
    this.recordingCaptureOutputPlanes = null
    this.recordingMonitorPointerOffset = 0
    this.recordingMonitorPlanes = null
    this.recordingMonitoring = false
    this.recordingCaptureActive = false
    this.recordingCaptureGeneration = 0
    this.recordingCaptureSessionId = 0
    this.recordingCaptureNotificationPending = false
    this.recordingCaptureAvailableMessage = null
    this.recordingCaptureFinalizePending = false
    this.recordingCaptureStopFrame = 0
    this.recordingInputBusCount = 0
    this.initialization = null
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object' || message.version !== PROTOCOL_VERSION) return this.fault('malformed-message')
    if (message.type === 'dispose') {
      this.releaseAllAssets()
      this.disposed = true
      this.close()
      return
    }
    if (message.type === 'diagnostics') {
      this.postMessage({
        version: PROTOCOL_VERSION,
        type: 'health',
        abiVersion: ABI_VERSION,
        contractHash: this.contractHash,
        revision: this.revision,
        framesProcessed: this.framesProcessed,
        memoryBytes: this.memory ? this.memory.buffer.byteLength : 0,
        graphPrepare: this.graphPrepareDiagnostics,
      })
      return
    }
    if (message.type === 'recording-capture-configure') return this.configureRecordingCapture(message)
    if (message.type === 'recording-capture-finalize') {
      const stopFrame = message.stopFrame === null
        ? this.transportFrame + this.framesProcessed - this.transportProcessOrigin
        : message.stopFrame
      if (!this.recordingCaptureActive || !Number.isSafeInteger(stopFrame) || stopFrame < 0
        || !this.recordingCaptureFinalize || this.recordingCaptureFinalize(BigInt(stopFrame)) !== 0) return this.fault('core-error')
      this.recordingCaptureActive = false
      this.recordingInputBusCount = 0
      this.recordingCaptureFinalizePending = true
      this.recordingCaptureStopFrame = stopFrame
      this.drainRecordingCapture()
      return
    }
    if (message.type === 'recording-capture-cancel') {
      if (this.recordingCaptureActive && this.recordingCaptureCancel) this.recordingCaptureCancel()
      this.recordingCaptureActive = false
      this.recordingInputBusCount = 0
      this.recordingCaptureFinalizePending = false
      this.recordingCaptureNotificationPending = false
      this.postRecordingCaptureDiagnostics()
      this.postMessage({
        version: PROTOCOL_VERSION,
        type: 'recording-capture-applied',
        generation: this.recordingCaptureGeneration,
        sessionId: this.recordingCaptureSessionId,
        action: 'cancelled',
        frame: this.transportFrame + this.framesProcessed - this.transportProcessOrigin,
      })
      return
    }
    if (message.type === 'recording-capture-drain') return this.drainRecordingCapture()
    if (message.type === 'publish-graph' && Number.isInteger(message.requestId) && Number.isInteger(message.revision) && message.revision > this.revision) {
      if (!this.graphPublish || this.graphPublish(message.revision) !== 0) {
        this.postMessage({ version: PROTOCOL_VERSION, type: 'graph-published', requestId: message.requestId, revision: message.revision, result: 'rejected' })
        return
      }
      if (!this.preparedSnapshot || this.preparedSnapshot.revision !== message.revision || !this.configureInstruments(this.preparedSnapshot)) {
        this.postMessage({ version: PROTOCOL_VERSION, type: 'graph-published', requestId: message.requestId, revision: message.revision, result: 'rejected' })
        return
      }
      this.revision = message.revision
      this.liveInputBusCount = this.preparedInputBusCount
      this.postMessage({ version: PROTOCOL_VERSION, type: 'graph-published', requestId: message.requestId, revision: message.revision, result: 'published' })
      return
    }
    if (message.type === 'prepare-graph') {
      const snapshot = message.snapshot
      if (!Number.isInteger(message.requestId) || !snapshot || snapshot.version !== 1 || !Number.isInteger(snapshot.revision) || snapshot.revision < 1 || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) return this.fault('malformed-message')
      if (!this.graphPrepare || !this.malloc || !this.free || !this.memory) return this.fault('initialization-failed')
      let envelope
      try {
        envelope = graphEnvelope(snapshot)
      } catch {
        this.postMessage({ version: PROTOCOL_VERSION, type: 'graph-prepared', requestId: message.requestId, revision: snapshot.revision, result: 'rejected' })
        return
      }
      const envelopeView = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength)
      if (envelopeView.getUint32(0, true) !== GRAPH_ENVELOPE_VERSION) {
        this.postMessage({ version: PROTOCOL_VERSION, type: 'graph-prepared', requestId: message.requestId, revision: snapshot.revision, result: 'rejected' })
        return
      }
      const allocation = this.malloc(envelope.byteLength)
      if (!allocation) {
        this.postMessage({ version: PROTOCOL_VERSION, type: 'graph-prepared', requestId: message.requestId, revision: snapshot.revision, result: 'rejected' })
        return
      }
      new Uint8Array(this.memory.buffer, allocation, envelope.byteLength).set(envelope)
      const result = this.graphPrepare(allocation, envelope.byteLength)
      const view = envelopeView
      const edgeOffset = 24 + snapshot.nodes.length * 132
      this.graphPrepareDiagnostics = {
        byteLength: envelope.byteLength,
        byteHash: byteHash(envelope),
        header: Array.from({ length: 6 }, (_, index) => view.getUint32(index * 4, true)),
        allocation,
        nodeOffset: 24,
        edgeOffset,
        firstEdgeTargetProcessorIdPresent: snapshot.edges.length > 0 && view.getBigUint64(edgeOffset + 24, true) !== 0n,
        result,
      }
      this.free(allocation)
      if (result !== 0) {
        this.postMessage({ version: PROTOCOL_VERSION, type: 'graph-prepared', requestId: message.requestId, revision: snapshot.revision, result: 'rejected' })
        return
      }
      this.preparedSnapshot = snapshot
      this.preparedInputBusCount = Math.min(
        snapshot.nodes.reduce((count, node) => count + (node.kind === 'source' ? 1 : 0), 0),
        MAX_INPUT_BUSES,
      )
      this.postMessage({ version: PROTOCOL_VERSION, type: 'graph-prepared', requestId: message.requestId, revision: snapshot.revision, result: 'prepared' })
      return
    }
    if (message.type === 'utility-state' && Number.isInteger(message.revision) && message.revision >= this.revision) {
      this.revision = message.revision
      this.state = message.state
      this.writeState()
      return
    }
    if (message.type === 'parameter-blocks') {
      if (!this.ready || !Number.isInteger(message.revision) || message.revision !== this.revision
        || !Array.isArray(message.blocks) || message.blocks.length > 512
        || !message.blocks.every((block) => block && Number.isInteger(block.processorInstanceId) && block.processorInstanceId > 0
          && Number.isInteger(block.frameCount) && block.frameCount > 0 && block.frameCount <= this.maxFramesPerBlock
          && Array.isArray(block.parameterTargets) && block.parameterTargets.length > 0 && block.parameterTargets.length <= 16
          && block.parameterTargets.every((target) => Number.isInteger(target) && target > 0)
          && block.values instanceof Float32Array && block.values.length === block.parameterTargets.length * block.frameCount)) return this.fault('malformed-message')
      return this.replaceRenderEnvelope('parameter', parameterEnvelope(message.blocks))
    }
    if (message.type === 'processor-events') {
      if (!this.ready || !Number.isInteger(message.revision) || message.revision !== this.revision
        || !Array.isArray(message.events) || message.events.length > 256
        || !message.events.every((event) => event && Number.isInteger(event.processorInstanceId) && event.processorInstanceId > 0
          && Number.isInteger(event.parameterTarget) && event.parameterTarget > 0
          && Number.isInteger(event.frameOffset) && event.frameOffset >= 0 && event.frameOffset < this.maxFramesPerBlock
          && typeof event.value === 'number' && Number.isFinite(event.value))) return this.fault('malformed-message')
      return this.replaceRenderEnvelope('event', eventEnvelope(message.events))
    }
    if (message.type === 'transport') {
      if (!Number.isInteger(message.requestId) || !Number.isInteger(message.epoch) || message.epoch < 1 || typeof message.running !== 'boolean' || !Number.isSafeInteger(message.frame) || message.frame < 0) return this.fault('malformed-message')
      const resetSchedule = message.epoch !== this.transportEpoch || message.frame !== this.currentTransportFrame()
      if (message.epoch < this.transportEpoch || !this.graphSetTransport || this.graphSetTransport(message.epoch, message.running ? 1 : 0, BigInt(message.frame)) !== 0) {
        this.postMessage({ version: PROTOCOL_VERSION, type: 'transport-applied', requestId: message.requestId, epoch: message.epoch, result: 'rejected' })
        return
      }
      this.transportEpoch = message.epoch
      this.transportRunning = message.running
      this.transportFrame = message.frame
      this.transportProcessOrigin = this.framesProcessed
      if (resetSchedule) this.resetScheduleCursors(message.frame)
      this.postMessage({ version: PROTOCOL_VERSION, type: 'transport-applied', requestId: message.requestId, epoch: message.epoch, result: 'applied' })
      return
    }
    if (message.type === 'instrument-state') {
      const state = message.state
      if (!Number.isInteger(message.revision) || typeof message.nodeId !== 'string' || message.nodeId.length === 0
        || !state || state.version !== 1 || !['synth', 'sampler', 'drum-rack', 'granular'].includes(state.kind)) return this.fault('malformed-message')
      if (!this.ready || message.revision !== this.revision) return this.fault('core-error')
      if (!this.configureInstrument(message.nodeId, state)) return this.fault('core-error')
      return
    }
    if (message.type === 'instrument-events') {
      if (!Number.isInteger(message.epoch) || message.epoch !== this.transportEpoch || !Array.isArray(message.events) || message.events.length > 256) return this.fault('event-overflow')
      let previousOffset = -1
      let previousSequence = 0
      for (const event of message.events) {
        if (!event || typeof event.nodeId !== 'string'
          || !Number.isInteger(event.noteId) || event.noteId < 1 || !Number.isInteger(event.sequence) || event.sequence < 1
          || event.sequence <= previousSequence || !Number.isInteger(event.frameOffset) || event.frameOffset < previousOffset || event.frameOffset >= this.maxFramesPerBlock
          || !['note-on', 'note-off', 'sustain', 'expression'].includes(event.type)
          || !Number.isInteger(event.channel) || event.channel < 0 || event.channel > 15
          || !Number.isInteger(event.note) || event.note < 0 || event.note > 127
          || typeof event.value !== 'number' || !Number.isFinite(event.value) || event.value < 0 || event.value > 1) return this.fault('malformed-message')
        previousSequence = event.sequence
        previousOffset = event.frameOffset
      }
      return this.replaceRenderEnvelope('instrumentEvent', instrumentEventEnvelope(message.events))
    }
    if (message.type === 'install-schedule') {
      return this.installSchedule(message)
    }
    if (message.type === 'schedule-sources') {
      this.scheduleSources(message)
      return
    }
    if (message.type === 'register-asset') {
      this.registerAsset(message)
      return
    }
    if (message.type === 'release-asset') {
      this.releaseAsset(message)
      return
    }
    if (message.type === 'retire-assets' && Number.isInteger(message.generation) && message.generation >= this.assetGeneration) {
      this.releaseAllAssets()
      this.assetGeneration = message.generation + 1
      return
    }
    if (message.type !== 'initialize') return this.fault('malformed-message')
    if (message.abiVersion !== ABI_VERSION) return this.fault('abi-mismatch')
    if (!Number.isInteger(message.maxFramesPerBlock) || message.maxFramesPerBlock < 1 || message.maxFramesPerBlock > 8192 || !(message.wasmModule instanceof WebAssembly.Module)) return this.fault('capacity-exceeded')
    return this.initializeWasm(message)
  }

  initialize({ wasmBytes, wasmModule, contractHash, maxFramesPerBlock }) {
    const compiled = wasmModule instanceof WebAssembly.Module
      ? Promise.resolve(wasmModule)
      : WebAssembly.compile(wasmBytes)
    return compiled.then((module) => this.handleMessage({
      version: PROTOCOL_VERSION,
      type: 'initialize',
      abiVersion: ABI_VERSION,
      wasmModule: module,
      contractHash,
      maxFramesPerBlock,
    }), () => {
      this.fault('initialization-failed')
      return false
    })
  }

  initializeWasm(message) {
    this.initialization = WebAssembly.instantiate(message.wasmModule).then((instance) => {
      const exports = instance.exports
      if (typeof exports.daw_audio_core_get_abi_version !== 'function' || exports.daw_audio_core_get_abi_version() !== ABI_VERSION || typeof exports.daw_audio_core_wasm_graph_initialize_planar !== 'function' || typeof exports.daw_audio_core_wasm_graph_prepare !== 'function' || typeof exports.daw_audio_core_wasm_graph_publish !== 'function' || typeof exports.daw_audio_core_wasm_graph_process_planar !== 'function' || typeof exports.daw_audio_core_wasm_graph_set_transport !== 'function' || typeof exports.daw_audio_core_wasm_graph_schedule_sample_source !== 'function' || typeof exports.daw_audio_core_wasm_graph_register_pcm_asset !== 'function' || typeof exports.daw_audio_core_wasm_graph_release_asset !== 'function' || typeof exports.daw_audio_core_wasm_graph_configure_synth !== 'function' || typeof exports.daw_audio_core_wasm_graph_configure_sampler !== 'function' || typeof exports.daw_audio_core_wasm_graph_configure_granular !== 'function' || typeof exports.daw_audio_core_wasm_recording_capture_initialize !== 'function' || typeof exports.daw_audio_core_wasm_recording_capture_process_monitor !== 'function' || typeof exports.daw_audio_core_wasm_recording_capture_dequeue !== 'function' || typeof exports.daw_audio_core_wasm_recording_capture_finalize !== 'function' || typeof exports.daw_audio_core_wasm_recording_capture_cancel !== 'function' || typeof exports.daw_audio_core_wasm_recording_capture_get_diagnostics !== 'function' || typeof exports.malloc !== 'function' || typeof exports.free !== 'function' || !(exports.memory instanceof WebAssembly.Memory)) {
        this.fault('initialization-failed')
        return false
      }
      const planeBytes = message.maxFramesPerBlock * Float32Array.BYTES_PER_ELEMENT
      const planeCount = MAX_INPUT_BUSES * CHANNEL_COUNT + CHANNEL_COUNT
      const scratch = exports.malloc(planeCount * planeBytes + planeCount * Uint32Array.BYTES_PER_ELEMENT)
      if (!scratch || exports.daw_audio_core_wasm_graph_initialize_planar(this.sampleRate, message.maxFramesPerBlock, MAX_INPUT_BUSES, CHANNEL_COUNT, 64) !== 0) {
        this.fault('initialization-failed')
        return false
      }
      this.coreProcess = exports.daw_audio_core_wasm_graph_process_planar
      this.graphPrepare = exports.daw_audio_core_wasm_graph_prepare
      this.graphPublish = exports.daw_audio_core_wasm_graph_publish
      this.graphSetTransport = exports.daw_audio_core_wasm_graph_set_transport
      this.sourceSchedule = exports.daw_audio_core_wasm_graph_schedule_sample_source
      this.assetRegister = exports.daw_audio_core_wasm_graph_register_pcm_asset
      this.assetRelease = exports.daw_audio_core_wasm_graph_release_asset
      this.synthConfigure = exports.daw_audio_core_wasm_graph_configure_synth
      this.samplerConfigure = exports.daw_audio_core_wasm_graph_configure_sampler
      this.granularConfigure = exports.daw_audio_core_wasm_graph_configure_granular
      this.recordingCaptureInitialize = exports.daw_audio_core_wasm_recording_capture_initialize
      this.recordingCaptureProcess = exports.daw_audio_core_wasm_recording_capture_process
      this.recordingCaptureProcessMonitor = exports.daw_audio_core_wasm_recording_capture_process_monitor
      this.recordingCaptureDequeue = exports.daw_audio_core_wasm_recording_capture_dequeue
      this.recordingCaptureFinalize = exports.daw_audio_core_wasm_recording_capture_finalize
      this.recordingCaptureCancel = exports.daw_audio_core_wasm_recording_capture_cancel
      this.recordingCaptureDiagnostics = exports.daw_audio_core_wasm_recording_capture_get_diagnostics
      this.malloc = exports.malloc
      this.free = exports.free
      this.memory = exports.memory
      this.contractHash = message.contractHash
      const planes = scratch + planeCount * Uint32Array.BYTES_PER_ELEMENT
      this.inputPointerOffset = scratch
      this.outputPointerOffset = scratch + MAX_INPUT_BUSES * CHANNEL_COUNT * Uint32Array.BYTES_PER_ELEMENT
      this.inputPointers = new Uint32Array(exports.memory.buffer, this.inputPointerOffset, MAX_INPUT_BUSES * CHANNEL_COUNT)
      this.outputPointers = new Uint32Array(exports.memory.buffer, this.outputPointerOffset, CHANNEL_COUNT)
      this.inputPlanes = Array.from({ length: MAX_INPUT_BUSES * CHANNEL_COUNT }, (_, index) => {
        const offset = planes + index * planeBytes
        this.inputPointers[index] = offset
        return new Float32Array(exports.memory.buffer, offset, message.maxFramesPerBlock)
      })
      this.leftOutput = new Float32Array(exports.memory.buffer, planes + (planeCount - CHANNEL_COUNT) * planeBytes, message.maxFramesPerBlock)
      this.rightOutput = new Float32Array(exports.memory.buffer, planes + (planeCount - 1) * planeBytes, message.maxFramesPerBlock)
      this.outputPointers[0] = this.leftOutput.byteOffset
      this.outputPointers[1] = this.rightOutput.byteOffset
      const captureScratch = exports.malloc(
        56 + 48 + 64
        + CHANNEL_COUNT * Uint32Array.BYTES_PER_ELEMENT
        + CHANNEL_COUNT * 2048 * Float32Array.BYTES_PER_ELEMENT
        + CHANNEL_COUNT * Uint32Array.BYTES_PER_ELEMENT
        + CHANNEL_COUNT * message.maxFramesPerBlock * Float32Array.BYTES_PER_ELEMENT,
      )
      if (!captureScratch) {
        this.fault('initialization-failed')
        return false
      }
      this.recordingCaptureConfigOffset = captureScratch
      this.recordingCaptureBlockOffset = captureScratch + 56
      this.recordingCaptureDiagnosticsOffset = this.recordingCaptureBlockOffset + 48
      this.recordingCaptureDiagnosticsView = new DataView(exports.memory.buffer, this.recordingCaptureDiagnosticsOffset, 64)
      this.recordingCaptureOutputPointerOffset = this.recordingCaptureDiagnosticsOffset + 64
      const capturePlanes = this.recordingCaptureOutputPointerOffset + CHANNEL_COUNT * Uint32Array.BYTES_PER_ELEMENT
      const capturePointers = new Uint32Array(exports.memory.buffer, this.recordingCaptureOutputPointerOffset, CHANNEL_COUNT)
      this.recordingCaptureOutputPlanes = Array.from({ length: CHANNEL_COUNT }, (_, channel) => {
        const offset = capturePlanes + channel * 2048 * Float32Array.BYTES_PER_ELEMENT
        capturePointers[channel] = offset
        return new Float32Array(exports.memory.buffer, offset, 2048)
      })
      this.recordingMonitorPointerOffset = capturePlanes + CHANNEL_COUNT * 2048 * Float32Array.BYTES_PER_ELEMENT
      const monitorPlanes = this.recordingMonitorPointerOffset + CHANNEL_COUNT * Uint32Array.BYTES_PER_ELEMENT
      const monitorPointers = new Uint32Array(exports.memory.buffer, this.recordingMonitorPointerOffset, CHANNEL_COUNT)
      this.recordingMonitorPlanes = Array.from({ length: CHANNEL_COUNT }, (_, channel) => {
        const offset = monitorPlanes + channel * message.maxFramesPerBlock * Float32Array.BYTES_PER_ELEMENT
        monitorPointers[channel] = offset
        return new Float32Array(exports.memory.buffer, offset, message.maxFramesPerBlock)
      })
      this.maxFramesPerBlock = message.maxFramesPerBlock
      this.scheduleEventOffset = exports.malloc(4 + 256 * 20)
      this.scheduleInstrumentEventOffset = exports.malloc(4 + 256 * 48)
      if (!this.scheduleEventOffset || !this.scheduleInstrumentEventOffset) {
        this.fault('initialization-failed')
        return false
      }
      this.scheduleEventView = new DataView(exports.memory.buffer, this.scheduleEventOffset, 4 + 256 * 20)
      this.scheduleInstrumentEventView = new DataView(exports.memory.buffer, this.scheduleInstrumentEventOffset, 4 + 256 * 48)
      this.writeState()
      this.ready = true
      this.postMessage({ version: PROTOCOL_VERSION, type: 'ready', revision: this.revision })
      return true
    }, () => {
      this.fault('initialization-failed')
      return false
    })
    return this.initialization
  }

  fault(code) {
    if (this.faultCount++ < MAX_FAULTS) this.postMessage({ version: PROTOCOL_VERSION, type: 'fault', code })
  }

  writeState() {
    if (!this.memory || this.stateOffset === undefined) return
    const view = new DataView(this.memory.buffer, this.stateOffset, 40)
    view.setUint32(0, this.state.enabled ? 1 : 0, true)
    view.setFloat32(4, this.state.gainDb, true)
    view.setUint32(8, this.state.polarity === 'invert' ? 1 : 0, true)
    view.setUint32(12, this.state.inputMode === 'mono-sum' ? 1 : 0, true)
    view.setFloat32(16, this.state.pan, true)
    view.setFloat32(20, this.state.balance, true)
    view.setFloat32(24, this.state.width, true)
    view.setUint32(28, this.state.matrix === 'mid-side-encode' ? 1 : this.state.matrix === 'mid-side-decode' ? 2 : 0, true)
    view.setUint32(32, this.state.swap ? 1 : 0, true)
    view.setUint32(36, this.state.dcBlock ? 1 : 0, true)
  }

  replaceRenderEnvelope(kind, envelope) {
    if (!this.malloc || !this.free || !this.memory) return this.fault('initialization-failed')
    const allocation = this.malloc(envelope.byteLength)
    if (!allocation) return this.fault('capacity-exceeded')
    new Uint8Array(this.memory.buffer, allocation, envelope.byteLength).set(envelope)
    const offset = `${kind}Offset`
    const byteCount = `${kind}ByteCount`
    if (this[offset]) this.free(this[offset])
    this[offset] = allocation
    this[byteCount] = envelope.byteLength
  }

  configureInstruments(snapshot) {
    return snapshot.nodes
      .filter((node) => node.kind === 'instrument')
      .every((node) => this.configureInstrument(node.id, node.instrument))
  }

  currentTransportFrame() {
    return this.transportRunning
      ? this.transportFrame + this.framesProcessed - this.transportProcessOrigin
      : this.transportFrame
  }

  resetScheduleCursors(frame) {
    this.scheduleCursor = 0
    this.scheduleInstrumentCursor = 0
    if (this.scheduleInstrumentEvents) {
      while (this.scheduleInstrumentCursor < this.scheduleInstrumentEvents.length
        && this.scheduleInstrumentEvents[this.scheduleInstrumentCursor].frame < frame) {
        this.scheduleInstrumentCursor += 1
      }
      this.scheduleCursor = this.scheduleInstrumentCursor
    }
    if (!this.scheduleParameterStreams) return
    for (const stream of this.scheduleParameterStreams) {
      stream.cursor = 0
      for (const ramp of stream.activeRamps) ramp.event = null
      while (stream.cursor < stream.events.length && stream.events[stream.cursor].frame < frame) {
        const event = stream.events[stream.cursor]
        if (event.ramp && event.endFrame > frame) {
          stream.activeRamps[event.rampIndex].event = event
        }
        stream.cursor += 1
        this.scheduleCursor += 1
      }
    }
  }

  installSchedule(message) {
    const schedule = message.schedule
    if (!this.ready || !this.preparedSnapshot || !Number.isInteger(message.requestId)
      || !schedule || !Number.isInteger(schedule.revision) || schedule.revision !== this.revision
      || !Number.isInteger(schedule.transportEpoch) || schedule.transportEpoch !== this.transportEpoch
      || !Array.isArray(schedule.events) || schedule.events.length > 256) return this.scheduleResult(message, 'rejected')
    const targets = new Map()
    const parameterStreams = new Map()
    const instrumentEvents = []
    for (const node of this.preparedSnapshot.nodes) {
      if (node.mixer) {
        for (const target of node.mixer.parameterTargets) {
          targets.set(`parameter:${node.id}::${target.id}`, {
            kind: 'parameter',
            instanceId: node.mixer.instanceId,
            instanceIdValue: BigInt(node.mixer.instanceId),
            target: target.target,
          })
        }
      }
      for (const processor of node.processorOrder) {
        for (const target of processor.parameterTargets) {
          targets.set(`parameter:${node.id}:${processor.id}:${target.id}`, {
            kind: 'parameter',
            instanceId: processor.instanceId,
            instanceIdValue: BigInt(processor.instanceId),
            target: target.target,
          })
        }
      }
      if (node.kind === 'instrument') targets.set(`instrument:${node.id}`, {
        kind: 'instrument',
        nodeId: stableId(node.id),
      })
    }
    let previousFrame = -1
    let previousSequence = 0
    for (const event of schedule.events) {
      if (!event || typeof event !== 'object') return this.scheduleResult(message, 'rejected')
      const isNote = event.type === 'note-on' || event.type === 'note-off'
      const targetsInstrument = event.target && event.target.kind === 'instrument'
      const key = targetsInstrument
        ? `instrument:${event.target.trackId}`
        : event.target && event.target.scope === 'master'
          ? `parameter:${this.preparedSnapshot.masterNodeId}:${event.target.effectInstanceId || ''}:${event.target.parameterId}`
          : event.target ? `parameter:${event.target.trackId}:${event.target.effectInstanceId || ''}:${event.target.parameterId}` : ''
      const malformedRamp = event.type === 'parameter-ramp'
        && (!Number.isSafeInteger(event.startFrame) || !Number.isSafeInteger(event.endFrame)
          || event.startFrame !== event.frame || event.endFrame <= event.startFrame || event.interpolation !== 'linear'
          || !Number.isFinite(event.startValue) || !Number.isFinite(event.endValue))
      const malformedParameter = event.type !== 'parameter-ramp' && !isNote && !Number.isFinite(event.value)
      const malformedNote = isNote
        && (!Number.isInteger(event.noteId) || event.noteId < 1
          || !Number.isInteger(event.pitch) || event.pitch < 0 || event.pitch > 127
          || (event.type === 'note-on' && (!Number.isFinite(event.velocity) || event.velocity < 0 || event.velocity > 1)))
      if (!Number.isSafeInteger(event.frame) || event.frame < 0 || !Number.isInteger(event.sequence)
        || event.sequence <= previousSequence || event.frame < previousFrame || !targets.has(key)
        || isNote !== targetsInstrument
        || !['note-on', 'note-off', 'parameter-set', 'parameter-restore', 'parameter-ramp'].includes(event.type)
        || malformedRamp || malformedParameter || malformedNote) {
        return this.scheduleResult(message, 'rejected')
      }
      const target = targets.get(key)
      previousFrame = event.frame
      previousSequence = event.sequence
      if (target.kind === 'instrument') {
        instrumentEvents.push({
          frame: event.frame,
          nodeId: target.nodeId,
          noteId: BigInt(event.noteId),
          sequence: BigInt(event.sequence),
          type: event.type === 'note-on' ? 1 : 2,
          pitch: event.pitch,
          value: event.type === 'note-on' ? event.velocity : 0,
        })
        continue
      }
      let stream = parameterStreams.get(target.instanceId)
      if (!stream) {
        stream = {
          instanceId: target.instanceId,
          instanceIdValue: target.instanceIdValue,
          cursor: 0,
          activeRamps: [],
          rampTargets: new Map(),
          events: [],
        }
        parameterStreams.set(target.instanceId, stream)
      }
      if (event.type === 'parameter-ramp') {
        let rampIndex = stream.rampTargets.get(target.target)
        if (rampIndex === undefined) {
          rampIndex = stream.activeRamps.length
          stream.rampTargets.set(target.target, rampIndex)
          stream.activeRamps.push({ event: null })
        }
        stream.events.push({
          frame: event.frame,
          ramp: true,
          target: target.target,
          rampIndex,
          startFrame: event.startFrame,
          endFrame: event.endFrame,
          startValue: event.startValue,
          valueStep: (event.endValue - event.startValue) / (event.endFrame - event.startFrame),
        })
      } else {
        stream.events.push({
          frame: event.frame,
          ramp: false,
          target: target.target,
          value: event.value,
        })
      }
    }
    this.schedule = schedule
    this.scheduleParameterStreams = Array.from(parameterStreams.values())
      .sort((left, right) => left.instanceId - right.instanceId)
    this.scheduleInstrumentEvents = instrumentEvents
    this.resetScheduleCursors(this.currentTransportFrame())
    this.scheduleResult(message, 'installed')
  }

  scheduleResult(message, result) {
    if (Number.isInteger(message && message.requestId)) this.postMessage({
      version: PROTOCOL_VERSION, type: 'schedule-installed', requestId: message.requestId,
      revision: message.schedule && message.schedule.revision, epoch: message.schedule && message.schedule.transportEpoch, result,
    })
  }

  configureInstrument(nodeId, state) {
    if (!this.memory || !this.malloc || !this.free || !state) return false
    const node = stableId(nodeId)
    if (state.kind === 'synth') {
      if (!this.synthConfigure) return false
      const allocation = this.malloc(156)
      if (!allocation) return false
      const view = new DataView(this.memory.buffer, allocation, 156)
      view.setUint32(0, 1, true)
      view.setUint32(4, 0xA341316C, true)
      const oscillators = state.oscillators || [
        { enabled: true, waveform: 0, level: 0.5, octave: 0, semitone: 0, detuneCents: 0 },
        { enabled: true, waveform: 0, level: 0.5, octave: 0, semitone: 0, detuneCents: 0 },
      ]
      oscillators.forEach((oscillator, index) => {
        const offset = 8 + index * 24
        view.setUint32(offset, oscillator.enabled ? 1 : 0, true)
        view.setUint32(offset + 4, oscillator.waveform, true)
        view.setFloat32(offset + 8, oscillator.level, true)
        view.setInt32(offset + 12, oscillator.octave, true)
        view.setInt32(offset + 16, oscillator.semitone, true)
        view.setFloat32(offset + 20, oscillator.detuneCents, true)
      })
      view.setUint32(56, state.noiseEnabled ? 1 : 0, true)
      view.setFloat32(60, state.noiseLevel, true)
      view.setUint32(64, state.filterEnabled ? 1 : 0, true)
      view.setUint32(68, state.filterMode, true)
      view.setFloat32(72, state.filterCutoffHz, true)
      view.setFloat32(76, state.filterResonance, true)
      view.setFloat32(80, state.filterKeyTracking, true)
      view.setFloat32(84, state.filterEnvelopeAmountOctaves, true)
      view.setFloat32(88, state.filterAttackMs, true)
      view.setFloat32(92, state.filterDecayMs, true)
      view.setFloat32(96, state.filterSustain, true)
      view.setFloat32(100, state.filterReleaseMs, true)
      view.setFloat32(104, state.ampAttackMs, true)
      view.setFloat32(108, state.ampDecayMs, true)
      view.setFloat32(112, state.ampSustain, true)
      view.setFloat32(116, state.ampReleaseMs, true)
      view.setUint32(120, state.lfoEnabled ? 1 : 0, true)
      view.setUint32(124, state.lfoWaveform, true)
      view.setFloat32(128, state.lfoRateHz, true)
      view.setFloat32(132, state.lfoPitchCents, true)
      view.setFloat32(136, state.lfoFilterOctaves, true)
      view.setFloat32(140, state.lfoAmplitude, true)
      view.setFloat32(144, state.lfoPan, true)
      view.setFloat32(148, state.outputGain, true)
      view.setFloat32(152, state.outputPan, true)
      const result = this.synthConfigure(node, allocation) === 0
      this.free(allocation)
      return result
    }
    if (state.kind === 'granular') {
      const asset = this.assets.get(state.assetId)
      if (!asset || !this.granularConfigure) return false
      const allocation = this.malloc(60)
      if (!allocation) return false
      const view = new DataView(this.memory.buffer, allocation, 60)
      view.setUint32(0, 1, true)
      view.setBigUint64(4, asset.handle.value, true)
      view.setUint32(12, state.seed, true)
      view.setUint32(16, state.maxGrains, true)
      view.setUint32(20, state.windowShape === 'hann' ? 0 : state.windowShape === 'tukey' ? 1 : 2, true)
      view.setUint32(24, state.freeze ? 1 : 0, true)
      ;[state.grainSizeMs, state.densityHz, state.position, state.spray, state.pitchSemitones, state.reverseProbability, state.stereoSpread]
        .forEach((value, index) => view.setFloat32(28 + index * 4, value, true))
      const result = this.granularConfigure(node, allocation) === 0
      this.free(allocation)
      return result
    }
    if (!this.samplerConfigure || !Array.isArray(state.zones) || state.zones.length === 0 || state.zones.length > 32) return false
    const allocation = this.malloc(44 + state.zones.length * 72)
    if (!allocation) return false
    const view = new DataView(this.memory.buffer, allocation, 44 + state.zones.length * 72)
    view.setUint32(0, 1, true)
    view.setUint32(4, state.zones.length, true)
    ;[state.ampAttackMs, state.ampDecayMs, state.ampSustain, state.ampReleaseMs].forEach((value, index) => view.setFloat32(8 + index * 4, value, true))
    view.setUint32(24, state.filterEnabled ? 1 : 0, true)
    view.setUint32(28, state.filterMode === 'lowpass' ? 0 : 1, true)
    view.setFloat32(32, state.filterCutoffHz, true)
    view.setFloat32(36, state.filterResonance, true)
    view.setUint32(40, state.retrigger ? 1 : 0, true)
    for (let index = 0; index < state.zones.length; index += 1) {
      const zone = state.zones[index]
      const asset = this.assets.get(zone.assetId)
      if (!asset) {
        this.free(allocation)
        return false
      }
      const offset = allocation + 44 + index * 72
      view.setBigUint64(offset - allocation, asset.handle.value, true)
      ;[zone.keyLow, zone.keyHigh, zone.velocityLow, zone.velocityHigh, zone.rootNote].forEach((value, integerIndex) => view.setUint32(offset - allocation + 8 + integerIndex * 4, value, true))
      view.setFloat32(offset - allocation + 28, zone.tuneCents, true)
      view.setFloat32(offset - allocation + 32, zone.gain, true)
      view.setFloat32(offset - allocation + 36, zone.pan, true)
      ;[zone.roundRobinGroup, zone.roundRobinIndex, zone.playbackMode === 'one-shot' ? 0 : 1, zone.startFrame, zone.endFrame, zone.loopStartFrame, zone.loopEndFrame, zone.chokeGroup]
        .forEach((value, integerIndex) => view.setUint32(offset - allocation + 40 + integerIndex * 4, value, true))
    }
    const result = this.samplerConfigure(node, allocation, allocation + 44) === 0
    this.free(allocation)
    return result
  }

  registerAsset(message) {
    if (!this.ready || !this.memory || !this.assetRegister || !this.free || !Number.isInteger(message.requestId) || !Number.isInteger(message.generation) || !message.asset || !Array.isArray(message.planes)) return this.assetRegistrationResult(message, 'invalid-pcm')
    if (message.generation < this.assetGeneration) return this.assetRegistrationResult(message, 'stale-generation')
    if (message.generation > this.assetGeneration) {
      this.releaseAllAssets()
      this.assetGeneration = message.generation
    }
    const asset = message.asset
    if (!Number.isInteger(asset.frameCount) || asset.frameCount < 1 || !Number.isInteger(asset.sampleRateHz) || asset.sampleRateHz < 1 || !Number.isInteger(asset.channelCount) || asset.channelCount < 1 || asset.channelCount > 64 || typeof asset.assetId !== 'string' || asset.assetId.length === 0 || message.planes.length !== asset.channelCount || !message.planes.every((plane) => plane instanceof Float32Array && plane.length === asset.frameCount)) return this.assetRegistrationResult(message, 'invalid-pcm')
    const existing = this.assets.get(asset.assetId)
    if (existing) {
      existing.retainCount += 1
      return this.assetRegistrationResult(message, 'registered', existing.handle)
    }
    const planeBytes = asset.frameCount * Float32Array.BYTES_PER_ELEMENT
    const pointersBytes = asset.channelCount * Uint32Array.BYTES_PER_ELEMENT
    const allocation = this.assetRegisterAllocation(planeBytes * asset.channelCount + pointersBytes + 8)
    if (!allocation) return this.assetRegistrationResult(message, 'capacity-exceeded')
    const pointers = new Uint32Array(this.memory.buffer, allocation, asset.channelCount)
    const planeStart = allocation + pointersBytes
    for (let channel = 0; channel < asset.channelCount; channel += 1) {
      const pointer = planeStart + planeBytes * channel
      pointers[channel] = pointer
      new Float32Array(this.memory.buffer, pointer, asset.frameCount).set(message.planes[channel])
    }
    const outHandle = planeStart + planeBytes * asset.channelCount
    const result = this.assetRegister(asset.frameCount, asset.sampleRateHz, asset.channelCount, allocation, outHandle)
    if (result !== 0) {
      this.free(allocation)
      return this.assetRegistrationResult(message, result === 3 ? 'capacity-exceeded' : 'invalid-pcm')
    }
    const handleValue = new DataView(this.memory.buffer, outHandle, 8).getBigUint64(0, true)
    const handle = {
      slot: Number(handleValue & 0xffffffffn) - 1,
      generation: Number(handleValue >> 32n),
      value: handleValue,
    }
    this.assets.set(asset.assetId, {
      handle,
      allocation,
      retainCount: 1,
    })
    this.assetRegistrationResult(message, 'registered', handle)
  }

  assetRegisterAllocation(byteLength) {
    return this.malloc ? this.malloc(byteLength) : 0
  }

  releaseAsset(message) {
    if (!Number.isInteger(message.requestId) || !Number.isInteger(message.generation) || typeof message.assetId !== 'string') return this.assetReleaseResult(message, 'stale-generation')
    if (message.generation !== this.assetGeneration) return this.assetReleaseResult(message, 'stale-generation')
    const existing = this.assets.get(message.assetId)
    if (!existing) return this.assetReleaseResult(message, 'stale-generation')
    existing.retainCount -= 1
    if (existing.retainCount === 0) this.releaseStoredAsset(message.assetId, existing)
    this.assetReleaseResult(message, 'released')
  }

  releaseAllAssets() {
    for (const [assetId, asset] of this.assets) this.releaseStoredAsset(assetId, asset)
  }

  releaseStoredAsset(assetId, asset) {
    if (this.assetRelease) this.assetRelease(asset.handle.value)
    if (this.free) this.free(asset.allocation)
    this.assets.delete(assetId)
  }

  assetRegistrationResult(message, result, handle) {
    if (Number.isInteger(message && message.requestId)) this.postMessage({
      version: PROTOCOL_VERSION,
      type: 'asset-registered',
      requestId: message.requestId,
      generation: message.generation,
      assetId: message.asset && typeof message.asset.assetId === 'string' ? message.asset.assetId : '',
      result,
      ...(result === 'registered' && handle ? { handle: { slot: handle.slot, generation: handle.generation } } : {}),
    })
  }

  assetReleaseResult(message, result) {
    if (Number.isInteger(message && message.requestId)) this.postMessage({ version: PROTOCOL_VERSION, type: 'asset-released', requestId: message.requestId, generation: message.generation, assetId: typeof message.assetId === 'string' ? message.assetId : '', result })
  }

  scheduleSources(message) {
    if (!this.ready || !this.sourceSchedule || !Number.isInteger(message.requestId) || !Number.isInteger(message.revision)
      || message.revision !== this.revision || !Number.isInteger(message.epoch) || message.epoch !== this.transportEpoch
      || !Array.isArray(message.events) || message.events.length > 256) {
      return this.sourceScheduleResult(message, 'rejected')
    }
    let previousSequence = 0
    for (const event of message.events) {
      if (!event || event.version !== 1 || event.epoch !== message.epoch || !Number.isInteger(event.sequence)
        || event.sequence <= previousSequence || typeof event.sourceNodeId !== 'string' || event.sourceNodeId.length === 0
        || typeof event.assetId !== 'string' || !this.assets.has(event.assetId)
        || !Number.isSafeInteger(event.startFrame) || !Number.isSafeInteger(event.stopFrame) || event.stopFrame <= event.startFrame
        || !Number.isSafeInteger(event.sourceOffsetFrame) || event.sourceOffsetFrame < 0 || !Number.isSafeInteger(event.sourceFrameCount)
        || event.sourceFrameCount < 1 || typeof event.gain !== 'number' || !Number.isFinite(event.gain)
        || !Number.isSafeInteger(event.fadeInStartFrame) || !Number.isSafeInteger(event.fadeInEndFrame)
        || event.fadeInEndFrame < event.fadeInStartFrame || !Number.isSafeInteger(event.fadeOutStartFrame)
        || !Number.isSafeInteger(event.fadeOutEndFrame) || event.fadeOutEndFrame < event.fadeOutStartFrame) {
        return this.sourceScheduleResult(message, 'rejected')
      }
      const handle = this.assets.get(event.assetId).handle.value
      const result = this.sourceSchedule(message.epoch, BigInt(event.sequence), stableId(event.sourceNodeId), handle,
        BigInt(event.startFrame), BigInt(event.stopFrame), BigInt(event.sourceOffsetFrame), BigInt(event.sourceFrameCount), event.gain,
        BigInt(event.fadeInStartFrame), BigInt(event.fadeInEndFrame), BigInt(event.fadeOutStartFrame), BigInt(event.fadeOutEndFrame))
      if (result !== 0) return this.sourceScheduleResult(message, 'rejected')
      previousSequence = event.sequence
    }
    this.sourceScheduleResult(message, 'scheduled')
  }

  sourceScheduleResult(message, result) {
    if (Number.isInteger(message && message.requestId)) this.postMessage({
      version: PROTOCOL_VERSION,
      type: 'sources-scheduled',
      requestId: message.requestId,
      revision: message.revision,
      epoch: message.epoch,
      result,
    })
  }

  configureRecordingCapture(message) {
    if (!this.ready || !this.memory || !this.recordingCaptureInitialize || !Number.isSafeInteger(message.generation)
      || message.generation < 0 || !Number.isSafeInteger(message.sessionId) || message.sessionId < 0
      || (message.channelCount !== 1 && message.channelCount !== 2)
      || !Array.isArray(message.inputChannels) || message.inputChannels.length !== message.channelCount
      || !message.inputChannels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel < 64)
      || !Number.isFinite(message.gain) || message.gain < 0 || (message.polarity !== 1 && message.polarity !== -1)
      || typeof message.monitoring !== 'boolean'
      || !Number.isSafeInteger(message.punchStartFrame) || message.punchStartFrame < 0
      || (message.punchEndFrame !== null && (!Number.isSafeInteger(message.punchEndFrame) || message.punchEndFrame < message.punchStartFrame))) {
      return this.fault('malformed-message')
    }
    const view = new DataView(this.memory.buffer, this.recordingCaptureConfigOffset, 56)
    view.setUint32(0, ABI_VERSION, true)
    view.setUint32(4, message.generation, true)
    view.setBigUint64(8, BigInt(message.sessionId), true)
    view.setUint32(16, message.channelCount, true)
    view.setUint32(20, message.inputChannels[0] || 0, true)
    view.setUint32(24, message.inputChannels[1] || 0, true)
    view.setFloat32(28, message.gain, true)
    view.setInt32(32, message.polarity, true)
    view.setBigInt64(40, BigInt(message.punchStartFrame), true)
    view.setBigInt64(48, BigInt(message.punchEndFrame === null ? -1 : message.punchEndFrame), true)
    if (this.recordingCaptureInitialize(this.recordingCaptureConfigOffset) !== 0) return this.fault('core-error')
    this.recordingMonitoring = message.monitoring
    this.recordingCaptureActive = true
    this.recordingInputBusCount = Math.floor(Math.max(...message.inputChannels) / CHANNEL_COUNT) + 1
    this.recordingCaptureGeneration = message.generation
    this.recordingCaptureSessionId = message.sessionId
    this.recordingCaptureNotificationPending = false
    this.recordingCaptureFinalizePending = false
    this.recordingCaptureAvailableMessage = {
      version: PROTOCOL_VERSION,
      type: 'recording-capture-available',
      generation: message.generation,
      sessionId: message.sessionId,
    }
    this.postMessage({
      version: PROTOCOL_VERSION,
      type: 'recording-capture-applied',
      generation: message.generation,
      sessionId: message.sessionId,
      action: 'configured',
      frame: this.transportFrame + this.framesProcessed - this.transportProcessOrigin,
    })
  }

  drainRecordingCapture() {
    if (!this.ready || !this.memory || !this.recordingCaptureDequeue || !this.recordingCaptureDiagnostics
      || !this.recordingCaptureOutputPlanes) return this.fault('initialization-failed')
    const metadata = new DataView(this.memory.buffer, this.recordingCaptureBlockOffset, 48)
    if (this.recordingCaptureDequeue(this.recordingCaptureOutputPointerOffset, this.recordingCaptureBlockOffset) === 0) {
      const channelCount = metadata.getUint32(28, true)
      const frameCount = metadata.getUint32(24, true)
      const planes = []
      for (let channel = 0; channel < channelCount; channel += 1) {
        planes.push(this.recordingCaptureOutputPlanes[channel].slice(0, frameCount))
      }
      this.postMessage({
        version: PROTOCOL_VERSION,
        type: 'recording-capture-block',
        generation: metadata.getUint32(0, true),
        sessionId: Number(metadata.getBigUint64(8, true)),
        sequence: metadata.getUint32(16, true),
        frameCount,
        channelCount,
        planes,
        rms: metadata.getFloat32(40, true),
        peak: metadata.getFloat32(44, true),
      })
    }
    this.recordingCaptureNotificationPending = false
    const diagnostics = this.postRecordingCaptureDiagnostics()
    if (this.recordingCaptureFinalizePending && diagnostics && diagnostics.getUint32(40, true) === 0) {
      this.recordingCaptureFinalizePending = false
      this.postMessage({
        version: PROTOCOL_VERSION,
        type: 'recording-capture-applied',
        generation: this.recordingCaptureGeneration,
        sessionId: this.recordingCaptureSessionId,
        action: 'finalized',
        frame: this.recordingCaptureStopFrame,
      })
    }
  }

  postRecordingCaptureDiagnostics() {
    if (!this.ready || !this.memory || !this.recordingCaptureDiagnostics
      || this.recordingCaptureDiagnostics(this.recordingCaptureDiagnosticsOffset) !== 0) return this.fault('core-error')
    const diagnostics = this.recordingCaptureDiagnosticsView
    if (!diagnostics) return this.fault('initialization-failed')
    this.postMessage({
      version: PROTOCOL_VERSION,
      type: 'recording-capture-diagnostics',
      generation: diagnostics.getUint32(0, true),
      sessionId: Number(diagnostics.getBigUint64(8, true)),
      capturedFrames: Number(diagnostics.getBigUint64(16, true)),
      droppedFrames: Number(diagnostics.getBigUint64(24, true)),
      droppedBlocks: diagnostics.getUint32(32, true),
      availableBlocks: diagnostics.getUint32(36, true),
      queuedBlocks: diagnostics.getUint32(40, true),
      rms: diagnostics.getFloat32(44, true),
      peak: diagnostics.getFloat32(48, true),
      fatal: diagnostics.getUint32(52, true) !== 0,
      active: diagnostics.getUint32(56, true) !== 0,
    })
    return diagnostics
  }

  materializeSchedule(startFrame, frameCount) {
    if (!this.schedule || this.schedule.transportEpoch !== this.transportEpoch || this.schedule.revision !== this.revision
      || !this.scheduleEventView || !this.scheduleInstrumentEventView
      || !this.scheduleParameterStreams || !this.scheduleInstrumentEvents) return false
    let processorCount = 0
    let instrumentCount = 0
    const endFrame = startFrame + frameCount
    for (const stream of this.scheduleParameterStreams) {
      while (stream.cursor < stream.events.length && stream.events[stream.cursor].frame < startFrame) {
        const expired = stream.events[stream.cursor]
        if (expired.ramp && expired.endFrame > startFrame) {
          stream.activeRamps[expired.rampIndex].event = expired
        }
        stream.cursor += 1
        this.scheduleCursor += 1
      }
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        for (const active of stream.activeRamps) {
          const ramp = active.event
          if (!ramp) continue
          if (frame >= ramp.endFrame) {
            active.event = null
            continue
          }
          if (processorCount >= 256) return null
          const offset = 4 + processorCount * 20
          this.scheduleEventView.setBigUint64(offset, stream.instanceIdValue, true)
          this.scheduleEventView.setUint32(offset + 8, ramp.target, true)
          this.scheduleEventView.setUint32(offset + 12, frame - startFrame, true)
          this.scheduleEventView.setFloat32(offset + 16, ramp.startValue + (frame - ramp.startFrame) * ramp.valueStep, true)
          processorCount += 1
        }
        while (stream.cursor < stream.events.length && stream.events[stream.cursor].frame === frame) {
          const event = stream.events[stream.cursor]
          stream.cursor += 1
          this.scheduleCursor += 1
          if (event.ramp) {
            stream.activeRamps[event.rampIndex].event = event
            if (processorCount >= 256) return null
            const offset = 4 + processorCount * 20
            this.scheduleEventView.setBigUint64(offset, stream.instanceIdValue, true)
            this.scheduleEventView.setUint32(offset + 8, event.target, true)
            this.scheduleEventView.setUint32(offset + 12, frame - startFrame, true)
            this.scheduleEventView.setFloat32(offset + 16, event.startValue, true)
            processorCount += 1
            continue
          }
          if (processorCount >= 256) return null
          const offset = 4 + processorCount * 20
          this.scheduleEventView.setBigUint64(offset, stream.instanceIdValue, true)
          this.scheduleEventView.setUint32(offset + 8, event.target, true)
          this.scheduleEventView.setUint32(offset + 12, frame - startFrame, true)
          this.scheduleEventView.setFloat32(offset + 16, event.value, true)
          processorCount += 1
        }
      }
    }
    while (this.scheduleInstrumentCursor < this.scheduleInstrumentEvents.length
      && this.scheduleInstrumentEvents[this.scheduleInstrumentCursor].frame < startFrame) {
      this.scheduleInstrumentCursor += 1
      this.scheduleCursor += 1
    }
    while (this.scheduleInstrumentCursor < this.scheduleInstrumentEvents.length) {
      const event = this.scheduleInstrumentEvents[this.scheduleInstrumentCursor]
      if (event.frame >= endFrame) break
      if (instrumentCount >= 256) return null
      const offset = 4 + instrumentCount * 48
      this.scheduleInstrumentEventView.setBigUint64(offset, event.nodeId, true)
      this.scheduleInstrumentEventView.setBigUint64(offset + 8, event.noteId, true)
      this.scheduleInstrumentEventView.setBigUint64(offset + 16, event.sequence, true)
      this.scheduleInstrumentEventView.setUint32(offset + 24, this.transportEpoch, true)
      this.scheduleInstrumentEventView.setUint32(offset + 28, event.frame - startFrame, true)
      this.scheduleInstrumentEventView.setUint32(offset + 32, event.type, true)
      this.scheduleInstrumentEventView.setUint32(offset + 36, 0, true)
      this.scheduleInstrumentEventView.setUint32(offset + 40, event.pitch, true)
      this.scheduleInstrumentEventView.setFloat32(offset + 44, event.value, true)
      this.scheduleInstrumentCursor += 1
      this.scheduleCursor += 1
      instrumentCount += 1
    }
    this.scheduleEventView.setUint32(0, processorCount, true)
    this.scheduleInstrumentEventView.setUint32(0, instrumentCount, true)
    this.scheduleEventCount = processorCount
    this.scheduleInstrumentEventCount = instrumentCount
    return true
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (this.disposed) return false
    if (!output || output.length === 0 || !this.ready || !this.coreProcess) return true
    const frames = output[0] ? output[0].length : 0
    if (frames > this.maxFramesPerBlock) {
      for (let channel = 0; channel < output.length; channel += 1) output[channel].fill(0)
      return true
    }
    const inputBusCount = Math.min(inputs.length, MAX_INPUT_BUSES)
    const stagedInputBusCount = Math.min(
      Math.max(inputBusCount, this.liveInputBusCount, this.recordingCaptureActive ? this.recordingInputBusCount : 0),
      MAX_INPUT_BUSES,
    )
    const busesToWrite = Math.max(stagedInputBusCount, this.stagedInputBusCount)
    for (let bus = 0; bus < busesToWrite; bus += 1) {
      const input = bus < inputBusCount ? inputs[bus] : null
      for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
        const target = this.inputPlanes[bus * CHANNEL_COUNT + channel]
        const source = input && (input[channel] || input[0])
        for (let frame = 0; frame < frames; frame += 1) target[frame] = source ? source[frame] : 0
      }
    }
    this.stagedInputBusCount = stagedInputBusCount
    const startFrame = this.currentTransportFrame()
    if (this.recordingCaptureActive && this.recordingCaptureProcessMonitor && this.recordingMonitorPlanes) {
      const captureResult = this.recordingCaptureProcessMonitor(
        this.inputPointerOffset,
        stagedInputBusCount * CHANNEL_COUNT,
        this.recordingMonitorPointerOffset,
        CHANNEL_COUNT,
        frames,
        BigInt(startFrame),
      )
      if (captureResult !== 0) {
        this.recordingCaptureActive = false
        this.recordingInputBusCount = 0
        if (!this.recordingCaptureNotificationPending && this.recordingCaptureAvailableMessage) {
          this.recordingCaptureNotificationPending = true
          this.postMessage(this.recordingCaptureAvailableMessage)
        }
      }
    }
    const materialized = this.materializeSchedule(startFrame, frames)
    if (materialized === null) {
      for (let channel = 0; channel < output.length; channel += 1) output[channel].fill(0)
      return true
    }
    const eventOffset = materialized ? this.scheduleEventOffset : this.eventOffset
    const eventByteCount = materialized ? 4 + this.scheduleEventCount * 20 : this.eventByteCount
    const instrumentEventOffset = materialized ? this.scheduleInstrumentEventOffset : this.instrumentEventOffset
    const instrumentEventByteCount = materialized ? 4 + this.scheduleInstrumentEventCount * 48 : this.instrumentEventByteCount
    const result = this.coreProcess(frames, stagedInputBusCount, CHANNEL_COUNT, this.inputPointerOffset, this.outputPointerOffset, this.revision, this.parameterOffset, this.parameterByteCount, eventOffset, eventByteCount, instrumentEventOffset, instrumentEventByteCount)
    if (result !== 0) {
      for (let channel = 0; channel < output.length; channel += 1) output[channel].fill(0)
      return true
    }
    this.eventByteCount = 0
    this.instrumentEventByteCount = 0
    for (let frame = 0; frame < frames; frame += 1) {
      output[0][frame] = this.leftOutput[frame] + (
        this.recordingCaptureActive && this.recordingMonitoring ? this.recordingMonitorPlanes[0][frame] : 0
      )
      if (output[1]) output[1][frame] = this.rightOutput[frame] + (
        this.recordingCaptureActive && this.recordingMonitoring ? this.recordingMonitorPlanes[1][frame] : 0
      )
    }
    this.framesProcessed += frames
    if (this.recordingCaptureActive && !this.recordingCaptureNotificationPending && this.recordingCaptureDiagnostics
      && this.recordingCaptureDiagnostics(this.recordingCaptureDiagnosticsOffset) === 0) {
      const diagnostics = this.recordingCaptureDiagnosticsView
      if (!diagnostics) return true
      if (diagnostics.getUint32(40, true) > 0) {
        this.recordingCaptureNotificationPending = true
        this.postMessage(this.recordingCaptureAvailableMessage)
      }
      if (diagnostics.getUint32(52, true) !== 0
        && !this.recordingCaptureNotificationPending && this.recordingCaptureAvailableMessage) {
        this.recordingCaptureNotificationPending = true
        this.postMessage(this.recordingCaptureAvailableMessage)
      }
    }
    return true
  }
}