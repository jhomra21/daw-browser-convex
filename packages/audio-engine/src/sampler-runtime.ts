import { getScheduledMidiEvents } from './audio-scheduling'
import { disconnectAudioNodes } from './effects/chain'
import { createSamplerVoicePlan, getSamplerLoopBounds, resetSamplerRoundRobin, selectSamplerZone, type SamplerRoundRobinState } from './sampler-core'
import { stopAndDisconnectSource, type SourceRegistry } from './source-registry'
import {
  normalizeSamplerParams,
  parseInstrumentAutomationKey,
  SAMPLER_AUTOMATION_DESCRIPTORS,
  valueAtAutomationTime,
  type ArpParams,
  type AutomationEnvelope,
  type SamplerAutomationParameterId,
  type SamplerParams,
  type SamplerZone,
} from '@daw-browser/shared'
import { scheduleAutomationEnvelope } from './automation'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

export type SamplerResolvedBuffers = ReadonlyMap<string, AudioBuffer>
export type SamplerNoteMiss = {
  trackId: string
  zoneId: string
  assetKey: string
  url: string
}

type Options = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getBpm: () => number
  timelineToCtxTime: (timelineSec: number) => number
  ensureTrackInput: (trackId: string) => GainNode
  sources: SourceRegistry
  getArpeggiator: (trackId: string) => ArpParams | undefined
  onNoteMiss: (miss: SamplerNoteMiss) => void
  onAssetUse: (assetKey: string, active: boolean) => void
  getAutomationEnvelopes: () => readonly AutomationEnvelope[]
}

type Config = { instanceId: string; params: SamplerParams; buffers: SamplerResolvedBuffers; roundRobin: SamplerRoundRobinState }
type Voice = { id: number; clipId?: string; note: number; chokeGroup: number; assetKey: string; source: AudioBufferSourceNode; sources: AudioBufferSourceNode[]; nodes: AudioNode[]; gain: GainNode; removed: boolean }
const EMPTY_BUFFERS: SamplerResolvedBuffers = new Map()
const SAMPLER_TERMINATION_FADE_SEC = 0.006

