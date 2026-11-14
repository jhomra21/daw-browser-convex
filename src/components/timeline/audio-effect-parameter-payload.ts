import {
  AUDIO_EFFECT_CONTRACTS,
  isJsonObject,
  normalizeCompressorParams,
  normalizeDelayParams,
  normalizeEqParams,
  normalizeGateParamsEnvelope,
  normalizeReverbParams,
  normalizeSaturatorParams,
  normalizeSpectralParamsEnvelope,
  normalizeUtilityParamsEnvelope,
  type AudioEffectKind,
  type JsonValue,
} from "@daw-browser/shared";
import type { NativeBuiltInParameterPayload } from "~/lib/desktop/native-built-in-parameter-mapper";

// The one builder of a typed parameter payload from a stored audio-effect value,
// shared by the panel's writes and the Timeline's effective-projection capture.
export const createAudioEffectParameterPayload = (
  interaction: { targetId: string; instanceId: string; kind: AudioEffectKind },
  from: JsonValue | undefined,
  to: JsonValue | undefined,
): NativeBuiltInParameterPayload => {
  const { targetId, instanceId } = interaction;
  const master = targetId === "master";
  const previous = isJsonObject(from) ? from : {};
  const next = isJsonObject(to) ? to : {};
  switch (interaction.kind) {
    case "utility": return master ? { targetId: "master", effect: "master-utility", instanceId, from: normalizeUtilityParamsEnvelope(previous), to: normalizeUtilityParamsEnvelope(next) } : { targetId, effect: "utility", instanceId, from: normalizeUtilityParamsEnvelope(previous), to: normalizeUtilityParamsEnvelope(next) };
    case "eq": return master ? { targetId: "master", effect: "master-eq", instanceId, from: normalizeEqParams(previous), to: normalizeEqParams(next) } : { targetId, effect: "eq", instanceId, from: normalizeEqParams(previous), to: normalizeEqParams(next) };
    case "autofilter": return master ? { targetId: "master", effect: "master-autofilter", instanceId, from: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(next) } : { targetId, effect: "autofilter", instanceId, from: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(next) };
    case "gate": return master ? { targetId: "master", effect: "master-gate", instanceId, from: normalizeGateParamsEnvelope(previous), to: normalizeGateParamsEnvelope(next) } : { targetId, effect: "gate", instanceId, from: normalizeGateParamsEnvelope(previous), to: normalizeGateParamsEnvelope(next) };
    case "limiter": return master ? { targetId: "master", effect: "master-limiter", instanceId, from: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(next) } : { targetId, effect: "limiter", instanceId, from: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(next) };
    case "lofi": return master ? { targetId: "master", effect: "master-lofi", instanceId, from: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(next) } : { targetId, effect: "lofi", instanceId, from: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(next) };
    case "compressor": return master ? { targetId: "master", effect: "master-compressor", instanceId, from: normalizeCompressorParams(previous), to: normalizeCompressorParams(next) } : { targetId, effect: "compressor", instanceId, from: normalizeCompressorParams(previous), to: normalizeCompressorParams(next) };
    case "saturator": return master ? { targetId: "master", effect: "master-saturator", instanceId, from: normalizeSaturatorParams(previous), to: normalizeSaturatorParams(next) } : { targetId, effect: "saturator", instanceId, from: normalizeSaturatorParams(previous), to: normalizeSaturatorParams(next) };
    case "delay": return master ? { targetId: "master", effect: "master-delay", instanceId, from: normalizeDelayParams(previous), to: normalizeDelayParams(next) } : { targetId, effect: "delay", instanceId, from: normalizeDelayParams(previous), to: normalizeDelayParams(next) };
    case "reverb": return master ? { targetId: "master", effect: "master-reverb", instanceId, from: normalizeReverbParams(previous), to: normalizeReverbParams(next) } : { targetId, effect: "reverb", instanceId, from: normalizeReverbParams(previous), to: normalizeReverbParams(next) };
    case "spectral": return master ? { targetId: "master", effect: "master-spectral", instanceId, from: normalizeSpectralParamsEnvelope(previous), to: normalizeSpectralParamsEnvelope(next) } : { targetId, effect: "spectral", instanceId, from: normalizeSpectralParamsEnvelope(previous), to: normalizeSpectralParamsEnvelope(next) };
    case "chorus": return master ? { targetId: "master", effect: "master-chorus", instanceId, from: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(next) } : { targetId, effect: "chorus", instanceId, from: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(next) };
    case "flanger": return master ? { targetId: "master", effect: "master-flanger", instanceId, from: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(next) } : { targetId, effect: "flanger", instanceId, from: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(next) };
    case "phaser": return master ? { targetId: "master", effect: "master-phaser", instanceId, from: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(next) } : { targetId, effect: "phaser", instanceId, from: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(next) };
    case "tremolo": return master ? { targetId: "master", effect: "master-tremolo", instanceId, from: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(next) } : { targetId, effect: "tremolo", instanceId, from: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(next) };
    case "autopan": return master ? { targetId: "master", effect: "master-autopan", instanceId, from: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(next) } : { targetId, effect: "autopan", instanceId, from: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(next) };
    case "ensemble": return master ? { targetId: "master", effect: "master-ensemble", instanceId, from: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(next) } : { targetId, effect: "ensemble", instanceId, from: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(previous), to: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(next) };
  }
};
