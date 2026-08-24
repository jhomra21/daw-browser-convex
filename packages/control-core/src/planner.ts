import {
  canonicalTrackCreation,
  audioWarpEqual,
  createDefaultSynthParams,
  getAutomationParameterDescriptor,
  hasValidReturnTrackPartition,
  normalizeAutomationPoints,
  normalizeArpeggiatorParams,
  normalizeAudioEffectParamsForUpdate,
  normalizeMasterVolume,
  normalizeLegacyMidiClip,
  normalizePersistedInstrumentParams,
  normalizeTrackRouting,
  normalizeTrackInstrumentParams,
  normalizeAudioWarp,
  normalizeClipColor,
  normalizeTrackColor,
  midiMappingDescriptor,
  trackCreationCollapsed,
  parseGranularAutomationKey,
  parseInstrumentAutomationKey,
  parseSynthAutomationKey,
  granularAutomationKey,
  instrumentAutomationKey,
  synthAutomationKey,
  sidechainEligibilityError,
  sidechainTargetEligibilityError,
} from '@daw-browser/shared'
import { normalizeClipFades } from '@daw-browser/timeline-core/clip-fades'
import { sha256 } from '@noble/hashes/sha2.js'
import { recoveryLimitsV1 } from '@daw-browser/control/recovery-limits'
import type {
  ControlActionV1 as CanonicalControlActionV1,
  ProjectSnapshotV1 as CanonicalProjectSnapshotV1,
  ProjectSnapshotV2 as CanonicalProjectSnapshotV2,
  RecoveryPayload,
} from '@daw-browser/control'
import { ControlMidiResolutionError, resolveControlMidiActionV1 } from './midi'
import { collectDeletedTrackIdsV1, collectTrackDeletionAffectedIdsV1 } from './trackDeletion'
import { mergeRecoveryTrackOrderV1 } from './recovery-track-order'
import { buildTimelineRangeDeletePatchV1, type TimelineRangeDeletePatchV1 } from './timeline-range-delete'

type ContextualRefV1 = { source: 'persisted'; id: string } | { source: 'client'; clientRef: string }
type TrackRefV1 = ContextualRefV1
type ClipRefV1 = ContextualRefV1
type ProcessorRefV1 = ContextualRefV1
type ControlActionV1 = any
type ProjectSnapshotV1 = {
  version: any
  project: any
  tracks: any[]
  clips: any[]
  processors: any[]
  automation: any[]
  sidechains: any[]
  assets: any[]
  assetFolders: any[]
}
type PlannerRequest = { projectId: string; actions: ControlActionV1[] }
type CanonicalPlannerRequest = { projectId: string; actions: CanonicalControlActionV1[] }
type CanonicalProjectSnapshot = CanonicalProjectSnapshotV1 | CanonicalProjectSnapshotV2
type PlannerRecovery = { payload: RecoveryPayload }
type Entity = 'track' | 'clip' | 'effect'
export type ControlPlannerCapabilities = {
  externalVstRecovery: 'unsupported' | 'supported'
}
export const defaultControlPlannerCapabilities: Readonly<ControlPlannerCapabilities> = Object.freeze({
  externalVstRecovery: 'unsupported',
})
export type ControlPlanError = {
  code: 'validation' | 'not-found' | 'limit-exceeded'
  message: string
  actionIndex: number
}

export type PlannedControlActionV1 = {
  actionIndex: number
  action: CanonicalControlActionV1
  changed: boolean
  destructivePersisted?: boolean
  generatedInstrumentInstanceId?: string
  timelineRangeDelete?: TimelineRangeDeletePatchV1
}

export type ControlPlanV1<
  Snapshot extends CanonicalProjectSnapshot = CanonicalProjectSnapshotV2,
> = {
  baseSnapshot: Snapshot
  snapshot: Snapshot
  actions: PlannedControlActionV1[]
  applied: boolean
  priorRevision: number
  revision: number
  resolvedRefs: Array<{ entity: Entity; clientRef: string; id: string; persisted: false }>
  warnings: Array<{ code: string; message: string; actionIndex?: number }>
  changeSummary: {
    actionCount: number
    changes: Array<{ actionIndex: number; kind: string; description: string }>
  }
}

type ControlPlannerTraceV1<
  Snapshot extends CanonicalProjectSnapshot = CanonicalProjectSnapshotV1,
> = {
  onActionPlanned: (entry: {
    actionIndex: number
    action: CanonicalControlActionV1
    changed: boolean
    beforeSnapshot: Snapshot
    afterSnapshot: Snapshot
  }) => void
}

export const destructiveControlActionKindsV1 = [
  'track.delete',
  'track.ungroup',
  'clip.delete',
  'effect.remove',
  'instrument.remove',
  'arpeggiator.remove',
  'automation.delete',
  'sidechain.remove',
  'asset.delete',
  'timeline.range.delete',
] as const

const destructiveKinds = new Set<string>(destructiveControlActionKindsV1)

const countRemoved = (base: { id: string }[], final: { id: string }[]) => {
  const finalIds = new Set(final.map((entry) => entry.id))
  return base.filter((entry) => !finalIds.has(entry.id)).length
}

const countRemovedEntries = <Entry>(base: Entry[], final: Entry[]) => {
  const finalEntries = new Set(final.map(canonical))
  return base.filter((entry) => !finalEntries.has(canonical(entry))).length
}

const routingChanged = (
  baseTracks: ProjectSnapshotV1['tracks'],
  finalTracks: ProjectSnapshotV1['tracks'],
) => {
  const finalById = new Map(finalTracks.map((track) => [track.id, track]))
  return baseTracks.filter((track) => {
    const final = finalById.get(track.id)
    return final !== undefined && !same(
      { groupId: track.groupId, outputTargetId: track.outputTargetId, sends: track.sends },
      { groupId: final.groupId, outputTargetId: final.outputTargetId, sends: final.sends },
    )
  }).length
}

export const controlApprovalRequirementV1 = (plan: ControlPlanV1, requestDigest: string) => {
  const before = plan.baseSnapshot
  const after = plan.snapshot
  const impact = {
    tracks: countRemoved(before.tracks, after.tracks),
    clips: countRemoved(before.clips, after.clips),
    processors: countRemoved(before.processors, after.processors),
    automation: countRemovedEntries(before.automation, after.automation),
    sidechains: countRemovedEntries(before.sidechains, after.sidechains),
    assets: countRemoved(before.assets, after.assets),
    routingChanges: routingChanged(before.tracks, after.tracks),
  }
  const destructive = plan.actions.filter((entry) => entry.destructivePersisted)
  return {
    required: destructive.length > 0,
    actionIndexes: destructive.map((entry) => entry.actionIndex),
    actionKinds: destructive.map((entry) => entry.action.kind),
    impact,
    requestDigest,
    baseRevision: plan.priorRevision,
    expiresInSeconds: 600 as const,
  }
}

type ControlPlannerOptionsV1<
  Snapshot extends CanonicalProjectSnapshot = CanonicalProjectSnapshotV1,
> = {
  trace?: ControlPlannerTraceV1<Snapshot>
  actionIndexOffset?: number
  capabilities?: Readonly<ControlPlannerCapabilities>
}

const planError = (actionIndex: number, code: ControlPlanError['code'], message: string): never => {
  throw { code, message, actionIndex } satisfies ControlPlanError
}

const placeholderId = (entity: Entity, clientRef: string | undefined, actionIndex: number) => (
  `control:${entity}:${clientRef ?? actionIndex}`
)

const isCanonicalPrimitive = <Value>(
  value: Value,
): value is Value & (null | boolean | number | string | undefined) => (
  value === undefined
  || value === null
  || typeof value === 'boolean'
  || typeof value === 'number'
  || typeof value === 'string'
)

const isCanonicalObject = <Value>(value: Value): value is Value & object => (
  typeof value === 'object' && value !== null
)

