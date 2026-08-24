import {
  canonicalCapturedRecoveryPayloadV2,
  hashCanonicalJsonSyncV1,
  hashRecoveryPayloadSyncV1,
  recoveryCapturedPayloadSchemaV2,
  timelineRangeRecoveryAutomationDigestV2,
  timelineRangeRecoveryClipDigestV2,
  timelineRangeRecoveryOwnershipDigestV2,
  type ControlActionV1,
  type ProjectSnapshotV2,
  type CapturedRecoveryPayloadV2,
} from '@daw-browser/control'
import {
  buildTimelineRangeDeletePatchV1,
  collectDeletedTrackIdsV1,
} from '@daw-browser/control-core'
import {
  automationTargetKey,
  isJsonObject,
  isJsonString,
  parseGranularAutomationKey,
  parseInstrumentAutomationKey,
  parseSynthAutomationKey,
} from '@daw-browser/shared'
import { z } from 'zod'
import type {
  LocalProjectAssetRow,
  LocalProjectEntityRow,
  LocalProjectExternalPluginArtifactRow,
  LocalExternalProcessorRecoveryBundle,
} from '~/lib/local-project-db'
import {
  externalPluginEntityKind,
  externalProcessorSchema,
  parseExternalProcessorValue,
  type ExternalProcessor,
} from '@daw-browser/external-plugins'
import { parseExternalPluginJsonValue } from '~/lib/external-plugin-json'
import { pathFreeExternalProcessor } from '~/lib/external-plugins'
import {
  localVstStateArtifactLocation,
  validateLocalVstStateBytes,
} from '~/lib/external-plugin-artifacts'
import { maxVst3WorkerStateBytes, opaquePluginStateMetadataSchema } from '@daw-browser/plugin-host-protocol'
import { localSidechainRouteRowId } from '~/lib/local-effects'

export const localRecoveryLifetimeMs = 7 * 24 * 60 * 60 * 1000
export const maxLocalRecoveryExternalArtifactCount = 16
export const maxLocalRecoveryExternalArtifactBytes = 2 * maxVst3WorkerStateBytes
export const maxLocalProjectExternalRecoveryBytes = 16 * maxVst3WorkerStateBytes
const jsonValueSchema = z.json()

export const collectLocalDeletedTrackIds = (
  tracks: readonly ProjectSnapshotV2['tracks'][number][],
  rootTrackId: string,
) => collectDeletedTrackIdsV1(
  tracks.map((track) => ({
    id: track.id,
    index: track.index,
    groupId: track.groupId,
    outputTargetId: track.outputTargetId,
    sends: track.sends.map((send) => ({ targetTrackId: send.targetTrackId })),
  })),
  rootTrackId,
)

const externalProcessorStateMetadata = (processor: ExternalProcessor) => [
  processor.state,
  processor.launchReference?.state,
].filter((metadata) => metadata !== undefined)

const externalRecoveryHashValue = (bundles: readonly LocalExternalProcessorRecoveryBundle[]) => (
  JSON.parse(JSON.stringify({
    version: 1,
    bundles: bundles.map((bundle) => ({
      version: bundle.version,
      entity: bundle.entity,
      artifacts: bundle.artifacts.map(({ payload: _payload, ...artifact }) => artifact),
    })),
  }))
)

export const hashLocalExternalProcessorRecoveryBundles = (
  bundles: readonly LocalExternalProcessorRecoveryBundle[],
) => hashCanonicalJsonSyncV1(externalRecoveryHashValue(bundles))

export const localExternalRecoveryUsage = (
  bundles: readonly LocalExternalProcessorRecoveryBundle[],
) => {
  const artifactCount = bundles.reduce((count, bundle) => count + bundle.artifacts.length, 0)
  const byteLength = bundles.reduce(
    (total, bundle) => total + bundle.artifacts.reduce((bytes, artifact) => bytes + artifact.byteLength, 0),
    0,
  )
  if (
    artifactCount > maxLocalRecoveryExternalArtifactCount
    || byteLength > maxLocalRecoveryExternalArtifactBytes
  ) throw new Error('Recovery external artifact limits exceeded.')
  return { artifactCount, byteLength }
}

export const validateLocalProjectExternalRecoveryBytes = (byteLength: number) => {
  if (byteLength > maxLocalProjectExternalRecoveryBytes) {
    throw new Error('Local project external recovery bytes exceeded.')
  }
}

