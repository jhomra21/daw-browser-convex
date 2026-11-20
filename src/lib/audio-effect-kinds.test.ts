import { describe, expect, test } from "bun:test";
import { AUDIO_EFFECT_CONTRACTS, AUDIO_EFFECT_KINDS, type AudioEffectKind } from "@daw-browser/shared";
import { audioEffectForms } from "./audio-effect-kinds";

// The operation that persists each kind, written out per kind so a registry change cannot move it silently.
const trackOperationByKind = {
  utility: "effects.setUtilityParams",
  eq: "effects.setEqParams",
  autofilter: "effects.setModulationParams",
  gate: "effects.setGateParams",
  compressor: "effects.setCompressorParams",
  saturator: "effects.setSaturatorParams",
  limiter: "effects.setLimiterParams",
  lofi: "effects.setModulationParams",
  chorus: "effects.setModulationParams",
  flanger: "effects.setModulationParams",
  phaser: "effects.setModulationParams",
  tremolo: "effects.setModulationParams",
  autopan: "effects.setModulationParams",
  ensemble: "effects.setModulationParams",
  delay: "effects.setDelayParams",
  reverb: "effects.setReverbParams",
  spectral: "effects.setSpectralParams",
  spectrum: "effects.setModulationParams",
} as const satisfies Record<AudioEffectKind, string>;

const masterOperationByKind = {
  utility: "effects.setMasterUtilityParams",
  eq: "effects.setMasterEqParams",
  autofilter: "effects.setMasterModulationParams",
  gate: "effects.setMasterGateParams",
  compressor: "effects.setMasterCompressorParams",
  saturator: "effects.setMasterSaturatorParams",
  limiter: "effects.setMasterLimiterParams",
  lofi: "effects.setMasterModulationParams",
  chorus: "effects.setMasterModulationParams",
  flanger: "effects.setMasterModulationParams",
  phaser: "effects.setMasterModulationParams",
  tremolo: "effects.setMasterModulationParams",
  autopan: "effects.setMasterModulationParams",
  ensemble: "effects.setMasterModulationParams",
  delay: "effects.setMasterDelayParams",
  reverb: "effects.setMasterReverbParams",
  spectral: "effects.setMasterSpectralParams",
  spectrum: "effects.setMasterModulationParams",
} as const satisfies Record<AudioEffectKind, string>;

const carriesKindInPayload = (kind: AudioEffectKind) => trackOperationByKind[kind] === "effects.setModulationParams";

describe("audioEffectForms", () => {
  for (const kind of AUDIO_EFFECT_KINDS) test(`${kind} forms the history change and its persistence operation`, () => {
    const contract = AUDIO_EFFECT_CONTRACTS[kind];
    const forms = audioEffectForms(kind, undefined, {});
    const params = contract.normalizeParams({});

    expect<unknown>(forms.track).toEqual({ effect: kind, from: params, to: params });
    expect<unknown>(forms.master).toEqual({ effect: `master-${kind}`, from: params, to: params });

    expect<unknown>(forms.persist("track-1", "instance-1")).toEqual({
      kind: trackOperationByKind[kind],
      payload: carriesKindInPayload(kind)
        ? { trackId: "track-1", effect: kind, params, instanceId: "instance-1" }
        : { trackId: "track-1", params, instanceId: "instance-1" },
    });
    expect<unknown>(forms.persist("master", "instance-2")).toEqual({
      kind: masterOperationByKind[kind],
      payload: carriesKindInPayload(kind)
        ? { effect: kind, params, instanceId: "instance-2" }
        : { params, instanceId: "instance-2" },
    });
  });
});
