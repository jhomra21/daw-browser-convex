import { isGainReductionMeterKind, isOwnedProcessorKind } from '@daw-browser/shared'
import type { FxChainStageConfig } from './effects/chain'
import type { CompressorChainState } from './effects/compressor-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import { disconnectStaticWorkletNodeChain, resolveStaticWorkletAutomationBinding, subscribeStaticGateMeter, type GateMeterListener, type StaticWorkletNodeChain } from './effects/static-worklet-chain'
import type { AutomationAudioBinding } from './automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from './automation-bindings'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { closeResources, type InstanceResources } from './effect-chain-transaction'

const replaceMap = <Value,>(target: Map<string, Value>, source: Map<string, Value>) => {
  target.clear()

  for (const [id, value] of source) target.set(id, value)
}

const subscribeMeter = <Listener,>(
  listenersById: Map<string, Set<Listener>>,
  subscriptions: Map<string, () => void>,
  instanceId: string,
  listener: Listener,
  bind: () => void,
  onRelease?: (listener: Listener) => void,
) => {
  let listeners = listenersById.get(instanceId)

  if (!listeners) {
    listeners = new Set()
    listenersById.set(instanceId, listeners)
  }

  listeners.add(listener)

  if (!subscriptions.has(instanceId)) bind()

  return () => {
    onRelease?.(listener)
    listeners.delete(listener)

    if (listeners.size > 0) return
    subscriptions.get(instanceId)?.()
    subscriptions.delete(instanceId)
    listenersById.delete(instanceId)
  }
}