const validateLocalExternalProcessorRecoveryArtifact = (
  artifact: LocalProjectExternalPluginArtifactRow,
): LocalProjectExternalPluginArtifactRow => {
  if (!(artifact.payload instanceof Uint8Array)) {
    throw new Error(`Local external processor recovery artifact "${artifact.id}" is invalid.`)
  }
  const metadata = opaquePluginStateMetadataSchema.parse({
    artifactId: artifact.id,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    artifactKind: artifact.kind,
    ownerId: artifact.ownerId,
    acl: artifact.acl,
    bucket: artifact.bucket,
    location: artifact.location,
  })
  if (
    metadata.artifactKind !== 'plugin-state'
    || metadata.bucket !== 'local'
    || metadata.location !== localVstStateArtifactLocation(metadata.artifactId)
    || metadata.byteLength > maxVst3WorkerStateBytes
  ) throw new Error(`Local external processor recovery artifact "${artifact.id}" metadata is invalid.`)
  const bytes = validateLocalVstStateBytes(artifact.payload, metadata.sha256)
  if (bytes.bytes.byteLength !== metadata.byteLength) {
    throw new Error(`Local external processor recovery artifact "${artifact.id}" length is invalid.`)
  }
  return { ...artifact, payload: bytes.bytes }
}

export const localRecoveryArtifactsMatch = (
  left: LocalProjectExternalPluginArtifactRow,
  right: LocalProjectExternalPluginArtifactRow,
) => {
  if (
    left.id !== right.id
    || left.sha256 !== right.sha256
    || left.byteLength !== right.byteLength
    || left.kind !== right.kind
    || left.ownerId !== right.ownerId
    || left.acl !== right.acl
    || left.bucket !== right.bucket
    || left.location !== right.location
    || !(left.payload instanceof Uint8Array)
    || !(right.payload instanceof Uint8Array)
    || left.payload.byteLength !== right.payload.byteLength
  ) return false
  const leftPayload = left.payload
  const rightPayload = right.payload
  return leftPayload.every((byte, index) => byte === rightPayload[index])
}

const validateLocalExternalProcessorRecoveryBundle = (
  bundle: LocalExternalProcessorRecoveryBundle,
  allArtifacts: ReadonlyMap<string, LocalProjectExternalPluginArtifactRow>,
): LocalExternalProcessorRecoveryBundle => {
  if (bundle.version !== 1) {
    throw new Error('Local external processor recovery bundle version is invalid.')
  }
  if (bundle.entity.kind !== externalPluginEntityKind) {
    throw new Error('Local external processor recovery entity kind is invalid.')
  }
  const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(bundle.entity.value))
  if (!parsed.success) throw new Error(`Local external processor recovery row "${bundle.entity.id}" is invalid.`)
  const processor = pathFreeExternalProcessor(externalProcessorSchema.parse(parsed.data))
  if (bundle.entity.id !== `external-plugin:${processor.instanceId}`) {
    throw new Error('Local external processor recovery entity identity is invalid.')
  }
  const artifacts = new Map<string, LocalProjectExternalPluginArtifactRow>()
  for (const artifact of bundle.artifacts) {
    if (artifacts.has(artifact.id)) {
      throw new Error(`Local external processor recovery artifact "${artifact.id}" is duplicated.`)
    }
    artifacts.set(artifact.id, validateLocalExternalProcessorRecoveryArtifact(artifact))
  }
  for (const metadata of externalProcessorStateMetadata(processor)) {
    if (metadata.bucket !== 'local') continue
    const artifact = artifacts.get(metadata.artifactId) ?? allArtifacts.get(metadata.artifactId)
    if (!artifact
      || artifact.sha256 !== metadata.sha256
      || artifact.byteLength !== metadata.byteLength
      || artifact.ownerId !== metadata.ownerId
      || artifact.kind !== metadata.artifactKind
      || artifact.acl !== metadata.acl
      || artifact.location !== metadata.location
    ) throw new Error(`Local external processor recovery artifact "${metadata.artifactId}" does not match its processor.`)
  }
  return {
    version: 1,
    entity: { ...bundle.entity, value: processor },
    artifacts: [...artifacts.values()],
  }
}

