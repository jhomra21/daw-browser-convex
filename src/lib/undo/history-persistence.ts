import { buildLocalClip } from "~/lib/clip-create";
import { AUDIO_EFFECT_CONTRACTS, assert, buildClipCreatePayload, normalizeAudioWarp, normalizeCompressorParams, normalizeDelayParams, normalizeReverbParams, normalizeSaturatorParams, normalizeSpectralParamsEnvelope, type AutomationEnvelope, type ClipCreateSnapshot } from "@daw-browser/shared";
import { buildClipMoveManyMutationInput, buildClipRemoveManyMutationInput } from "~/lib/clip-mutation-args";
import { persistClipAudioWarp, persistClipTiming, persistClipTimingAndAudioWarp } from "~/lib/clip-mutations";
import { buildTrackEffectMutationInput } from "~/lib/effect-track-args";
import { localEffectRowId, restoreLocalTrackEffectChain, setLocalEffect, setLocalEffectInstance } from "~/lib/local-effects";
import { deleteLocalAutomationEnvelope, setLocalAutomationEnvelope } from "~/lib/local-automation";
import { automationTargetKey, granularAutomationKey, instrumentAutomationKey, isLocalId, parseGranularAutomationKey, parseInstrumentAutomationKey } from "@daw-browser/shared";
import { buildSharedClipCreateOperation, buildSharedTrackCreateOperation, isAppliedSharedTimelineOperationResult, publishSharedTimelineOperation, type SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import { createLocalTimelineRepository } from "~/lib/timeline-repository/local-timeline-repository";
import { buildTrackCreateMutationInput, buildTrackDeleteMutationInput, buildTrackMixMutationInput, buildTrackVolumeMutationInput } from "~/lib/track-mutation-args";
import { buildTrackRoutingMutationInput } from "~/lib/track-routing-state";
import type { LocalMixPatch } from "~/lib/timeline-storage";
import type { Track, TrackRouting } from "@daw-browser/timeline-core/types";
import type { Deps } from "./exec";
import type { HistoryEntry, TrackAudioEffectSnapshot, TrackAutomationSnapshot, TrackEffectSnapshot } from "./types";
import { buildHistoryRefIndex, resolveTrackId } from "./refs";

type ClipMove = { clipId: string; trackId: Track["id"]; startSec: number };

type ClipTimingPatch = {
  startSec: number;
  duration: number;
  leftPadSec?: number;
  bufferOffsetSec?: number;
  midiOffsetBeats?: number;
  audioWarp?: Track["clips"][number]["audioWarp"];
  gain?: number;
};

export const isLocalHistoryProject = (deps: Pick<Deps, "projectId">) => (
  isLocalId("project", deps.projectId)
);

export const rebaseTrackAutomationEnvelope = (
  envelope: TrackAutomationSnapshot[number],
  trackId: Track["id"],
) => {
  const samplerKey = parseInstrumentAutomationKey(envelope.parameterId);
  const granularKey = parseGranularAutomationKey(envelope.parameterId);
  const parameterId = samplerKey
    ? instrumentAutomationKey(trackId, samplerKey.instanceId, samplerKey.parameterId)
    : granularKey
      ? granularAutomationKey(trackId, granularKey.instanceId, granularKey.parameterId)
      : envelope.parameterId;
  const target: AutomationEnvelope["target"] = {
    kind: "track",
    trackId,
    effectInstanceId: envelope.target.effectInstanceId,
  };
  return {
    ...envelope,
    target,
    parameterId,
    targetKey: automationTargetKey(target, parameterId),
  };
};

const toHistoryCreateClipInput = (trackId: Track["id"], clip: Track["clips"][number]) => ({
  id: clip.id,
  historyRef: clip.historyRef,
  trackId,
  name: clip.name,
  startSec: clip.startSec,
  duration: clip.duration,
  color: clip.color,
  sourceAssetKey: clip.sourceAssetKey,
  sourceKind: clip.sourceKind,
  sourceDurationSec: clip.sourceDurationSec,
  sourceSampleRate: clip.sourceSampleRate,
  sourceChannelCount: clip.sourceChannelCount,
  leftPadSec: clip.leftPadSec,
  bufferOffsetSec: clip.bufferOffsetSec,
  audioWarp: normalizeAudioWarp(clip.audioWarp),
  gain: clip.gain,
  sampleUrl: clip.sampleUrl,
  midi: clip.midi,
  midiOffsetBeats: clip.midiOffsetBeats,
});

export const syncHistoryTrackCreateEntryId = (
  entries: HistoryEntry[],
  trackRef: string | undefined,
  trackId: Track["id"],
) => {
  if (!trackRef) return;
  for (const entry of entries) {
    if (entry.type === "track-create" && entry.data.trackRef === trackRef) {
      entry.data.currentTrackId = trackId;
    }
  }
};

export const syncHistoryClipCreateEntryIds = (
  entries: HistoryEntry[],
  clipIdsByRef: ReadonlyMap<string, string>,
) => {
  if (clipIdsByRef.size === 0) return;
  for (const entry of entries) {
    if (entry.type !== "clip-create") continue;
    const clipId = clipIdsByRef.get(entry.data.clip.clipRef);
    if (clipId) {
      entry.data.clip.currentId = clipId;
    }
  }
};

export const createHistoryTrack = async (
  deps: Deps,
  track: {
    trackRef?: string;
    index: number;
    name?: string;
    volume?: number;
    muted?: boolean;
    soloed?: boolean;
    kind?: Track["kind"];
    channelRole?: Track["channelRole"];
    groupId?: Track["id"];
    collapsed?: boolean;
    color?: string;
    sends?: TrackRouting["sends"];
  },
) => {
  if (isLocalHistoryProject(deps)) {
    const row = await createLocalTimelineRepository(deps.projectId).createTrack({
      id: track.trackRef,
      historyRef: track.trackRef,
      name: track.name,
      index: track.index,
      volume: track.volume,
      muted: track.muted,
      soloed: track.soloed,
      kind: track.kind,
      channelRole: track.channelRole,
      groupId: track.groupId,
      collapsed: track.collapsed,
      color: track.color,
      sends: track.sends,
    });
    return row.id;
  }
  const payload = buildTrackCreateMutationInput({
    projectId: deps.projectId,
    index: track.index,
    kind: track.kind,
    channelRole: track.channelRole,
    collapsed: track.collapsed,
  });
  const operation = buildSharedTrackCreateOperation({
    index: payload.index,
    kind: payload.kind,
    channelRole: payload.channelRole,
    collapsed: track.collapsed,
    color: track.color,
  });
  const result = await publishSharedTimelineOperation(deps.projectId, operation);
  assert(typeof result === "string", "Failed to create history track");
  return result;
};

export const persistHistoryTrackGroup = async (
  deps: Deps,
  trackId: Track["id"],
  groupId: Track["id"] | undefined,
  outputTargetId?: Track["id"],
) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({
      trackId,
      groupId: groupId ?? null,
      outputTargetId: outputTargetId ?? null,
    });
    return;
  }
  await publishHistoryOperation(deps, { kind: "tracks.setGroup", payload: { trackId, groupId: groupId ?? null } });
  const track = deps.getTracks().find((entry) => entry.id === trackId);
  await publishHistoryOperation(deps, { kind: "tracks.setRouting", payload: { trackId, routing: { outputTargetId, sends: track?.sends ?? [] } } });
};

