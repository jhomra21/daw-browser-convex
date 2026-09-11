import {
  canonicalCapturedRecoveryPayloadV2,
  hashRecoveryPayloadV1,
  isCloudRecoveryAssetV1,
  isCloudRecoveryOwnershipV1,
  parseStoredRecoveryPayload,
  recoveryCapturedPayloadSchemaV2,
  timelineRangeRecoveryAutomationDigestV2,
  timelineRangeRecoveryClipDigestV2,
  timelineRangeRecoveryOwnershipDigestV2,
  type ControlActionV1,
  type ContextualRefV1,
  type RecoveryPayload,
  type RecoveryOwnershipV1,
} from "@daw-browser/control";
import {
  buildTimelineRangeDeletePatchV1,
  collectDeletedTrackIdsV1,
  deriveTrackDeletionAfterStatesV1,
  deriveTrackUngroupAfterStatesV1,
  mergeRecoveryTrackOrderV1,
} from "@daw-browser/control-core";
import type { NormalizedTrackControlStateV1, TimelineRangeDeletePatchV1 } from "@daw-browser/control-core";
import {
  automationTargetKey,
  granularAutomationKey,
  instrumentAutomationKey,
  normalizeLegacyMidiClip,
  normalizePersistedInstrumentParams,
  parseGranularAutomationKey,
  parseInstrumentAutomationKey,
  parseSynthAutomationKey,
  persistedProcessorSnapshotSchema,
  sanitizeAudioSourceKind,
  sidechainEligibilityError,
  synthAutomationKey,
} from "@daw-browser/shared";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ControlDomainError } from "./controlPreflight";
import { readProjectControlSnapshotV2 } from "./controlSnapshot";
import { findSampleRow } from "./sampleRows";

const recoveryLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const maxRecoveriesPerProject = 1000;
const maxRecoveriesPerActorProject = 128;
const recoveryKinds = new Set([
  "clip.delete", "effect.remove", "instrument.remove", "arpeggiator.remove",
  "automation.delete", "sidechain.remove", "asset.delete", "track.delete", "track.ungroup",
  "timeline.range.delete",
]);

type Mapping = { entity: "track" | "clip" | "effect" | "automation" | "sidechain" | "asset"; sourceId: string; restoredId: string };
type RecoveryCtx = Pick<MutationCtx, "db">;
type RecoveryResolver = <TableName extends "tracks" | "clips" | "effects">(
  table: TableName,
  ref: ContextualRefV1,
) => Id<TableName>;
type RecoverableAction = Extract<ControlActionV1, { kind:
  | "clip.delete" | "effect.remove" | "instrument.remove" | "arpeggiator.remove"
  | "automation.delete" | "sidechain.remove" | "asset.delete" | "track.delete" | "track.ungroup"
  | "timeline.range.delete"
}>;
type EffectBundle = Extract<RecoveryPayload, {
  kind: "effect.remove" | "instrument.remove" | "arpeggiator.remove"
}>["data"];
type RecoveryEffect = EffectBundle["effects"][number]["effect"];
type TrackRecoveryData = Extract<RecoveryPayload, {
  kind: "track.delete" | "track.ungroup";
}>["data"];
type RecoveryTrackState = TrackRecoveryData["tracks"][number]["track"];
type RecoveryTrackTransition = {
  id: string;
  before: RecoveryTrackState;
  after: RecoveryTrackState;
};
type RecoveryRoutingState = {
  index: number;
  groupId?: string;
  outputTargetId?: string;
  sends: RecoveryTrackState["mixer"]["sends"];
};
type TrackBundleRecoveryData = Extract<RecoveryPayload, {
  kind: "track.delete" | "track.ungroup";
}>["data"];
type MergedRecoveryTrack = Doc<"tracks"> & Pick<
  Doc<"mixerChannels">,
  "volume" | "muted" | "soloed" | "channelRole" | "outputTargetId" | "sends"
>;
type RecoveryClipSource = {
  sourceAssetKey?: string;
  sourceKind?: string;
  sourceDurationSec?: number;
  sourceSampleRate?: number;
  sourceChannelCount?: number;
  sampleUrl?: string;
  midi?: unknown;
};

const trackStatePayload = (row: MergedRecoveryTrack): RecoveryTrackState => ({
  projectId: row.projectId,
  name: row.name,
  index: row.index,
  kind: row.kind === "audio" || row.kind === "instrument" ? row.kind : undefined,
  historyRef: row.historyRef,
  groupId: row.groupId === undefined ? undefined : String(row.groupId),
  collapsed: row.collapsed,
  color: row.color,
  mixer: {
    volume: row.volume,
    muted: row.muted,
    soloed: row.soloed,
    channelRole: row.channelRole === "track" || row.channelRole === "group" || row.channelRole === "return"
      ? row.channelRole
      : "track",
    outputTargetId: row.outputTargetId === undefined ? undefined : String(row.outputTargetId),
    sends: row.sends.map((send) => ({
      targetId: String(send.targetId),
      amount: send.amount,
      tap: send.tap,
    })),
  },
});

const recoverySurvivorState = (row: RecoveryTrackState): RecoveryRoutingState => ({
  index: row.index,
  groupId: row.groupId,
  outputTargetId: row.mixer.outputTargetId,
  sends: row.mixer.sends.map((send) => ({ ...send })),
});

const sameRecoverySurvivorState = (left: RecoveryRoutingState, right: RecoveryRoutingState) => (
  JSON.stringify(left) === JSON.stringify(right)
);

const mergedRecoveryRoutingState = (
  track: Doc<"tracks">,
  channel: Doc<"mixerChannels">,
): RecoveryRoutingState => ({
  index: track.index,
  groupId: track.groupId === undefined ? undefined : String(track.groupId),
  outputTargetId: channel.outputTargetId === undefined ? undefined : String(channel.outputTargetId),
  sends: channel.sends.map((send) => ({
    targetId: String(send.targetId),
    amount: send.amount,
    tap: send.tap,
  })),
});

const requireCloudRecoveryOwnership = (ownership: RecoveryOwnershipV1, actionIndex: number) => {
  if (!isCloudRecoveryOwnershipV1(ownership)) {
    throw new ControlDomainError("validation", "Local recovery ownership cannot be restored to cloud.", actionIndex);
  }
  return ownership;
};

const rebasedAutomationParameterId = (parameterId: string, trackId: string | undefined) => {
  if (trackId === undefined) return parameterId;
  const instrument = parseInstrumentAutomationKey(parameterId);
  if (instrument) return instrumentAutomationKey(trackId, instrument.instanceId, instrument.parameterId);
  const granular = parseGranularAutomationKey(parameterId);
  if (granular) return granularAutomationKey(trackId, granular.instanceId, granular.parameterId);
  const synth = parseSynthAutomationKey(parameterId);
  return synth ? synthAutomationKey(trackId, synth.instanceId, synth.parameterId) : parameterId;
};

const requireRecoveryTrackTarget = async (
  ctx: RecoveryCtx,
  projectId: string,
  id: Id<"tracks"> | undefined,
  actionIndex: number,
  message: string,
) => {
  if (!id) throw new ControlDomainError("not-found", message, actionIndex);
  const track = await ctx.db.get(id);
  if (!track || track.projectId !== projectId) throw new ControlDomainError("not-found", message, actionIndex);
  return track;
};

const postDeleteTrackState = (
  before: RecoveryTrackState,
  after: NormalizedTrackControlStateV1,
): RecoveryTrackState => ({
  ...before,
  index: after.index,
  groupId: after.groupId,
  mixer: {
    ...before.mixer,
    outputTargetId: after.outputTargetId,
    sends: after.sends.map((send) => ({ ...send })),
  },
});

