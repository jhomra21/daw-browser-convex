import {
  AUDIO_EFFECT_CONTRACTS,
  AUDIO_EFFECT_ORDER,
  INSTRUMENT_CONTRACTS,
  isInstrumentKind,
  isOwnedProcessorKind,
  OWNED_PROCESSOR_DESCRIPTORS,
  type AudioEffectContract,
  type AudioEffectKind,
  type InstrumentContract,
  type InstrumentKind,
} from "@daw-browser/shared";

type DeviceCatalogGroup = "audio-effects" | "midi-effects" | "instruments";

type DeviceCatalogCapabilities = {
  addable: boolean;
  browser: boolean;
  contextMenu: boolean;
  drag: boolean;
};

type DeviceCatalogBase = {
  id: string;
  label: string;
  group: DeviceCatalogGroup;
  description?: string;
  capabilities: DeviceCatalogCapabilities;
};

type AudioEffectDeviceCatalogEntry = DeviceCatalogBase & {
  category: "audio-effect";
  kind: AudioEffectKind;
  contract: AudioEffectContract;
  descriptor?: (typeof OWNED_PROCESSOR_DESCRIPTORS)[keyof typeof OWNED_PROCESSOR_DESCRIPTORS];
  payload: {
    kind: "audio-effect";
    effect: AudioEffectKind;
    label: string;
  };
};

type MidiEffectDeviceCatalogEntry = DeviceCatalogBase & {
  category: "midi-effect";
  kind: "arpeggiator";
  payload: {
    kind: "midi-effect";
    effect: "arpeggiator";
    label: string;
  };
};

type InstrumentDeviceCatalogEntry = DeviceCatalogBase & {
  category: "midi-instrument";
  kind: InstrumentKind;
  contract: InstrumentContract;
  payload: {
    kind: "midi-instrument";
    instrument: InstrumentKind;
    label: string;
  };
};

type DeviceCatalogEntry =
  | AudioEffectDeviceCatalogEntry
  | MidiEffectDeviceCatalogEntry
  | InstrumentDeviceCatalogEntry;

type AudioEffectMetadata = {
  label: string;
  description: string;
};

const AUDIO_EFFECT_METADATA = {
  utility: { label: "Utility", description: "Gain, pan, width, and utility routing" },
  eq: { label: "EQ", description: "Eight-band parametric equalizer" },
  autofilter: { label: "Auto Filter", description: "Envelope and LFO filter modulation" },
  gate: { label: "Gate", description: "Gate and expander dynamics processor" },
  compressor: { label: "Compressor", description: "Dynamics compression and expansion" },
  saturator: { label: "Saturator", description: "Drive and waveshaping" },
  limiter: { label: "Limiter", description: "True-peak output limiting" },
  lofi: { label: "LoFi", description: "Bit depth and sample-rate reduction" },
  chorus: { label: "Chorus", description: "Stereo chorus modulation" },
  flanger: { label: "Flanger", description: "Feedback flanger modulation" },
  phaser: { label: "Phaser", description: "Multi-stage phase modulation" },
  tremolo: { label: "Tremolo", description: "Amplitude modulation" },
  autopan: { label: "Auto Pan", description: "Stereo amplitude panning" },
  ensemble: { label: "Ensemble", description: "Multi-voice stereo modulation" },
  delay: { label: "Delay", description: "Synchronized or free-time echo" },
  reverb: { label: "Reverb", description: "Algorithmic room and space reverb" },
  spectral: { label: "Spectral", description: "FFT spectral processing and freeze" },
} satisfies Record<AudioEffectKind, AudioEffectMetadata>;

const INSTRUMENT_METADATA = {
  synth: { label: "Synth", description: "Polyphonic subtractive synthesizer" },
  "drum-rack": { label: "Drum Rack", description: "MIDI drum rack with sample pads" },
  sampler: { label: "Sampler", description: "Key-zone sample instrument" },
  granular: { label: "Granular", description: "Granular sample instrument" },
} satisfies Record<InstrumentKind, AudioEffectMetadata>;

const catalogCapabilities = (): DeviceCatalogCapabilities => ({
  addable: true,
  browser: true,
  contextMenu: true,
  drag: true,
});

const createAudioEffectEntry = (kind: AudioEffectKind): AudioEffectDeviceCatalogEntry => {
  const metadata = AUDIO_EFFECT_METADATA[kind];
  return {
    id: `builtin:audio-effect:${kind}`,
    category: "audio-effect",
    kind,
    label: metadata.label,
    group: "audio-effects",
    description: metadata.description,
    capabilities: catalogCapabilities(),
    contract: AUDIO_EFFECT_CONTRACTS[kind],
    descriptor: isOwnedProcessorKind(kind) ? OWNED_PROCESSOR_DESCRIPTORS[kind] : undefined,
    payload: {
      kind: "audio-effect",
      effect: kind,
      label: metadata.label,
    },
  };
};