export const persistHistoryTrackColor = async (
  deps: Deps,
  trackId: Track["id"],
  color: string | undefined,
) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({ trackId, color: color ?? null });
    return;
  }
  await publishHistoryOperation(deps, { kind: "tracks.setColor", payload: { trackId, color } });
};

export const persistHistoryColorBatch = async (
  deps: Deps,
  updates: {
    tracks: Array<{ trackId: Track["id"]; color: string | undefined }>
    clips: Array<{ clipId: string; color: string }>
  },
) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).applyColorBatch({
      tracks: updates.tracks.map((update) => ({ trackId: update.trackId, color: update.color ?? null })),
      clips: updates.clips,
    });
    return;
  }
  await publishHistoryOperation(deps, {
    kind: "tracks.applyColorBatch",
    payload: {
      trackUpdates: updates.tracks.map((update) => ({ trackId: update.trackId, color: update.color ?? null })),
      clipUpdates: updates.clips,
    },
  });
};

export const persistHistoryTrackReorder = async (
  deps: Deps,
  updates: Array<{ trackId: Track["id"]; index: number; groupId?: Track["id"] | null; outputTargetId?: Track["id"] | null }>,
) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).reorderAndGroup(updates);
    return;
  }
  await publishHistoryOperation(deps, { kind: "tracks.reorderAndGroup", payload: { updates } });
};