export const validateLocalExternalProcessorRecoveryBundles = (
  bundles: readonly LocalExternalProcessorRecoveryBundle[],
) => {
  const allArtifacts = new Map<string, LocalProjectExternalPluginArtifactRow>()
  for (const bundle of bundles) {
    for (const artifact of bundle.artifacts) {
      if (allArtifacts.has(artifact.id)) {
        throw new Error(`Local external processor recovery artifact "${artifact.id}" is duplicated.`)
      }
      allArtifacts.set(artifact.id, validateLocalExternalProcessorRecoveryArtifact(artifact))
    }
  }
  const validated = bundles.map((bundle) => validateLocalExternalProcessorRecoveryBundle(bundle, allArtifacts))
  const entityIds = new Set<string>()
  const artifactIds = new Set<string>()
  for (const bundle of validated) {
    if (entityIds.has(bundle.entity.id)) throw new Error('Local external processor recovery entities must be unique.')
    entityIds.add(bundle.entity.id)
    for (const artifact of bundle.artifacts) {
      if (artifactIds.has(artifact.id)) throw new Error('Local external processor recovery artifacts must be unique.')
      artifactIds.add(artifact.id)
    }
  }
  return validated
}

export const captureLocalExternalProcessorRecoveryBundles = (input: {
  action: Extract<ControlActionV1, { kind: 'track.delete' | 'track.ungroup' }>
  snapshot: ProjectSnapshotV2
  entities: readonly LocalProjectEntityRow[]
  artifacts: readonly LocalProjectExternalPluginArtifactRow[]
}) => {
  const rootId = input.action.kind === 'track.delete' ? input.action.track : input.action.group
  if (rootId.source !== 'persisted') return []
  const root = input.snapshot.tracks.find((track) => track.id === rootId.id)
  if (!root) return []
  const selected = input.action.kind === 'track.ungroup'
    ? new Set([root.id])
    : collectLocalDeletedTrackIds(input.snapshot.tracks, root.id)
  const entityById = new Map(input.entities
    .filter((row) => row.kind === externalPluginEntityKind)
    .map((row) => [row.id, row]))
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]))
  const capturedArtifactIds = new Set<string>()
  const bundles: LocalExternalProcessorRecoveryBundle[] = input.snapshot.processors.flatMap((entry) => {
    if (
      entry.processor.kind !== 'external-vst3'
      || !('trackId' in entry.target)
      || !selected.has(entry.target.trackId)
    ) return []
    const entity = entityById.get(entry.id)
    if (!entity) throw new Error(`Local external processor row "${entry.id}" is missing.`)
    const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(entity.value))
    if (!parsed.success) throw new Error(`Local external processor row "${entry.id}" is invalid.`)
    const artifacts = externalProcessorStateMetadata(pathFreeExternalProcessor(parsed.data)).flatMap((metadata) => {
      if (metadata.bucket !== 'local' || capturedArtifactIds.has(metadata.artifactId)) return []
      const artifact = artifactById.get(metadata.artifactId)
      if (!artifact) throw new Error(`Local external processor artifact "${metadata.artifactId}" is missing.`)
      capturedArtifactIds.add(metadata.artifactId)
      return [artifact]
    })
    return [{
      version: 1,
      entity: { ...entity, value: pathFreeExternalProcessor(parsed.data) },
      artifacts,
    }]
  })
  return validateLocalExternalProcessorRecoveryBundles(bundles)
}

const ownership = (projectId: string, localActorSubject: string) => ({ projectId, localActorSubject })
const recoveryAssetRow = (asset: Extract<CapturedRecoveryPayloadV2, { kind: 'asset.delete' }>['data']['asset']): LocalProjectAssetRow => {
  if (!('storagePath' in asset)) throw new Error('Cloud recovery assets cannot be restored locally.')
  return {
    id: asset.assetKey,
    name: asset.name,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    storagePath: asset.storagePath,
    sourceKind: asset.sourceKind,
    contentHash: asset.contentSha256,
    durationSec: asset.duration,
    sampleRate: asset.sampleRate,
    channelCount: asset.channelCount,
    folderId: asset.folderId,
    missing: asset.missing,
    originalFileName: asset.originalFileName,
    originalLastModified: asset.originalLastModified,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  }
}

