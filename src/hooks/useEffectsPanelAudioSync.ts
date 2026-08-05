import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import {
  AUDIO_EFFECT_CONTRACTS,
  isAudioEffectKind,
  type AudioEffectKind,
  type CompressorParams,
  type ArpeggiatorParams,
  type DelayParams,
  type EqParams,
  type ReverbParams,
  type SaturatorParams,
  type TrackInstrumentParams,isLocalId
} from "@daw-browser/shared";
import type { AudioEffectRuntimeInstance, AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import type { convexApi } from "~/lib/convex";
import { audioEffectKindFromLocalEffect, listLocalEffects, type LocalEffectRow } from "~/lib/local-effects";
import { collectAudioEffectInstances } from "~/lib/audio-effect-order-rows";
import { subscribeToLocalProjectChanges } from "~/lib/local-project-changes";
import type { ExternalSidechainRoute, Track } from "@daw-browser/timeline-core/types";
import { readInstrumentParamsFromEffectRow } from "~/lib/effect-row-instrument-params";
import { createDrumRackBufferSync } from "~/lib/drum-rack-buffer-sync";
import type { createSamplerBufferSync } from "~/lib/sampler-buffer-sync";

type UseEffectsPanelAudioSyncOptions = {
  isOpen: Accessor<boolean>;
  projectId: Accessor<string | undefined>;
  currentTargetId: Accessor<string>;
  tracks: Accessor<Track[]>;
  sidechainRoutes: Accessor<ExternalSidechainRoute[]>;
  audioEngine: Accessor<AudioEngine>;
  usesLegacyAudioEngine?: Accessor<boolean>;
  roomEffects: Accessor<RoomEffectRow[] | undefined>;
  localDraftEffects?: {
    eq?: (targetId: string) => EqParams | undefined;
    compressor?: (targetId: string) => CompressorParams | undefined;
    saturator?: (targetId: string) => SaturatorParams | undefined;
    delay?: (targetId: string) => DelayParams | undefined;
    reverb?: (targetId: string) => ReverbParams | undefined;
    instrument?: (targetId: string) => TrackInstrumentParams | undefined;
    arp?: (targetId: string) => ArpeggiatorParams | undefined;
  };
  samplerBufferSync: ReturnType<typeof createSamplerBufferSync>;
  spectrumProvider?: Accessor<((targetId: string, listener: (frame: SpectrumFrame | null) => void) => () => void) | undefined>;
};

type RoomEffectRow = FunctionReturnType<typeof convexApi.effects.listByRoom>[number];
type SyncedEffectRow = RoomEffectRow | LocalEffectRow;

type UseEffectsPanelAudioSyncReturn = {
  spectrum: Accessor<SpectrumFrame | null>;
};

type SpectrumProvider = (
  targetId: string,
  listener: (frame: SpectrumFrame | null) => void,
) => () => void;

export const createSpectrumSubscriptionOwner = (
  setFrame: (frame: SpectrumFrame | null) => void,
) => {
  let unsubscribe: () => void = () => undefined;
  let generation = 0;
  let disposed = false;
  let activeOpen = false;
  let activeProvider: SpectrumProvider | undefined;
  let activeTargetId = "";

  const update = (
    isOpen: boolean,
    provider: SpectrumProvider | undefined,
    targetId: string,
  ) => {
    if (disposed) return;
    if (isOpen === activeOpen && provider === activeProvider && targetId === activeTargetId) return;
    generation += 1;
    unsubscribe();
    unsubscribe = () => undefined;
    activeOpen = isOpen;
    activeProvider = provider;
    activeTargetId = targetId;
    if (!isOpen || !provider) {
      setFrame(null);
      return;
    }
    const subscriptionGeneration = generation;
    unsubscribe = provider(targetId, (frame) => {
      if (!disposed && subscriptionGeneration === generation) setFrame(frame);
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    unsubscribe();
    unsubscribe = () => undefined;
  };

  return { update, dispose };
};

type SyncedAudioEffectInstanceRow = AudioEffectRuntimeInstance & {
  targetId: string;
  index?: number;
};

const createSyncedAudioEffectInstanceRow = (
  targetId: string,
  kind: AudioEffectKind,
  params: unknown,
  instanceId?: string,
  index?: number
): SyncedAudioEffectInstanceRow => {
  if (!instanceId) throw new Error(`Audio effect "${kind}" is missing an instance ID.`)
  const id = instanceId;
  const input = params && typeof params === "object" ? params : {};
  if (kind === "utility") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.utility.normalizeParams(input), index };
  if (kind === "autofilter") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(input), index };
  if (kind === "eq") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams(input), index };
  if (kind === "gate") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.gate.normalizeParams(input), index };
  if (kind === "compressor") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams(input), index };
  if (kind === "saturator") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams(input), index };
  if (kind === "limiter") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(input), index };
  if (kind === "lofi") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(input), index };
  if (kind === "delay") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams(input), index };
  if (kind === "reverb") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams(input), index };
  if (kind === "chorus") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(input), index };
  if (kind === "flanger") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(input), index };
  if (kind === "phaser") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(input), index };
  if (kind === "tremolo") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(input), index };
  if (kind === "autopan") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(input), index };
  if (kind === "spectral") return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams(input), index };
  return { targetId, id, kind, params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(input), index };
};

