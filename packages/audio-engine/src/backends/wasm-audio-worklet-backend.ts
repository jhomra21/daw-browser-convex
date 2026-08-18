import {
  audioCoreWasmAbiVersion,
  loadAudioCoreWasmArtifact,
  type AudioCoreWasmArtifactResult,
} from '../../../audio-core-wasm/src/index'
import {
  isPlanarPcmForAsset,
  type AudioAssetRef,
  type AudioCoreGraphSnapshot,
  type AudioCoreSampleSourceEventDto,
  type PlanarPcm,
} from '../../../audio-core-contract/src/index'
import { processorContractHash } from '../../../audio-core-contract/src/generated/processor-contract-metadata'
import type { AudioAssetRegistration, AudioAssetRelease } from '../audio-asset-types'
import { loadWorkletModule } from '../worklet-loader'
import {
  createPortableWasmInitializeMessage,
  portableWasmProtocolVersion,
  readPortableWasmGraphContinuityMessage,
  readPortableWasmRecordingStatusMessage,
  readPortableWasmTransportPositionMessage,
  type PortableWasmControlMessage,
  type PortableWasmProcessorEvent,
  type PortableWasmStatusMessage,
} from '../portable-wasm-protocol'
import type { PortableFrameSchedule } from '../portable-frame-scheduling'
import {
  portableAudioCoreWorklet,
  resolvePortableWasmManifestUrl,
  resolveWorkletModuleUrl,
} from '../worklet-manifest'
import { portableWasmCapabilityMatrix } from './portable-wasm-capabilities'

export type PortableProjectSupport = {
  processorKinds: readonly string[]
  trackCount: number
  hasClips: boolean
  hasRouting: boolean
  hasAutomation: boolean
  hasExternalPlugins: boolean
  sampleRateHz?: number
  inputBusCount?: number
  channelCount?: number
  hasSynthMidi?: boolean
}

export type PortableWasmCapability =
  | { available: true; artifact: Extract<AudioCoreWasmArtifactResult, { available: true }>['artifact']; sharedQueue: 'unavailable-without-cross-origin-isolation' | 'available' }
  | { available: false; reason: string }

export type PortableWasmBackendSelection =
  | { selected: true; capability: Extract<PortableWasmCapability, { available: true }> }
  | { selected: false; reason: string }

type PendingPortableRequest = {
  resolve: (message: PortableRequestStatus) => void
  reject: (error: Error) => void
  deadline: ReturnType<typeof setTimeout>
}

const portableControlTimeoutMs = 2_000

type PortableWorkletNode = AudioNode & Pick<AudioWorkletNode, 'port' | 'onprocessorerror'>
type PortableWireValue =
  | null
  | boolean
  | number
  | string
  | PortableWireValue[]
  | { [key: string]: PortableWireValue }
  | Float32Array
  | Uint8Array

type PortableRequestMessage = PortableWasmControlMessage extends infer Message
  ? Message extends { requestId: number }
    ? Omit<Message, 'version' | 'requestId'>
    : never
  : never

type PortableRequestStatus = Extract<PortableWasmStatusMessage, { requestId: number }>

const isWireObject = (value: PortableWireValue): value is { [key: string]: PortableWireValue } =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && !(value instanceof Float32Array)
  && !(value instanceof Uint8Array)