export function scheduleSamplerVoice(input: {
  ctx: BaseAudioContext
  destination: AudioNode
  buffer: AudioBuffer
  zone: SamplerZone
  params: SamplerParams
  note: number
  velocity: number
  when: number
  durationSec: number
  timelineStartSec?: number
  automationEnvelopes?: readonly AutomationEnvelope[]
  timelineToCtxTime?: (timelineSec: number) => number
}) {
  const noteValue = (parameterId: SamplerAutomationParameterId, fallback: number) => {
    const envelope = input.automationEnvelopes?.find((candidate) => parseInstrumentAutomationKey(candidate.parameterId)?.parameterId === parameterId)
    return envelope && input.timelineStartSec !== undefined
      ? valueAtAutomationTime(envelope.points, input.timelineStartSec, fallback)
      : fallback
  }
  const params = normalizeSamplerParams({
    ...input.params,
    ampEnvelope: {
      ...input.params.ampEnvelope,
      attackSec: noteValue('amp.attack', input.params.ampEnvelope.attackSec),
      decaySec: noteValue('amp.decay', input.params.ampEnvelope.decaySec),
      sustain: noteValue('amp.sustain', input.params.ampEnvelope.sustain),
      releaseSec: noteValue('amp.release', input.params.ampEnvelope.releaseSec),
    },
    filterEnvelope: {
      ...input.params.filterEnvelope,
      amount: noteValue('filter.envAmount', input.params.filterEnvelope.amount),
    },
  })
  const plan = createSamplerVoicePlan({ ...input, params })
  const loop = getSamplerLoopBounds(input.zone)
  const filter = input.ctx.createBiquadFilter()
  filter.type = params.filterMode
  filter.frequency.setValueAtTime(plan.filterBaseHz, input.when)
  filter.Q.setValueAtTime(params.filterQ, input.when)
  const pan = input.ctx.createStereoPanner()
  pan.pan.setValueAtTime(input.zone.pan, input.when)
  const outputPan = input.ctx.createStereoPanner()
  outputPan.pan.setValueAtTime(0, input.when)
  const gain = input.ctx.createGain()
  const outputGain = input.ctx.createGain()
  outputGain.gain.setValueAtTime(1, input.when)
  gain.gain.setValueAtTime(0, plan.ampEnvelope.startTime)
  gain.gain.linearRampToValueAtTime(plan.peakGain, plan.ampEnvelope.attackEnd)
  gain.gain.linearRampToValueAtTime(plan.peakGain * plan.ampEnvelope.sustain, plan.ampEnvelope.decayEnd)
  gain.gain.setValueAtTime(plan.peakGain * plan.ampEnvelope.sustain, plan.ampEnvelope.releaseTime)
  gain.gain.linearRampToValueAtTime(0, plan.ampEnvelope.endTime)
  filter.frequency.linearRampToValueAtTime(plan.filterPeakHz, plan.filterEnvelope.attackEnd)
  filter.frequency.linearRampToValueAtTime(plan.filterBaseHz, plan.filterEnvelope.decayEnd)
  const sources: AudioBufferSourceNode[] = []
  const nodes: AudioNode[] = [filter, pan, gain, outputPan, outputGain]
  for (const segment of plan.segments) {
    const source = input.ctx.createBufferSource()
    source.buffer = input.buffer
    source.detune.setValueAtTime(plan.detuneCents, segment.startTime)
    if (input.zone.playbackMode === 'forward-loop' && loop) {
      source.loop = true
      source.loopStart = loop.startSec
      source.loopEnd = loop.endSec
    }
    if (segment.fadeInSec > 0 || segment.fadeOutSec > 0) {
      const segmentGain = input.ctx.createGain()
      const fadeInCurve = Float32Array.from({ length: 32 }, (_, index) => Math.sin(index / 31 * Math.PI / 2))
      const fadeOutCurve = Float32Array.from({ length: 32 }, (_, index) => Math.cos(index / 31 * Math.PI / 2))
      segmentGain.gain.setValueAtTime(segment.fadeInSec > 0 ? 0 : 1, segment.startTime)
      if (segment.fadeInSec > 0) segmentGain.gain.setValueCurveAtTime(fadeInCurve, segment.startTime, segment.fadeInSec)
      if (segment.fadeOutSec > 0) segmentGain.gain.setValueCurveAtTime(fadeOutCurve, segment.startTime + segment.durationSec - segment.fadeOutSec, segment.fadeOutSec)
      source.connect(segmentGain)
      segmentGain.connect(filter)
      nodes.push(segmentGain)
    } else source.connect(filter)
    source.start(segment.startTime, segment.offsetSec)
    source.stop(Math.min(plan.endTime, segment.startTime + segment.durationSec))
    sources.push(source)
  }
  const oscillator = params.lfo.enabled ? input.ctx.createOscillator() : undefined
  const lfoDepthParams: Partial<Record<SamplerAutomationParameterId, AudioParam>> = {}
  if (params.lfo.enabled) {
    if (!oscillator) throw new Error('Sampler LFO oscillator unavailable')
    oscillator.frequency.setValueAtTime(params.lfo.frequencyHz, input.when)
    for (const [parameterId, amount, target] of [
      ['lfo.filterDepth', params.lfo.filterHz, filter.frequency],
      ['lfo.ampDepth', params.lfo.amp * plan.peakGain, gain.gain],
      ['lfo.panDepth', params.lfo.pan, pan.pan],
    ] as const) {
      const modulation = input.ctx.createGain()
      modulation.gain.setValueAtTime(amount, input.when)
      oscillator.connect(modulation)
      modulation.connect(target)
      lfoDepthParams[parameterId] = modulation.gain
      nodes.push(modulation)
    }
    for (const source of sources) {
      const modulation = input.ctx.createGain()
      modulation.gain.setValueAtTime(params.lfo.pitchCents, input.when)
      oscillator.connect(modulation)
      modulation.connect(source.detune)
      lfoDepthParams['lfo.pitchDepth'] = modulation.gain
      nodes.push(modulation)
    }
    oscillator.start(input.when)
    oscillator.stop(plan.endTime)
    nodes.push(oscillator)
  }
  filter.connect(pan)
  pan.connect(gain)
  gain.connect(outputPan)
  outputPan.connect(outputGain)
  outputGain.connect(input.destination)
  if (input.timelineStartSec !== undefined && input.timelineToCtxTime) {
    const directBindings: Partial<Record<SamplerAutomationParameterId, AudioParam>> = {
      'output.gain': outputGain.gain,
      'output.pan': outputPan.pan,
      'filter.frequency': filter.frequency,
      'filter.q': filter.Q,
      'lfo.rate': oscillator?.frequency,
      ...lfoDepthParams,
    }
    for (const envelope of input.automationEnvelopes ?? []) {
      const key = parseInstrumentAutomationKey(envelope.parameterId)
      const param = key ? directBindings[key.parameterId] : undefined
      if (!key || !param || !envelope.enabled) continue
      scheduleAutomationEnvelope(
        [{ param, valueToAudioValue: (value) => key.parameterId === 'lfo.ampDepth' ? value * plan.peakGain : value }],
        envelope,
        {
          playheadSec: input.timelineStartSec,
          startLimitSec: input.timelineStartSec,
          endLimitSec: input.timelineStartSec + input.durationSec + params.ampEnvelope.releaseSec,
        },
        input.timelineToCtxTime,
        SAMPLER_AUTOMATION_DESCRIPTORS[key.parameterId].defaultValue,
      )
    }
  }
  const source = sources[sources.length - 1]
  if (!source) throw new Error('Sampler voice has no playable segment')
  return { source, sources, gain, nodes }
}

