import type { getScheduledMidiEvents } from './audio-scheduling'
import { type AutomationEnvelope, type DrumRackParams, normalizeSynthParams, type SynthParamsInput, type SynthAutomationParameterId, type TrackInstrumentParams, parseInstrumentAutomationKey, parseSynthAutomationKey, SYNTH_AUTOMATION_DESCRIPTORS } from '@daw-browser/shared'
import { createSynthOutputChain, scheduleSynthVoice, type SynthVoiceHandle } from './synth-voice'
import { chooseSynthVoiceVictim, isSynthVoiceSoundingAt, pruneSynthVoiceAllocations } from './synth-voice-allocation'
import { DRUM_RACK_CHOKE_FADE_SEC, scheduleDrumRackHit, type DrumRackResolvedBuffers } from './drum-rack-runtime'
import { scheduleSamplerVoice, type SamplerResolvedBuffers } from './sampler-runtime'
import { resetSamplerRoundRobin, selectSamplerZone } from './sampler-core'
import { createGranularRuntime, type GranularInstalledBuffer } from './granular-runtime'
import { scheduleAutomationEnvelope } from './automation'
import type { ResourceObserver } from './runtime-diagnostics'
import type { ExportFx } from './export-types'
import { localizeSampledInstrumentSeconds } from './sampled-instrument-region'

export type OfflineDrumRackHit = {
  source: AudioBufferSourceNode
  gain: GainNode
  chokeGroup: number
}

export const readTrackInstrument = (
  fxCfg: NonNullable<ExportFx['trackFx']>[string] | undefined,
): TrackInstrumentParams | undefined => fxCfg?.instrument

export function createOfflineSynthTrack(input: {
  ctx: OfflineAudioContext
  destination: AudioNode
  trackId: string
  rangeStartSec: number
  synth: SynthParamsInput | undefined
  automationEnvelopes: readonly AutomationEnvelope[]
}) {
  const synth = normalizeSynthParams(input.synth ?? {})

  const { output: outputGain, outputPan } = createSynthOutputChain(
    input.ctx,
    input.destination,
    synth.gain,
    synth.pan,
    0,
  )

  const outputBindings = {
    'output.gain': outputGain.gain,
    'output.pan': outputPan.pan,
  }

  for (const envelope of input.automationEnvelopes) {
    const key = parseSynthAutomationKey(envelope.parameterId)

    if (!key || !envelope.enabled) continue

    const param = key.parameterId === 'output.gain'
      ? outputBindings['output.gain']
      : key.parameterId === 'output.pan'
        ? outputBindings['output.pan']
        : undefined

    if (!param) continue
    scheduleAutomationEnvelope(
      [{ param, valueToAudioValue: (value) => value }],
      envelope,
      {
        playheadSec: input.rangeStartSec,
        startLimitSec: input.rangeStartSec,
        endLimitSec: Number.POSITIVE_INFINITY,
      },
      (timelineSec) => Math.max(0, timelineSec - input.rangeStartSec),
      SYNTH_AUTOMATION_DESCRIPTORS[key.parameterId].defaultValue,
    )
  }

  let voices: SynthVoiceHandle[] = []
  let nextId = 1
  const envelopes = new Map<SynthAutomationParameterId, AutomationEnvelope>()

  for (const envelope of input.automationEnvelopes) {
    const key = parseSynthAutomationKey(envelope.parameterId)

    if (key && envelope.enabled) envelopes.set(key.parameterId, envelope)
  }

  return {
    scheduleEvents: (
      events: readonly (ReturnType<typeof getScheduledMidiEvents>[number] & {
        clipGain: number | undefined
      })[],
    ) => {
      for (const event of events) {
        const when = Math.max(0, event.startSec - input.rangeStartSec)
        const noteDur = event.endSec - event.startSec

        if (noteDur <= 0) continue
        voices = pruneSynthVoiceAllocations(voices, when)

        if (!synth.retrigger && voices.some((voice) => voice.pitch === event.pitch && isSynthVoiceSoundingAt(voice, when))) continue
        const victim = chooseSynthVoiceVictim(voices, synth.polyphony, when)

        if (victim) {
          voices = voices.filter((voice) => voice !== victim)
          victim.stop(when)
        }

        const id = nextId
        nextId += 1
        voices.push(scheduleSynthVoice(input.ctx, {
          id,
          noteInstanceId: id,
          pitch: event.pitch,
          velocity: event.velocity,
          clipGain: event.clipGain,
          when,
          durationSec: noteDur,
          seedKey: input.trackId,
          params: synth,
          destination: outputPan,
          timelineStartSec: event.startSec,
          timelineToCtxTime: (timelineSec) => Math.max(0, timelineSec - input.rangeStartSec),
          automationEnvelopes: envelopes,
          onEnded: (ended) => {
            const index = voices.indexOf(ended)

            if (index >= 0) voices.splice(index, 1)
          },
        }))
      }
    }
  }
}