export const persistHistoryUngroup = async (deps: Deps, groupId: Track["id"]) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).ungroupTrack(groupId);
    return;
  }
  await publishHistoryOperation(deps, {
    kind: "tracks.ungroup",
    payload: { groupId, operationId: crypto.randomUUID() },
  });
};

type RestoreUngroupInput = {
  groupId: Track["id"]
  operationId?: string
  group: {
    trackRef?: string
    name: string
    index: number
    volume: number
    muted?: boolean
    soloed?: boolean
    kind?: Track["kind"]
    channelRole?: Track["channelRole"]
    parentGroupId?: Track["id"]
    collapsed?: boolean
    color?: string
    routing: { outputTargetId?: Track["id"]; sends: TrackRouting["sends"] }
  }
  children: Array<{ trackId: Track["id"]; outputTargetId?: Track["id"]; outputToGroup: boolean }>
  effects?: TrackEffectSnapshot
  automation?: TrackAutomationSnapshot
  sidechainRoutes: Array<{ sourceTrackId?: Track["id"]; targetTrackId?: Track["id"]; effectInstanceId: string }>
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
)

const snapshotAudioEffects = (effects: TrackEffectSnapshot): TrackAudioEffectSnapshot[] => {
  if (effects.audioEffects?.length) return effects.audioEffects
  const audioEffects: TrackAudioEffectSnapshot[] = []
  if (effects.eq) audioEffects.push({ effect: "eq", params: effects.eq })
  if (effects.compressor) audioEffects.push({ effect: "compressor", params: effects.compressor })
  if (effects.saturator) audioEffects.push({ effect: "saturator", params: effects.saturator })
  if (effects.delay) audioEffects.push({ effect: "delay", params: effects.delay })
  if (effects.reverb) audioEffects.push({ effect: "reverb", params: effects.reverb })
  return audioEffects
}

const localRestoreEffectRows = (trackId: Track["id"], effects: TrackEffectSnapshot | undefined) => {
  if (!effects) return []
  const timestamp = Date.now()
  const audioEffects = snapshotAudioEffects(effects)
  return [
    ...audioEffects.map((effect) => ({
      id: localEffectRowId(trackId, effect.effect, effect.instanceId),
      targetId: trackId,
      effect: effect.effect,
      instanceId: effect.instanceId,
      params: effect.params,
      index: effect.index,
      updatedAt: timestamp,
    })),
    ...(effects.instrument ? [{ id: localEffectRowId(trackId, "instrument"), targetId: trackId, effect: "instrument", params: effects.instrument, updatedAt: timestamp }] : []),
    ...(!effects.instrument && effects.synth ? [{ id: localEffectRowId(trackId, "synth"), targetId: trackId, effect: "synth", params: effects.synth, updatedAt: timestamp }] : []),
    ...(effects.arp ? [{ id: localEffectRowId(trackId, "arp"), targetId: trackId, effect: "arp", params: effects.arp, updatedAt: timestamp }] : []),
  ]
}

type SharedRestoreEffects = Extract<SharedTimelineOperation, { kind: 'tracks.restoreUngroup' }>['payload']['effects']

const sharedRestoreEffects = (effects: TrackEffectSnapshot | undefined): SharedRestoreEffects => {
  if (!effects) return []
  const audioEffects = snapshotAudioEffects(effects)
  const restored: SharedRestoreEffects = []
  for (const effect of audioEffects) {
    restored.push({ type: effect.effect, instanceId: effect.instanceId, index: effect.index, params: effect.params })
  }
  if (effects.instrument) restored.push({ type: 'instrument', params: effects.instrument })
  if (!effects.instrument && effects.synth) restored.push({ type: 'synth', params: effects.synth })
  if (effects.arp) restored.push({ type: 'arpeggiator', params: effects.arp })
  return restored
}

