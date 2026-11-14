import { normalizeCompressorParams, normalizeEqParams, serializeNormalizedEqParams, type EqParams } from '@daw-browser/shared'
import { connectFxChain, createCompressorNodeChain, createGainTransitionOwner, disconnectAudioNodes, type FxChainStageConfig, type GainTransitionOwner, type GainTransitionScheduler } from './effects/chain'
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
import { getEffectChainTiming } from './effects/timing'
import { createChainAdmission } from './chain-admission'
import type { EngineDisposition } from './engine-disposition'

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
  transitionScheduler?: GainTransitionScheduler
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
  eqParamUpdates: Array<{ instance: AudioEffectRuntimeInstance; nodes: BiquadFilterNode[]; params: EqParams }>
  // Instances whose parameters were written to the nodes that already held them.
  writtenInPlace: AudioEffectRuntimeInstance[]
}

// inPlace: no graph latency to republish, so the caller skips it. A skipped request changed nothing.
type MasterFxOutcome = { disposition: EngineDisposition; inPlace: boolean }

// A request that joins work is 'joined' only when that work installed; any other outcome is the joined request's too.
const joinedOutcome = (underlying: MasterFxOutcome): MasterFxOutcome => (
  { ...underlying, disposition: underlying.disposition === 'applied' ? 'joined' : underlying.disposition }
)

type StaticWorkletChainHolder = {
  chain: StaticWorkletNodeChain | undefined
}

