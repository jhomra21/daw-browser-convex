export type MidiEditorNote = {
  beat: number
  length: number
  pitch: number
  velocity?: number
}

type MidiGridCell = {
  col: number
  row: number
}

export type MidiNoteDrag = {
  mode: 'move' | 'resize'
  note: MidiEditorNote
  startCell: MidiGridCell
  grabOffsetSteps: number
  pointerStep: number
}

const MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK_KEY_INDICES = new Set([1, 3, 6, 8, 10])

const MIDI_EDITOR_MIN_PITCH = 12
const MIDI_EDITOR_MAX_PITCH = 108
const MIDI_EDITOR_ROW_HEIGHT = 20
const DEFAULT_NOTE_VELOCITY = 0.9

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const pitchIndex = (pitch: number) => ((pitch % 12) + 12) % 12

const getMidiEditorRowCount = () => MIDI_EDITOR_MAX_PITCH - MIDI_EDITOR_MIN_PITCH + 1
const getMidiEditorTopPitch = () => MIDI_EDITOR_MAX_PITCH
const getMidiEditorContentHeight = () => getMidiEditorRowCount() * MIDI_EDITOR_ROW_HEIGHT

const getMidiEditorStepsPerBeat = (gridDenominator: number) => (
  Math.max(1, Math.round((gridDenominator || 4) / 4))
)

const getMidiEditorSecondsPerBeat = (bpm: number) => 60 / Math.max(1e-6, bpm || 120)

const getMidiEditorClipBeats = (
  clipDurationSec: number,
  secondsPerBeat: number,
  stepsPerBeat: number,
) => Math.max(1 / stepsPerBeat, (clipDurationSec || 1) / secondsPerBeat)

const getMidiEditorColumnCount = (clipBeats: number, stepsPerBeat: number) => (
  Math.max(stepsPerBeat, Math.ceil(clipBeats * stepsPerBeat))
)

const getMidiPitchForRow = (row: number) => (
  clamp(getMidiEditorTopPitch() - row, MIDI_EDITOR_MIN_PITCH, MIDI_EDITOR_MAX_PITCH)
)

const getMidiRowForPitch = (pitch: number) => getMidiEditorTopPitch() - pitch

const getMidiNoteName = (pitch: number) => {
  const octave = Math.floor(pitch / 12) - 1
  return `${MIDI_NOTE_NAMES[pitchIndex(pitch)]}${octave}`
}

const isBlackMidiKey = (pitch: number) => BLACK_KEY_INDICES.has(pitchIndex(pitch))

const createMidiEditorRowIndexes = () => (
  Array.from({ length: getMidiEditorRowCount() }, (_, index) => index)
)

const createMidiEditorGridCells = (columns: number, stepsPerBeat: number) => {
  const majorStep = stepsPerBeat * 4
  return Array.from({ length: getMidiEditorRowCount() * columns }, (_, index) => (
    index % columns % majorStep === 0
  ))
}

