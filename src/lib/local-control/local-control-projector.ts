import {
  assetSnapshotSchemaV1,
  projectControlSnapshotV1,
  projectControlSnapshotV2,
  stableIdSchemaV1,
  type ProjectSnapshotV1,
  type ProjectSnapshotV2,
} from '@daw-browser/control'
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type AutomationEnvelope,
  type JsonValue,
} from '@daw-browser/shared'
import {
  externalPluginEntityKind,
  parseExternalProcessorValue,
  type ExternalProcessor,
} from '@daw-browser/external-plugins'
import type { LocalEffectRow } from '~/lib/local-effects'
import {
  LOCAL_CONTROL_PROJECT_METADATA_KEY,
  isCanonicalLocalControlTimeSignature,
  type LocalControlProjectMetadata,
  type LocalProjectAssetRow,
  type LocalProjectEntityRow,
  type LocalProjectStateRow,
} from '~/lib/local-project-db'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import type { TimelineClipRow, TimelineTrackRow } from '~/lib/timeline-repository/types'
import {
  LOCAL_ASSET_FOLDER_KEY_PREFIX,
  parseLocalAssetFolderRow,
} from '~/lib/local-asset-folders'
import { normalizeLocalAutomationEnvelopes } from '~/lib/local-automation'
import { parseExternalPluginJsonValue } from '~/lib/external-plugin-json'
import { parseLocalProjectStoredJsonValue } from './local-control-model'

const projectMetadata = (
  rows: readonly LocalProjectStateRow[],
  fallback: LocalControlProjectMetadata,
): LocalControlProjectMetadata => {
  const row = rows.find((entry) => entry.key === LOCAL_CONTROL_PROJECT_METADATA_KEY)
  const value = parseLocalProjectStoredJsonValue(row?.value)
  if (
    !isJsonObject(value)
    || value.version !== 1
    || !isJsonString(value.name)
    || !isJsonNumber(value.updatedAt)
    || !isCanonicalLocalControlTimeSignature(value.timeSignature)
  ) return fallback
  return {
    version: 1,
    name: value.name,
    updatedAt: value.updatedAt,
    timeSignature: {
      numerator: value.timeSignature.numerator,
      denominator: value.timeSignature.denominator,
    },
  }
}

const valueOfKind = <Value extends JsonValue>(
  rows: readonly LocalProjectEntityRow[],
  kind: string,
  accepts: (value: JsonValue) => value is Value,
) => rows.flatMap((row) => {
  const value = parseLocalProjectStoredJsonValue(row.value)
  return row.kind === kind && value !== undefined && accepts(value) ? [value] : []
})

const isTrackSend = (value: JsonValue) => (
  isJsonObject(value)
  && isJsonString(value.targetId)
  && stableIdSchemaV1.safeParse(value.targetId).success
  && isJsonNumber(value.amount)
  && Number.isFinite(value.amount)
  && value.amount >= 0
  && value.amount <= 2
  && (
    value.tap === undefined
    || value.tap === 'pre-fx'
    || value.tap === 'pre-fader'
    || value.tap === 'post-fader'
  )
)

const isTrack = (value: JsonValue): value is TimelineTrackRow => (
  isJsonObject(value)
  && isJsonString(value.id)
  && stableIdSchemaV1.safeParse(value.id).success
  && isJsonString(value.name)
  && isJsonNumber(value.index)
  && isJsonNumber(value.volume)
  && isJsonBoolean(value.muted)
  && isJsonBoolean(value.soloed)
  && Array.isArray(value.sends)
  && value.sends.every(isTrackSend)
  && new Set(value.sends.flatMap((send) => (
    isJsonObject(send) && isJsonString(send.targetId) ? [send.targetId] : []
  ))).size === value.sends.length
  && (value.groupId === undefined || stableIdSchemaV1.safeParse(value.groupId).success)
  && (value.outputTargetId === undefined || stableIdSchemaV1.safeParse(value.outputTargetId).success)
  && (value.kind === 'audio' || value.kind === 'instrument')
  && (value.channelRole === 'track' || value.channelRole === 'group' || value.channelRole === 'return')
)