export function createMasterFxRuntime(options: MasterFxRuntimeOptions) {
  let analyser: AnalyserNode | null = null
  let spectrumTmp: Uint8Array<ArrayBuffer> | null = null
  let spectrumLast: SpectrumFrame | null = null
  let analyserConnected = false
  let releaseAnalyser: () => void = () => undefined
  let masterFxInstances: AudioEffectRuntimeInstance[] = []
  let masterChainInstances: AudioEffectRuntimeInstance[] = []
  const admission = createChainAdmission<MasterFxOutcome>(joinedOutcome)
  let fxInstanceRevision = 0
  // What the live nodes are known to hold, recorded when a request commits. A request superseded after it changed a node
  // leaves the node on its value, so the installed chain alone cannot say whether a request is already in place.
  const liveParams = new Map<string, AudioEffectRuntimeInstance['params']>()
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
  let graphPublicationPending = false

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
    liveParams.delete(instanceId)
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
  ) => {
    let wasPending = false
    let nextRoutingGain = routingGain
    if (!nextRoutingGain) {
      nextRoutingGain = ctx.createGain()
      nextRoutingGain.gain.value = 1
      routingGain = nextRoutingGain
      releaseRoutingGain = observeResource(options.resourceObserver, 'audio-nodes', nextRoutingGain)
      masterGain.connect(nextRoutingGain)
      routingTransitionOwner = createGainTransitionOwner(nextRoutingGain, () => ctx.currentTime, options.transitionScheduler)
    }
    if (analyserConnected && analyser) {
      try { masterGain.disconnect(analyser) } catch {}
    }
    analyserConnected = false
    const reconnect = () => {
      wasPending = graphPublicationPending
      graphPublicationPending = true
      disconnectAudioNodes([nextRoutingGain])
      connectFxChain(nextRoutingGain, destination, {
        instances: createInstanceStageConfigs(masterChainInstances),
      })
      if (analyser) {
        masterGain.connect(analyser)
        analyserConnected = true
      }
      drainRetiredResources()
    }
    routingTransitionOwner?.request(
      reconnect,
      () => {
        if (!wasPending) graphPublicationPending = false
      },
    )
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
  ) => {
    if (instanceStaticWorkletChains.get(instanceId) !== chain) return
    fxInstanceRevision += 1
    closeInstanceState(instanceId)
    const requested = admission.intent()
    if (requested) admission.adopt(requested.filter((instance) => instance.id !== instanceId))
    masterChainInstances = masterChainInstances.filter((instance) => instance.id !== instanceId)
    masterFxInstances = masterChainInstances
    const transaction = options.workletBudget.begin('master', 0)
    options.workletBudget.commit(transaction, countStaticWorklets(masterChainInstances))
    try {
      rebuildRouting(ctx, masterGain, destination)
    } catch (error) {
      graphPublicationPending = true
      throw error
    }
  }

  type InPlaceEdit = Pick<MasterCandidate, 'requiresRoutingRebuild' | 'eqParamUpdates' | 'writtenInPlace'>

  // Applies an instance's new parameters to the nodes that already hold it, replacing none. False when nothing holds it
  // that way, so the caller builds it. The one parameter path for a whole-chain update and for a single-instance edit.
  // Its proof leaves liveParams before a node is written and returns only when the request commits (recordCommittedParams):
  // a write that throws, or a request superseded after it, leaves a node holding what no proof names.
  const applyParamsInPlace = async (
    ctx: AudioContext,
    instance: AudioEffectRuntimeInstance,
    prior: AudioEffectRuntimeInstance | undefined,
    resources: MasterCandidate['resources'],
    edit: InPlaceEdit,
    stale: () => boolean,
  ): Promise<boolean> => {
    // The EQ is the exception: its node write waits for the commit.
    const forgetLive = () => liveParams.delete(instance.id)
    if (instance.kind === 'eq') {
      const params = normalizeEqParams(instance.params)
      const priorParams = prior?.kind === 'eq' ? normalizeEqParams(prior.params) : undefined
      const priorNodes = resources.eq.get(instance.id)
      if (!priorParams || !priorNodes || getEqTopologySignature(priorParams) !== getEqTopologySignature(params)) return false
      resources.eqSignatures.set(instance.id, serializeNormalizedEqParams(params))
      edit.eqParamUpdates.push({ instance, nodes: priorNodes, params })
      return true
    }
    if (isStaticWorkletInstance(instance)) {
      const retained = resources.staticWorklets.get(instance.id)
      if (prior?.kind !== instance.kind || retained?.state !== 'active') return false
      forgetLive()
      applyStaticWorkletNodeParams(retained, instance.params)
      edit.writtenInPlace.push(instance)
      return true
    }
    if (instance.kind === 'compressor' && prior?.kind === 'compressor') {
      const state = resources.compressors.get(instance.id)
      if (!state) return false
      forgetLive()
      const params = normalizeCompressorParams(instance.params)
      const result = await state.set(ctx, params)
      // The state keeps a faulted chain when its replacement cannot be built and still reports success. A newer request
      // owns the chain by now and cancelled the construction this one awaited: it reports the outcome, not this check.
      if (!stale() && params.enabled && state.chain()?.state !== 'active') throw new Error('Failed to recover compressor chain.')
      edit.requiresRoutingRebuild = result.requiresRoutingRebuild || edit.requiresRoutingRebuild
      edit.writtenInPlace.push(instance)
      return true
    }
    if (instance.kind === 'saturator' && prior?.kind === 'saturator') {
      const state = resources.saturators.get(instance.id)
      if (!state) return false
      forgetLive()
      edit.requiresRoutingRebuild = state.set(ctx, instance.params).requiresRoutingRebuild || edit.requiresRoutingRebuild
      edit.writtenInPlace.push(instance)
      return true
    }
    if (instance.kind === 'delay' && prior?.kind === 'delay') {
      const state = resources.delays.get(instance.id)
      if (!state) return false
      forgetLive()
      edit.requiresRoutingRebuild = state.set(ctx, instance.params, currentBpm).requiresRoutingRebuild || edit.requiresRoutingRebuild
      edit.writtenInPlace.push(instance)
      return true
    }
    if (instance.kind === 'reverb' && prior?.kind === 'reverb') {
      const state = resources.reverbs.get(instance.id)
      if (!state) return false
      forgetLive()
      const result = await state.set(ctx, instance.params)
      edit.requiresRoutingRebuild = result.requiresRoutingRebuild || edit.requiresRoutingRebuild
      edit.writtenInPlace.push(instance)
      return true
    }
    return false
  }

  // A commit is when new resources, confirmed in-place writes and deferred EQ writes become what the nodes hold. Ids that
  // left the chain hold nothing any more. A candidate that was discarded never reaches this, so it records nothing.
  const recordCommittedParams = (
    instances: readonly AudioEffectRuntimeInstance[],
    createdIds: ReadonlySet<string>,
    edit: InPlaceEdit,
  ) => {
    const ids = new Set(instances.map((instance) => instance.id))
    for (const id of liveParams.keys()) if (!ids.has(id)) liveParams.delete(id)
    for (const instance of instances) if (createdIds.has(instance.id)) liveParams.set(instance.id, instance.params)
    for (const instance of edit.writtenInPlace) liveParams.set(instance.id, instance.params)
    for (const update of edit.eqParamUpdates) {
      // The proof leaves before the nodes are written: a write that throws partway leaves them holding no named value.
      liveParams.delete(update.instance.id)
      applyEqNodeParams(update.nodes, update.params)
      liveParams.set(update.instance.id, update.instance.params)
    }
  }

  const applyFxInstances = async (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    instances: AudioEffectRuntimeInstance[],
  ): Promise<MasterFxOutcome> => {
    const publicationPending = graphPublicationPending
    const revision = ++fxInstanceRevision
    const inputIds = new Set<string>()
    for (const instance of instances) {
      if (inputIds.has(instance.id)) throw new Error(`Duplicate effect instance ID: ${instance.id}`)
      inputIds.add(instance.id)
    }
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    const previous = masterChainInstances
    const previousById = new Map(previous.map((instance) => [instance.id, instance]))
    // Equal means the nodes hold the requested parameters, not that the installed chain lists them: a superseded
    // request can have moved a node and left the installed chain on its old value.
    const unchanged = (instance: AudioEffectRuntimeInstance) => {
      const prior = previousById.get(instance.id)
      const held = liveParams.get(instance.id)
      if (!prior || prior.kind !== instance.kind || held === undefined || JSON.stringify(held) !== JSON.stringify(instance.params)) return false
      if (isStaticWorkletKind(instance.kind)) return instanceStaticWorkletChains.get(instance.id)?.state === 'active'
      if (instance.kind === 'compressor') return !instance.params.enabled || instanceCompressorChains.get(instance.id)?.chain()?.state === 'active'
      return true
    }
    const changed = normalized.filter((instance) => !unchanged(instance))
    const changedInstances = new Set(changed)
    const sameChainOrder = previous.length === normalized.length &&
      previous.every((prior, index) => prior.id === normalized[index]?.id && prior.kind === normalized[index]?.kind)
    // The revision is already bumped, so an older request still in flight cannot commit over what the nodes hold.
    if (!publicationPending && sameChainOrder && changed.length === 0) return { disposition: 'skipped', inPlace: true }
    const candidateWorkletCount = changed.filter((instance) => isStaticWorkletKind(instance.kind)).length
    const transaction = options.workletBudget.begin('master', candidateWorkletCount)
    const stale = () => fxInstanceRevision !== revision || !options.workletBudget.isCurrent(transaction)
    // Exactly one instance changed, with the same id and kind in the same place: its parameters go straight to the
    // nodes that hold it, before any resource snapshot, whole-chain loop, meter rebind or retirement scan.
    const [edited] = changed
    if (!publicationPending && edited && changed.length === 1 && sameChainOrder) {
      const edit: InPlaceEdit = { requiresRoutingRebuild: false, eqParamUpdates: [], writtenInPlace: [] }
      let applied: boolean
      try {
        applied = await applyParamsInPlace(ctx, edited, previousById.get(edited.id), currentResources(), edit, stale)
      } catch (error) {
        options.workletBudget.rollback(transaction)
        throw error
      }
      if (applied) {
        if (stale()) {
          options.workletBudget.rollback(transaction)
          return { disposition: 'superseded', inPlace: false }
        }
        if (!options.workletBudget.commit(transaction, countStaticWorklets(normalized))) {
          options.workletBudget.rollback(transaction)
          return { disposition: 'dropped', inPlace: false }
        }
        graphPublicationPending = true
        masterChainInstances = normalized
        masterFxInstances = normalized
        recordCommittedParams(normalized, new Set(), edit)
        if (edit.requiresRoutingRebuild || publicationPending) {
          rebuildRouting(ctx, masterGain, destination)
        } else if (!routingTransitionOwner?.pending()) {
          drainRetiredResources()
        }
        graphPublicationPending = false
        return {
          disposition: 'applied',
          inPlace: !edit.requiresRoutingRebuild &&
            getEffectChainTiming(previous, ctx.sampleRate, currentBpm).latencyFrames ===
              getEffectChainTiming(normalized, ctx.sampleRate, currentBpm).latencyFrames,
        }
      }
    }
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
      writtenInPlace: [],
    }
    candidate.requiresRoutingRebuild = candidate.requiresRoutingRebuild || publicationPending
    const discard = () => {
      closeResources(candidate.resources, candidate.ownedIds)
      options.workletBudget.rollback(transaction)
    }
    try {
      for (const instance of normalized) {
      if (!changedInstances.has(instance)) continue
      // Every instance after the first is reached through an await: a newer request may own the nodes by now.
      if (stale()) {
        discard()
        return { disposition: 'superseded', inPlace: false }
      }
      if (await applyParamsInPlace(ctx, instance, previousById.get(instance.id), candidate.resources, candidate, stale)) continue
      candidate.ownedIds.add(instance.id)
      removeCandidateResources(candidate.resources, instance.id)
      if (isStaticWorkletInstance(instance)) {
        const faultGeneration = options.getFaultGeneration()
        const createdHolder: StaticWorkletChainHolder = { chain: undefined }
        const created = await createStaticWorkletNodeChain(ctx, instance.kind, instance.params, (code) => {
          const chain = createdHolder.chain
          if (!chain) return
          bypassStaticWorklet(ctx, masterGain, destination, instance.id, chain)
          options.onWorkletFault?.(faultGeneration, 'owned-processor', code, `master:effect:${instance.id}`)
        })
        createdHolder.chain = created
        if (stale()) {
          disconnectStaticWorkletNodeChain(created)
          discard()
          return { disposition: 'superseded', inPlace: false }
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
          return { disposition: 'superseded', inPlace: false }
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
      return { disposition: 'superseded', inPlace: false }
    }
    if (!options.workletBudget.commit(transaction, candidate.desiredStaticCount)) {
      discard()
      return { disposition: 'dropped', inPlace: false }
    }
    graphPublicationPending = true
    masterChainInstances = candidate.instances
    masterFxInstances = candidate.instances
    const installedIds = new Set(candidate.instances.map((instance) => instance.id))
    const displaced = new Set<string>()
    for (const id of candidate.ownedIds) {
      if (oldResources.eq.has(id) || oldResources.compressors.has(id) || oldResources.reverbs.has(id) ||
        oldResources.saturators.has(id) || oldResources.delays.has(id) || oldResources.staticWorklets.has(id)) displaced.add(id)
    }
    for (const id of [
      ...oldResources.eq.keys(), ...oldResources.compressors.keys(), ...oldResources.reverbs.keys(),
      ...oldResources.saturators.keys(), ...oldResources.delays.keys(), ...oldResources.staticWorklets.keys(),
    ]) {
      if (!installedIds.has(id)) displaced.add(id)
    }
    for (const id of displaced) {
      if (!installedIds.has(id)) removeCandidateResources(candidate.resources, id)
    }
    if (displaced.size > 0) retiredResources.push({ resources: oldResources, ids: displaced })
    publishResources(candidate.resources)
    recordCommittedParams(candidate.instances, candidate.ownedIds, candidate)
    for (const instance of candidate.instances) {
      const staticWorklet = candidate.resources.staticWorklets.get(instance.id)
      if (staticWorklet) bindGateMeter(instance.id, staticWorklet)
      const compressor = candidate.resources.compressors.get(instance.id)
      if (compressor) bindCompressorMeter(instance.id, compressor)
    }
    if (candidate.requiresRoutingRebuild) {
      rebuildRouting(ctx, masterGain, destination)
    } else if (!routingTransitionOwner?.pending()) {
      drainRetiredResources()
    }
    graphPublicationPending = false
    // True for one in-place parameter edit (same ids and kinds, no node replaced, no rebuild, same latency): the
    // caller then has no graph latency to republish.
    return {
      disposition: 'applied',
      inPlace: candidate.ownedIds.size === 0 && !candidate.requiresRoutingRebuild &&
        getEffectChainTiming(previous, ctx.sampleRate, currentBpm).latencyFrames ===
          getEffectChainTiming(normalized, ctx.sampleRate, currentBpm).latencyFrames,
    }
  }

  const installFxInstances = async (
    ctx: AudioContext,
    masterGain: GainNode,
    destination: AudioDestinationNode,
    instances: AudioEffectRuntimeInstance[],
  ) => {
    try {
      return await applyFxInstances(ctx, masterGain, destination, instances)
    } catch (error) {
      options.onWorkletFault?.(
        options.getFaultGeneration(),
        'owned-processor',
        'effect-chain-construction-failed',
        `master:${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }
  const noInstall: MasterFxOutcome = { disposition: 'dropped', inPlace: false }

  return {
    // The chain asked for before there was a context installs through the same path as any request. installFxInstances
    // has already reported a failure.
    applyPending: (ctx: AudioContext, masterGain: GainNode, destination: AudioDestinationNode) => {
      void admission.replay((instances) => installFxInstances(ctx, masterGain, destination, instances), noInstall)?.catch(() => undefined)
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
    // Every chain request, whole or single, goes through the admission: an equal request joins the work still running
    // (failure included) and a different one supersedes it in applyFxInstances. Without a context the request is only
    // kept, and the revision moves so the work of the chain it replaces cannot commit over it.
    setFxInstances: (
      ctx: AudioContext | null,
      masterGain: GainNode | null,
      destination: AudioDestinationNode | null,
      instances: AudioEffectRuntimeInstance[],
    ): Promise<MasterFxOutcome> => {
      if (!ctx || !masterGain) fxInstanceRevision += 1
      return admission.admit(
        normalizeAudioEffectRuntimeInstances(instances),
        ctx && masterGain ? (chain) => installFxInstances(ctx, masterGain, destination ?? ctx.destination, chain) : undefined,
        noInstall,
      )
    },
    // The chain last requested, installed or not.
    retainedInstances: (): readonly AudioEffectRuntimeInstance[] => admission.intent() ?? masterChainInstances,
    setBpm: (bpm: number) => {
      currentBpm = bpm
      let failure: unknown
      for (const [instanceId, state] of instanceDelayChains) {
        try {
          state.setBpm(bpm)
        } catch (error) {
          fxInstanceRevision += 1
          liveParams.delete(instanceId)
          failure ??= error
        }
      }
      if (failure !== undefined) throw failure
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
      graphPublicationPending = false
      fxInstanceRevision += 1
      admission.reset()
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
