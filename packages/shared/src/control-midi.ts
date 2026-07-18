export type ControlMidiNote = {
  beat: number
  length: number
  pitch: number
  velocity?: number
}

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
  .map(({ note }) => note)
