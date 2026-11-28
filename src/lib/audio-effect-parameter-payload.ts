import type { AudioEffectKind, JsonValue } from "@daw-browser/shared";
import { audioEffectForms } from "./audio-effect-kinds";
import type { EffectChange, NativeBuiltInParameterPayload } from "./processor-edit-semantics";

// The change alone, for callers that ask what an edit moves and not where it happens.
export const createAudioEffectChange = (
  kind: AudioEffectKind,
  from: JsonValue | undefined,
  to: JsonValue | undefined,
): EffectChange<AudioEffectKind> => audioEffectForms(kind, from, to).track;

export const createAudioEffectParameterPayload = (
  interaction: { targetId: string; instanceId: string; kind: AudioEffectKind },
  from: JsonValue | undefined,
  to: JsonValue | undefined,
): NativeBuiltInParameterPayload => {
  const { targetId, instanceId } = interaction;
  const forms = audioEffectForms(interaction.kind, from, to);

  return targetId === "master"
    ? { targetId: "master", instanceId, ...forms.master }
    : { targetId, instanceId, ...forms.track };
};