export const resolveLocalRecoveryAssets = (
  snapshot: ProjectSnapshotV2,
  persistedAssets: readonly LocalProjectAssetRow[],
  recoveries: ReadonlyMap<string, { payload: CapturedRecoveryPayloadV2 }>,
) => {
  const assets = new Map(persistedAssets.map((asset) => [asset.id, asset]))
  for (const recovery of recoveries.values()) {
    if (recovery.payload.kind === 'asset.delete') {
      const asset = recoveryAssetRow(recovery.payload.data.asset)
      assets.set(asset.id, asset)
    }
  }
  return snapshot.assets.flatMap((asset) => {
    const metadata = assets.get(asset.id)
    return metadata === undefined ? [] : [metadata]
  })
}

const clipPayload = (
  projectId: string,
  clip: ProjectSnapshotV2['clips'][number],
  historyRef?: string,
) => ({
  projectId,
  trackId: clip.trackId,
  historyRef,
  startSec: clip.startSec,
  duration: clip.duration,
  sourceAssetKey: clip.source?.assetId,
  sourceKind: clip.source?.sourceKind,
  sourceDurationSec: clip.source?.durationSec,
  sourceSampleRate: clip.source?.sampleRate,
  sourceChannelCount: clip.source?.channelCount,
  leftPadSec: clip.leftPadSec,
  bufferOffsetSec: clip.bufferOffsetSec,
  audioWarp: clip.audioWarp,
  gain: clip.gain,
  fades: clip.fades,
  color: clip.color,
  name: clip.name,
  midi: clip.midi,
  midiOffsetBeats: clip.midiOffsetBeats,
})
const trackPayload = (projectId: string, track: ProjectSnapshotV2['tracks'][number], actorSubject: string) => ({
  id: track.id,
  track: {
    projectId,
    name: track.name,
    index: track.index,
    kind: track.kind,
    groupId: track.groupId,
    collapsed: track.collapsed,
    color: track.color,
    mixer: {
      volume: track.volume,
      muted: track.muted,
      soloed: track.soloed,
      channelRole: track.channelRole,
      outputTargetId: track.outputTargetId,
      sends: track.sends.map((send) => ({
        targetId: send.targetTrackId,
        amount: send.amount,
        tap: send.tap,
      })),
    },
  },
  ownership: ownership(projectId, actorSubject),
})
const effectPayload = (projectId: string, effect: ProjectSnapshotV2['processors'][number]) => ({
  id: effect.id,
  effect: {
    projectId,
    target: 'master' in effect.target ? { kind: 'master' as const } : { kind: 'track' as const, trackId: effect.target.trackId },
    index: effect.index,
    processor: effect.processor,
    instanceId: effect.instanceId,
    createdAt: 0,
  },
})
const automationPayload = (projectId: string, entry: ProjectSnapshotV2['automation'][number], id: string) => ({
  id,
  automation: {
    projectId,
    targetKind: 'master' in entry.target ? 'master' as const : 'track' as const,
    trackId: 'master' in entry.target ? undefined : entry.target.trackId,
    effectInstanceId: entry.effectInstanceId,
    targetKey: id,
    parameterId: entry.parameterId,
    enabled: entry.enabled,
    points: entry.points,
    updatedAt: 0,
  },
})
const sidechainPayload = (projectId: string, entry: ProjectSnapshotV2['sidechains'][number], id: string) => ({
  id,
  sidechain: {
    projectId,
    sourceTrackId: entry.sourceTrackId,
    targetTrackId: entry.targetTrackId,
    effectInstanceId: entry.effectInstanceId,
  },
})
const effectBundle = (
  projectId: string,
  snapshot: ProjectSnapshotV2,
  effects: readonly ProjectSnapshotV2['processors'][number][],
) => {
  const effectInstanceIds = new Set(effects.flatMap((effect) => effect.instanceId === undefined ? [] : [effect.instanceId]))
  const targets = new Set(effects.map((effect) => (
    'master' in effect.target ? 'master' : effect.target.trackId
  )))
  return {
    effects: effects.map((effect) => effectPayload(projectId, effect)),
    automation: snapshot.automation.flatMap((entry) => (
      effectInstanceIds.has(entry.effectInstanceId ?? '')
      && targets.has('master' in entry.target ? 'master' : entry.target.trackId)
        ? [automationPayload(projectId, entry, automationTargetKey(
          'master' in entry.target
            ? { kind: 'master', effectInstanceId: entry.effectInstanceId }
            : { kind: 'track', trackId: entry.target.trackId, effectInstanceId: entry.effectInstanceId },
          entry.parameterId,
        ))]
        : []
    )),
    sidechains: snapshot.sidechains.flatMap((entry) => (
      effectInstanceIds.has(entry.effectInstanceId)
        ? [sidechainPayload(projectId, entry, localSidechainRouteRowId(entry.targetTrackId, entry.effectInstanceId))]
        : []
    )),
  }
}

