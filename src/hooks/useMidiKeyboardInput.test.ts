import { describe, expect, test } from 'bun:test'

import {
  clampMidiKeyboardOctave,
  clampMidiKeyboardVelocity,
  midiKeyboardCodeToSemitone,
} from './useMidiKeyboardInput'

describe('midi keyboard input helpers', () => {
  test('maps computer keyboard rows to MIDI semitones', () => {
    expect(midiKeyboardCodeToSemitone('KeyA')).toBe(0)
    expect(midiKeyboardCodeToSemitone('KeyW')).toBe(1)
    expect(midiKeyboardCodeToSemitone('KeyK')).toBe(12)
    expect(midiKeyboardCodeToSemitone('KeyP')).toBe(15)
    expect(midiKeyboardCodeToSemitone('KeyC')).toBeUndefined()
  })

  test('clamps octave and velocity controls', () => {
    expect(clampMidiKeyboardOctave(-9)).toBe(-4)
    expect(clampMidiKeyboardOctave(2)).toBe(2)
    expect(clampMidiKeyboardOctave(9)).toBe(4)
    expect(clampMidiKeyboardVelocity(-1)).toBe(0.1)
    expect(clampMidiKeyboardVelocity(0.7)).toBe(0.7)
    expect(clampMidiKeyboardVelocity(2)).toBe(1)
  })
})
