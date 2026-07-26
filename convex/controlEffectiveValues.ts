import { midiClipEquals, normalizeLegacyMidiClip, type MidiClip } from "@daw-browser/shared";

export { normalizeMidiClip } from "@daw-browser/shared";

export const effectiveControlClipName = (name: string | undefined) => (
  name?.trim() || "Clip"
);

export const effectiveControlTimingOffset = (value: number | undefined) => (
  value ?? 0
);

export const effectiveControlMixerBoolean = (value: boolean | undefined) => (
  value ?? false
);

type ControlMidi = MidiClip;

export const controlMidiEqual = (
  left: ControlMidi | { wave: string } | undefined,
  right: ControlMidi,
) => left === undefined ? false : midiClipEquals(normalizeLegacyMidiClip(left), right);
