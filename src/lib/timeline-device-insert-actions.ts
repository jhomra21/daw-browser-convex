import type { ArpeggiatorParams, AudioEffectKind, InstrumentKind, TrackInstrumentParams } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import type { AudioEffectChainPreset } from "~/lib/audio-effect-chain-presets";

export type AddMidiClipOptions = {
  durationSec?: number;
  startSec?: number;
};

export type TimelineDeviceInsertActions = {
  addMidiClip: () => Promise<void>;
  addMidiClipToTarget: (targetId: Track["id"], options?: AddMidiClipOptions) => Promise<boolean>;
  canAddMidiClipToTarget: (targetId: Track["id"]) => boolean;
  addArpeggiator: () => void;
  addArpeggiatorToTarget: (targetId: Track["id"]) => Promise<boolean>;
  canAddArpeggiatorToTarget: (targetId: Track["id"]) => boolean;
  setArpeggiatorForTarget: (targetId: Track["id"], params: ArpeggiatorParams) => boolean;
  addAudioEffectToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => Promise<boolean>;
  canAddAudioEffectToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind) => boolean;
  addAudioEffectChainToTarget: (targetId: Track["id"] | "master", chain: AudioEffectChainPreset, index?: number) => Promise<boolean>;
  canAddAudioEffectChainToTarget: (targetId: Track["id"] | "master", chain: AudioEffectChainPreset) => boolean;
  addEq: () => void;
  addCompressor: () => void;
  addSaturator: () => void;
  addDelay: () => void;
  addReverb: () => void;
  switchInstrumentForTarget: (targetId: Track["id"], kind: InstrumentKind) => boolean;
  setInstrumentForTarget: (targetId: Track["id"], instrument: TrackInstrumentParams) => boolean;
  canSetInstrumentForTarget: (targetId: Track["id"]) => boolean;
  canWrite: boolean;
  canAddMidiClip: boolean;
  canAddArpeggiator: boolean;
  canAddEq: boolean;
  canAddCompressor: boolean;
  canAddSaturator: boolean;
  canAddDelay: boolean;
  canAddReverb: boolean;
};
