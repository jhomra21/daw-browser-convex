import {
  AUDIO_EFFECT_CONTRACTS,
  isJsonObject,
  type AudioEffectKind,
  type JsonValue,
} from "@daw-browser/shared";
import type { EffectChange, NativeBuiltInParameterPayload } from "./processor-edit-semantics";

type EffectForms = {
  track: EffectChange<AudioEffectKind>;
  master: EffectChange<`master-${AudioEffectKind}`>;
};

const effectForms = (kind: AudioEffectKind, from: JsonValue | undefined, to: JsonValue | undefined): EffectForms => {
  const previous = isJsonObject(from) ? from : {};
  const next = isJsonObject(to) ? to : {};
  switch (kind) {
    case "utility": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.utility;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "utility", from: fromParams, to: toParams }, master: { effect: "master-utility", from: fromParams, to: toParams } };
    }
    case "eq": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.eq;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "eq", from: fromParams, to: toParams }, master: { effect: "master-eq", from: fromParams, to: toParams } };
    }
    case "autofilter": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.autofilter;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "autofilter", from: fromParams, to: toParams }, master: { effect: "master-autofilter", from: fromParams, to: toParams } };
    }
    case "gate": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.gate;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "gate", from: fromParams, to: toParams }, master: { effect: "master-gate", from: fromParams, to: toParams } };
    }
    case "limiter": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.limiter;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "limiter", from: fromParams, to: toParams }, master: { effect: "master-limiter", from: fromParams, to: toParams } };
    }
    case "lofi": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.lofi;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "lofi", from: fromParams, to: toParams }, master: { effect: "master-lofi", from: fromParams, to: toParams } };
    }
    case "compressor": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.compressor;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "compressor", from: fromParams, to: toParams }, master: { effect: "master-compressor", from: fromParams, to: toParams } };
    }
    case "saturator": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.saturator;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "saturator", from: fromParams, to: toParams }, master: { effect: "master-saturator", from: fromParams, to: toParams } };
    }
    case "delay": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.delay;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "delay", from: fromParams, to: toParams }, master: { effect: "master-delay", from: fromParams, to: toParams } };
    }
    case "reverb": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.reverb;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "reverb", from: fromParams, to: toParams }, master: { effect: "master-reverb", from: fromParams, to: toParams } };
    }
    case "spectral": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.spectral;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "spectral", from: fromParams, to: toParams }, master: { effect: "master-spectral", from: fromParams, to: toParams } };
    }
    case "chorus": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.chorus;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "chorus", from: fromParams, to: toParams }, master: { effect: "master-chorus", from: fromParams, to: toParams } };
    }
    case "flanger": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.flanger;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "flanger", from: fromParams, to: toParams }, master: { effect: "master-flanger", from: fromParams, to: toParams } };
    }
    case "phaser": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.phaser;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "phaser", from: fromParams, to: toParams }, master: { effect: "master-phaser", from: fromParams, to: toParams } };
    }
    case "tremolo": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.tremolo;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "tremolo", from: fromParams, to: toParams }, master: { effect: "master-tremolo", from: fromParams, to: toParams } };
    }
    case "autopan": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.autopan;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "autopan", from: fromParams, to: toParams }, master: { effect: "master-autopan", from: fromParams, to: toParams } };
    }
    case "ensemble": {
      const { normalizeParams } = AUDIO_EFFECT_CONTRACTS.ensemble;
      const [fromParams, toParams] = [normalizeParams(previous), normalizeParams(next)];
      return { track: { effect: "ensemble", from: fromParams, to: toParams }, master: { effect: "master-ensemble", from: fromParams, to: toParams } };
    }
  }
};

// The change alone, for callers that ask what an edit moves and not where it happens.
export const createAudioEffectChange = (
  kind: AudioEffectKind,
  from: JsonValue | undefined,
  to: JsonValue | undefined,
): EffectChange<AudioEffectKind> => effectForms(kind, from, to).track;

export const createAudioEffectParameterPayload = (
  interaction: { targetId: string; instanceId: string; kind: AudioEffectKind },
  from: JsonValue | undefined,
  to: JsonValue | undefined,
): NativeBuiltInParameterPayload => {
  const { targetId, instanceId } = interaction;
  const forms = effectForms(interaction.kind, from, to);
  return targetId === "master"
    ? { targetId: "master", instanceId, ...forms.master }
    : { targetId, instanceId, ...forms.track };
};
