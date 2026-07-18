import {
  canonicalRecoveryPayloadV1,
  hashRecoveryPayloadV1,
  parseRecoveryPayloadV1,
  recoveryPayloadSchemaV1,
  type ControlActionV1,
  type ContextualRefV1,
  type RecoveryPayloadV1,
} from "@daw-browser/control";
import {
  normalizePersistedInstrumentParams,
  parseGranularAutomationKey,
  parseInstrumentAutomationKey,
  parseSynthAutomationKey,
  persistedProcessorSnapshotSchema,
} from "@daw-browser/shared";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ControlDomainError } from "./controlPreflight";

const recoveryLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const maxRecoveriesPerProject = 1000;
const maxRecoveriesPerActorProject = 128;
const recoveryKinds = new Set([
  "clip.delete", "effect.remove", "instrument.remove", "arpeggiator.remove",
  "automation.delete", "sidechain.remove", "asset.delete",
]);

type Mapping = { entity: "clip" | "effect" | "automation" | "sidechain" | "asset"; sourceId: string; restoredId: string };
type RecoveryCtx = Pick<MutationCtx, "db">;
type RecoveryResolver = <TableName extends "tracks" | "clips" | "effects">(
  table: TableName,
  ref: ContextualRefV1,
) => Id<TableName>;
type RecoverableAction = Extract<ControlActionV1, { kind:
  | "clip.delete" | "effect.remove" | "instrument.remove" | "arpeggiator.remove"
  | "automation.delete" | "sidechain.remove" | "asset.delete"
}>;
type EffectBundle = Extract<RecoveryPayloadV1, {
  kind: "effect.remove" | "instrument.remove" | "arpeggiator.remove"
}>["data"];
type RecoveryEffect = EffectBundle["effects"][number]["effect"];

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
  return {
    clips: payload.kind === "clip.delete" ? 1 : 0,
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
  const validated = recoveryPayloadSchemaV1.parse({ version: 1, kind: input.kind, data: input.data });
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

export const restoreRecovery = async (
  ctx: RecoveryCtx,
  input: { projectId: string; recovery: Awaited<ReturnType<typeof loadRecovery>>; actionIndex: number },
) => {
  const { row, payload } = input.recovery;
  const mappings: Mapping[] = [];
  if (payload.kind === "clip.delete") {
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
