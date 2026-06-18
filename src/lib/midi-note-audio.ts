export const midiPitchFrequency = (pitch: number) => 440 * Math.pow(2, (pitch - 69) / 12)

export const clampMidiVelocity = (velocity: number) => Math.max(0, Math.min(1.5, velocity))