const isFiniteNumber = (value: PortableWireValue | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isString = (value: PortableWireValue | undefined): value is string =>
  typeof value === 'string'

const isPositiveInteger = (value: PortableWireValue | undefined): value is number =>
  isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0

const isNonNegativeInteger = (value: PortableWireValue | undefined): value is number =>
  isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0

const isRegisteredAssetHandle = (
  value: PortableWireValue | undefined,
): value is { slot: number; generation: number } =>
  value !== undefined
  && isWireObject(value)
  && isNonNegativeInteger(value.slot)
  && isPositiveInteger(value.generation)

const readPortableRequestStatus = (value: PortableWireValue): PortableRequestStatus | null => {
  if (!isWireObject(value)
    || value.version !== portableWasmProtocolVersion
    || !isPositiveInteger(value.requestId)) return null
  if (value.type === 'graph-prepared'
    && isPositiveInteger(value.revision)
    && (value.result === 'prepared' || value.result === 'rejected')) {
    return {
      version: portableWasmProtocolVersion,
      type: value.type,
      requestId: value.requestId,
      revision: value.revision,
      result: value.result,
    }
  }
  if (value.type === 'graph-published'
    && isPositiveInteger(value.revision)
    && (value.result === 'published' || value.result === 'rejected')) {
    return {
      version: portableWasmProtocolVersion,
      type: value.type,
      requestId: value.requestId,
      revision: value.revision,
      result: value.result,
    }
  }
  if (value.type === 'asset-registered'
    && isPositiveInteger(value.generation)
    && isString(value.assetId)) {
    if (value.result === 'registered' && isRegisteredAssetHandle(value.handle)) {
      return {
        version: portableWasmProtocolVersion,
        type: value.type,
        requestId: value.requestId,
        generation: value.generation,
        assetId: value.assetId,
        result: value.result,
        handle: value.handle,
      }
    }
    if (value.result === 'capacity-exceeded'
      || value.result === 'stale-generation'
      || value.result === 'invalid-pcm') {
      return {
        version: portableWasmProtocolVersion,
        type: value.type,
        requestId: value.requestId,
        generation: value.generation,
        assetId: value.assetId,
        result: value.result,
      }
    }
  }
  if (value.type === 'asset-released'
    && isPositiveInteger(value.generation)
    && isString(value.assetId)
    && (value.result === 'released' || value.result === 'stale-generation')) {
    return {
      version: portableWasmProtocolVersion,
      type: value.type,
      requestId: value.requestId,
      generation: value.generation,
      assetId: value.assetId,
      result: value.result,
    }
  }
  if (value.type === 'transport-applied'
    && isPositiveInteger(value.epoch)
    && (value.result === 'applied' || value.result === 'rejected')) {
    return {
      version: portableWasmProtocolVersion,
      type: value.type,
      requestId: value.requestId,
      epoch: value.epoch,
      result: value.result,
    }
  }
  if (value.type === 'schedule-installed'
    && isPositiveInteger(value.revision)
    && isPositiveInteger(value.epoch)
    && (value.result === 'installed' || value.result === 'rejected')) {
    return {
      version: portableWasmProtocolVersion,
      type: value.type,
      requestId: value.requestId,
      revision: value.revision,
      epoch: value.epoch,
      result: value.result,
    }
  }
  if (value.type === 'sources-scheduled'
    && isPositiveInteger(value.revision)
    && isPositiveInteger(value.epoch)
    && (value.result === 'scheduled' || value.result === 'rejected')) {
    return {
      version: portableWasmProtocolVersion,
      type: value.type,
      requestId: value.requestId,
      revision: value.revision,
      epoch: value.epoch,
      result: value.result,
    }
  }
  if (value.type === 'processor-events-applied'
    && isPositiveInteger(value.revision)
    && isPositiveInteger(value.epoch)
    && isPositiveInteger(value.sequence)
    && (value.result === 'applied' || value.result === 'rejected')) {
    return {
      version: portableWasmProtocolVersion,
      type: value.type,
      requestId: value.requestId,
      revision: value.revision,
      epoch: value.epoch,
      sequence: value.sequence,
      result: value.result,
    }
  }
  if (value.type === 'processor-automation-reenabled'
    && isPositiveInteger(value.revision)
    && isPositiveInteger(value.epoch)
    && (value.result === 'applied' || value.result === 'rejected')) {
    return {
      version: portableWasmProtocolVersion,
      type: value.type,
      requestId: value.requestId,
      revision: value.revision,
      epoch: value.epoch,
      result: value.result,
    }
  }
  return null
}

const isPortableFault = (
  value: PortableWireValue,
): value is Extract<PortableWasmStatusMessage, { type: 'fault' }> =>
  isWireObject(value)
  && value.version === portableWasmProtocolVersion
  && value.type === 'fault'
  && (value.code === 'malformed-message'
    || value.code === 'abi-mismatch'
    || value.code === 'contract-mismatch'
    || value.code === 'capacity-exceeded'
    || value.code === 'initialization-failed'
    || value.code === 'event-overflow'
    || value.code === 'core-error')

const hasSharedQueueSupport = (
  environment: typeof globalThis,
): environment is typeof globalThis & { crossOriginIsolated: true } =>
  typeof environment.SharedArrayBuffer === 'function'
  && environment.crossOriginIsolated === true

const disposePortableWorkletNode = (node: PortableWorkletNode, output?: AudioNode) => {
  node.port.onmessage = null
  node.onprocessorerror = null
  try {
    node.port.postMessage({ version: portableWasmProtocolVersion, type: 'dispose' })
  } catch {}
  try {
    if (output) node.disconnect(output)
    else node.disconnect()
  } catch {}
  try {
    node.port.close()
  } catch {}
}

/**
 * Owns the one AudioWorklet message port for a portable playback attempt.
 * Nothing is activated until graph publication, asset registration, source
 * scheduling, and transport acknowledgement have all completed.
 */
export class PortableWasmPlaybackSession {
  private nextRequestId = 1
  private pending = new Map<number, PendingPortableRequest>()
  private faultListeners = new Set<(error: Error) => void>()
  private recordingListeners = new Set<(message: PortableWasmStatusMessage) => void>()
  private graphContinuityListeners = new Set<(message: Extract<PortableWasmStatusMessage, { type: 'graph-continuity' }>) => void>()
  private transportPositionListeners = new Set<(message: Extract<PortableWasmStatusMessage, { type: 'transport-position' }>) => void>()
  private active = false
  private disposed = false

  constructor(
    readonly node: PortableWorkletNode,
    private readonly output?: AudioNode,
    private readonly controlTimeoutMs = portableControlTimeoutMs,
  ) {
    node.port.onmessage = (event) => this.onMessage(event.data)
    node.onprocessorerror = () => this.fail(new Error('Portable audio-core AudioWorklet processing failed.'))
    if (output) node.connect(output)
  }

  private fail(error: Error) {
    if (this.disposed) return
    this.active = false
    for (const request of this.pending.values()) {
      clearTimeout(request.deadline)
      request.reject(error)
    }
    this.pending.clear()
    for (const listener of this.faultListeners) listener(error)
    this.dispose()
  }

  private onMessage(value: PortableWireValue) {
    if (isPortableFault(value)) {
      this.fail(new Error('Portable audio-core AudioWorklet control request failed.'))
      return
    }
    const recordingMessage = readPortableWasmRecordingStatusMessage(value)
    if (recordingMessage) {
      for (const listener of this.recordingListeners) listener(recordingMessage)
      return
    }
    const graphContinuity = readPortableWasmGraphContinuityMessage(value)
    if (graphContinuity) {
      for (const listener of this.graphContinuityListeners) listener(graphContinuity)
      return
    }
    const transportPosition = readPortableWasmTransportPositionMessage(value)
    if (transportPosition) {
      for (const listener of this.transportPositionListeners) listener(transportPosition)
      return
    }
    const response = readPortableRequestStatus(value)
    if (!response) return
    const request = this.pending.get(response.requestId)
    if (!request) return
    this.pending.delete(response.requestId)
    clearTimeout(request.deadline)
    request.resolve(response)
  }

  private request(message: PortableRequestMessage): Promise<PortableRequestStatus> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('Portable playback session was disposed.'))
        return
      }
      const requestId = this.nextRequestId
      this.nextRequestId += 1
      const deadline = setTimeout(() => {
        const request = this.pending.get(requestId)
        if (!request) return
        this.pending.delete(requestId)
        request.reject(new Error('Portable playback control request timed out.'))
        this.fail(new Error('Portable playback control request timed out.'))
      }, this.controlTimeoutMs)
      this.pending.set(requestId, { resolve, reject, deadline })
      this.node.port.postMessage({ ...message, version: portableWasmProtocolVersion, requestId })
    })
  }

  async prepareGraph(snapshot: AudioCoreGraphSnapshot) {
    const response = await this.request({ type: 'prepare-graph', snapshot })
    if (response.type !== 'graph-prepared' || response.result !== 'prepared') {
      throw new Error('Portable playback graph-prepared was rejected.')
    }
  }

  async publishGraph(revision: number) {
    const response = await this.request({ type: 'publish-graph', revision })
    if (response.type !== 'graph-published' || response.result !== 'published') {
      throw new Error('Portable playback graph-published was rejected.')
    }
  }

  async registerAsset(asset: AudioAssetRef, pcm: PlanarPcm, generation: number): Promise<AudioAssetRegistration> {
    if (!isPlanarPcmForAsset(asset, pcm)) return { status: 'invalid-pcm' }
    const response = await this.request({ type: 'register-asset', generation, asset, planes: pcm.planes })
    if (response.type !== 'asset-registered') return { status: 'stale-generation' }
    if (response.result === 'registered') {
      return { status: 'registered', handle: { slot: response.handle.slot, generation: response.handle.generation } }
    }
    if (response.result === 'capacity-exceeded' || response.result === 'invalid-pcm' || response.result === 'stale-generation') {
      return { status: response.result }
    }
    return { status: 'stale-generation' }
  }

  async releaseAsset(assetId: string, generation: number): Promise<AudioAssetRelease> {
    const response = await this.request({ type: 'release-asset', generation, assetId })
    if (response.type === 'asset-released'
      && (response.result === 'released' || response.result === 'stale-generation')) {
      return { status: response.result }
    }
    return { status: 'stale-generation' }
  }

  retireAssets(generation: number) {
    if (this.disposed) return
    this.node.port.postMessage({
      version: portableWasmProtocolVersion,
      type: 'retire-assets',
      generation,
    })
  }

  async scheduleSources(revision: number, epoch: number, events: readonly AudioCoreSampleSourceEventDto[]) {
    const response = await this.request({ type: 'schedule-sources', revision, epoch, events })
    if (response.type !== 'sources-scheduled' || response.result !== 'scheduled') {
      throw new Error('Portable playback sources-scheduled was rejected.')
    }
  }

  async setTransport(epoch: number, running: boolean, frame: number) {
    const response = await this.request({ type: 'transport', epoch, running, frame })
    if (response.type !== 'transport-applied' || response.result !== 'applied') {
      throw new Error('Portable playback transport-applied was rejected.')
    }
    this.active = running
  }

  async installSchedule(schedule: PortableFrameSchedule) {
    const response = await this.request({ type: 'install-schedule', schedule })
    if (response.type !== 'schedule-installed' || response.result !== 'installed') {
      throw new Error('Portable playback schedule-installed was rejected.')
    }
  }

  async queueProcessorEvents(
    revision: number,
    epoch: number,
    sequence: number,
    events: readonly PortableWasmProcessorEvent[],
  ) {
    if (this.disposed) throw new Error('Portable playback session was disposed.')
    const response = await this.request({
      type: 'processor-events',
      revision,
      epoch,
      sequence,
      events,
    })
    if (response.type !== 'processor-events-applied' || response.result !== 'applied') {
      throw new Error('Portable playback processor-events-applied was rejected.')
    }
  }

  async reenableProcessorAutomation(
    revision: number,
    epoch: number,
    processorInstanceId: number,
    parameterTargets: readonly number[],
  ) {
    const response = await this.request({
      type: 'reenable-processor-automation',
      revision,
      epoch,
      processorInstanceId,
      parameterTargets,
    })
    if (response.type !== 'processor-automation-reenabled' || response.result !== 'applied') {
      throw new Error('Portable playback processor-automation-reenabled was rejected.')
    }
  }

  markActive() {
    this.active = true
  }

  onFault(listener: (error: Error) => void) {
    this.faultListeners.add(listener)
    return () => this.faultListeners.delete(listener)
  }

  onRecordingStatus(listener: (message: PortableWasmStatusMessage) => void) {
    this.recordingListeners.add(listener)
    return () => this.recordingListeners.delete(listener)
  }

  onGraphContinuity(listener: (message: Extract<PortableWasmStatusMessage, { type: 'graph-continuity' }>) => void) {
    this.graphContinuityListeners.add(listener)
    return () => this.graphContinuityListeners.delete(listener)
  }

  onTransportPosition(listener: (message: Extract<PortableWasmStatusMessage, { type: 'transport-position' }>) => void) {
    this.transportPositionListeners.add(listener)
    return () => this.transportPositionListeners.delete(listener)
  }

  postRecordingControl(message: Extract<PortableWasmControlMessage, { type: `recording-capture-${string}` }>) {
    if (this.disposed) throw new Error('Portable playback session was disposed.')
    this.node.port.postMessage(message)
  }

  connectInput(source: AudioNode) {
    if (this.disposed) throw new Error('Portable playback session was disposed.')
    source.connect(this.node)
    return () => source.disconnect(this.node)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    for (const request of this.pending.values()) {
      clearTimeout(request.deadline)
      request.reject(new Error('Portable playback session was disposed.'))
    }
    this.pending.clear()
    this.faultListeners.clear()
    this.recordingListeners.clear()
    this.transportPositionListeners.clear()
    disposePortableWorkletNode(this.node, this.output)
  }

  get isActive() {
    return this.active
  }
}