export const persistHistoryRestoreUngroup = async (deps: Deps, input: RestoreUngroupInput): Promise<Track["id"]> => {
  const groupId = input.groupId
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).restoreUngroup({
      group: {
        id: groupId,
        historyRef: input.group.trackRef ?? groupId,
        name: input.group.name,
        index: input.group.index,
        volume: input.group.volume,
        muted: input.group.muted ?? false,
        soloed: input.group.soloed ?? false,
        kind: input.group.kind ?? "audio",
        channelRole: input.group.channelRole ?? "group",
        collapsed: input.group.collapsed,
        color: input.group.color,
        groupId: input.group.parentGroupId,
        outputTargetId: input.group.routing.outputTargetId,
        sends: input.group.routing.sends ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      children: input.children,
      effects: localRestoreEffectRows(groupId, input.effects),
      automation: (input.automation ?? []).map((envelope) => rebaseTrackAutomationEnvelope(envelope, groupId)),
      sidechainRoutes: input.sidechainRoutes,
    })
    return groupId
  }
  const result = await publishSharedTimelineOperation(
    deps.projectId,
    {
      kind: "tracks.restoreUngroup",
      payload: {
        group: {
          index: input.group.index,
          kind: input.group.kind,
          historyRef: input.group.trackRef,
          parentGroupId: input.group.parentGroupId,
          collapsed: input.group.collapsed,
          color: input.group.color,
          volume: input.group.volume,
          muted: input.group.muted,
          soloed: input.group.soloed,
          outputTargetId: input.group.routing.outputTargetId,
          sends: input.group.routing.sends ?? [],
        },
        children: input.children,
        effects: sharedRestoreEffects(input.effects),
        automation: (input.automation ?? []).map((envelope) => {
          const rebased = rebaseTrackAutomationEnvelope(envelope, groupId)
          return {
            effectInstanceId: rebased.target.effectInstanceId,
            parameterId: rebased.parameterId,
            enabled: envelope.enabled,
            points: envelope.points,
            updatedAt: envelope.updatedAt,
          }
        }),
        sidechainRoutes: input.sidechainRoutes,
        operationId: input.operationId ?? crypto.randomUUID(),
      },
    },
  )
  if (!isRecord(result) || result.status !== "applied" || typeof result.groupId !== "string") {
    throw new Error("Failed to restore dissolved group.")
  }
  return result.groupId
}

export const createHistoryClip = async (
  deps: Deps,
  trackId: Track["id"],
  clip: ClipCreateSnapshot & { clipRef?: string; currentId?: string },
) => {
  if (isLocalHistoryProject(deps)) {
    const clipRef = clip.clipRef ?? clip.currentId;
    assert(clipRef, "Missing clip reference for local history clip creation");
    return (await createLocalTimelineRepository(deps.projectId).createClip(
      toHistoryCreateClipInput(trackId, buildLocalClip({ id: clipRef, clip })),
    )).id;
  }
  const operation = buildSharedClipCreateOperation(buildClipCreatePayload({ projectId: deps.projectId, trackId, clip }));
  const result = await publishSharedTimelineOperation(deps.projectId, operation);
  return typeof result === "string" ? result : null;
};

type TrackDeleteEffects = NonNullable<Extract<HistoryEntry, { type: "track-delete" }>["data"]["effects"]>;
type TrackDeleteAutomation = NonNullable<Extract<HistoryEntry, { type: "track-delete" }>["data"]["automation"]>;
type EffectParamsEntry = Extract<HistoryEntry, { type: "effect-params" }>;
type AutomationEnvelopeEntry = Extract<HistoryEntry, { type: "automation-envelope-change" }>;
type HistoryDirection = "undo" | "redo";

function pickDirectionalValue<T>(direction: HistoryDirection, from: T, to: T) {
  return direction === "undo" ? from : to;
}

const publishHistoryOperation = async (deps: Deps, operation: SharedTimelineOperation) => {
  const result = await publishSharedTimelineOperation(deps.projectId, operation);
  assert(isAppliedSharedTimelineOperationResult(result), "Shared timeline operation was not applied.");
};

export const persistHistoryTrackEffects = async (
  deps: Deps,
  trackId: Track["id"],
  effects: TrackDeleteEffects | undefined,
) => {
  if (!effects) return;
  const audioEffects = effects.audioEffects ?? [];
  const restoredAudioEffects = audioEffects.flatMap((effect) => (
    effect.instanceId ? [{ id: effect.instanceId, kind: effect.effect, params: effect.params }] : []
  ));
  if (restoredAudioEffects.length !== audioEffects.length) {
    throw new Error("History effect restore is missing an audio effect instance ID.");
  }
  if (isLocalHistoryProject(deps)) {
    await restoreLocalTrackEffectChain(deps.projectId, trackId, {
      audioEffects: restoredAudioEffects,
      instrument: effects.instrument,
      arp: effects.arp,
    });
    return;
  }
  await publishHistoryOperation(deps, {
    kind: "effects.restoreChain",
    payload: {
      trackId,
      audioEffects: restoredAudioEffects,
      instrument: effects.instrument,
      arpeggiator: effects.arp,
      operationId: crypto.randomUUID(),
    },
  });
};

