import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type Accessor } from "solid-js";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { Track } from "@daw-browser/timeline-core/types";
import type { LiveProcessorControlResult } from "~/lib/live-processor-control";
import {
  automationTargetKey,
  automationEnvelopeFromRow,
  createAutomationTarget,
  externalAutomationParameterId,
  automationTargetKeysAfterReEnable,
  automationTargetKeysForManualOverride,
  filterAutomationEnvelopesForScheduling,
  getAutomationParameterOptionsForTarget,
  evaluatedAutomationValuesByTargetKey,
  isAudioEffectKind,
  isLocalId,
  parseEqBandParameterId,
  parseGranularAutomationKey,
  parseInstrumentAutomationKey,
  parseSynthAutomationKey,
  type AutomationTargetDeviceInstance,
  type AutomationExternalParameter,
  type AutomationParameterSelection,
  type AutomationEnvelope,
  type AutomationTarget,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import { createPersistedAutomationState } from "~/components/timeline/create-persisted-automation-state";
import { createAutomationSeedEnvelope } from "~/components/timeline/automation-seed-envelope";
import type { ExportAutomationPatch } from "~/lib/export/run-export-job";
import { clampAutomationLaneHeight, DEFAULT_AUTOMATION_LANE_HEIGHT } from "~/lib/timeline-utils";
import { loadLocalAutomationEnvelopes, setLocalAutomationEnvelope, deleteLocalAutomationEnvelope } from "~/lib/local-automation";
import { publishDurableSharedTimelineOperation } from "~/lib/shared-outbox";
import { buildAutomationEnvelopeHistoryEntry } from "~/lib/undo/builders";
import type { HistoryEntry } from "~/lib/undo/types";
import { useProjectPersistedState } from "~/hooks/useProjectPersistedState";
import { listLocalEffects } from "~/lib/local-effects";
import { listLocalExternalProcessors } from "~/lib/external-plugins";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";

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

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue };

const isJsonObject = (cause: unknown): cause is JsonObject => (
  typeof cause === "object"
  && cause !== null
  && !Array.isArray(cause)
  && Object.values(cause).every(isJsonValue)
);

const isJsonValue = (cause: unknown): cause is JsonValue => (
  cause === null
  || typeof cause === "boolean"
  || typeof cause === "number"
  || typeof cause === "string"
  || (Array.isArray(cause) && cause.every(isJsonValue))
  || isJsonObject(cause)
);

const isBoolean = (cause: unknown): cause is boolean => typeof cause === "boolean";
const isFiniteNumber = (cause: unknown): cause is number => typeof cause === "number" && Number.isFinite(cause);
const isString = (cause: unknown): cause is string => typeof cause === "string";
const isAutomationTargetKey = (cause: JsonValue): cause is string => (
  typeof cause === "string" && cause.startsWith("automation:v2:")
);

