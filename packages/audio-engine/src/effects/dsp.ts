import { DELAY_MAX_DELAY_TIME_SEC, evaluateSaturatorCurvePoint, normalizeReverbParams, normalizeSaturatorParams, normalizeDelayParams, REVERB_DIFFUSION_HIGH_CUT_HZ_MAX, REVERB_DIFFUSION_LOW_CUT_HZ_MIN, supportsGain, type ArpParams, type DelayParamsLite, type EqBandParams, type EqChannelMode, type EqParamsLite, type ReverbParamsLite, type SaturatorCurve, type SaturatorParamsLite } from '@daw-browser/shared'
import { formatReverbImpulseSignature, getReverbImpulseSignatureParts, type ReverbImpulseSignatureParts } from './reverb-signature'

type MidiNote = { beat: number; length: number; pitch: number; velocity?: number }

type ReverbImpulseInfo = ReverbImpulseSignatureParts & {
  length: number
  signature: string
}

type ReverbImpulseRender = {
  params: ReverbParamsLite
  info: ReverbImpulseInfo
}

function createSeededRandom(seed: number) {
  let state = (seed >>> 0) || 1
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function getOnePoleLowpassAlpha(cutoffHz: number, sampleRate: number): number {
  return 1 - Math.exp(-2 * Math.PI * cutoffHz / sampleRate)
}

function getOnePoleHighpassAlpha(cutoffHz: number, sampleRate: number): number {
  return Math.exp(-2 * Math.PI * cutoffHz / sampleRate)
}

export function getImpulseResponseBufferInfo(
  ctx: Pick<BaseAudioContext, 'sampleRate'>,
  params: ReverbParamsLite,
  options?: { bucketSize?: number },
): ReverbImpulseInfo {
  return createReverbImpulseRender(ctx, params, options).info
}

export function createReverbImpulseRender(
  ctx: Pick<BaseAudioContext, 'sampleRate'>,
  params: ReverbParamsLite,
  options?: { bucketSize?: number },
): ReverbImpulseRender {
  const normalized = normalizeReverbParams(params)
  const info = createReverbImpulseRenderInfo(ctx.sampleRate, normalized, options)
  return { params: normalized, info }
}

export function createReverbImpulseRenderInfo(
  sampleRate: number,
  params: ReverbParamsLite,
  options?: { bucketSize?: number },
): ReverbImpulseInfo {
  const signatureParts = getReverbImpulseSignatureParts(params, options)
  const length = Math.max(1, Math.floor(sampleRate * signatureParts.bucketSec))
  return {
    ...signatureParts,
    length,
    signature: formatReverbImpulseSignature(signatureParts, length),
  }
}

export function addEarlyReflectionTaps(
  data: Float32Array,
  sampleRate: number,
  params: ReverbParamsLite,
  channel: number,
) {
  const normalized = normalizeReverbParams(params)
  const reflections = normalized.reflections
  if (reflections <= 0) return
  const spacingScale = 0.7 + normalized.size * 0.8
  const shape = normalized.reflectionShape
  const modAmountMs = normalized.reflectionSpin ? normalized.reflectionModAmountMs : 0
  const modRateHz = normalized.reflectionModRateHz
  const taps = channel === 0
    ? [
        { delayMs: 7, gain: 0.34 },
        { delayMs: 13, gain: -0.25 },
        { delayMs: 23, gain: 0.19 },
        { delayMs: 37, gain: -0.14 },
      ]
    : [
        { delayMs: 9, gain: -0.31 },
        { delayMs: 17, gain: 0.23 },
        { delayMs: 29, gain: -0.17 },
        { delayMs: 41, gain: 0.13 },
      ]
  for (const tap of taps) {
    const delaySec = (tap.delayMs * spacingScale) / 1000
    const spinPhase = channel * Math.PI * 0.5 + delaySec * modRateHz * Math.PI * 2
    const modDelayMs = Math.sin(spinPhase) * modAmountMs * 0.5
    const frame = Math.round(((tap.delayMs * spacingScale + modDelayMs) * sampleRate) / 1000)
    const shapedGain = tap.gain * (0.65 + shape * 0.7)
    if (frame >= 0 && frame < data.length) data[frame] += shapedGain * reflections
  }
}

export function createImpulseResponseBuffer(
  ctx: Pick<BaseAudioContext, 'sampleRate' | 'createBuffer'>,
  render: ReverbImpulseRender,
  options?: { channelCount?: number },
) {
  const params = render.params
  const info = render.info
  const channelCount = Math.max(1, Math.min(2, options?.channelCount ?? 2))
  const impulse = ctx.createBuffer(channelCount, info.length, ctx.sampleRate)
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel)
    const noise = createSeededRandom(
      info.bucketIndex * 0x9E3779B1
      + info.densityBucket * 0x85EBCA77
      + info.diffusionBucket * 0xC2B2AE3D
      + channel * 0x27D4EB2F,
    )
    const density = Math.max(0.05, params.density)
    const diffusion = params.diffusion
    const diffusionAlpha = 0.08 + diffusion * 0.35
    const highCutActive = params.diffusionHighCutHz < REVERB_DIFFUSION_HIGH_CUT_HZ_MAX
    const lowCutActive = params.diffusionLowCutHz > REVERB_DIFFUSION_LOW_CUT_HZ_MIN
    const lowpassAlpha = highCutActive ? getOnePoleLowpassAlpha(params.diffusionHighCutHz, ctx.sampleRate) : 1
    const highpassAlpha = lowCutActive ? getOnePoleHighpassAlpha(params.diffusionLowCutHz, ctx.sampleRate) : 1
    const reflectionShape = 0.75 + params.reflectionShape * 1.5
    let diffusedState = 0
    let lowPassed = 0
    let previousHighpassInput = 0
    let highPassed = 0
    for (let frame = 0; frame < info.length; frame++) {
      const t = frame / info.length
      const decay = Math.pow(1 - t, 1.5 + diffusion * 2.5)
      const sparse = noise() <= density ? noise() * 2 - 1 : 0
      diffusedState += (sparse - diffusedState) * diffusionAlpha
      let shaped = (sparse * (1 - diffusion) + diffusedState * diffusion) * params.diffuse * Math.pow(1 - t, reflectionShape)
      if (highCutActive) {
        lowPassed += lowpassAlpha * (shaped - lowPassed)
        shaped = lowPassed
      }
      if (lowCutActive) {
        highPassed = highpassAlpha * (highPassed + shaped - previousHighpassInput)
        previousHighpassInput = shaped
        shaped = highPassed
      }
      data[frame] = shaped * decay
    }
    addEarlyReflectionTaps(data, ctx.sampleRate, params, channel)
  }
  return { buffer: impulse, bucketIndex: info.bucketIndex, bucketSec: info.bucketSec, length: info.length, signature: info.signature }
}

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

  const rateMap: Record<string, number> = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 }
  const stepBeats = rateMap[params.rate] ?? 0.25
  const chordThreshold = 0.02
  const sorted = notes.slice().sort((left, right) => left.beat - right.beat)
  const chords: Array<{ beat: number; endBeat: number; pitches: number[]; velocity: number }> = []

  for (const note of sorted) {
    const lastChord = chords[chords.length - 1]
    if (lastChord && Math.abs(note.beat - lastChord.beat) < chordThreshold) {
      lastChord.pitches.push(note.pitch)
      lastChord.endBeat = Math.max(lastChord.endBeat, note.beat + note.length)
      continue
    }
    chords.push({
      beat: note.beat,
      endBeat: note.beat + note.length,
      pitches: [note.pitch],
      velocity: note.velocity ?? 0.9,
    })
  }

  const arpeggiated: MidiNote[] = []
  for (const chord of chords) {
    const basePitches = chord.pitches.slice().sort((left, right) => left - right)
    if (basePitches.length === 0) continue

    const expandedPitches: number[] = []
    const octaves = Math.max(1, Math.floor(params.octaves || 1))
    for (let octave = 0; octave < octaves; octave++) {
      for (const pitch of basePitches) expandedPitches.push(pitch + octave * 12)
    }
    if (expandedPitches.length === 0) continue

    let sequence: number[] = []
    switch (params.pattern) {
      case 'up':
        sequence = expandedPitches
        break
      case 'down':
        sequence = expandedPitches.slice().reverse()
        break
      case 'updown':
        sequence = [...expandedPitches, ...expandedPitches.slice(0, -1).reverse()]
        break
      case 'random': {
        sequence = expandedPitches.slice()
        if (sequence.length > 1) {
          const signature = chord.pitches.reduce((acc, pitch, index) => {
            const mixed = (acc ^ ((pitch + index * 131) >>> 0)) >>> 0
            return ((mixed << 5) - mixed) >>> 0
          }, Math.floor(chord.beat * 10_000) >>> 0)
          const random = createSeededRandom(signature || 1)
          for (let index = sequence.length - 1; index > 0; index--) {
            const swapIndex = Math.floor(random() * (index + 1))
            ;[sequence[index], sequence[swapIndex]] = [sequence[swapIndex], sequence[index]]
          }
        }
        break
      }
      default:
        sequence = expandedPitches
    }

    const endBeat = params.hold ? clipDurationBeats : chord.endBeat
    const gate = Math.max(0, params.gate)
    if (gate <= 0) continue
    const noteLength = stepBeats * gate
    let currentBeat = chord.beat
    let sequenceIndex = 0
    while (currentBeat < endBeat && currentBeat < clipDurationBeats) {
      arpeggiated.push({
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
