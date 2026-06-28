import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { FunctionReturnType } from "convex/server";
import {
  AUDIO_EFFECT_CONTRACTS,
  isAudioEffectKind,
  createDefaultEqParams,
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
  normalizeSynthParams,
  type AudioEffectKind,
  type CompressorParams,
  type ArpeggiatorParams,
  type DelayParams,
  type EqParams,
  type ReverbParams,
  type SaturatorParams,
  type SynthParams,
} from "@daw-browser/shared";
import type { AudioEngine, SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import { convexApi } from "~/lib/convex";
import { audioEffectKindFromLocalEffect, listLocalEffects, type LocalEffectRow } from "~/lib/local-effects";
import { collectAudioEffectOrders as collectAudioEffectOrdersFromEntries } from "~/lib/audio-effect-order-rows";
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
  isPlaying: Accessor<boolean>;
  playheadSec?: Accessor<number | undefined>;
  localDraftEffects?: {
    eq?: (targetId: string) => EqParams | undefined;
    compressor?: (targetId: string) => CompressorParams | undefined;
    saturator?: (targetId: string) => SaturatorParams | undefined;
    delay?: (targetId: string) => DelayParams | undefined;
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

type SyncedAudioEffectDescriptor<Params> = {
  kind: AudioEffectKind;
  normalize: (params: Params) => Params;
  disabled: Params;
  readDraft: (drafts: UseEffectsPanelAudioSyncOptions["localDraftEffects"], targetId: string) => Params | undefined;
  setMaster: (audioEngine: AudioEngine, params: Params) => void;
  setTrack: (audioEngine: AudioEngine, trackId: string, params: Params) => void;
};

type SyncedAudioEffectState<Params> = {
  byTrackId: Map<string, Params>;
  hasMaster: boolean;
};

const createSyncedAudioEffectState = <Params,>(): SyncedAudioEffectState<Params> => ({
  byTrackId: new Map<string, Params>(),
  hasMaster: false,
});

const syncLocalAudioEffect = <Params,>(
  row: LocalEffectRow,
  descriptor: SyncedAudioEffectDescriptor<Params>,
  state: SyncedAudioEffectState<Params>,
  activeTargetId: string,
  audioEngine: AudioEngine,
) => {
  if (row.effect === AUDIO_EFFECT_CONTRACTS[descriptor.kind].masterKind) {
    if (activeTargetId !== "master") {
      state.hasMaster = true;
      descriptor.setMaster(audioEngine, descriptor.normalize(row.params));
    }
    return true;
  }
  if (row.effect === descriptor.kind) {
    if (row.targetId !== activeTargetId) {
      state.byTrackId.set(row.targetId, descriptor.normalize(row.params));
    }
    return true;
  }
  return false;
};

const syncRemoteAudioEffect = <Params,>(
  row: RoomEffectRow,
  descriptor: SyncedAudioEffectDescriptor<Params>,
  state: SyncedAudioEffectState<Params>,
  activeTargetId: string,
  audioEngine: AudioEngine,
) => {
  if (row.type !== descriptor.kind || !row.params) return false;
  if (row.targetType === "master") {
    if (activeTargetId !== "master") {
      state.hasMaster = true;
      descriptor.setMaster(audioEngine, descriptor.normalize(row.params));
    }
    return true;
  }
  if (row.trackId && row.trackId !== activeTargetId) {
    state.byTrackId.set(row.trackId, descriptor.normalize(row.params));
  }
  return true;
};

const applyMasterAudioDraft = <Params,>(
  descriptor: SyncedAudioEffectDescriptor<Params>,
  state: SyncedAudioEffectState<Params>,
  activeTargetId: string,
  audioEngine: AudioEngine,
  drafts: UseEffectsPanelAudioSyncOptions["localDraftEffects"],
) => {
  if (activeTargetId === "master") return;
  const draft = descriptor.readDraft(drafts, "master");
  if (!draft) return;
  state.hasMaster = true;
  descriptor.setMaster(audioEngine, draft);
};

const applyTrackAudioEffect = <Params,>(
  descriptor: SyncedAudioEffectDescriptor<Params>,
  state: SyncedAudioEffectState<Params>,
  trackId: string,
  audioEngine: AudioEngine,
  drafts: UseEffectsPanelAudioSyncOptions["localDraftEffects"],
) => {
  const params = descriptor.readDraft(drafts, trackId) ?? state.byTrackId.get(trackId);
  descriptor.setTrack(audioEngine, trackId, params ?? descriptor.disabled);
};

const collectSyncedAudioEffectOrders = (effects: SyncedEffectRow[]) => collectAudioEffectOrdersFromEntries(
  effects.flatMap((row) => {
    if ("effect" in row) {
      const kind = audioEffectKindFromLocalEffect(row.effect);
      return kind ? [{ targetId: row.targetId, kind, index: row.index }] : [];
    }
    if (!isAudioEffectKind(row.type)) return [];
    if (row.targetType === "master") return [{ targetId: "master", kind: row.type, index: row.index }];
    return row.trackId ? [{ targetId: row.trackId, kind: row.type, index: row.index }] : [];
  }),
);

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
  const disabledCompressor = { ...createDefaultCompressorParams(), enabled: false };
  const disabledSaturator = { ...createDefaultSaturatorParams(), enabled: false };
  const disabledDelay = { ...createDefaultDelayParams(), enabled: false };
  const disabledReverb = { ...createDefaultReverbParams(), enabled: false };
  const eqSyncDescriptor: SyncedAudioEffectDescriptor<EqParams> = {
    kind: AUDIO_EFFECT_CONTRACTS.eq.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams,
    disabled: disabledEq,
    readDraft: (drafts, targetId) => drafts?.eq?.(targetId),
    setMaster: (audioEngine, params) => audioEngine.setMasterEq(params),
    setTrack: (audioEngine, trackId, params) => audioEngine.setTrackEq(trackId, params),
  };
  const compressorSyncDescriptor: SyncedAudioEffectDescriptor<CompressorParams> = {
    kind: AUDIO_EFFECT_CONTRACTS.compressor.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams,
    disabled: disabledCompressor,
    readDraft: (drafts, targetId) => drafts?.compressor?.(targetId),
    setMaster: (audioEngine, params) => audioEngine.setMasterCompressor(params),
    setTrack: (audioEngine, trackId, params) => audioEngine.setTrackCompressor(trackId, params),
  };
  const saturatorSyncDescriptor: SyncedAudioEffectDescriptor<SaturatorParams> = {
    kind: AUDIO_EFFECT_CONTRACTS.saturator.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams,
    disabled: disabledSaturator,
    readDraft: (drafts, targetId) => drafts?.saturator?.(targetId),
    setMaster: (audioEngine, params) => audioEngine.setMasterSaturator(params),
    setTrack: (audioEngine, trackId, params) => audioEngine.setTrackSaturator(trackId, params),
  };
  const delaySyncDescriptor: SyncedAudioEffectDescriptor<DelayParams> = {
    kind: AUDIO_EFFECT_CONTRACTS.delay.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams,
    disabled: disabledDelay,
    readDraft: (drafts, targetId) => drafts?.delay?.(targetId),
    setMaster: (audioEngine, params) => audioEngine.setMasterDelay(params),
    setTrack: (audioEngine, trackId, params) => audioEngine.setTrackDelay(trackId, params),
  };
  const reverbSyncDescriptor: SyncedAudioEffectDescriptor<ReverbParams> = {
    kind: AUDIO_EFFECT_CONTRACTS.reverb.kind,
    normalize: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams,
    disabled: disabledReverb,
    readDraft: (drafts, targetId) => drafts?.reverb?.(targetId),
    setMaster: (audioEngine, params) => audioEngine.setMasterReverb(params),
    setTrack: (audioEngine, trackId, params) => audioEngine.setTrackReverb(trackId, params),
  };
  let syncedTrackIds = new Set<Track["id"]>();
  let syncedProjectId: string | null = null;

  const clearSyncedTrackState = (audioEngine: AudioEngine, trackIds: Iterable<Track["id"]>) => {
    for (const trackId of trackIds) {
      audioEngine.setTrackEq(trackId, disabledEq);
      audioEngine.setTrackCompressor(trackId, disabledCompressor);
      audioEngine.setTrackSaturator(trackId, disabledSaturator);
      audioEngine.setTrackDelay(trackId, disabledDelay);
      audioEngine.setTrackReverb(trackId, disabledReverb);
      audioEngine.clearTrackSynth(trackId);
      audioEngine.clearTrackArpeggiator(trackId);
    }
  };

  const clearSyncedMasterState = (audioEngine: AudioEngine) => {
    audioEngine.setMasterEq(disabledEq);
    audioEngine.setMasterCompressor(disabledCompressor);
    audioEngine.setMasterSaturator(disabledSaturator);
    audioEngine.setMasterDelay(disabledDelay);
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

    const eqState = createSyncedAudioEffectState<EqParams>();
    const compressorState = createSyncedAudioEffectState<CompressorParams>();
    const saturatorState = createSyncedAudioEffectState<SaturatorParams>();
    const delayState = createSyncedAudioEffectState<DelayParams>();
    const reverbState = createSyncedAudioEffectState<ReverbParams>();
    const synthByTrackId = new Map<string, SynthParams>();
    const arpByTrackId = new Map<string, ArpeggiatorParams>();
    const effectOrders = collectSyncedAudioEffectOrders(effects);

    for (const row of effects) {
      if ("effect" in row) {
        if (syncLocalAudioEffect(row, eqSyncDescriptor, eqState, activeTargetId, audioEngine)) continue;
        if (syncLocalAudioEffect(row, compressorSyncDescriptor, compressorState, activeTargetId, audioEngine)) continue;
        if (syncLocalAudioEffect(row, saturatorSyncDescriptor, saturatorState, activeTargetId, audioEngine)) continue;
        if (syncLocalAudioEffect(row, delaySyncDescriptor, delayState, activeTargetId, audioEngine)) continue;
        if (syncLocalAudioEffect(row, reverbSyncDescriptor, reverbState, activeTargetId, audioEngine)) continue;
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
      if (syncRemoteAudioEffect(row, eqSyncDescriptor, eqState, activeTargetId, audioEngine)) continue;
      if (syncRemoteAudioEffect(row, compressorSyncDescriptor, compressorState, activeTargetId, audioEngine)) continue;
      if (syncRemoteAudioEffect(row, saturatorSyncDescriptor, saturatorState, activeTargetId, audioEngine)) continue;
      if (syncRemoteAudioEffect(row, delaySyncDescriptor, delayState, activeTargetId, audioEngine)) continue;
      if (syncRemoteAudioEffect(row, reverbSyncDescriptor, reverbState, activeTargetId, audioEngine)) continue;

      const trackId = row.trackId;
      if (!trackId || trackId === activeTargetId) continue;
      if (row.type === "synth" && row.params) synthByTrackId.set(trackId, normalizeSynthParams(row.params));
      if (row.type === "arpeggiator" && row.params) arpByTrackId.set(trackId, row.params);
    }

    applyMasterAudioDraft(eqSyncDescriptor, eqState, activeTargetId, audioEngine, options.localDraftEffects);
    applyMasterAudioDraft(compressorSyncDescriptor, compressorState, activeTargetId, audioEngine, options.localDraftEffects);
    applyMasterAudioDraft(saturatorSyncDescriptor, saturatorState, activeTargetId, audioEngine, options.localDraftEffects);
    applyMasterAudioDraft(delaySyncDescriptor, delayState, activeTargetId, audioEngine, options.localDraftEffects);
    applyMasterAudioDraft(reverbSyncDescriptor, reverbState, activeTargetId, audioEngine, options.localDraftEffects);

    if (activeTargetId !== "master") {
      audioEngine.setMasterFxOrder(effectOrders.master);
      if (!eqState.hasMaster) audioEngine.setMasterEq(disabledEq);
      if (!compressorState.hasMaster) audioEngine.setMasterCompressor(disabledCompressor);
      if (!saturatorState.hasMaster) audioEngine.setMasterSaturator(disabledSaturator);
      if (!delayState.hasMaster) audioEngine.setMasterDelay(disabledDelay);
      if (!reverbState.hasMaster) audioEngine.setMasterReverb(disabledReverb);
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
      audioEngine.setTrackFxOrder(track.id, effectOrders.tracks.get(track.id) ?? []);
      applyTrackAudioEffect(eqSyncDescriptor, eqState, track.id, audioEngine, options.localDraftEffects);
      applyTrackAudioEffect(compressorSyncDescriptor, compressorState, track.id, audioEngine, options.localDraftEffects);
      applyTrackAudioEffect(saturatorSyncDescriptor, saturatorState, track.id, audioEngine, options.localDraftEffects);
      applyTrackAudioEffect(delaySyncDescriptor, delayState, track.id, audioEngine, options.localDraftEffects);
      applyTrackAudioEffect(reverbSyncDescriptor, reverbState, track.id, audioEngine, options.localDraftEffects);
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
    if (!options.isOpen() || !options.isPlaying()) {
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