type TimelineAutomationControllerOptions = {
  projectId: Accessor<string>;
  userId: Accessor<string>;
  tracks: Accessor<Track[]>;
  masterVolume: Accessor<number>;
  masterReady: Accessor<boolean>;
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
  reenableProcessorAutomation?: (
    instanceId: string,
    parameterIds: readonly string[],
  ) => Promise<LiveProcessorControlResult>;
  isPlaying: Accessor<boolean>;
  playheadSec: Accessor<number>;
  selectedTrackId: Accessor<Track["id"] | "">;
  pushHistory: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void;
  onPersistenceError?: (error: Error) => void;
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

const readNumericPath = (value: JsonValue | undefined, path: readonly string[]): number | undefined => {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return isFiniteNumber(current) ? current : undefined;
};

const readEffectParameterValue = (params: JsonValue | undefined, parameterId: string): number | undefined => {
  const object = isJsonObject(params) ? params : undefined;
  const state = object && isJsonObject(object.state) ? object.state : object;
  const eq = parseEqBandParameterId(parameterId);
  if (eq && state && Array.isArray(state.bands)) {
    const band = state.bands.find((entry) => isJsonObject(entry) && entry.id === eq.bandId);
    if (!isJsonObject(band)) return undefined;
    const field = eq.property === "frequencyHz" ? "frequency" : eq.property;
    return readNumericPath(band, [field]);
  }
  return readNumericPath(state, parameterId.split(".").slice(1));
};

const readInstrumentParameterValue = (instrument: TrackInstrumentParams, parameterId: string): number | undefined => {
  const sampler = parseInstrumentAutomationKey(parameterId);
  if (sampler && instrument.kind === "sampler" && instrument.instanceId === sampler.instanceId) {
    const samplerParams = instrument.params;
    if (sampler.parameterId === "output.gain") return 1;
    if (sampler.parameterId === "output.pan") return 0;
    if (sampler.parameterId.startsWith("amp.")) {
      const field = sampler.parameterId === "amp.attack"
        ? "attackSec"
        : sampler.parameterId === "amp.decay"
          ? "decaySec"
          : sampler.parameterId === "amp.sustain"
            ? "sustain"
            : "releaseSec";
      return readNumericPath(samplerParams.ampEnvelope, [field]);
    }
    if (sampler.parameterId === "filter.frequency") return samplerParams.filterFrequencyHz;
    if (sampler.parameterId === "filter.q") return samplerParams.filterQ;
    if (sampler.parameterId.startsWith("filter.env")) return samplerParams.filterEnvelope.amount;
    if (sampler.parameterId.startsWith("lfo.")) {
      const field = sampler.parameterId === "lfo.rate"
        ? "frequencyHz"
        : sampler.parameterId === "lfo.pitchDepth"
          ? "pitchCents"
          : sampler.parameterId === "lfo.filterDepth"
            ? "filterHz"
            : sampler.parameterId === "lfo.ampDepth"
              ? "amp"
              : "pan";
      return readNumericPath(samplerParams.lfo, [field]);
    }
  }
  const granular = parseGranularAutomationKey(parameterId);
  if (granular && instrument.kind === "granular" && instrument.instanceId === granular.instanceId) {
    if (granular.parameterId === "grainSize") return instrument.params.grainSizeMs;
    if (granular.parameterId === "density") return instrument.params.densityHz;
    if (granular.parameterId === "position") return instrument.params.position;
    if (granular.parameterId === "spray") return instrument.params.spray;
    if (granular.parameterId === "pitch") return instrument.params.pitchSemitones;
    if (granular.parameterId === "reverseProbability") return instrument.params.reverseProbability;
    return instrument.params.stereoSpread;
  }
  const synth = parseSynthAutomationKey(parameterId);
  if (synth && instrument.kind === "synth" && instrument.instanceId === synth.instanceId) {
    if (synth.parameterId === "output.gain") return instrument.params.gain;
    if (synth.parameterId === "output.pan") return instrument.params.pan;
    if (synth.parameterId === "osc1.level") return instrument.params.oscillators[0].level;
    if (synth.parameterId === "osc1.detune") return instrument.params.oscillators[0].detuneCents;
    if (synth.parameterId === "osc2.level") return instrument.params.oscillators[1].level;
    if (synth.parameterId === "osc2.detune") return instrument.params.oscillators[1].detuneCents;
    if (synth.parameterId === "noise.level") return instrument.params.noise.level;
    if (synth.parameterId === "amp.attack") return instrument.params.ampEnvelope.attackSec;
    if (synth.parameterId === "amp.decay") return instrument.params.ampEnvelope.decaySec;
    if (synth.parameterId === "amp.sustain") return instrument.params.ampEnvelope.sustain;
    if (synth.parameterId === "amp.release") return instrument.params.ampEnvelope.releaseSec;
    if (synth.parameterId === "filter.frequency") return instrument.params.filter.frequencyHz;
    if (synth.parameterId === "filter.q") return instrument.params.filter.q;
    if (synth.parameterId === "filter.envAmount") return instrument.params.filter.envelopeAmountOctaves;
    if (synth.parameterId === "filter.attack") return instrument.params.filter.envelope.attackSec;
    if (synth.parameterId === "filter.decay") return instrument.params.filter.envelope.decaySec;
    if (synth.parameterId === "filter.sustain") return instrument.params.filter.envelope.sustain;
    if (synth.parameterId === "filter.release") return instrument.params.filter.envelope.releaseSec;
    if (synth.parameterId === "lfo.rate") return instrument.params.lfo.frequencyHz;
    if (synth.parameterId === "lfo.pitchDepth") return instrument.params.lfo.pitchCents;
    if (synth.parameterId === "lfo.filterDepth") return instrument.params.lfo.filterOctaves;
    if (synth.parameterId === "lfo.ampDepth") return instrument.params.lfo.amp;
    return instrument.params.lfo.pan;
  }
  return undefined;
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
  const [automationValuesByTargetKey, setAutomationValuesByTargetKey] = createSignal<ReadonlyMap<string, number>>(new Map());
  const [effectDataReady, setEffectDataReady] = createSignal(false);
  const [automationDataReady, setAutomationDataReady] = createSignal(false);
  const [overriddenAutomationTargetKeys, setOverriddenAutomationTargetKeys] = createSignal<Set<string>>(new Set());
  const seededAutomationTargetKeys = new Set<string>();
  let seededProjectId: string | undefined;
  const visibleAutomationTracks = useProjectPersistedState<Record<string, boolean>>({
    projectId: options.projectId,
    createInitial: () => ({}),
    load: (rid) => {
      const raw = localStorage.getItem(`timeline:${rid}:automation-visible-tracks`);
      if (!raw) return {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isJsonObject(parsed)) return {};
        const next: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (isBoolean(value)) next[key] = value;
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
          const parsed: unknown = JSON.parse(selectedRaw);
          if (isJsonObject(parsed)) {
            for (const [key, value] of Object.entries(parsed)) {
              if (isString(value)) legacySelected[key] = value;
            }
          }
        } catch {}
      }
      const readLegacy = () => {
        if (!legacyRaw) return {};
        try {
          const parsed: unknown = JSON.parse(legacyRaw);
          if (!isJsonObject(parsed)) return {};
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
        const parsed: unknown = JSON.parse(raw);
        if (!isJsonObject(parsed)) return readLegacy();
        const next: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (!Array.isArray(value)) continue;
          const targetKeys = value.filter(isAutomationTargetKey);
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
        const parsed: unknown = JSON.parse(raw);
        if (!isJsonObject(parsed)) return {};
        const next: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (isFiniteNumber(value)) next[key] = clampAutomationLaneHeight(value);
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
        const parsed: unknown = JSON.parse(raw);
        if (!isJsonObject(parsed)) return {};
        const next: Record<string, AutomationParameterSelection> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (value === "volume") next[key] = { parameterId: "volume" };
          if (isJsonObject(value)) {
            const parameterId = value.parameterId;
            const effectInstanceId = value.effectInstanceId;
            if (isString(parameterId) && (effectInstanceId === undefined || isString(effectInstanceId))) {
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
    return automationTargetKey(createAutomationTarget({ kind: "track", trackId }, selection.effectInstanceId), selection.parameterId);
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
    const nextTargetKeys = new Set(next.map((envelope) => envelope.targetKey));
    const removedTargetKeys = new Set(
      [...changedTargetKeys].filter((targetKey) => !nextTargetKeys.has(targetKey)),
    );
    if (removedTargetKeys.size > 0) {
      options.audioEngine.restoreAutomationTargets(removedTargetKeys, previous);
    }
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
  const reEnableAutomation = async () => {
    const current = overriddenAutomationTargetKeys();
    if (current.size === 0) return;
    const reEnabledTargetKeys = new Set(current);
    const envelopes = automationEnvelopes().filter((envelope) => reEnabledTargetKeys.has(envelope.targetKey));
    const byProcessor = new Map<string, { instanceId: string; parameterIds: string[] }>();
    for (const envelope of envelopes) {
      if (!envelope.target.effectInstanceId) continue;
      const key = envelope.target.effectInstanceId;
      const entry = byProcessor.get(key) ?? { instanceId: key, parameterIds: [] };
      if (!entry.parameterIds.includes(envelope.parameterId)) entry.parameterIds.push(envelope.parameterId);
      byProcessor.set(key, entry);
    }
    const reenableProcessorAutomation = options.reenableProcessorAutomation;
    if (reenableProcessorAutomation) {
      const results = await Promise.all(
        [...byProcessor.values()].map((processor) => (
          reenableProcessorAutomation(processor.instanceId, processor.parameterIds)
        )),
      );
      const playbackControlAttempted = results.some((result) => result.accepted || result.reason !== "unavailable");
      if (playbackControlAttempted && results.some((result) => !result.accepted)) return;
    }
    const next = automationTargetKeysAfterReEnable(current, reEnabledTargetKeys);
    setOverriddenAutomationTargetKeys(next);
    options.audioEngine.cancelAutomationSchedules(reEnabledTargetKeys, automationEnvelopes());
    options.audioEngine.setAutomationEnvelopes(filterAutomationEnvelopesForScheduling(automationEnvelopes(), next));
    if (options.isPlaying()) options.audioEngine.scheduleAutomationFromPlayhead(options.playheadSec(), { targetKeys: reEnabledTargetKeys });
    else options.audioEngine.applyAutomationAtTimelineSec(options.playheadSec());
  };
  onMount(() => {
    const releasePointerAutomation = () => {
      void reEnableAutomation();
    };
    window.addEventListener("pointerup", releasePointerAutomation);
    window.addEventListener("pointercancel", releasePointerAutomation);
    onCleanup(() => {
      window.removeEventListener("pointerup", releasePointerAutomation);
      window.removeEventListener("pointercancel", releasePointerAutomation);
    });
  });
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

  const seedVisibleAutomationLanes = () => {
    const rid = options.projectId();
    if (!rid) return;
    if (seededProjectId !== rid) {
      seededProjectId = rid;
      seededAutomationTargetKeys.clear();
    }
    const visibleByTrackId = visibleAutomationTracks.value();
    const visibleLanesByTrackId = visibleAutomationLanes.value();
    const seed = (target: AutomationTarget, parameterId: string) => {
      const targetKey = automationTargetKey(target, parameterId);
      if (persistedAutomation.envelopes().some((envelope) => envelope.targetKey === targetKey)) {
        seededAutomationTargetKeys.add(targetKey);
        return;
      }
      if (
        seededAutomationTargetKeys.has(targetKey)
        || (target.kind === "master" && !options.masterReady())
        || (parameterId !== "volume" && !effectDataReady())
        || !automationDataReady()
        || (target.kind === "track" && !options.tracks().some((track) => track.id === target.trackId))
      ) return;
      const envelope = createAutomationSeedEnvelope({
        projectId: rid,
        target,
        parameterId,
        initialValue: initialValueForTarget(target, parameterId),
      });
      if (!envelope) return;
      seededAutomationTargetKeys.add(targetKey);
      void persistedAutomation.commitEnvelope(envelope).catch((cause: unknown) => {
        seededAutomationTargetKeys.delete(targetKey);
        options.onPersistenceError?.(cause instanceof Error ? cause : new Error("Automation could not be saved."));
      });
    };

    if (visibleByTrackId.master === true) {
      const selection = selectedAutomationParameters.value().master ?? { parameterId: "volume" };
      seed(createAutomationTarget({ kind: "master" }, selection.effectInstanceId), selection.parameterId);
    }
    for (const [trackId, targetKeys] of Object.entries(visibleLanesByTrackId)) {
      if (visibleByTrackId[trackId] !== true) continue;
      for (const targetKey of targetKeys) {
        const existing = persistedAutomation.envelopes().find((envelope) => envelope.targetKey === targetKey);
        const selection = existing
          ? { parameterId: existing.parameterId, effectInstanceId: existing.target.effectInstanceId }
          : getAutomationParameterOptionsForTarget(effectInstancesByOwnerKey()[trackId] ?? [], trackId)
            .find((option) => automationTargetKey(
              createAutomationTarget({ kind: "track", trackId }, option.effectInstanceId),
              option.parameterId,
            ) === targetKey);
        if (!selection) continue;
        seed(createAutomationTarget({ kind: "track", trackId }, selection.effectInstanceId), selection.parameterId);
      }
    }
  };

  createEffect(() => {
    const rid = options.projectId();
    if (!rid) {
      setAutomationEnvelopes([]);
      setAutomationDataReady(false);
      setOverriddenAutomationTargetKeys(new Set<string>());
      options.audioEngine.setAutomationEnvelopes([]);
      return;
    }
    setOverriddenAutomationTargetKeys(new Set<string>());
    if (isLocalId("project", rid)) {
      setAutomationDataReady(false);
      void loadLocalAutomationEnvelopes(rid).then((rows) => {
        if (options.projectId() !== rid) return;
        setAutomationEnvelopes(rows);
        setAutomationDataReady(true);
        untrack(persistedAutomation.syncRemote);
      }).catch(() => {
        if (options.projectId() !== rid) return;
        setAutomationEnvelopes([]);
        setAutomationDataReady(true);
        untrack(persistedAutomation.syncRemote);
      });
      return;
    }
    const remoteRows = options.remoteRows();
    if (remoteRows === undefined) {
      setAutomationDataReady(false);
      return;
    }
    const next = remoteRows.flatMap((row) => {
      const envelope = automationEnvelopeFromRow(row);
      return envelope ? [envelope] : [];
    });
    setAutomationEnvelopes(next);
    setAutomationDataReady(true);
    untrack(persistedAutomation.syncRemote);
  });
  createEffect(() => {
    const rid = options.projectId();
    if (!rid) {
      setEffectInstancesByOwnerKey({});
      return;
    }
    const collect = (rows: Array<{
      targetId: string
      kind: string
      instanceId?: string
      index?: number
      params?: unknown
      external?: { name: string; parameters: readonly AutomationExternalParameter[] }
      externalValues?: ReadonlyMap<number, number>
    }>) => {
      const grouped = new Map<string, Array<AutomationTargetDeviceInstance & { index: number }>>();
      const values = new Map<string, number>();
      for (const row of rows) {
        if (row.external) {
          const entries = grouped.get(row.targetId) ?? [];
          entries.push({
            id: row.instanceId ?? "external",
            kind: "external",
            name: row.external.name,
            parameters: row.external.parameters,
            index: row.index ?? entries.length,
          });
          grouped.set(row.targetId, entries);
          const externalInstanceId = row.instanceId ?? "external";
          for (const parameter of row.external.parameters) {
            const value = row.externalValues?.get(parameter.id);
            if (value !== undefined) {
              const target = row.targetId === "master"
                ? { kind: "master" as const, effectInstanceId: externalInstanceId }
                : { kind: "track" as const, trackId: row.targetId, effectInstanceId: externalInstanceId };
              values.set(automationTargetKey(
                target,
                externalAutomationParameterId(externalInstanceId, parameter.id),
              ), value);
            }
          }
          continue;
        }
        const normalizedKind = row.kind.startsWith("master-") ? row.kind.slice("master-".length) : row.kind;
        if (normalizedKind === "instrument" || normalizedKind === "synth") {
          const instrument = readInstrumentParamsFromEffectRow({
            effect: normalizedKind,
            instanceId: row.instanceId,
            params: row.params,
          });
          if (!instrument || (instrument.kind !== "sampler" && instrument.kind !== "granular" && instrument.kind !== "synth")) continue;
          const entries = grouped.get(row.targetId) ?? [];
          entries.push({ id: instrument.instanceId, kind: instrument.kind, index: row.index ?? entries.length });
          grouped.set(row.targetId, entries);
          if (row.targetId !== "master") {
            for (const parameter of getAutomationParameterOptionsForTarget(
              [{ id: instrument.instanceId, kind: instrument.kind }],
              row.targetId,
            )) {
              if (parameter.parameterId === "volume") continue;
              const value = readInstrumentParameterValue(instrument, parameter.parameterId);
              if (value !== undefined) {
                values.set(automationTargetKey(
                  { kind: "track", trackId: row.targetId },
                  parameter.parameterId,
                ), value);
              }
            }
          }
          continue;
        }
        if (!isAudioEffectKind(normalizedKind)) continue;
        const entries = grouped.get(row.targetId) ?? [];
        entries.push({ id: row.instanceId ?? normalizedKind, kind: normalizedKind, index: row.index ?? entries.length });
        grouped.set(row.targetId, entries);
        const effectInstanceId = row.instanceId ?? normalizedKind;
        for (const parameter of getAutomationParameterOptionsForTarget(
          [{ id: effectInstanceId, kind: normalizedKind }],
          row.targetId === "master" ? undefined : row.targetId,
        )) {
          if (parameter.parameterId === "volume" || parameter.effectInstanceId !== effectInstanceId) continue;
          const value = isJsonValue(row.params)
            ? readEffectParameterValue(row.params, parameter.parameterId)
            : undefined;
          if (value !== undefined) {
            const target = row.targetId === "master"
              ? { kind: "master" as const, effectInstanceId }
              : { kind: "track" as const, trackId: row.targetId, effectInstanceId };
            values.set(automationTargetKey(
              target,
              parameter.parameterId,
            ), value);
          }
        }
      }
      const next: Record<string, AutomationTargetDeviceInstance[]> = {};
      for (const [targetId, entries] of grouped) {
        next[targetId] = entries
          .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
          .map((entry) => entry.kind === "external"
            ? {
              id: entry.id,
              kind: "external" as const,
              name: entry.name,
              parameters: entry.parameters,
            }
            : { id: entry.id, kind: entry.kind });
      }
      setEffectInstancesByOwnerKey(next);
      setAutomationValuesByTargetKey(values);
    };
    setEffectDataReady(false);
    if (isLocalId("project", rid)) {
      const reload = () => {
        setEffectDataReady(false);
        void Promise.all([listLocalEffects(rid), listLocalExternalProcessors(rid)]).then(([rows, processors]) => {
          if (options.projectId() !== rid) return;
          collect([
            ...rows.map((row) => ({
              targetId: row.targetId,
              kind: row.effect,
              instanceId: row.instanceId,
              index: row.index,
              params: row.params,
            })),
            ...processors.map((processor) => ({
              targetId: processor.targetId,
              kind: "external",
              instanceId: processor.instanceId,
              index: processor.index,
              external: {
                name: processor.manifest.identity.name,
                parameters: processor.manifest.parameters
                  .map(({ id, title, unit, readOnly, hidden }) => ({ id, title, unit, readOnly, hidden })),
              },
              externalValues: new Map(processor.manifest.parameters.map((parameter) => [
                parameter.id,
                processor.parameterOverrides[String(parameter.id)] ?? parameter.defaultValue,
              ])),
            })),
          ]);
          setEffectDataReady(true);
        }).catch(() => {
          if (options.projectId() !== rid) return;
          setEffectInstancesByOwnerKey({});
          setAutomationValuesByTargetKey(new Map());
          setEffectDataReady(true);
        });
      };
      reload();
      const unsubscribe = subscribeToLocalProjectChanges(rid, reload);
      onCleanup(unsubscribe);
    }
    if (!isLocalId("project", rid)) {
      const remoteEffects = options.remoteEffects();
      if (remoteEffects === undefined) return;
      collect(remoteEffects.map((row) => ({
        targetId: row.targetType === "master" ? "master" : row.trackId ?? "",
        kind: row.type,
        instanceId: row.instanceId,
        index: row.index,
        params: row.params,
      })).filter((row) => row.targetId.length > 0));
      setEffectDataReady(true);
    }
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
  const initialValueForTarget = (target: AutomationTarget, parameterId: string) => {
    const key = automationTargetKey(target, parameterId);
    if (parameterId === "volume") {
      if (target.kind === "master") return options.masterVolume();
      return options.tracks().find((track) => track.id === target.trackId)?.volume;
    }
    return automationValuesByTargetKey().get(key);
  };
  createEffect(() => {
    options.projectId();
    options.tracks();
    options.masterReady();
    effectDataReady();
    automationDataReady();
    visibleAutomationTracks.value();
    visibleAutomationLanes.value();
    selectedAutomationParameters.value();
    persistedAutomation.envelopes();
    seedVisibleAutomationLanes();
  });
  const targetKeyForTrackSelection = (trackId: Track["id"], selection: AutomationParameterSelection) => (
    automationTargetKey(createAutomationTarget({ kind: "track", trackId }, selection.effectInstanceId), selection.parameterId)
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
        selections.set(automationTargetKey({ kind: "master" }, "volume"), { parameterId: "volume" });
        for (const track of options.tracks()) {
          selections.set(automationTargetKey({ kind: "track", trackId: track.id }, "volume"), { parameterId: "volume" });
        }
        for (const [ownerKey, effects] of Object.entries(effectInstancesByOwnerKey())) {
          const target = ownerKey === "master"
            ? { kind: "master" as const }
            : { kind: "track" as const, trackId: ownerKey };
          for (const option of getAutomationParameterOptionsForTarget(effects, ownerKey === "master" ? undefined : ownerKey)) {
            selections.set(
              automationTargetKey(createAutomationTarget(target, option.effectInstanceId), option.parameterId),
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
        void persistedAutomation.commitEnvelope(envelope, targetKey).catch((cause: unknown) => {
          options.onPersistenceError?.(cause instanceof Error ? cause : new Error("Automation could not be saved."));
        });
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
    snapshotExportPatches: (): ExportAutomationPatch[] => persistedAutomation.snapshotPatches(),
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
