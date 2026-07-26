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
  readPortableWasmRecordingStatusMessage,
  type PortableWasmControlMessage,
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
  resolve: (message: Record<string, unknown>) => void
  reject: (error: Error) => void
  deadline: ReturnType<typeof setTimeout>
}

const portableControlTimeoutMs = 2_000

type PortableWorkletNode = AudioNode & Pick<AudioWorkletNode, 'port' | 'onprocessorerror'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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

  private onMessage(value: unknown) {
    if (!isRecord(value)) return
    if (value.type === 'fault') {
      this.fail(new Error('Portable audio-core AudioWorklet control request failed.'))
      return
    }
    const recordingMessage = readPortableWasmRecordingStatusMessage(value)
    if (recordingMessage) {
      for (const listener of this.recordingListeners) listener(recordingMessage)
      return
    }
    if (typeof value.requestId !== 'number') return
    const request = this.pending.get(value.requestId)
    if (!request) return
    this.pending.delete(value.requestId)
    clearTimeout(request.deadline)
    request.resolve(value)
  }

  private request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
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

  private require(message: Record<string, unknown>, type: string, result: string) {
    if (message.type !== type || message.result !== result) throw new Error(`Portable playback ${type} was rejected.`)
  }

  async prepareGraph(snapshot: AudioCoreGraphSnapshot) {
    const response = await this.request({ type: 'prepare-graph', snapshot })
    this.require(response, 'graph-prepared', 'prepared')
  }

  async publishGraph(revision: number) {
    const response = await this.request({ type: 'publish-graph', revision })
    this.require(response, 'graph-published', 'published')
  }

  async registerAsset(asset: AudioAssetRef, pcm: PlanarPcm, generation: number): Promise<AudioAssetRegistration> {
    if (!isPlanarPcmForAsset(asset, pcm)) return { status: 'invalid-pcm' }
    const response = await this.request({ type: 'register-asset', generation, asset, planes: pcm.planes })
    if (response.type !== 'asset-registered') return { status: 'stale-generation' }
    if (response.result === 'registered' && isRecord(response.handle)
      && typeof response.handle.slot === 'number' && typeof response.handle.generation === 'number') {
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
    this.require(response, 'sources-scheduled', 'scheduled')
  }

  async setTransport(epoch: number, running: boolean, frame: number) {
    const response = await this.request({ type: 'transport', epoch, running, frame })
    this.require(response, 'transport-applied', 'applied')
    this.active = running
  }

  async installSchedule(schedule: PortableFrameSchedule) {
    const response = await this.request({ type: 'install-schedule', schedule })
    this.require(response, 'schedule-installed', 'installed')
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
  const sharedQueue = typeof SharedArrayBuffer === 'function'
    && typeof crossOriginIsolated === 'boolean'
    && crossOriginIsolated
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
          if (typeof event.data === 'object' && event.data !== null && 'type' in event.data && event.data.type === 'fault') {
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

  isReady(message: unknown): message is Extract<PortableWasmStatusMessage, { type: 'ready' }> {
    return typeof message === 'object'
      && message !== null
      && 'version' in message
      && 'type' in message
      && message.version === portableWasmProtocolVersion
      && message.type === 'ready'
  }

  get abiVersion() {
    return audioCoreWasmAbiVersion
  }
}
