import { normalizeCompressorParams, normalizeEqParams, serializeNormalizedEqParams, type EqParams } from '@daw-browser/shared'
import { connectFxChain, createCompressorNodeChain, createGainTransitionOwner, disconnectAudioNodes, type FxChainStageConfig, type GainTransitionOwner } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createCompressorChainState, type CompressorChainState } from './effects/compressor-chain-state'
import { createDelayChainState, type DelayChainState } from './effects/delay-chain-state'
import { createReverbChainState, type ReverbChainState } from './effects/reverb-chain-state'
import { createSaturatorChainState, type SaturatorChainState } from './effects/saturator-chain-state'
import type { CompressorMeterListener } from './effects/compressor-worklet'
import type { SpectrumFrame } from './metering-runtime'
import type { AutomationAudioBinding } from './automation'
import { resolveDelayAutomationBindings, resolveEqAutomationBindings, resolveReverbAutomationBindings, resolveSaturatorAutomationBindings } from './automation-bindings'
import { normalizeAudioEffectRuntimeInstances, type AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { ResolveMixerGraphOptions } from './mixer/types'
import { applyStaticWorkletNodeParams, createStaticWorkletNodeChain, disconnectStaticWorkletNodeChain, resolveStaticWorkletAutomationBinding, subscribeStaticGateMeter, type GateMeterListener, type StaticWorkletKind, type StaticWorkletNodeChain } from './effects/static-worklet-chain'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
import { countStaticWorklets, isStaticWorkletKind, type LiveWorkletTransaction } from './effects/live-worklet-budget'
const isStaticWorkletInstance = (
  instance: AudioEffectRuntimeInstance,
): instance is Extract<AudioEffectRuntimeInstance, { kind: StaticWorkletKind }> => isStaticWorkletKind(instance.kind)

type MasterFxRuntimeOptions = {
  getFaultGeneration: () => number
  workletBudget: {
    begin: (owner: string, count: number) => LiveWorkletTransaction
    commit: (transaction: LiveWorkletTransaction, count: number) => boolean
    isCurrent: (transaction: LiveWorkletTransaction) => boolean
    rollback: (transaction: LiveWorkletTransaction) => void
    releaseOwner: (owner: string) => void
  }
  onWorkletFault?: (generation: number, kind: 'compressor' | 'owned-processor', code: string, context: string) => void
  resourceObserver?: ResourceObserver
}

type InstanceResources = {
  eq: Map<string, BiquadFilterNode[]>
  eqByBand: Map<string, Map<string, BiquadFilterNode>>
  eqSignatures: Map<string, string>
  eqTopologySignatures: Map<string, string>
  compressors: Map<string, CompressorChainState>
  reverbs: Map<string, ReverbChainState>
  saturators: Map<string, SaturatorChainState>
  delays: Map<string, DelayChainState>
  staticWorklets: Map<string, StaticWorkletNodeChain>
}

type MasterCandidate = {
  instances: AudioEffectRuntimeInstance[]
  transaction: LiveWorkletTransaction
  resources: InstanceResources
  ownedIds: Set<string>
  requiresRoutingRebuild: boolean
  desiredStaticCount: number
  eqParamUpdates: Array<{ nodes: BiquadFilterNode[]; params: EqParams }>
}

export function createMasterFxRuntime(options: MasterFxRuntimeOptions) {
  let analyser: AnalyserNode | null = null
  let spectrumTmp: Uint8Array<ArrayBuffer> | null = null
  let spectrumLast: SpectrumFrame | null = null
  let analyserConnected = false
  let releaseAnalyser: () => void = () => undefined
  let masterFxInstances: AudioEffectRuntimeInstance[] = []
  let masterChainInstances: AudioEffectRuntimeInstance[] = []
  let pendingFxInstances: AudioEffectRuntimeInstance[] | null = null
  let fxInstanceRevision = 0
  let routingGain: GainNode | null = null
  let releaseRoutingGain: () => void = () => undefined
  let routingTransitionOwner: GainTransitionOwner | null = null
  const instanceEqChains = new Map<string, BiquadFilterNode[]>()
  const instanceEqNodesByBand = new Map<string, Map<string, BiquadFilterNode>>()
  const instanceEqSignatures = new Map<string, string>()
  const instanceEqTopologySignatures = new Map<string, string>()
  const instanceCompressorChains = new Map<string, ReturnType<typeof createCompressorChainState>>()
  const instanceReverbChains = new Map<string, ReturnType<typeof createReverbChainState>>()
  const instanceSaturatorChains = new Map<string, ReturnType<typeof createSaturatorChainState>>()
  const instanceDelayChains = new Map<string, ReturnType<typeof createDelayChainState>>()
  const instanceStaticWorkletChains = new Map<string, StaticWorkletNodeChain>()
  const compressorMeterListeners = new Map<string, Set<CompressorMeterListener>>()
  const compressorMeterSubscriptions = new Map<string, () => void>()
  const gateMeterListeners = new Map<string, Set<GateMeterListener>>()
  const gateMeterSubscriptions = new Map<string, () => void>()
  let currentBpm = 120
  let retiredResources: Array<{ resources: InstanceResources; ids: Set<string> }> = []

  const currentResources = (): InstanceResources => ({
    eq: instanceEqChains,
    eqByBand: instanceEqNodesByBand,
    eqSignatures: instanceEqSignatures,
    eqTopologySignatures: instanceEqTopologySignatures,
    compressors: instanceCompressorChains,
    reverbs: instanceReverbChains,
    saturators: instanceSaturatorChains,
    delays: instanceDelayChains,
    staticWorklets: instanceStaticWorkletChains,
  })

  const snapshotResources = (): InstanceResources => {
    const resources = currentResources()
    return {
      eq: new Map(resources.eq),
      eqByBand: new Map(resources.eqByBand),
      eqSignatures: new Map(resources.eqSignatures),
      eqTopologySignatures: new Map(resources.eqTopologySignatures),
      compressors: new Map(resources.compressors),
      reverbs: new Map(resources.reverbs),
      saturators: new Map(resources.saturators),
      delays: new Map(resources.delays),
      staticWorklets: new Map(resources.staticWorklets),
    }
  }

  const closeResources = (resources: InstanceResources, ids?: Iterable<string>) => {
    const resourceIds = ids ? new Set(ids) : new Set([
      ...resources.eq.keys(),
      ...resources.compressors.keys(),
      ...resources.reverbs.keys(),
      ...resources.saturators.keys(),
      ...resources.delays.keys(),
      ...resources.staticWorklets.keys(),
    ])
    for (const id of resourceIds) {
      const eq = resources.eq.get(id)
      if (eq) disconnectAudioNodes(eq)
      resources.compressors.get(id)?.close()
      resources.reverbs.get(id)?.close()
      resources.saturators.get(id)?.close()
      resources.delays.get(id)?.close()
      const staticWorklet = resources.staticWorklets.get(id)
      if (staticWorklet) disconnectStaticWorkletNodeChain(staticWorklet)
    }
  }

  const drainRetiredResources = () => {
    for (const { resources, ids } of retiredResources) closeResources(resources, ids)
    retiredResources = []
  }

  const replaceMap = <Value,>(target: Map<string, Value>, source: Map<string, Value>) => {
    target.clear()
    for (const [id, value] of source) target.set(id, value)
  }

  const publishResources = (resources: InstanceResources) => {
    replaceMap(instanceEqChains, resources.eq)
    replaceMap(instanceEqNodesByBand, resources.eqByBand)
    replaceMap(instanceEqSignatures, resources.eqSignatures)
    replaceMap(instanceEqTopologySignatures, resources.eqTopologySignatures)
    replaceMap(instanceCompressorChains, resources.compressors)
    replaceMap(instanceReverbChains, resources.reverbs)
    replaceMap(instanceSaturatorChains, resources.saturators)
    replaceMap(instanceDelayChains, resources.delays)
    replaceMap(instanceStaticWorkletChains, resources.staticWorklets)
  }

  const removeCandidateResources = (resources: InstanceResources, id: string) => {
    resources.eq.delete(id)
    resources.eqByBand.delete(id)
    resources.eqSignatures.delete(id)
    resources.eqTopologySignatures.delete(id)
    resources.compressors.delete(id)
    resources.reverbs.delete(id)
    resources.saturators.delete(id)
    resources.delays.delete(id)
    resources.staticWorklets.delete(id)
  }

  const closeInstanceState = (instanceId: string) => {
    compressorMeterSubscriptions.get(instanceId)?.()
    compressorMeterSubscriptions.delete(instanceId)
    gateMeterSubscriptions.get(instanceId)?.()
    gateMeterSubscriptions.delete(instanceId)
    const eq = instanceEqChains.get(instanceId)
    if (eq) disconnectAudioNodes(eq)
    instanceEqChains.delete(instanceId)
    instanceEqNodesByBand.delete(instanceId)
    instanceEqSignatures.delete(instanceId)
    instanceEqTopologySignatures.delete(instanceId)
    instanceCompressorChains.get(instanceId)?.close()
    instanceCompressorChains.delete(instanceId)
    instanceReverbChains.get(instanceId)?.close()
    instanceReverbChains.delete(instanceId)
    instanceSaturatorChains.get(instanceId)?.close()
    instanceSaturatorChains.delete(instanceId)
    instanceDelayChains.get(instanceId)?.close()
    instanceDelayChains.delete(instanceId)
    const staticWorklet = instanceStaticWorkletChains.get(instanceId)
    if (staticWorklet) disconnectStaticWorkletNodeChain(staticWorklet)
    instanceStaticWorkletChains.delete(instanceId)
  }

  const bindGateMeter = (instanceId: string, chain: StaticWorkletNodeChain) => {
    gateMeterSubscriptions.get(instanceId)?.()
    gateMeterSubscriptions.delete(instanceId)
    const listeners = gateMeterListeners.get(instanceId)
    if (chain.kind !== 'gate' && chain.kind !== 'limiter' || !listeners || listeners.size === 0) return
    gateMeterSubscriptions.set(instanceId, subscribeStaticGateMeter(chain, (frame) => {
      for (const listener of listeners) listener(frame)
    }))
  }

  const bindCompressorMeter = (instanceId: string, state: ReturnType<typeof createCompressorChainState>) => {
    compressorMeterSubscriptions.get(instanceId)?.()
    compressorMeterSubscriptions.delete(instanceId)
    const listeners = compressorMeterListeners.get(instanceId)
    if (!listeners || listeners.size === 0) return
    compressorMeterSubscriptions.set(instanceId, state.subscribeMeter((frame) => {
      for (const listener of listeners) listener(frame)
    }))
  }

  const closeAllInstanceStates = () => {
    const ids = new Set<string>()
    for (const id of instanceEqChains.keys()) ids.add(id)
    for (const id of instanceCompressorChains.keys()) ids.add(id)
    for (const id of instanceReverbChains.keys()) ids.add(id)
    for (const id of instanceSaturatorChains.keys()) ids.add(id)
    for (const id of instanceDelayChains.keys()) ids.add(id)
    for (const id of instanceStaticWorkletChains.keys()) ids.add(id)
    for (const id of ids) closeInstanceState(id)
  }

  const createInstanceStageConfigs = (
    instances: AudioEffectRuntimeInstance[],
    resources: InstanceResources = currentResources(),
  ): FxChainStageConfig[] => instances.map((instance) => ({
    id: instance.id,
    kind: instance.kind,
    eqNodes: instance.kind === 'eq' ? resources.eq.get(instance.id) : undefined,
    compressorChain: instance.kind === 'compressor' ? resources.compressors.get(instance.id)?.chain() : undefined,
    saturatorChain: instance.kind === 'saturator' ? resources.saturators.get(instance.id)?.chain() : undefined,
    delayChain: instance.kind === 'delay' ? resources.delays.get(instance.id)?.chain() : undefined,
    reverbChain: instance.kind === 'reverb' ? resources.reverbs.get(instance.id)?.chain() : undefined,
    staticWorkletChain: isStaticWorkletKind(instance.kind) ? resources.staticWorklets.get(instance.id) : undefined,
  }))

  const rebuildRouting = (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    afterReconnect?: () => void,
  ) => {
    let nextRoutingGain = routingGain
    if (!nextRoutingGain) {
      nextRoutingGain = ctx.createGain()
      nextRoutingGain.gain.value = 1
      routingGain = nextRoutingGain
      releaseRoutingGain = observeResource(options.resourceObserver, 'audio-nodes', nextRoutingGain)
      masterGain.connect(nextRoutingGain)
      routingTransitionOwner = createGainTransitionOwner(nextRoutingGain, () => ctx.currentTime)
    }
    if (analyserConnected && analyser) {
      try { masterGain.disconnect(analyser) } catch {}
    }
    analyserConnected = false
    const reconnect = () => {
      disconnectAudioNodes([nextRoutingGain])
      connectFxChain(nextRoutingGain, destination, {
        instances: createInstanceStageConfigs(masterChainInstances),
      })
      if (analyser) {
        masterGain.connect(analyser)
        analyserConnected = true
      }
      afterReconnect?.()
    }
    routingTransitionOwner?.request(reconnect)
  }

  const ensureAnalyser = (ctx: AudioContext | null, masterGain: GainNode | null) => {
    if (!ctx || !masterGain) return
    if (!analyser) {
      const next = ctx.createAnalyser()
      next.fftSize = 2048
      next.smoothingTimeConstant = 0.8
      analyser = next
      releaseAnalyser = observeResource(options.resourceObserver, 'audio-nodes', next)
    }
    if (analyser && !analyserConnected) {
      masterGain.connect(analyser)
      analyserConnected = true
    }
  }

  const bypassStaticWorklet = (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    instanceId: string,
    chain: StaticWorkletNodeChain,
    revision: number,
  ) => {
    if (fxInstanceRevision !== revision || instanceStaticWorkletChains.get(instanceId) !== chain) return
    closeInstanceState(instanceId)
    masterChainInstances = masterChainInstances.filter((instance) => instance.id !== instanceId)
    masterFxInstances = masterChainInstances
    const transaction = options.workletBudget.begin('master', 0)
    options.workletBudget.commit(transaction, countStaticWorklets(masterChainInstances))
    rebuildRouting(ctx, masterGain, destination)
  }

  const applyFxInstances = async (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    instances: AudioEffectRuntimeInstance[],
  ) => {
    const revision = ++fxInstanceRevision
    const inputIds = new Set<string>()
    for (const instance of instances) {
      if (inputIds.has(instance.id)) throw new Error(`Duplicate effect instance ID: ${instance.id}`)
      inputIds.add(instance.id)
    }
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    const previous = masterChainInstances
    const previousById = new Map(previous.map((instance) => [instance.id, instance]))
    const unchanged = (instance: AudioEffectRuntimeInstance) => {
      const prior = previousById.get(instance.id)
      if (!prior || prior.kind !== instance.kind || JSON.stringify(prior.params) !== JSON.stringify(instance.params)) return false
      if (isStaticWorkletKind(instance.kind)) return instanceStaticWorkletChains.get(instance.id)?.state === 'active'
      if (instance.kind === 'compressor') return !instance.params.enabled || instanceCompressorChains.get(instance.id)?.chain()?.state === 'active'
      return true
    }
    const candidateWorkletCount = normalized.filter((instance) => isStaticWorkletKind(instance.kind) && !unchanged(instance)).length
    const transaction = options.workletBudget.begin('master', candidateWorkletCount)
    const oldResources = snapshotResources()
    const candidate: MasterCandidate = {
      instances: normalized,
      transaction,
      resources: {
        eq: new Map(oldResources.eq),
        eqByBand: new Map(oldResources.eqByBand),
        eqSignatures: new Map(oldResources.eqSignatures),
        eqTopologySignatures: new Map(oldResources.eqTopologySignatures),
        compressors: new Map(oldResources.compressors),
        reverbs: new Map(oldResources.reverbs),
        saturators: new Map(oldResources.saturators),
        delays: new Map(oldResources.delays),
        staticWorklets: new Map(oldResources.staticWorklets),
      },
      ownedIds: new Set(),
      requiresRoutingRebuild: previous.length !== normalized.length ||
        previous.some((instance, index) => instance.id !== normalized[index]?.id || instance.kind !== normalized[index]?.kind),
      desiredStaticCount: countStaticWorklets(normalized),
      eqParamUpdates: [],
    }
    const discard = () => {
      closeResources(candidate.resources, candidate.ownedIds)
      options.workletBudget.rollback(transaction)
    }
    const stale = () => fxInstanceRevision !== revision || !options.workletBudget.isCurrent(transaction)
    try {
      for (const instance of normalized) {
      if (unchanged(instance)) continue
      if (instance.kind === 'eq') {
        const normalizedParams = normalizeEqParams(instance.params)
        const prior = previousById.get(instance.id)
        const priorParams = prior?.kind === 'eq' ? normalizeEqParams(prior.params) : undefined
        const priorNodes = candidate.resources.eq.get(instance.id)
        if (priorParams && priorNodes && getEqTopologySignature(priorParams) === getEqTopologySignature(normalizedParams)) {
          candidate.resources.eqSignatures.set(instance.id, serializeNormalizedEqParams(normalizedParams))
          candidate.eqParamUpdates.push({ nodes: priorNodes, params: normalizedParams })
          continue
        }
      }
      const prior = previousById.get(instance.id)
      if (isStaticWorkletInstance(instance)) {
        const retained = candidate.resources.staticWorklets.get(instance.id)
        if (prior?.kind === instance.kind && retained?.state === 'active') {
          applyStaticWorkletNodeParams(retained, instance.params)
          continue
        }
      }
      if (instance.kind === 'compressor' && prior?.kind === 'compressor') {
        const state = candidate.resources.compressors.get(instance.id)
        if (state) {
          const result = await state.set(ctx, normalizeCompressorParams(instance.params))
          candidate.requiresRoutingRebuild = result.requiresRoutingRebuild || candidate.requiresRoutingRebuild
          continue
        }
      }
      if (instance.kind === 'saturator' && prior?.kind === 'saturator') {
        const state = candidate.resources.saturators.get(instance.id)
        if (state) {
          const result = state.set(ctx, instance.params)
          candidate.requiresRoutingRebuild = result.requiresRoutingRebuild || candidate.requiresRoutingRebuild
          continue
        }
      }
      if (instance.kind === 'delay' && prior?.kind === 'delay') {
        const state = candidate.resources.delays.get(instance.id)
        if (state) {
          const result = state.set(ctx, instance.params, currentBpm)
          candidate.requiresRoutingRebuild = result.requiresRoutingRebuild || candidate.requiresRoutingRebuild
          continue
        }
      }
      if (instance.kind === 'reverb' && prior?.kind === 'reverb') {
        const state = candidate.resources.reverbs.get(instance.id)
        if (state) {
          const result = await state.set(ctx, instance.params)
          candidate.requiresRoutingRebuild = result.requiresRoutingRebuild || candidate.requiresRoutingRebuild
          continue
        }
      }
      candidate.ownedIds.add(instance.id)
      removeCandidateResources(candidate.resources, instance.id)
      if (isStaticWorkletInstance(instance)) {
        const faultGeneration = options.getFaultGeneration()
        const createdHolder: { chain: StaticWorkletNodeChain | undefined } = { chain: undefined }
        const created = await createStaticWorkletNodeChain(ctx, instance.kind, instance.params, (code) => {
          const chain = createdHolder.chain
          if (!chain) return
          bypassStaticWorklet(ctx, masterGain, destination, instance.id, chain, revision)
          options.onWorkletFault?.(faultGeneration, 'owned-processor', code, `master:effect:${instance.id}`)
        })
        createdHolder.chain = created
        if (stale()) {
          disconnectStaticWorkletNodeChain(created)
          discard()
          return
        }
        candidate.resources.staticWorklets.set(instance.id, created)
        candidate.requiresRoutingRebuild = true
        continue
      }
      if (instance.kind === 'eq') {
        const normalizedParams = normalizeEqParams(instance.params)
        const nodes = createEqNodes(ctx, normalizedParams, ctx.destination.maxChannelCount || 2)
        candidate.resources.eq.set(instance.id, nodes)
        candidate.resources.eqByBand.set(instance.id, new Map(normalizedParams.bands.filter((band) => band.enabled).flatMap((band, index) => {
          const node = nodes[index]
          return node ? [[band.id, node]] : []
        })))
        candidate.resources.eqSignatures.set(instance.id, serializeNormalizedEqParams(normalizedParams))
        candidate.resources.eqTopologySignatures.set(instance.id, getEqTopologySignature(normalizedParams))
        candidate.requiresRoutingRebuild = true
        continue
      }
      if (instance.kind === 'compressor') {
        const faultGeneration = options.getFaultGeneration()
        const state = createCompressorChainState((audioContext, params) =>
          createCompressorNodeChain(audioContext, params, (code) =>
            options.onWorkletFault?.(faultGeneration, 'compressor', code, `master:effect:${instance.id}`)))
        const result = await state.set(ctx, normalizeCompressorParams(instance.params))
        if (stale()) {
          state.close()
          discard()
          return
        }
        if (instance.params.enabled && !state.chain()) throw new Error('Failed to construct compressor chain.')
        candidate.resources.compressors.set(instance.id, state)
        candidate.requiresRoutingRebuild = result.changed || candidate.requiresRoutingRebuild
        continue
      }
      if (instance.kind === 'saturator') {
        const state = createSaturatorChainState()
        state.set(ctx, instance.params)
        candidate.resources.saturators.set(instance.id, state)
        candidate.requiresRoutingRebuild = true
        continue
      }
      if (instance.kind === 'delay') {
        const state = createDelayChainState()
        state.set(ctx, instance.params, currentBpm)
        candidate.resources.delays.set(instance.id, state)
        candidate.requiresRoutingRebuild = true
        continue
      }
      if (instance.kind !== 'reverb') throw new Error('Unsupported audio effect kind.')
      const state = createReverbChainState()
      await state.set(ctx, instance.params)
      candidate.resources.reverbs.set(instance.id, state)
      candidate.requiresRoutingRebuild = true
      }
    } catch (error) {
      discard()
      throw error
    }
    if (stale()) {
      discard()
      return
    }
    if (!options.workletBudget.commit(transaction, candidate.desiredStaticCount)) {
      discard()
      return
    }
    masterChainInstances = candidate.instances
    masterFxInstances = candidate.instances
    pendingFxInstances = null
    publishResources(candidate.resources)
    for (const update of candidate.eqParamUpdates) applyEqNodeParams(update.nodes, update.params)
    for (const instance of candidate.instances) {
      const staticWorklet = candidate.resources.staticWorklets.get(instance.id)
      if (staticWorklet) bindGateMeter(instance.id, staticWorklet)
      const compressor = candidate.resources.compressors.get(instance.id)
      if (compressor) bindCompressorMeter(instance.id, compressor)
    }
    const displaced = new Set<string>()
    for (const id of candidate.ownedIds) {
      if (oldResources.eq.has(id) || oldResources.compressors.has(id) || oldResources.reverbs.has(id) ||
        oldResources.saturators.has(id) || oldResources.delays.has(id) || oldResources.staticWorklets.has(id)) displaced.add(id)
    }
    for (const id of [
      ...oldResources.eq.keys(), ...oldResources.compressors.keys(), ...oldResources.reverbs.keys(),
      ...oldResources.saturators.keys(), ...oldResources.delays.keys(), ...oldResources.staticWorklets.keys(),
    ]) {
      if (!candidate.instances.some((instance) => instance.id === id)) displaced.add(id)
    }
    if (displaced.size > 0) retiredResources.push({ resources: oldResources, ids: displaced })
    if (candidate.requiresRoutingRebuild) rebuildRouting(ctx, masterGain, destination, drainRetiredResources)
    else drainRetiredResources()
  }

  return {
    applyPending: (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode) => {
      if (pendingFxInstances) {
        const instances = pendingFxInstances
        pendingFxInstances = null
        void applyFxInstances(ctx, masterGain, destination, instances).catch((error) => {
          options.onWorkletFault?.(
            options.getFaultGeneration(),
            'owned-processor',
            'effect-chain-construction-failed',
            `master:${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }
      rebuildRouting(ctx, masterGain, destination)
    },
    subscribeCompressorMeter: (instanceId: string, listener: CompressorMeterListener) => {
      let listeners = compressorMeterListeners.get(instanceId)
      if (!listeners) {
        listeners = new Set()
        compressorMeterListeners.set(instanceId, listeners)
      }
      listeners.add(listener)
      const state = instanceCompressorChains.get(instanceId)
      if (state && !compressorMeterSubscriptions.has(instanceId)) bindCompressorMeter(instanceId, state)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        compressorMeterSubscriptions.get(instanceId)?.()
        compressorMeterSubscriptions.delete(instanceId)
        compressorMeterListeners.delete(instanceId)
      }
    },
    subscribeGateMeter: (instanceId: string, listener: GateMeterListener) => {
      let listeners = gateMeterListeners.get(instanceId)
      if (!listeners) {
        listeners = new Set()
        gateMeterListeners.set(instanceId, listeners)
      }
      listeners.add(listener)
      const chain = instanceStaticWorkletChains.get(instanceId)
      if (chain && !gateMeterSubscriptions.has(instanceId)) bindGateMeter(instanceId, chain)
      return () => {
        listener({ gainReductionDb: 0 })
        listeners.delete(listener)
        if (listeners.size > 0) return
        gateMeterSubscriptions.get(instanceId)?.()
        gateMeterSubscriptions.delete(instanceId)
        gateMeterListeners.delete(instanceId)
      }
    },
    setFxInstances: async (
      ctx: AudioContext | null,
      masterGain: GainNode | null,
      destination: AudioDestinationNode | null,
      instances: AudioEffectRuntimeInstance[],
    ) => {
      const normalized = normalizeAudioEffectRuntimeInstances(instances)
      if (!ctx || !masterGain) {
        pendingFxInstances = normalized
        fxInstanceRevision += 1
        return
      }
      try {
        await applyFxInstances(ctx, masterGain, destination ?? ctx.destination, normalized)
      } catch (error) {
        options.onWorkletFault?.(
          options.getFaultGeneration(),
          'owned-processor',
          'effect-chain-construction-failed',
          `master:${error instanceof Error ? error.message : String(error)}`,
        )
        throw error
      }
    },
    setBpm: (bpm: number) => {
      currentBpm = bpm
      for (const state of instanceDelayChains.values()) state.setBpm(bpm)
    },
    getMixerFx: (): Pick<
      ResolveMixerGraphOptions,
      'masterFxInstances'
    > => ({
      masterFxInstances,
    }),
    resolveMasterAutomationBindings: (parameterId: string, masterGain: GainNode | null, effectInstanceId?: string): AutomationAudioBinding[] => {
      if (parameterId === 'volume') return masterGain ? [{ param: masterGain.gain, valueToAudioValue: (value) => value }] : []
      if (effectInstanceId) {
        return [
          ...resolveEqAutomationBindings(instanceEqNodesByBand.get(effectInstanceId) ?? new Map(), parameterId),
          ...resolveSaturatorAutomationBindings(instanceSaturatorChains.get(effectInstanceId), parameterId),
          ...resolveDelayAutomationBindings(instanceDelayChains.get(effectInstanceId), parameterId),
          ...resolveReverbAutomationBindings(instanceReverbChains.get(effectInstanceId), parameterId),
          ...resolveStaticWorkletAutomationBinding(instanceStaticWorkletChains.get(effectInstanceId), parameterId),
        ]
      }
      const eqNodes = new Map<string, BiquadFilterNode>()
      for (const nodesByBand of instanceEqNodesByBand.size === 1 ? instanceEqNodesByBand.values() : []) {
        for (const [bandId, node] of nodesByBand) eqNodes.set(bandId, node)
      }
      return [
        ...resolveEqAutomationBindings(eqNodes, parameterId),
        ...Array.from(instanceSaturatorChains.size === 1 ? instanceSaturatorChains.values() : []).flatMap((state) => resolveSaturatorAutomationBindings(state, parameterId)),
        ...Array.from(instanceDelayChains.size === 1 ? instanceDelayChains.values() : []).flatMap((state) => resolveDelayAutomationBindings(state, parameterId)),
        ...Array.from(instanceReverbChains.size === 1 ? instanceReverbChains.values() : []).flatMap((state) => resolveReverbAutomationBindings(state, parameterId)),
      ]
    },
    rebuildRouting,
    getSpectrum: (ctx: AudioContext | null, masterGain: GainNode | null) => {
      ensureAnalyser(ctx, masterGain)
      if (!analyser) return spectrumLast
      if (!spectrumTmp || spectrumTmp.length !== analyser.frequencyBinCount) {
        spectrumTmp = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      }
      try { analyser.getByteFrequencyData(spectrumTmp) } catch { return spectrumLast }
      let sum = 0
      for (let i = 0; i < spectrumTmp.length; i++) sum += spectrumTmp[i]
      if (sum === 0) {
        spectrumLast = null
        return null
      }
      let out = spectrumLast?.data
      if (!out || out.length !== spectrumTmp.length) out = new Float32Array(spectrumTmp.length)
      for (let i = 0; i < out.length; i++) out[i] = spectrumTmp[i] / 255
      spectrumLast = {
        data: out,
        sampleRate: ctx?.sampleRate ?? 44100,
        fftSize: analyser.fftSize,
        binCount: analyser.frequencyBinCount,
      }
      return spectrumLast
    },
    close: () => {
      releaseAnalyser()
      releaseAnalyser = () => undefined
      releaseRoutingGain()
      releaseRoutingGain = () => undefined
      routingTransitionOwner?.dispose()
      routingTransitionOwner = null
      disconnectAudioNodes([routingGain])
      routingGain = null
      masterFxInstances = []
      masterChainInstances = []
      pendingFxInstances = null
      fxInstanceRevision += 1
      closeAllInstanceStates()
      drainRetiredResources()
      options.workletBudget.releaseOwner('master')
      compressorMeterSubscriptions.clear()
      compressorMeterListeners.clear()
      disconnectAudioNodes([analyser])
      analyser = null
      spectrumTmp = null
      spectrumLast = null
      analyserConnected = false
    },
  }
}
