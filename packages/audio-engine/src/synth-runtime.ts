import { getScheduledMidiEvents } from './audio-scheduling'
import { createSynthOutputChain, getSynthFilterCutoff, scheduleSynthVoice, type SynthAutomationEnvelopes, type SynthVoiceHandle } from './synth-voice'
import { chooseSynthVoiceVictim, isSynthVoiceSoundingAt } from './synth-voice-allocation'
import {
  createDefaultSynthParams,
  normalizeSynthParams,
  parseSynthAutomationKey,
  type ArpParams,
  type AutomationEnvelope,
  type SynthParams,
  type SynthParamsInput,
  type SynthAutomationParameterId,
} from '@daw-browser/shared'
import type { AutomationAudioBinding } from './automation'
import type { SourceRegistry } from './source-registry'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

type TrackSynthRuntimeState = {
  generation: number
  instanceId?: string
  params: SynthParams
  output: GainNode
  outputPan: StereoPannerNode
  voices: SynthVoiceHandle[]
  allocation: SynthVoiceHandle[]
  liveVoiceRefs: Map<number, number>
  nextVoiceId: number
}

type SynthRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getBpm: () => number
  timelineToCtxTime: (timelineSec: number) => number
  ensureTrackInput: (trackId: string) => GainNode
  sources: SourceRegistry
  getArpeggiator?: (trackId: string) => ArpParams | undefined
  getAutomationEnvelopes?: () => readonly AutomationEnvelope[]
}

const synthParamsEqual = (left: SynthParams, right: SynthParams) => left === right || (
  left.gain === right.gain
  && left.pan === right.pan
  && left.oscillators[0].level === right.oscillators[0].level
  && left.oscillators[0].enabled === right.oscillators[0].enabled
  && left.oscillators[0].wave === right.oscillators[0].wave
  && left.oscillators[0].octave === right.oscillators[0].octave
  && left.oscillators[0].semitone === right.oscillators[0].semitone
  && left.oscillators[0].detuneCents === right.oscillators[0].detuneCents
  && left.oscillators[1].level === right.oscillators[1].level
  && left.oscillators[1].enabled === right.oscillators[1].enabled
  && left.oscillators[1].wave === right.oscillators[1].wave
  && left.oscillators[1].octave === right.oscillators[1].octave
  && left.oscillators[1].semitone === right.oscillators[1].semitone
  && left.oscillators[1].detuneCents === right.oscillators[1].detuneCents
  && left.noise.enabled === right.noise.enabled
  && left.noise.level === right.noise.level
  && left.filter.enabled === right.filter.enabled
  && left.filter.mode === right.filter.mode
  && left.filter.frequencyHz === right.filter.frequencyHz
  && left.filter.q === right.filter.q
  && left.filter.keyTracking === right.filter.keyTracking
  && left.filter.envelopeAmountOctaves === right.filter.envelopeAmountOctaves
  && left.ampEnvelope.attackSec === right.ampEnvelope.attackSec
  && left.ampEnvelope.decaySec === right.ampEnvelope.decaySec
  && left.ampEnvelope.sustain === right.ampEnvelope.sustain
  && left.ampEnvelope.releaseSec === right.ampEnvelope.releaseSec
  && left.filter.envelope.attackSec === right.filter.envelope.attackSec
  && left.filter.envelope.decaySec === right.filter.envelope.decaySec
  && left.filter.envelope.sustain === right.filter.envelope.sustain
  && left.filter.envelope.releaseSec === right.filter.envelope.releaseSec
  && left.lfo.enabled === right.lfo.enabled
  && left.lfo.wave === right.lfo.wave
  && left.lfo.frequencyHz === right.lfo.frequencyHz
  && left.lfo.pitchCents === right.lfo.pitchCents
  && left.lfo.filterOctaves === right.lfo.filterOctaves
  && left.lfo.amp === right.lfo.amp
  && left.lfo.pan === right.lfo.pan
  && left.polyphony === right.polyphony
  && left.retrigger === right.retrigger
)

