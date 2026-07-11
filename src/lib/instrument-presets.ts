import {
  AUDIO_EFFECT_CONTRACTS,
  INSTRUMENT_CONTRACTS,
  normalizeTrackInstrumentParams,
  type ArpeggiatorParams,
  type DrumRackParamsInput,
  type SynthParamsInput,
  type TrackInstrumentParams,
} from "@daw-browser/shared";
import type { AudioEffectChainPresetStep } from "~/lib/audio-effect-chain-presets";

export type InstrumentPresetMidiEffect = {
  kind: "arpeggiator";
  params: ArpeggiatorParams;
};

export type InstrumentPreset = {
  id: string;
  name: string;
  folderId?: string;
  folderName?: string;
  instrument: TrackInstrumentParams;
  midiEffects?: readonly InstrumentPresetMidiEffect[];
  audioEffects?: readonly AudioEffectChainPresetStep[];
};

const synth = (params: SynthParamsInput): TrackInstrumentParams => (
  normalizeTrackInstrumentParams({ kind: "synth", params: INSTRUMENT_CONTRACTS.synth.normalizeParams(params) })
  ?? (() => { throw new Error("Invalid synth preset") })()
);

const drumRack = (params: DrumRackParamsInput): TrackInstrumentParams => (
  normalizeTrackInstrumentParams({ kind: "drum-rack", params: INSTRUMENT_CONTRACTS["drum-rack"].normalizeParams(params) })
  ?? (() => { throw new Error("Invalid drum rack preset") })()
);

const arpeggiator = (params: ArpeggiatorParams): InstrumentPresetMidiEffect => ({
  kind: "arpeggiator",
  params,
});

export const BUILTIN_INSTRUMENT_PRESETS: readonly InstrumentPreset[] = [
  {
    id: "bright-poly-synth",
    name: "Bright Poly Synth",
    folderId: "synths",
    folderName: "Synths",
    instrument: synth({ wave1: "sawtooth", wave2: "square", gain: 0.72, attackMs: 8, releaseMs: 95 }),
    audioEffects: [
      {
        kind: "delay",
        params: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams({
          syncDivision: "1/8",
          feedback: 0.24,
          dryWet: 0.18,
          pingPong: true,
          filterEnabled: true,
          lowCutHz: 180,
          highCutHz: 7200,
        }),
      },
      {
        kind: "reverb",
        params: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams({
          wet: 0.16,
          decaySec: 2.2,
          preDelayMs: 18,
          size: 0.62,
          diffusion: 0.76,
          density: 0.78,
          highCutHz: 8500,
        }),
      },
    ],
  },
  {
    id: "pluck-arp",
    name: "Pluck Arp",
    folderId: "synths",
    folderName: "Synths",
    instrument: synth({ wave1: "triangle", wave2: "sawtooth", gain: 0.66, attackMs: 0, releaseMs: 80 }),
    midiEffects: [
      arpeggiator({
        enabled: true,
        pattern: "updown",
        rate: "1/16",
        octaves: 2,
        gate: 0.62,
        hold: true,
      }),
    ],
    audioEffects: [
      {
        kind: "delay",
        params: AUDIO_EFFECT_CONTRACTS.delay.normalizeParams({
          syncDivision: "1/8",
          feedback: 0.34,
          dryWet: 0.26,
          pingPong: true,
          filterEnabled: true,
          lowCutHz: 220,
          highCutHz: 6800,
        }),
      },
      {
        kind: "reverb",
        params: AUDIO_EFFECT_CONTRACTS.reverb.normalizeParams({
          wet: 0.2,
          decaySec: 2.6,
          preDelayMs: 12,
          size: 0.7,
          diffusion: 0.8,
          density: 0.76,
          highCutHz: 7800,
        }),
      },
    ],
  },
  {
    id: "drum-rack-punch",
    name: "Drum Rack Punch",
    folderId: "drums",
    folderName: "Drums",
    instrument: drumRack({}),
    audioEffects: [
      {
        kind: "compressor",
        params: AUDIO_EFFECT_CONTRACTS.compressor.normalizeParams({
          thresholdDb: -18,
          ratio: 4,
          attackMs: 16,
          releaseMs: 90,
          kneeDb: 4,
          dryWet: 0.72,
          makeupDb: 1.5,
        }),
      },
      {
        kind: "saturator",
        params: AUDIO_EFFECT_CONTRACTS.saturator.normalizeParams({
          driveDb: 5,
          curve: "medium",
          dryWet: 0.38,
          outputDb: -1.5,
        }),
      },
    ],
  },
];
