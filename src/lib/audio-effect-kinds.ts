import {
  buildEffectParamsOperation,
  isJsonObject,
  normalizeAudioEffectChange,
  normalizeAudioEffectRow,
  normalizeMasterAudioEffectChange,
  type AudioEffectKind,
  type JsonValue,
  type SharedTimelineOperation,
} from "@daw-browser/shared";
import type { EffectChange } from "./processor-edit-semantics";

// Everything that differs between effect kinds and between a master and a track instance, listed once: the
// normalized params, the history effect each form is recorded under, and the operation that persists them.
type AudioEffectForms = {
  track: EffectChange<AudioEffectKind>;
  master: EffectChange<`master-${AudioEffectKind}`>;
  persist: (targetId: string, instanceId: string) => SharedTimelineOperation;
};

export const audioEffectForms = (kind: AudioEffectKind, from: JsonValue | undefined, to: JsonValue | undefined): AudioEffectForms => {
  const previous = isJsonObject(from) ? from : {};
  const next = isJsonObject(to) ? to : {};
  const row = normalizeAudioEffectRow(kind, next);

  return {
    track: normalizeAudioEffectChange(kind, previous, next),
    master: normalizeMasterAudioEffectChange(kind, previous, next),
    persist: (targetId, instanceId) => buildEffectParamsOperation(row, instanceId, targetId === "master" ? undefined : targetId),
  };
};
