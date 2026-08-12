import { DELAY_MAX_DELAY_TIME_SEC, arpeggiatorSequence, arpeggiatorStepBeats, evaluateSaturatorCurvePoint, normalizeSaturatorParams, normalizeDelayParams, supportsGain, type ArpParams, type DelayParamsLite, type EqBandParams, type EqChannelMode, type EqParamsLite, type SaturatorCurve, type SaturatorParamsLite } from '@daw-browser/shared'

type MidiNote = { id?: string; beat: number; length: number; pitch: number; velocity?: number }


export function createEqNodes(ctx: BaseAudioContext, params?: EqParamsLite, channels = 2): BiquadFilterNode[] {
  const nodes: BiquadFilterNode[] = []
  if (!params?.enabled) return nodes
  for (const band of params.bands) {
    if (!band.enabled) continue
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
  const bandsSignature = params.bands
    .filter((band) => band.enabled)
    .map((band) => `${band.id}:${band.type}`)
    .join('|')
  return bandsSignature ? `${params.channelMode}|${bandsSignature}` : ''
}

export function applyEqNodeParams(nodes: BiquadFilterNode[], params: EqParamsLite) {
  const bands = params.enabled ? params.bands.filter((band) => band.enabled) : []
  for (let index = 0; index < nodes.length; index++) {
    applyEqBandParams(nodes[index], bands[index])
  }
}

function applyEqBandParams(filter: BiquadFilterNode, band: EqBandParams) {
  filter.type = band.type
  filter.frequency.value = band.frequency
  filter.Q.value = band.q
  filter.gain.value = supportsGain(band.type) ? band.gainDb : 0
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
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
  shaper: WaveShaperNode
  dryGain: GainNode
  wetGain: GainNode
  outputGain: GainNode
}, params: SaturatorParamsLite) {
  const normalized = normalizeSaturatorParams(params)
  nodes.driveGain.gain.value = dbToGain(normalized.driveDb)
  nodes.colorFilter.type = 'peaking'
  nodes.colorFilter.frequency.value = normalized.colorFrequencyHz
  nodes.colorFilter.Q.value = 0.8
  nodes.colorFilter.gain.value = normalized.color ? normalized.colorAmount * 12 : 0
  nodes.shaper.curve = getSaturatorCurve(normalized.curve)
  nodes.shaper.oversample = '4x'
  nodes.dryGain.gain.value = 1 - normalized.dryWet
  nodes.wetGain.gain.value = normalized.dryWet
  nodes.outputGain.gain.value = dbToGain(normalized.outputDb)
}

export function resolveDelayTimeSec(params: DelayParamsLite, bpm: number): number {
  const normalized = normalizeDelayParams(params)
  if (normalized.mode === 'time') return Math.min(DELAY_MAX_DELAY_TIME_SEC, normalized.timeMs / 1000)
  const beatSec = 60 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 120)
  const multipliers: Record<string, number> = { '1/16': 0.25, '1/8': 0.5, '1/4': 1, '1/2': 2, '1/1': 4 }
  return Math.min(DELAY_MAX_DELAY_TIME_SEC, beatSec * (multipliers[normalized.syncDivision] ?? 0.5))
}

export function applyDelayNodeParams(nodes: {
  delayLeft: DelayNode
  delayRight?: DelayNode
  feedbackLeft: GainNode
  feedbackRight?: GainNode
  dryGain: GainNode
  wetGain: GainNode
  lowCutLeft: BiquadFilterNode
  highCutLeft: BiquadFilterNode
  lowCutRight?: BiquadFilterNode
  highCutRight?: BiquadFilterNode
}, params: DelayParamsLite, bpm: number) {
  const normalized = normalizeDelayParams(params)
  const timeSec = resolveDelayTimeSec(normalized, bpm)
  nodes.delayLeft.delayTime.value = timeSec
  if (nodes.delayRight) nodes.delayRight.delayTime.value = timeSec
  nodes.feedbackLeft.gain.value = normalized.feedback
  if (nodes.feedbackRight) nodes.feedbackRight.gain.value = normalized.feedback
  nodes.dryGain.gain.value = 1 - normalized.dryWet
  nodes.wetGain.gain.value = normalized.dryWet
  for (const filter of [nodes.lowCutLeft, nodes.lowCutRight]) {
    if (!filter) continue
    filter.type = 'highpass'
    filter.frequency.value = normalized.filterEnabled ? normalized.lowCutHz : 20
    filter.Q.value = 0.707
  }
  for (const filter of [nodes.highCutLeft, nodes.highCutRight]) {
    if (!filter) continue
    filter.type = 'lowpass'
    filter.frequency.value = normalized.filterEnabled ? normalized.highCutHz : 20000
    filter.Q.value = 0.707
  }
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
