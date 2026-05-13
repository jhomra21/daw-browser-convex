const EPSILON = 1e-4

type MidiVoiceSource = {
  wave?: OscillatorType
  gain?: number
}

type SynthVoiceSource = {
  wave1?: OscillatorType
  wave2?: OscillatorType
  gain?: number
  attackMs?: number
  releaseMs?: number
}

export type SynthVoiceConfig = {
  wave1: OscillatorType
  wave2: OscillatorType
  synthGain: number
  clipGain: number
  attackSec: number
  releaseSec: number
}

export type SynthVoiceEnvelope = {
  peakTime: number
  releaseStartTime: number
  endTime: number
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function getSynthVoiceConfig(input: {
  synth?: SynthVoiceSource | null
  midi?: MidiVoiceSource | null
}): SynthVoiceConfig {
  const synth = input.synth
  const midiWave = input.midi?.wave
  const wave1 = synth?.wave1 ?? midiWave ?? 'sawtooth'
  const wave2 = synth?.wave2 ?? wave1

  return {
    wave1,
    wave2,
    synthGain: typeof synth?.gain === 'number' ? clamp(synth.gain, 0, 1.5) : 0.8,
    clipGain: typeof input.midi?.gain === 'number' ? clamp(input.midi.gain, 0, 1.5) : 1.0,
    attackSec: Math.max(0.001, (synth?.attackMs ?? 5) / 1000),
    releaseSec: Math.max(0.001, (synth?.releaseMs ?? 30) / 1000),
  }
}

export function getSynthVoiceVelocity(velocity?: number) {
  return typeof velocity === 'number' ? clamp(velocity, 0, 1) : 0.9
}

export function getMidiNoteFrequency(pitch: number) {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

export function getSynthVoiceEnvelope(
  startTime: number,
  durationSec: number,
  attackSec: number,
  releaseSec: number,
): SynthVoiceEnvelope {
  const safeAttackSec = Math.max(0.001, attackSec)
  const safeReleaseSec = Math.max(0.001, releaseSec)
  const safeDurationSec = Math.max(0, durationSec)
  const peakTime = startTime + safeAttackSec
  const endTime = startTime + Math.max(safeDurationSec, safeAttackSec)
  const releaseStartTime = Math.max(peakTime, endTime - safeReleaseSec)

  return {
    peakTime,
    releaseStartTime,
    endTime,
  }
}

export function scheduleSynthVoiceEnvelope(
  gain: AudioParam,
  options: {
    startTime: number
    durationSec: number
    attackSec: number
    releaseSec: number
    peakGain: number
    epsilon?: number
  },
) {
  const epsilon = Math.max(1e-8, options.epsilon ?? EPSILON)
  const envelope = getSynthVoiceEnvelope(
    options.startTime,
    options.durationSec,
    options.attackSec,
    options.releaseSec,
  )

  gain.setValueAtTime(epsilon, options.startTime)
  gain.exponentialRampToValueAtTime(Math.max(epsilon, options.peakGain), envelope.peakTime)
  if (envelope.releaseStartTime > envelope.peakTime) {
    gain.setValueAtTime(Math.max(epsilon, options.peakGain), envelope.releaseStartTime)
  }
  gain.exponentialRampToValueAtTime(epsilon, envelope.endTime)
  try {
    gain.setValueAtTime(0, envelope.endTime + 1e-4)
  } catch {}

  return envelope
}

export function createSynthVoiceOscillators(
  ctx: BaseAudioContext,
  options: {
    startTime: number
    pitch: number
    wave1: OscillatorType
    wave2: OscillatorType
  },
) {
  const osc1 = ctx.createOscillator()
  const osc2 = ctx.createOscillator()
  const frequency = getMidiNoteFrequency(options.pitch)

  try { osc1.type = options.wave1 } catch {}
  try { osc2.type = options.wave2 } catch {}
  osc1.frequency.setValueAtTime(frequency, options.startTime)
  osc2.frequency.setValueAtTime(frequency, options.startTime)

  return { osc1, osc2 }
}