export function renderOfflineDrumRackEvents(input: {
  ctx: OfflineAudioContext
  destination: AudioNode
  events: ReturnType<typeof getScheduledMidiEvents>
  padsByNote: ReadonlyMap<number, DrumRackParams['pads'][number]>
  rangeStartSec: number
  buffers: DrumRackResolvedBuffers | undefined
  activeHitsByChokeGroup: Map<number, OfflineDrumRackHit[]>
}) {
  if (!input.buffers) return

  for (const event of input.events) {
    const pad = input.padsByNote.get(event.pitch)

    if (!pad) continue
    const resolved = input.buffers.get(pad.id)

    if (!resolved) continue
    const sampled = resolved
    const sampleRate = pad.sample?.source.sampleRate ?? sampled.buffer.sampleRate

    const localPad = {
      ...pad,
      startSec: localizeSampledInstrumentSeconds(pad.startSec, sampled.sourceStartFrame, sampleRate),
      endSec: pad.endSec === undefined
        ? sampled.buffer.length / sampled.buffer.sampleRate
        : localizeSampledInstrumentSeconds(pad.endSec, sampled.sourceStartFrame, sampleRate),
    }

    const when = Math.max(0, event.startSec - input.rangeStartSec)

    if (pad.chokeGroup > 0) {
      const activeHits = input.activeHitsByChokeGroup.get(pad.chokeGroup)

      if (activeHits) {
        for (const hit of activeHits) {
          try {
            hit.gain.gain.cancelScheduledValues(when)
            hit.gain.gain.linearRampToValueAtTime(0, when + DRUM_RACK_CHOKE_FADE_SEC)
            hit.source.stop(when + DRUM_RACK_CHOKE_FADE_SEC)
          } catch {}
        }
      }

      input.activeHitsByChokeGroup.set(pad.chokeGroup, [])
    }

    try {
      const scheduled = scheduleDrumRackHit({
        ctx: input.ctx,
        destination: input.destination,
        buffer: sampled.buffer,
        pad: localPad,
        when,
        velocity: event.velocity ?? 1,
      })

      if (scheduled && pad.chokeGroup > 0) {
        const activeHits = input.activeHitsByChokeGroup.get(pad.chokeGroup) ?? []
        activeHits.push({ source: scheduled.source, gain: scheduled.gain, chokeGroup: pad.chokeGroup })
        input.activeHitsByChokeGroup.set(pad.chokeGroup, activeHits)
      }
    } catch {}
  }
}

export function renderOfflineSamplerEvents(input: {
  ctx: OfflineAudioContext
  destination: AudioNode
  events: ReturnType<typeof getScheduledMidiEvents>
  rangeStartSec: number
  instrument: Extract<TrackInstrumentParams, { kind: 'sampler' }>
  buffers: SamplerResolvedBuffers | undefined
  automationEnvelopes: readonly AutomationEnvelope[]
}) {
  if (!input.buffers) throw new Error('Sampler export requires preloaded sampler buffers.')
  let roundRobin = resetSamplerRoundRobin()

  for (const event of input.events) {
    const selected = selectSamplerZone(input.instrument.params.zones, event.pitch, Math.round((event.velocity ?? 1) * 127), roundRobin)
    roundRobin = selected.roundRobin

    if (!selected.zone) continue
    const resolved = input.buffers.get(selected.zone.id)

    if (!resolved) throw new Error(`Sampler export is missing buffer for zone "${selected.zone.id}".`)
    const sampled = resolved

    const zone = {
      ...selected.zone,
      startSec: localizeSampledInstrumentSeconds(selected.zone.startSec, sampled.sourceStartFrame, selected.zone.sample.source.sampleRate),
      endSec: selected.zone.endSec === undefined
        ? sampled.buffer.length / sampled.buffer.sampleRate
        : localizeSampledInstrumentSeconds(selected.zone.endSec, sampled.sourceStartFrame, selected.zone.sample.source.sampleRate),
      loopStartSec: selected.zone.loopStartSec === undefined
        ? undefined
        : localizeSampledInstrumentSeconds(selected.zone.loopStartSec, sampled.sourceStartFrame, selected.zone.sample.source.sampleRate),
      loopEndSec: selected.zone.loopEndSec === undefined
        ? undefined
        : localizeSampledInstrumentSeconds(selected.zone.loopEndSec, sampled.sourceStartFrame, selected.zone.sample.source.sampleRate),
    }

    scheduleSamplerVoice({
      ctx: input.ctx,
      destination: input.destination,
      buffer: sampled.buffer,
      zone,
      params: input.instrument.params,
      note: event.pitch,
      velocity: Math.round((event.velocity ?? 1) * 127),
      when: Math.max(0, event.startSec - input.rangeStartSec),
      durationSec: event.endSec - event.startSec,
      timelineStartSec: event.startSec,
      automationEnvelopes: input.automationEnvelopes.filter((envelope) => {
        const key = parseInstrumentAutomationKey(envelope.parameterId)

        return key?.instanceId === input.instrument.instanceId
      }),
      timelineToCtxTime: (timelineSec) => Math.max(0, timelineSec - input.rangeStartSec),
    })
  }
}

export async function createOfflineGranularTrack(input: {
  ctx: OfflineAudioContext
  destination: AudioNode
  instrument: Extract<TrackInstrumentParams, { kind: 'granular' }>
  installedBuffer: GranularInstalledBuffer | undefined
  resourceObserver?: ResourceObserver
}) {
  const runtime = await createGranularRuntime({
    context: input.ctx,
    destination: input.destination,
    params: input.instrument.params,
    resourceObserver: input.resourceObserver,
  })

  try {
    if (input.installedBuffer) await runtime.installSample(input.installedBuffer)
    runtime.resetSeed(input.instrument.params.seed)
    runtime.setFrozen(input.instrument.params.freeze)

    return runtime
  } catch (error) {
    runtime.close()
    throw error
  }
}
