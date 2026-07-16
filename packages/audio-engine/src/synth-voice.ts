import {
  SYNTH_AUTOMATION_DESCRIPTORS,
  valueAtAutomationTime,
  type AutomationEnvelope,
  type SynthAutomationParameterId,
  type SynthEnvelopeParams,
  type SynthLfoParams,
  type SynthParams,
} from '@daw-browser/shared'
import { scheduleAutomationEnvelope } from './automation'

const EPSILON = 1e-4
const STEAL_FADE_SEC = 0.006

type SynthEnvelopePlan = {
  startTime: number
  attackEndTime: number
  decayEndTime: number
  noteOffTime: number
  releaseEndTime: number
  startLevel: number
  peak: number
  sustain: number
  levelAtNoteOff: number
}

type EnvelopeParam = {
  linearRampToValueAtTime: (value: number, endTime: number) => void
  setValueAtTime: (value: number, startTime: number) => void
}

export type SynthVoiceBindings = {
  oscillatorLevels: readonly [AudioParam | undefined, AudioParam | undefined]
  oscillatorGates: readonly [AudioParam | undefined, AudioParam | undefined]
  oscillatorDetunes: readonly [AudioParam | undefined, AudioParam | undefined]
  filterFrequency: AudioParam
  filterDetune: AudioParam
  filterQ: AudioParam
  outputGain: AudioParam
  outputPan: AudioParam
  lfoRate?: AudioParam
  lfoDepths: Partial<Record<'pitch' | 'filter' | 'amp' | 'pan', AudioParam>>
}

export type SynthVoiceHandle = {
  id: number
  noteInstanceId: number
  pitch: number
  clipId?: string
  stage: 'attack' | 'decay' | 'sustain' | 'release'
  startedAt: number
  scheduledStartTime: number
  releaseTime: number
  effectiveEndTime: number
  releaseStartedAt?: number
  sources: OscillatorNode[]
  oscillatorSources: readonly [OscillatorNode | undefined, OscillatorNode | undefined]
  nodes: AudioNode[]
  amplitude: GainNode
  amplitudeModulation: GainNode
  filter: BiquadFilterNode
  output: GainNode
  bindings: SynthVoiceBindings
  release: (when: number) => void
  retargetEnvelopes: (
    when: number,
    nextAmpEnvelope: SynthEnvelopeParams,
    nextFilterEnvelope: SynthEnvelopeParams,
    nextFilterAmount: number,
  ) => void
  rescheduleLfoAutomation: (envelopes: SynthAutomationEnvelopes, contextTime: number) => void
  stop: (when: number) => void
}

export type SynthAutomationEnvelopes = ReadonlyMap<SynthAutomationParameterId, AutomationEnvelope>

