export const effectiveControlClipName = (name: string | undefined) => (
  name?.trim() || "Clip"
);

export const effectiveControlTimingOffset = (value: number | undefined) => (
  value ?? 0
);

export const effectiveControlMixerBoolean = (value: boolean | undefined) => (
  value ?? false
);

type ControlMidiNote = {
  beat: number;
  length: number;
  pitch: number;
  velocity?: number;
};

type ControlMidi = {
  wave: string;
  gain?: number;
  notes: ControlMidiNote[];
};

export const canonicalControlMidiNotes = (
  notes: ReadonlyArray<ControlMidiNote>,
) => notes
  .map((note, index) => ({ note, index }))
  .sort((left, right) => (
    left.note.beat - right.note.beat
    || left.note.pitch - right.note.pitch
    || left.note.length - right.note.length
    || (left.note.velocity ?? 0) - (right.note.velocity ?? 0)
    || left.index - right.index
  ))
  .map(({ note }) => note);

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
