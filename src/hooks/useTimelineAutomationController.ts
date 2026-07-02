import { createEffect, createMemo, createSignal, untrack, type Accessor } from "solid-js";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { Track } from "@daw-browser/timeline-core/types";
import {
  automationTargetKey,
  automationTargetKeysAfterReEnable,
  automationTargetKeysForManualOverride,
  filterAutomationEnvelopesForScheduling,
  getAutomationParameterOptions,
  assert,
  isLocalId,
  type AutomationEnvelope,
} from "@daw-browser/shared";
import { createPersistedAutomationState } from "~/components/timeline/create-persisted-automation-state";
import { clampAutomationLaneHeight, DEFAULT_AUTOMATION_LANE_HEIGHT } from "~/lib/timeline-utils";
import { loadLocalAutomationEnvelopes, setLocalAutomationEnvelope, deleteLocalAutomationEnvelope } from "~/lib/local-automation";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import { buildAutomationEnvelopeHistoryEntry } from "~/lib/undo/builders";
import type { HistoryEntry } from "~/lib/undo/types";
import { useProjectPersistedState } from "~/hooks/useProjectPersistedState";

type RemoteAutomationRow = {
  _id: string;
  projectId: string;
  targetKind: "master" | "track";
  trackId?: string;
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
    visibleParameterIdsByTrackId: Record<string, string[]>;
    heightsByLaneOwnerKey: Record<string, number>;
    masterVisible: boolean;
    masterHeight: number;
    selectedParametersByTargetKey: Record<string, string>;
  };
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
    showTrackLane: (trackId: Track["id"], parameterId: string) => void;
    hideTrackLane: (trackId: Track["id"], parameterId: string) => void;
    resizeMasterLane: (height: number) => void;
    resizeTrackLane: (trackId: Track["id"], height: number) => void;
    selectParameter: (targetKey: string, parameterId: string) => void;
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

const automationParameterOptions = getAutomationParameterOptions();