const isClip = (value: JsonValue): value is TimelineClipRow => (
  isJsonObject(value)
  && isJsonString(value.id)
  && isJsonString(value.trackId)
  && isJsonString(value.name)
  && isJsonNumber(value.startSec)
  && isJsonNumber(value.duration)
  && isJsonString(value.color)
)

const isEffect = (value: JsonValue): value is LocalEffectRow<JsonValue> => (
  isJsonObject(value)
  && isJsonString(value.id)
  && isJsonString(value.targetId)
  && isJsonString(value.effect)
  && 'params' in value
)
const isExternalProcessor = (value: JsonValue): value is ExternalProcessor => (
  parseExternalProcessorValue(parseExternalPluginJsonValue(value)).success
)

const isAutomation = (value: JsonValue): value is AutomationEnvelope => (
  isJsonObject(value)
  && isJsonString(value.id)
  && isJsonObject(value.target)
  && isJsonString(value.parameterId)
  && isJsonBoolean(value.enabled)
  && Array.isArray(value.points)
)

const isSidechain = (value: JsonValue): value is ExternalSidechainRoute => (
  isJsonObject(value)
  && isJsonString(value.sourceTrackId)
  && isJsonString(value.targetTrackId)
  && isJsonString(value.effectInstanceId)
)

const isProjectMix = (value: JsonValue | undefined): value is { masterVolume: number } => (
  isJsonObject(value) && isJsonNumber(value.masterVolume)
)

const completeAssets = (assets: readonly LocalProjectAssetRow[]) => assets.flatMap((asset) => {
  if (asset.missing || !asset.sourceKind || !asset.contentHash) return []
  const result = assetSnapshotSchemaV1.safeParse({
    id: asset.id,
    name: asset.name,
    sourceKind: asset.sourceKind,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    contentSha256: asset.contentHash,
    durationSec: asset.durationSec,
    sampleRate: asset.sampleRate,
    channelCount: asset.channelCount,
    folderId: asset.folderId,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  })
  if (!result.success) return []
  return [{
    assetKey: result.data.id,
    name: result.data.name,
    sourceKind: result.data.sourceKind,
    mimeType: result.data.mimeType,
    sizeBytes: result.data.sizeBytes,
    contentSha256: result.data.contentSha256,
    duration: result.data.durationSec,
    sampleRate: result.data.sampleRate,
    channelCount: result.data.channelCount,
    folderId: result.data.folderId,
    createdAt: result.data.createdAt,
    updatedAt: result.data.updatedAt,
  }]
})

type LocalControlSnapshotInput = {
  projectId: string
  fallbackMetadata: LocalControlProjectMetadata
  entities: readonly LocalProjectEntityRow[]
  assets: readonly LocalProjectAssetRow[]
  projectState: readonly LocalProjectStateRow[]
  revision: number
}

