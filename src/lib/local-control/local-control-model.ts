import {
  automationTargetKey,
  createAudioEffectInstanceId,
  createInstrumentInstanceId,
  AUDIO_EFFECT_ORDER,
  normalizeLegacyMidiClip,
  type AutomationTarget,
  type AudioEffectKind,
} from '@daw-browser/shared'
import type { ControlPlanV1 } from '@daw-browser/control'
import {
  createLocalProjectEntityRow,
  LOCAL_CONTROL_PROJECT_METADATA_KEY,
  type LocalProjectAssetRow,
  type LocalProjectEntityRow,
  type LocalProjectStateRow,
} from '~/lib/local-project-db'
import {
  localAssetFolderKey,
  parseLocalAssetFolderRow,
} from '~/lib/local-asset-folders'
import { localEffectRowId, localSidechainRouteRowId, type LocalEffectRow } from '~/lib/local-effects'
import type { TimelineClipRow, TimelineTrackRow } from '~/lib/timeline-repository/types'

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const stringField = (value: Record<string, unknown> | undefined, key: string) => (
  typeof value?.[key] === 'string' ? value[key] : undefined
)
const timeField = (value: Record<string, unknown> | undefined, key: string, fallback: number) => (
  typeof value?.[key] === 'number' ? value[key] : fallback
)
const isAudioEffectKind = (kind: string): kind is AudioEffectKind => (
  AUDIO_EFFECT_ORDER.some((effect) => effect === kind)
)
const localProcessorKind = (
  target: ControlSnapshot['processors'][number]['target'],
  kind: string,
): LocalEffectRow['effect'] | undefined => {
  if (kind === 'instrument') return 'instrument'
  if (kind === 'arpeggiator') return 'arp'
  if (!isAudioEffectKind(kind)) return undefined
  return 'master' in target ? `master-${kind}` : kind
}
type ControlSnapshot = ControlPlanV1['snapshot']

const localMidi = (value: ControlSnapshot['clips'][number]['midi']): TimelineClipRow['midi'] => {
  if (!value) return undefined
  return normalizeLegacyMidiClip(value)
}

type LocalControlModel = {
  entities: readonly LocalProjectEntityRow[]
  assets: readonly LocalProjectAssetRow[]
  projectState: readonly LocalProjectStateRow[]
}

type MaterializedLocalControlModel = LocalControlModel & {
  replaced: {
    entities: Array<{ kind: string; id: string }>
    assets: string[]
    projectState: string[]
  }
}

const rowsByKind = (rows: readonly LocalProjectEntityRow[], kind: string) => (
  new Map(rows.filter((row) => row.kind === kind && isRecord(row.value)).map((row) => [row.id, row]))
)

