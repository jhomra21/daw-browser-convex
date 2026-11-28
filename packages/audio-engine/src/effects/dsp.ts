import { DEFAULT_BPM } from '@daw-browser/timeline-core/project-defaults'
import { DELAY_MAX_DELAY_TIME_SEC, arpeggiatorSequence, arpeggiatorStepBeats, evaluateSaturatorCurvePoint, linearFromDb, normalizeSaturatorParams, normalizeDelayParams, effectiveEqBand, EQ_BANDS_PER_CURVE, type ArpParams, type DelayParamsLite, type EqBandType, type EqChannelMode, type EqParamsLite, type SaturatorCurve, type SaturatorParamsLite } from '@daw-browser/shared'

type MidiNote = { id?: string; beat: number; length: number; pitch: number; velocity?: number }


// The Web Audio path predates EQ Eight and has no 48 dB slopes, second curve, Output gain or oversampling. It runs the first
// curve as one BiquadFilterNode per enabled band with Scale and Adaptive Q applied, a 48 dB cut as its 12 dB cut, and L/R and
// M/S as Stereo. The portable core is the product path and implements all of it.
const LEGACY_BAND_TYPE: Record<EqBandType, BiquadFilterType> = {
  lowpass: 'lowpass',
  highpass: 'highpass',
  bandpass: 'bandpass',
  lowshelf: 'lowshelf',
  highshelf: 'highshelf',
  peaking: 'peaking',
  notch: 'notch',
  allpass: 'allpass',
  lowpass48: 'lowpass',
  highpass48: 'highpass',
}

export type LegacyEqBand = { id: string; type: BiquadFilterType; frequency: number; gainDb: number; q: number }

export function getLegacyEqBands(params: EqParamsLite): LegacyEqBand[] {
  if (!params.enabled) return []

  return params.bands.slice(0, EQ_BANDS_PER_CURVE).filter((band) => band.enabled).map((band) => {
    const { gainDb, q } = effectiveEqBand(band, params)

    return { id: band.id, type: LEGACY_BAND_TYPE[band.type], frequency: band.frequency, gainDb, q }
  })
}

export function createEqNodes(ctx: BaseAudioContext, params?: EqParamsLite, channels = 2): BiquadFilterNode[] {
  const nodes: BiquadFilterNode[] = []

  if (!params?.enabled) return nodes

  for (const band of getLegacyEqBands(params)) {
    const filter = ctx.createBiquadFilter()
    configureEqNodeChannels(filter, params.channelMode, channels)
    applyEqBandParams(filter, band)
    nodes.push(filter)
  }

  return nodes
}

export function resolveEqChannelCount(mode: EqChannelMode, availableChannels = 2): number {
  if (mode === 'mono') return 1

  return Math.max(1, Math.min(2, availableChannels))
}

type ConfigurableEqNodeChannels = Pick<AudioNode, 'channelCount' | 'channelCountMode' | 'channelInterpretation'>

export function configureEqNodeChannels(node: ConfigurableEqNodeChannels, mode: EqChannelMode, availableChannels = 2) {
  try {
    node.channelCountMode = 'explicit'
    node.channelInterpretation = 'speakers'
    node.channelCount = resolveEqChannelCount(mode, availableChannels)
  } catch {
    // Some browsers may not allow changing channel configuration.
  }
}

export function getEqTopologySignature(params?: EqParamsLite): string {
  if (!params?.enabled) return ''

  const bandsSignature = getLegacyEqBands(params)
    .map((band) => `${band.id}:${band.type}`)
    .join('|')

  return bandsSignature ? `${params.channelMode}|${bandsSignature}` : ''
}

export function applyEqNodeParams(nodes: BiquadFilterNode[], params: EqParamsLite) {
  const bands = getLegacyEqBands(params)

  for (let index = 0; index < nodes.length; index++) {
    applyEqBandParams(nodes[index], bands[index])
  }
}

function applyEqBandParams(filter: BiquadFilterNode, band: LegacyEqBand) {
  filter.type = band.type
  filter.frequency.value = band.frequency
  filter.Q.value = band.q
  filter.gain.value = band.gainDb
}

export function createSaturatorCurve(curve: SaturatorCurve): Float32Array<ArrayBuffer> {
  const values = new Float32Array(new ArrayBuffer(4096 * Float32Array.BYTES_PER_ELEMENT))

  for (let index = 0; index < values.length; index++) {
    const x = (index / (values.length - 1)) * 2 - 1
    const y = evaluateSaturatorCurvePoint(curve, x)
    values[index] = Math.max(-1, Math.min(1, Number.isFinite(y) ? y : 0))
  }

  return values
}

const saturatorCurveCache = new Map<SaturatorCurve, Float32Array<ArrayBuffer>>()

