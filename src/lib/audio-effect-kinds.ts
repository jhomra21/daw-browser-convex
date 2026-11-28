import {
  AUDIO_EFFECT_CONTRACTS,
  isJsonObject,
  type AudioEffectKind,
  type JsonObject,
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
  const normalized = <Params>(normalize: (input: JsonObject) => Params): [Params, Params] => [normalize(previous), normalize(next)];

  switch (kind) {
    case "utility": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.utility.normalizeParams);

      return {
        track: { effect: "utility", from: fromParams, to: toParams },
        master: { effect: "master-utility", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterUtilityParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setUtilityParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "eq": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.eq.normalizeParams);

      return {
        track: { effect: "eq", from: fromParams, to: toParams },
        master: { effect: "master-eq", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterEqParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setEqParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "gate": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.gate.normalizeParams);

      return {
        track: { effect: "gate", from: fromParams, to: toParams },
        master: { effect: "master-gate", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterGateParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setGateParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "limiter": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams);

      return {
        track: { effect: "limiter", from: fromParams, to: toParams },
        master: { effect: "master-limiter", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterLimiterParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setLimiterParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "compressor": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams);

      return {
        track: { effect: "compressor", from: fromParams, to: toParams },
        master: { effect: "master-compressor", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterCompressorParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setCompressorParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "saturator": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams);

      return {
        track: { effect: "saturator", from: fromParams, to: toParams },
        master: { effect: "master-saturator", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterSaturatorParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setSaturatorParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "delay": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.delay.normalizeParams);

      return {
        track: { effect: "delay", from: fromParams, to: toParams },
        master: { effect: "master-delay", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterDelayParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setDelayParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "reverb": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams);

      return {
        track: { effect: "reverb", from: fromParams, to: toParams },
        master: { effect: "master-reverb", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterReverbParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setReverbParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "spectral": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.spectral.normalizeParams);

      return {
        track: { effect: "spectral", from: fromParams, to: toParams },
        master: { effect: "master-spectral", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterSpectralParams", payload: { params: toParams, instanceId } }
          : { kind: "effects.setSpectralParams", payload: { trackId: targetId, params: toParams, instanceId } },
      };
    }

    case "autofilter": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams);

      return {
        track: { effect: "autofilter", from: fromParams, to: toParams },
        master: { effect: "master-autofilter", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "autofilter", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "autofilter", params: toParams, instanceId } },
      };
    }

    case "chorus": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams);

      return {
        track: { effect: "chorus", from: fromParams, to: toParams },
        master: { effect: "master-chorus", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "chorus", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "chorus", params: toParams, instanceId } },
      };
    }

    case "flanger": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams);

      return {
        track: { effect: "flanger", from: fromParams, to: toParams },
        master: { effect: "master-flanger", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "flanger", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "flanger", params: toParams, instanceId } },
      };
    }

    case "phaser": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams);

      return {
        track: { effect: "phaser", from: fromParams, to: toParams },
        master: { effect: "master-phaser", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "phaser", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "phaser", params: toParams, instanceId } },
      };
    }

    case "tremolo": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams);

      return {
        track: { effect: "tremolo", from: fromParams, to: toParams },
        master: { effect: "master-tremolo", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "tremolo", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "tremolo", params: toParams, instanceId } },
      };
    }

    case "autopan": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams);

      return {
        track: { effect: "autopan", from: fromParams, to: toParams },
        master: { effect: "master-autopan", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "autopan", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "autopan", params: toParams, instanceId } },
      };
    }

    case "ensemble": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams);

      return {
        track: { effect: "ensemble", from: fromParams, to: toParams },
        master: { effect: "master-ensemble", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "ensemble", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "ensemble", params: toParams, instanceId } },
      };
    }

    case "spectrum": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.spectrum.normalizeParams);

      return {
        track: { effect: "spectrum", from: fromParams, to: toParams },
        master: { effect: "master-spectrum", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "spectrum", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "spectrum", params: toParams, instanceId } },
      };
    }

    case "lofi": {
      const [fromParams, toParams] = normalized(AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams);

      return {
        track: { effect: "lofi", from: fromParams, to: toParams },
        master: { effect: "master-lofi", from: fromParams, to: toParams },
        persist: (targetId, instanceId) => targetId === "master"
          ? { kind: "effects.setMasterModulationParams", payload: { effect: "lofi", params: toParams, instanceId } }
          : { kind: "effects.setModulationParams", payload: { trackId: targetId, effect: "lofi", params: toParams, instanceId } },
      };
    }
  }
};
