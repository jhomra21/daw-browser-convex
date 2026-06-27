import type { AudioEffectKind } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";

export type TimelineDeviceInsertActions = {
  addMidiClip: () => Promise<void>;
  addMidiClipToTarget: (targetId: Track["id"]) => Promise<void>;
  addArpeggiator: () => void;
  addArpeggiatorToTarget: (targetId: Track["id"]) => void;
  addAudioEffectToTarget: (targetId: Track["id"] | "master", effect: AudioEffectKind, index?: number) => void;
  addEq: () => void;
  addSaturator: () => void;
  addDelay: () => void;
  addReverb: () => void;
  openSynthForTarget: (targetId: Track["id"]) => void;
  canWrite: boolean;
  canAddMidiClip: boolean;
  canAddArpeggiator: boolean;
  canAddEq: boolean;
  canAddSaturator: boolean;
  canAddDelay: boolean;
  canAddReverb: boolean;
};
