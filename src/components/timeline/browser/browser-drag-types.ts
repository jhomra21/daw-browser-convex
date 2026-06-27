import type { AudioEffectKind } from "@daw-browser/shared";
import type { Track } from "@daw-browser/timeline-core/types";

export type BrowserDragPayload =
  | { kind: "audio-effect"; effect: AudioEffectKind; label: string }
  | { kind: "midi-effect"; effect: "arpeggiator"; label: string }
  | { kind: "midi-instrument"; instrument: "synth"; label: string };

export type BrowserDropTarget =
  | { kind: "track"; trackId: Track["id"] }
  | { kind: "new-track" }
  | { kind: "effect-chain"; targetId: Track["id"] | "master"; index: number }
  | { kind: "none" };

export type BrowserDragSession = {
  payload: BrowserDragPayload;
  pointer: { x: number; y: number };
  target: BrowserDropTarget;
  ghostOffset: { x: number; y: number };
  ghostSize: { width: number; height: number };
};