const supportsTestedProject = (project: PortableProjectSupport) =>
  project.processorKinds.every((kind) => portableWasmCapabilityMatrix.processorKinds.includes(kind))
  && project.trackCount > 0
  && !project.hasExternalPlugins
  && project.sampleRateHz !== undefined
  && portableWasmCapabilityMatrix.sampleRatesHz.includes(project.sampleRateHz)
  && project.inputBusCount !== undefined
  && project.inputBusCount > 0
  && project.inputBusCount <= portableWasmCapabilityMatrix.maxInputBuses
  && project.channelCount !== undefined
  && project.channelCount > 0
  && project.channelCount <= portableWasmCapabilityMatrix.maxChannels
  && (!project.hasRouting || portableWasmCapabilityMatrix.sidechains)
  && (!project.hasAutomation || (portableWasmCapabilityMatrix.fullBlockAutomation && portableWasmCapabilityMatrix.processorEvents))
  && (!project.hasSynthMidi || portableWasmCapabilityMatrix.synthMidi)

export const detectPortableWasmCapability = async (
  manifestUrl = resolvePortableWasmManifestUrl(),
  environment = globalThis,
): Promise<PortableWasmCapability> => {
  if (!('AudioWorkletNode' in environment) || !('AudioContext' in environment)) {
    return { available: false, reason: 'AudioWorklet is unavailable.' }
  }
  const artifact = await loadAudioCoreWasmArtifact(manifestUrl)
  if (!artifact.available) return { available: false, reason: artifact.message }
  const sharedQueue = hasSharedQueueSupport(environment)
    ? 'available'
    : 'unavailable-without-cross-origin-isolation'
  return { available: true, artifact: artifact.artifact, sharedQueue }
}