const clipPayload = (row: Doc<"clips">) => ({
  projectId: row.projectId,
  trackId: String(row.trackId),
  historyRef: row.historyRef,
  startSec: row.startSec,
  duration: row.duration,
  sourceAssetKey: row.sourceAssetKey,
  sourceKind: row.sourceKind,
  sourceDurationSec: row.sourceDurationSec,
  sourceSampleRate: row.sourceSampleRate,
  sourceChannelCount: row.sourceChannelCount,
  leftPadSec: row.leftPadSec,
  bufferOffsetSec: row.bufferOffsetSec,
  audioWarp: row.audioWarp,
  gain: row.gain,
  fades: row.fades,
  color: row.color,
  name: row.name,
  sampleUrl: row.sampleUrl,
  midi: row.midi,
  midiOffsetBeats: row.midiOffsetBeats,
});
const ownershipPayload = (row: Doc<"ownerships">) => ({
  projectId: row.projectId,
  ownerUserId: row.ownerUserId,
  role: row.role,
});
const canonicalSampleUrl = (projectId: string, assetKey: string) =>
  `/api/samples/${encodeURIComponent(projectId)}/${encodeURIComponent(assetKey)}`;
const assetPayload = (row: Doc<"samples">) => ({
  projectId: row.projectId,
  assetKey: row.assetKey,
  sourceKind: row.sourceKind,
  name: row.name,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  contentSha256: row.contentSha256,
  r2Key: row.r2Key,
  duration: row.duration,
  sampleRate: row.sampleRate,
  channelCount: row.channelCount,
  ownerUserId: row.ownerUserId,
  folderId: row.folderId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const automationPayload = (row: Doc<"automationEnvelopes">) => ({
  projectId: row.projectId,
  targetKind: row.targetKind,
  trackId: row.trackId === undefined ? undefined : String(row.trackId),
  effectInstanceId: row.effectInstanceId,
  targetKey: row.targetKey,
  parameterId: row.parameterId,
  enabled: row.enabled,
  points: row.points,
  updatedAt: row.updatedAt,
});
const sidechainPayload = (row: Doc<"sidechainRoutes">) => ({
  projectId: row.projectId,
  sourceTrackId: String(row.sourceTrackId),
  targetTrackId: String(row.targetTrackId),
  effectInstanceId: row.effectInstanceId,
});
const effectPayload = (row: Doc<"effects">): RecoveryEffect => ({
  projectId: row.projectId,
  target: row.targetType === "master"
    ? { kind: "master" }
    : { kind: "track", trackId: String(row.trackId) },
  index: row.index,
  processor: persistedProcessorSnapshotSchema.parse({ kind: row.type, params: row.params }),
  instanceId: row.instanceId,
  createdAt: row.createdAt,
});

const removeInstrumentAutomation = (rows: Doc<"automationEnvelopes">[], instruments: Doc<"effects">[]) => {
  const instanceIds = new Set(instruments.flatMap((row) => {
    const instrument = normalizePersistedInstrumentParams(row.type, row.instanceId ?? null, row.params);
    return instrument?.instanceId ? [instrument.instanceId] : [];
  }));
  return rows.filter((row) => {
    const key = parseInstrumentAutomationKey(row.parameterId)
      ?? parseGranularAutomationKey(row.parameterId)
      ?? parseSynthAutomationKey(row.parameterId);
    return key !== undefined && instanceIds.has(key.instanceId);
  });
};

export const isRecoverableAction = (action: ControlActionV1): action is RecoverableAction => recoveryKinds.has(action.kind);

export const captureRecoveryPayload = async (
  ctx: RecoveryCtx,
  input: {
    projectId: string;
    action: RecoverableAction;
    resolveRef: RecoveryResolver;
    actionIndex?: number;
    timelineRangeDelete?: TimelineRangeDeletePatchV1;
  },
) => {
  const { action } = input;
  if (!isRecoverableAction(action)) return null;
  if (action.kind === "timeline.range.delete") {
    const snapshot = await readProjectControlSnapshotV2(ctx, input.projectId);
    const trackIds = action.tracks.map((track) => String(input.resolveRef("tracks", track)));
    const plannedPatch = input.timelineRangeDelete ?? buildTimelineRangeDeletePatchV1(
      snapshot,
      trackIds,
      action.startSec,
      action.endSec,
      input.actionIndex ?? 0,
    );
    const snapshotClipById = new Map(snapshot.clips.map((clip) => [clip.id, clip]));
    const patch = {
      ...plannedPatch,
      clipUpdates: plannedPatch.clipUpdates.map((entry) => {
        const current = snapshotClipById.get(entry.clipId);
        if (!current) throw new Error("Range recovery clip is unavailable.");
        return {
          ...entry,
          after: {
            ...current,
            id: entry.clipId,
            startSec: entry.after.startSec,
            duration: entry.after.duration,
            leftPadSec: entry.after.leftPadSec,
            bufferOffsetSec: entry.after.bufferOffsetSec,
            midiOffsetBeats: entry.after.midiOffsetBeats,
            fades: entry.after.fades,
            audioWarp: entry.after.audioWarp,
          },
        };
      }),
      clipCreates: plannedPatch.clipCreates.map((entry) => {
        const source = snapshotClipById.get(entry.sourceClipId);
        if (!source) throw new Error("Range fragment source is unavailable.");
        return {
          ...entry,
          after: {
            ...source,
            id: entry.placeholderId,
            startSec: entry.after.startSec,
            duration: entry.after.duration,
            leftPadSec: entry.after.leftPadSec,
            bufferOffsetSec: entry.after.bufferOffsetSec,
            midiOffsetBeats: entry.after.midiOffsetBeats,
            fades: entry.after.fades,
            audioWarp: entry.after.audioWarp,
          },
        };
      }),
    };
    if (
      patch.clipDeletes.length === 0
      && patch.clipUpdates.length === 0
      && patch.clipCreates.length === 0
      && patch.automationUpdates.length === 0
    ) return null;
    const clips = await ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect();
    const clipById = new Map(clips.map((clip) => [String(clip._id), clip]));
    const deleted = await Promise.all(patch.clipDeletes.map(async (entry) => {
      const clip = clipById.get(entry.clipId);
      if (!clip) return null;
      const clipOwnership = await ctx.db.query("ownerships").withIndex("by_clip", (q) => q.eq("clipId", clip._id)).unique();
      return clipOwnership
        ? { id: entry.clipId, clip: clipPayload(clip), ownership: ownershipPayload(clipOwnership) }
        : null;
    }));
    if (deleted.some((entry) => entry === null)) return null;
    const automationRows = await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", input.projectId)).collect();
    return {
      range: { trackIds: patch.trackIds, startSec: action.startSec, endSec: action.endSec },
      deletedClips: deleted.filter((entry) => entry !== null).map((entry) => ({
        id: entry.id,
        before: entry.clip,
        ownership: entry.ownership,
      })),
      updatedClips: patch.clipUpdates.map((entry) => {
        const clip = clipById.get(entry.clipId);
        if (!clip) throw new Error("Range recovery clip is unavailable.");
        return {
          id: entry.clipId,
          before: clipPayload(clip),
          expectedAfterDigest: timelineRangeRecoveryClipDigestV2(entry.after),
        };
      }),
      createdClips: await Promise.all(patch.clipCreates.map(async (entry) => {
        const sourceId = ctx.db.normalizeId("clips", entry.sourceClipId);
        const sourceOwnership = sourceId
          ? await ctx.db.query("ownerships").withIndex("by_clip", (q) => q.eq("clipId", sourceId)).unique()
          : null;
        if (!sourceOwnership) throw new Error("Range fragment ownership is unavailable.");
        return {
          id: entry.placeholderId,
          expectedAfterDigest: timelineRangeRecoveryClipDigestV2(entry.after),
          expectedOwnershipDigest: timelineRangeRecoveryOwnershipDigestV2(ownershipPayload(sourceOwnership)),
        };
      })),
      automation: patch.automationUpdates.map((entry) => {
        const row = automationRows.find((candidate) => (
          candidate.targetKind === ("master" in entry.identity.target ? "master" : "track")
          && String(candidate.trackId ?? "") === String("trackId" in entry.identity.target ? entry.identity.target.trackId : "")
          && candidate.effectInstanceId === entry.identity.effectInstanceId
          && candidate.parameterId === entry.identity.parameterId
        ));
        if (!row) throw new Error("Range recovery automation is unavailable.");
        return {
          id: String(row._id),
          before: automationPayload(row),
          expectedAfterDigest: timelineRangeRecoveryAutomationDigestV2(entry.after),
        };
      }),
    };
  }
  if (action.kind === "track.delete" || action.kind === "track.ungroup") {
    const tracks = await ctx.db.query("tracks").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect();
    const channels = await ctx.db.query("mixerChannels").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect();
    const channelByTrackId = new Map(channels.map((channel) => [String(channel.trackId), channel]));
    const merged = tracks.map((track) => {
      const channel = channelByTrackId.get(String(track._id));
      if (!channel) throw new Error("Track mixer channel is unavailable.");
      return {
        ...track,
        volume: channel.volume,
        muted: channel.muted,
        soloed: channel.soloed,
        channelRole: channel.channelRole,
        outputTargetId: channel.outputTargetId,
        sends: channel.sends,
      };
    });
    const ownerships = await ctx.db.query("ownerships").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect();
    const ownershipByTrackId = new Map(ownerships.flatMap((ownership) => ownership.trackId ? [[String(ownership.trackId), ownership] as const] : []));
    const rootId = input.resolveRef("tracks", action.kind === "track.delete" ? action.track : action.group);
    const root = merged.find((track) => String(track._id) === String(rootId));
    const rootOwnership = ownershipByTrackId.get(String(rootId));
    if (!root || !rootOwnership) return null;
    const selectedIds = action.kind === "track.delete"
      ? collectDeletedTrackIdsV1(merged.map((track) => ({
          id: String(track._id), index: track.index, groupId: track.groupId ? String(track.groupId) : undefined,
          outputTargetId: track.outputTargetId ? String(track.outputTargetId) : undefined,
          sends: track.sends.map((send) => ({ targetTrackId: String(send.targetId) })),
        })), String(rootId))
      : new Set([String(rootId)]);
    const normalizedStates = merged.map((track): NormalizedTrackControlStateV1 => ({
      id: String(track._id),
      index: track.index,
      groupId: track.groupId ? String(track.groupId) : undefined,
      outputTargetId: track.outputTargetId ? String(track.outputTargetId) : undefined,
      sends: track.sends.map((send) => ({
        targetId: String(send.targetId),
        amount: send.amount,
        tap: send.tap,
      })),
    }));
    const selected = merged.filter((track) => selectedIds.has(String(track._id)));
    const clips = (await ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect())
      .filter((clip) => selectedIds.has(String(clip.trackId)));
    const clipOwnerships = await Promise.all(clips.map((clip) => ctx.db.query("ownerships").withIndex("by_clip", (q) => q.eq("clipId", clip._id)).unique()));
    if (clipOwnerships.some((ownership) => !ownership)) return null;
    const effects = (await ctx.db.query("effects").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect())
      .filter((effect) => effect.targetType === "track" && effect.trackId && selectedIds.has(String(effect.trackId)));
    const automation = (await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", input.projectId)).collect())
      .filter((row) => row.trackId && selectedIds.has(String(row.trackId)));
    const sidechains = (await ctx.db.query("sidechainRoutes").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect())
      .filter((row) => selectedIds.has(String(row.sourceTrackId)) || selectedIds.has(String(row.targetTrackId)));
    const entityBundle = {
      tracks: selected.map((track) => {
        const ownership = ownershipByTrackId.get(String(track._id));
        if (!ownership) throw new Error("Track ownership is unavailable.");
        return { id: String(track._id), track: trackStatePayload(track), ownership: ownershipPayload(ownership) };
      }),
      clips: clips.map((clip, index) => ({
        id: String(clip._id), clip: clipPayload(clip), ownership: ownershipPayload(clipOwnerships[index]!),
      })),
      effects: effects.map((effect) => ({ id: String(effect._id), effect: effectPayload(effect) })),
      automation: automation.map((row) => ({ id: String(row._id), automation: automationPayload(row) })),
      sidechains: sidechains.map((row) => ({ id: String(row._id), sidechain: sidechainPayload(row) })),
    };
    if (action.kind === "track.delete") {
      const afterById = new Map(
        deriveTrackDeletionAfterStatesV1(normalizedStates, selectedIds)
          .map((state) => [state.id, state]),
      );
      return {
        rootTrackId: String(rootId),
        ...entityBundle,
        survivors: merged.flatMap((track): RecoveryTrackTransition[] => {
          if (selectedIds.has(String(track._id))) return [];
          const before = trackStatePayload(track);
          const afterState = afterById.get(String(track._id));
          if (!afterState) throw new Error("Track deletion recovery state is unavailable.");
          const after = postDeleteTrackState(before, afterState);
          return sameRecoverySurvivorState(recoverySurvivorState(before), recoverySurvivorState(after))
            ? []
            : [{ id: String(track._id), before, after }];
        }),
      };
    }
    if (root.channelRole !== "group" || clips.length > 0) return null;
    const children = merged.filter((track) => String(track.groupId) === String(rootId));
    const afterById = new Map(
      deriveTrackUngroupAfterStatesV1(normalizedStates, {
        groupId: String(rootId),
        groupIndex: root.index,
        parentGroupId: root.groupId ? String(root.groupId) : undefined,
      }).map((state) => [state.id, state]),
    );
    return {
      groupId: String(rootId),
      ...entityBundle,
      children: children.map((child) => {
        const before = trackStatePayload(child);
        const afterState = afterById.get(String(child._id));
        if (!afterState) throw new Error("Track ungroup recovery state is unavailable.");
        return {
          id: String(child._id),
          before,
          after: postDeleteTrackState(before, afterState),
        };
      }),
    };
  }
  if (action.kind === "clip.delete") {
    const clipId = input.resolveRef("clips", action.clip);
    const clip = await ctx.db.get(clipId);
    const ownership = clip
      ? await ctx.db.query("ownerships").withIndex("by_clip", (q) => q.eq("clipId", clipId)).unique()
      : null;
    return clip && ownership ? { clip: clipPayload(clip), clipId: String(clip._id), ownership: ownershipPayload(ownership) } : null;
  }
  if (action.kind === "asset.delete") {
    const asset = await ctx.db.query("samples").withIndex("by_room_assetKey", (q) => (
      q.eq("projectId", input.projectId).eq("assetKey", action.asset.id)
    )).unique();
    return asset ? { asset: assetPayload(asset), assetId: asset.assetKey } : null;
  }
  if (action.kind === "automation.delete") {
    const trackId = action.target.kind === "track" ? input.resolveRef("tracks", action.target.track) : undefined;
    const effect = action.effect === undefined ? undefined : await ctx.db.get(input.resolveRef("effects", action.effect));
    const rows = await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", input.projectId)).collect();
    const row = rows.find((entry) => (
      entry.targetKind === action.target.kind
      && String(entry.trackId ?? "") === String(trackId ?? "")
      && entry.effectInstanceId === effect?.instanceId
      && entry.parameterId === action.parameterId
    ));
    return row ? { automation: automationPayload(row), automationId: String(row._id) } : null;
  }
  if (action.kind === "sidechain.remove") {
    const targetTrackId = input.resolveRef("tracks", action.target);
    const effect = await ctx.db.get(input.resolveRef("effects", action.effect));
    const effectInstanceId = effect?.instanceId;
    const row = effectInstanceId === undefined
      ? null
      : await ctx.db.query("sidechainRoutes").withIndex("by_room_target_effect", (q) => (
        q.eq("projectId", input.projectId).eq("targetTrackId", targetTrackId).eq("effectInstanceId", effectInstanceId)
      )).unique();
    return row ? { sidechain: sidechainPayload(row), sidechainId: String(row._id) } : null;
  }
  const trackId = action.kind === "effect.remove"
    ? action.target.kind === "track" ? input.resolveRef("tracks", action.target.track) : undefined
    : input.resolveRef("tracks", action.target.track);
  const effects = action.kind === "effect.remove"
    ? [await ctx.db.get(input.resolveRef("effects", action.effect))].filter((row): row is Doc<"effects"> => row !== null)
    : (await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", trackId)).collect())
      .filter((row) => row.targetType === "track" && (
        action.kind === "instrument.remove"
          ? row.type === "instrument" || row.type === "synth"
          : row.type === "arpeggiator"
      ));
  if (effects.length === 0) return null;
  const automationRows = await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", input.projectId)).collect();
  const automation = action.kind === "effect.remove"
    ? automationRows.filter((row) => effects.some((effect) => (
      row.effectInstanceId === effect.instanceId
      && row.targetKind === effect.targetType
      && (effect.targetType === "master" || String(row.trackId) === String(effect.trackId))
    )))
    : action.kind === "instrument.remove" ? removeInstrumentAutomation(automationRows, effects) : [];
  const sidechains = action.kind === "effect.remove"
    ? (await ctx.db.query("sidechainRoutes").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect())
      .filter((row) => effects.some((effect) => (
        effect.targetType === "track" && row.targetTrackId === effect.trackId && row.effectInstanceId === effect.instanceId
      )))
    : [];
  return {
    effects: effects.map((row) => ({ id: String(row._id), effect: effectPayload(row) })),
    automation: automation.map((row) => ({ id: String(row._id), automation: automationPayload(row) })),
    sidechains: sidechains.map((row) => ({ id: String(row._id), sidechain: sidechainPayload(row) })),
  };
};

const impact = (payload: RecoveryPayload) => {
  const data = payload.data;
  const bundle = "effects" in data ? data : undefined;
  const trackBundle = payload.kind === "track.delete" || payload.kind === "track.ungroup"
    ? payload.data
    : undefined;
  const rangeBundle = payload.kind === "timeline.range.delete" ? payload.data : undefined;
  return {
    tracks: trackBundle?.tracks.length ?? 0,
    clips: payload.kind === "clip.delete"
      ? 1
      : rangeBundle
        ? rangeBundle.deletedClips.length + rangeBundle.updatedClips.length + rangeBundle.createdClips.length
        : (trackBundle?.clips.length ?? 0),
    processors: bundle?.effects.length ?? 0,
    automation: rangeBundle?.automation.length ?? bundle?.automation.length ?? 0,
    sidechains: bundle?.sidechains.length ?? 0,
    assets: payload.kind === "asset.delete" ? 1 : 0,
  };
};

const pruneRecoveries = async (ctx: RecoveryCtx, projectId: string, actorSubject: string) => {
  const now = Date.now();
  const projectRows = await ctx.db.query("controlRecoveries")
    .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId)).order("asc").take(maxRecoveriesPerProject + 1);
  const actorRows = await ctx.db.query("controlRecoveries")
    .withIndex("by_project_actor_createdAt", (q) => q.eq("projectId", projectId).eq("actorSubject", actorSubject))
    .order("asc").take(maxRecoveriesPerActorProject + 1);
  const deleted = new Set<string>();
  const remove = async (row: Doc<"controlRecoveries">) => {
    if (deleted.has(String(row._id))) return;
    deleted.add(String(row._id));
    await ctx.db.delete(row._id);
  };
  for (const row of [...projectRows, ...actorRows]) {
    if (row.expiresAt <= now || row.consumedAt !== undefined) await remove(row);
  }
  const activeProject = await ctx.db.query("controlRecoveries")
    .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId)).order("asc").collect();
  const activeActor = activeProject.filter((row) => row.actorSubject === actorSubject);
  for (const row of activeProject.slice(0, Math.max(0, activeProject.length - maxRecoveriesPerProject + 1))) await remove(row);
  for (const row of activeActor.slice(0, Math.max(0, activeActor.length - maxRecoveriesPerActorProject + 1))) await remove(row);
};