function getSaturatorCurve(curve: SaturatorCurve): Float32Array<ArrayBuffer> {
  const cached = saturatorCurveCache.get(curve)

  if (cached) return cached
  const values = createSaturatorCurve(curve)
  saturatorCurveCache.set(curve, values)

  return values
}

export function applySaturatorNodeParams(nodes: {
  driveGain: GainNode
  colorFilter: BiquadFilterNode
  waveNode: ReturnType<BaseAudioContext['createWaveShaper']>
  dryGain: GainNode
  wetGain: GainNode
  outputGain: GainNode
}, params: SaturatorParamsLite) {
  const normalized = normalizeSaturatorParams(params)
  nodes.driveGain.gain.value = linearFromDb(normalized.driveDb)
  nodes.colorFilter.type = 'peaking'
  nodes.colorFilter.frequency.value = normalized.colorFrequencyHz
  nodes.colorFilter.Q.value = 0.8
  nodes.colorFilter.gain.value = normalized.color ? normalized.colorAmount * 12 : 0
  nodes.waveNode.curve = getSaturatorCurve(normalized.curve)
  nodes.waveNode.oversample = '4x'
  nodes.dryGain.gain.value = 1 - normalized.dryWet
  nodes.wetGain.gain.value = normalized.dryWet
  nodes.outputGain.gain.value = linearFromDb(normalized.outputDb)
}

const DELAY_DIVISION_BEATS = { '1/32': 0.125, '1/16': 0.25, '1/8': 0.5, '1/4': 1, '1/2': 2, '1/1': 4 }

const DELAY_FEEL_SCALE = { straight: 1, dotted: 1.5, triplet: 2 / 3 }

// The longer of the two channels' times, which is how long the first echo takes to leave the delay.
export function resolveDelayTimeSec(params: DelayParamsLite, bpm: number): number {
  const normalized = normalizeDelayParams(params)
  const beatSec = 60 / (Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM)

  const channelSec = (side: 'Left' | 'Right') => {
    const free = normalized[`time${side}Ms`] / 1000

    if (!normalized[`sync${side}`]) return free

    return beatSec * DELAY_DIVISION_BEATS[normalized[`division${side}`]] * DELAY_FEEL_SCALE[normalized[`feel${side}`]]
      * (1 + normalized[`offset${side}Percent`] / 100)
  }

  const left = channelSec('Left')
  const right = normalized.link ? left : channelSec('Right')

  return Math.min(DELAY_MAX_DELAY_TIME_SEC, Math.max(left, right))
}

export function applyArpeggiatorToNotes(
  notes: MidiNote[],
  params: ArpParams,
  clipDurationBeats: number,
): MidiNote[] {
  if (!params.enabled || notes.length === 0) return notes

  const stepBeats = arpeggiatorStepBeats(params.rate)
  const chordThreshold = 0.02
  const sorted = notes.slice().sort((left, right) => left.beat - right.beat)
  const chords: Array<{ beat: number; endBeat: number; pitches: number[]; ids: string[]; velocity: number }> = []

  for (const note of sorted) {
    const lastChord = chords[chords.length - 1]

    if (lastChord && Math.abs(note.beat - lastChord.beat) < chordThreshold) {
      lastChord.pitches.push(note.pitch)

      if (note.id !== undefined) lastChord.ids.push(note.id)
      lastChord.endBeat = Math.max(lastChord.endBeat, note.beat + note.length)
      continue
    }

    chords.push({
      beat: note.beat,
      endBeat: note.beat + note.length,
      pitches: [note.pitch],
      ids: note.id === undefined ? [] : [note.id],
      velocity: note.velocity ?? 0.9,
    })
  }

  const arpeggiated: MidiNote[] = []

  for (const chord of chords) {
    const basePitches = chord.pitches.slice().sort((left, right) => left - right)

    if (basePitches.length === 0) continue

    const sequence = arpeggiatorSequence(basePitches, params, chord.beat)

    if (sequence.length === 0) continue

    const endBeat = params.hold ? clipDurationBeats : chord.endBeat
    const gate = Math.max(0, params.gate)

    if (gate <= 0) continue
    const noteLength = stepBeats * gate
    let currentBeat = chord.beat
    let sequenceIndex = 0

    while (currentBeat < endBeat && currentBeat < clipDurationBeats) {
      arpeggiated.push({
        id: `${chord.ids.join(',')}:${currentBeat}:${sequenceIndex}`,
        beat: currentBeat,
        length: noteLength,
        pitch: sequence[sequenceIndex % sequence.length],
        velocity: chord.velocity,
      })
      currentBeat += stepBeats
      sequenceIndex += 1
    }
  }

  return arpeggiated
}