export const persistHistoryTrackAutomation = async (
  deps: Deps,
  envelopes: TrackDeleteAutomation | undefined,
  trackId: Track["id"],
) => {
  if (!envelopes || envelopes.length === 0) return;
  const rebased = envelopes.map((envelope) => rebaseTrackAutomationEnvelope(envelope, trackId));
  if (isLocalHistoryProject(deps)) {
    await Promise.all(rebased.map((envelope) => setLocalAutomationEnvelope(deps.projectId, envelope)));
    return;
  }
  await Promise.all(rebased.map((envelope) => publishHistoryOperation(deps, {
    kind: "automation.setEnvelope",
    payload: {
      targetKind: "track",
      trackId,
      effectInstanceId: envelope.target.effectInstanceId,
      parameterId: envelope.parameterId,
      enabled: envelope.enabled,
      points: envelope.points,
      updatedAt: envelope.updatedAt,
    },
  })));
};

export const persistHistorySidechainRoutes = async (
  deps: Deps,
  routes: Extract<HistoryEntry, { type: "track-delete" }>["data"]["sidechainRoutes"]
    | Extract<HistoryEntry, { type: "track-ungroup" }>["data"]["sidechainRoutes"],
) => {
  if (!routes || routes.length === 0) return;
  const index = buildHistoryRefIndex(deps.getHistoryEntries(), deps.getTracks());
  for (const route of routes) {
    const sourceTrackId = resolveTrackId(index, route.sourceTrackRef);
    const targetTrackId = resolveTrackId(index, route.targetTrackRef);
    if (!sourceTrackId || !targetTrackId || sourceTrackId === targetTrackId) continue;
    if (isLocalHistoryProject(deps)) {
      await createLocalTimelineRepository(deps.projectId).setSidechainRoute({
        sourceTrackId,
        targetTrackId,
        effectInstanceId: route.effectInstanceId,
      });
    } else {
      await publishHistoryOperation(deps, {
        kind: "sidechains.setRoute",
        payload: {
          projectId: deps.projectId,
          sourceTrackId,
          targetTrackId,
          effectInstanceId: route.effectInstanceId,
        },
      });
    }
  }
};