export function useTimelineAutomationController(options: TimelineAutomationControllerOptions) {
  const [automationEnvelopes, setAutomationEnvelopes] = createSignal<AutomationEnvelope[]>([]);
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
            next[key] = [legacySelected[key] ?? "volume"];
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
          const parameterIds = value.filter((entry): entry is string => typeof entry === "string");
          if (parameterIds.length > 0) next[key] = Array.from(new Set(parameterIds));
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
  const selectedAutomationParameters = useProjectPersistedState<Record<string, string>>({
    projectId: options.projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-parameters`);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") next[key] = value;
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
    const parameterId = selectedAutomationParameters.value()[trackId] ?? "volume";
    return automationTargetKey({ kind: "track", trackId }, parameterId);
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
        await setLocalAutomationEnvelope(rid, envelope);
        setAutomationEnvelopes((current) => replaceAutomationEnvelope(current, envelope.targetKey, envelope));
        return;
      }
      const uid = options.userId();
      assert(uid, "Cannot persist shared automation without a user id.");
      await publishDurableSharedTimelineOperation({
        projectId: rid,
        userId: uid,
        operation: {
          kind: "automation.setEnvelope",
          payload: {
            targetKind: envelope.target.kind,
            trackId: envelope.target.kind === "track" ? envelope.target.trackId : undefined,
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
      assert(uid, "Cannot persist shared automation without a user id.");
      await publishDurableSharedTimelineOperation({
        projectId: rid,
        userId: uid,
        operation: {
          kind: "automation.deleteEnvelope",
          payload: {
            targetKind: envelope.target.kind,
            trackId: envelope.target.kind === "track" ? envelope.target.trackId : undefined,
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
    const next: AutomationEnvelope[] = [];
    for (const row of options.remoteRows() ?? []) {
      if (row.targetKind === "master") {
        next.push({
          id: row._id,
          projectId: row.projectId,
          target: { kind: "master" },
          targetKey: row.targetKey,
          parameterId: row.parameterId,
          enabled: row.enabled,
          points: row.points,
          updatedAt: row.updatedAt,
        });
        continue;
      }
      if (!row.trackId) continue;
      next.push({
        id: row._id,
        projectId: row.projectId,
        target: { kind: "track", trackId: row.trackId },
        targetKey: row.targetKey,
        parameterId: row.parameterId,
        enabled: row.enabled,
        points: row.points,
        updatedAt: row.updatedAt,
      });
    }
    setAutomationEnvelopes(next);
    untrack(persistedAutomation.syncRemote);
  });
  const automationEnvelopesByTargetKey = createMemo(() => (
    new Map(persistedAutomation.envelopes().map((envelope) => [envelope.targetKey, envelope]))
  ));
  const showAutomationLane = (trackId: Track["id"], parameterId: string) => {
    visibleAutomationLanes.setValue((current) => {
      const lanes = current[trackId] ?? [];
      if (lanes.includes(parameterId)) return current;
      return { ...current, [trackId]: [...lanes, parameterId] };
    });
    visibleAutomationTracks.setValue((current) => (
      current[trackId] === true ? current : { ...current, [trackId]: true }
    ));
  };
  const hideAutomationLane = (trackId: Track["id"], parameterId: string) => {
    let hiddenLastLane = false;
    visibleAutomationLanes.setValue((current) => {
      const lanes = current[trackId] ?? [];
      const nextLanes = lanes.filter((entry) => entry !== parameterId);
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
    const parameterId = selectedAutomationParameters.value()[trackId] ?? "volume";
    const lanes = visibleAutomationLanes.value()[trackId] ?? (
      visibleAutomationTracks.value()[trackId] === true ? [parameterId] : []
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
    showAutomationLane(trackId, parameterId);
  };
  const handleAddAutomationLane = (trackId: Track["id"]) => {
    const visible = new Set(visibleAutomationLanes.value()[trackId] ?? []);
    if (visible.size === 0) return;
    const selectedParameter = selectedAutomationParameters.value()[trackId] ?? "volume";
    if (!visible.has(selectedParameter)) {
      showAutomationLane(trackId, selectedParameter);
      return;
    }
    const nextOption = automationParameterOptions.find((option) => !visible.has(option.id));
    if (nextOption) {
      showAutomationLane(trackId, nextOption.id);
      selectedAutomationParameters.setValue((current) => (
        current[trackId] === nextOption.id ? current : { ...current, [trackId]: nextOption.id }
      ));
      return;
    }
    for (const envelope of persistedAutomation.envelopes()) {
      if (envelope.target.kind !== "track" || envelope.target.trackId !== trackId) continue;
      if (visible.has(envelope.parameterId)) continue;
      showAutomationLane(trackId, envelope.parameterId);
      selectedAutomationParameters.setValue((current) => (
        current[trackId] === envelope.parameterId ? current : { ...current, [trackId]: envelope.parameterId }
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
  const workspace = createMemo<TimelineWorkspaceAutomationModel>(() => ({
    projectId: options.projectId(),
    lanes: {
      visibleByTrackId: visibleAutomationTracks.value(),
      visibleParameterIdsByTrackId: visibleAutomationLanes.value(),
      heightsByLaneOwnerKey: automationLaneHeights.value(),
      masterVisible: visibleAutomationTracks.value().master === true,
      masterHeight: automationLaneHeights.value().master ?? DEFAULT_AUTOMATION_LANE_HEIGHT,
      selectedParametersByTargetKey: selectedAutomationParameters.value(),
    },
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
      selectParameter: (targetKey, parameterId) => {
        selectedAutomationParameters.setValue((current) => (
          current[targetKey] === parameterId ? current : { ...current, [targetKey]: parameterId }
        ));
      },
    },
  }));

  return {
    envelopes: persistedAutomation.envelopes,
    envelopesByTargetKey: automationEnvelopesByTargetKey,
    applyEnvelope: applyAutomationEnvelopeState,
    overrideTarget: overrideAutomationTarget,
    reEnable: reEnableAutomation,
    overrideCount: () => overriddenAutomationTargetKeys().size,
    workspace,
    effectsPanel: {
      selectParameter: workspace().actions.selectParameter,
      overrideTarget: overrideAutomationTarget,
    },
  };
}
