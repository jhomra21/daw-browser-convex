import {
  canonicalRecoveryPayloadV1,
  hashRecoveryPayloadV1,
  parseRecoveryPayloadV1,
  recoveryPayloadSchemaV1,
  type ControlActionV1,
  type ContextualRefV1,
  type RecoveryPayloadV1,
  collectDeletedTrackIdsV1,
} from "@daw-browser/control";
import { mergeRecoveryTrackOrderV1 } from "@daw-browser/control/recovery-track-order";
import {
  automationTargetKey,
  granularAutomationKey,
  instrumentAutomationKey,
  normalizePersistedInstrumentParams,
  parseGranularAutomationKey,
  parseInstrumentAutomationKey,
  parseSynthAutomationKey,
  persistedProcessorSnapshotSchema,
  sidechainEligibilityError,
  synthAutomationKey,
} from "@daw-browser/shared";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ControlDomainError } from "./controlPreflight";

const recoveryLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const maxRecoveriesPerProject = 1000;
const maxRecoveriesPerActorProject = 128;
const recoveryKinds = new Set([
  "clip.delete", "effect.remove", "instrument.remove", "arpeggiator.remove",
  "automation.delete", "sidechain.remove", "asset.delete", "track.delete", "track.ungroup",
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
}>;
type EffectBundle = Extract<RecoveryPayloadV1, {
  kind: "effect.remove" | "instrument.remove" | "arpeggiator.remove"
}>["data"];
type RecoveryEffect = EffectBundle["effects"][number]["effect"];

const trackStatePayload = (row: any) => ({
  projectId: row.projectId,
  name: row.name,
  index: row.index,
  ...(row.kind === undefined ? {} : { kind: row.kind }),
  ...(row.historyRef === undefined ? {} : { historyRef: row.historyRef }),
  ...(row.groupId === undefined ? {} : { groupId: String(row.groupId) }),
  ...(row.collapsed === undefined ? {} : { collapsed: row.collapsed }),
  ...(row.color === undefined ? {} : { color: row.color }),
  mixer: {
    volume: row.volume,
    ...(row.muted === undefined ? {} : { muted: row.muted }),
    ...(row.soloed === undefined ? {} : { soloed: row.soloed }),
    channelRole: row.channelRole,
    ...(row.outputTargetId === undefined ? {} : { outputTargetId: String(row.outputTargetId) }),
    sends: row.sends.map((send: any) => ({
      targetId: String(send.targetId),
      amount: send.amount,
      ...(send.tap === undefined ? {} : { tap: send.tap }),
    })),
  },
});

const recoverySurvivorState = (row: any) => ({
  index: row.index,
  ...(row.groupId === undefined ? {} : { groupId: String(row.groupId) }),
  ...(row.mixer?.outputTargetId === undefined && row.outputTargetId === undefined ? {} : {
    outputTargetId: String(row.mixer?.outputTargetId ?? row.outputTargetId),
  }),
  sends: (row.mixer?.sends ?? row.sends).map((send: any) => ({
    targetId: String(send.targetId),
    amount: send.amount,
    ...(send.tap === undefined ? {} : { tap: send.tap }),
  })),
});

const sameRecoverySurvivorState = (left: any, right: any) => (
  JSON.stringify(recoverySurvivorState(left)) === JSON.stringify(recoverySurvivorState(right))
);

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

const postDeleteTrackState = (row: any, deletedIds: Set<string>, index: number) => ({
  ...trackStatePayload(row),
  index,
  ...(deletedIds.has(String(row.groupId)) ? { groupId: undefined } : {}),
  mixer: {
    ...trackStatePayload(row).mixer,
    ...(deletedIds.has(String(row.outputTargetId)) ? { outputTargetId: undefined } : {}),
    sends: row.sends
      .filter((send: any) => !deletedIds.has(String(send.targetId)))
      .map((send: any) => ({
        targetId: String(send.targetId),
        amount: send.amount,
        ...(send.tap === undefined ? {} : { tap: send.tap }),
      })),
  },
});

const clipPayload = (row: Doc<"clips">) => ({
  projectId: row.projectId,
  trackId: String(row.trackId),
  startSec: row.startSec,
  duration: row.duration,
  ...(row.sourceAssetKey === undefined ? {} : { sourceAssetKey: row.sourceAssetKey }),
  ...(row.sourceKind === undefined ? {} : { sourceKind: row.sourceKind }),
  ...(row.sourceDurationSec === undefined ? {} : { sourceDurationSec: row.sourceDurationSec }),
  ...(row.sourceSampleRate === undefined ? {} : { sourceSampleRate: row.sourceSampleRate }),
  ...(row.sourceChannelCount === undefined ? {} : { sourceChannelCount: row.sourceChannelCount }),
  ...(row.leftPadSec === undefined ? {} : { leftPadSec: row.leftPadSec }),
  ...(row.bufferOffsetSec === undefined ? {} : { bufferOffsetSec: row.bufferOffsetSec }),
  ...(row.audioWarp === undefined ? {} : { audioWarp: row.audioWarp }),
  ...(row.gain === undefined ? {} : { gain: row.gain }),
  ...(row.fades === undefined ? {} : { fades: row.fades }),
  ...(row.color === undefined ? {} : { color: row.color }),
  ...(row.name === undefined ? {} : { name: row.name }),
  ...(row.sampleUrl === undefined ? {} : { sampleUrl: row.sampleUrl }),
  ...(row.midi === undefined ? {} : { midi: row.midi }),
  ...(row.midiOffsetBeats === undefined ? {} : { midiOffsetBeats: row.midiOffsetBeats }),
});
const ownershipPayload = (row: Doc<"ownerships">) => ({
  projectId: row.projectId,
  ownerUserId: row.ownerUserId,
  ...(row.role === undefined ? {} : { role: row.role }),
});
const assetPayload = (row: Doc<"samples">) => ({
  projectId: row.projectId,
  assetKey: row.assetKey,
  sourceKind: row.sourceKind,
  name: row.name,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  contentSha256: row.contentSha256,
  r2Key: row.r2Key,
  ...(row.duration === undefined ? {} : { duration: row.duration }),
  ...(row.sampleRate === undefined ? {} : { sampleRate: row.sampleRate }),
  ...(row.channelCount === undefined ? {} : { channelCount: row.channelCount }),
  ownerUserId: row.ownerUserId,
  ...(row.folderId === undefined ? {} : { folderId: row.folderId }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const automationPayload = (row: Doc<"automationEnvelopes">) => ({
  projectId: row.projectId,
  targetKind: row.targetKind,
  ...(row.trackId === undefined ? {} : { trackId: String(row.trackId) }),
  ...(row.effectInstanceId === undefined ? {} : { effectInstanceId: row.effectInstanceId }),
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
  ...(row.instanceId === undefined ? {} : { instanceId: row.instanceId }),
  createdAt: row.createdAt,
});

const removeInstrumentAutomation = (rows: Doc<"automationEnvelopes">[], instruments: Doc<"effects">[]) => {
  const instanceIds = new Set(instruments.flatMap((row) => {
    const instrument = normalizePersistedInstrumentParams(row.type, row.instanceId, row.params);
    return instrument?.instanceId ? [instrument.instanceId] : [];
  }));
  return rows.filter((row) => {
    const key = parseInstrumentAutomationKey(row.parameterId)
      ?? parseGranularAutomationKey(row.parameterId)
      ?? parseSynthAutomationKey(row.parameterId);
    return key !== undefined && instanceIds.has(key.instanceId);
  });
};

export const isRecoverableAction = (action: { kind: string }) => recoveryKinds.has(action.kind);

export const captureRecoveryPayload = async (
  ctx: RecoveryCtx,
  input: { projectId: string; action: RecoverableAction; resolveRef: RecoveryResolver },
) => {
  const { action } = input;
  if (!isRecoverableAction(action)) return null;
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
          id: String(track._id), index: track.index, ...(track.groupId ? { groupId: String(track.groupId) } : {}),
          ...(track.outputTargetId ? { outputTargetId: String(track.outputTargetId) } : {}),
          sends: track.sends.map((send: any) => ({ targetTrackId: String(send.targetId) })),
        })), String(rootId))
      : new Set([String(rootId)]);
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
      const survivors = merged
        .filter((track) => !selectedIds.has(String(track._id)))
        .sort((left, right) => left.index - right.index || String(left._id).localeCompare(String(right._id)));
      return {
        rootTrackId: String(rootId),
        ...entityBundle,
        survivors: survivors.flatMap((track, index) => {
          const before = trackStatePayload(track);
          const after = postDeleteTrackState(track, selectedIds, index);
          return sameRecoverySurvivorState(before, after)
            ? []
            : [{ id: String(track._id), before, after }];
        }),
      };
    }
    if (root.channelRole !== "group" || clips.length > 0) return null;
    const children = merged.filter((track) => String(track.groupId) === String(rootId));
    return {
      groupId: String(rootId),
      ...entityBundle,
      children: children.map((child) => ({
        id: String(child._id),
        before: trackStatePayload(child),
        after: {
          ...trackStatePayload(child),
          index: child.index > root.index ? child.index - 1 : child.index,
          ...(root.groupId ? { groupId: String(root.groupId) } : { groupId: undefined }),
          mixer: {
            ...trackStatePayload(child).mixer,
            ...(String(child.outputTargetId) === String(rootId)
              ? root.groupId ? { outputTargetId: String(root.groupId) } : { outputTargetId: undefined }
              : {}),
          },
        },
      })),
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
    return asset ? { asset: assetPayload(asset), assetId: String(asset._id) } : null;
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

const impact = (payload: RecoveryPayloadV1) => {
  const data = payload.data;
  const bundle = "effects" in data ? data : undefined;
  const trackBundle = payload.kind === "track.delete" || payload.kind === "track.ungroup"
    ? payload.data
    : undefined;
  return {
    tracks: trackBundle?.tracks.length ?? 0,
    clips: payload.kind === "clip.delete" ? 1 : (trackBundle?.clips.length ?? 0),
    processors: bundle?.effects.length ?? 0,
    automation: bundle?.automation.length ?? 0,
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
  input: { projectId: string; actorSubject: string; sourceActionIndex: number; kind: RecoveryPayloadV1["kind"]; data: unknown },
) => {
  if (!recoveryKinds.has(input.kind)) return null;
  const data = JSON.parse(JSON.stringify(input.data));
  const validated = recoveryPayloadSchemaV1.parse({ version: 1, kind: input.kind, data });
  const payload = canonicalRecoveryPayloadV1(validated);
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
): Promise<{ row: Doc<"controlRecoveries">; payload: RecoveryPayloadV1 }> => {
  const id = ctx.db.normalizeId("controlRecoveries", input.id);
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.projectId !== input.projectId || row.consumedAt !== undefined || row.expiresAt <= Date.now()) {
    throw new Error("Recovery is unavailable.");
  }
  if (await hashRecoveryPayloadV1(row.payload) !== row.payloadHash) throw new Error("Recovery payload integrity check failed.");
  let payload;
  try {
    payload = parseRecoveryPayloadV1(row.payload);
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
      item.effect.instanceId,
      item.effect.processor.params,
    );
    const id = await ctx.db.insert("effects", {
      projectId: item.effect.projectId,
      targetType: item.effect.target.kind,
      ...(track === undefined ? {} : { trackId: track._id }),
      index: item.effect.index,
      type: instrument ? "instrument" : item.effect.processor.kind,
      ...(item.effect.instanceId === undefined ? {} : { instanceId: item.effect.instanceId }),
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
      ...(track === undefined ? {} : { trackId: track._id }),
      ...(automation.effectInstanceId === undefined ? {} : { effectInstanceId: automation.effectInstanceId }),
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
    data: any;
    survivors: Array<{ id: string; before: any; after: any }>;
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
    if (!track || !channel || !sameRecoverySurvivorState({ ...track, ...channel, sends: channel.sends }, survivor.after)) {
      throw new ControlDomainError("validation", "Recovery state has drifted.", input.actionIndex);
    }
  }
  const restoredSourceIds = new Set(input.data.tracks.map((entry: any) => entry.id));
  const validateRoutingTargets = async (state: any) => {
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
    input.data.tracks.map((entry: any) => ({ id: entry.id, index: entry.track.index })),
  );
  const finalIndexById = new Map(mergedOrder.map((entry) => [entry.id, entry.index]));
  for (const track of existingTracks) {
    const index = finalIndexById.get(String(track._id));
    if (index !== undefined && track.index !== index) await ctx.db.patch(track._id, { index });
  }
  for (const entry of [...input.data.tracks].sort((left: any, right: any) => left.track.index - right.track.index || left.id.localeCompare(right.id))) {
    const index = finalIndexById.get(entry.id);
    if (index === undefined) throw new Error("Recovery track order is unavailable.");
    const id = await ctx.db.insert("tracks", {
      projectId: entry.track.projectId,
      name: entry.track.name,
      index,
      ...(entry.track.kind === undefined ? {} : { kind: entry.track.kind }),
      ...(entry.track.historyRef === undefined ? {} : { historyRef: entry.track.historyRef }),
      ...(entry.track.collapsed === undefined ? {} : { collapsed: entry.track.collapsed }),
      ...(entry.track.color === undefined ? {} : { color: entry.track.color }),
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
    const sends = entry.track.mixer.sends.map((send: any) => {
      const targetId = resolve(send.targetId);
      if (!targetId) throw new ControlDomainError("not-found", "Recovery routing target is unavailable.", input.actionIndex);
      return { targetId, amount: send.amount, ...(send.tap === undefined ? {} : { tap: send.tap }) };
    });
    if (entry.track.groupId && !groupId) throw new ControlDomainError("not-found", "Recovery group target is unavailable.", input.actionIndex);
    if (entry.track.mixer.outputTargetId && !outputTargetId) throw new ControlDomainError("not-found", "Recovery output target is unavailable.", input.actionIndex);
    await ctx.db.patch(id, groupId === undefined ? {} : { groupId });
    await ctx.db.insert("mixerChannels", {
      projectId: entry.track.projectId, trackId: id, volume: entry.track.mixer.volume,
      ...(entry.track.mixer.muted === undefined ? {} : { muted: entry.track.mixer.muted }),
      ...(entry.track.mixer.soloed === undefined ? {} : { soloed: entry.track.mixer.soloed }),
      channelRole: entry.track.mixer.channelRole,
      ...(outputTargetId === undefined ? {} : { outputTargetId }),
      sends,
    });
    await ctx.db.insert("ownerships", {
      projectId: entry.ownership.projectId, ownerUserId: entry.ownership.ownerUserId,
      ...(entry.ownership.role === undefined ? {} : { role: entry.ownership.role }), trackId: id,
    });
  }
  for (const survivor of input.survivors) {
    const id = ctx.db.normalizeId("tracks", survivor.id);
    const channel = id ? channelByTrackId.get(survivor.id) : undefined;
    if (!id || !channel) throw new Error("Recovery survivor mapping is unavailable.");
    const groupId = resolve(survivor.before.groupId);
    const outputTargetId = resolve(survivor.before.mixer.outputTargetId);
    const sends = survivor.before.mixer.sends.map((send: any) => {
      const targetId = resolve(send.targetId);
      if (!targetId) throw new ControlDomainError("not-found", "Recovery routing target is unavailable.", input.actionIndex);
      return { targetId, amount: send.amount, ...(send.tap === undefined ? {} : { tap: send.tap }) };
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
    const instrument = normalizePersistedInstrumentParams(effect.processor.kind, effect.instanceId, effect.processor.params);
    const id = await ctx.db.insert("effects", {
      projectId: effect.projectId, targetType: effect.target.kind, ...(trackId === undefined ? {} : { trackId }),
      index: effect.index, type: instrument ? "instrument" : effect.processor.kind,
      ...(effect.instanceId === undefined ? {} : { instanceId: effect.instanceId }),
      params: instrument ?? effect.processor.params, createdAt: effect.createdAt,
    });
    mappings.push({ entity: "effect", sourceId: item.id, restoredId: String(id) });
  }
  for (const item of input.data.clips) {
    const clip = item.clip;
    const trackId = resolve(clip.trackId);
    if (!trackId) throw new ControlDomainError("not-found", "Recovery clip target is unavailable.", input.actionIndex);
    const id = await ctx.db.insert("clips", { ...clip, trackId });
    await ctx.db.insert("ownerships", {
      projectId: item.ownership.projectId, ownerUserId: item.ownership.ownerUserId,
      ...(item.ownership.role === undefined ? {} : { role: item.ownership.role }), clipId: id,
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
      projectId: automation.projectId, targetKind: automation.targetKind, ...(trackId === undefined ? {} : { trackId }),
      ...(automation.effectInstanceId === undefined ? {} : { effectInstanceId: automation.effectInstanceId }),
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

export const restoreRecovery = async (
  ctx: RecoveryCtx,
  input: { projectId: string; recovery: Awaited<ReturnType<typeof loadRecovery>>; actionIndex: number },
) => {
  const { row, payload } = input.recovery;
  const mappings: Mapping[] = [];
  if (payload.kind === "track.delete") {
    await restoreTrackBundle(ctx, {
      projectId: input.projectId,
      data: payload.data,
      survivors: payload.data.survivors,
      actionIndex: input.actionIndex,
    }, mappings);
  } else if (payload.kind === "track.ungroup") {
    await restoreTrackBundle(ctx, {
      projectId: input.projectId,
      data: payload.data,
      survivors: payload.data.children.map((child) => ({
        id: child.id, before: child.before, after: child.after,
      })),
      actionIndex: input.actionIndex,
    }, mappings);
  } else if (payload.kind === "clip.delete") {
    const data = payload.data;
    const track = await requireTrack(ctx, input.projectId, data.clip.trackId, input.actionIndex);
    const id = await ctx.db.insert("clips", {
      projectId: data.clip.projectId,
      trackId: track._id,
      startSec: data.clip.startSec,
      duration: data.clip.duration,
      ...(data.clip.sourceAssetKey === undefined ? {} : { sourceAssetKey: data.clip.sourceAssetKey }),
      ...(data.clip.sourceKind === undefined ? {} : { sourceKind: data.clip.sourceKind }),
      ...(data.clip.sourceDurationSec === undefined ? {} : { sourceDurationSec: data.clip.sourceDurationSec }),
      ...(data.clip.sourceSampleRate === undefined ? {} : { sourceSampleRate: data.clip.sourceSampleRate }),
      ...(data.clip.sourceChannelCount === undefined ? {} : { sourceChannelCount: data.clip.sourceChannelCount }),
      ...(data.clip.leftPadSec === undefined ? {} : { leftPadSec: data.clip.leftPadSec }),
      ...(data.clip.bufferOffsetSec === undefined ? {} : { bufferOffsetSec: data.clip.bufferOffsetSec }),
      ...(data.clip.audioWarp === undefined ? {} : { audioWarp: data.clip.audioWarp }),
      ...(data.clip.gain === undefined ? {} : { gain: data.clip.gain }),
      ...(data.clip.fades === undefined ? {} : { fades: data.clip.fades }),
      ...(data.clip.color === undefined ? {} : { color: data.clip.color }),
      ...(data.clip.name === undefined ? {} : { name: data.clip.name }),
      ...(data.clip.sampleUrl === undefined ? {} : { sampleUrl: data.clip.sampleUrl }),
      ...(data.clip.midi === undefined ? {} : { midi: data.clip.midi }),
      ...(data.clip.midiOffsetBeats === undefined ? {} : { midiOffsetBeats: data.clip.midiOffsetBeats }),
    });
    await ctx.db.insert("ownerships", {
      projectId: data.ownership.projectId,
      ownerUserId: data.ownership.ownerUserId,
      ...(data.ownership.role === undefined ? {} : { role: data.ownership.role }),
      clipId: id,
    });
    mappings.push({ entity: "clip", sourceId: data.clipId, restoredId: String(id) });
  } else if (payload.kind === "asset.delete") {
    const data = payload.data;
    const existing = await ctx.db.query("samples").withIndex("by_room_assetKey", (q) => (
      q.eq("projectId", input.projectId).eq("assetKey", data.asset.assetKey)
    )).unique();
    if (existing) throw new ControlDomainError("validation", "Recovery asset key collides with current state.", input.actionIndex);
    const queue = await ctx.db.query("r2DeleteQueue").withIndex("by_key", (q) => q.eq("r2Key", data.asset.r2Key)).unique();
    if (queue?.status === "deleted") throw new ControlDomainError("not-found", "Recovery asset bytes were already deleted.", input.actionIndex);
    if (queue?.status === "claimed") throw new ControlDomainError("validation", "Recovery asset bytes are being deleted.", input.actionIndex);
    if (queue?.status === "pending") await ctx.db.delete(queue._id);
    const id = await ctx.db.insert("samples", {
      projectId: data.asset.projectId,
      assetKey: data.asset.assetKey,
      sourceKind: data.asset.sourceKind,
      name: data.asset.name,
      mimeType: data.asset.mimeType,
      sizeBytes: data.asset.sizeBytes,
      contentSha256: data.asset.contentSha256,
      r2Key: data.asset.r2Key,
      ...(data.asset.duration === undefined ? {} : { duration: data.asset.duration }),
      ...(data.asset.sampleRate === undefined ? {} : { sampleRate: data.asset.sampleRate }),
      ...(data.asset.channelCount === undefined ? {} : { channelCount: data.asset.channelCount }),
      ownerUserId: data.asset.ownerUserId,
      ...(data.asset.folderId === undefined ? {} : { folderId: data.asset.folderId }),
      createdAt: data.asset.createdAt,
      updatedAt: data.asset.updatedAt,
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
      ...(track === undefined ? {} : { trackId: track._id }),
      ...(data.automation.effectInstanceId === undefined ? {} : { effectInstanceId: data.automation.effectInstanceId }),
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