export const createMidiEditorGrid = (
  bpm: number,
  gridDenominator: number,
  clipDurationSec: number,
) => {
  const stepsPerBeat = getMidiEditorStepsPerBeat(gridDenominator)
  const secondsPerBeat = getMidiEditorSecondsPerBeat(bpm)
  const clipBeats = getMidiEditorClipBeats(clipDurationSec, secondsPerBeat, stepsPerBeat)
  const columns = getMidiEditorColumnCount(clipBeats, stepsPerBeat)

  return {
    rows: createMidiEditorRowIndexes(),
    cells: createMidiEditorGridCells(columns, stepsPerBeat),
    contentHeight: getMidiEditorContentHeight(),
    rowTemplate: `repeat(${getMidiEditorRowCount()}, ${MIDI_EDITOR_ROW_HEIGHT}px)`,
    columnTemplate: `repeat(${columns}, minmax(0, 1fr))`,
    cellFromPointer: (container: HTMLElement, event: PointerEvent) => (
      getMidiGridCellFromPointer(container, event, columns)
    ),
    pitchForRow: getMidiPitchForRow,
    noteName: getMidiNoteName,
    isBlackKey: isBlackMidiKey,
    noteLeftPercent: (note: MidiEditorNote) => getMidiNoteLeftPercent(note, clipBeats),
    noteWidthPercent: (note: MidiEditorNote) => getMidiNoteWidthPercent(note, clipBeats, stepsPerBeat),
    noteTop: (note: MidiEditorNote) => getMidiRowForPitch(note.pitch) * MIDI_EDITOR_ROW_HEIGHT,
    noteHeight: Math.max(2, MIDI_EDITOR_ROW_HEIGHT - 2),
    notesEqual: midiNotesEqual,
    noteFromCell: (cell: MidiGridCell): MidiEditorNote => ({
      beat: cell.col / stepsPerBeat,
      length: 1 / stepsPerBeat,
      pitch: getMidiPitchForRow(cell.row),
      velocity: DEFAULT_NOTE_VELOCITY,
    }),
    findNoteAtCell: (notes: MidiEditorNote[], cell: MidiGridCell) => {
      const beat = cell.col / stepsPerBeat
      return notes.findIndex(note => Math.abs(note.beat - beat) < 1e-6 && note.pitch === getMidiPitchForRow(cell.row))
    },
    noteDurationSeconds: (lengthBeats: number, maxSeconds: number) => Math.min(maxSeconds, lengthBeats * secondsPerBeat),
    pointerStep: (container: HTMLElement, event: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      return (event.clientX - rect.left) / Math.max(1e-6, rect.width / columns)
    },
    hasStartedNoteDrag: hasStartedMidiNoteDrag,
    createNoteDrag: (input: {
      note: MidiEditorNote
      mode: MidiNoteDrag['mode']
      cell: MidiGridCell
      pointerStep: number
    }): MidiNoteDrag => ({
      mode: input.mode,
      note: input.note,
      startCell: input.cell,
      pointerStep: input.pointerStep,
      grabOffsetSteps: input.pointerStep - input.note.beat * stepsPerBeat,
    }),
    noteFromDrag: (drag: MidiNoteDrag, cell: MidiGridCell, pointerStep: number) => {
      if (drag.mode === 'resize') {
        const startStep = Math.round(drag.note.beat * stepsPerBeat)
        return {
          ...drag.note,
          length: Math.max(1 / stepsPerBeat, (cell.col - startStep + 1) / stepsPerBeat),
        }
      }

      const step = clamp(Math.round(pointerStep - drag.grabOffsetSteps), 0, columns - 1)
      return {
        ...drag.note,
        beat: step / stepsPerBeat,
        pitch: getMidiPitchForRow(cell.row),
      }
    },
    replaceNote,
  }
}

const getMidiGridCellFromPointer = (
  container: HTMLElement,
  event: PointerEvent,
  columns: number,
): MidiGridCell => {
  const rect = container.getBoundingClientRect()
  const x = clamp(event.clientX - rect.left, 0, rect.width)
  const y = clamp(event.clientY - rect.top, 0, getMidiEditorContentHeight() - 1)
  const col = Math.floor((x / Math.max(1, rect.width)) * columns)
  const row = Math.floor(y / MIDI_EDITOR_ROW_HEIGHT)

  return {
    col: clamp(col, 0, columns - 1),
    row,
  }
}

const getMidiNoteLeftPercent = (note: MidiEditorNote, clipBeats: number) => (
  (note.beat / clipBeats) * 100
)

const getMidiNoteWidthPercent = (
  note: MidiEditorNote,
  clipBeats: number,
  stepsPerBeat: number,
) => Math.max(1 / (clipBeats * stepsPerBeat), note.length / clipBeats) * 100

const midiNotesEqual = (a: MidiEditorNote, b: MidiEditorNote) => (
  a.beat === b.beat
  && a.length === b.length
  && a.pitch === b.pitch
  && a.velocity === b.velocity
)

const hasStartedMidiNoteDrag = (
  pointerStep: number,
  startPointerStep: number,
  row: number,
  startRow: number,
) => Math.abs(pointerStep - startPointerStep) >= 0.25 || Math.abs(row - startRow) >= 0.5

const replaceNote = (
  notes: MidiEditorNote[],
  index: number,
  note: MidiEditorNote,
) => notes.map((current, currentIndex) => currentIndex === index ? note : current)
