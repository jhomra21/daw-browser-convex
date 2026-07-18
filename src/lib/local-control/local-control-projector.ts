import {
  assetSnapshotSchemaV1,
  projectControlSnapshotV1,
  stableIdSchemaV1,
  type ProjectSnapshotV1,
} from '@daw-browser/control'
import type { AutomationEnvelope } from '@daw-browser/shared'
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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const projectMetadata = (
  rows: readonly LocalProjectStateRow[],
  fallback: LocalControlProjectMetadata,
): LocalControlProjectMetadata => {
  const row = rows.find((entry) => entry.key === LOCAL_CONTROL_PROJECT_METADATA_KEY)
  const value = row?.value
  if (
    !isRecord(value)
    || value.version !== 1
    || typeof value.name !== 'string'
    || typeof value.updatedAt !== 'number'
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

const valueOfKind = <Value>(
  rows: readonly LocalProjectEntityRow[],
  kind: string,
  accepts: (value: unknown) => value is Value,
) => rows.flatMap((row) => row.kind === kind && accepts(row.value) ? [row.value] : [])

const isTrackSend = (value: unknown): value is TimelineTrackRow['sends'][number] => (
  isRecord(value)
  && typeof value.targetId === 'string'
  && stableIdSchemaV1.safeParse(value.targetId).success
  && typeof value.amount === 'number'
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

const isTrack = (value: unknown): value is TimelineTrackRow => (
  isRecord(value)
  && typeof value.id === 'string'
  && stableIdSchemaV1.safeParse(value.id).success
  && typeof value.name === 'string'
  && typeof value.index === 'number'
  && typeof value.volume === 'number'
  && typeof value.muted === 'boolean'
  && typeof value.soloed === 'boolean'
  && Array.isArray(value.sends)
  && value.sends.every(isTrackSend)
  && new Set(value.sends.map((send) => send.targetId)).size === value.sends.length
  && (value.groupId === undefined || stableIdSchemaV1.safeParse(value.groupId).success)
  && (value.outputTargetId === undefined || stableIdSchemaV1.safeParse(value.outputTargetId).success)
  && (value.kind === 'audio' || value.kind === 'instrument')
  && (value.channelRole === 'track' || value.channelRole === 'group' || value.channelRole === 'return')
)

const isClip = (value: unknown): value is TimelineClipRow => (
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.trackId === 'string'
  && typeof value.name === 'string'
  && typeof value.startSec === 'number'
  && typeof value.duration === 'number'
  && typeof value.color === 'string'
)

const isEffect = (value: unknown): value is LocalEffectRow => (
  isRecord(value)
  && typeof value.id === 'string'
  && typeof value.targetId === 'string'
  && typeof value.effect === 'string'
  && 'params' in value
)

const isAutomation = (value: unknown): value is AutomationEnvelope => (
  isRecord(value)
  && typeof value.id === 'string'
  && isRecord(value.target)
  && typeof value.parameterId === 'string'
  && typeof value.enabled === 'boolean'
  && Array.isArray(value.points)
)

const isSidechain = (value: unknown): value is ExternalSidechainRoute => (
  isRecord(value)
  && typeof value.sourceTrackId === 'string'
  && typeof value.targetTrackId === 'string'
  && typeof value.effectInstanceId === 'string'
)

const isProjectMix = (value: unknown): value is { masterVolume: number } => (
  isRecord(value) && typeof value.masterVolume === 'number'
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

export const projectLocalControlSnapshotV1 = (input: {
  projectId: string
  fallbackMetadata: LocalControlProjectMetadata
  entities: readonly LocalProjectEntityRow[]
  assets: readonly LocalProjectAssetRow[]
  projectState: readonly LocalProjectStateRow[]
  revision: number
}): ProjectSnapshotV1 => {
  const metadata = projectMetadata(input.projectState, input.fallbackMetadata)
  const bpm = input.projectState.find((row) => row.key === 'bpm')?.value
  const loop = input.projectState.find((row) => row.key === 'loop')?.value
  const projectMix = input.projectState.find((row) => row.key === 'projectMix')?.value
  const effects = valueOfKind(input.entities, 'effect', isEffect)
  return projectControlSnapshotV1({
    omitUnavailableClipSources: true,
    project: {
      projectId: input.projectId,
      name: metadata.name,
      revision: input.revision,
      tempoBpm: typeof bpm === 'number' ? bpm : 120,
      timeSignatureNumerator: metadata.timeSignature.numerator,
      timeSignatureDenominator: metadata.timeSignature.denominator,
      loopEnabled: isRecord(loop) && loop.enabled === true,
      loopStartSec: isRecord(loop) && typeof loop.startSec === 'number' ? loop.startSec : 0,
      loopEndSec: isRecord(loop) && typeof loop.endSec === 'number' ? loop.endSec : 8,
      updatedAt: metadata.updatedAt,
    },
    tracks: valueOfKind(input.entities, 'track', isTrack).map((track) => ({
      ...track,
      _id: track.id,
    })),
    clips: valueOfKind(input.entities, 'clip', isClip).map((clip) => ({
      ...clip,
      _id: clip.id,
      sourceAssetKey: clip.sourceAssetKey ?? clip.sourceAssetId,
    })),
    masterVolume: isProjectMix(projectMix) ? projectMix.masterVolume : 1,
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
    automationEnvelopes: valueOfKind(input.entities, 'automation-envelope', isAutomation).map((envelope) => ({
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
    assetFolders: [],
  })
}
