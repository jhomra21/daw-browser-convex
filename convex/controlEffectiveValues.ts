import { canonicalControlMidiNotes } from "@daw-browser/shared";

export { canonicalControlMidiNotes } from "@daw-browser/shared";

export const effectiveControlClipName = (name: string | undefined) => (
  name?.trim() || "Clip"
);

export const effectiveControlTimingOffset = (value: number | undefined) => (
  value ?? 0
);

export const effectiveControlMixerBoolean = (value: boolean | undefined) => (
  value ?? false
);

type ControlMidi = {
  wave: string;
  gain?: number;
  notes: Array<{
    beat: number;
    length: number;
    pitch: number;
    velocity?: number;
  }>;
};

export const controlMidiEqual = (
  left: ControlMidi | undefined,
  right: ControlMidi,
) => {
  if (!left || left.wave !== right.wave || left.gain !== right.gain) return false;
  const leftNotes = canonicalControlMidiNotes(left.notes);
  const rightNotes = canonicalControlMidiNotes(right.notes);
  return leftNotes.length === rightNotes.length
    && leftNotes.every((note, index) => (
      note.beat === rightNotes[index]?.beat
      && note.length === rightNotes[index]?.length
      && note.pitch === rightNotes[index]?.pitch
      && note.velocity === rightNotes[index]?.velocity
    ));
};
