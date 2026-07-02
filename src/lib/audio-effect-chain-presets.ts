import {
  AUDIO_EFFECT_CONTRACTS,
  type CompressorParams,
  type CompressorParamsInput,
  type DelayParams,
  type DelayParamsInput,
  type EqParams,
  type EqParamsInput,
  type ReverbParams,
  type ReverbParamsInput,
  type SaturatorParams,
  type SaturatorParamsInput,
} from "@daw-browser/shared";

export type AudioEffectChainPresetStep =
  | { kind: "eq"; params: EqParams }
  | { kind: "compressor"; params: CompressorParams }
  | { kind: "saturator"; params: SaturatorParams }
  | { kind: "delay"; params: DelayParams }
  | { kind: "reverb"; params: ReverbParams };

export type AudioEffectChainPreset = {
  id: string;
  name: string;
  folderId?: string;
  folderName?: string;
  effects: readonly AudioEffectChainPresetStep[];
};

const eq = (params: EqParamsInput): AudioEffectChainPresetStep => ({
  kind: "eq",
  params: AUDIO_EFFECT_CONTRACTS.eq.normalizeParams(params),
});

const compressor = (params: CompressorParamsInput): AudioEffectChainPresetStep => ({
  kind: "compressor",
  params: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams(params),
});

const saturator = (params: SaturatorParamsInput): AudioEffectChainPresetStep => ({
  kind: "saturator",
  params: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams(params),
});

const delay = (params: DelayParamsInput): AudioEffectChainPresetStep => ({
  kind: "delay",
  params: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams(params),
});

const reverb = (params: ReverbParamsInput): AudioEffectChainPresetStep => ({
  kind: "reverb",
  params: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams(params),
});

export const BUILTIN_AUDIO_EFFECT_CHAIN_PRESETS: readonly AudioEffectChainPreset[] = [
  {
    id: "vocal-chain",
    name: "Vocal Chain",
    folderId: "mixing",
    folderName: "Mixing",
    effects: [
      eq({
        bands: [
          { id: "b1", type: "highpass", frequency: 90, q: 0.8, gainDb: 0, enabled: true },
          { id: "b2", type: "peaking", frequency: 250, q: 1.2, gainDb: -2.5, enabled: true },
          { id: "b3", type: "peaking", frequency: 3500, q: 1, gainDb: 2, enabled: true },
          { id: "b4", type: "highshelf", frequency: 9000, q: 0.7, gainDb: 3, enabled: true },
        ],
      }),
      compressor({ thresholdDb: -22, ratio: 3, attackMs: 8, releaseMs: 110, kneeDb: 8, makeupDb: 2 }),
      saturator({ driveDb: 4, curve: "soft", dryWet: 0.35, outputDb: -1 }),
      eq({
        bands: [
          { id: "b1", type: "highpass", frequency: 80, q: 0.7, gainDb: 0, enabled: true },
          { id: "b2", type: "peaking", frequency: 5200, q: 1.1, gainDb: 1.5, enabled: true },
          { id: "b3", type: "highshelf", frequency: 12000, q: 0.7, gainDb: 1.5, enabled: true },
        ],
      }),
    ],
  },
  {
    id: "drum-bus-punch",
    name: "Drum Bus Punch",
    folderId: "mixing",
    folderName: "Mixing",
    effects: [
      compressor({ thresholdDb: -18, ratio: 4, attackMs: 18, releaseMs: 90, kneeDb: 4, dryWet: 0.75, makeupDb: 1.5 }),
      saturator({ driveDb: 7, curve: "medium", dryWet: 0.45, outputDb: -2 }),
      eq({
        bands: [
          { id: "b1", type: "lowshelf", frequency: 70, q: 0.8, gainDb: 1.5, enabled: true },
          { id: "b2", type: "peaking", frequency: 350, q: 1, gainDb: -2, enabled: true },
          { id: "b3", type: "highshelf", frequency: 8500, q: 0.7, gainDb: 2, enabled: true },
        ],
      }),
    ],
  },
  {
    id: "space-delay",
    name: "Space Delay",
    folderId: "space",
    folderName: "Space",
    effects: [
      delay({ syncDivision: "1/8", feedback: 0.38, dryWet: 0.28, pingPong: true, filterEnabled: true, lowCutHz: 180, highCutHz: 6500 }),
      reverb({ wet: 0.22, decaySec: 2.8, preDelayMs: 24, size: 0.72, diffusion: 0.78, density: 0.82, highCutHz: 9000 }),
    ],
  },
];