const instrumentAutomation = (
  projectId: string,
  snapshot: ProjectSnapshotV2,
  effects: readonly ProjectSnapshotV2['processors'][number][],
) => {
  const instanceIds = new Set(effects.flatMap((effect) => {
    const params = jsonValueSchema.safeParse(effect.processor.params)
    return params.success && isJsonObject(params.data) && isJsonString(params.data.instanceId)
      ? [params.data.instanceId]
      : []
  }))
  return snapshot.automation.flatMap((entry) => {
    const identity = parseInstrumentAutomationKey(entry.parameterId)
      ?? parseGranularAutomationKey(entry.parameterId)
      ?? parseSynthAutomationKey(entry.parameterId)
    return identity && instanceIds.has(identity.instanceId)
      ? [automationPayload(projectId, entry, automationTargetKey(
        'master' in entry.target
          ? { kind: 'master', effectInstanceId: entry.effectInstanceId }
          : { kind: 'track', trackId: entry.target.trackId, effectInstanceId: entry.effectInstanceId },
        entry.parameterId,
      ))]
      : []
  })
}
export const captureLocalRecoveryPayload = (input: {
  projectId: string
  actorSubject: string
  action: ControlActionV1
  actionIndex: number
  snapshot: ProjectSnapshotV2
  assets: readonly LocalProjectAssetRow[]
  materializedClipIds?: ReadonlyMap<string, string>
  clipHistoryRefs?: ReadonlyMap<string, string>
}): CapturedRecoveryPayloadV2 | undefined => {
  const { action, snapshot } = input
  let raw: Parameters<typeof recoveryCapturedPayloadSchemaV2.safeParse>[0]
  if (action.kind === 'timeline.range.delete') {
    const trackIds = action.tracks.flatMap((track) => (
      track.source === 'persisted' ? [track.id] : []
    ))
    if (trackIds.length !== action.tracks.length) return undefined
    const patch = buildTimelineRangeDeletePatchV1(
      snapshot,
      trackIds,
      action.startSec,
      action.endSec,
      input.actionIndex,
    )
    const clipById = new Map(snapshot.clips.map((clip) => [clip.id, clip]))
    raw = {
      version: 2,
      kind: action.kind,
      data: {
        range: { trackIds: patch.trackIds, startSec: action.startSec, endSec: action.endSec },
        deletedClips: patch.clipDeletes.map((entry) => ({
          id: entry.clipId,
          before: clipPayload(input.projectId, entry.before, input.clipHistoryRefs?.get(entry.before.id)),
          ownership: ownership(input.projectId, input.actorSubject),
        })),
        updatedClips: patch.clipUpdates.map((entry) => ({
          id: entry.clipId,
          before: clipPayload(
            input.projectId,
            clipById.get(entry.clipId) ?? entry.before,
            input.clipHistoryRefs?.get(entry.clipId),
          ),
          expectedAfterDigest: timelineRangeRecoveryClipDigestV2(entry.after),
        })),
        createdClips: patch.clipCreates.map((entry) => ({
          id: input.materializedClipIds?.get(entry.placeholderId) ?? entry.placeholderId,
          expectedAfterDigest: timelineRangeRecoveryClipDigestV2(entry.after),
          expectedOwnershipDigest: timelineRangeRecoveryOwnershipDigestV2(ownership(input.projectId, input.actorSubject)),
        })),
        automation: patch.automationUpdates.map((entry) => {
          const id = automationTargetKey(
            'master' in entry.before.target
              ? { kind: 'master', effectInstanceId: entry.before.effectInstanceId }
              : { kind: 'track', trackId: entry.before.target.trackId, effectInstanceId: entry.before.effectInstanceId },
            entry.before.parameterId,
          )
          return {
            id,
            before: automationPayload(input.projectId, entry.before, id).automation,
            expectedAfterDigest: timelineRangeRecoveryAutomationDigestV2(entry.after),
          }
        }),
      },
    }
  } else if (action.kind === 'clip.delete') {
    const clipRef = action.clip
    if (clipRef.source !== 'persisted') return undefined
    const clip = snapshot.clips.find((entry) => entry.id === clipRef.id)
    raw = clip ? {
      version: 2,
      kind: action.kind,
      data: {
        clip: clipPayload(input.projectId, clip, input.clipHistoryRefs?.get(clip.id)),
        clipId: clip.id,
        ownership: ownership(input.projectId, input.actorSubject),
      },
    } : undefined
  } else if (action.kind === 'asset.delete') {
    const asset = input.assets.find((entry) => entry.id === action.asset.id)
    raw = asset ? {
      version: 2,
      kind: action.kind,
      data: {
        asset: {
          projectId: input.projectId, assetKey: asset.id, sourceKind: asset.sourceKind,
          name: asset.name, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes,
          contentSha256: asset.contentHash, storagePath: asset.storagePath, duration: asset.durationSec,
          sampleRate: asset.sampleRate, channelCount: asset.channelCount, folderId: asset.folderId,
          missing: asset.missing, originalFileName: asset.originalFileName,
          originalLastModified: asset.originalLastModified, createdAt: asset.createdAt, updatedAt: asset.updatedAt,
        },
        assetId: asset.id,
      },
    } : undefined
  } else if (action.kind === 'automation.delete') {
    const target = action.target.kind === 'master'
      ? { master: true }
      : action.target.track.source === 'persisted' ? { trackId: action.target.track.id } : undefined
    const effectId = action.effect?.source === 'persisted' ? action.effect.id : undefined
    const effect = effectId === undefined ? undefined : snapshot.processors.find((entry) => entry.id === effectId)
    const entry = snapshot.automation.find((candidate) => (
      target !== undefined && JSON.stringify(candidate.target) === JSON.stringify(target)
      && candidate.effectInstanceId === effect?.instanceId
      && candidate.parameterId === action.parameterId
    ))
    raw = entry ? {
      version: 2,
      kind: action.kind,
      data: {
        automation: automationPayload(input.projectId, entry, automationTargetKey(
          'master' in entry.target
            ? { kind: 'master', effectInstanceId: entry.effectInstanceId }
            : { kind: 'track', trackId: entry.target.trackId, effectInstanceId: entry.effectInstanceId },
          entry.parameterId,
        )).automation,
        automationId: automationTargetKey(
          'master' in entry.target
            ? { kind: 'master', effectInstanceId: entry.effectInstanceId }
            : { kind: 'track', trackId: entry.target.trackId, effectInstanceId: entry.effectInstanceId },
          entry.parameterId,
        ),
      },
    } : undefined
  } else if (action.kind === 'sidechain.remove') {
    const effectId = action.effect.source === 'persisted' ? action.effect.id : undefined
    const effect = effectId === undefined
      ? undefined
      : snapshot.processors.find((entry) => entry.id === effectId)
    const targetId = action.target.source === 'persisted' ? action.target.id : undefined
    const entry = targetId === undefined || effect?.instanceId === undefined ? undefined : snapshot.sidechains.find((candidate) => (
      candidate.targetTrackId === targetId && candidate.effectInstanceId === effect.instanceId
    ))
    raw = entry ? {
      version: 2,
      kind: action.kind,
      data: {
        sidechain: sidechainPayload(
          input.projectId,
          entry,
          localSidechainRouteRowId(entry.targetTrackId, entry.effectInstanceId),
        ).sidechain,
        sidechainId: localSidechainRouteRowId(entry.targetTrackId, entry.effectInstanceId),
      },
    } : undefined
  } else if (action.kind === 'effect.remove' || action.kind === 'instrument.remove' || action.kind === 'arpeggiator.remove') {
    const effectId = action.kind === 'effect.remove' && action.effect.source === 'persisted'
      ? action.effect.id
      : undefined
    const trackId = action.kind !== 'effect.remove' && action.target.track.source === 'persisted'
      ? action.target.track.id
      : undefined
    const effects = action.kind === 'effect.remove'
      ? effectId === undefined ? [] : snapshot.processors.filter((entry) => entry.id === effectId)
      : trackId === undefined ? [] : snapshot.processors.filter((entry) => (
        'trackId' in entry.target && entry.target.trackId === trackId
        && (action.kind === 'instrument.remove' ? entry.processor.kind === 'instrument' : entry.processor.kind === 'arpeggiator')
      ))
    if (effects.length > 0) {
      const bundle = effectBundle(input.projectId, snapshot, effects)
      raw = {
        version: 2,
        kind: action.kind,
        data: action.kind === 'instrument.remove'
          ? { ...bundle, automation: instrumentAutomation(input.projectId, snapshot, effects) }
          : bundle,
      }
    }
  } else if (action.kind === 'track.delete' || action.kind === 'track.ungroup') {
    const rootId = action.kind === 'track.delete' ? action.track : action.group
    if (rootId.source !== 'persisted') return undefined
    const root = snapshot.tracks.find((track) => track.id === rootId.id)
    if (!root) return undefined
    const selected = action.kind === 'track.delete'
      ? collectLocalDeletedTrackIds(snapshot.tracks, root.id)
      : new Set([root.id])
    const tracks = snapshot.tracks.filter((track) => selected.has(track.id))
    const bundle = {
      tracks: tracks.map((track) => trackPayload(input.projectId, track, input.actorSubject)),
      clips: snapshot.clips.filter((clip) => selected.has(clip.trackId)).map((clip) => ({
        id: clip.id,
        clip: clipPayload(input.projectId, clip, input.clipHistoryRefs?.get(clip.id)),
        ownership: ownership(input.projectId, input.actorSubject),
      })),
      effects: snapshot.processors
        .filter((effect) => (
          effect.processor.kind !== 'external-vst3'
          && 'trackId' in effect.target
          && selected.has(effect.target.trackId)
        ))
        .map((effect) => effectPayload(input.projectId, effect)),
      automation: snapshot.automation
        .flatMap((entry) => 'trackId' in entry.target && selected.has(entry.target.trackId)
          ? [automationPayload(input.projectId, entry, automationTargetKey(
          { kind: 'track', trackId: entry.target.trackId, effectInstanceId: entry.effectInstanceId },
          entry.parameterId,
        ))]
          : []),
      sidechains: snapshot.sidechains
        .filter((entry) => selected.has(entry.sourceTrackId) || selected.has(entry.targetTrackId))
        .map((entry) => sidechainPayload(
          input.projectId,
          entry,
          localSidechainRouteRowId(entry.targetTrackId, entry.effectInstanceId),
        )),
    }
    if (action.kind === 'track.delete') {
      const survivors = snapshot.tracks
        .filter((track) => !selected.has(track.id))
        .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
        .flatMap((track, index) => {
          const after = {
            ...trackPayload(input.projectId, track, input.actorSubject).track,
            index,
            groupId: selected.has(track.groupId ?? '') ? undefined : track.groupId,
            mixer: {
              ...trackPayload(input.projectId, track, input.actorSubject).track.mixer,
              outputTargetId: selected.has(track.outputTargetId ?? '') ? undefined : track.outputTargetId,
              sends: track.sends.filter((send) => !selected.has(send.targetTrackId)).map((send) => ({
                targetId: send.targetTrackId, amount: send.amount, tap: send.tap,
              })),
            },
          }
          const before = trackPayload(input.projectId, track, input.actorSubject).track
          return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ id: track.id, before, after }]
        })
      raw = { version: 2, kind: action.kind, data: { rootTrackId: root.id, ...bundle, survivors } }
    } else {
      if (root.channelRole !== 'group' || snapshot.clips.some((clip) => clip.trackId === root.id)) return undefined
      raw = {
        version: 2,
        kind: action.kind,
        data: {
          groupId: root.id,
          ...bundle,
          children: snapshot.tracks.filter((track) => track.groupId === root.id).map((child) => ({
            id: child.id,
            before: trackPayload(input.projectId, child, input.actorSubject).track,
            after: {
              ...trackPayload(input.projectId, child, input.actorSubject).track,
              index: child.index > root.index ? child.index - 1 : child.index,
              groupId: root.groupId,
              mixer: {
                ...trackPayload(input.projectId, child, input.actorSubject).track.mixer,
                outputTargetId: child.outputTargetId === root.id ? root.groupId : undefined,
              },
            },
          })),
        },
      }
    }
  }
  const parsed = recoveryCapturedPayloadSchemaV2.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

export const serializeLocalRecoveryPayload = (payload: CapturedRecoveryPayloadV2) => {
  const text = canonicalCapturedRecoveryPayloadV2(JSON.parse(JSON.stringify(payload)))
  return { payload: text, payloadHash: hashRecoveryPayloadSyncV1(text) }
}