const canonical = <Value>(value: Value): string => {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (isCanonicalPrimitive(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!isCanonicalObject(value)) throw new Error('Unsupported planner value.')
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`
}

const same = <Left, Right>(left: Left, right: Right) => canonical(left) === canonical(right)
const plannerSha256 = (value: string) => (
  Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
)
const timelineRangeClipDigest = (clip: ProjectSnapshotV1['clips'][number]) => {
  const { id: _id, ...semantic } = clip
  return plannerSha256(canonical(semantic))
}
const timelineRangeAutomationDigest = (automation: ProjectSnapshotV1['automation'][number]) => (
  plannerSha256(canonical(automation))
)

export const canonicalizePlannerSnapshotV1 = <
  Snapshot extends CanonicalProjectSnapshot,
>(
  snapshot: Snapshot,
): Snapshot => {
  const canonicalSnapshot = structuredClone(snapshot)
  canonicalSnapshot.tracks.sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
  canonicalSnapshot.clips.sort((left, right) => left.startSec - right.startSec || (left.id < right.id ? -1 : 1))
  canonicalSnapshot.processors.sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
  return canonicalSnapshot
}

const recoverySurvivorState = (entry: any) => ({
  index: entry.index,
  groupId: entry.groupId,
  outputTargetId: entry.mixer?.outputTargetId ?? entry.outputTargetId,
  sends: (entry.mixer?.sends ?? entry.sends).map((send: any) => ({
    targetTrackId: send.targetId ?? send.targetTrackId,
    amount: send.amount,
    tap: send.tap,
  })),
})

export const rebaseRecoveryAutomationParameterIdV1 = (parameterId: string, trackId: string | undefined) => {
  if (trackId === undefined) return parameterId
  const instrument = parseInstrumentAutomationKey(parameterId)
  if (instrument) return instrumentAutomationKey(trackId, instrument.instanceId, instrument.parameterId)
  const granular = parseGranularAutomationKey(parameterId)
  if (granular) return granularAutomationKey(trackId, granular.instanceId, granular.parameterId)
  const synth = parseSynthAutomationKey(parameterId)
  return synth ? synthAutomationKey(trackId, synth.instanceId, synth.parameterId) : parameterId
}

const validateRecoveryLimits = (
  actionIndex: number,
  snapshot: ProjectSnapshotV1,
  trackIds: Set<string>,
  transitions: readonly ProjectSnapshotV1['tracks'][number][] = [],
) => {
  const clips = snapshot.clips.filter((clip) => trackIds.has(clip.trackId))
  const processors = snapshot.processors.filter((processor) => 'trackId' in processor.target && trackIds.has(processor.target.trackId))
  const automation = snapshot.automation.filter((entry) => 'trackId' in entry.target && trackIds.has(entry.target.trackId))
  const sidechains = snapshot.sidechains.filter((entry) => trackIds.has(entry.sourceTrackId) || trackIds.has(entry.targetTrackId))
  const entities = trackIds.size + clips.length + processors.length + automation.length + sidechains.length
  const points = automation.reduce((total, entry) => total + entry.points.length, 0)
  const markers = clips.reduce((total, clip) => total + (clip.audioWarp?.markers?.length ?? 0), 0)
  const sends = Array.from(trackIds, (id) => tracksById(snapshot.tracks).get(id)?.sends.length ?? 0)
    .reduce((total, count) => total + count, 0)
    + transitions.reduce((total, track) => total + track.sends.length * 2, 0)
  if (
    entities > recoveryLimitsV1.maxEntities
    || transitions.length > recoveryLimitsV1.maxEntities
    || points > recoveryLimitsV1.maxAutomationPoints
    || markers > recoveryLimitsV1.maxWarpMarkers
    || sends > recoveryLimitsV1.maxSends
  ) planError(actionIndex, 'limit-exceeded', 'Recovery payload exceeds recovery limits.')
}

const tracksById = (tracks: ProjectSnapshotV1['tracks']) => new Map(tracks.map((track) => [track.id, track]))

const validateExternalVstRecovery = (
  actionIndex: number,
  snapshot: ProjectSnapshotV1,
  affectedTrackIds: ReadonlySet<string>,
  capabilities: Readonly<ControlPlannerCapabilities>,
) => {
  if (capabilities.externalVstRecovery === 'supported') return
  if (snapshot.processors.some((processor) => (
    processor.processor.kind === 'external-vst3'
    && 'trackId' in processor.target
    && affectedTrackIds.has(processor.target.trackId)
  ))) {
    planError(
      actionIndex,
      'validation',
      'External VST processors are not currently recoverable through canonical control.',
    )
  }
}

const removedBaseEntries = (base: unknown[], before: unknown[], after: unknown[]) => {
  const baseEntries = new Set(base.map(canonical))
  const beforeEntries = new Set(before.map(canonical))
  const afterEntries = new Set(after.map(canonical))
  return Array.from(baseEntries).some((entry) => beforeEntries.has(entry) && !afterEntries.has(entry))
}

const removedBaseIds = (
  base: { id: string }[],
  before: { id: string }[],
  after: { id: string }[],
) => {
  const baseIds = new Set(base.map((entry) => entry.id))
  const beforeIds = new Set(before.map((entry) => entry.id))
  const afterIds = new Set(after.map((entry) => entry.id))
  return Array.from(baseIds).some((id) => beforeIds.has(id) && !afterIds.has(id))
}

const changesBaseRouting = (
  base: ProjectSnapshotV1['tracks'],
  before: ProjectSnapshotV1['tracks'],
  after: ProjectSnapshotV1['tracks'],
) => {
  const baseIds = new Set(base.map((track) => track.id))
  const afterById = new Map(after.map((track) => [track.id, track]))
  return before.some((track) => {
    if (!baseIds.has(track.id)) return false
    const next = afterById.get(track.id)
    return next !== undefined && !same(
      { groupId: track.groupId, outputTargetId: track.outputTargetId, sends: track.sends },
      { groupId: next.groupId, outputTargetId: next.outputTargetId, sends: next.sends },
    )
  })
}

const hasPersistedDestructiveEffect = (
  base: ProjectSnapshotV1,
  before: ProjectSnapshotV1,
  after: ProjectSnapshotV1,
) => (
  removedBaseIds(base.tracks, before.tracks, after.tracks)
  || removedBaseIds(base.clips, before.clips, after.clips)
  || removedBaseIds(base.processors, before.processors, after.processors)
  || removedBaseIds(base.assets, before.assets, after.assets)
  || removedBaseEntries(base.automation, before.automation, after.automation)
  || removedBaseEntries(base.sidechains, before.sidechains, after.sidechains)
  || changesBaseRouting(base.tracks, before.tracks, after.tracks)
)

const referenceId = (
  ref: ContextualRefV1,
  entity: Entity,
  ids: Map<string, string>,
  actionIndex: number,
): string => {
  if (ref.source === 'persisted') return ref.id
  const id = ids.get(ref.clientRef)
  return id ?? planError(actionIndex, 'not-found', `Unknown client ${entity} reference "${ref.clientRef}".`)
}

const requireTrack = (
  ref: TrackRefV1,
  tracks: Map<string, ProjectSnapshotV1['tracks'][number]>,
  trackRefs: Map<string, string>,
  actionIndex: number,
): ProjectSnapshotV1['tracks'][number] => {
  const id = referenceId(ref, 'track', trackRefs, actionIndex)
  const track = tracks.get(id)
  return track ?? planError(actionIndex, 'not-found', `Track "${id}" was not found.`)
}

const requireClip = (
  ref: ClipRefV1,
  clips: Map<string, ProjectSnapshotV1['clips'][number]>,
  clipRefs: Map<string, string>,
  actionIndex: number,
): ProjectSnapshotV1['clips'][number] => {
  const id = referenceId(ref, 'clip', clipRefs, actionIndex)
  const clip = clips.get(id)
  return clip ?? planError(actionIndex, 'not-found', `Clip "${id}" was not found.`)
}

const requireEffect = (
  ref: ProcessorRefV1,
  processors: Map<string, ProjectSnapshotV1['processors'][number]>,
  effectRefs: Map<string, string>,
  actionIndex: number,
): ProjectSnapshotV1['processors'][number] => {
  const id = referenceId(ref, 'effect', effectRefs, actionIndex)
  const processor = processors.get(id)
  return processor ?? planError(actionIndex, 'not-found', `Effect "${id}" was not found.`)
}

const requireAudioAssetSource = (
  assetId: string,
  assets: Map<string, ProjectSnapshotV1['assets'][number]>,
  actionIndex: number,
) => {
  const asset = assets.get(assetId)
    ?? planError(actionIndex, 'not-found', `Asset "${assetId}" was not found.`)
  if (asset.durationSec === undefined || asset.sampleRate === undefined || asset.channelCount === undefined) {
    planError(actionIndex, 'validation', 'Audio clips require an asset with complete source metadata.')
  }
  return {
    assetId: asset.id,
    sourceKind: asset.sourceKind,
    durationSec: asset.durationSec,
    sampleRate: asset.sampleRate,
    channelCount: asset.channelCount,
  }
}

const recoveredClip = (
  id: string,
  clip: any,
  trackId: string,
  assets: Map<string, ProjectSnapshotV1['assets'][number]>,
  actionIndex: number,
) => ({
  id,
  trackId,
  name: clip.name ?? 'Recovered clip',
  startSec: clip.startSec,
  duration: clip.duration,
  gain: clip.gain,
  leftPadSec: clip.leftPadSec ?? 0,
  bufferOffsetSec: clip.bufferOffsetSec ?? 0,
  midiOffsetBeats: clip.midiOffsetBeats ?? 0,
  fades: clip.fades,
  audioWarp: clip.audioWarp,
  color: clip.color,
  midi: clip.midi === undefined ? undefined : normalizeLegacyMidiClip(clip.midi),
  source: clip.sourceAssetKey === undefined ? undefined : requireAudioAssetSource(clip.sourceAssetKey, assets, actionIndex),
})

const targetMatches = (
  processor: ProjectSnapshotV1['processors'][number],
  target: { kind: 'track'; track: ContextualRefV1 } | { kind: 'master' },
  tracks: Map<string, ProjectSnapshotV1['tracks'][number]>,
  trackRefs: Map<string, string>,
  actionIndex: number,
) => {
  if (target.kind === 'master') return 'master' in processor.target
  const track = requireTrack(target.track, tracks, trackRefs, actionIndex)
  return 'trackId' in processor.target && processor.target.trackId === track.id
}

const validateGroups = (
  tracks: Iterable<ProjectSnapshotV1['tracks'][number]>,
  actionIndex: number,
) => {
  const trackById = new Map(Array.from(tracks, (track) => [track.id, track]))
  for (const track of trackById.values()) {
    const seen = new Set<string>()
    let parentId = track.groupId
    while (parentId) {
      if (parentId === track.id || seen.has(parentId)) planError(actionIndex, 'validation', 'Track grouping creates a cycle.')
      seen.add(parentId)
      parentId = trackById.get(parentId)?.groupId
    }
  }
}

const describe = (action: ControlActionV1) => action.kind.replaceAll('.', ' ')

const isAudioEffectKind = (kind: string) => (
  kind === 'utility' || kind === 'eq' || kind === 'autofilter' || kind === 'gate'
  || kind === 'compressor' || kind === 'saturator' || kind === 'limiter' || kind === 'lofi'
  || kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo'
  || kind === 'autopan' || kind === 'ensemble' || kind === 'delay' || kind === 'reverb'
  || kind === 'spectral'
)

const compactTrackProcessorIndexes = (
  processors: ProjectSnapshotV1['processors'],
  trackId: string,
) => {
  processors
    .filter((entry) => 'trackId' in entry.target && entry.target.trackId === trackId)
    .sort((left, right) => left.index - right.index)
    .forEach((entry, index) => { entry.index = index })
}

const validateAutomationTarget = (
  action: { parameterId: string },
  target: ProjectSnapshotV1['processors'][number]['target'],
  effect: ProjectSnapshotV1['processors'][number] | undefined,
  processors: Map<string, ProjectSnapshotV1['processors'][number]>,
  actionIndex: number,
) => {
  const descriptor = getAutomationParameterDescriptor(action.parameterId)
    ?? planError(actionIndex, 'validation', 'Unsupported automation parameter.')
  if (!descriptor.targetKinds.includes('master' in target ? 'master' : 'track')) {
    planError(actionIndex, 'validation', 'Unsupported automation parameter.')
  }
  if (descriptor.owner === 'mixer' && effect) {
    planError(actionIndex, 'validation', 'Mixer automation cannot reference an effect instance.')
  }
  const instrumentKey = parseInstrumentAutomationKey(action.parameterId)
  const granularKey = parseGranularAutomationKey(action.parameterId)
  const synthKey = parseSynthAutomationKey(action.parameterId)
  const instrumentAutomation = instrumentKey ?? granularKey ?? synthKey
  if (instrumentAutomation) {
    if ('master' in target || effect) {
      planError(actionIndex, 'validation', 'Instrument automation identity does not match its target.')
    }
    if (instrumentAutomation.trackId !== target.trackId) {
      planError(actionIndex, 'validation', 'Instrument automation identity does not match its target.')
    }
    const instrument = Array.from(processors.values()).find((entry) => (
      'trackId' in entry.target
      && entry.target.trackId === target.trackId
      && entry.processor.kind === 'instrument'
    ))
    const params = instrument ? normalizeTrackInstrumentParams(instrument.processor.params) : undefined
    const kind = granularKey ? 'granular' : synthKey ? 'synth' : 'sampler'
    if (!params || params.instanceId !== instrumentAutomation.instanceId || params.kind !== kind) {
      planError(actionIndex, 'validation', 'Instrument automation instance does not belong to this track.')
    }
    return descriptor
  }
  if (descriptor.owner !== 'mixer') {
    const requiredEffect = effect
      ?? planError(actionIndex, 'validation', 'Effect automation requires an effect instance.')
    if (requiredEffect.processor.kind !== descriptor.owner) {
      planError(actionIndex, 'validation', 'Automation effect instance does not belong to this target.')
    }
  }
  return descriptor
}

const validateMidiMappings = (
  midi: ReturnType<typeof normalizeLegacyMidiClip>,
  previous: ReturnType<typeof normalizeLegacyMidiClip> | undefined,
  clipTrackId: string,
  processors: Map<string, ProjectSnapshotV1['processors'][number]>,
  actionIndex: number,
) => {
  const previousById = new Map((previous?.mappings ?? []).map((mapping) => [mapping.id, mapping]))
  for (const mapping of midi.mappings) {
    const before = previousById.get(mapping.id)
    if (before && same(before, mapping)) continue
    const descriptor = midiMappingDescriptor(mapping.target)
      ?? planError(actionIndex, 'validation', 'Unsupported MIDI mapping target.')
    if (mapping.target.effectInstanceId === undefined) continue
    const processor = Array.from(processors.values()).find((entry) => (
      'trackId' in entry.target
      && entry.target.trackId === clipTrackId
      && entry.instanceId === mapping.target.effectInstanceId
    ))
    if (!processor || processor.processor.kind !== descriptor.owner) {
      planError(actionIndex, 'validation', 'MIDI mapping effect does not belong to the clip track.')
    }
  }
}

export function planControlRequestV1<
  Snapshot extends CanonicalProjectSnapshot,
>(
  base: Snapshot,
  request: CanonicalPlannerRequest,
  trustedRecoveries?: ReadonlyMap<string, PlannerRecovery>,
  options?: ControlPlannerOptionsV1<Snapshot>,
): ControlPlanV1<Snapshot>
export function planControlRequestV1(
  base: ProjectSnapshotV1,
  request: PlannerRequest,
  trustedRecoveries: ReadonlyMap<string, PlannerRecovery> = new Map(),
  options: ControlPlannerOptionsV1<CanonicalProjectSnapshot> = {},
) {
  const capabilities = options.capabilities ?? defaultControlPlannerCapabilities
  const trace = options.trace
  const actionIndexOffset = options.actionIndexOffset ?? 0
  if (base.project.id !== request.projectId) {
    planError(0, 'not-found', 'Project snapshot does not match the request project.')
  }
  const snapshot = structuredClone(base)
  const tracks = new Map(snapshot.tracks.map((track) => [track.id, track]))
  const clips = new Map(snapshot.clips.map((clip) => [clip.id, clip]))
  const processors = new Map(snapshot.processors.map((processor) => [processor.id, processor]))
  const assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]))
  const restoredAssetIds = new Set<string>()
  const trackRefs = new Map<string, string>()
  const clipRefs = new Map<string, string>()
  const effectRefs = new Map<string, string>()
  const resolvedRefs: ControlPlanV1['resolvedRefs'] = []
  const planned: PlannedControlActionV1[] = []
  let resolvedMidiEvents = 0
  const enforceResolvedMidiAggregate = (
    actionIndex: number,
    midi: ReturnType<typeof normalizeLegacyMidiClip>,
    previous?: ReturnType<typeof normalizeLegacyMidiClip>,
  ) => {
    const performanceEvents = midi.notes.length + midi.cc.length + midi.pitchBends.length
      + midi.channelPressure.length + midi.polyPressure.length
    const previousEvents = previous === undefined ? 0 : previous.notes.length + previous.cc.length
      + previous.pitchBends.length + previous.channelPressure.length + previous.polyPressure.length
    if (previous === undefined || previousEvents <= 500) resolvedMidiEvents += performanceEvents
    if (resolvedMidiEvents > 500) {
      planError(actionIndex, 'limit-exceeded', 'Control request exceeds 500 MIDI performance events.')
    }
  }
  const traceAction = (
    actionIndex: number,
    action: ControlActionV1,
    changed: boolean,
    beforeSnapshot: ProjectSnapshotV1 | undefined,
  ) => {
    if (!trace) return
    trace.onActionPlanned({
      actionIndex,
      action,
      changed,
      beforeSnapshot: canonicalizePlannerSnapshotV1(beforeSnapshot ?? snapshot),
      afterSnapshot: canonicalizePlannerSnapshotV1(snapshot),
    })
  }

  const resolveTarget = (
    target: { kind: 'track'; track: ContextualRefV1 } | { kind: 'master' },
    actionIndex: number,
  ): ProjectSnapshotV1['processors'][number]['target'] => {
    if (target.kind === 'master') return { master: true }
    return { trackId: requireTrack(target.track, tracks, trackRefs, actionIndex).id }
  }

  for (const [requestActionIndex, action] of request.actions.entries()) {
    const actionIndex = requestActionIndex + actionIndexOffset
    let changed = false
    const beforeAction = trace || destructiveKinds.has(action.kind)
      ? structuredClone(snapshot)
      : undefined
    switch (action.kind) {
      case 'project.rename': {
        const name = action.name.trim()
        changed = snapshot.project.name !== name
        snapshot.project.name = name
        break
      }
      case 'project.settings.set': {
        const project = snapshot.project
        const next = {
          tempoBpm: action.tempoBpm ?? project.tempoBpm,
          timeSignature: {
            numerator: action.timeSignatureNumerator ?? project.timeSignature.numerator,
            denominator: action.timeSignatureDenominator ?? project.timeSignature.denominator,
          },
          loop: {
            enabled: action.loopEnabled ?? project.loop.enabled,
            startSec: action.loopStartSec ?? project.loop.startSec,
            endSec: action.loopEndSec ?? project.loop.endSec,
          },
        }
        if (next.loop.endSec < next.loop.startSec + 0.05) planError(actionIndex, 'validation', 'Loop end must be at least 0.05 seconds after loop start.')
        changed = !same(
          { tempoBpm: project.tempoBpm, timeSignature: project.timeSignature, loop: project.loop },
          next,
        )
        project.tempoBpm = next.tempoBpm
        project.timeSignature = next.timeSignature
        project.loop = next.loop
        break
      }
      case 'track.create': {
        const id = placeholderId('track', action.clientRef, actionIndex)
        if (tracks.has(id)) planError(actionIndex, 'validation', `Track "${id}" already exists.`)
        const creation = canonicalTrackCreation(
          Array.from(tracks.values()),
          action.channelRole,
          action.index,
        )
        for (const existing of creation.existingTracks) {
          const current = tracks.get(existing.id)
          if (!current) continue
          current.index = existing.index
          current.groupId = existing.groupId
        }
        const index = creation.creationIndex
        const track = {
          id,
          name: action.name ?? `Track ${index + 1}`,
          index,
          kind: action.trackKind ?? 'audio',
          channelRole: action.channelRole ?? 'track',
          volume: 0.8,
          muted: false,
          soloed: false,
          sends: [],
          collapsed: trackCreationCollapsed(action.channelRole, undefined),
          color: action.color === undefined ? undefined : normalizeTrackColor(action.color) ?? planError(actionIndex, 'validation', 'Invalid track color.'),
        }
        tracks.set(id, track)
        snapshot.tracks.push(track)
        const generatedInstrumentInstanceId = (
          (action.trackKind ?? 'audio') === 'instrument'
          && (action.channelRole ?? 'track') === 'track'
        ) ? `control:instrument:${actionIndex}` : undefined
        if (generatedInstrumentInstanceId) {
          const processor = {
            id: placeholderId('effect', undefined, actionIndex),
            target: { trackId: id },
            instanceId: generatedInstrumentInstanceId,
            index: 0,
            processor: {
              kind: 'instrument',
              params: {
                kind: 'synth',
                instanceId: generatedInstrumentInstanceId,
                params: createDefaultSynthParams(),
              },
            },
          }
          processors.set(processor.id, processor)
          snapshot.processors.push(processor)
        }
        if (action.clientRef) {
          trackRefs.set(action.clientRef, id)
          resolvedRefs.push({ entity: 'track', clientRef: action.clientRef, id, persisted: false })
        }
        changed = true
        planned.push({ actionIndex, action, changed, generatedInstrumentInstanceId })
        traceAction(actionIndex, action, changed, beforeAction)
        continue
      }
      case 'track.rename': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        changed = track.name !== action.name.trim()
        track.name = action.name.trim()
        break
      }
      case 'track.mix.set': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const next = {
          volume: action.volume ?? track.volume,
          muted: action.muted ?? track.muted,
          soloed: action.soloed ?? track.soloed,
        }
        changed = !same({ volume: track.volume, muted: track.muted, soloed: track.soloed }, next)
        track.volume = next.volume
        track.muted = next.muted
        track.soloed = next.soloed
        break
      }
      case 'track.routing.set': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const outputTargetId = action.output === undefined
          ? track.outputTargetId
          : action.output === null ? undefined : requireTrack(action.output, tracks, trackRefs, actionIndex).id
        const sends = action.sends === undefined
          ? track.sends
          : action.sends.map((send: any) => ({
              targetTrackId: requireTrack(send.target, tracks, trackRefs, actionIndex).id,
              amount: send.amount,
              tap: send.tap,
            }))
        const normalized = normalizeTrackRouting({
          track: { id: track.id, channelRole: track.channelRole, groupId: track.groupId },
          outputTargetId,
          sends: sends.map((send: any) => ({ targetId: send.targetTrackId, amount: send.amount, tap: send.tap })),
          tracks: Array.from(tracks.values(), (value) => ({ id: value.id, channelRole: value.channelRole, groupId: value.groupId })),
        })
        const nextSends = normalized.sends.map((send) => ({
          targetTrackId: send.targetId,
          amount: send.amount,
          tap: send.tap,
        }))
        changed = !same(
          { outputTargetId: track.outputTargetId, sends: track.sends },
          { outputTargetId: normalized.outputTargetId, sends: nextSends },
        )
        track.outputTargetId = normalized.outputTargetId
        track.sends = nextSends
        break
      }
      case 'track.group.set': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const groupId = action.group === null ? undefined : requireTrack(action.group, tracks, trackRefs, actionIndex).id
        if (groupId && tracks.get(groupId)?.channelRole !== 'group') planError(actionIndex, 'validation', 'A track group must target a group track.')
        if (track.channelRole === 'return' && groupId) planError(actionIndex, 'validation', 'Return tracks cannot belong to a group.')
        changed = track.groupId !== groupId
        track.groupId = groupId
        validateGroups(tracks.values(), actionIndex)
        break
      }
      case 'track.reorder': {
        if (action.tracks.length !== tracks.size) planError(actionIndex, 'validation', 'Track reorder must include every project track.')
        const updates = action.tracks.map((update: any) => ({
          track: requireTrack(update.track, tracks, trackRefs, actionIndex),
          index: update.index,
          groupId: update.group === null ? undefined : requireTrack(update.group, tracks, trackRefs, actionIndex).id,
        }))
        if (new Set(updates.map((update: any) => update.track.id)).size !== tracks.size) planError(actionIndex, 'validation', 'Track reorder contains duplicate tracks.')
        if (!same(updates.map((update: any) => update.index).sort((left: number, right: number) => left - right), Array.from({ length: tracks.size }, (_, index) => index))) {
          planError(actionIndex, 'validation', 'Track reorder positions must be contiguous.')
        }
        changed = updates.some((update: any) => update.track.index !== update.index || update.track.groupId !== update.groupId)
        for (const update of updates) {
          update.track.index = update.index
          update.track.groupId = update.groupId
        }
        validateGroups(tracks.values(), actionIndex)
        if (!hasValidReturnTrackPartition(Array.from(tracks.values()))) {
          planError(actionIndex, 'validation', 'Return tracks must remain an ungrouped suffix.')
        }
        break
      }
      case 'track.delete': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const affectedTrackIds = collectTrackDeletionAffectedIdsV1(
          Array.from(tracks.values()),
          snapshot.sidechains,
          track.id,
        )
        validateExternalVstRecovery(actionIndex, snapshot, affectedTrackIds, capabilities)
        const deletedTrackIds = collectDeletedTrackIdsV1(Array.from(tracks.values()), track.id)
        const survivors = Array.from(tracks.values())
          .filter((entry) => !deletedTrackIds.has(entry.id))
          .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
          .filter((entry, index) => (
            entry.index !== index
            || entry.groupId !== undefined && deletedTrackIds.has(entry.groupId)
            || entry.outputTargetId !== undefined && deletedTrackIds.has(entry.outputTargetId)
            || entry.sends.some((send: any) => deletedTrackIds.has(send.targetTrackId))
          ))
        validateRecoveryLimits(actionIndex, snapshot, deletedTrackIds, survivors)
        for (const id of deletedTrackIds) tracks.delete(id)
        snapshot.tracks = snapshot.tracks.filter((entry) => !deletedTrackIds.has(entry.id))
        snapshot.clips = snapshot.clips.filter((entry) => !deletedTrackIds.has(entry.trackId))
        for (const clip of clips.values()) if (deletedTrackIds.has(clip.trackId)) clips.delete(clip.id)
        snapshot.processors = snapshot.processors.filter((entry) => !('trackId' in entry.target && deletedTrackIds.has(entry.target.trackId)))
        for (const processor of processors.values()) if ('trackId' in processor.target && deletedTrackIds.has(processor.target.trackId)) processors.delete(processor.id)
        snapshot.automation = snapshot.automation.filter((entry) => !('trackId' in entry.target && deletedTrackIds.has(entry.target.trackId)))
        snapshot.sidechains = snapshot.sidechains.filter((entry) => !deletedTrackIds.has(entry.sourceTrackId) && !deletedTrackIds.has(entry.targetTrackId))
        for (const current of tracks.values()) {
          if (current.groupId && deletedTrackIds.has(current.groupId)) current.groupId = undefined
          if (current.outputTargetId && deletedTrackIds.has(current.outputTargetId)) current.outputTargetId = undefined
          current.sends = current.sends.filter((send: any) => !deletedTrackIds.has(send.targetTrackId))
        }
        snapshot.tracks.sort((left, right) => left.index - right.index).forEach((entry, index) => { entry.index = index })
        changed = true
        break
      }
      case 'track.collapsed.set': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        changed = track.collapsed !== action.collapsed
        track.collapsed = action.collapsed
        break
      }
      case 'track.color.set': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        const color = action.color === null ? undefined : normalizeTrackColor(action.color)
        if (action.color !== null && !color) planError(actionIndex, 'validation', 'Invalid track color.')
        changed = track.color !== color
        track.color = color
        break
      }
      case 'track.color.cascade': {
        const root = requireTrack(action.root, tracks, trackRefs, actionIndex)
        const color = action.color === null ? undefined : normalizeTrackColor(action.color)
        if (action.color !== null && !color) planError(actionIndex, 'validation', 'Invalid track color.')
        const targetIds = new Set([root.id])
        if (root.channelRole === 'group') {
          let added = true
          while (added) {
            added = false
            for (const track of tracks.values()) {
              if (track.groupId && targetIds.has(track.groupId) && !targetIds.has(track.id)) {
                targetIds.add(track.id)
                added = true
              }
            }
          }
        }
        changed = false
        for (const track of tracks.values()) {
          if (!targetIds.has(track.id)) continue
          changed = changed || track.color !== color
          track.color = color
        }
        if (root.channelRole === 'group' && action.cascadeClipColors && color) {
          for (const clip of clips.values()) {
            if (!targetIds.has(clip.trackId)) continue
            changed = changed || clip.color !== color
            clip.color = color
          }
        }
        break
      }
      case 'track.ungroup': {
        const group = requireTrack(action.group, tracks, trackRefs, actionIndex)
        if (group.channelRole !== 'group') planError(actionIndex, 'validation', 'Only group tracks can be ungrouped.')
        const children = Array.from(tracks.values()).filter((track) => track.groupId === group.id)
        validateExternalVstRecovery(actionIndex, snapshot, new Set([group.id]), capabilities)
        validateRecoveryLimits(actionIndex, snapshot, new Set([group.id]), children)
        if (Array.from(clips.values()).some((clip) => clip.trackId === group.id)) planError(actionIndex, 'validation', 'Cannot ungroup a group with clips.')
        const childIds = new Set(children.map((child) => child.id))
        if (Array.from(tracks.values()).some((track) => (
          track.id !== group.id
          && !childIds.has(track.id)
          && (track.outputTargetId === group.id || track.sends.some((send: any) => send.targetTrackId === group.id))
        ))) {
          planError(actionIndex, 'validation', 'Cannot ungroup a group with external routing references.')
        }
        for (const child of children) {
          child.groupId = group.groupId
          if (child.outputTargetId === group.id) child.outputTargetId = group.groupId
        }
        tracks.delete(group.id)
        snapshot.tracks = snapshot.tracks.filter((track) => track.id !== group.id)
        snapshot.processors = snapshot.processors.filter((processor) => !('trackId' in processor.target && processor.target.trackId === group.id))
        snapshot.automation = snapshot.automation.filter((entry) => !('trackId' in entry.target && entry.target.trackId === group.id))
        snapshot.sidechains = snapshot.sidechains.filter((entry) => entry.sourceTrackId !== group.id && entry.targetTrackId !== group.id)
        snapshot.tracks.sort((left, right) => left.index - right.index).forEach((track, index) => { track.index = index })
        changed = true
        break
      }
      case 'clip.midi.create': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        if (track.kind !== 'instrument' || track.channelRole !== 'track') planError(actionIndex, 'validation', 'MIDI clips require an instrument track.')
        const id = placeholderId('clip', action.clientRef, actionIndex)
        const midi = (() => {
          try {
            return resolveControlMidiActionV1(action)
          } catch (error) {
            if (error instanceof ControlMidiResolutionError) {
              return planError(actionIndex, error.code, error.message.slice(0, 512))
            }
            throw error
          }
        })()
        validateMidiMappings(midi, undefined, track.id, processors, actionIndex)
        enforceResolvedMidiAggregate(actionIndex, midi)
        const clip = {
          id,
          trackId: track.id,
          name: action.name ?? 'MIDI Clip',
          startSec: action.startSec,
          duration: action.duration,
          gain: action.gain,
          leftPadSec: 0,
          bufferOffsetSec: 0,
          midiOffsetBeats: 0,
          midi,
        }
        clips.set(id, clip)
        snapshot.clips.push(clip)
        if (action.clientRef) {
          clipRefs.set(action.clientRef, id)
          resolvedRefs.push({ entity: 'clip', clientRef: action.clientRef, id, persisted: false })
        }
        changed = true
        break
      }
      case 'clip.audio.create': {
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        if (track.kind !== 'audio' || track.channelRole !== 'track') planError(actionIndex, 'validation', 'Audio clips require an audio track.')
        const source = requireAudioAssetSource(action.asset.id, assets, actionIndex)
        const asset = assets.get(action.asset.id)
        if (!asset) throw new Error('Audio asset disappeared during planning.')
        const id = placeholderId('clip', action.clientRef, actionIndex)
        const duration = action.duration ?? source.durationSec
        const clip = {
          id, trackId: track.id, name: action.name ?? asset.name, startSec: action.startSec ?? 0, duration,
          gain: action.gain, leftPadSec: action.leftPadSec ?? 0, bufferOffsetSec: action.bufferOffsetSec ?? 0,
          midiOffsetBeats: action.midiOffsetBeats ?? 0, fades: action.fades ? normalizeClipFades(action.fades, duration) : undefined,
          color: action.color === undefined ? undefined : normalizeClipColor(action.color) ?? planError(actionIndex, 'validation', 'Invalid clip color.'),
          audioWarp: action.audioWarp ? normalizeAudioWarp(action.audioWarp) : undefined,
          source,
        }
        clips.set(id, clip)
        snapshot.clips.push(clip)
        if (action.clientRef) {
          clipRefs.set(action.clientRef, id)
          resolvedRefs.push({ entity: 'clip', clientRef: action.clientRef, id, persisted: false })
        }
        changed = true
        break
      }
      case 'clip.source.set': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        if (clip.midi) planError(actionIndex, 'validation', 'MIDI clips cannot have an audio source.')
        const source = requireAudioAssetSource(action.asset.id, assets, actionIndex)
        changed = !same(clip.source, source)
        clip.source = source
        break
      }
      case 'clip.midi.set': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        if (!clip.midi) planError(actionIndex, 'validation', 'Audio clips cannot contain MIDI.')
        let midi
        try {
          midi = resolveControlMidiActionV1(action, clip.midi)
        } catch (error) {
          if (error instanceof ControlMidiResolutionError) {
            planError(actionIndex, error.code, error.message.slice(0, 512))
          }
          throw error
        }
        validateMidiMappings(midi, normalizeLegacyMidiClip(clip.midi), clip.trackId, processors, actionIndex)
        enforceResolvedMidiAggregate(actionIndex, midi, normalizeLegacyMidiClip(clip.midi))
        changed = !same(normalizeLegacyMidiClip(clip.midi), midi)
        clip.midi = midi
        break
      }
      case 'clip.fades.set': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        if (clip.midi) planError(actionIndex, 'validation', 'MIDI clips do not support fades.')
        const fades = normalizeClipFades(action.fades, clip.duration)
        changed = !same(clip.fades, fades)
        clip.fades = fades
        break
      }
      case 'clip.audioWarp.set': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        if (clip.midi) planError(actionIndex, 'validation', 'MIDI clips do not support audio warp.')
        const audioWarp = normalizeAudioWarp(action.audioWarp)
        changed = !audioWarpEqual(clip.audioWarp, audioWarp)
        if (changed) clip.audioWarp = audioWarp
        break
      }
      case 'clip.color.set': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        const color = action.color === null ? undefined : normalizeClipColor(action.color)
        if (action.color !== null && !color) planError(actionIndex, 'validation', 'Invalid clip color.')
        changed = clip.color !== color
        clip.color = color
        break
      }
      case 'clip.move': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        const track = requireTrack(action.track, tracks, trackRefs, actionIndex)
        if (clip.midi && (track.kind !== 'instrument' || track.channelRole !== 'track')) planError(actionIndex, 'validation', 'MIDI clips require an instrument track.')
        if (!clip.midi && (track.kind !== 'audio' || track.channelRole !== 'track')) planError(actionIndex, 'validation', 'Audio clips require an audio track.')
        if (clip.midi) validateMidiMappings(normalizeLegacyMidiClip(clip.midi), undefined, track.id, processors, actionIndex)
        changed = clip.trackId !== track.id || clip.startSec !== action.startSec
        clip.trackId = track.id
        clip.startSec = action.startSec
        break
      }
      case 'clip.timing.set': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        if (clip.midi && (action.fadeInSec !== undefined || action.fadeOutSec !== undefined)) {
          planError(actionIndex, 'validation', 'MIDI clips do not support fades.')
        }
        const duration = action.duration ?? clip.duration
        const fades = action.fadeInSec === undefined && action.fadeOutSec === undefined
          ? (clip.fades === undefined ? undefined : normalizeClipFades(clip.fades, duration))
          : normalizeClipFades({
              ...clip.fades,
              fadeInSec: action.fadeInSec,
              fadeOutSec: action.fadeOutSec,
            }, duration)
        const patch = {
          duration,
          gain: action.gain ?? clip.gain,
          leftPadSec: action.leftPadSec ?? clip.leftPadSec,
          bufferOffsetSec: action.bufferOffsetSec ?? clip.bufferOffsetSec,
          midiOffsetBeats: action.midiOffsetBeats ?? clip.midiOffsetBeats,
          fades,
        }
        changed = !same(
          {
            duration: clip.duration,
            gain: clip.gain,
            leftPadSec: clip.leftPadSec,
            bufferOffsetSec: clip.bufferOffsetSec,
            midiOffsetBeats: clip.midiOffsetBeats,
            fades: clip.fades,
          },
          patch,
        )
        Object.assign(clip, patch)
        break
      }
      case 'clip.rename': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        changed = clip.name !== action.name.trim()
        clip.name = action.name.trim()
        break
      }
      case 'clip.delete': {
        const clip = requireClip(action.clip, clips, clipRefs, actionIndex)
        clips.delete(clip.id)
        snapshot.clips = snapshot.clips.filter((entry) => entry.id !== clip.id)
        changed = true
        break
      }
      case 'timeline.range.delete': {
        const targetIds = action.tracks.map((track: TrackRefV1) => (
          requireTrack(track, tracks, trackRefs, actionIndex).id
        ))
        const patch = buildTimelineRangeDeletePatchV1(
          snapshot,
          targetIds,
          action.startSec,
          action.endSec,
          actionIndex,
        )
        for (const deletion of patch.clipDeletes) clips.delete(deletion.clipId)
        for (const update of patch.clipUpdates) clips.set(update.clipId, update.after)
        for (const creation of patch.clipCreates) clips.set(creation.placeholderId, creation.after)
        snapshot.clips = [
          ...Array.from(clips.values()).filter((clip) => (
            !patch.clipCreates.some((creation) => creation.placeholderId === clip.id)
          )),
          ...patch.clipCreates.map((creation) => creation.after),
        ]
        const automationByIdentity = (entry: ProjectSnapshotV1['automation'][number]) => canonical({
          target: entry.target,
          effectInstanceId: entry.effectInstanceId,
          parameterId: entry.parameterId,
        })
        const updates = new Map(patch.automationUpdates.map((update) => [
          canonical(update.identity),
          update.after,
        ]))
        snapshot.automation = snapshot.automation.map((entry) => (
          updates.get(automationByIdentity(entry)) ?? entry
        ))
        changed = patch.clipDeletes.length > 0
          || patch.clipUpdates.length > 0
          || patch.clipCreates.length > 0
          || patch.automationUpdates.length > 0
        const baseClipIds = new Set(base.clips.map((clip) => clip.id))
        const destructivePersisted = patch.clipDeletes.some((entry) => baseClipIds.has(entry.clipId))
          || patch.clipUpdates.some((entry) => baseClipIds.has(entry.clipId))
          || patch.automationUpdates.some((update) => base.automation.some((entry) => (
            same(entry.target, update.identity.target)
            && entry.effectInstanceId === update.identity.effectInstanceId
            && entry.parameterId === update.identity.parameterId
          )))
        planned.push({
          actionIndex,
          action,
          changed,
          timelineRangeDelete: patch,
          destructivePersisted: destructivePersisted ? destructivePersisted : undefined,
        })
        traceAction(actionIndex, action, changed, beforeAction)
        continue
      }
      case 'asset.delete': {
        const asset = assets.get(action.asset.id)
        if (!asset) {
          changed = false
          break
        }
        if (Array.from(clips.values()).some((clip) => clip.source?.assetId === asset.id)) {
          planError(actionIndex, 'validation', 'Referenced assets cannot be deleted.')
        }
        assets.delete(asset.id)
        snapshot.assets = snapshot.assets.filter((entry) => entry.id !== asset.id)
        changed = true
        break
      }
      case 'master.volume.set': {
        const volume = normalizeMasterVolume(action.volume)
        changed = snapshot.project.masterVolume !== volume
        snapshot.project.masterVolume = volume
        break
      }
      case 'effect.upsert': {
        const target = resolveTarget(action.target, actionIndex)
        const existing = action.effect === undefined ? undefined : requireEffect(action.effect, processors, effectRefs, actionIndex)
        if (existing && !targetMatches(existing, action.target, tracks, trackRefs, actionIndex)) planError(actionIndex, 'validation', 'Effect does not belong to the supplied target.')
        if (existing && existing.processor.kind !== action.effectKind) planError(actionIndex, 'validation', 'Effect kind cannot change.')
        const id = existing?.id ?? placeholderId('effect', action.clientRef, actionIndex)
        const next = {
          id,
          target,
          instanceId: existing?.instanceId ?? `control:audio-effect:${action.clientRef ?? actionIndex}`,
          index: existing?.index ?? snapshot.processors.filter((entry) => same(entry.target, target)).length,
          processor: {
            kind: action.effectKind,
            params: normalizeAudioEffectParamsForUpdate(
              action.effectKind,
              action.params ?? existing?.processor.params ?? {},
              existing?.processor.params,
            ),
          },
        }
        changed = !existing || !same(existing, next)
        if (existing) Object.assign(existing, next)
        else {
          processors.set(id, next)
          snapshot.processors.push(next)
        }
        if (action.clientRef) {
          effectRefs.set(action.clientRef, id)
          resolvedRefs.push({ entity: 'effect', clientRef: action.clientRef, id, persisted: false })
        }
        break
      }
      case 'effect.remove': {
        const effect = requireEffect(action.effect, processors, effectRefs, actionIndex)
        if (!targetMatches(effect, action.target, tracks, trackRefs, actionIndex) || effect.processor.kind !== action.effectKind) planError(actionIndex, 'validation', 'Effect does not match the supplied target and kind.')
        processors.delete(effect.id)
        snapshot.processors = snapshot.processors.filter((entry) => entry.id !== effect.id)
        const removedTarget = effect.target
        snapshot.automation = snapshot.automation.filter((entry) => (
          entry.effectInstanceId !== effect.instanceId || !same(entry.target, removedTarget)
        ))
        snapshot.sidechains = snapshot.sidechains.filter((entry) => (
          entry.effectInstanceId !== effect.instanceId
          || !('trackId' in removedTarget && entry.targetTrackId === removedTarget.trackId)
        ))
        const remaining = snapshot.processors
          .filter((entry) => same(entry.target, removedTarget) && isAudioEffectKind(entry.processor.kind))
          .sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
        remaining.forEach((entry, index) => { entry.index = index })
        changed = true
        break
      }
      case 'external-plugin.parameters.set': {
        const target = resolveTarget(action.target, actionIndex)
        const processor = requireEffect(action.processor, processors, effectRefs, actionIndex)
        if (processor.processor.kind !== 'external-vst3') {
          planError(actionIndex, 'validation', 'Processor is not an external VST3 processor.')
        }
        if (processor.instanceId === undefined) {
          planError(actionIndex, 'validation', 'External VST3 processor requires an instance ID.')
        }
        if (!same(processor.target, target)) {
          planError(actionIndex, 'validation', 'External VST3 processor does not match the supplied target.')
        }
        const parameters = new Map<number, { id: number; readOnly: boolean }>(
          processor.processor.params.parameters.map((parameter: { id: number; readOnly: boolean }) => [parameter.id, parameter]),
        )
        const overrides = { ...processor.processor.params.parameterOverrides }
        for (const change of action.changes) {
          const parameter = parameters.get(change.parameterId)
            ?? planError(actionIndex, 'not-found', `External VST3 parameter "${change.parameterId}" was not found.`)
          if (parameter.readOnly) {
            planError(actionIndex, 'validation', `External VST3 parameter "${change.parameterId}" is read-only.`)
          }
          const key = String(change.parameterId)
          changed = changed || overrides[key] !== change.normalizedValue
          overrides[key] = change.normalizedValue
        }
        processor.processor.params.parameterOverrides = overrides
        break
      }
      case 'effect.reorder': {
        resolveTarget(action.target, actionIndex)
        const ordered = action.order.map((item: any) => {
          const effect = requireEffect(item.effect, processors, effectRefs, actionIndex)
          if (!targetMatches(effect, action.target, tracks, trackRefs, actionIndex) || effect.processor.kind !== item.kind) planError(actionIndex, 'validation', 'Effect reorder includes an incompatible effect.')
          return effect
        })
        if (new Set(ordered.map((effect: any) => effect.id)).size !== ordered.length) planError(actionIndex, 'validation', 'Effect reorder contains duplicate effects.')
        const targetEffects = Array.from(processors.values()).filter((effect) => (
          isAudioEffectKind(effect.processor.kind)
          && targetMatches(effect, action.target, tracks, trackRefs, actionIndex)
        ))
        if (
          ordered.length !== targetEffects.length
          || ordered.some((effect: any) => !targetEffects.some((targetEffect) => targetEffect.id === effect.id))
        ) {
          planError(actionIndex, 'validation', 'Effect reorder must include every audio effect on its target exactly once.')
        }
        changed = ordered.some((effect: any, index: number) => effect.index !== index)
        ordered.forEach((effect: any, index: number) => { effect.index = index })
        break
      }
      case 'instrument.set':
      case 'arpeggiator.set': {
        const track = requireTrack(action.target.track, tracks, trackRefs, actionIndex)
        if (track.kind !== 'instrument') planError(actionIndex, 'validation', 'Instruments and arpeggiators require an instrument track.')
        const processorKind = action.kind === 'instrument.set' ? 'instrument' : 'arpeggiator'
        const existingRows = Array.from(processors.values()).filter((entry) => (
          'trackId' in entry.target
          && entry.target.trackId === track.id
          && entry.processor.kind === processorKind
        ))
        const existing = existingRows[0]
        const existingInstrument = action.kind === 'instrument.set'
          ? normalizeTrackInstrumentParams(existing?.processor.params)
          : undefined
        const generatedInstrumentInstanceId = action.kind === 'instrument.set' && !existingInstrument
          ? `control:instrument:${actionIndex}`
          : undefined
        const processor = action.kind === 'instrument.set'
          ? {
              kind: 'instrument',
              params: normalizeTrackInstrumentParams({
                kind: action.instrumentKind,
                instanceId: existingInstrument?.instanceId ?? `control:instrument:${actionIndex}`,
                params: action.params ?? (existingInstrument && existingInstrument.kind === action.instrumentKind ? existingInstrument.params : {}),
              }) ?? planError(actionIndex, 'validation', 'Invalid instrument parameters.'),
            }
          : { kind: 'arpeggiator', params: normalizeArpeggiatorParams(action.params) }
        const next = {
          id: existing?.id ?? placeholderId('effect', undefined, actionIndex),
          target: { trackId: track.id },
          instanceId: action.kind === 'instrument.set' ? existingInstrument?.instanceId ?? generatedInstrumentInstanceId : undefined,
          index: existing?.index ?? snapshot.processors.filter((processor) => 'trackId' in processor.target && processor.target.trackId === track.id).length,
          processor,
        }
        changed = existingRows.length !== 1 || !existing || !same(existing.processor, next.processor)
        if (existing) Object.assign(existing, next)
        else {
          processors.set(next.id, next)
          snapshot.processors.push(next)
        }
        if (existingRows.length > 1) {
          const duplicateIds = new Set(existingRows.slice(1).map((entry) => entry.id))
          for (const id of duplicateIds) processors.delete(id)
          snapshot.processors = snapshot.processors.filter((entry) => !duplicateIds.has(entry.id))
          compactTrackProcessorIndexes(snapshot.processors, track.id)
        }
        planned.push({ actionIndex, action, changed, generatedInstrumentInstanceId })
        traceAction(actionIndex, action, changed, beforeAction)
        continue
      }
      case 'instrument.remove':
      case 'arpeggiator.remove': {
        const track = requireTrack(action.target.track, tracks, trackRefs, actionIndex)
        const kind = action.kind === 'instrument.remove' ? 'instrument' : 'arpeggiator'
        const existing = Array.from(processors.values()).filter((entry) => (
          'trackId' in entry.target
          && entry.target.trackId === track.id
          && (entry.processor.kind === kind || kind === 'instrument' && entry.processor.kind === 'synth')
        ))
        if (existing.length === 0) {
          changed = false
          break
        }
        const existingIds = new Set(existing.map((entry) => entry.id))
        for (const entry of existing) processors.delete(entry.id)
        snapshot.processors = snapshot.processors.filter((entry) => !existingIds.has(entry.id))
        const instrumentIds = new Set(existing.flatMap((entry) => (
          kind === 'instrument'
            ? [normalizeTrackInstrumentParams(entry.processor.params)?.instanceId]
            : []
        )).filter((instanceId): instanceId is string => instanceId !== undefined))
        snapshot.automation = snapshot.automation.filter((entry) => (
          !('trackId' in entry.target && entry.target.trackId === track.id)
          || instrumentIds.size === 0
          || !(
            instrumentIds.has(parseInstrumentAutomationKey(entry.parameterId)?.instanceId ?? '')
            || instrumentIds.has(parseGranularAutomationKey(entry.parameterId)?.instanceId ?? '')
            || instrumentIds.has(parseSynthAutomationKey(entry.parameterId)?.instanceId ?? '')
          )
        ))
        snapshot.processors
          .filter((entry) => 'trackId' in entry.target && entry.target.trackId === track.id)
          .sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
          .forEach((entry, index) => { entry.index = index })
        changed = true
        break
      }
      case 'automation.set': {
        const target = resolveTarget(action.target, actionIndex)
        const effect = action.effect === undefined ? undefined : requireEffect(action.effect, processors, effectRefs, actionIndex)
        if (effect && !targetMatches(effect, action.target, tracks, trackRefs, actionIndex)) planError(actionIndex, 'validation', 'Automation effect does not belong to its target.')
        const descriptor = validateAutomationTarget(action, target, effect, processors, actionIndex)
        const effectInstanceId = effect?.instanceId
        if (action.effect && !effectInstanceId) planError(actionIndex, 'validation', 'Automation requires an effect with an instance ID.')
        const points = normalizeAutomationPoints(action.points, descriptor)
        const current = snapshot.automation.find((entry) => same(entry.target, target) && entry.effectInstanceId === effectInstanceId && entry.parameterId === action.parameterId)
        const next = { target, effectInstanceId, parameterId: action.parameterId, enabled: action.enabled, points }
        changed = !current || !same(current, next)
        if (current) Object.assign(current, next)
        else snapshot.automation.push(next)
        break
      }
      case 'automation.delete': {
        const target = resolveTarget(action.target, actionIndex)
        const effect = action.effect === undefined ? undefined : requireEffect(action.effect, processors, effectRefs, actionIndex)
        if (effect && !targetMatches(effect, action.target, tracks, trackRefs, actionIndex)) planError(actionIndex, 'validation', 'Automation effect does not belong to its target.')
        validateAutomationTarget(action, target, effect, processors, actionIndex)
        const index = snapshot.automation.findIndex((entry) => same(entry.target, target) && entry.effectInstanceId === effect?.instanceId && entry.parameterId === action.parameterId)
        if (index < 0) planError(actionIndex, 'not-found', 'Automation envelope was not found.')
        snapshot.automation.splice(index, 1)
        changed = true
        break
      }
      case 'sidechain.set': {
        const source = requireTrack(action.source, tracks, trackRefs, actionIndex)
        const target = requireTrack(action.target, tracks, trackRefs, actionIndex)
        const effect = requireEffect(action.effect, processors, effectRefs, actionIndex)
        const effectInstanceId = effect.instanceId
        const eligibility = sidechainEligibilityError({
          sourceTrackId: source.id,
          targetTrackId: target.id,
          effectTargetTrackId: 'trackId' in effect.target ? effect.target.trackId : undefined,
          effectKind: effect.processor.kind,
          effectInstanceId,
        })
        if (eligibility) planError(actionIndex, 'validation', eligibility)
        const next = { sourceTrackId: source.id, targetTrackId: target.id, effectInstanceId: effectInstanceId ?? planError(actionIndex, 'validation', 'Sidechain effect requires an instance ID.') }
        const current = snapshot.sidechains.find((entry) => entry.targetTrackId === next.targetTrackId && entry.effectInstanceId === next.effectInstanceId)
        changed = !current || !same(current, next)
        if (current) Object.assign(current, next)
        else snapshot.sidechains.push(next)
        break
      }
      case 'sidechain.remove': {
        const target = requireTrack(action.target, tracks, trackRefs, actionIndex)
        const effect = requireEffect(action.effect, processors, effectRefs, actionIndex)
        const effectInstanceId = effect.instanceId ?? planError(actionIndex, 'validation', 'Sidechain effect requires an instance ID.')
        const eligibility = sidechainTargetEligibilityError({
          targetTrackId: target.id,
          effectTargetTrackId: 'trackId' in effect.target ? effect.target.trackId : undefined,
          effectKind: effect.processor.kind,
          effectInstanceId,
        })
        if (eligibility) planError(actionIndex, 'validation', eligibility)
        const index = snapshot.sidechains.findIndex((entry) => entry.targetTrackId === target.id && entry.effectInstanceId === effectInstanceId)
        if (index < 0) planError(actionIndex, 'not-found', 'Sidechain route was not found.')
        snapshot.sidechains.splice(index, 1)
        changed = true
        break
      }
      case 'recovery.restore': {
        const recovery = trustedRecoveries.get(action.recovery.id)
        if (!recovery) planError(actionIndex, 'not-found', 'Recovery is unavailable.')
        const availableRecovery = recovery ?? planError(actionIndex, 'not-found', 'Recovery is unavailable.')
        if (availableRecovery.payload.kind === 'timeline.range.delete') {
          const data = availableRecovery.payload.data
          const selectedTrackIds = new Set(data.range.trackIds)
          for (const trackId of selectedTrackIds) {
            if (!tracks.has(trackId)) planError(actionIndex, 'not-found', 'Recovery target track is unavailable.')
          }
          for (const deletion of data.deletedClips) {
            if (clips.has(deletion.id)) planError(actionIndex, 'validation', 'Recovery clip collides with current state.')
          }
          for (const update of data.updatedClips) {
            const current = clips.get(update.id)
            if (!current || timelineRangeClipDigest(current) !== update.expectedAfterDigest) {
              planError(actionIndex, 'validation', 'Recovery state has drifted.')
            }
          }
          const createdClipIds = new Set<string>()
          for (const creation of data.createdClips) {
            const current = clips.get(creation.id)
            if (!current || !selectedTrackIds.has(current.trackId) || timelineRangeClipDigest(current) !== creation.expectedAfterDigest) {
              planError(actionIndex, 'validation', 'Recovery state has drifted.')
            }
            createdClipIds.add(creation.id)
          }
          for (const update of data.automation) {
            const current = snapshot.automation.find((automation) => (
              ("master" in automation.target ? "master" : "track") === update.before.targetKind
              && String("trackId" in automation.target ? automation.target.trackId : "") === String(update.before.trackId ?? "")
              && automation.effectInstanceId === update.before.effectInstanceId
              && automation.parameterId === update.before.parameterId
            ))
            if (!current || timelineRangeAutomationDigest(current) !== update.expectedAfterDigest) {
              planError(actionIndex, 'validation', 'Recovery state has drifted.')
            }
          }
          for (const clipId of createdClipIds) clips.delete(clipId)
          snapshot.clips = snapshot.clips.filter((clip) => !createdClipIds.has(clip.id))
          for (const update of data.updatedClips) {
            const restored = recoveredClip(update.id, update.before, update.before.trackId, assets, actionIndex)
            clips.set(update.id, restored)
            const index = snapshot.clips.findIndex((clip) => clip.id === update.id)
            if (index < 0) throw new Error('Range recovery clip is unavailable.')
            snapshot.clips[index] = restored
          }
          for (const deletion of data.deletedClips) {
            const id = `recovery:clip:${action.recovery.id}:${deletion.id}`
            const restored = recoveredClip(id, deletion.before, deletion.before.trackId, assets, actionIndex)
            clips.set(id, restored)
            snapshot.clips.push(restored)
          }
          for (const update of data.automation) {
            const index = snapshot.automation.findIndex((automation) => (
              ("master" in automation.target ? "master" : "track") === update.before.targetKind
              && String("trackId" in automation.target ? automation.target.trackId : "") === String(update.before.trackId ?? "")
              && automation.effectInstanceId === update.before.effectInstanceId
              && automation.parameterId === update.before.parameterId
            ))
            if (index < 0) throw new Error('Range recovery automation is unavailable.')
            snapshot.automation[index] = update.before
          }
        } else if (availableRecovery.payload.kind === 'track.delete' || availableRecovery.payload.kind === 'track.ungroup') {
          const data = availableRecovery.payload.data
          const restoreTracks = data.tracks
          const restoredIds = new Map(restoreTracks.map((entry: any) => [entry.id, `recovery:track:${action.recovery.id}:${entry.id}`]))
          const survivorStates = availableRecovery.payload.kind === 'track.delete'
            ? availableRecovery.payload.data.survivors
            : availableRecovery.payload.data.children
          for (const entry of restoreTracks) {
            if (tracks.has(entry.id)) planError(actionIndex, 'validation', 'Recovery track collides with current state.')
          }
          for (const survivor of survivorStates) {
            const current = tracks.get(survivor.id)
            if (!current || !same(recoverySurvivorState(current), recoverySurvivorState(survivor.after))) {
              planError(actionIndex, 'validation', 'Recovery state has drifted.')
            }
          }
          const restoredSourceIds = new Set(restoreTracks.map((entry: any) => entry.id))
          const validateRoutingTargets = (state: any) => {
            const requireTarget = (targetId: string | undefined, message: string, groupOnly = false) => {
              if (!targetId || restoredSourceIds.has(targetId)) return
              const target = tracks.get(targetId) ?? planError(actionIndex, 'not-found', message)
              if (groupOnly && target.channelRole !== 'group') planError(actionIndex, 'validation', 'Recovery group target must be a group track.')
            }
            requireTarget(state.groupId, 'Recovery group target is unavailable.', true)
            requireTarget(state.mixer.outputTargetId, 'Recovery output target is unavailable.')
            for (const send of state.mixer.sends) requireTarget(send.targetId, 'Recovery routing target is unavailable.')
          }
          for (const entry of restoreTracks) validateRoutingTargets(entry.track)
          for (const survivor of survivorStates) validateRoutingTargets(survivor.before)
          for (const survivor of survivorStates) {
            const current = tracks.get(survivor.id)
            if (!current) planError(actionIndex, 'not-found', 'Recovery target track is unavailable.')
            const { index: _index, ...before } = recoverySurvivorState(survivor.before)
            Object.assign(current, {
              ...before,
              groupId: restoredIds.get(survivor.before.groupId) ?? survivor.before.groupId,
              outputTargetId: restoredIds.get(survivor.before.mixer.outputTargetId) ?? survivor.before.mixer.outputTargetId,
              sends: survivor.before.mixer.sends.map((send: any) => ({
                targetTrackId: restoredIds.get(send.targetId) ?? send.targetId,
                amount: send.amount,
                tap: send.tap,
              })),
            })
          }
          for (const entry of restoreTracks) {
            const track = entry.track
            const id = restoredIds.get(entry.id)
            if (!id) throw new Error('Recovery track mapping is unavailable.')
            const restored = {
              id, name: track.name, index: track.index, kind: track.kind,
              channelRole: track.mixer.channelRole,
              groupId: restoredIds.get(track.groupId) ?? track.groupId,
              collapsed: track.collapsed,
              color: track.color,
              volume: track.mixer.volume, muted: Boolean(track.mixer.muted), soloed: Boolean(track.mixer.soloed),
              outputTargetId: restoredIds.get(track.mixer.outputTargetId) ?? track.mixer.outputTargetId,
              sends: track.mixer.sends.map((send: any) => ({
                targetTrackId: restoredIds.get(send.targetId) ?? send.targetId,
                amount: send.amount,
                tap: send.tap,
              })),
            }
            tracks.set(id, restored)
            snapshot.tracks.push(restored)
          }
          const restoredPlannerIds = new Set(restoredIds.values())
          const mergedOrder = mergeRecoveryTrackOrderV1(
            Array.from(tracks.values())
              .filter((track) => !restoredPlannerIds.has(track.id))
              .map((track) => ({ id: track.id, index: track.index })),
            restoreTracks.map((entry: any) => ({
              id: restoredIds.get(entry.id) ?? planError(actionIndex, 'validation', 'Recovery track mapping is unavailable.'),
              index: entry.track.index,
            })),
          )
          for (const entry of mergedOrder) {
            const track = tracks.get(entry.id)
            if (track) track.index = entry.index
          }
          for (const item of data.clips) {
            const trackId = restoredIds.get(item.clip.trackId)
            if (!trackId) planError(actionIndex, 'validation', 'Recovery clip target is unavailable.')
            const id = `recovery:clip:${action.recovery.id}:${item.id}`
            const clip = recoveredClip(id, item.clip, String(trackId), assets, actionIndex)
            clips.set(id, clip)
            snapshot.clips.push(clip)
          }
          for (const item of data.effects) {
            const effect = item.effect
            const trackId = effect.target.kind === 'track' ? restoredIds.get(effect.target.trackId) : undefined
            if (effect.target.kind === 'track' && !trackId) planError(actionIndex, 'validation', 'Recovery processor target is unavailable.')
            const target = effect.target.kind === 'master' ? { master: true } : { trackId }
            const singleton = effect.processor.kind === 'instrument' || effect.processor.kind === 'synth' || effect.processor.kind === 'arpeggiator'
            if (Array.from(processors.values()).some((processor) => (
              same(processor.target, target)
              && (
                singleton
                  ? processor.processor.kind === effect.processor.kind || effect.processor.kind === 'instrument' && processor.processor.kind === 'synth'
                  : effect.instanceId !== undefined && processor.instanceId === effect.instanceId
              )
            ))) {
              planError(actionIndex, 'validation', 'Recovery processor collides with current state.')
            }
            const id = `recovery:effect:${action.recovery.id}:${item.id}`
            const processor = { id, target, index: effect.index, instanceId: effect.instanceId, processor: effect.processor }
            processors.set(id, processor)
            snapshot.processors.push(processor)
          }
          for (const item of data.automation) {
            const row = item.automation
            const restoredTrackId = row.trackId === undefined ? undefined : restoredIds.get(row.trackId)
            const trackId = restoredTrackId === undefined ? undefined : String(restoredTrackId)
            if (row.trackId !== undefined && !trackId) planError(actionIndex, 'validation', 'Recovery automation target is unavailable.')
            const target = row.targetKind === 'master' ? { master: true } : { trackId }
            snapshot.automation.push({
              target,
              effectInstanceId: row.effectInstanceId,
              parameterId: rebaseRecoveryAutomationParameterIdV1(row.parameterId, trackId),
              enabled: row.enabled,
              points: row.points,
            })
          }
          for (const item of data.sidechains) {
            const route = item.sidechain
            const sourceTrackId = restoredIds.get(route.sourceTrackId) ?? route.sourceTrackId
            const targetTrackId = restoredIds.get(route.targetTrackId) ?? route.targetTrackId
            if (!tracks.has(sourceTrackId) || !tracks.has(targetTrackId)) planError(actionIndex, 'not-found', 'Recovery sidechain target is unavailable.')
            const targetEffect = Array.from(processors.values()).find((processor) => (
              'trackId' in processor.target
              && processor.target.trackId === targetTrackId
              && processor.instanceId === route.effectInstanceId
            ))
            const eligibility = sidechainEligibilityError({
              sourceTrackId,
              targetTrackId,
              effectTargetTrackId: targetEffect && 'trackId' in targetEffect.target ? targetEffect.target.trackId : undefined,
              effectKind: targetEffect?.processor.kind ?? '',
              effectInstanceId: targetEffect?.instanceId,
            })
            if (eligibility) planError(actionIndex, 'validation', eligibility)
            if (snapshot.sidechains.some((entry) => entry.targetTrackId === targetTrackId && entry.effectInstanceId === route.effectInstanceId)) {
              planError(actionIndex, 'validation', 'Recovery sidechain target collides with current state.')
            }
            snapshot.sidechains.push({ sourceTrackId, targetTrackId, effectInstanceId: route.effectInstanceId })
          }
          if (!hasValidReturnTrackPartition(Array.from(tracks.values()))) planError(actionIndex, 'validation', 'Return tracks must remain an ungrouped suffix.')
        } else if (availableRecovery.payload.kind === 'clip.delete') {
          const data = availableRecovery.payload.data
          const track = tracks.get(String(data.clip.trackId))
          if (!track) planError(actionIndex, 'not-found', 'Recovery target track is unavailable.')
          if (clips.has(String(data.clipId))) planError(actionIndex, 'validation', 'Recovery clip collides with current state.')
          const id = `recovery:clip:${action.recovery.id}`
          const clip = recoveredClip(id, data.clip, data.clip.trackId, assets, actionIndex)
          clips.set(id, clip)
          snapshot.clips.push(clip)
        } else if (availableRecovery.payload.kind === 'asset.delete') {
          const data = availableRecovery.payload.data
          const id = String(data.asset.assetKey)
          if (assets.has(id)) planError(actionIndex, 'validation', 'Recovery asset key collides with current state.')
          restoredAssetIds.add(id)
          assets.set(id, {
            id,
            name: String(data.asset.name),
            sourceKind: data.asset.sourceKind,
            mimeType: data.asset.mimeType,
            sizeBytes: Number(data.asset.sizeBytes),
            contentSha256: data.asset.contentSha256,
            durationSec: data.asset.duration === undefined ? undefined : Number(data.asset.duration),
            sampleRate: data.asset.sampleRate === undefined ? undefined : Number(data.asset.sampleRate),
            channelCount: data.asset.channelCount === undefined ? undefined : Number(data.asset.channelCount),
            folderId: data.asset.folderId === undefined ? undefined : String(data.asset.folderId),
            createdAt: Number(data.asset.createdAt),
            updatedAt: Number(data.asset.updatedAt),
          })
          snapshot.assets = Array.from(assets.values())
        } else if (availableRecovery.payload.kind === 'automation.delete') {
          const data = availableRecovery.payload.data
          const row = data.automation
          if (row.targetKind === 'track' && !tracks.has(String(row.trackId))) planError(actionIndex, 'not-found', 'Recovery target track is unavailable.')
          const target = row.targetKind === 'master' ? { master: true } : { trackId: String(row.trackId) }
          const effect = row.effectInstanceId === undefined ? undefined : Array.from(processors.values()).find((entry) => (
            same(entry.target, target) && entry.instanceId === row.effectInstanceId
          ))
          validateAutomationTarget({ parameterId: row.parameterId }, target, effect, processors, actionIndex)
          if (snapshot.automation.some((entry) => same(entry.target, target) && entry.effectInstanceId === row.effectInstanceId && entry.parameterId === row.parameterId)) {
            planError(actionIndex, 'validation', 'Recovery automation target collides with current state.')
          }
          snapshot.automation.push({ target, effectInstanceId: row.effectInstanceId === undefined ? undefined : String(row.effectInstanceId), parameterId: String(row.parameterId), enabled: Boolean(row.enabled), points: row.points })
        } else if (availableRecovery.payload.kind === 'sidechain.remove') {
          const data = availableRecovery.payload.data
          const row = data.sidechain
          if (!tracks.has(String(row.sourceTrackId)) || !tracks.has(String(row.targetTrackId))) planError(actionIndex, 'not-found', 'Recovery sidechain track is unavailable.')
          if (!Array.from(processors.values()).some((entry) => 'trackId' in entry.target && entry.target.trackId === String(row.targetTrackId) && entry.instanceId === row.effectInstanceId)) {
            planError(actionIndex, 'not-found', 'Recovery sidechain effect is unavailable.')
          }
          if (snapshot.sidechains.some((entry) => entry.targetTrackId === String(row.targetTrackId) && entry.effectInstanceId === row.effectInstanceId)) {
            planError(actionIndex, 'validation', 'Recovery sidechain target collides with current state.')
          }
          snapshot.sidechains.push({ sourceTrackId: String(row.sourceTrackId), targetTrackId: String(row.targetTrackId), effectInstanceId: String(row.effectInstanceId) })
        } else {
          const data = availableRecovery.payload.data
          for (const item of data.effects) {
            const row = item.effect
            const target = row.target.kind === 'master' ? { master: true } : { trackId: row.target.trackId }
            if ('trackId' in target && !tracks.has(target.trackId)) planError(actionIndex, 'not-found', 'Recovery target track is unavailable.')
            const instrument = normalizePersistedInstrumentParams(
              row.processor.kind,
              row.instanceId ?? null,
              row.processor.params,
            )
            const type = row.processor.kind === 'synth' ? 'instrument' : row.processor.kind
            const singleton = type === 'instrument' || type === 'arpeggiator'
            const collision = Array.from(processors.values()).some((entry) => (
              same(entry.target, target)
              && (
                singleton
                  ? entry.processor.kind === type
                  : entry.processor.kind === type && entry.instanceId === row.instanceId
              )
            ))
            if (collision) planError(actionIndex, 'validation', 'Recovery processor collides with current state.')
            const index = row.index
            for (const entry of processors.values()) {
              if (same(entry.target, target) && entry.index >= index) entry.index += 1
            }
            const id = `recovery:effect:${action.recovery.id}:${item.id}`
            const processor = {
              id,
              target,
              instanceId: row.instanceId,
              index,
              processor: {
                kind: type,
                params: instrument ?? row.processor.params,
              },
            }
            processors.set(id, processor)
            snapshot.processors.push(processor)
          }
          for (const item of data.automation) {
            const row = item.automation
            const target = row.targetKind === 'master' ? { master: true } : { trackId: row.trackId }
            if ('trackId' in target && !tracks.has(target.trackId)) planError(actionIndex, 'not-found', 'Recovery target track is unavailable.')
            const effect = row.effectInstanceId === undefined ? undefined : Array.from(processors.values()).find((entry) => (
              same(entry.target, target) && entry.instanceId === row.effectInstanceId
            ))
            validateAutomationTarget({ parameterId: row.parameterId }, target, effect, processors, actionIndex)
            if (snapshot.automation.some((entry) => same(entry.target, target) && entry.effectInstanceId === row.effectInstanceId && entry.parameterId === row.parameterId)) {
              planError(actionIndex, 'validation', 'Recovery automation target collides with current state.')
            }
            snapshot.automation.push({ target, effectInstanceId: row.effectInstanceId === undefined ? undefined : String(row.effectInstanceId), parameterId: String(row.parameterId), enabled: Boolean(row.enabled), points: row.points })
          }
          for (const item of data.sidechains) {
            const row = item.sidechain
            if (!tracks.has(row.sourceTrackId) || !tracks.has(row.targetTrackId)) planError(actionIndex, 'not-found', 'Recovery sidechain track is unavailable.')
            if (snapshot.sidechains.some((entry) => entry.targetTrackId === row.targetTrackId && entry.effectInstanceId === row.effectInstanceId)) {
              planError(actionIndex, 'validation', 'Recovery sidechain target collides with current state.')
            }
            snapshot.sidechains.push({ sourceTrackId: row.sourceTrackId, targetTrackId: row.targetTrackId, effectInstanceId: row.effectInstanceId })
          }
        }
        changed = true
        break
      }
    }
    const destructivePersisted = beforeAction === undefined
      ? false
      : destructiveKinds.has(action.kind) && (
        hasPersistedDestructiveEffect(base, beforeAction, snapshot)
        || action.kind === 'asset.delete' && restoredAssetIds.has(action.asset.id)
      )
    planned.push({ actionIndex, action, changed, destructivePersisted: destructivePersisted ? destructivePersisted : undefined })
    traceAction(actionIndex, action, changed, beforeAction)
  }

  snapshot.tracks.sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
  snapshot.clips.sort((left, right) => left.startSec - right.startSec || (left.id < right.id ? -1 : 1))
  snapshot.processors.sort((left, right) => left.index - right.index || (left.id < right.id ? -1 : 1))
  const applied = planned.some((entry) => entry.changed)
  return {
    baseSnapshot: base,
    snapshot,
    actions: planned,
    applied,
    priorRevision: base.project.revision,
    revision: base.project.revision + (applied ? 1 : 0),
    resolvedRefs,
    warnings: [],
    changeSummary: {
      actionCount: request.actions.length,
      changes: planned.filter((entry) => entry.changed).map((entry) => ({
        actionIndex: entry.actionIndex,
        kind: entry.action.kind,
        description: describe(entry.action),
      })),
    },
  }
}