export const createRecovery = async (
  ctx: RecoveryCtx,
  input: { projectId: string; actorSubject: string; sourceActionIndex: number; kind: RecoveryPayload["kind"]; data: unknown },
) => {
  if (!recoveryKinds.has(input.kind)) return null;
  const data = JSON.parse(JSON.stringify(input.data));
  const validated = recoveryCapturedPayloadSchemaV2.parse({ version: 2, kind: input.kind, data });
  const payload = canonicalCapturedRecoveryPayloadV2(validated);
  await pruneRecoveries(ctx, input.projectId, input.actorSubject);
  const createdAt = Date.now();
  const expiresAt = createdAt + recoveryLifetimeMs;
  const id = await ctx.db.insert("controlRecoveries", {
    projectId: input.projectId,
    actorSubject: input.actorSubject,
    sourceActionIndex: input.sourceActionIndex,
    kind: input.kind,
    payload,
    payloadHash: await hashRecoveryPayloadV1(payload),
    impact: impact(validated),
    createdAt,
    expiresAt,
  });
  return { id: String(id), kind: input.kind, expiresAt };
};

export const loadRecovery = async (
  ctx: RecoveryCtx,
  input: { projectId: string; id: string },
): Promise<{ row: Doc<"controlRecoveries">; payload: RecoveryPayload }> => {
  const id = ctx.db.normalizeId("controlRecoveries", input.id);
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.projectId !== input.projectId || row.consumedAt !== undefined || row.expiresAt <= Date.now()) {
    throw new Error("Recovery is unavailable.");
  }
  if (await hashRecoveryPayloadV1(row.payload) !== row.payloadHash) throw new Error("Recovery payload integrity check failed.");
  let payload;
  try {
    payload = parseStoredRecoveryPayload(row.payload);
  } catch {
    throw new Error("Recovery payload is invalid.");
  }
  if (payload.kind !== row.kind || !recoveryKinds.has(payload.kind)) throw new Error("Recovery payload is invalid.");
  return { row, payload };
};