const projectLocalControlSnapshot = <Snapshot>(
  input: LocalControlSnapshotInput,
  projectSnapshot: (value: Parameters<typeof projectControlSnapshotV1>[0]) => Snapshot,
): Snapshot => {
  const metadata = projectMetadata(input.projectState, input.fallbackMetadata)
  const bpm = input.projectState.find((row) => row.key === 'bpm')?.value
  const loop = input.projectState.find((row) => row.key === 'loop')?.value
  const projectMix = input.projectState.find((row) => row.key === 'projectMix')?.value
  const parsedBpm = parseLocalProjectStoredJsonValue(bpm)
  const parsedLoop = parseLocalProjectStoredJsonValue(loop)
  const parsedProjectMix = parseLocalProjectStoredJsonValue(projectMix)
  const effects = valueOfKind(input.entities, 'effect', isEffect)
  const externalProcessors = valueOfKind(input.entities, externalPluginEntityKind, isExternalProcessor)
    .flatMap((value) => {
      const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(value))
      return parsed.success ? [parsed.data] : []
    })
  return projectSnapshot({
    omitUnavailableClipSources: true,
    project: {
      projectId: input.projectId,
      name: metadata.name,
      revision: input.revision,
      tempoBpm: isJsonNumber(parsedBpm) ? parsedBpm : 120,
      timeSignatureNumerator: metadata.timeSignature.numerator,
      timeSignatureDenominator: metadata.timeSignature.denominator,
      loopEnabled: isJsonObject(parsedLoop) && parsedLoop.enabled === true,
      loopStartSec: isJsonObject(parsedLoop) && isJsonNumber(parsedLoop.startSec) ? parsedLoop.startSec : 0,
      loopEndSec: isJsonObject(parsedLoop) && isJsonNumber(parsedLoop.endSec) ? parsedLoop.endSec : 8,
      updatedAt: metadata.updatedAt,
    },
    tracks: valueOfKind(input.entities, 'track', isTrack).map((track) => ({
      _id: track.id,
      name: track.name,
      index: track.index,
      kind: track.kind,
      channelRole: track.channelRole,
      groupId: track.groupId,
      volume: track.volume,
      muted: track.muted,
      soloed: track.soloed,
      outputTargetId: track.outputTargetId,
      sends: track.sends,
      collapsed: track.collapsed,
      color: track.color,
    })),
    clips: valueOfKind(input.entities, 'clip', isClip).map((clip) => ({
      _id: clip.id,
      trackId: clip.trackId,
      name: clip.name,
      sourceAssetKey: clip.sourceAssetKey ?? clip.sourceAssetId,
      startSec: clip.startSec,
      duration: clip.duration,
      gain: clip.gain,
      leftPadSec: clip.leftPadSec,
      bufferOffsetSec: clip.bufferOffsetSec,
      audioWarp: clip.audioWarp,
      fades: clip.fades,
      color: clip.controlColorExplicit === false ? undefined : clip.color,
      midi: clip.midi,
      midiOffsetBeats: clip.midiOffsetBeats,
    })),
    masterVolume: isProjectMix(parsedProjectMix) ? parsedProjectMix.masterVolume : 1,
    effects: effects.map((effect) => {
      const master = effect.effect.startsWith('master-')
      const type = master ? effect.effect.slice('master-'.length) : effect.effect === 'arp' ? 'arpeggiator' : effect.effect
      return {
        _id: effect.id,
        targetType: master ? 'master' : 'track',
        trackId: master ? undefined : effect.targetId,
        index: effect.index ?? 0,
        type,
        instanceId: effect.instanceId,
        params: effect.params,
      }
    }),
    externalProcessors: externalProcessors.map((processor) => ({
      instanceId: processor.instanceId,
      targetId: processor.targetId,
      index: processor.index,
      manifest: {
        identity: {
          name: processor.manifest.identity.name,
          vendor: processor.manifest.identity.vendor,
          classId: processor.manifest.identity.classId,
        },
        role: processor.manifest.role,
        parameters: processor.manifest.parameters.map((parameter) => ({
          id: parameter.id,
          readOnly: parameter.readOnly,
        })),
      },
      bypassed: processor.bypassed,
      parameterOverrides: processor.parameterOverrides,
    })),
    automationEnvelopes: normalizeLocalAutomationEnvelopes(
      valueOfKind(input.entities, 'automation-envelope', isAutomation),
    ).map((envelope) => ({
      _id: envelope.id,
      targetKind: envelope.target.kind,
      trackId: envelope.target.kind === 'track' ? envelope.target.trackId : undefined,
      effectInstanceId: envelope.target.effectInstanceId,
      parameterId: envelope.parameterId,
      enabled: envelope.enabled,
      points: envelope.points,
    })),
    sidechainRoutes: valueOfKind(input.entities, 'sidechain-route', isSidechain),
    assets: completeAssets(input.assets),
    assetFolders: input.projectState.flatMap((row) => {
      if (!row.key.startsWith(LOCAL_ASSET_FOLDER_KEY_PREFIX)) return []
      const value = parseLocalProjectStoredJsonValue(row.value)
      const folder = value === undefined ? undefined : parseLocalAssetFolderRow(value)
      return folder ? [{
        _id: folder.id,
        name: folder.name,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      }] : []
    }),
  })
}

export const projectLocalControlSnapshotV1 = (input: LocalControlSnapshotInput): ProjectSnapshotV1 => (
  projectLocalControlSnapshot(input, projectControlSnapshotV1)
)

export const projectLocalControlSnapshotV2 = (input: LocalControlSnapshotInput): ProjectSnapshotV2 => (
  projectLocalControlSnapshot(input, projectControlSnapshotV2)
)
