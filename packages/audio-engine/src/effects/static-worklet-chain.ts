import {
  OWNED_PROCESSOR_PARAMETER_IDS,
  type OwnedProcessorKind,
} from '@daw-browser/shared'
import { loadWorkletModule } from '../worklet-loader'
import { autoFilterWorklet, gateWorklet, limiterWorklet, loFiWorklet, modulationWorklet, resolveWorkletModuleUrl, utilityWorklet } from '../worklet-manifest'
import { disconnectAudioNodes } from './chain'
import { normalizeOwnedProcessorAudioState, ownedProcessorAudioParamValues } from './owned-processor-audio-descriptors'

export type StaticWorkletKind = OwnedProcessorKind

export type GateMeterFrame = {
  gainReductionDb: number
}

export type GateMeterListener = (frame: GateMeterFrame) => void

export type StaticWorkletNodeChain = {
  kind: StaticWorkletKind
  state: 'active' | 'faulted' | 'closed'
  node: AudioWorkletNode
  fault: Error | null
  revision: number
  gateMeterListeners: Set<GateMeterListener>
}

const isModulationKind = (kind: StaticWorkletKind) =>
  kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo' || kind === 'autopan' || kind === 'ensemble'

const manifest = (kind: StaticWorkletKind) => kind === 'utility' ? utilityWorklet : kind === 'autofilter' ? autoFilterWorklet : kind === 'gate' ? gateWorklet : kind === 'limiter' ? limiterWorklet : kind === 'lofi' ? loFiWorklet : modulationWorklet

type StaticWorkletParams = unknown

export async function createStaticWorkletNodeChain(
  ctx: BaseAudioContext,
  kind: StaticWorkletKind,
  params: StaticWorkletParams,
): Promise<StaticWorkletNodeChain> {
  const asset = manifest(kind)
  await loadWorkletModule(ctx, resolveWorkletModuleUrl(asset.modulePath))
  const node = new AudioWorkletNode(ctx, asset.processorName, {
    numberOfInputs: kind === 'gate' ? 2 : 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: isModulationKind(kind) ? { processorKind: kind } : undefined,
  })
  const chain: StaticWorkletNodeChain = {
    kind,
    state: 'active',
    node,
    fault: null,
    revision: 0,
    gateMeterListeners: new Set(),
  }
  node.port.onmessage = (event) => {
    const fault = readStaticWorkletFault(event.data)
    if (fault) {
      if (chain.state === 'active') {
        chain.state = 'faulted'
        chain.fault = new Error(`${kind} processor protocol fault: ${fault}`)
        publishGateMeterReset(chain)
      }
      return
    }
    const frame = readGateMeterFrame(event.data)
    if (!frame) return
    for (const listener of chain.gateMeterListeners) listener(frame)
  }
  node.onprocessorerror = () => {
    if (chain.state !== 'active') return
    chain.state = 'faulted'
    chain.fault = new Error(`${kind} processor failed during runtime processing.`)
    publishGateMeterReset(chain)
  }
  applyStaticWorkletNodeParams(chain, params)
  return chain
}

export function applyStaticWorkletNodeParams(
  chain: StaticWorkletNodeChain,
  params: StaticWorkletParams,
) {
  const normalizedState = normalizeOwnedProcessorAudioState(chain.kind, params)
  chain.revision += 1
  chain.node.port.postMessage({
    type: 'configure',
    version: 1,
    revision: chain.revision,
    processorKind: isModulationKind(chain.kind) ? chain.kind : undefined,
    state: normalizedState,
  })
  for (const { parameterId, value } of ownedProcessorAudioParamValues(chain.kind, params)) {
    const param = chain.node.parameters.get(parameterId)
    if (param && typeof value === 'number') param.value = value
  }
}

export function disconnectStaticWorkletNodeChain(chain: StaticWorkletNodeChain) {
  if (chain.state === 'closed') return
  chain.state = 'closed'
  publishGateMeterReset(chain)
  chain.gateMeterListeners.clear()
  chain.node.port.onmessage = null
  chain.node.onprocessorerror = null
  try { chain.node.port.postMessage({ type: 'dispose', version: 1 }) } catch {}
  try { chain.node.port.close() } catch {}
  disconnectAudioNodes([chain.node])
}

function readGateMeterFrame(data: unknown): GateMeterFrame | null {
  if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'meter') return null
  if (!('gainReductionDb' in data) || typeof data.gainReductionDb !== 'number' || !Number.isFinite(data.gainReductionDb)) return null
  return { gainReductionDb: data.gainReductionDb }
}

function readStaticWorkletFault(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'fault') return null
  if (!('version' in data) || data.version !== 1 || !('code' in data) || typeof data.code !== 'string' || data.code.length === 0) {
    return 'malformed-fault'
  }
  return data.code
}

const publishGateMeterReset = (chain: StaticWorkletNodeChain) => {
  if (chain.kind !== 'gate' && chain.kind !== 'limiter') return
  for (const listener of chain.gateMeterListeners) listener({ gainReductionDb: 0 })
}

export function subscribeStaticGateMeter(chain: StaticWorkletNodeChain, listener: GateMeterListener) {
  if ((chain.kind !== 'gate' && chain.kind !== 'limiter') || chain.state !== 'active') {
    listener({ gainReductionDb: 0 })
    return () => {}
  }
  const hadListeners = chain.gateMeterListeners.size > 0
  chain.gateMeterListeners.add(listener)
  if (!hadListeners) chain.node.port.postMessage({ type: 'metering', version: 1, enabled: true })
  return () => {
    chain.gateMeterListeners.delete(listener)
    if (chain.gateMeterListeners.size === 0 && chain.state === 'active') {
      chain.node.port.postMessage({ type: 'metering', version: 1, enabled: false })
      listener({ gainReductionDb: 0 })
    }
  }
}

export const resolveStaticWorkletAutomationBinding = (
  chain: StaticWorkletNodeChain | undefined,
  parameterId: string,
) => {
  if (!chain || !OWNED_PROCESSOR_PARAMETER_IDS[chain.kind].some((id) => id === parameterId)) return []
  const param = chain.node.parameters.get(parameterId)
  return param ? [{ param, valueToAudioValue: (value: number) => value }] : []
}
