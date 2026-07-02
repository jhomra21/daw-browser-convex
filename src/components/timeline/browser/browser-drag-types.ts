import type { AudioEffectKind } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";
import type { AudioEffectChainPreset } from "~/lib/audio-effect-chain-presets";

export type BrowserDragPayload =
  | { kind: "audio-effect"; effect: AudioEffectKind; label: string }
  | { kind: "audio-effect-chain"; chain: AudioEffectChainPreset; label: string }
  | { kind: "midi-effect"; effect: "arpeggiator"; label: string }
  | { kind: "midi-instrument"; instrument: "synth" | "drum-rack"; label: string };

export type BrowserDropTarget =
  | { kind: "track"; trackId: Track["id"]; laneIndex: number }
  | { kind: "new-track" }
  | { kind: "effect-chain"; targetId: Track["id"] | "master"; index: number }
  | { kind: "none" };

export type BrowserDragSession = {
  payload: BrowserDragPayload;
  pointer: { x: number; y: number };
  target: BrowserDropTarget;
  effectChainPreview?: { x: number; top: number; height: number };
  ghostOffset: { x: number; y: number };
  ghostSize: { width: number; height: number };
};