export const persistHistoryEffectParams = async (
  deps: Deps,
  entry: EffectParamsEntry,
  targetId: Track["id"] | "master",
  direction: HistoryDirection,
) => {
  assert(entry.data.instanceId, "Effect history requires an instance ID");
  if (isLocalHistoryProject(deps)) {
    if (entry.data.effect === "reverb" || entry.data.effect === "master-reverb") {
      const params = normalizeReverbParams(pickDirectionalValue(direction, entry.data.from, entry.data.to));
      await setLocalEffectInstance(deps.projectId, targetId, entry.data.effect, params, { instanceId: entry.data.instanceId });
      return;
    }
    if (entry.data.effect === "spectral" || entry.data.effect === "master-spectral") {
      const params = normalizeSpectralParamsEnvelope(pickDirectionalValue(direction, entry.data.from, entry.data.to));
      await setLocalEffectInstance(deps.projectId, targetId, entry.data.effect, params, { instanceId: entry.data.instanceId });
      return;
    }
    const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
    await setLocalEffectInstance(
      deps.projectId,
      targetId,
      entry.data.effect,
      params,
      { instanceId: entry.data.instanceId },
    );
    return;
  }
  switch (entry.data.effect) {
    case "master-utility": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setMasterUtilityParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "master-gate": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setMasterGateParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "master-limiter": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setMasterLimiterParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "master-spectral": {
      const params = normalizeSpectralParamsEnvelope(pickDirectionalValue(direction, entry.data.from, entry.data.to));
      await publishHistoryOperation(deps, { kind: "effects.setMasterSpectralParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "master-autofilter":
    case "master-chorus":
    case "master-flanger":
    case "master-phaser":
    case "master-tremolo":
    case "master-autopan":
    case "master-ensemble":
    case "master-lofi": {
      const effect = entry.data.effect.slice(7);
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      if (effect === "autofilter") await publishHistoryOperation(deps, { kind: "effects.setMasterModulationParams", payload: { effect, params: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(params), instanceId: entry.data.instanceId } });
      else if (effect === "chorus") await publishHistoryOperation(deps, { kind: "effects.setMasterModulationParams", payload: { effect, params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(params), instanceId: entry.data.instanceId } });
      else if (effect === "flanger") await publishHistoryOperation(deps, { kind: "effects.setMasterModulationParams", payload: { effect, params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(params), instanceId: entry.data.instanceId } });
      else if (effect === "phaser") await publishHistoryOperation(deps, { kind: "effects.setMasterModulationParams", payload: { effect, params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(params), instanceId: entry.data.instanceId } });
      else if (effect === "tremolo") await publishHistoryOperation(deps, { kind: "effects.setMasterModulationParams", payload: { effect, params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(params), instanceId: entry.data.instanceId } });
      else if (effect === "autopan") await publishHistoryOperation(deps, { kind: "effects.setMasterModulationParams", payload: { effect, params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(params), instanceId: entry.data.instanceId } });
      else if (effect === "ensemble") await publishHistoryOperation(deps, { kind: "effects.setMasterModulationParams", payload: { effect, params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(params), instanceId: entry.data.instanceId } });
      else if (effect === "lofi") await publishHistoryOperation(deps, { kind: "effects.setMasterModulationParams", payload: { effect, params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(params), instanceId: entry.data.instanceId } });
      return;
    }
    case "master-eq": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setMasterEqParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "master-compressor": {
      const params = normalizeCompressorParams(pickDirectionalValue(direction, entry.data.from, entry.data.to));
      await publishHistoryOperation(deps, { kind: "effects.setMasterCompressorParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "master-reverb": {
      const params = normalizeReverbParams(pickDirectionalValue(direction, entry.data.from, entry.data.to));
      await publishHistoryOperation(deps, { kind: "effects.setMasterReverbParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "master-saturator": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setMasterSaturatorParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "master-delay": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setMasterDelayParams", payload: { params, instanceId: entry.data.instanceId } });
      return;
    }
    case "eq": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setEqParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "utility": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setUtilityParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "gate": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setGateParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "limiter": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setLimiterParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "spectral": {
      const params = normalizeSpectralParamsEnvelope(pickDirectionalValue(direction, entry.data.from, entry.data.to));
      await publishHistoryOperation(deps, { kind: "effects.setSpectralParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "autofilter":
    case "chorus":
    case "flanger":
    case "phaser":
    case "tremolo":
    case "autopan":
    case "ensemble":
    case "lofi": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      const instanceId = entry.data.instanceId;
      if (entry.data.effect === "autofilter") await publishHistoryOperation(deps, { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "autofilter", params: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(params), instanceId } });
      else if (entry.data.effect === "chorus") await publishHistoryOperation(deps, { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "chorus", params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(params), instanceId } });
      else if (entry.data.effect === "flanger") await publishHistoryOperation(deps, { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "flanger", params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(params), instanceId } });
      else if (entry.data.effect === "phaser") await publishHistoryOperation(deps, { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "phaser", params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(params), instanceId } });
      else if (entry.data.effect === "tremolo") await publishHistoryOperation(deps, { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "tremolo", params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(params), instanceId } });
      else if (entry.data.effect === "autopan") await publishHistoryOperation(deps, { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "autopan", params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(params), instanceId } });
      else if (entry.data.effect === "ensemble") await publishHistoryOperation(deps, { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "ensemble", params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(params), instanceId } });
      else await publishHistoryOperation(deps, { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "lofi", params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(params), instanceId } });
      return;
    }
    case "compressor": {
      const params = normalizeCompressorParams(pickDirectionalValue(direction, entry.data.from, entry.data.to));
      await publishHistoryOperation(deps, { kind: "effects.setCompressorParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "reverb": {
      const params = normalizeReverbParams(pickDirectionalValue(direction, entry.data.from, entry.data.to));
      await publishHistoryOperation(deps, { kind: "effects.setReverbParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "saturator": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setSaturatorParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "delay": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setDelayParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "synth": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setSynthParams", payload: { trackId: targetId, params, instanceId: entry.data.instanceId } });
      return;
    }
    case "instrument": {
      const instrument = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "instruments.setTrackInstrument", payload: { trackId: targetId, instrument } });
      return;
    }
    case "arp": {
      const params = pickDirectionalValue(direction, entry.data.from, entry.data.to);
      await publishHistoryOperation(deps, { kind: "effects.setArpeggiatorParams", payload: { trackId: targetId, params } });
      return;
    }
  }
};

