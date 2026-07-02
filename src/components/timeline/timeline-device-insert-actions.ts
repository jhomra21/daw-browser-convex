import type { AudioEffectKind, InstrumentKind } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";

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
  addAudioEffectToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => Promise<boolean>;
  canAddAudioEffectToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind) => boolean;
  addEq: () => void;
  addCompressor: () => void;
  addSaturator: () => void;
  addDelay: () => void;
  addReverb: () => void;
  openSynthForTarget: (targetId: Track["id"]) => void;
  switchInstrumentForTarget: (targetId: Track["id"], kind: InstrumentKind) => boolean;
  canWrite: boolean;
  canAddMidiClip: boolean;
  canAddArpeggiator: boolean;
  canAddEq: boolean;
  canAddCompressor: boolean;
  canAddSaturator: boolean;
  canAddDelay: boolean;
  canAddReverb: boolean;
};