export const materializeLocalControlSnapshot = (
  model: LocalControlModel,
  snapshot: ControlSnapshot,
  timestamp: number,
  assetFallbacks: ReadonlyMap<string, LocalProjectAssetRow> = new Map(),
  removedAssetIds: ReadonlySet<string> = new Set(),
  removedEntities: ReadonlySet<string> = new Set(),
  migratedLegacySynthIds: ReadonlySet<string> = new Set(),
  sampleUrlFallbacks: ReadonlyMap<string, string> = new Map(),
  historyRefFallbacks: ReadonlyMap<string, string> = new Map(),
): MaterializedLocalControlModel => {
  const tracks = rowsByKind(model.entities, 'track')
  const clips = rowsByKind(model.entities, 'clip')
  const effects = rowsByKind(model.entities, 'effect')
  const automation = rowsByKind(model.entities, 'automation-envelope')
  const sidechains = rowsByKind(model.entities, 'sidechain-route')
  const canonicalIds = new Map<string, Set<string>>([
    ['track', new Set(snapshot.tracks.map((item) => item.id))],
    ['clip', new Set(snapshot.clips.map((item) => item.id))],
    ['effect', new Set(snapshot.processors.flatMap((item) => {
      const kind = localProcessorKind(item.target, item.processor.kind)
      if (!kind) return []
      const targetId = 'master' in item.target ? 'master' : item.target.trackId
      const instanceId = item.instanceId ?? (
        item.processor.kind === 'instrument' ? createInstrumentInstanceId() : createAudioEffectInstanceId()
      )
      return [localEffectRowId(
        targetId,
        kind,
        item.processor.kind === 'instrument' || kind === 'arp' ? undefined : instanceId,
      )]
    }))],
    ['automation-envelope', new Set(snapshot.automation.map((item) => automationTargetKey(
      'master' in item.target
        ? { kind: 'master', effectInstanceId: item.effectInstanceId }
        : { kind: 'track', trackId: item.target.trackId, effectInstanceId: item.effectInstanceId },
      item.parameterId,
    )))],
    ['sidechain-route', new Set(snapshot.sidechains.map((item) => (
      localSidechainRouteRowId(item.targetTrackId, item.effectInstanceId)
    )))],
  ])
  const replaceableEntities = model.entities.filter((row) => (
    canonicalIds.get(row.kind)?.has(row.id) === true
    || removedEntities.has(`${row.kind}:${row.id}`)
  ))
  const entities = model.entities.filter((row) => !replaceableEntities.includes(row))

  for (const item of snapshot.tracks) {
    const existingValue = tracks.get(item.id)?.value
    const existing = isRecord(existingValue) ? existingValue : undefined
    const row: TimelineTrackRow = {
      ...(isRecord(existing) ? existing : {}),
      id: item.id,
      historyRef: stringField(existing, 'historyRef') ?? item.id,
      name: item.name,
      index: item.index,
      volume: item.volume,
      muted: item.muted,
      soloed: item.soloed,
      kind: item.kind,
      channelRole: item.channelRole,
      groupId: item.groupId,
      collapsed: item.collapsed,
      color: item.color,
      outputTargetId: item.outputTargetId,
      sends: item.sends.map((send: { targetTrackId: string; amount: number; tap?: 'pre-fx' | 'pre-fader' | 'post-fader' }) => ({ targetId: send.targetTrackId, amount: send.amount, tap: send.tap })),
      createdAt: timeField(existing, 'createdAt', timestamp),
      updatedAt: timestamp,
    }
    entities.push(createLocalProjectEntityRow('track', row.id, row, timestamp))
  }
  for (const item of snapshot.clips) {
    const existingValue = clips.get(item.id)?.value
    const existing = isRecord(existingValue) ? existingValue : undefined
    const source = item.source
    const sourceChanged = source !== undefined
      && stringField(existing, 'sourceAssetKey') !== source.assetId
    const row: TimelineClipRow = {
      ...(isRecord(existing) ? existing : {}),
      id: item.id,
      trackId: item.trackId,
      historyRef: historyRefFallbacks.get(item.id) ?? stringField(existing, 'historyRef') ?? item.id,
      name: item.name,
      startSec: item.startSec,
      duration: item.duration,
      color: item.color ?? (item.midi ? 'clip-midi' : 'clip-audio'),
      controlColorExplicit: item.color !== undefined,
      sourceAssetKey: source?.assetId,
      sourceAssetId: source?.assetId,
      sourceKind: source?.sourceKind,
      sourceDurationSec: source?.durationSec,
      sourceSampleRate: source?.sampleRate,
      sourceChannelCount: source?.channelCount,
      sampleUrl: sourceChanged ? undefined : stringField(existing, 'sampleUrl') ?? sampleUrlFallbacks.get(item.id),
      leftPadSec: item.leftPadSec,
      bufferOffsetSec: item.bufferOffsetSec,
      audioWarp: item.audioWarp,
      gain: item.gain,
      fades: item.fades,
      midi: localMidi(item.midi),
      midiOffsetBeats: item.midiOffsetBeats,
      createdAt: timeField(existing, 'createdAt', timestamp),
      updatedAt: timestamp,
    }
    entities.push(createLocalProjectEntityRow('clip', row.id, row, timestamp))
  }
  for (const item of snapshot.processors) {
    const legacy = effects.get(item.id)
    if (
      item.processor.kind === 'instrument'
      && isRecord(legacy?.value)
      && legacy.value.effect === 'synth'
      && !migratedLegacySynthIds.has(item.id)
    ) continue
    const targetId = 'master' in item.target ? 'master' : item.target.trackId
    const kind = localProcessorKind(item.target, item.processor.kind)
    if (!kind) continue
    const instanceId = item.instanceId ?? (
      item.processor.kind === 'instrument' ? createInstrumentInstanceId() : createAudioEffectInstanceId()
    )
    const id = localEffectRowId(targetId, kind, item.processor.kind === 'instrument' || kind === 'arp' ? undefined : instanceId)
    const existing = legacy?.value
    const row: LocalEffectRow = {
      ...(isRecord(existing) ? existing : {}),
      id,
      targetId,
      effect: kind,
      ...(item.instanceId === undefined ? {} : { instanceId }),
      params: item.processor.params,
      index: item.index,
      updatedAt: timestamp,
    }
    entities.push(createLocalProjectEntityRow('effect', id, row, timestamp))
  }
  for (const item of snapshot.automation) {
    const target: AutomationTarget = 'master' in item.target
      ? { kind: 'master', effectInstanceId: item.effectInstanceId }
      : { kind: 'track', trackId: item.target.trackId, effectInstanceId: item.effectInstanceId }
    const id = automationTargetKey(target, item.parameterId)
    const existing = automation.get(id)?.value
    entities.push(createLocalProjectEntityRow('automation-envelope', id, {
      ...(isRecord(existing) ? existing : {}),
      id,
      projectId: snapshot.project.id,
      target,
      targetKey: id,
      parameterId: item.parameterId,
      enabled: item.enabled,
      points: item.points,
      updatedAt: timestamp,
    }, timestamp))
  }
  for (const item of snapshot.sidechains) {
    const id = localSidechainRouteRowId(item.targetTrackId, item.effectInstanceId)
    const existing = sidechains.get(id)?.value
    entities.push(createLocalProjectEntityRow('sidechain-route', id, {
      ...(isRecord(existing) ? existing : {}),
      sourceTrackId: item.sourceTrackId,
      targetTrackId: item.targetTrackId,
      effectInstanceId: item.effectInstanceId,
    }, timestamp))
  }

  const assetById = new Map([...model.assets, ...assetFallbacks.values()].map((asset) => [asset.id, asset]))
  const assetsById = new Map(model.assets
    .filter((asset) => !removedAssetIds.has(asset.id))
    .map((asset) => [asset.id, asset]))
  for (const item of snapshot.assets) {
    const existing = assetById.get(item.id)
    assetsById.set(item.id, {
      ...(existing ?? {
        storagePath: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }),
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      sourceKind: item.sourceKind,
      contentHash: item.contentSha256,
      durationSec: item.durationSec,
      sampleRate: item.sampleRate,
      channelCount: item.channelCount,
      folderId: item.folderId,
      updatedAt: item.updatedAt,
    })
  }
  const assets = Array.from(assetsById.values())
  const folderKeys = new Set<string>()
  const projectState = model.projectState.filter((row) => {
    if (row.key === LOCAL_CONTROL_PROJECT_METADATA_KEY || row.key === 'bpm' || row.key === 'loop' || row.key === 'projectMix') {
      return false
    }
    if (!row.key.startsWith('asset-folder:')) return true
    if (!parseLocalAssetFolderRow(row.value)) return true
    folderKeys.add(row.key)
    return false
  })
  projectState.push(
    {
      key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
      value: {
        version: 1,
        name: snapshot.project.name,
        updatedAt: timestamp,
        timeSignature: snapshot.project.timeSignature,
      },
      updatedAt: timestamp,
    },
    { key: 'bpm', value: snapshot.project.tempoBpm, updatedAt: timestamp },
    { key: 'loop', value: snapshot.project.loop, updatedAt: timestamp },
    { key: 'projectMix', value: { masterVolume: snapshot.project.masterVolume }, updatedAt: timestamp },
    ...snapshot.assetFolders.map((folder) => {
      const key = localAssetFolderKey(folder.id)
      folderKeys.delete(key)
      return {
        key,
        value: {
          id: folder.id,
          name: folder.name,
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt,
        },
        updatedAt: folder.updatedAt,
      }
    }),
  )
  return {
    entities,
    assets,
    projectState,
    replaced: {
      entities: replaceableEntities.map((row) => ({ kind: row.kind, id: row.id })),
      assets: Array.from(removedAssetIds),
      projectState: [
        ...model.projectState
          .filter((row) => row.key === LOCAL_CONTROL_PROJECT_METADATA_KEY || row.key === 'bpm' || row.key === 'loop' || row.key === 'projectMix')
          .map((row) => row.key),
        ...folderKeys,
      ],
    },
  }
}