type SynthVoiceScheduleOptions = {
  id: number
  noteInstanceId: number
  pitch: number
  velocity?: number
  clipGain?: number
  when: number
  durationSec: number
  clipId?: string
  params: SynthParams
  destination: AudioNode
  timelineStartSec?: number
  timelineToCtxTime?: (timelineSec: number) => number
  automationEnvelopes?: SynthAutomationEnvelopes
  scheduleVoiceAutomation?: boolean
  onEnded?: (voice: SynthVoiceHandle) => void
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export const midiPitchFrequency = (pitch: number) => 440 * 2 ** ((pitch - 69) / 12)

export const createSynthOutputChain = (
  ctx: BaseAudioContext,
  destination: AudioNode,
  gain: number,
  pan: number,
  when: number,
) => {
  const outputPan = ctx.createStereoPanner()
  const output = ctx.createGain()
  outputPan.pan.setValueAtTime(pan, when)
  output.gain.setValueAtTime(gain, when)
  outputPan.connect(output)
  output.connect(destination)
  return { output, outputPan }
}

export const transposeFrequency = (
  baseHz: number,
  octave: number,
  semitone: number,
  detuneCents: number,
) => baseHz * 2 ** ((octave * 12 + semitone + detuneCents / 100) / 12)

const getSynthVoiceVelocity = (velocity?: number) => (
  typeof velocity === 'number' && Number.isFinite(velocity) ? clamp(velocity, 0, 1) : 0.9
)

export const getSynthCutoffLimit = (sampleRate: number) => Math.min(20_000, sampleRate * 0.45)

export const getSynthFilterCutoff = (
  frequencyHz: number,
  pitch: number,
  keyTracking: number,
  sampleRate: number,
) => clamp(
  frequencyHz * 2 ** (((pitch - 60) / 12) * keyTracking),
  20,
  getSynthCutoffLimit(sampleRate),
)

export const evaluateSynthParamsAtNote = (
  params: SynthParams,
  automationEnvelopes: SynthAutomationEnvelopes,
  timelineStartSec: number | undefined,
): SynthParams => {
  if (timelineStartSec === undefined) return params
  const noteValue = (parameterId: SynthAutomationParameterId, fallback: number) => {
    const envelope = automationEnvelopes.get(parameterId)
    return envelope
      ? valueAtAutomationTime(envelope.points, timelineStartSec, fallback)
      : fallback
  }
  return {
    ...params,
    ampEnvelope: {
      ...params.ampEnvelope,
      attackSec: noteValue('amp.attack', params.ampEnvelope.attackSec),
      decaySec: noteValue('amp.decay', params.ampEnvelope.decaySec),
      sustain: noteValue('amp.sustain', params.ampEnvelope.sustain),
      releaseSec: noteValue('amp.release', params.ampEnvelope.releaseSec),
    },
    filter: {
      ...params.filter,
      envelopeAmountOctaves: noteValue('filter.envAmount', params.filter.envelopeAmountOctaves),
      envelope: {
        ...params.filter.envelope,
        attackSec: noteValue('filter.attack', params.filter.envelope.attackSec),
        decaySec: noteValue('filter.decay', params.filter.envelope.decaySec),
        sustain: noteValue('filter.sustain', params.filter.envelope.sustain),
        releaseSec: noteValue('filter.release', params.filter.envelope.releaseSec),
      },
    },
  }
}

export function createSynthEnvelopePlan(
  startTime: number,
  durationSec: number,
  envelope: SynthEnvelopeParams,
  peak = 1,
  startLevel = 0,
): SynthEnvelopePlan {
  const attackSec = Math.max(0.001, envelope.attackSec)
  const decaySec = Math.max(0.001, envelope.decaySec)
  const releaseSec = Math.max(0.001, envelope.releaseSec)
  const noteOffTime = startTime + Math.max(0, durationSec)
  const attackEndTime = startTime + attackSec
  const decayEndTime = attackEndTime + decaySec
  const sustain = clamp(envelope.sustain, 0, 1) * peak
  const levelAtNoteOff = estimateSynthEnvelopeLevel({
    startTime,
    attackEndTime,
    decayEndTime,
    noteOffTime: Number.POSITIVE_INFINITY,
    releaseEndTime: Number.POSITIVE_INFINITY,
    startLevel,
    peak,
    sustain,
    levelAtNoteOff: sustain,
  }, noteOffTime)
  return {
    startTime,
    attackEndTime,
    decayEndTime,
    noteOffTime,
    releaseEndTime: noteOffTime + releaseSec,
    startLevel,
    peak,
    sustain,
    levelAtNoteOff,
  }
}

export function estimateSynthEnvelopeLevel(plan: SynthEnvelopePlan, time: number): number {
  if (time <= plan.startTime) return plan.startLevel
  if (time < plan.attackEndTime) {
    const progress = (time - plan.startTime) / Math.max(0.001, plan.attackEndTime - plan.startTime)
    return plan.startLevel + (plan.peak - plan.startLevel) * progress
  }
  if (time < plan.decayEndTime) {
    const progress = (time - plan.attackEndTime) / Math.max(0.001, plan.decayEndTime - plan.attackEndTime)
    return plan.peak + (plan.sustain - plan.peak) * progress
  }
  if (time <= plan.noteOffTime) return plan.sustain
  if (time >= plan.releaseEndTime) return 0
  return plan.levelAtNoteOff * (1 - (time - plan.noteOffTime) / Math.max(0.001, plan.releaseEndTime - plan.noteOffTime))
}

const createSynthReleasePlan = (
  startTime: number,
  startLevel: number,
  releaseSec: number,
): SynthEnvelopePlan => ({
  startTime,
  attackEndTime: startTime,
  decayEndTime: startTime,
  noteOffTime: startTime,
  releaseEndTime: startTime + Math.max(0.001, releaseSec),
  startLevel,
  peak: startLevel,
  sustain: startLevel,
  levelAtNoteOff: startLevel,
})

const scheduleEnvelope = (
  param: EnvelopeParam,
  plan: SynthEnvelopePlan,
) => {
  param.setValueAtTime(plan.startLevel, plan.startTime)
  if (plan.noteOffTime > plan.startTime) {
    if (plan.noteOffTime < plan.attackEndTime) {
      param.linearRampToValueAtTime(plan.levelAtNoteOff, plan.noteOffTime)
    } else {
      param.linearRampToValueAtTime(plan.peak, plan.attackEndTime)
      if (plan.noteOffTime < plan.decayEndTime) {
        param.linearRampToValueAtTime(plan.levelAtNoteOff, plan.noteOffTime)
      } else {
        param.linearRampToValueAtTime(plan.sustain, plan.decayEndTime)
      }
    }
  }
  param.setValueAtTime(plan.levelAtNoteOff, plan.noteOffTime)
  param.linearRampToValueAtTime(0, plan.releaseEndTime)
}

export function scheduleSynthEnvelope(gain: EnvelopeParam, plan: SynthEnvelopePlan) {
  scheduleEnvelope(gain, plan)
  gain.setValueAtTime(0, plan.releaseEndTime + 1e-4)
}

const scheduleFilterEnvelope = (filter: BiquadFilterNode, plan: SynthEnvelopePlan) => {
  scheduleEnvelope(filter.detune, plan)
}

const scheduleLfo = (
  ctx: BaseAudioContext,
  lfo: SynthLfoParams,
  when: number,
  sources: OscillatorNode[],
  filter: BiquadFilterNode,
  amplitudeModulation: GainNode,
  pan: StereoPannerNode,
): { node: OscillatorNode; depths: SynthVoiceBindings['lfoDepths']; nodes: GainNode[] } => {
  const oscillator = ctx.createOscillator()
  oscillator.type = lfo.wave
  oscillator.frequency.setValueAtTime(lfo.frequencyHz, when)
  const depths: SynthVoiceBindings['lfoDepths'] = {}
  const nodes: GainNode[] = []
  {
    const depth = ctx.createGain()
    nodes.push(depth)
    depth.gain.setValueAtTime(lfo.enabled ? lfo.pitchCents : 0, when)
    oscillator.connect(depth)
    for (const source of sources) depth.connect(source.detune)
    depths.pitch = depth.gain
  }
  {
    const depth = ctx.createGain()
    nodes.push(depth)
    depth.gain.setValueAtTime(lfo.enabled ? lfo.filterOctaves * 1200 : 0, when)
    oscillator.connect(depth)
    depth.connect(filter.detune)
    depths.filter = depth.gain
  }
  {
    const depth = ctx.createGain()
    nodes.push(depth)
    depth.gain.setValueAtTime(lfo.enabled ? lfo.amp : 0, when)
    oscillator.connect(depth)
    depth.connect(amplitudeModulation.gain)
    depths.amp = depth.gain
  }
  {
    const depth = ctx.createGain()
    nodes.push(depth)
    depth.gain.setValueAtTime(lfo.enabled ? lfo.pan : 0, when)
    oscillator.connect(depth)
    depth.connect(pan.pan)
    depths.pan = depth.gain
  }
  oscillator.start(when)
  return { node: oscillator, depths, nodes }
}

export function scheduleSynthVoice(ctx: BaseAudioContext, options: SynthVoiceScheduleOptions): SynthVoiceHandle {
  const { when, pitch } = options
  const params = evaluateSynthParamsAtNote(
    options.params,
    options.automationEnvelopes ?? new Map(),
    options.timelineStartSec,
  )
  const releaseTime = when + Math.max(0, options.durationSec)
  const clipGain = typeof options.clipGain === 'number' && Number.isFinite(options.clipGain)
    ? clamp(options.clipGain, 0, 1.5)
    : 1
  let ampPlan = createSynthEnvelopePlan(
    when,
    options.durationSec,
    params.ampEnvelope,
    getSynthVoiceVelocity(options.velocity) * clipGain,
    EPSILON,
  )
  let filterPlan = createSynthEnvelopePlan(
    when,
    options.durationSec,
    params.filter.envelope,
    (params.filter.enabled ? params.filter.envelopeAmountOctaves : 0) * 1200,
  )
  let ampEnvelope = params.ampEnvelope
  let filterEnvelope = params.filter.envelope
  const filter = ctx.createBiquadFilter()
  filter.type = params.filter.enabled ? params.filter.mode : 'allpass'
  filter.frequency.setValueAtTime(
    params.filter.enabled
      ? getSynthFilterCutoff(params.filter.frequencyHz, pitch, params.filter.keyTracking, ctx.sampleRate)
      : getSynthFilterCutoff(20_000, pitch, 0, ctx.sampleRate),
    when,
  )
  filter.Q.setValueAtTime(params.filter.enabled ? params.filter.q : 0.0001, when)
  scheduleFilterEnvelope(filter, filterPlan)
  const amplitude = ctx.createGain()
  scheduleSynthEnvelope(amplitude.gain, ampPlan)
  const amplitudeModulation = ctx.createGain()
  amplitudeModulation.gain.setValueAtTime(1, when)
  const pan = ctx.createStereoPanner()
  pan.pan.setValueAtTime(0, when)
  const output = ctx.createGain()
  output.gain.setValueAtTime(1, when)
  filter.connect(amplitude)
  amplitude.connect(amplitudeModulation)
  amplitudeModulation.connect(pan)
  pan.connect(output)
  output.connect(options.destination)

  const baseFrequency = midiPitchFrequency(pitch)
  const sources: OscillatorNode[] = []
  const oscillatorSources: [OscillatorNode | undefined, OscillatorNode | undefined] = [undefined, undefined]
  const oscillatorLevelNodes: GainNode[] = []
  const oscillatorGateNodes: GainNode[] = []
  const oscillatorLevels: [AudioParam | undefined, AudioParam | undefined] = [undefined, undefined]
  const oscillatorGates: [AudioParam | undefined, AudioParam | undefined] = [undefined, undefined]
  const oscillatorDetunes: [AudioParam | undefined, AudioParam | undefined] = [undefined, undefined]
  for (const [index, oscillator] of params.oscillators.entries()) {
    const source = ctx.createOscillator()
    const level = ctx.createGain()
    const gate = ctx.createGain()
    source.type = oscillator.wave
    source.frequency.setValueAtTime(transposeFrequency(baseFrequency, oscillator.octave, oscillator.semitone, 0), when)
    source.detune.setValueAtTime(oscillator.detuneCents, when)
    level.gain.setValueAtTime(oscillator.level, when)
    gate.gain.setValueAtTime(oscillator.enabled ? 1 : 0, when)
    source.connect(level)
    level.connect(gate)
    gate.connect(filter)
    source.start(when)
    source.stop(ampPlan.releaseEndTime)
    sources.push(source)
    oscillatorSources[index] = source
    oscillatorLevelNodes.push(level)
    oscillatorGateNodes.push(gate)
    oscillatorLevels[index] = level.gain
    oscillatorGates[index] = gate.gain
    oscillatorDetunes[index] = source.detune
  }
  const lfo = scheduleLfo(ctx, params.lfo, when, sources, filter, amplitudeModulation, pan)
  lfo.node.stop(ampPlan.releaseEndTime)
  const nodes: AudioNode[] = [filter, amplitude, amplitudeModulation, pan, output, ...sources, ...oscillatorLevelNodes, ...oscillatorGateNodes, ...lfo.nodes]
  nodes.push(lfo.node)
  const endableSources = [...sources, lfo.node]
  let endedSources = 0
  let stopped = false
  let finalized = false
  const finalize = () => {
    if (finalized) return
    finalized = true
    for (const node of nodes) {
      try { node.disconnect() } catch {}
    }
    options.onEnded?.(handle)
  }
  const handle: SynthVoiceHandle = {
    id: options.id,
    noteInstanceId: options.noteInstanceId,
    pitch,
    clipId: options.clipId,
    stage: 'attack',
    startedAt: when,
    scheduledStartTime: when,
    releaseTime,
    effectiveEndTime: ampPlan.releaseEndTime,
    sources,
    oscillatorSources,
    nodes,
    amplitude,
    amplitudeModulation,
    filter,
    output,
    bindings: {
      oscillatorLevels,
      oscillatorGates,
      oscillatorDetunes,
      filterFrequency: filter.frequency,
      filterDetune: filter.detune,
      filterQ: filter.Q,
      outputGain: output.gain,
      outputPan: pan.pan,
      lfoRate: lfo.node.frequency,
      lfoDepths: lfo.depths,
    },
    release: (releaseWhen) => {
      if (stopped || handle.stage === 'release') return
      const start = Math.max(when, releaseWhen)
      const nextAmpPlan = createSynthReleasePlan(
        start,
        estimateSynthEnvelopeLevel(ampPlan, start),
        ampEnvelope.releaseSec,
      )
      const nextFilterPlan = createSynthReleasePlan(
        start,
        estimateSynthEnvelopeLevel(filterPlan, start),
        filterEnvelope.releaseSec,
      )
      amplitude.gain.cancelScheduledValues(start)
      scheduleSynthEnvelope(amplitude.gain, nextAmpPlan)
      filter.detune.cancelScheduledValues(start)
      scheduleFilterEnvelope(filter, nextFilterPlan)
      ampPlan = nextAmpPlan
      filterPlan = nextFilterPlan
      for (const source of endableSources) source.stop(nextAmpPlan.releaseEndTime)
      handle.releaseStartedAt = start
      handle.releaseTime = start
      handle.effectiveEndTime = nextAmpPlan.releaseEndTime
      handle.stage = 'release'
    },
    retargetEnvelopes: (retargetWhen, nextAmpEnvelope, nextFilterEnvelope, nextFilterAmount) => {
      if (stopped) return
      const start = Math.max(when, retargetWhen)
      const retargetPlan = (
        currentPlan: SynthEnvelopePlan,
        envelope: SynthEnvelopeParams,
        peak: number,
      ) => {
        const currentLevel = estimateSynthEnvelopeLevel(currentPlan, start)
        return start >= currentPlan.noteOffTime
          ? createSynthReleasePlan(start, currentLevel, envelope.releaseSec)
          : createSynthEnvelopePlan(
            start,
            Math.max(0, currentPlan.noteOffTime - start),
            envelope,
            peak,
            currentLevel,
          )
      }
      const nextAmpPlan = retargetPlan(
        ampPlan,
        nextAmpEnvelope,
        getSynthVoiceVelocity(options.velocity) * clipGain,
      )
      const nextFilterPlan = retargetPlan(
        filterPlan,
        nextFilterEnvelope,
        nextFilterAmount * 1200,
      )
      amplitude.gain.cancelScheduledValues(start)
      scheduleSynthEnvelope(amplitude.gain, nextAmpPlan)
      filter.detune.cancelScheduledValues(start)
      scheduleFilterEnvelope(filter, nextFilterPlan)
      ampPlan = nextAmpPlan
      filterPlan = nextFilterPlan
      ampEnvelope = nextAmpEnvelope
      filterEnvelope = nextFilterEnvelope
      for (const source of endableSources) source.stop(nextAmpPlan.releaseEndTime)
      handle.effectiveEndTime = nextAmpPlan.releaseEndTime
    },
    rescheduleLfoAutomation: (envelopes, contextTime) => {
      if (options.timelineStartSec === undefined || !options.timelineToCtxTime) return
      const startTimelineSec = Math.max(
        options.timelineStartSec,
        options.timelineStartSec + contextTime - when,
      )
      const endTimelineSec = options.timelineStartSec + Math.max(0, handle.effectiveEndTime - when)
      if (startTimelineSec >= endTimelineSec) return
      const bindings: Partial<Record<SynthAutomationParameterId, AudioParam>> = {
        'lfo.rate': handle.bindings.lfoRate,
        'lfo.pitchDepth': handle.bindings.lfoDepths.pitch,
        'lfo.filterDepth': handle.bindings.lfoDepths.filter,
        'lfo.ampDepth': handle.bindings.lfoDepths.amp,
        'lfo.panDepth': handle.bindings.lfoDepths.pan,
      }
      for (const [parameterId, envelope] of envelopes) {
        if (!parameterId.startsWith('lfo.') || !envelope.enabled) continue
        const param = bindings[parameterId]
        if (!param) continue
        scheduleAutomationEnvelope([{
          param,
          valueToAudioValue: (value) => (
            parameterId === 'lfo.filterDepth' ? value * 1200
              : value
          ),
        }], envelope, {
          playheadSec: startTimelineSec,
          startLimitSec: startTimelineSec,
          endLimitSec: endTimelineSec,
        }, options.timelineToCtxTime, SYNTH_AUTOMATION_DESCRIPTORS[parameterId].defaultValue)
      }
    },
    stop: (stopWhen) => {
      if (stopped && stopWhen >= handle.releaseTime) return
      stopped = true
      if (stopWhen < when) {
        amplitude.gain.cancelScheduledValues(stopWhen)
        amplitude.gain.setValueAtTime(0, stopWhen)
        for (const source of endableSources) source.stop(stopWhen)
        handle.releaseStartedAt = stopWhen
        handle.releaseTime = stopWhen
        handle.effectiveEndTime = stopWhen
        handle.stage = 'release'
        finalize()
        return
      }
      const end = Math.max(when, stopWhen) + STEAL_FADE_SEC
      const nextAmpPlan = createSynthReleasePlan(
        stopWhen,
        estimateSynthEnvelopeLevel(ampPlan, stopWhen),
        STEAL_FADE_SEC,
      )
      amplitude.gain.cancelScheduledValues(stopWhen)
      scheduleSynthEnvelope(amplitude.gain, nextAmpPlan)
      ampPlan = nextAmpPlan
      for (const source of endableSources) source.stop(end)
      handle.releaseStartedAt = stopWhen
      handle.releaseTime = stopWhen
      handle.effectiveEndTime = end
      handle.stage = 'release'
    },
  }
  if (options.scheduleVoiceAutomation !== false && options.timelineStartSec !== undefined && options.timelineToCtxTime) {
    const directBindings: Partial<Record<SynthAutomationParameterId, AudioParam>> = {
      'osc1.level': oscillatorLevels[0],
      'osc1.detune': oscillatorDetunes[0],
      'osc2.level': oscillatorLevels[1],
      'osc2.detune': oscillatorDetunes[1],
      'filter.frequency': filter.frequency,
      'filter.q': filter.Q,
      'lfo.rate': lfo.node?.frequency,
      'lfo.pitchDepth': lfo.depths.pitch,
      'lfo.filterDepth': lfo.depths.filter,
      'lfo.ampDepth': lfo.depths.amp,
      'lfo.panDepth': lfo.depths.pan,
    }
    for (const [parameterId, envelope] of options.automationEnvelopes ?? []) {
      const param = directBindings[parameterId]
      if (!param || !envelope.enabled || (!params.lfo.enabled && parameterId.startsWith('lfo.'))) continue
      scheduleAutomationEnvelope(
        [{
          param,
          valueToAudioValue: (value) => (
            parameterId === 'filter.frequency'
              ? getSynthFilterCutoff(value, pitch, params.filter.keyTracking, ctx.sampleRate)
              : parameterId === 'lfo.filterDepth' ? value * 1200
              : value
          ),
        }],
        envelope,
        {
          playheadSec: options.timelineStartSec,
          startLimitSec: options.timelineStartSec,
          endLimitSec: options.timelineStartSec + options.durationSec + params.ampEnvelope.releaseSec,
        },
        options.timelineToCtxTime,
        SYNTH_AUTOMATION_DESCRIPTORS[parameterId].defaultValue,
      )
    }
  }
  const onEnded = () => {
    endedSources += 1
    if (endedSources !== endableSources.length) return
    finalize()
  }
  for (const source of endableSources) source.onended = onEnded
  if (endableSources.length === 0) queueMicrotask(finalize)
  return handle
}
