import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import {
  createDefaultEqParams,
  createDefaultReverbParams,
  normalizeReverbParams,
  normalizeSynthParams,
  type ArpeggiatorParams,
  type EqParams,
  type ReverbParams,
  type SynthParams,
} from "@daw-browser/shared";
import type { AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import { convexApi } from "~/lib/convex";
import { listLocalEffects, type LocalEffectRow } from "~/lib/local-effects";
import { isLocalId } from "@daw-browser/shared";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import type { Track } from "@daw-browser/timeline-core/types";

type UseEffectsPanelAudioSyncOptions = {
  isOpen: Accessor<boolean>;
  projectId: Accessor<string | undefined>;
  currentTargetId: Accessor<string>;
  tracks: Accessor<Track[]>;
  audioEngine: Accessor<AudioEngine>;
  roomEffects: Accessor<RoomEffectRow[] | undefined>;
  playheadSec?: Accessor<number | undefined>;
  localDraftEffects?: {
    eq?: (targetId: string) => EqParams | undefined;
    reverb?: (targetId: string) => ReverbParams | undefined;
    synth?: (targetId: string) => SynthParams | undefined;
    arp?: (targetId: string) => ArpeggiatorParams | undefined;
  };
};

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type SyncedEffectRow = RoomEffectRow | LocalEffectRow;

type UseEffectsPanelAudioSyncReturn = {
  spectrum: Accessor<SpectrumFrame | null>;
};

export function useEffectsPanelAudioSync(
  options: UseEffectsPanelAudioSyncOptions,
): UseEffectsPanelAudioSyncReturn {
  const [localEffects, setLocalEffects] = createSignal<LocalEffectRow[] | undefined>(undefined);

  createEffect(on(options.projectId, (projectId) => {
    if (!projectId || !isLocalId("project", projectId)) {
      setLocalEffects(undefined);
      return;
    }
    const isCurrentProject = () => options.projectId() === projectId;
    const reloadLocalEffects = () => listLocalEffects(projectId).then((rows) => {
      if (isCurrentProject()) {
        setLocalEffects(rows);
      }
    }).catch(() => {
      if (isCurrentProject()) {
        setLocalEffects([]);
      }
    });
    void reloadLocalEffects();
    const unsubscribe = subscribeToLocalProjectChanges(projectId, () => {
      void reloadLocalEffects();
    })
    onCleanup(unsubscribe)
  }));

  const disabledEq = { ...createDefaultEqParams(), enabled: false };
  const disabledReverb = { ...createDefaultReverbParams(), enabled: false };
  let syncedTrackIds = new Set<Track["id"]>();
  let syncedProjectId: string | null = null;

  const clearSyncedTrackState = (audioEngine: AudioEngine, trackIds: Iterable<Track["id"]>) => {
    for (const trackId of trackIds) {
      audioEngine.setTrackEq(trackId, disabledEq);
      audioEngine.setTrackReverb(trackId, disabledReverb);
      audioEngine.clearTrackSynth(trackId);
      audioEngine.clearTrackArpeggiator(trackId);
    }
  };

  const clearSyncedMasterState = (audioEngine: AudioEngine) => {
    audioEngine.setMasterEq(disabledEq);
    audioEngine.setMasterReverb(disabledReverb);
  };

  createEffect(() => {
    const audioEngine = options.audioEngine();
    const projectId = options.projectId();
    if (projectId) return;
    clearSyncedTrackState(audioEngine, syncedTrackIds);
    clearSyncedMasterState(audioEngine);
    syncedTrackIds = new Set();
    syncedProjectId = null;
  });

  createEffect(() => {
    const audioEngine = options.audioEngine();
    const projectId = options.projectId();
    const effects: SyncedEffectRow[] | undefined = projectId && isLocalId("project", projectId)
      ? localEffects()
      : options.roomEffects();

    const activeTargetId = options.currentTargetId();
    const tracks = options.tracks();
    const currentTrackIds = new Set(tracks.map((track) => track.id));
    if (effects === undefined) {
      if (projectId && syncedProjectId !== projectId) {
        clearSyncedTrackState(audioEngine, new Set([...syncedTrackIds, ...currentTrackIds]));
        clearSyncedMasterState(audioEngine);
        syncedTrackIds = new Set(currentTrackIds);
        syncedProjectId = projectId;
      }
      return;
    }

    if (!projectId) return;

    const eqByTrackId = new Map<string, EqParams>();
    const reverbByTrackId = new Map<string, ReverbParams>();
    const synthByTrackId = new Map<string, SynthParams>();
    const arpByTrackId = new Map<string, ArpeggiatorParams>();
    let hasMasterEq = false;
    let hasMasterReverb = false;

    for (const row of effects) {
      if ("effect" in row) {
        if (row.effect === "master-eq") {
          if (activeTargetId !== "master") {
            hasMasterEq = true;
            audioEngine.setMasterEq(row.params);
          }
          continue;
        }
        if (row.effect === "master-reverb") {
          if (activeTargetId !== "master") {
            hasMasterReverb = true;
            audioEngine.setMasterReverb(normalizeReverbParams(row.params));
          }
          continue;
        }
        if (row.effect === "eq") {
          if (row.targetId !== activeTargetId) eqByTrackId.set(row.targetId, row.params);
          continue;
        }
        if (row.effect === "reverb") {
          if (row.targetId !== activeTargetId) reverbByTrackId.set(row.targetId, normalizeReverbParams(row.params));
          continue;
        }
        if (row.effect === "synth") {
          if (row.targetId !== activeTargetId) synthByTrackId.set(row.targetId, normalizeSynthParams(row.params));
          continue;
        }
        if (row.effect === "arp") {
          if (row.targetId !== activeTargetId) arpByTrackId.set(row.targetId, row.params);
          continue;
        }
        continue;
      }
      if (row.targetType === "master") {
        if (activeTargetId === "master") continue;
        if (row.type === "eq" && row.params) {
          hasMasterEq = true;
          audioEngine.setMasterEq(row.params);
        }
        if (row.type === "reverb" && row.params) {
          hasMasterReverb = true;
          audioEngine.setMasterReverb(normalizeReverbParams(row.params));
        }
        continue;
      }

      const trackId = row?.trackId;
      if (!trackId || trackId === activeTargetId) continue;
      if (row.type === "eq" && row.params) eqByTrackId.set(trackId, row.params);
      if (row.type === "reverb" && row.params) reverbByTrackId.set(trackId, normalizeReverbParams(row.params));
      if (row.type === "synth" && row.params) synthByTrackId.set(trackId, normalizeSynthParams(row.params));
      if (row.type === "arpeggiator" && row.params) arpByTrackId.set(trackId, row.params);
    }

    const masterEqDraft = activeTargetId === "master"
      ? undefined
      : options.localDraftEffects?.eq?.("master");
    if (masterEqDraft) {
      hasMasterEq = true;
      audioEngine.setMasterEq(masterEqDraft);
    }

    const masterReverbDraft = activeTargetId === "master"
      ? undefined
      : options.localDraftEffects?.reverb?.("master");
    if (masterReverbDraft) {
      hasMasterReverb = true;
      audioEngine.setMasterReverb(masterReverbDraft);
    }

    if (activeTargetId !== "master") {
      if (!hasMasterEq) audioEngine.setMasterEq(disabledEq);
      if (!hasMasterReverb) audioEngine.setMasterReverb(disabledReverb);
    }

    const staleTrackIds = new Set<Track["id"]>();
    for (const trackId of syncedTrackIds) {
      if (!currentTrackIds.has(trackId)) {
        staleTrackIds.add(trackId);
      }
    }
    clearSyncedTrackState(audioEngine, staleTrackIds);

    for (const track of tracks) {
      if (track.id === activeTargetId) continue;
      const eq = options.localDraftEffects?.eq?.(track.id) ?? eqByTrackId.get(track.id);
      if (eq) audioEngine.setTrackEq(track.id, eq);
      else audioEngine.setTrackEq(track.id, disabledEq);
      const reverb = options.localDraftEffects?.reverb?.(track.id) ?? reverbByTrackId.get(track.id);
      if (reverb) audioEngine.setTrackReverb(track.id, reverb);
      else audioEngine.setTrackReverb(track.id, disabledReverb);
      if (track.kind === "instrument") {
        const synth = options.localDraftEffects?.synth?.(track.id) ?? synthByTrackId.get(track.id);
        if (synth) audioEngine.setTrackSynth(track.id, synth);
        else audioEngine.clearTrackSynth(track.id);
        const arp = options.localDraftEffects?.arp?.(track.id) ?? arpByTrackId.get(track.id);
        if (arp) audioEngine.setTrackArpeggiator(track.id, arp);
        else audioEngine.clearTrackArpeggiator(track.id);
        continue;
      }
      audioEngine.clearTrackSynth(track.id);
      audioEngine.clearTrackArpeggiator(track.id);
    }

    syncedTrackIds = new Set(currentTrackIds);
    syncedProjectId = projectId;
  });

  const [spectrum, setSpectrum] = createSignal<SpectrumFrame | null>(null);

  createEffect(() => {
    if (!options.isOpen()) {
      setSpectrum(null);
      return;
    }
    options.playheadSec?.();
    try {
      const audioEngine = options.audioEngine();
      const id = options.currentTargetId();
      const data = id === "master"
        ? audioEngine.getMasterSpectrum()
        : audioEngine.getTrackSpectrum(id);
      setSpectrum(data ?? null);
    } catch {
      setSpectrum(null);
    }
  });

  return {
    spectrum,
  };
}