const requireTrack = async (ctx: RecoveryCtx, projectId: string, trackId: string, actionIndex?: number) => {
  const id = ctx.db.normalizeId("tracks", trackId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.projectId !== projectId) {
    if (actionIndex !== undefined) throw new ControlDomainError("not-found", "Recovery target track is unavailable.", actionIndex);
    throw new Error("Recovery target track is unavailable.");
  }
  return row;
};

const ensureEffectTarget = async (ctx: RecoveryCtx, projectId: string, effect: RecoveryEffect, actionIndex: number) => {
  const track = effect.target.kind === "track"
    ? await requireTrack(ctx, projectId, effect.target.trackId, actionIndex)
    : undefined;
  const rows = effect.target.kind === "master"
    ? await ctx.db.query("effects").withIndex("by_room_target", (q) => q.eq("projectId", projectId).eq("targetType", "master")).collect()
    : await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", track?._id)).collect();
  const effectKind = effect.processor.kind;
  const singleton = effectKind === "instrument" || effectKind === "synth" || effectKind === "arpeggiator";
  if (rows.some((row) => (
    singleton
      ? row.type === effectKind || effectKind === "instrument" && row.type === "synth"
      : row.type === effectKind && row.instanceId === effect.instanceId
  ))) {
    throw new ControlDomainError("validation", "Recovery processor collides with current state.", actionIndex);
  }
  for (const row of rows) {
    if (row.index >= effect.index) await ctx.db.patch(row._id, { index: row.index + 1 });
  }
  return track;
};