export const persistHistoryAutomationEnvelope = async (
  deps: Deps,
  entry: AutomationEnvelopeEntry,
  direction: HistoryDirection,
) => {
  const envelope = pickDirectionalValue(direction, entry.data.before, entry.data.after);
  const targetKey = envelope?.targetKey ?? entry.data.before?.targetKey ?? entry.data.after?.targetKey;
  if (!targetKey) return;
  if (isLocalHistoryProject(deps)) {
    if (envelope) await setLocalAutomationEnvelope(deps.projectId, envelope);
    else await deleteLocalAutomationEnvelope(deps.projectId, targetKey);
    return;
  }
  if (envelope) {
    await publishHistoryOperation(deps, {
      kind: "automation.setEnvelope",
      payload: {
        targetKind: envelope.target.kind,
        trackId: envelope.target.kind === "track" ? envelope.target.trackId : undefined,
        effectInstanceId: envelope.target.effectInstanceId,
        parameterId: envelope.parameterId,
        enabled: envelope.enabled,
        points: envelope.points,
        updatedAt: envelope.updatedAt,
      },
    });
    return;
  }
  const before = entry.data.before ?? entry.data.after;
  if (!before) return;
  await publishHistoryOperation(deps, {
    kind: "automation.deleteEnvelope",
    payload: {
      targetKind: before.target.kind,
      trackId: before.target.kind === "track" ? before.target.trackId : undefined,
      effectInstanceId: before.target.effectInstanceId,
      parameterId: before.parameterId,
    },
  });
};

export const removeHistoryClipIdsOrThrow = async (deps: Deps, clipIds: string[], message: string) => {
  if (clipIds.length === 0) return;
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).deleteClips(clipIds);
    return;
  }
  const result = await deps.convexClient.mutation(
    deps.convexApi.clips.removeMany,
    buildClipRemoveManyMutationInput({ clipIds }),
  );
  const removedIds = new Set(
    Array.isArray(result?.removedClipIds)
      ? result.removedClipIds.map((clipId: unknown) => String(clipId))
      : [],
  );
  assert(clipIds.every((clipId) => removedIds.has(String(clipId))), message);
};

export const removeHistoryTrackOrThrow = async (deps: Deps, trackId: Track["id"], message: string) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).deleteTrack(trackId);
    return;
  }
  const result = await deps.convexClient.mutation(
    deps.convexApi.tracks.remove,
    buildTrackDeleteMutationInput({ trackId }),
  );
  assert(result?.status === "deleted", message);
};

export const persistHistoryClipTimingOrThrow = async (
  deps: Deps,
  clipId: string,
  timing: ClipTimingPatch,
  message: string,
) => {
  if (isLocalHistoryProject(deps)) {
    const applied = await createLocalTimelineRepository(deps.projectId).updateClip({
      clipId,
      startSec: timing.startSec,
      duration: timing.duration,
      leftPadSec: timing.leftPadSec,
      bufferOffsetSec: timing.bufferOffsetSec,
      midiOffsetBeats: timing.midiOffsetBeats,
      audioWarp: timing.audioWarp,
      gain: timing.gain,
    });
    assert(applied, message);
    return;
  }
  const audioWarp = normalizeAudioWarp(timing.audioWarp);
  const applied = audioWarp
    ? await persistClipTimingAndAudioWarp(deps.convexClient, deps.convexApi, {
      clipId,
      startSec: timing.startSec,
      duration: timing.duration,
      leftPadSec: timing.leftPadSec ?? 0,
      bufferOffsetSec: timing.bufferOffsetSec ?? 0,
      midiOffsetBeats: timing.midiOffsetBeats ?? 0,
      audioWarp,
    })
    : await persistClipTiming(deps.convexClient, deps.convexApi, {
      clipId,
      startSec: timing.startSec,
      duration: timing.duration,
      leftPadSec: timing.leftPadSec ?? 0,
      bufferOffsetSec: timing.bufferOffsetSec ?? 0,
      midiOffsetBeats: timing.midiOffsetBeats ?? 0,
    });
  assert(applied, message);
  if (timing.gain !== undefined) {
    const result = await publishSharedTimelineOperation(
      deps.projectId,
      { kind: "clips.setGain", payload: { clipId, gain: timing.gain } },
    );
    assert(isAppliedSharedTimelineOperationResult(result), message);
  }
};

