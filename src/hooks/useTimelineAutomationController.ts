import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { Track } from "@daw-browser/timeline-core/types";
import {
  automationTargetKey,
  automationEnvelopeFromRow,
  automationTargetKeysAfterReEnable,
  automationTargetKeysForManualOverride,
  filterAutomationEnvelopesForScheduling,
  getAutomationParameterOptionsForTarget,
  evaluatedAutomationValuesByTargetKey,
  isAudioEffectKind,
  isLocalId,
  normalizeTrackInstrumentParams,
  type AutomationTargetDeviceInstance,
  type AutomationParameterSelection,
  type AutomationEnvelope,
} from "@daw-browser/shared";
import { createPersistedAutomationState } from "~/components/timeline/create-persisted-automation-state";
import { clampAutomationLaneHeight, DEFAULT_AUTOMATION_LANE_HEIGHT } from "~/lib/timeline-utils";
import { loadLocalAutomationEnvelopes, setLocalAutomationEnvelope, deleteLocalAutomationEnvelope } from "~/lib/local-automation";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import { buildAutomationEnvelopeHistoryEntry } from "~/lib/undo/builders";
import type { HistoryEntry } from "~/lib/undo/types";
import { useProjectPersistedState } from "~/hooks/useProjectPersistedState";
import { listLocalEffects } from "~/lib/local-effects";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";

type RemoteAutomationRow = {
  _id: string;
  projectId: string;
  targetKind: "master" | "track";
  trackId?: string;
  effectInstanceId?: string;
  targetKey: string;
  parameterId: string;
  enabled: boolean;
  points: AutomationEnvelope["points"];
  updatedAt: number;
};

type TimelineAutomationControllerOptions = {
  projectId: Accessor<string>;
  userId: Accessor<string>;
  remoteRows: Accessor<RemoteAutomationRow[] | undefined>;
  remoteEffects: Accessor<Array<{
    targetType: "track" | "master";
    trackId?: string;
    type: string;
    instanceId?: string;
    index?: number;
    params?: unknown;
  }> | undefined>;
  audioEngine: AudioEngine;
  isPlaying: Accessor<boolean>;
  playheadSec: Accessor<number>;
  selectedTrackId: Accessor<Track["id"] | "">;
  pushHistory: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void;
};

export type TimelineWorkspaceAutomationModel = {
  projectId: string;
  lanes: {
    visibleByTrackId: Record<string, boolean>;
    visibleTargetKeysByTrackId: Record<string, string[]>;
    heightsByLaneOwnerKey: Record<string, number>;
    masterVisible: boolean;
    masterHeight: number;
    selectedTargetsByOwnerKey: Record<string, AutomationParameterSelection>;
    selectionByTargetKey: Map<string, AutomationParameterSelection>;
    effectInstancesByOwnerKey: Record<string, AutomationTargetDeviceInstance[]>;
  };
  evaluatedValuesByTargetKey: Accessor<ReadonlyMap<string, number>>;
  envelopes: {
    byTargetKey: Map<string, AutomationEnvelope>;
    preview: (envelope: AutomationEnvelope | undefined) => void;
    commit: (envelope: AutomationEnvelope | undefined, targetKey?: string) => void;
    cancelPreview: (targetKey: string) => void;
  };
  actions: {
    toggleMasterVisibility: () => void;
    toggleTrackVisibility: (trackId: Track["id"]) => void;
    addTrackLane: (trackId: Track["id"]) => void;
    showTrackLane: (trackId: Track["id"], selection: AutomationParameterSelection) => void;
    hideTrackLane: (trackId: Track["id"], targetKey: string) => void;
    resizeMasterLane: (height: number) => void;
    resizeTrackLane: (trackId: Track["id"], height: number) => void;
    selectParameter: (targetKey: string, selection: AutomationParameterSelection) => void;
    overrideTarget: (targetKey: string) => void;
  };
};

