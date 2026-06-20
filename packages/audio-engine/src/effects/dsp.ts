import { normalizeReverbParams, REVERB_DECAY_SEC_MAX, REVERB_DECAY_SEC_MIN, supportsGain, type ArpParams, type EqBandParams, type EqParamsLite, type ReverbParamsLite } from '@daw-browser/shared'

type MidiNote = { beat: number; length: number; pitch: number; velocity?: number }

type ImpulseBucket = {
  bucketIndex: number
  bucketSec: number
}

type ReverbImpulseInfo = ImpulseBucket & {
  densityBucket: number
  diffusionBucket: number
  highCutBucket: number
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

export function getImpulseBucket(decaySec: number, bucketSize = 0.1): ImpulseBucket {
  const clampedDecay = Math.min(REVERB_DECAY_SEC_MAX, Math.max(REVERB_DECAY_SEC_MIN, decaySec))
  const bucketIndex = Math.max(1, Math.round(clampedDecay / bucketSize))
  return {
    bucketIndex,
    bucketSec: Math.min(REVERB_DECAY_SEC_MAX, Math.max(bucketSize, bucketIndex * bucketSize)),
  }
}

export function getImpulseResponseBufferInfo(
  ctx: BaseAudioContext,
  params: ReverbParamsLite,
  options?: { bucketSize?: number },
): ReverbImpulseInfo {
  return createReverbImpulseRender(ctx, params, options).info
}

export function createReverbImpulseRender(
  ctx: BaseAudioContext,
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
  const sizeScale = 0.5 + params.size * 0.75
  const bucket = getImpulseBucket(params.decaySec * sizeScale, options?.bucketSize)
  const densityBucket = Math.round(params.density * 100)
  const diffusionBucket = Math.round(params.diffusion * 100)
  const highCutBucket = Math.round(params.highCutHz / 100)
  const length = Math.max(1, Math.floor(sampleRate * bucket.bucketSec))
  return {
    bucketIndex: bucket.bucketIndex,
    bucketSec: bucket.bucketSec,
    densityBucket,
    diffusionBucket,
    highCutBucket,
    length,
    signature: `${bucket.bucketIndex}:${densityBucket}:${diffusionBucket}:${highCutBucket}:${length}`,
  }
}

export function createImpulseResponseBuffer(
  ctx: BaseAudioContext,
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
    const damping = 1 - params.highCutHz / 20000
    let smoothed = 0
    for (let frame = 0; frame < info.length; frame++) {
      const t = frame / info.length
      const decay = Math.pow(1 - t, 1.5 + diffusion * 2.5)
      const sparse = noise() <= density ? noise() * 2 - 1 : 0
      smoothed += (sparse - smoothed) * (1 - damping * 0.85)
      data[frame] = (sparse * (1 - diffusion) + smoothed * diffusion) * decay
    }
  }
  return { buffer: impulse, bucketIndex: info.bucketIndex, bucketSec: info.bucketSec, length: info.length, signature: info.signature }
}

export function createEqNodes(ctx: BaseAudioContext, params?: EqParamsLite, channels = 2): BiquadFilterNode[] {
  const nodes: BiquadFilterNode[] = []
  if (!params?.enabled) return nodes
  for (const band of params.bands) {
    if (!band.enabled) continue
    const filter = ctx.createBiquadFilter()
    try {
      ;(filter as any).channelCountMode = 'explicit'
      ;(filter as any).channelInterpretation = 'speakers'
      filter.channelCount = Math.max(1, Math.min(2, channels))
    } catch {
      // Some browsers may not allow changing channel configuration.
    }
    applyEqBandParams(filter, band)
    nodes.push(filter)
  }
  return nodes
}

export function getEqTopologySignature(params?: EqParamsLite): string {
  if (!params?.enabled) return ''
  return params.bands
    .filter((band) => band.enabled)
    .map((band) => `${band.id}:${band.type}`)
    .join('|')
}

export function applyEqNodeParams(nodes: BiquadFilterNode[], params: EqParamsLite) {
  const bands = params.enabled ? params.bands.filter((band) => band.enabled) : []
  for (let index = 0; index < nodes.length; index++) {
    applyEqBandParams(nodes[index], bands[index])
  }
}

function applyEqBandParams(filter: BiquadFilterNode, band: EqBandParams) {
  filter.type = band.type
  filter.frequency.value = Math.max(20, Math.min(20000, band.frequency))
  filter.Q.value = Math.max(0.001, band.q)
  filter.gain.value = supportsGain(band.type) ? band.gainDb : 0
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