export const persistHistoryClipAudioWarpOrThrow = async (
  deps: Deps,
  clipId: string,
  audioWarp: Track["clips"][number]["audioWarp"],
  message: string,
) => {
  const normalizedAudioWarp = normalizeAudioWarp(audioWarp);
  if (!normalizedAudioWarp) throw new Error(message);
  if (isLocalHistoryProject(deps)) {
    const applied = await createLocalTimelineRepository(deps.projectId).updateClip({
      clipId,
      audioWarp: normalizedAudioWarp,
    });
    assert(applied, message);
    return;
  }
  const applied = await persistClipAudioWarp(deps.convexClient, deps.convexApi, {
    clipId,
    audioWarp: normalizedAudioWarp,
  });
  assert(applied, message);
};

export const persistHistoryClipColorOrThrow = async (
  deps: Deps,
  clipId: string,
  color: string | undefined,
  message: string,
) => {
  if (!color) throw new Error(message);
  if (isLocalHistoryProject(deps)) {
    const applied = await createLocalTimelineRepository(deps.projectId).updateClip({ clipId, color });
    assert(applied, message);
    return;
  }
  const result = await publishSharedTimelineOperation(
    deps.projectId,
    { kind: "clips.setColor", payload: { clipId, color } },
  );
  assert(isAppliedSharedTimelineOperationResult(result), message);
};

export const persistHistoryClipMovesOrThrow = async (
  deps: Deps,
  moves: ClipMove[],
  message: string,
) => {
  if (moves.length === 0) return;
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).moveClips(moves);
    return;
  }
  const result = await deps.convexClient.mutation(
    deps.convexApi.clips.moveMany,
    buildClipMoveManyMutationInput({
      moves: moves.map((move) => ({
        clipId: move.clipId,
        startSec: move.startSec,
        toTrackId: move.trackId,
      })),
    }),
  );
  assert(result?.status === "applied", message);
};

export const persistHistoryTrackRouting = async (deps: Deps, trackId: Track["id"], routing: TrackRouting) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({
      trackId,
      outputTargetId: routing.outputTargetId ?? null,
      sends: routing.sends ?? [],
    });
    return;
  }
  await deps.convexClient.mutation(
    deps.convexApi.tracks.setRouting,
    buildTrackRoutingMutationInput({
      trackId,
      routing: { sends: routing.sends ?? [], outputTargetId: routing.outputTargetId },
    }),
  );
};

export const persistHistoryTrackMixState = async (
  deps: Pick<Deps, "convexClient" | "convexApi" | "userId">,
  trackId: Track["id"],
  mix: { muted?: boolean; soloed?: boolean },
) => {
  if (typeof mix.muted !== "boolean" && typeof mix.soloed !== "boolean") return;
  await deps.convexClient.mutation(deps.convexApi.tracks.setMix, buildTrackMixMutationInput({
    trackId,
    muted: mix.muted,
    soloed: mix.soloed,
  }));
};

export const persistHistoryTrackVolume = async (
  deps: Deps,
  trackId: Track["id"],
  volume: number,
  scope?: "local" | "shared",
) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({ trackId, volume });
  } else if (scope === "local") {
    deps.persistLocalMix(deps.projectId, trackId, { volume } satisfies LocalMixPatch);
  } else {
    await deps.convexClient.mutation(
      deps.convexApi.tracks.setVolume,
      buildTrackVolumeMutationInput({ trackId, volume }),
    );
  }
};

export const persistHistoryTrackMix = async (
  deps: Deps,
  trackId: Track["id"],
  patch: { muted?: boolean; soloed?: boolean },
  scope?: "local" | "shared",
) => {
  if (isLocalHistoryProject(deps)) {
    await createLocalTimelineRepository(deps.projectId).updateTrack({ trackId, ...patch });
  } else if (scope !== "local") {
    await persistHistoryTrackMixState(deps, trackId, patch);
  } else {
    deps.persistLocalMix(deps.projectId, trackId, patch);
  }
};
