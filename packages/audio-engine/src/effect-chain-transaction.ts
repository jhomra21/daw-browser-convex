import { normalizeCompressorParams, normalizeEqParams, serializeNormalizedEqParams, type EqParams } from '@daw-browser/shared'
import { createCompressorNodeChain, disconnectAudioNodes } from './effects/chain'
import { applyEqNodeParams, createEqNodes, getEqTopologySignature } from './effects/dsp'
import { createCompressorChainState, type CompressorChainState } from './effects/compressor-chain-state'
import { createDelayChainState, type DelayChainState } from './effects/delay-chain-state'
import { createReverbChainState, type ReverbChainState } from './effects/reverb-chain-state'
import { createSaturatorChainState, type SaturatorChainState } from './effects/saturator-chain-state'
import { normalizeAudioEffectRuntimeInstances, type AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { applyStaticWorkletNodeParams, createStaticWorkletNodeChain, disconnectStaticWorkletNodeChain, type StaticWorkletKind, type StaticWorkletNodeChain } from './effects/static-worklet-chain'
import { countStaticWorklets, isStaticWorkletKind, type LiveWorkletBudget } from './effects/live-worklet-budget'
import type { EngineDisposition } from './engine-disposition'

type EffectInstance = AudioEffectRuntimeInstance

const isStaticWorkletInstance = (
  instance: EffectInstance,
): instance is Extract<EffectInstance, { kind: StaticWorkletKind }> => isStaticWorkletKind(instance.kind)

export type InstanceResources = {
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

export const snapshotResources = (resources: InstanceResources): InstanceResources => ({
  eq: new Map(resources.eq),
  eqByBand: new Map(resources.eqByBand),
  eqSignatures: new Map(resources.eqSignatures),
  eqTopologySignatures: new Map(resources.eqTopologySignatures),
  compressors: new Map(resources.compressors),
  reverbs: new Map(resources.reverbs),
  saturators: new Map(resources.saturators),
  delays: new Map(resources.delays),
  staticWorklets: new Map(resources.staticWorklets),
})

export const removeResources = (resources: InstanceResources, id: string) => {
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

export const closeResources = (resources: InstanceResources, ids: Iterable<string>) => {
  for (const id of new Set(ids)) {
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

const heldIds = (resources: InstanceResources) => [
  ...resources.eq.keys(), ...resources.compressors.keys(), ...resources.reverbs.keys(),
  ...resources.saturators.keys(), ...resources.delays.keys(), ...resources.staticWorklets.keys(),
]

export type EffectChainOutcome = {
  disposition: EngineDisposition
  // One in-place parameter edit (same ids and kinds, no node replaced, no rebuild, same latency): the caller then has
  // no graph latency to republish. A skipped request changed nothing.
  inPlace: boolean
}

export type ChainCommit = {
  previous: readonly EffectInstance[] | undefined
  instances: readonly EffectInstance[]
  changed: readonly EffectInstance[]
  ownedIds: ReadonlySet<string>
  requiresRoutingRebuild: boolean
  // The previous publication never finished, so the routing is rebuilt whatever changed.
  publicationPending: boolean
}

// What a track or the master supplies: where its chain state lives, and how a committed chain reaches its routing and
// meters. The transaction decides what the nodes hold and when; the host decides how they are wired.
export type EffectChainHost = {
  // Budget owner, and the prefix of every fault context.
  owner: string
  budget: LiveWorkletBudget
  bpm: () => number
  eqChannelCount: (ctx: AudioContext) => number
  faultGeneration: () => number
  reportFault: (generation: number, kind: 'compressor' | 'owned-processor', code: string, context: string) => void
  installed: () => readonly EffectInstance[] | undefined
  install: (instances: EffectInstance[]) => void
  resources: () => InstanceResources
  publishResources: (resources: InstanceResources) => void
  retire: (resources: InstanceResources, ids: Set<string>) => void
  liveParams: () => Map<string, EffectInstance['params']>
  revision: () => number | undefined
  bumpRevision: () => number
  publicationPending: () => boolean
  beginPublication: () => void
  finishPublication: () => void
  bypassStaticWorklet: (instanceId: string, chain: StaticWorkletNodeChain) => void
  bindStaticWorkletMeter: (instanceId: string, chain: StaticWorkletNodeChain) => void
  bindCompressorMeter: (instanceId: string, state: CompressorChainState) => void
  // Wires the committed chain. Settled false means the routing could not be published yet.
  route: (commit: ChainCommit) => { settled: boolean; inPlace: boolean }
}

type Candidate = {
  resources: InstanceResources
  ownedIds: Set<string>
  requiresRoutingRebuild: boolean
  // Deferred: the nodes of an EQ whose topology is unchanged are written at the commit, never before it.
  eqParamUpdates: Array<{ instance: EffectInstance; nodes: BiquadFilterNode[]; params: EqParams }>
  // Instances whose parameters were written to the nodes that already held them.
  writtenInPlace: EffectInstance[]
}

type StaticWorkletChainHolder = {
  chain: StaticWorkletNodeChain | undefined
}

type InPlaceEdit = Pick<Candidate, 'requiresRoutingRebuild' | 'eqParamUpdates' | 'writtenInPlace'>

const noIds: ReadonlySet<string> = new Set()

export const createEffectChainTransaction = (host: EffectChainHost) => {
  const { budget } = host

  // Applies an instance's new parameters to the nodes that already hold it, replacing none. False when nothing holds it
  // that way, so the caller builds it. The one parameter path for a whole-chain update and for a single-instance edit.
  // Its proof leaves liveParams before a node is written and returns only when the request commits (recordCommittedParams):
  // a write that throws, or a request superseded after it, leaves a node holding what no proof names.
  const applyParamsInPlace = async (
    ctx: AudioContext,
    instance: EffectInstance,
    prior: EffectInstance | undefined,
    resources: InstanceResources,
    edit: InPlaceEdit,
    stale: () => boolean,
  ): Promise<boolean> => {
    const forgetLive = () => host.liveParams().delete(instance.id)
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
      edit.requiresRoutingRebuild = state.set(ctx, instance.params, host.bpm()).requiresRoutingRebuild || edit.requiresRoutingRebuild
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
    instances: readonly EffectInstance[],
    createdIds: ReadonlySet<string>,
    edit: Pick<Candidate, 'eqParamUpdates' | 'writtenInPlace'>,
  ) => {
    const held = host.liveParams()
    const ids = new Set(instances.map((instance) => instance.id))
    for (const id of held.keys()) if (!ids.has(id)) held.delete(id)
    for (const instance of instances) if (createdIds.has(instance.id)) held.set(instance.id, instance.params)
    for (const instance of edit.writtenInPlace) held.set(instance.id, instance.params)
    for (const update of edit.eqParamUpdates) {
      // The proof leaves before the nodes are written: a write that throws partway leaves them holding no named value.
      held.delete(update.instance.id)
      applyEqNodeParams(update.nodes, update.params)
      held.set(update.instance.id, update.instance.params)
    }
  }

  // Builds the nodes the candidate owns for one instance. False when a newer request owns the chain by the time the
  // construction finished; what this built is then already released.
  const build = async (
    ctx: AudioContext,
    instance: EffectInstance,
    candidate: Candidate,
    stale: () => boolean,
  ): Promise<boolean> => {
    const { resources } = candidate
    if (isStaticWorkletInstance(instance)) {
      const faultGeneration = host.faultGeneration()
      const holder: StaticWorkletChainHolder = { chain: undefined }
      const created = await createStaticWorkletNodeChain(ctx, instance.kind, instance.params, (code) => {
        if (!holder.chain) return
        host.bypassStaticWorklet(instance.id, holder.chain)
        host.reportFault(faultGeneration, 'owned-processor', code, `${host.owner}:effect:${instance.id}`)
      })
      holder.chain = created
      if (stale()) {
        disconnectStaticWorkletNodeChain(created)
        return false
      }
      resources.staticWorklets.set(instance.id, created)
      candidate.requiresRoutingRebuild = true
      return true
    }
    if (instance.kind === 'eq') {
      const params = normalizeEqParams(instance.params)
      const nodes = createEqNodes(ctx, params, host.eqChannelCount(ctx))
      resources.eq.set(instance.id, nodes)
      resources.eqByBand.set(instance.id, new Map(params.bands.filter((band) => band.enabled).flatMap((band, index) => {
        const node = nodes[index]
        return node ? [[band.id, node]] : []
      })))
      resources.eqSignatures.set(instance.id, serializeNormalizedEqParams(params))
      resources.eqTopologySignatures.set(instance.id, getEqTopologySignature(params))
      candidate.requiresRoutingRebuild = true
      return true
    }
    if (instance.kind === 'compressor') {
      const faultGeneration = host.faultGeneration()
      const state = createCompressorChainState((audioContext, params) =>
        createCompressorNodeChain(audioContext, params, (code) =>
          host.reportFault(faultGeneration, 'compressor', code, `${host.owner}:effect:${instance.id}`)))
      const result = await state.set(ctx, normalizeCompressorParams(instance.params))
      if (stale()) {
        state.close()
        return false
      }
      if (instance.params.enabled && !state.chain()) throw new Error('Failed to construct compressor chain.')
      resources.compressors.set(instance.id, state)
      candidate.requiresRoutingRebuild = result.changed || candidate.requiresRoutingRebuild
      return true
    }
    if (instance.kind === 'saturator') {
      const state = createSaturatorChainState()
      state.set(ctx, instance.params)
      resources.saturators.set(instance.id, state)
    } else if (instance.kind === 'delay') {
      const state = createDelayChainState()
      state.set(ctx, instance.params, host.bpm())
      resources.delays.set(instance.id, state)
    } else if (instance.kind === 'reverb') {
      const state = createReverbChainState()
      await state.set(ctx, instance.params)
      resources.reverbs.set(instance.id, state)
    } else {
      throw new Error('Unsupported audio effect kind.')
    }
    candidate.requiresRoutingRebuild = true
    return true
  }

  const run = async (ctx: AudioContext, instances: EffectInstance[]): Promise<EffectChainOutcome> => {
    const publicationPending = host.publicationPending()
    const revision = host.bumpRevision()
    const inputIds = new Set<string>()
    for (const instance of instances) {
      if (inputIds.has(instance.id)) throw new Error(`Duplicate effect instance ID: ${instance.id}`)
      inputIds.add(instance.id)
    }
    const normalized = normalizeAudioEffectRuntimeInstances(instances)
    const previous = host.installed()
    const previousById = new Map(previous?.map((instance) => [instance.id, instance]))
    const live = host.resources()
    const liveParams = host.liveParams()
    // Equal means the nodes hold the requested parameters, not that the installed chain lists them: a superseded
    // request can have moved a node and left the installed chain on its old value.
    const unchanged = (instance: EffectInstance) => {
      const prior = previousById.get(instance.id)
      const held = liveParams.get(instance.id)
      if (!prior || prior.kind !== instance.kind || held === undefined || JSON.stringify(held) !== JSON.stringify(instance.params)) return false
      if (isStaticWorkletKind(instance.kind)) return live.staticWorklets.get(instance.id)?.state === 'active'
      if (instance.kind === 'compressor') return !instance.params.enabled || live.compressors.get(instance.id)?.chain()?.state === 'active'
      return true
    }
    const changed = normalized.filter((instance) => !unchanged(instance))
    const changedInstances = new Set(changed)
    const sameChainOrder = previous !== undefined && previous.length === normalized.length &&
      previous.every((prior, index) => prior.id === normalized[index]?.id && prior.kind === normalized[index]?.kind)
    // The revision is already bumped, so an older request still in flight cannot commit over what the nodes hold.
    if (!publicationPending && sameChainOrder && changed.length === 0) return { disposition: 'skipped', inPlace: true }
    const transaction = budget.begin(host.owner, countStaticWorklets(changed))
    const stale = () => host.revision() !== revision || !budget.isCurrent(transaction)
    // Exactly one instance changed, with the same id and kind in the same place: its parameters go straight to the
    // nodes that hold it, before any resource snapshot, whole-chain loop, meter rebind or retirement scan.
    const [edited] = changed
    if (!publicationPending && edited && changed.length === 1 && sameChainOrder) {
      const edit: InPlaceEdit = { requiresRoutingRebuild: false, eqParamUpdates: [], writtenInPlace: [] }
      let applied: boolean
      try {
        applied = await applyParamsInPlace(ctx, edited, previousById.get(edited.id), live, edit, stale)
      } catch (error) {
        budget.rollback(transaction)
        throw error
      }
      if (applied) {
        if (stale()) {
          budget.rollback(transaction)
          return { disposition: 'superseded', inPlace: false }
        }
        if (!budget.commit(transaction, countStaticWorklets(normalized))) {
          budget.rollback(transaction)
          return { disposition: 'dropped', inPlace: false }
        }
        host.beginPublication()
        host.install(normalized)
        recordCommittedParams(normalized, noIds, edit)
        const routed = host.route({
          previous, instances: normalized, changed, ownedIds: noIds,
          requiresRoutingRebuild: edit.requiresRoutingRebuild, publicationPending: false,
        })
        if (routed.settled) host.finishPublication()
        return { disposition: 'applied', inPlace: routed.inPlace }
      }
    }
    const oldResources = snapshotResources(live)
    const candidate: Candidate = {
      resources: snapshotResources(oldResources),
      ownedIds: new Set(),
      requiresRoutingRebuild: previous?.length !== normalized.length ||
        previous.some((instance, index) => instance.id !== normalized[index]?.id || instance.kind !== normalized[index]?.kind),
      eqParamUpdates: [],
      writtenInPlace: [],
    }
    const discard = () => {
      closeResources(candidate.resources, candidate.ownedIds)
      budget.rollback(transaction)
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
        removeResources(candidate.resources, instance.id)
        if (!await build(ctx, instance, candidate, stale)) {
          discard()
          return { disposition: 'superseded', inPlace: false }
        }
      }
    } catch (error) {
      discard()
      throw error
    }
    if (stale()) {
      discard()
      return { disposition: 'superseded', inPlace: false }
    }
    if (!budget.commit(transaction, countStaticWorklets(normalized))) {
      discard()
      return { disposition: 'dropped', inPlace: false }
    }
    host.beginPublication()
    host.install(normalized)
    const installedIds = new Set(normalized.map((instance) => instance.id))
    const displaced = new Set<string>()
    const oldIds = new Set(heldIds(oldResources))
    for (const id of candidate.ownedIds) {
      if (oldIds.has(id)) displaced.add(id)
    }
    for (const id of oldIds) {
      if (!installedIds.has(id)) displaced.add(id)
    }
    for (const id of displaced) {
      if (!installedIds.has(id)) removeResources(candidate.resources, id)
    }
    if (displaced.size > 0) host.retire(oldResources, displaced)
    host.publishResources(candidate.resources)
    recordCommittedParams(normalized, candidate.ownedIds, candidate)
    for (const instance of normalized) {
      const staticWorklet = candidate.resources.staticWorklets.get(instance.id)
      if (staticWorklet) host.bindStaticWorkletMeter(instance.id, staticWorklet)
      const compressor = candidate.resources.compressors.get(instance.id)
      if (compressor) host.bindCompressorMeter(instance.id, compressor)
    }
    const routed = host.route({
      previous, instances: normalized, changed, ownedIds: candidate.ownedIds,
      requiresRoutingRebuild: candidate.requiresRoutingRebuild, publicationPending,
    })
    if (routed.settled) host.finishPublication()
    return { disposition: 'applied', inPlace: routed.inPlace }
  }

  return {
    apply: async (ctx: AudioContext, instances: EffectInstance[]): Promise<EffectChainOutcome> => {
      try {
        return await run(ctx, instances)
      } catch (error) {
        host.reportFault(
          host.faultGeneration(),
          'owned-processor',
          'effect-chain-construction-failed',
          `${host.owner}:${error instanceof Error ? error.message : String(error)}`,
        )
        throw error
      }
    },
  }
}