const replaceAutomationEnvelope = (
  envelopes: AutomationEnvelope[],
  targetKey: string,
  envelope: AutomationEnvelope | undefined,
) => {
  const existingIndex = envelopes.findIndex((entry) => entry.targetKey === targetKey);
  if (!envelope) {
    return existingIndex === -1 ? envelopes : envelopes.filter((entry) => entry.targetKey !== targetKey);
  }
  if (existingIndex !== -1 && envelopes[existingIndex] === envelope) return envelopes;
  const next = existingIndex === -1 ? [...envelopes, envelope] : [...envelopes];
  next[existingIndex === -1 ? next.length - 1 : existingIndex] = envelope;
  return next;
};

export function useTimelineAutomationController(options: TimelineAutomationControllerOptions) {
  const [automationEnvelopes, setAutomationEnvelopes] = createSignal<AutomationEnvelope[]>([]);
  const [effectInstancesByOwnerKey, setEffectInstancesByOwnerKey] = createSignal<Record<string, AutomationTargetDeviceInstance[]>>({});
  const [overriddenAutomationTargetKeys, setOverriddenAutomationTargetKeys] = createSignal<Set<string>>(new Set());
  const visibleAutomationTracks = useProjectPersistedState<Record<string, boolean>>({
    projectId: options.projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-visible-tracks`);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        const next: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "boolean") next[key] = value;
        }
        return next;
      } catch {
        return {};
      }
    },
    save: (rid, value) => localStorage.setItem(`timeline:${rid}:automation-visible-tracks`, JSON.stringify(value)),
  });
  const visibleAutomationLanes = useProjectPersistedState<Record<string, string[]>>({
    projectId: options.projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-visible-lanes`);
      const legacyRaw = localStorage.getItem(`timeline:${rid}:automation-visible-tracks`);
      const selectedRaw = localStorage.getItem(`timeline:${rid}:automation-parameters`);
      const legacySelected: Record<string, string> = {};
      if (selectedRaw) {
        try {
          const parsed = JSON.parse(selectedRaw);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed)) {
              if (typeof value === "string") legacySelected[key] = value;
            }
          }
        } catch {}
      }
      const readLegacy = () => {
        if (!legacyRaw) return {};
        try {
          const parsed = JSON.parse(legacyRaw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
          const next: Record<string, string[]> = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (key === "master" || value !== true) continue;
            if ((legacySelected[key] ?? "volume") === "volume") {
              next[key] = [automationTargetKey({ kind: "track", trackId: key }, "volume")];
            }
          }
          return next;
        } catch {
          return {};
        }
      };
      if (!raw) return readLegacy();
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return readLegacy();
        const next: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (!Array.isArray(value)) continue;
          const targetKeys = value.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("automation:v2:"));
          if (targetKeys.length > 0) next[key] = Array.from(new Set(targetKeys));
        }
        return next;
      } catch {
        return readLegacy();
      }
    },
    save: (rid, value) => localStorage.setItem(`timeline:${rid}:automation-visible-lanes`, JSON.stringify(value)),
  });
  const automationLaneHeights = useProjectPersistedState<Record<string, number>>({
    projectId: options.projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-lane-heights`);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        const next: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "number" && Number.isFinite(value)) next[key] = clampAutomationLaneHeight(value);
        }
        return next;
      } catch {
        return {};
      }
    },
    save: (rid, value) => localStorage.setItem(`timeline:${rid}:automation-lane-heights`, JSON.stringify(value)),
  });
  const selectedAutomationParameters = useProjectPersistedState<Record<string, AutomationParameterSelection>>({
    projectId: options.projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-parameters`);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        const next: Record<string, AutomationParameterSelection> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (value === "volume") next[key] = { parameterId: "volume" };
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const parameterId = Reflect.get(value, "parameterId");
            const effectInstanceId = Reflect.get(value, "effectInstanceId");
            if (typeof parameterId === "string" && (effectInstanceId === undefined || typeof effectInstanceId === "string")) {
              next[key] = { parameterId, effectInstanceId };
            }
          }
        }
        return next;
      } catch {
        return {};
      }
    },
    save: (rid, value) => localStorage.setItem(`timeline:${rid}:automation-parameters`, JSON.stringify(value)),
  });
  const automationTargetKeyAccessor = createMemo(() => {
    const trackId = options.selectedTrackId();
    if (!trackId) return undefined;
    const selection = selectedAutomationParameters.value()[trackId] ?? { parameterId: "volume" };
    return automationTargetKey({ kind: "track", trackId, effectInstanceId: selection.effectInstanceId }, selection.parameterId);
  });
  const applyAutomationEnvelopeState = (envelope: AutomationEnvelope | undefined, targetKey: string) => {
    setAutomationEnvelopes((current) => {
      const rows = replaceAutomationEnvelope(current, targetKey, envelope);
      options.audioEngine.cancelAutomationSchedules(new Set([targetKey]), current);
      options.audioEngine.setAutomationEnvelopes(filterAutomationEnvelopesForScheduling(rows, overriddenAutomationTargetKeys()));
      if (options.isPlaying() && !overriddenAutomationTargetKeys().has(targetKey)) {
        options.audioEngine.scheduleAutomationFromPlayhead(options.playheadSec(), { targetKeys: new Set([targetKey]) });
      }
      return rows;
    });
  };
  const applyAutomationRowsToEngine = (
    next: AutomationEnvelope[],
    previous: AutomationEnvelope[],
    changedTargetKeys: ReadonlySet<string>,
  ) => {
    options.audioEngine.cancelAutomationSchedules(changedTargetKeys.size === 0 ? undefined : changedTargetKeys, previous);
    const overrides = overriddenAutomationTargetKeys();
    options.audioEngine.setAutomationEnvelopes(filterAutomationEnvelopesForScheduling(next, overrides));
    if (options.isPlaying()) {
      const targetKeys = changedTargetKeys.size === 0
        ? undefined
        : new Set([...changedTargetKeys].filter((targetKey) => !overrides.has(targetKey)));
      if (targetKeys && targetKeys.size === 0) return;
      options.audioEngine.scheduleAutomationFromPlayhead(options.playheadSec(), { targetKeys });
    }
  };
  const overrideAutomationTarget = (targetKey: string) => {
    if (!options.isPlaying()) return;
    const envelope = automationEnvelopesByTargetKey().get(targetKey);
    if (!envelope?.enabled) return;
    setOverriddenAutomationTargetKeys((current) => {
      const next = automationTargetKeysForManualOverride(current, targetKey);
      if (next.size === current.size) return current;
      options.audioEngine.cancelAutomationSchedules(new Set([targetKey]), automationEnvelopes());
      options.audioEngine.setAutomationEnvelopes(filterAutomationEnvelopesForScheduling(automationEnvelopes(), next));
      return next;
    });
  };
  const reEnableAutomation = () => {
    const current = overriddenAutomationTargetKeys();
    if (current.size === 0) return;
    const reEnabledTargetKeys = new Set(current);
    const next = automationTargetKeysAfterReEnable(current, reEnabledTargetKeys);
    setOverriddenAutomationTargetKeys(next);
    options.audioEngine.cancelAutomationSchedules(reEnabledTargetKeys, automationEnvelopes());
    options.audioEngine.setAutomationEnvelopes(filterAutomationEnvelopesForScheduling(automationEnvelopes(), next));
    if (options.isPlaying()) options.audioEngine.scheduleAutomationFromPlayhead(options.playheadSec(), { targetKeys: reEnabledTargetKeys });
    else options.audioEngine.applyAutomationAtTimelineSec(options.playheadSec());
  };
  const persistedAutomation = createPersistedAutomationState({
    targetKey: automationTargetKeyAccessor,
    envelopes: automationEnvelopes,
    applyToEngine: applyAutomationRowsToEngine,
    persistEnvelope: async (envelope) => {
      const rid = options.projectId();
      if (!rid) return;
      if (isLocalId("project", rid)) {
        const persisted = await setLocalAutomationEnvelope(rid, envelope);
        setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, envelope.targetKey, persisted));
        return;
      }
      const uid = options.userId();
      if (!uid) throw new Error("Cannot persist shared automation without a user id.");
      await publishDurableSharedTimelineOperation({
        projectId: rid,
        userId: uid,
        operation: {
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
        },
      });
      setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, envelope.targetKey, envelope));
    },
    deleteEnvelope: async (targetKey) => {
      const rid = options.projectId();
      if (!rid) return;
      const envelope = automationEnvelopes().find((entry) => entry.targetKey === targetKey);
      if (isLocalId("project", rid)) {
        await deleteLocalAutomationEnvelope(rid, targetKey);
        setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, targetKey, undefined));
        return;
      }
      if (!envelope) return;
      const uid = options.userId();
      if (!uid) throw new Error("Cannot persist shared automation without a user id.");
      await publishDurableSharedTimelineOperation({
        projectId: rid,
        userId: uid,
        operation: {
          kind: "automation.deleteEnvelope",
          payload: {
            targetKind: envelope.target.kind,
            trackId: envelope.target.kind === "track" ? envelope.target.trackId : undefined,
            effectInstanceId: envelope.target.effectInstanceId,
            parameterId: envelope.parameterId,
          },
        },
      });
      setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, targetKey, undefined));
    },
    onEnvelopeCommitted: (previous, next) => {
      const rid = options.projectId();
      if (!rid) return;
      options.pushHistory(buildAutomationEnvelopeHistoryEntry({
        projectId: rid,
        before: previous ?? null,
        after: next ?? null,
      }), `automation:${next?.targetKey ?? previous?.targetKey ?? "unknown"}`, 0);
    },
  });

  createEffect(() => {
    const rid = options.projectId();
    if (!rid) {
      setAutomationEnvelopes([]);
      setOverriddenAutomationTargetKeys(new Set<string>());
      options.audioEngine.setAutomationEnvelopes([]);
      return;
    }
    setOverriddenAutomationTargetKeys(new Set<string>());
    if (isLocalId("project", rid)) {
      void loadLocalAutomationEnvelopes(rid).then((rows) => {
        if (options.projectId() !== rid) return;
        setAutomationEnvelopes(rows);
        untrack(persistedAutomation.syncRemote);
      }).catch(() => {
        if (options.projectId() !== rid) return;
        setAutomationEnvelopes([]);
        untrack(persistedAutomation.syncRemote);
      });
      return;
    }
    const next = (options.remoteRows() ?? []).flatMap((row) => {
      const envelope = automationEnvelopeFromRow(row);
      return envelope ? [envelope] : [];
    });
    setAutomationEnvelopes(next);
    untrack(persistedAutomation.syncRemote);
  });
  createEffect(() => {
    const rid = options.projectId();
    if (!rid) {
      setEffectInstancesByOwnerKey({});
      return;
    }
    const collect = (rows: Array<{ targetId: string; kind: string; instanceId?: string; index?: number; params?: unknown }>) => {
      const grouped = new Map<string, Array<AutomationTargetDeviceInstance & { index: number }>>();
      for (const row of rows) {
        const normalizedKind = row.kind.startsWith("master-") ? row.kind.slice("master-".length) : row.kind;
        if (normalizedKind === "instrument") {
          const instrument = normalizeTrackInstrumentParams(row.params);
          if (!instrument || (instrument.kind !== "sampler" && instrument.kind !== "granular")) continue;
          const entries = grouped.get(row.targetId) ?? [];
          entries.push({ id: instrument.instanceId, kind: instrument.kind, index: row.index ?? entries.length });
          grouped.set(row.targetId, entries);
          continue;
        }
        if (!isAudioEffectKind(normalizedKind)) continue;
        const entries = grouped.get(row.targetId) ?? [];
        entries.push({ id: row.instanceId ?? normalizedKind, kind: normalizedKind, index: row.index ?? entries.length });
        grouped.set(row.targetId, entries);
      }
      const next: Record<string, AutomationTargetDeviceInstance[]> = {};
      for (const [targetId, entries] of grouped) {
        next[targetId] = entries
          .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
          .map(({ id, kind }) => ({ id, kind }));
      }
      setEffectInstancesByOwnerKey(next);
    };
    if (isLocalId("project", rid)) {
      const reload = () => void listLocalEffects(rid).then((rows) => {
        if (options.projectId() !== rid) return;
        collect(rows.map((row) => ({
          targetId: row.targetId,
          kind: row.effect,
          instanceId: row.instanceId,
          index: row.index,
          params: row.params,
        })));
      });
      reload();
      const unsubscribe = subscribeToLocalProjectChanges(rid, reload);
      onCleanup(unsubscribe);
    }
    collect((options.remoteEffects() ?? []).map((row) => ({
      targetId: row.targetType === "master" ? "master" : row.trackId ?? "",
      kind: row.type,
      instanceId: row.instanceId,
      index: row.index,
      params: row.params,
    })).filter((row) => row.targetId.length > 0));
  });
  const automationEnvelopesByTargetKey = createMemo(() => (
    new Map(persistedAutomation.envelopes().map((envelope) => [envelope.targetKey, envelope]))
  ));
  const evaluatedValuesByTargetKey = createMemo(() => (
    evaluatedAutomationValuesByTargetKey(
      persistedAutomation.envelopes(),
      options.playheadSec(),
      overriddenAutomationTargetKeys(),
    )
  ));
  const targetKeyForTrackSelection = (trackId: Track["id"], selection: AutomationParameterSelection) => (
    automationTargetKey({ kind: "track", trackId, effectInstanceId: selection.effectInstanceId }, selection.parameterId)
  );
  const showAutomationLane = (trackId: Track["id"], selection: AutomationParameterSelection) => {
    const targetKey = targetKeyForTrackSelection(trackId, selection);
    visibleAutomationLanes.setValue((current) => {
      const lanes = current[trackId] ?? [];
      if (lanes.includes(targetKey)) return current;
      return { ...current, [trackId]: [...lanes, targetKey] };
    });
    visibleAutomationTracks.setValue((current) => (
      current[trackId] === true ? current : { ...current, [trackId]: true }
    ));
  };
  const hideAutomationLane = (trackId: Track["id"], targetKey: string) => {
    let hiddenLastLane = false;
    visibleAutomationLanes.setValue((current) => {
      const lanes = current[trackId] ?? [];
      const nextLanes = lanes.filter((entry) => entry !== targetKey);
      if (nextLanes.length === lanes.length) return current;
      const next = { ...current };
      if (nextLanes.length > 0) next[trackId] = nextLanes;
      else {
        delete next[trackId];
        hiddenLastLane = true;
      }
      return next;
    });
    if (hiddenLastLane) {
      visibleAutomationTracks.setValue((current) => ({ ...current, [trackId]: false }));
    }
  };
  const handleTogglePrimaryAutomationLane = (trackId: Track["id"]) => {
    const selection = selectedAutomationParameters.value()[trackId] ?? { parameterId: "volume" };
    const targetKey = targetKeyForTrackSelection(trackId, selection);
    const lanes = visibleAutomationLanes.value()[trackId] ?? (
      visibleAutomationTracks.value()[trackId] === true ? [targetKey] : []
    );
    if (lanes.length > 0) {
      visibleAutomationLanes.setValue((current) => {
        const next = { ...current };
        delete next[trackId];
        return next;
      });
      visibleAutomationTracks.setValue((current) => ({ ...current, [trackId]: false }));
      return;
    }
    showAutomationLane(trackId, selection);
  };
  const handleAddAutomationLane = (trackId: Track["id"]) => {
    const visible = new Set(visibleAutomationLanes.value()[trackId] ?? []);
    if (visible.size === 0) return;
    const selected = selectedAutomationParameters.value()[trackId] ?? { parameterId: "volume" };
    const selectedTargetKey = targetKeyForTrackSelection(trackId, selected);
    if (!visible.has(selectedTargetKey)) {
      showAutomationLane(trackId, selected);
      return;
    }
    const nextOption = getAutomationParameterOptionsForTarget(effectInstancesByOwnerKey()[trackId] ?? [], trackId)
      .find((option) => !visible.has(targetKeyForTrackSelection(trackId, option)));
    if (nextOption) {
      const selection = { parameterId: nextOption.parameterId, effectInstanceId: nextOption.effectInstanceId };
      showAutomationLane(trackId, selection);
      selectedAutomationParameters.setValue((current) => (
        { ...current, [trackId]: selection }
      ));
      return;
    }
    for (const envelope of persistedAutomation.envelopes()) {
      if (envelope.target.kind !== "track" || envelope.target.trackId !== trackId) continue;
      if (visible.has(envelope.targetKey)) continue;
      const selection = { parameterId: envelope.parameterId, effectInstanceId: envelope.target.effectInstanceId };
      showAutomationLane(trackId, selection);
      selectedAutomationParameters.setValue((current) => (
        { ...current, [trackId]: selection }
      ));
      return;
    }
  };
  const resizeLane = (targetKey: string, height: number) => {
    const nextHeight = clampAutomationLaneHeight(height || DEFAULT_AUTOMATION_LANE_HEIGHT);
    automationLaneHeights.setValue((current) => (
      current[targetKey] === nextHeight ? current : { ...current, [targetKey]: nextHeight }
    ));
  };
  const selectAutomationParameter = (
    targetKey: string,
    selection: AutomationParameterSelection,
  ) => {
    selectedAutomationParameters.setValue((current) => (
      { ...current, [targetKey]: selection }
    ));
  };
  const workspace = createMemo<TimelineWorkspaceAutomationModel>(() => ({
    projectId: options.projectId(),
    lanes: {
      visibleByTrackId: visibleAutomationTracks.value(),
      visibleTargetKeysByTrackId: visibleAutomationLanes.value(),
      heightsByLaneOwnerKey: automationLaneHeights.value(),
      masterVisible: visibleAutomationTracks.value().master === true,
      masterHeight: automationLaneHeights.value().master ?? DEFAULT_AUTOMATION_LANE_HEIGHT,
      selectedTargetsByOwnerKey: selectedAutomationParameters.value(),
      selectionByTargetKey: (() => {
        const selections = new Map<string, AutomationParameterSelection>();
        for (const [ownerKey, effects] of Object.entries(effectInstancesByOwnerKey())) {
          const target = ownerKey === "master"
            ? { kind: "master" as const }
            : { kind: "track" as const, trackId: ownerKey };
          for (const option of getAutomationParameterOptionsForTarget(effects, ownerKey === "master" ? undefined : ownerKey)) {
            selections.set(
              automationTargetKey({ ...target, effectInstanceId: option.effectInstanceId }, option.parameterId),
              { parameterId: option.parameterId, effectInstanceId: option.effectInstanceId },
            );
          }
        }
        for (const envelope of persistedAutomation.envelopes()) {
          selections.set(envelope.targetKey, {
            parameterId: envelope.parameterId,
            effectInstanceId: envelope.target.effectInstanceId,
          });
        }
        return selections;
      })(),
      effectInstancesByOwnerKey: effectInstancesByOwnerKey(),
    },
    evaluatedValuesByTargetKey,
    envelopes: {
      byTargetKey: automationEnvelopesByTargetKey(),
      preview: persistedAutomation.previewEnvelope,
      commit: (envelope, targetKey) => {
        void persistedAutomation.commitEnvelope(envelope, targetKey);
      },
      cancelPreview: persistedAutomation.cancelPreview,
    },
    actions: {
      toggleMasterVisibility: () => {
        visibleAutomationTracks.setValue((current) => ({ ...current, master: !current.master }));
      },
      toggleTrackVisibility: handleTogglePrimaryAutomationLane,
      addTrackLane: handleAddAutomationLane,
      showTrackLane: showAutomationLane,
      hideTrackLane: hideAutomationLane,
      resizeMasterLane: (height) => resizeLane("master", height),
      resizeTrackLane: resizeLane,
      overrideTarget: overrideAutomationTarget,
      selectParameter: selectAutomationParameter,
    },
  }));

  return {
    envelopes: persistedAutomation.envelopes,
    envelopesByTargetKey: automationEnvelopesByTargetKey,
    evaluatedValuesByTargetKey,
    applyEnvelope: applyAutomationEnvelopeState,
    overrideTarget: overrideAutomationTarget,
    reEnable: reEnableAutomation,
    overrideCount: () => overriddenAutomationTargetKeys().size,
    workspace,
    effectsPanel: {
      selectParameter: selectAutomationParameter,
      overrideTarget: overrideAutomationTarget,
    },
  };
}