export const selectPortableWasmAudioWorkletBackend = async (
  manifestUrl: string | undefined,
  project: PortableProjectSupport,
  environment = globalThis,
): Promise<PortableWasmBackendSelection> => {
  if (!supportsTestedProject(project)) return { selected: false, reason: 'The portable Wasm backend requires a project fully covered by the graph parity capability matrix.' }
  const capability = await detectPortableWasmCapability(manifestUrl ?? resolvePortableWasmManifestUrl(), environment)
  return capability.available
    ? { selected: true, capability }
    : { selected: false, reason: capability.reason }
}

export class WasmAudioWorkletBackend {
  readonly kind = 'portable-wasm'

  constructor(private readonly controlTimeoutMs = portableControlTimeoutMs) {}

  async createNode(
    context: BaseAudioContext,
    capability: Extract<PortableWasmCapability, { available: true }>,
    maxFramesPerBlock: number,
  ): Promise<AudioWorkletNode> {
    await loadWorkletModule(context, resolveWorkletModuleUrl(portableAudioCoreWorklet.modulePath))
    const node = new AudioWorkletNode(context, portableAudioCoreWorklet.processorName, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmModule: capability.artifact.module },
    })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Portable audio-core AudioWorklet initialization timed out.')),
          this.controlTimeoutMs,
        )
        node.port.onmessage = (event) => {
          if (this.isReady(event.data)) {
            resolve()
            return
          }
          if (isPortableFault(event.data)) {
            reject(new Error('Portable audio-core AudioWorklet initialization failed.'))
          }
        }
        node.port.postMessage(createPortableWasmInitializeMessage(
          processorContractHash,
          maxFramesPerBlock,
        ))
      })
      if (deadline !== undefined) clearTimeout(deadline)
      node.port.onmessage = null
    } catch (error) {
      if (deadline !== undefined) clearTimeout(deadline)
      disposePortableWorkletNode(node)
      throw error
    }
    return node
  }

  async createPlaybackSession(
    context: BaseAudioContext,
    capability: Extract<PortableWasmCapability, { available: true }>,
    maxFramesPerBlock: number,
    output: AudioNode = context.destination,
  ) {
    return new PortableWasmPlaybackSession(
      await this.createNode(context, capability, maxFramesPerBlock),
      output,
      this.controlTimeoutMs,
    )
  }

  isReady(message: PortableWireValue): message is Extract<PortableWasmStatusMessage, { type: 'ready' }> {
    return isWireObject(message)
      && message.version === portableWasmProtocolVersion
      && message.type === 'ready'
      && isNonNegativeInteger(message.revision)
  }

  get abiVersion() {
    return audioCoreWasmAbiVersion
  }
}