const collectSyncedAudioEffectInstances = (effects: SyncedEffectRow[]) => {
  const rows: SyncedAudioEffectInstanceRow[] = [];
  for (const row of effects) {
    let instance: SyncedAudioEffectInstanceRow | undefined;
    if ("effect" in row) {
      const kind = audioEffectKindFromLocalEffect(row.effect);
      if (kind) instance = createSyncedAudioEffectInstanceRow(row.targetId, kind, row.params, row.instanceId, row.index);
    } else if (isAudioEffectKind(row.type) && row.params) {
      const targetId = row.targetType === "master" ? "master" : row.trackId;
      if (targetId) instance = createSyncedAudioEffectInstanceRow(targetId, row.type, row.params, row.instanceId, row.index);
    }
    if (!instance) continue;
    rows.push(instance);
  }
  const instances = collectAudioEffectInstances(rows.map((row) => ({
    targetId: row.targetId,
    kind: row.kind,
    instanceId: row.id,
    index: row.index,
  })));
  const rowByKey = new Map(rows.map((row) => [`${row.targetId}:${row.id}`, row]));
  const toRuntimeInstances = (targetId: string, order: ReturnType<typeof collectAudioEffectInstances>["master"]): AudioEffectRuntimeInstance[] => {
    const runtimeInstances: AudioEffectRuntimeInstance[] = [];
    for (const instance of order) {
      const row = rowByKey.get(`${targetId}:${instance.id}`);
      if (!row) continue;
      if (row.kind === "utility") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "autofilter") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "eq") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "gate") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "compressor") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "saturator") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "limiter") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "lofi") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "delay") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "reverb") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "chorus") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "flanger") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "phaser") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "tremolo") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "autopan") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else if (row.kind === "spectral") runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
      else runtimeInstances.push({ id: row.id, kind: row.kind, params: row.params });
    }
    return runtimeInstances;
  };
  return {
    master: toRuntimeInstances("master", instances.master),
    tracks: new Map([...instances.tracks].map(([trackId, order]) => [trackId, toRuntimeInstances(trackId, order)])),
  };
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

  let syncedTrackIds = new Set<Track["id"]>();
  let syncedProjectId: string | null = null;
  const drumRackBufferSync = createDrumRackBufferSync();
  const samplerBufferSync = options.samplerBufferSync;
  onCleanup(drumRackBufferSync.dispose);

  const clearSyncedTrackState = (audioEngine: AudioEngine, trackIds: Iterable<Track["id"]>) => {
    for (const trackId of trackIds) {
      void audioEngine.setTrackFxInstances(trackId, [])
        .catch(() => undefined);
      audioEngine.clearTrackInstrument(trackId);
      audioEngine.clearTrackArpeggiator(trackId);
      drumRackBufferSync.clearTrack(trackId);
      samplerBufferSync.clearTrack(trackId);
    }
  };

  const clearSyncedMasterState = (audioEngine: AudioEngine) => {
    void audioEngine.setMasterFxInstances([]).catch(() => undefined);
  };

  createEffect(() => {
    const audioEngine = options.audioEngine();
    if (options.usesLegacyAudioEngine && !options.usesLegacyAudioEngine()) return;
    const projectId = options.projectId();
    if (projectId) return;
    clearSyncedTrackState(audioEngine, syncedTrackIds);
    clearSyncedMasterState(audioEngine);
    syncedTrackIds = new Set();
    syncedProjectId = null;
  });

  createEffect(() => {
    const audioEngine = options.audioEngine();
    if (options.usesLegacyAudioEngine && !options.usesLegacyAudioEngine()) return;
    const projectId = options.projectId();
    const effects: SyncedEffectRow[] | undefined = projectId && isLocalId("project", projectId)
      ? localEffects()
      : options.roomEffects();

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

    const instrumentByTrackId = new Map<string, TrackInstrumentParams>();
    const arpByTrackId = new Map<string, ArpeggiatorParams>();
    const effectInstances = collectSyncedAudioEffectInstances(effects);

    for (const row of effects) {
      if ("effect" in row) {
        if (row.effect === "instrument" || (row.effect === "synth" && !instrumentByTrackId.has(row.targetId))) {
          const instrument = readInstrumentParamsFromEffectRow(row);
          if (instrument) instrumentByTrackId.set(row.targetId, instrument);
          continue;
        }
        if (row.effect === "arp") {
          arpByTrackId.set(row.targetId, row.params);
          continue;
        }
        continue;
      }
      const trackId = row.trackId;
      if (!trackId) continue;
      if (row.type === "instrument" || (row.type === "synth" && !instrumentByTrackId.has(trackId))) {
        const instrument = readInstrumentParamsFromEffectRow(row);
        if (instrument) instrumentByTrackId.set(trackId, instrument);
      }
      if (row.type === "arpeggiator" && row.params) arpByTrackId.set(trackId, row.params);
    }

    void audioEngine.setMasterFxInstances(effectInstances.master).catch(() => undefined);

    const staleTrackIds = new Set<Track["id"]>();
    for (const trackId of syncedTrackIds) {
      if (!currentTrackIds.has(trackId)) {
        staleTrackIds.add(trackId);
      }
    }
    clearSyncedTrackState(audioEngine, staleTrackIds);

    for (const track of tracks) {
      const trackEffectInstances = effectInstances.tracks.get(track.id) ?? [];
      void audioEngine.setTrackFxInstances(track.id, trackEffectInstances).catch(() => undefined);
      if (track.kind === "instrument") {
        const instrument = options.localDraftEffects?.instrument?.(track.id) ?? instrumentByTrackId.get(track.id);
        if (instrument?.kind === "synth") {
          drumRackBufferSync.clearTrack(track.id);
          samplerBufferSync.clearTrack(track.id);
          audioEngine.setTrackInstrument(track.id, { instrument });
        } else if (instrument?.kind === "drum-rack") {
          samplerBufferSync.clearTrack(track.id);
          drumRackBufferSync.syncTrack(audioEngine, track.id, instrument.params);
        } else if (instrument?.kind === "sampler") {
          drumRackBufferSync.clearTrack(track.id);
          samplerBufferSync.syncTrack(audioEngine, track.id, instrument.params, instrument.instanceId);
        } else if (instrument?.kind === "granular") {
          drumRackBufferSync.clearTrack(track.id);
          samplerBufferSync.syncGranularTrack(audioEngine, track.id, instrument.params, instrument.instanceId);
        } else {
          drumRackBufferSync.clearTrack(track.id);
          samplerBufferSync.clearTrack(track.id);
          audioEngine.clearTrackInstrument(track.id);
        }
        const arp = options.localDraftEffects?.arp?.(track.id) ?? arpByTrackId.get(track.id);
        if (arp) audioEngine.setTrackArpeggiator(track.id, arp);
        else audioEngine.clearTrackArpeggiator(track.id);
        continue;
      }
      drumRackBufferSync.clearTrack(track.id);
      samplerBufferSync.clearTrack(track.id);
      audioEngine.clearTrackInstrument(track.id);
      audioEngine.clearTrackArpeggiator(track.id);
    }
    audioEngine.setExternalSidechainRoutes(options.sidechainRoutes());

    syncedTrackIds = new Set(currentTrackIds);
    syncedProjectId = projectId;
  });

  const [spectrum, setSpectrum] = createSignal<SpectrumFrame | null>(null);

  const spectrumSubscription = createSpectrumSubscriptionOwner(setSpectrum);
  spectrumSubscription.update(options.isOpen(), options.spectrumProvider?.(), options.currentTargetId());
  createEffect(() => {
    spectrumSubscription.update(options.isOpen(), options.spectrumProvider?.(), options.currentTargetId());
  });
  onCleanup(spectrumSubscription.dispose);

  return {
    spectrum,
  };
}