const createMidiEffectEntry = (): MidiEffectDeviceCatalogEntry => ({
  id: "builtin:midi-effect:arpeggiator",
  category: "midi-effect",
  kind: "arpeggiator",
  label: "Arpeggiator",
  group: "midi-effects",
  description: "MIDI note pattern generator",
  capabilities: catalogCapabilities(),
  payload: {
    kind: "midi-effect",
    effect: "arpeggiator",
    label: "Arpeggiator",
  },
});

const createInstrumentEntry = (kind: InstrumentKind): InstrumentDeviceCatalogEntry => {
  const metadata = INSTRUMENT_METADATA[kind];
  return {
    id: `builtin:midi-instrument:${kind}`,
    category: "midi-instrument",
    kind,
    label: metadata.label,
    group: "instruments",
    description: metadata.description,
    capabilities: catalogCapabilities(),
    contract: INSTRUMENT_CONTRACTS[kind],
    payload: {
      kind: "midi-instrument",
      instrument: kind,
      label: metadata.label,
    },
  };
};

export const AUDIO_EFFECT_DEVICE_CATALOG: readonly AudioEffectDeviceCatalogEntry[] =
  AUDIO_EFFECT_ORDER.map(createAudioEffectEntry);

const MIDI_EFFECT_DEVICE_CATALOG: readonly MidiEffectDeviceCatalogEntry[] = [
  createMidiEffectEntry(),
];

export const INSTRUMENT_DEVICE_CATALOG: readonly InstrumentDeviceCatalogEntry[] =
  Object.keys(INSTRUMENT_CONTRACTS)
    .filter(isInstrumentKind)
    .map(createInstrumentEntry);

export const DEVICE_CATALOG: readonly DeviceCatalogEntry[] = [
  ...AUDIO_EFFECT_DEVICE_CATALOG,
  ...MIDI_EFFECT_DEVICE_CATALOG,
  ...INSTRUMENT_DEVICE_CATALOG,
];

const addableForSurface = (
  surface: "browser" | "contextMenu",
): readonly DeviceCatalogEntry[] => DEVICE_CATALOG.filter((entry) => (
  entry.capabilities.addable && entry.capabilities[surface]
));

export const BROWSER_DEVICE_CATALOG = addableForSurface("browser");
export const CONTEXT_MENU_DEVICE_CATALOG = addableForSurface("contextMenu");
export const BROWSER_AUDIO_EFFECT_CATALOG = BROWSER_DEVICE_CATALOG.filter((entry): entry is AudioEffectDeviceCatalogEntry => entry.category === "audio-effect");
export const BROWSER_MIDI_EFFECT_CATALOG = BROWSER_DEVICE_CATALOG.filter((entry): entry is MidiEffectDeviceCatalogEntry => entry.category === "midi-effect");
export const BROWSER_INSTRUMENT_CATALOG = BROWSER_DEVICE_CATALOG.filter((entry): entry is InstrumentDeviceCatalogEntry => entry.category === "midi-instrument");
export const CONTEXT_MENU_AUDIO_EFFECT_CATALOG = CONTEXT_MENU_DEVICE_CATALOG.filter((entry): entry is AudioEffectDeviceCatalogEntry => entry.category === "audio-effect");
export const CONTEXT_MENU_MIDI_EFFECT_CATALOG = CONTEXT_MENU_DEVICE_CATALOG.filter((entry): entry is MidiEffectDeviceCatalogEntry => entry.category === "midi-effect");
export const CONTEXT_MENU_INSTRUMENT_CATALOG = CONTEXT_MENU_DEVICE_CATALOG.filter((entry): entry is InstrumentDeviceCatalogEntry => entry.category === "midi-instrument");

const audioEffectByKind = new Map(AUDIO_EFFECT_DEVICE_CATALOG.map((entry) => [entry.kind, entry]));

export const getAudioEffectDeviceCatalogEntry = (kind: AudioEffectKind): AudioEffectDeviceCatalogEntry => {
  const entry = audioEffectByKind.get(kind);
  if (!entry) throw new Error(`Missing device catalog entry for audio effect "${kind}".`);
  return entry;
};

export const deviceCatalogSearchText = (entry: DeviceCatalogEntry): string => (
  `${entry.label} ${entry.kind} ${entry.group} ${entry.description ?? ""}`.toLowerCase()
);