// Everything one effect chain (a track's, or the master's) holds per instance: the nodes and chain states, the meter
// listeners bound to them, the parameters the nodes are known to hold, and the resources a routing swap has yet to close.
export const createChainInstanceState = () => {
  const resources: InstanceResources = {
    eqs: new Map(),
    compressors: new Map(),
    reverbs: new Map(),
    saturators: new Map(),
    delays: new Map(),
    staticWorklets: new Map(),
  }

  // Recorded when a request commits. A request superseded after it changed a node leaves the node on its value, so the
  // installed chain alone cannot say whether a request is already in place.
  const liveParams = new Map<string, AudioEffectRuntimeInstance['params']>()
  const compressorMeterListeners = new Map<string, Set<CompressorMeterListener>>()
  const compressorMeterSubscriptions = new Map<string, () => void>()
  const gateMeterListeners = new Map<string, Set<GateMeterListener>>()
  const gateMeterSubscriptions = new Map<string, () => void>()
  let retired: Array<{ resources: InstanceResources; ids: Set<string> }> = []

  const bindGateMeter = (instanceId: string, chain: StaticWorkletNodeChain) => {
    gateMeterSubscriptions.get(instanceId)?.()
    gateMeterSubscriptions.delete(instanceId)
    const listeners = gateMeterListeners.get(instanceId)

    if (!isGainReductionMeterKind(chain.kind) || !listeners || listeners.size === 0) return
    gateMeterSubscriptions.set(instanceId, subscribeStaticGateMeter(chain, (frame) => {
      for (const listener of listeners) listener(frame)
    }))
  }

  const bindCompressorMeter = (instanceId: string, state: CompressorChainState) => {
    compressorMeterSubscriptions.get(instanceId)?.()
    compressorMeterSubscriptions.delete(instanceId)
    const listeners = compressorMeterListeners.get(instanceId)

    if (!listeners || listeners.size === 0) return
    compressorMeterSubscriptions.set(instanceId, state.subscribeMeter((frame) => {
      for (const listener of listeners) listener(frame)
    }))
  }

  const close = (instanceId: string) => {
    compressorMeterSubscriptions.get(instanceId)?.()
    compressorMeterSubscriptions.delete(instanceId)
    gateMeterSubscriptions.get(instanceId)?.()
    gateMeterSubscriptions.delete(instanceId)
    resources.eqs.get(instanceId)?.close()
    resources.eqs.delete(instanceId)
    resources.compressors.get(instanceId)?.close()
    resources.compressors.delete(instanceId)
    resources.reverbs.get(instanceId)?.close()
    resources.reverbs.delete(instanceId)
    resources.saturators.get(instanceId)?.close()
    resources.saturators.delete(instanceId)
    resources.delays.get(instanceId)?.close()
    resources.delays.delete(instanceId)
    const staticWorklet = resources.staticWorklets.get(instanceId)

    if (staticWorklet) disconnectStaticWorkletNodeChain(staticWorklet)
    resources.staticWorklets.delete(instanceId)
    liveParams.delete(instanceId)
  }

  return {
    resources,
    liveParams,
    publish: (next: InstanceResources) => {
      replaceMap(resources.eqs, next.eqs)
      replaceMap(resources.compressors, next.compressors)
      replaceMap(resources.reverbs, next.reverbs)
      replaceMap(resources.saturators, next.saturators)
      replaceMap(resources.delays, next.delays)
      replaceMap(resources.staticWorklets, next.staticWorklets)
    },
    retire: (displaced: InstanceResources, ids: Set<string>) => { retired.push({ resources: displaced, ids }) },
    drainRetired: () => {
      for (const { resources: displaced, ids } of retired) closeResources(displaced, ids)
      retired = []
    },
    bindGateMeter,
    bindCompressorMeter,
    close,
    closeAll: () => {
      const ids = new Set<string>()

      for (const map of [
        resources.eqs, resources.compressors, resources.reverbs,
        resources.saturators, resources.delays, resources.staticWorklets,
      ]) {
        for (const id of map.keys()) ids.add(id)
      }

      for (const id of ids) close(id)
    },
    // Compressor and gate meter listeners outlive their instance and rebind when a chain installs one.
    subscribeCompressorMeter: (instanceId: string, listener: CompressorMeterListener) => subscribeMeter(
      compressorMeterListeners,
      compressorMeterSubscriptions,
      instanceId,
      listener,
      () => {
        const state = resources.compressors.get(instanceId)

        if (state) bindCompressorMeter(instanceId, state)
      },
    ),
    subscribeGateMeter: (instanceId: string, listener: GateMeterListener) => subscribeMeter(
      gateMeterListeners,
      gateMeterSubscriptions,
      instanceId,
      listener,
      () => {
        const chain = resources.staticWorklets.get(instanceId)

        if (chain) bindGateMeter(instanceId, chain)
      },
      (released) => released({ gainReductionDb: 0 }),
    ),
    hasMeterListeners: () => compressorMeterListeners.size > 0 || gateMeterListeners.size > 0,
    forgetCompressorMeterListeners: () => {
      compressorMeterSubscriptions.clear()
      compressorMeterListeners.clear()
    },
    forgetMeterListeners: () => {
      gateMeterSubscriptions.clear()
      gateMeterListeners.clear()
      compressorMeterSubscriptions.clear()
      compressorMeterListeners.clear()
    },
    // One named instance, or (without one) the single instance of each kind the chain holds.
    automationBindings: (parameterId: string, effectInstanceId?: string): AutomationAudioBinding[] => {
      if (effectInstanceId) {
        return [
          ...resolveEqAutomationBindings(resources.eqs.get(effectInstanceId)?.nodesByBand() ?? new Map(), parameterId),
          ...resolveSaturatorAutomationBindings(resources.saturators.get(effectInstanceId), parameterId),
          ...resolveDelayAutomationBindings(resources.delays.get(effectInstanceId), parameterId),
          ...resolveReverbAutomationBindings(resources.reverbs.get(effectInstanceId), parameterId),
          ...resolveStaticWorkletAutomationBinding(resources.staticWorklets.get(effectInstanceId), parameterId),
        ]
      }

      const eqNodes = new Map<string, BiquadFilterNode>()

      for (const state of resources.eqs.size === 1 ? resources.eqs.values() : []) {
        for (const [bandId, node] of state.nodesByBand()) eqNodes.set(bandId, node)
      }

      return [
        ...resolveEqAutomationBindings(eqNodes, parameterId),
        ...Array.from(resources.saturators.size === 1 ? resources.saturators.values() : []).flatMap((state) => resolveSaturatorAutomationBindings(state, parameterId)),
        ...Array.from(resources.delays.size === 1 ? resources.delays.values() : []).flatMap((state) => resolveDelayAutomationBindings(state, parameterId)),
        ...Array.from(resources.reverbs.size === 1 ? resources.reverbs.values() : []).flatMap((state) => resolveReverbAutomationBindings(state, parameterId)),
      ]
    },
    stageConfigs: (instances: AudioEffectRuntimeInstance[], from: InstanceResources = resources): FxChainStageConfig[] => instances.map((instance) => ({
      id: instance.id,
      kind: instance.kind,
      eqNodes: instance.kind === 'eq' ? from.eqs.get(instance.id)?.nodes() : undefined,
      compressorChain: instance.kind === 'compressor' ? from.compressors.get(instance.id)?.chain() : undefined,
      saturatorChain: instance.kind === 'saturator' ? from.saturators.get(instance.id)?.chain() : undefined,
      delayChain: instance.kind === 'delay' ? from.delays.get(instance.id)?.chain() : undefined,
      reverbChain: instance.kind === 'reverb' ? from.reverbs.get(instance.id)?.chain() : undefined,
      staticWorkletChain: isOwnedProcessorKind(instance.kind) ? from.staticWorklets.get(instance.id) : undefined,
    })),
  }
}

export type ChainInstanceState = ReturnType<typeof createChainInstanceState>
