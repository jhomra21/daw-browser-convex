import {
  canonicalCapturedRecoveryPayloadV2,
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
import type { LocalProjectAssetRow } from '~/lib/local-project-db'
import { localSidechainRouteRowId } from '~/lib/local-effects'

export const localRecoveryLifetimeMs = 7 * 24 * 60 * 60 * 1000
const jsonValueSchema = z.json()

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
      ? new Set(snapshot.tracks.filter((track) => {
        let current = track
        while (current.groupId !== undefined) {
          if (current.groupId === root.id) return true
          const parent = snapshot.tracks.find((candidate) => candidate.id === current.groupId)
          if (!parent) break
          current = parent
        }
        return track.id === root.id
      }).map((track) => track.id))
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