export function createSynthRuntime(options: SynthRuntimeOptions) {
  const states = new Map<string, TrackSynthRuntimeState>()
  let nextStateGeneration = 1
  const smooth = (param: AudioParam | undefined, value: number, now: number) => {
    if (!param) return
    param.cancelScheduledValues(now)
    param.setTargetAtTime(value, now, 0.01)
  }
  const ensureState = (trackId: string): TrackSynthRuntimeState | undefined => {
    options.ensureAudio()
    const ctx = options.getAudioContext()
    if (!ctx) return undefined
    let state = states.get(trackId)
    if (!state) {
      const params = createDefaultSynthParams()
      const { output, outputPan } = createSynthOutputChain(ctx, options.ensureTrackInput(trackId), params.gain, params.pan, ctx.currentTime)
      state = {
        generation: nextStateGeneration++,
        params,
        output,
        outputPan,
        voices: [],
        allocation: [],
        liveVoiceRefs: new Map(),
        nextVoiceId: 1,
      }
      states.set(trackId, state)
    }
    return state
  }
  const enforcePolyphony = (state: TrackSynthRuntimeState, now: number) => {
    const allocated = state.allocation
      .filter((voice) => voice.effectiveEndTime > now)
      .toSorted((left, right) => (
        left.scheduledStartTime - right.scheduledStartTime || left.id - right.id
      ))
    const current = allocated.filter((voice) => voice.scheduledStartTime <= now)
    while (true) {
      const victim = chooseSynthVoiceVictim(current, state.params.polyphony + 1, now)
      if (!victim) break
      victim.stop(now)
      current.splice(current.indexOf(victim), 1)
    }
    for (const voice of allocated) {
      if (voice.scheduledStartTime <= now || voice.effectiveEndTime <= voice.scheduledStartTime) continue
      const victim = chooseSynthVoiceVictim(current, state.params.polyphony, voice.scheduledStartTime)
      if (victim) {
        victim.stop(voice.scheduledStartTime)
        current.splice(current.indexOf(victim), 1)
      }
      current.push(voice)
    }
    state.allocation = current
  }
  const removeVoice = (trackId: string, expectedState: TrackSynthRuntimeState, voice: SynthVoiceHandle) => {
    const state = states.get(trackId)
    if (state !== expectedState) return
    state.voices = state.voices.filter((candidate) => candidate !== voice)
    state.allocation = state.allocation.filter((candidate) => candidate !== voice)
    state.liveVoiceRefs.delete(voice.noteInstanceId)
    if (voice.clipId) for (const source of voice.sources) options.sources.remove(voice.clipId, source)
  }
  const triggerNote = (input: {
    trackId: string
    pitch: number
    velocity?: number
    clipGain?: number
    when: number
    durationSec: number
    clipId?: string
    timelineStartSec?: number
    automationEnvelopes?: SynthAutomationEnvelopes
    scheduleVoiceAutomation?: boolean
    deferPolyphonyEnforcement?: boolean
    live?: boolean
  }): number | undefined => {
    if (
      !Number.isFinite(input.pitch)
      || !Number.isInteger(input.pitch)
      || input.pitch < 0
      || input.pitch > 127
      || input.velocity !== undefined && (!Number.isFinite(input.velocity) || input.velocity < 0 || input.velocity > 1)
      || !Number.isFinite(input.when)
      || !Number.isFinite(input.durationSec)
      || input.durationSec <= 0
    ) return undefined
    const state = ensureState(input.trackId)
    const ctx = options.getAudioContext()
    if (!state || !ctx) return undefined
    if (input.live && !state.params.retrigger) {
      const legato = state.voices.find((voice) => (
        state.liveVoiceRefs.has(voice.noteInstanceId)
        && voice.pitch === input.pitch
        && isSynthVoiceSoundingAt(voice, input.when)
      ))
      if (legato) {
        state.liveVoiceRefs.set(legato.noteInstanceId, (state.liveVoiceRefs.get(legato.noteInstanceId) ?? 0) + 1)
        return legato.noteInstanceId
      }
    }
    const noteInstanceId = state.nextVoiceId
    state.nextVoiceId += 1
    const voice = scheduleSynthVoice(ctx, {
      id: noteInstanceId,
      noteInstanceId,
      pitch: input.pitch,
      velocity: input.velocity,
      clipGain: input.clipGain,
      when: input.when,
      durationSec: input.durationSec,
      clipId: input.clipId,
      seedKey: input.trackId,
      params: state.params,
      destination: state.outputPan,
      timelineStartSec: input.timelineStartSec,
      timelineToCtxTime: input.timelineStartSec === undefined
        ? undefined
        : ((timelineStartSec) => (timelineSec: number) => input.when + (timelineSec - timelineStartSec))(input.timelineStartSec),
      automationEnvelopes: input.automationEnvelopes ?? getTrackAutomationEnvelopes(input.trackId, state.instanceId),
      scheduleVoiceAutomation: input.scheduleVoiceAutomation,
      onEnded: (ended) => removeVoice(input.trackId, state, ended),
    })
    state.voices.push(voice)
    state.allocation.push(voice)
    if (input.live) state.liveVoiceRefs.set(voice.noteInstanceId, 1)
    if (!input.deferPolyphonyEnforcement) enforcePolyphony(state, ctx.currentTime)
    if (input.clipId) for (const source of voice.sources) options.sources.add(input.clipId, source)
    return noteInstanceId
  }
  const stopVoice = (voice: SynthVoiceHandle, when: number) => voice.stop(when)
  const getTrackAutomationEnvelopes = (trackId: string, instanceId: string | undefined): SynthAutomationEnvelopes => {
    const envelopes = new Map<SynthAutomationParameterId, AutomationEnvelope>()
    for (const envelope of options.getAutomationEnvelopes?.() ?? []) {
      const key = parseSynthAutomationKey(envelope.parameterId)
      if (envelope.enabled && key?.trackId === trackId && key.instanceId === instanceId) envelopes.set(key.parameterId, envelope)
    }
    return envelopes
  }
  const disposeTrack = (trackId: string) => {
    const state = states.get(trackId)
    if (state) {
      for (const voice of state.voices) stopVoice(voice, 0)
      try { state.output.disconnect() } catch {}
      try { state.outputPan.disconnect() } catch {}
    }
    states.delete(trackId)
  }
  const stopClip = (clipId: string) => {
    const now = options.getAudioContext()?.currentTime ?? 0
    for (const state of states.values()) {
      for (const voice of state.voices) {
        if (voice.clipId === clipId) {
          voice.stop(now)
          for (const source of voice.sources) options.sources.remove(clipId, source)
        }
      }
    }
  }
  const stopAll = () => {
    const now = options.getAudioContext()?.currentTime ?? 0
    for (const state of states.values()) {
      for (const voice of state.voices) {
        voice.stop(now)
        if (voice.clipId) for (const source of voice.sources) options.sources.remove(voice.clipId, source)
      }
    }
  }

  return {
    setTrackSynth: (trackId: string, params: SynthParamsInput, instanceId?: string) => {
      const state = ensureState(trackId)
      if (!state) return
      const nextParams = normalizeSynthParams(params)
      const previousParams = state.params
      if (synthParamsEqual(previousParams, nextParams)) {
        state.instanceId = instanceId ?? state.instanceId
        state.params = nextParams
        return
      }
      state.params = nextParams
      state.instanceId = instanceId ?? state.instanceId
      const now = options.getAudioContext()?.currentTime ?? 0
      if (previousParams.gain !== nextParams.gain) smooth(state.output.gain, nextParams.gain, now)
      if (previousParams.pan !== nextParams.pan) smooth(state.outputPan.pan, nextParams.pan, now)
      const envelopesChanged = (
        previousParams.ampEnvelope.attackSec !== nextParams.ampEnvelope.attackSec
        || previousParams.ampEnvelope.decaySec !== nextParams.ampEnvelope.decaySec
        || previousParams.ampEnvelope.sustain !== nextParams.ampEnvelope.sustain
        || previousParams.ampEnvelope.releaseSec !== nextParams.ampEnvelope.releaseSec
        || previousParams.filter.envelopeAmountOctaves !== nextParams.filter.envelopeAmountOctaves
        || previousParams.filter.envelope.attackSec !== nextParams.filter.envelope.attackSec
        || previousParams.filter.envelope.decaySec !== nextParams.filter.envelope.decaySec
        || previousParams.filter.envelope.sustain !== nextParams.filter.envelope.sustain
        || previousParams.filter.envelope.releaseSec !== nextParams.filter.envelope.releaseSec
      )
      const lfoWasEnabled = previousParams.lfo.enabled
      for (const voice of state.voices) {
        const filterEnabled = nextParams.filter.enabled
        if (previousParams.filter.enabled !== filterEnabled || previousParams.filter.mode !== nextParams.filter.mode) {
          voice.filter.type = filterEnabled ? nextParams.filter.mode : 'allpass'
        }
        if (
          previousParams.filter.enabled !== filterEnabled
          || previousParams.filter.frequencyHz !== nextParams.filter.frequencyHz
          || previousParams.filter.keyTracking !== nextParams.filter.keyTracking
        ) {
          smooth(
            voice.bindings.filterFrequency,
            filterEnabled
              ? getSynthFilterCutoff(nextParams.filter.frequencyHz, voice.pitch, nextParams.filter.keyTracking, options.getAudioContext()?.sampleRate ?? 44_100)
              : getSynthFilterCutoff(20_000, voice.pitch, 0, options.getAudioContext()?.sampleRate ?? 44_100),
            now,
          )
        }
        if (previousParams.filter.enabled !== filterEnabled || previousParams.filter.q !== nextParams.filter.q) {
          smooth(voice.bindings.filterQ, filterEnabled ? nextParams.filter.q : 0.0001, now)
        }
        for (const index of [0, 1] as const) {
          if (previousParams.oscillators[index].enabled !== nextParams.oscillators[index].enabled) {
            smooth(voice.bindings.oscillatorGates[index], nextParams.oscillators[index].enabled ? 1 : 0, now)
          }
          if (previousParams.oscillators[index].level !== nextParams.oscillators[index].level) {
            smooth(voice.bindings.oscillatorLevels[index], nextParams.oscillators[index].level, now)
          }
          if (previousParams.oscillators[index].detuneCents !== nextParams.oscillators[index].detuneCents) {
            smooth(voice.bindings.oscillatorDetunes[index], nextParams.oscillators[index].detuneCents, now)
          }
        }
        if (previousParams.noise.enabled !== nextParams.noise.enabled) {
          smooth(voice.bindings.noiseGate, nextParams.noise.enabled ? 1 : 0, now)
        }
        if (previousParams.noise.level !== nextParams.noise.level) {
          smooth(voice.bindings.noiseLevel, nextParams.noise.level, now)
        }
        if (previousParams.lfo.enabled !== nextParams.lfo.enabled || previousParams.lfo.frequencyHz !== nextParams.lfo.frequencyHz) {
          smooth(voice.bindings.lfoRate, nextParams.lfo.frequencyHz, now)
        }
        const lfoEnabled = nextParams.lfo.enabled
        if (previousParams.lfo.enabled !== lfoEnabled || previousParams.lfo.pitchCents !== nextParams.lfo.pitchCents) smooth(voice.bindings.lfoDepths.pitch, lfoEnabled ? nextParams.lfo.pitchCents : 0, now)
        if (previousParams.lfo.enabled !== lfoEnabled || previousParams.lfo.filterOctaves !== nextParams.lfo.filterOctaves) smooth(voice.bindings.lfoDepths.filter, lfoEnabled ? nextParams.lfo.filterOctaves * 1200 : 0, now)
        if (previousParams.lfo.enabled !== lfoEnabled || previousParams.lfo.amp !== nextParams.lfo.amp) smooth(voice.bindings.lfoDepths.amp, lfoEnabled ? nextParams.lfo.amp : 0, now)
        if (previousParams.lfo.enabled !== lfoEnabled || previousParams.lfo.pan !== nextParams.lfo.pan) smooth(voice.bindings.lfoDepths.pan, lfoEnabled ? nextParams.lfo.pan : 0, now)
        if (envelopesChanged) {
          voice.retargetEnvelopes(
            now,
            nextParams.ampEnvelope,
            nextParams.filter.envelope,
            nextParams.filter.enabled ? nextParams.filter.envelopeAmountOctaves : 0,
          )
        }
        if (!lfoWasEnabled && lfoEnabled) {
          voice.rescheduleLfoAutomation(getTrackAutomationEnvelopes(trackId, state.instanceId), now)
        }
      }
      enforcePolyphony(state, now)
    },
    clearTrackSynth: (trackId: string) => {
      disposeTrack(trackId)
    },
    triggerNote,
    getLiveVoiceGeneration: (trackId: string) => states.get(trackId)?.generation,
    previewNote: (trackId: string, pitch: number, velocity = 0.9, durationSec = 0.5) => {
      const ctx = options.getAudioContext()
      return ctx ? triggerNote({ trackId, pitch, velocity, when: ctx.currentTime, durationSec }) : undefined
    },
    startPreviewNote: (trackId: string, pitch: number, velocity = 0.9) => {
      const ctx = options.getAudioContext()
      return ctx ? triggerNote({ trackId, pitch, velocity, when: ctx.currentTime, durationSec: 86_400, live: true }) : undefined
    },
    resolveAutomationBindings: (trackId: string, parameterId: string): AutomationAudioBinding[] => {
      const state = states.get(trackId)
      const key = parseSynthAutomationKey(parameterId)
      if (!state || !key || key.instanceId !== state.instanceId) return []
      if (key.parameterId === 'output.gain') return [{ param: state.output.gain, valueToAudioValue: (value) => value }]
      if (key.parameterId === 'output.pan') return [{ param: state.outputPan.pan, valueToAudioValue: (value) => value }]
      if (!state.params.lfo.enabled && key.parameterId.startsWith('lfo.')) return []
      const sampleRate = options.getAudioContext()?.sampleRate ?? 44_100
      return state.voices.flatMap((voice): AutomationAudioBinding[] => {
        const binding = key.parameterId === 'osc1.level'
          ? voice.bindings.oscillatorLevels[0]
          : key.parameterId === 'osc1.detune'
            ? voice.bindings.oscillatorDetunes[0]
            : key.parameterId === 'osc2.level'
              ? voice.bindings.oscillatorLevels[1]
              : key.parameterId === 'osc2.detune'
                ? voice.bindings.oscillatorDetunes[1]
                : key.parameterId === 'noise.level'
                  ? voice.bindings.noiseLevel
                : key.parameterId === 'filter.frequency'
                  ? voice.bindings.filterFrequency
                  : key.parameterId === 'filter.q'
                    ? voice.bindings.filterQ
                    : key.parameterId === 'lfo.rate'
                      ? voice.bindings.lfoRate
                      : key.parameterId === 'lfo.pitchDepth'
                        ? voice.bindings.lfoDepths.pitch
                        : key.parameterId === 'lfo.filterDepth'
                          ? voice.bindings.lfoDepths.filter
                          : key.parameterId === 'lfo.ampDepth'
                            ? voice.bindings.lfoDepths.amp
                            : key.parameterId === 'lfo.panDepth'
                              ? voice.bindings.lfoDepths.pan
                              : undefined
        if (!binding) return []
        return [{
          param: binding,
          valueToAudioValue: (value) => (
            key.parameterId === 'filter.frequency'
              ? getSynthFilterCutoff(value, voice.pitch, state.params.filter.keyTracking, sampleRate)
              : key.parameterId === 'lfo.filterDepth'
                ? value * 1200
                : value
          ),
        }]
      })
    },
    releasePreviewNote: (
      trackId: string,
      noteInstanceId: number,
      requestedWhen?: number,
      force = false,
      generation?: number,
    ) => {
      const state = states.get(trackId)
      if (generation !== undefined && state?.generation !== generation) return
      const voice = state?.voices.find((candidate) => candidate.noteInstanceId === noteInstanceId)
      const now = options.getAudioContext()?.currentTime
      const when = now === undefined ? undefined : Math.max(now, requestedWhen ?? now)
      if (!voice || when === undefined) return
      if (force) {
        state?.liveVoiceRefs.delete(noteInstanceId)
        voice.stop(when)
        return
      }
      const refs = state?.liveVoiceRefs.get(noteInstanceId)
      if (refs !== undefined && refs > 1) {
        state?.liveVoiceRefs.set(noteInstanceId, refs - 1)
        return
      }
      state?.liveVoiceRefs.delete(noteInstanceId)
      voice.release(when)
    },
    scheduleMidiClip: (
      track: RuntimeTrack,
      clip: RuntimeClip,
      playheadSec: number,
      nowCtx: number,
      endLimitSec?: number,
      scheduleOptions?: { scheduleVoiceAutomation?: boolean },
    ): boolean => {
      const ctx = options.getAudioContext()
      if (!ctx) return false
      const midi = clip.midi
      if (!midi || !Array.isArray(midi.notes)) return false

      const scheduledNotes = getScheduledMidiEvents({
        clip,
        bpm: options.getBpm(),
        notes: midi.notes,
        rangeStartSec: playheadSec,
        rangeEndSec: endLimitSec,
        arp: options.getArpeggiator?.(track.id),
      })
      const state = states.get(track.id)
      const automationEnvelopes = state ? getTrackAutomationEnvelopes(track.id, state.instanceId) : new Map()
      for (const note of scheduledNotes.toSorted((left, right) => left.startSec - right.startSec)) {
        const durationSec = note.endSec - note.startSec
        if (durationSec <= 0) continue
        triggerNote({
          trackId: track.id,
          pitch: note.pitch,
          velocity: note.velocity,
          clipGain: midi.gain,
          when: Math.max(nowCtx, options.timelineToCtxTime(note.startSec)),
          durationSec,
          clipId: clip.id,
          timelineStartSec: note.startSec,
          automationEnvelopes,
          scheduleVoiceAutomation: scheduleOptions?.scheduleVoiceAutomation,
          deferPolyphonyEnforcement: true,
        })
      }
      if (state) enforcePolyphony(state, ctx.currentTime)

      return true
    },
    stopClip,
    stopAll,
    disposeTrack,
    clear: () => {
      for (const trackId of states.keys()) disposeTrack(trackId)
    },
  }
}