export function createSamplerRuntime(options: Options) {
  const configs = new Map<string, Config>()
  const voices = new Map<string, Voice[]>()
  let voiceId = 0

  const remove = (trackId: string, voice: Voice) => {
    if (voice.removed) return
    voice.removed = true
    const active = voices.get(trackId)?.filter((candidate) => candidate !== voice) ?? []
    if (active.length) voices.set(trackId, active)
    else voices.delete(trackId)
    if (voice.clipId) options.sources.remove(voice.clipId, voice.source)
    options.onAssetUse(voice.assetKey, false)
    disconnectAudioNodes(voice.nodes)
  }
  const stop = (trackId: string, voice: Voice, when?: number) => {
    voice.source.onended = null
    for (const source of voice.sources) stopAndDisconnectSource(source, when)
    remove(trackId, voice)
  }
  const terminateMatching = (trackId: string, when: number, predicate: (voice: Voice) => boolean) => {
    // oxlint-disable-next-line unicorn/no-useless-spread -- stopping a voice removes it from this collection.
    for (const voice of [...(voices.get(trackId) ?? [])]) {
      if (!predicate(voice)) continue
      voice.gain.gain.cancelScheduledValues(when)
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, when)
      voice.gain.gain.linearRampToValueAtTime(0, when + SAMPLER_TERMINATION_FADE_SEC)
      try {
        for (const source of voice.sources) source.stop(when + SAMPLER_TERMINATION_FADE_SEC)
      } catch {
        stop(trackId, voice)
      }
    }
  }
  const trigger = (trackId: string, note: number, velocity: number, when: number, durationSec: number, clipId?: string, timelineStartSec?: number) => {
    const config = configs.get(trackId)
    const ctx = options.getAudioContext()
    if (!config || !ctx) return false
    const selected = selectSamplerZone(config.params.zones, note, Math.round(velocity * 127), config.roundRobin)
    config.roundRobin = selected.roundRobin
    const zone = selected.zone
    const buffer = zone ? config.buffers.get(zone.id) : undefined
    if (!zone) return false
    if (!buffer) {
      options.onNoteMiss({ trackId, zoneId: zone.id, assetKey: zone.sample.assetKey, url: zone.sample.url })
      return false
    }
    if (config.params.retrigger) terminateMatching(trackId, when, (voice) => voice.note === note)
    if (zone.chokeGroup > 0) terminateMatching(trackId, when, (voice) => voice.chokeGroup === zone.chokeGroup)
    const active = voices.get(trackId) ?? []
    if (active.length >= config.params.polyphony) terminateMatching(trackId, when, (voice) => voice.id === active[0]?.id)
    const automationEnvelopes = options.getAutomationEnvelopes().filter((envelope) => {
      const key = parseInstrumentAutomationKey(envelope.parameterId)
      return key?.trackId === trackId && key.instanceId === config.instanceId
    })
    const scheduled = scheduleSamplerVoice({
      ctx,
      destination: options.ensureTrackInput(trackId),
      buffer,
      zone,
      params: config.params,
      note,
      velocity: Math.round(velocity * 127),
      when,
      durationSec,
      timelineStartSec,
      automationEnvelopes,
      timelineToCtxTime: timelineStartSec === undefined
        ? options.timelineToCtxTime
        : (timelineSec) => when + (timelineSec - timelineStartSec),
    })
    options.onAssetUse(zone.sample.assetKey, true)
    const voice: Voice = { ...scheduled, id: voiceId++, note, chokeGroup: zone.chokeGroup, assetKey: zone.sample.assetKey, clipId, removed: false }
    voices.set(trackId, [...(voices.get(trackId) ?? []), voice])
    scheduled.source.onended = () => remove(trackId, voice)
    if (clipId) options.sources.add(clipId, scheduled.source)
    return true
  }
  const disposeTrack = (trackId: string) => {
    // oxlint-disable-next-line unicorn/no-useless-spread -- stopping a voice removes it from this collection.
    for (const voice of [...(voices.get(trackId) ?? [])]) stop(trackId, voice)
    configs.delete(trackId)
  }

  return {
    setTrackSampler: (trackId: string, instanceId: string | undefined, params: SamplerParams, buffers?: SamplerResolvedBuffers) => {
      const current = configs.get(trackId)
      configs.set(trackId, { instanceId: instanceId ?? current?.instanceId ?? '', params: normalizeSamplerParams(params), buffers: buffers ?? current?.buffers ?? EMPTY_BUFFERS, roundRobin: resetSamplerRoundRobin() })
    },
    scheduleMidiClip: (track: Track<AudioBuffer>, clip: Clip<AudioBuffer>, playheadSec: number, nowCtx: number, endLimitSec?: number) => {
      if (!clip.midi) return false
      const events = getScheduledMidiEvents({ clip, bpm: options.getBpm(), notes: clip.midi.notes, rangeStartSec: playheadSec, rangeEndSec: endLimitSec, arp: options.getArpeggiator(track.id) })
      let scheduled = false
      for (const event of events) scheduled = trigger(track.id, event.pitch, event.velocity ?? 1, Math.max(nowCtx, options.timelineToCtxTime(event.startSec)), event.endSec - event.startSec, clip.id, event.startSec) || scheduled
      return scheduled
    },
    previewNote: (trackId: string, note: number, velocity: number) => {
      options.ensureAudio()
      const ctx = options.getAudioContext()
      return ctx ? trigger(trackId, note, velocity, ctx.currentTime, 0.5) : false
    },
    stopClip: (clipId: string) => {
      for (const [trackId, active] of voices) {
        // oxlint-disable-next-line unicorn/no-useless-spread -- stopping a voice mutates the active collection.
        for (const voice of [...active]) if (voice.clipId === clipId) stop(trackId, voice)
      }
    },
    stopAll: () => {
      for (const [trackId, active] of voices) {
        // oxlint-disable-next-line unicorn/no-useless-spread -- stopping a voice mutates the active collection.
        for (const voice of [...active]) stop(trackId, voice)
      }
    },
    disposeTrack,
    clear: () => {
      // oxlint-disable-next-line unicorn/no-useless-spread -- disposing a track removes its config.
      for (const trackId of [...configs.keys()]) disposeTrack(trackId)
      configs.clear()
    },
  }
}