const restoreEffectBundle = async (
  ctx: RecoveryCtx,
  projectId: string,
  data: EffectBundle,
  mappings: Mapping[],
  actionIndex: number,
) => {
  for (const item of data.effects) {
    const track = await ensureEffectTarget(ctx, projectId, item.effect, actionIndex);
    const instrument = normalizePersistedInstrumentParams(
      item.effect.processor.kind,
      item.effect.instanceId ?? null,
      item.effect.processor.params,
    );
    const id = await ctx.db.insert("effects", {
      projectId: item.effect.projectId,
      targetType: item.effect.target.kind,
      trackId: track === undefined ? undefined : track._id,
      index: item.effect.index,
      type: instrument ? "instrument" : item.effect.processor.kind,
      instanceId: item.effect.instanceId,
      params: instrument ?? item.effect.processor.params,
      createdAt: item.effect.createdAt,
    });
    mappings.push({ entity: "effect", sourceId: item.id, restoredId: String(id) });
  }
  for (const item of data.automation) {
    const automation = item.automation;
    const track = automation.trackId === undefined ? undefined : await requireTrack(ctx, projectId, automation.trackId, actionIndex);
    const existing = await ctx.db.query("automationEnvelopes").withIndex("by_project_target_key", (q) => (
      q.eq("projectId", projectId).eq("targetKey", automation.targetKey)
    )).unique();
    if (existing) throw new ControlDomainError("validation", "Recovery automation target collides with current state.", actionIndex);
    const id = await ctx.db.insert("automationEnvelopes", {
      projectId: automation.projectId,
      targetKind: automation.targetKind,
      trackId: track === undefined ? undefined : track._id,
      effectInstanceId: automation.effectInstanceId,
      targetKey: automation.targetKey,
      parameterId: automation.parameterId,
      enabled: automation.enabled,
      points: automation.points,
      updatedAt: automation.updatedAt,
    });
    mappings.push({ entity: "automation", sourceId: item.id, restoredId: String(id) });
  }
  for (const item of data.sidechains) {
    const sidechain = item.sidechain;
    const sourceTrack = await requireTrack(ctx, projectId, sidechain.sourceTrackId, actionIndex);
    const targetTrack = await requireTrack(ctx, projectId, sidechain.targetTrackId, actionIndex);
    const targetEffect = (await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", targetTrack._id)).collect())
      .find((effect) => effect.projectId === projectId && effect.instanceId === sidechain.effectInstanceId);
    const eligibility = sidechainEligibilityError({
      sourceTrackId: String(sourceTrack._id),
      targetTrackId: String(targetTrack._id),
      effectTargetTrackId: targetEffect?.trackId === undefined ? undefined : String(targetEffect.trackId),
      effectKind: targetEffect?.type ?? "",
      effectInstanceId: targetEffect?.instanceId,
    });
    if (eligibility) throw new ControlDomainError("validation", eligibility, actionIndex);
    const existing = await ctx.db.query("sidechainRoutes").withIndex("by_room_target_effect", (q) => (
      q.eq("projectId", projectId).eq("targetTrackId", targetTrack._id).eq("effectInstanceId", sidechain.effectInstanceId)
    )).unique();
    if (existing) throw new ControlDomainError("validation", "Recovery sidechain target collides with current state.", actionIndex);
    const id = await ctx.db.insert("sidechainRoutes", {
      projectId: sidechain.projectId,
      sourceTrackId: sourceTrack._id,
      targetTrackId: targetTrack._id,
      effectInstanceId: sidechain.effectInstanceId,
    });
    mappings.push({ entity: "sidechain", sourceId: item.id, restoredId: String(id) });
  }
};

const restoredTrackId = (ctx: RecoveryCtx, map: Map<string, Id<"tracks">>, id: string | undefined) => {
  if (id === undefined) return undefined;
  return map.get(id) ?? ctx.db.normalizeId("tracks", id) ?? undefined;
};

const restoreTrackBundle = async (
  ctx: RecoveryCtx,
  input: {
    projectId: string;
    data: TrackBundleRecoveryData;
    survivors: RecoveryTrackTransition[];
    actionIndex: number;
  },
  mappings: Mapping[],
) => {
  const existingTracks = await ctx.db.query("tracks").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect();
  const channels = await ctx.db.query("mixerChannels").withIndex("by_room", (q) => q.eq("projectId", input.projectId)).collect();
  const channelByTrackId = new Map(channels.map((channel) => [String(channel.trackId), channel]));
  for (const entry of input.data.tracks) {
    const originalId = ctx.db.normalizeId("tracks", entry.id);
    if (originalId && await ctx.db.get(originalId)) {
      throw new ControlDomainError("validation", "Recovery track collides with current state.", input.actionIndex);
    }
  }
  for (const survivor of input.survivors) {
    const track = existingTracks.find((entry) => String(entry._id) === survivor.id);
    const channel = track ? channelByTrackId.get(survivor.id) : undefined;
    if (!track || !channel || !sameRecoverySurvivorState(mergedRecoveryRoutingState(track, channel), recoverySurvivorState(survivor.after))) {
      throw new ControlDomainError("validation", "Recovery state has drifted.", input.actionIndex);
    }
  }
  const restoredSourceIds = new Set(input.data.tracks.map((entry) => entry.id));
  const validateRoutingTargets = async (state: RecoveryTrackState) => {
    const validate = async (targetId: string | undefined, message: string, groupOnly = false) => {
      if (!targetId || restoredSourceIds.has(targetId)) return;
      const target = await requireRecoveryTrackTarget(
        ctx,
        input.projectId,
        ctx.db.normalizeId("tracks", targetId) ?? undefined,
        input.actionIndex,
        message,
      );
      const channel = channelByTrackId.get(String(target._id));
      if (groupOnly && channel?.channelRole !== "group") {
        throw new ControlDomainError("validation", "Recovery group target must be a group track.", input.actionIndex);
      }
    };
    await validate(state.groupId, "Recovery group target is unavailable.", true);
    await validate(state.mixer.outputTargetId, "Recovery output target is unavailable.");
    for (const send of state.mixer.sends) await validate(send.targetId, "Recovery routing target is unavailable.");
  };
  for (const entry of input.data.tracks) await validateRoutingTargets(entry.track);
  for (const survivor of input.survivors) await validateRoutingTargets(survivor.before);
  const trackIds = new Map<string, Id<"tracks">>();
  const mergedOrder = mergeRecoveryTrackOrderV1(
    existingTracks.map((track) => ({ id: String(track._id), index: track.index })),
    input.data.tracks.map((entry) => ({ id: entry.id, index: entry.track.index })),
  );
  const finalIndexById = new Map(mergedOrder.map((entry) => [entry.id, entry.index]));
  for (const track of existingTracks) {
    const index = finalIndexById.get(String(track._id));
    if (index !== undefined && track.index !== index) await ctx.db.patch(track._id, { index });
  }
  for (const entry of [...input.data.tracks].sort((left, right) => left.track.index - right.track.index || left.id.localeCompare(right.id))) {
    const index = finalIndexById.get(entry.id);
    if (index === undefined) throw new Error("Recovery track order is unavailable.");
    const id = await ctx.db.insert("tracks", {
      projectId: entry.track.projectId,
      name: entry.track.name,
      index,
      kind: entry.track.kind,
      historyRef: entry.track.historyRef,
      collapsed: entry.track.collapsed,
      color: entry.track.color,
    });
    trackIds.set(entry.id, id);
    mappings.push({ entity: "track", sourceId: entry.id, restoredId: String(id) });
  }
  const resolve = (id: string | undefined) => restoredTrackId(ctx, trackIds, id);
  for (const entry of input.data.tracks) {
    const id = trackIds.get(entry.id);
    if (!id) throw new Error("Recovery track mapping is unavailable.");
    const groupId = resolve(entry.track.groupId);
    const outputTargetId = resolve(entry.track.mixer.outputTargetId);
    const sends = entry.track.mixer.sends.map((send) => {
      const targetId = resolve(send.targetId);
      if (!targetId) throw new ControlDomainError("not-found", "Recovery routing target is unavailable.", input.actionIndex);
      return { targetId, amount: send.amount, tap: send.tap };
    });
    if (entry.track.groupId && !groupId) throw new ControlDomainError("not-found", "Recovery group target is unavailable.", input.actionIndex);
    if (entry.track.mixer.outputTargetId && !outputTargetId) throw new ControlDomainError("not-found", "Recovery output target is unavailable.", input.actionIndex);
    await ctx.db.patch(id, groupId === undefined ? {} : { groupId });
    await ctx.db.insert("mixerChannels", {
      projectId: entry.track.projectId, trackId: id, volume: entry.track.mixer.volume,
      muted: entry.track.mixer.muted,
      soloed: entry.track.mixer.soloed,
      channelRole: entry.track.mixer.channelRole,
      outputTargetId,
      sends,
    });
    const ownership = requireCloudRecoveryOwnership(entry.ownership, input.actionIndex);
    await ctx.db.insert("ownerships", {
      projectId: ownership.projectId,
      ownerUserId: ownership.ownerUserId,
      role: ownership.role, trackId: id,
    });
  }
  for (const survivor of input.survivors) {
    const id = ctx.db.normalizeId("tracks", survivor.id);
    const channel = id ? channelByTrackId.get(survivor.id) : undefined;
    if (!id || !channel) throw new Error("Recovery survivor mapping is unavailable.");
    const groupId = resolve(survivor.before.groupId);
    const outputTargetId = resolve(survivor.before.mixer.outputTargetId);
    const sends = survivor.before.mixer.sends.map((send) => {
      const targetId = resolve(send.targetId);
      if (!targetId) throw new ControlDomainError("not-found", "Recovery routing target is unavailable.", input.actionIndex);
      return { targetId, amount: send.amount, tap: send.tap };
    });
    await ctx.db.patch(id, groupId === undefined ? { groupId: undefined } : { groupId });
    await ctx.db.patch(channel._id, {
      ...(outputTargetId === undefined ? { outputTargetId: undefined } : { outputTargetId }),
      sends,
    });
  }
  for (const item of input.data.effects) {
    const effect = item.effect;
    const trackId = effect.target.kind === "track" ? resolve(effect.target.trackId) : undefined;
    if (effect.target.kind === "track" && !trackId) throw new ControlDomainError("not-found", "Recovery processor target is unavailable.", input.actionIndex);
    const targetRows = effect.target.kind === "master"
      ? await ctx.db.query("effects").withIndex("by_room_target", (q) => q.eq("projectId", input.projectId).eq("targetType", "master")).collect()
      : await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", trackId)).collect();
    const singleton = effect.processor.kind === "instrument" || effect.processor.kind === "synth" || effect.processor.kind === "arpeggiator";
    if (targetRows.some((row) => (
      singleton
        ? row.type === effect.processor.kind || effect.processor.kind === "instrument" && row.type === "synth"
        : effect.instanceId !== undefined && row.instanceId === effect.instanceId
    ))) throw new ControlDomainError("validation", "Recovery processor collides with current state.", input.actionIndex);
    const instrument = normalizePersistedInstrumentParams(effect.processor.kind, effect.instanceId ?? null, effect.processor.params);
    const id = await ctx.db.insert("effects", {
      projectId: effect.projectId, targetType: effect.target.kind, trackId,
      index: effect.index, type: instrument ? "instrument" : effect.processor.kind,
      instanceId: effect.instanceId,
      params: instrument ?? effect.processor.params, createdAt: effect.createdAt,
    });
    mappings.push({ entity: "effect", sourceId: item.id, restoredId: String(id) });
  }
  for (const item of input.data.clips) {
    const clip = item.clip;
    const trackId = resolve(clip.trackId);
    if (!trackId) throw new ControlDomainError("not-found", "Recovery clip target is unavailable.", input.actionIndex);
    const normalizedClip = clip.midi === undefined ? clip : { ...clip, midi: normalizeLegacyMidiClip(clip.midi) };
    const source = await authoritativeClipSourceFields(ctx, input.projectId, clip);
    const id = await ctx.db.insert("clips", { ...normalizedClip, ...source, trackId });
    const ownership = requireCloudRecoveryOwnership(item.ownership, input.actionIndex);
    await ctx.db.insert("ownerships", {
      projectId: ownership.projectId,
      ownerUserId: ownership.ownerUserId,
      role: ownership.role, clipId: id,
    });
    mappings.push({ entity: "clip", sourceId: item.id, restoredId: String(id) });
  }
  for (const item of input.data.automation) {
    const automation = item.automation;
    const trackId = resolve(automation.trackId);
    if (automation.trackId && !trackId) throw new ControlDomainError("not-found", "Recovery automation target is unavailable.", input.actionIndex);
    const parameterId = rebasedAutomationParameterId(
      automation.parameterId,
      trackId === undefined ? undefined : String(trackId),
    );
    const targetKey = automationTargetKey(
      automation.targetKind === "master"
        ? { kind: "master", effectInstanceId: automation.effectInstanceId }
        : { kind: "track", trackId: String(trackId), effectInstanceId: automation.effectInstanceId },
      parameterId,
    );
    const existing = await ctx.db.query("automationEnvelopes").withIndex("by_project_target_key", (q) => q.eq("projectId", input.projectId).eq("targetKey", targetKey)).unique();
    if (existing) throw new ControlDomainError("validation", "Recovery automation target collides with current state.", input.actionIndex);
    const id = await ctx.db.insert("automationEnvelopes", {
      projectId: automation.projectId, targetKind: automation.targetKind, trackId,
      effectInstanceId: automation.effectInstanceId,
      targetKey, parameterId, enabled: automation.enabled, points: automation.points, updatedAt: automation.updatedAt,
    });
    mappings.push({ entity: "automation", sourceId: item.id, restoredId: String(id) });
  }
  for (const item of input.data.sidechains) {
    const sidechain = item.sidechain;
    const sourceTrackId = resolve(sidechain.sourceTrackId);
    const targetTrackId = resolve(sidechain.targetTrackId);
    if (!sourceTrackId || !targetTrackId) throw new ControlDomainError("not-found", "Recovery sidechain target is unavailable.", input.actionIndex);
    const targetEffect = (await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", targetTrackId)).collect())
      .find((effect) => effect.projectId === input.projectId && effect.instanceId === sidechain.effectInstanceId);
    const eligibility = sidechainEligibilityError({
      sourceTrackId: String(sourceTrackId),
      targetTrackId: String(targetTrackId),
      effectTargetTrackId: targetEffect?.trackId === undefined ? undefined : String(targetEffect.trackId),
      effectKind: targetEffect?.type ?? "",
      effectInstanceId: targetEffect?.instanceId,
    });
    if (eligibility) throw new ControlDomainError("validation", eligibility, input.actionIndex);
    const existing = await ctx.db.query("sidechainRoutes").withIndex("by_room_target_effect", (q) => (
      q.eq("projectId", input.projectId).eq("targetTrackId", targetTrackId).eq("effectInstanceId", sidechain.effectInstanceId)
    )).unique();
    if (existing) throw new ControlDomainError("validation", "Recovery sidechain target collides with current state.", input.actionIndex);
    const id = await ctx.db.insert("sidechainRoutes", { projectId: sidechain.projectId, sourceTrackId, targetTrackId, effectInstanceId: sidechain.effectInstanceId });
    mappings.push({ entity: "sidechain", sourceId: item.id, restoredId: String(id) });
  }
};

type RangeRecoveryData = Extract<RecoveryPayload, { kind: "timeline.range.delete" }>["data"];

const authoritativeClipSourceFields = async (
  ctx: RecoveryCtx,
  projectId: string,
  clip: RecoveryClipSource,
) => {
  if (clip.midi !== undefined) return {
    sourceAssetKey: undefined,
    sourceKind: undefined,
    sourceDurationSec: undefined,
    sourceSampleRate: undefined,
    sourceChannelCount: undefined,
    sampleUrl: undefined,
  };
  if (!clip.sourceAssetKey) return {
    sourceAssetKey: undefined,
    sourceKind: sanitizeAudioSourceKind(clip.sourceKind),
    sourceDurationSec: clip.sourceDurationSec,
    sourceSampleRate: clip.sourceSampleRate,
    sourceChannelCount: clip.sourceChannelCount,
    sampleUrl: clip.sampleUrl,
  };
  const asset = await findSampleRow(ctx, { projectId, assetKey: clip.sourceAssetKey });
  if (
    asset
    && sanitizeAudioSourceKind(asset.sourceKind) !== undefined
    && asset.duration !== undefined
    && asset.sampleRate !== undefined
    && asset.channelCount !== undefined
  ) {
    return {
      sourceAssetKey: asset.assetKey,
      sourceKind: sanitizeAudioSourceKind(asset.sourceKind),
      sourceDurationSec: asset.duration,
      sourceSampleRate: asset.sampleRate,
      sourceChannelCount: asset.channelCount,
      sampleUrl: canonicalSampleUrl(projectId, asset.assetKey),
    };
  }
  return {
    sourceAssetKey: clip.sourceAssetKey,
    sourceKind: sanitizeAudioSourceKind(clip.sourceKind),
    sourceDurationSec: clip.sourceDurationSec,
    sourceSampleRate: clip.sourceSampleRate,
    sourceChannelCount: clip.sourceChannelCount,
    sampleUrl: clip.sampleUrl,
  };
};

const restoredClipFields = async (
  ctx: RecoveryCtx,
  projectId: string,
  clip: RangeRecoveryData["updatedClips"][number]["before"],
  trackId: Id<"tracks">,
) => {
  const midi = clip.midi === undefined ? undefined : normalizeLegacyMidiClip(clip.midi);
  const source = await authoritativeClipSourceFields(ctx, projectId, clip);
  return {
    projectId: clip.projectId,
    trackId,
    historyRef: clip.historyRef,
    startSec: clip.startSec,
    duration: clip.duration,
    ...source,
    leftPadSec: clip.leftPadSec,
    bufferOffsetSec: clip.bufferOffsetSec,
    audioWarp: clip.audioWarp,
    gain: clip.gain,
    fades: clip.fades,
    color: clip.color,
    name: clip.name,
    midi,
    midiOffsetBeats: clip.midiOffsetBeats,
  };
};

const restoreTimelineRange = async (
  ctx: RecoveryCtx,
  input: { projectId: string; data: RangeRecoveryData; actionIndex: number },
  mappings: Mapping[],
) => {
  for (const trackId of input.data.range.trackIds) await requireTrack(ctx, input.projectId, trackId, input.actionIndex);
  const snapshot = await readProjectControlSnapshotV2(ctx, input.projectId);
  const snapshotClipById = new Map(snapshot.clips.map((clip) => [clip.id, clip]));
  for (const deletion of input.data.deletedClips) {
    const originalId = ctx.db.normalizeId("clips", deletion.id);
    if (originalId && await ctx.db.get(originalId)) {
      throw new ControlDomainError("validation", "Recovery clip collides with current state.", input.actionIndex);
    }
    if (!isCloudRecoveryOwnershipV1(deletion.ownership)) {
      throw new ControlDomainError("validation", "Local recovery ownership cannot be restored to cloud.", input.actionIndex);
    }
  }
  for (const update of input.data.updatedClips) {
    const current = snapshotClipById.get(update.id);
    if (!current || timelineRangeRecoveryClipDigestV2(current) !== update.expectedAfterDigest) {
      throw new ControlDomainError("validation", "Recovery state has drifted.", input.actionIndex);
    }
  }
  const selectedTrackIds = new Set(input.data.range.trackIds);
  for (const creation of input.data.createdClips) {
    const current = snapshotClipById.get(creation.id);
    const id = ctx.db.normalizeId("clips", creation.id);
    const ownership = id ? await ctx.db.query("ownerships").withIndex("by_clip", (q) => q.eq("clipId", id)).unique() : null;
    if (
      !current || !selectedTrackIds.has(current.trackId)
      || timelineRangeRecoveryClipDigestV2(current) !== creation.expectedAfterDigest
      || !ownership || timelineRangeRecoveryOwnershipDigestV2(ownershipPayload(ownership)) !== creation.expectedOwnershipDigest
    ) throw new ControlDomainError("validation", "Recovery state has drifted.", input.actionIndex);
  }
  for (const update of input.data.automation) {
    const currentId = ctx.db.normalizeId("automationEnvelopes", update.id);
    const row = currentId ? await ctx.db.get(currentId) : null;
    const current = row && row.projectId === input.projectId
      ? snapshot.automation.find((automation) => (
          ("master" in automation.target ? "master" : "track") === row.targetKind
          && String("trackId" in automation.target ? automation.target.trackId : "") === String(row.trackId ?? "")
          && automation.effectInstanceId === row.effectInstanceId
          && automation.parameterId === row.parameterId
        ))
      : undefined;
    if (!current || timelineRangeRecoveryAutomationDigestV2(current) !== update.expectedAfterDigest) {
      throw new ControlDomainError("validation", "Recovery state has drifted.", input.actionIndex);
    }
  }
  for (const creation of input.data.createdClips) {
    const id = ctx.db.normalizeId("clips", creation.id);
    if (!id) throw new Error("Range recovery clip mapping is unavailable.");
    const clipOwnership = await ctx.db.query("ownerships").withIndex("by_clip", (q) => q.eq("clipId", id)).unique();
    if (!clipOwnership) throw new Error("Range recovery clip ownership is unavailable.");
    await ctx.db.delete(clipOwnership._id);
    await ctx.db.delete(id);
  }
  for (const update of input.data.updatedClips) {
    const id = ctx.db.normalizeId("clips", update.id);
    const track = await requireTrack(ctx, input.projectId, update.before.trackId, input.actionIndex);
    if (!id) throw new Error("Range recovery clip mapping is unavailable.");
    await ctx.db.patch(id, await restoredClipFields(ctx, input.projectId, update.before, track._id));
  }
  for (const deletion of input.data.deletedClips) {
    const track = await requireTrack(ctx, input.projectId, deletion.before.trackId, input.actionIndex);
    const ownership = deletion.ownership;
    if (!isCloudRecoveryOwnershipV1(ownership)) {
      throw new ControlDomainError("validation", "Local recovery ownership cannot be restored to cloud.", input.actionIndex);
    }
    const id = await ctx.db.insert("clips", await restoredClipFields(ctx, input.projectId, deletion.before, track._id));
    await ctx.db.insert("ownerships", {
      projectId: ownership.projectId,
      ownerUserId: ownership.ownerUserId,
      role: ownership.role,
      clipId: id,
    });
    mappings.push({ entity: "clip", sourceId: deletion.id, restoredId: String(id) });
  }
  for (const update of input.data.automation) {
    const currentId = ctx.db.normalizeId("automationEnvelopes", update.id);
    const current = currentId ? await ctx.db.get(currentId) : null;
    if (!current) throw new Error("Range recovery automation is unavailable.");
    await ctx.db.patch(current._id, {
      enabled: update.before.enabled,
      points: update.before.points,
      updatedAt: Date.now(),
    });
  }
};

export const restoreRecovery = async (
  ctx: RecoveryCtx,
  input: { projectId: string; recovery: Awaited<ReturnType<typeof loadRecovery>>; actionIndex: number },
) => {
  const { row, payload } = input.recovery;
  const mappings: Mapping[] = [];
  if (payload.kind === "track.delete") {
    if (
      payload.data.tracks.some((entry) => !isCloudRecoveryOwnershipV1(entry.ownership))
      || payload.data.clips.some((entry) => !isCloudRecoveryOwnershipV1(entry.ownership))
    ) {
      throw new ControlDomainError("validation", "Local recovery ownership cannot be restored to cloud.", input.actionIndex);
    }
    await restoreTrackBundle(ctx, {
      projectId: input.projectId,
      data: payload.data,
      survivors: payload.data.survivors,
      actionIndex: input.actionIndex,
    }, mappings);
  } else if (payload.kind === "track.ungroup") {
    if (
      payload.data.tracks.some((entry) => !isCloudRecoveryOwnershipV1(entry.ownership))
      || payload.data.clips.some((entry) => !isCloudRecoveryOwnershipV1(entry.ownership))
    ) {
      throw new ControlDomainError("validation", "Local recovery ownership cannot be restored to cloud.", input.actionIndex);
    }
    await restoreTrackBundle(ctx, {
      projectId: input.projectId,
      data: payload.data,
      survivors: payload.data.children.map((child) => ({
        id: child.id, before: child.before, after: child.after,
      })),
      actionIndex: input.actionIndex,
    }, mappings);
  } else if (payload.kind === "timeline.range.delete") {
    await restoreTimelineRange(ctx, {
      projectId: input.projectId,
      data: payload.data,
      actionIndex: input.actionIndex,
    }, mappings);
  } else if (payload.kind === "clip.delete") {
    const data = payload.data;
    if (!isCloudRecoveryOwnershipV1(data.ownership)) {
      throw new ControlDomainError("validation", "Local recovery ownership cannot be restored to cloud.", input.actionIndex);
    }
    const track = await requireTrack(ctx, input.projectId, data.clip.trackId, input.actionIndex);
    const midi = data.clip.midi === undefined ? undefined : normalizeLegacyMidiClip(data.clip.midi);
    const source = await authoritativeClipSourceFields(ctx, input.projectId, data.clip);
    const id = await ctx.db.insert("clips", {
      projectId: data.clip.projectId,
      trackId: track._id,
      startSec: data.clip.startSec,
      duration: data.clip.duration,
      ...source,
      leftPadSec: data.clip.leftPadSec,
      bufferOffsetSec: data.clip.bufferOffsetSec,
      audioWarp: data.clip.audioWarp,
      gain: data.clip.gain,
      fades: data.clip.fades,
      color: data.clip.color,
      name: data.clip.name,
      midi,
      midiOffsetBeats: data.clip.midiOffsetBeats,
    });
    await ctx.db.insert("ownerships", {
      projectId: data.ownership.projectId,
      ownerUserId: data.ownership.ownerUserId,
      role: data.ownership.role,
      clipId: id,
    });
    mappings.push({ entity: "clip", sourceId: data.clipId, restoredId: String(id) });
  } else if (payload.kind === "asset.delete") {
    const data = payload.data;
    const asset = data.asset;
    if (!isCloudRecoveryAssetV1(asset)) {
      throw new ControlDomainError("validation", "Local recovery assets cannot be restored to cloud.", input.actionIndex);
    }
    const existing = await ctx.db.query("samples").withIndex("by_room_assetKey", (q) => (
      q.eq("projectId", input.projectId).eq("assetKey", asset.assetKey)
    )).unique();
    if (existing) throw new ControlDomainError("validation", "Recovery asset key collides with current state.", input.actionIndex);
    const queue = await ctx.db.query("r2DeleteQueue").withIndex("by_key", (q) => q.eq("r2Key", asset.r2Key)).unique();
    if (queue?.status === "deleted") throw new ControlDomainError("not-found", "Recovery asset bytes were already deleted.", input.actionIndex);
    if (queue?.status === "claimed") throw new ControlDomainError("validation", "Recovery asset bytes are being deleted.", input.actionIndex);
    if (queue?.status === "pending") await ctx.db.delete(queue._id);
    const id = await ctx.db.insert("samples", {
      projectId: asset.projectId,
      assetKey: asset.assetKey,
      sourceKind: asset.sourceKind,
      name: asset.name,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      contentSha256: asset.contentSha256,
      r2Key: asset.r2Key,
      duration: asset.duration,
      sampleRate: asset.sampleRate,
      channelCount: asset.channelCount,
      ownerUserId: asset.ownerUserId,
      folderId: asset.folderId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    });
    mappings.push({ entity: "asset", sourceId: data.assetId, restoredId: String(id) });
  } else if (payload.kind === "automation.delete") {
    const data = payload.data;
    const track = data.automation.trackId === undefined ? undefined : await requireTrack(ctx, input.projectId, data.automation.trackId, input.actionIndex);
    const existing = await ctx.db.query("automationEnvelopes").withIndex("by_project_target_key", (q) => (
      q.eq("projectId", input.projectId).eq("targetKey", data.automation.targetKey)
    )).unique();
    if (existing) throw new ControlDomainError("validation", "Recovery automation target collides with current state.", input.actionIndex);
    const id = await ctx.db.insert("automationEnvelopes", {
      projectId: data.automation.projectId,
      targetKind: data.automation.targetKind,
      trackId: track === undefined ? undefined : track._id,
      effectInstanceId: data.automation.effectInstanceId,
      targetKey: data.automation.targetKey,
      parameterId: data.automation.parameterId,
      enabled: data.automation.enabled,
      points: data.automation.points,
      updatedAt: data.automation.updatedAt,
    });
    mappings.push({ entity: "automation", sourceId: data.automationId, restoredId: String(id) });
  } else if (payload.kind === "sidechain.remove") {
    const data = payload.data;
    const sourceTrack = await requireTrack(ctx, input.projectId, data.sidechain.sourceTrackId, input.actionIndex);
    const targetTrack = await requireTrack(ctx, input.projectId, data.sidechain.targetTrackId, input.actionIndex);
    const existing = await ctx.db.query("sidechainRoutes").withIndex("by_room_target_effect", (q) => (
      q.eq("projectId", input.projectId).eq("targetTrackId", targetTrack._id).eq("effectInstanceId", data.sidechain.effectInstanceId)
    )).unique();
    if (existing) throw new ControlDomainError("validation", "Recovery sidechain target collides with current state.", input.actionIndex);
    const id = await ctx.db.insert("sidechainRoutes", {
      projectId: data.sidechain.projectId,
      sourceTrackId: sourceTrack._id,
      targetTrackId: targetTrack._id,
      effectInstanceId: data.sidechain.effectInstanceId,
    });
    mappings.push({ entity: "sidechain", sourceId: data.sidechainId, restoredId: String(id) });
  } else {
    await restoreEffectBundle(ctx, input.projectId, payload.data, mappings, input.actionIndex);
  }
  await ctx.db.patch(row._id, { consumedAt: Date.now() });
  return { actionIndex: input.actionIndex, recoveryId: String(row._id), entities: mappings };
};
