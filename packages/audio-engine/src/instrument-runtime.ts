import { createDrumRackRuntime, type DrumRackResolvedBuffers } from './drum-rack-runtime'
import { createSynthRuntime } from './synth-runtime'
import { createSamplerRuntime, type SamplerNoteMiss, type SamplerResolvedBuffers } from './sampler-runtime'
import { createGranularRuntime, type GranularInstalledBuffer } from './granular-runtime'
import type { SourceRegistry } from './source-registry'
import { parseGranularAutomationKey, type ArpParams, type AutomationEnvelope, type SynthParamsInput, type TrackInstrumentParams } from '@daw-browser/shared'
import { getScheduledMidiEvents } from './audio-scheduling'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

type InstrumentRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getBpm: () => number
  timelineToCtxTime: (timelineSec: number) => number
  ensureTrackInput: (trackId: string) => GainNode
  sources: SourceRegistry
  getAutomationEnvelopes?: () => readonly AutomationEnvelope[]
}

export type SetTrackInstrumentInput =
  | { instrument: Pick<Extract<TrackInstrumentParams, { kind: 'synth' }>, 'kind' | 'params'> & { instanceId?: string } }
  | { instrument: { kind: 'drum-rack'; params: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>['params'] }; buffers?: DrumRackResolvedBuffers }
  | { instrument: Extract<TrackInstrumentParams, { kind: 'sampler' }>; buffers?: SamplerResolvedBuffers }
  | { instrument: Extract<TrackInstrumentParams, { kind: 'granular' }>; installedBuffer?: GranularInstalledBuffer }

export function createInstrumentRuntime(options: InstrumentRuntimeOptions) {
  let samplerNoteMissListener: ((miss: SamplerNoteMiss) => void) | undefined
  let samplerAssetUseListener: ((assetKey: string, active: boolean) => void) | undefined
  const activeKinds = new Map<string, TrackInstrumentParams['kind']>()
  const arpeggiators = new Map<string, ArpParams>()
  const synthRuntime = createSynthRuntime({
    ...options,
    getArpeggiator: (trackId) => arpeggiators.get(trackId),
    getAutomationEnvelopes: options.getAutomationEnvelopes,
  })
  const drumRackRuntime = createDrumRackRuntime({ ...options, getArpeggiator: (trackId) => arpeggiators.get(trackId) })
  const samplerRuntime = createSamplerRuntime({
    ...options,
    getArpeggiator: (trackId) => arpeggiators.get(trackId),
    getAutomationEnvelopes: options.getAutomationEnvelopes ?? (() => []),
    onNoteMiss: (miss) => samplerNoteMissListener?.(miss),
    onAssetUse: (assetKey, active) => samplerAssetUseListener?.(assetKey, active),
  })
  const granularRuntimes = new Map<string, Awaited<ReturnType<typeof createGranularRuntime>>>()
  const granularInstanceIds = new Map<string, string>()
  const granularRevisions = new Map<string, number>()
  const disposeGranular = (trackId: string) => {
    granularRevisions.set(trackId, (granularRevisions.get(trackId) ?? 0) + 1)
    granularRuntimes.get(trackId)?.close()
    granularRuntimes.delete(trackId)
    granularInstanceIds.delete(trackId)
  }
  const setTrackGranular = async (
    trackId: string,
    params: Extract<TrackInstrumentParams, { kind: 'granular' }>['params'],
    installedBuffer?: GranularInstalledBuffer,
    instanceId = '',
  ) => {
    options.ensureAudio()
    const context = options.getAudioContext()
    if (!context) return
    disposeGranular(trackId)
    const revision = granularRevisions.get(trackId) ?? 0
    const runtime = await createGranularRuntime({
      context,
      destination: options.ensureTrackInput(trackId),
      params,
    })
    if (granularRevisions.get(trackId) !== revision) {
      runtime.close()
      return
    }
    granularRuntimes.set(trackId, runtime)
    granularInstanceIds.set(trackId, instanceId)
    runtime.setFrozen(params.freeze)
    try {
      if (installedBuffer) await runtime.installSample(installedBuffer)
    } catch (error) {
      if (granularRuntimes.get(trackId) === runtime) {
        runtime.close()
        granularRuntimes.delete(trackId)
        granularInstanceIds.delete(trackId)
      }
      throw error
    }
  }

  const setTrackSynth = (trackId: string, params: SynthParamsInput, instanceId?: string) => {
    disposeGranular(trackId)
    drumRackRuntime.clearTrackDrumRack(trackId)
    samplerRuntime.disposeTrack(trackId)
    activeKinds.set(trackId, 'synth')
    synthRuntime.setTrackSynth(trackId, params, instanceId)
  }

  const clearTrackSynth = (trackId: string) => {
    if (activeKinds.get(trackId) === 'synth') activeKinds.delete(trackId)
    synthRuntime.disposeTrack(trackId)
  }

  const clearTrackInstrument = (trackId: string) => {
    activeKinds.delete(trackId)
    synthRuntime.disposeTrack(trackId)
    drumRackRuntime.clearTrackDrumRack(trackId)
    samplerRuntime.disposeTrack(trackId)
    disposeGranular(trackId)
  }

  return {
    setTrackInstrument: (trackId: string, input: SetTrackInstrumentInput) => {
      if (input.instrument.kind === 'synth') {
        setTrackSynth(trackId, input.instrument.params, input.instrument.instanceId)
        return
      }
      synthRuntime.disposeTrack(trackId)
      if (input.instrument.kind === 'drum-rack') {
        disposeGranular(trackId)
        samplerRuntime.disposeTrack(trackId)
        activeKinds.set(trackId, 'drum-rack')
        drumRackRuntime.setTrackDrumRack(trackId, input.instrument.params, 'buffers' in input ? input.buffers : undefined)
        return
      }
      if (input.instrument.kind === 'granular') {
        drumRackRuntime.clearTrackDrumRack(trackId)
        samplerRuntime.disposeTrack(trackId)
        activeKinds.set(trackId, 'granular')
        void setTrackGranular(trackId, input.instrument.params, 'installedBuffer' in input ? input.installedBuffer : undefined, input.instrument.instanceId).catch(() => undefined)
        return
      }
      disposeGranular(trackId)
      drumRackRuntime.clearTrackDrumRack(trackId)
      samplerRuntime.disposeTrack(trackId)
      activeKinds.set(trackId, 'sampler')
      samplerRuntime.setTrackSampler(trackId, input.instrument.instanceId, input.instrument.params, 'buffers' in input ? input.buffers : undefined)
    },
    clearTrackInstrument,
    setTrackSynth,
    clearTrackSynth,
    setTrackDrumRack: (trackId: string, params: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>['params'], buffers?: DrumRackResolvedBuffers) => {
      disposeGranular(trackId)
      synthRuntime.disposeTrack(trackId)
      samplerRuntime.disposeTrack(trackId)
      activeKinds.set(trackId, 'drum-rack')
      drumRackRuntime.setTrackDrumRack(trackId, params, buffers)
    },
    clearTrackDrumRack: (trackId: string) => {
      if (activeKinds.get(trackId) === 'drum-rack') activeKinds.delete(trackId)
      drumRackRuntime.clearTrackDrumRack(trackId)
    },
    setTrackSampler: (trackId: string, params: Extract<TrackInstrumentParams, { kind: 'sampler' }>['params'], buffers?: SamplerResolvedBuffers, instanceId?: string) => {
      disposeGranular(trackId)
      synthRuntime.disposeTrack(trackId)
      drumRackRuntime.clearTrackDrumRack(trackId)
      activeKinds.set(trackId, 'sampler')
      samplerRuntime.setTrackSampler(trackId, instanceId, params, buffers)
    },
    setTrackGranular: (trackId: string, params: Extract<TrackInstrumentParams, { kind: 'granular' }>['params'], installedBuffer?: GranularInstalledBuffer, instanceId?: string) => {
      synthRuntime.disposeTrack(trackId)
      drumRackRuntime.clearTrackDrumRack(trackId)
      samplerRuntime.disposeTrack(trackId)
      activeKinds.set(trackId, 'granular')
      return setTrackGranular(trackId, params, installedBuffer, instanceId)
    },
    setTrackArpeggiator: (trackId: string, params: ArpParams) => {
      arpeggiators.set(trackId, params)
    },
    getTrackArpeggiator: (trackId: string) => arpeggiators.get(trackId),
    clearTrackArpeggiator: (trackId: string) => {
      arpeggiators.delete(trackId)
    },
    getTrackInstrumentKind: (trackId: string) => activeKinds.get(trackId),
    triggerSynthNote: (input: {
      trackId: string
      pitch: number
      velocity?: number
      when: number
      durationSec: number
      live?: boolean
    }) => activeKinds.get(input.trackId) === 'synth' ? synthRuntime.triggerNote(input) : undefined,
    getSynthLiveVoiceGeneration: (trackId: string) => (
      activeKinds.get(trackId) === 'synth' ? synthRuntime.getLiveVoiceGeneration(trackId) : undefined
    ),
    previewSynthNote: (trackId: string, pitch: number, velocity?: number, durationSec?: number) => (
      activeKinds.get(trackId) === 'synth' ? synthRuntime.previewNote(trackId, pitch, velocity, durationSec) : undefined
    ),
    startSynthPreviewNote: (trackId: string, pitch: number, velocity?: number) => (
      activeKinds.get(trackId) === 'synth' ? synthRuntime.startPreviewNote(trackId, pitch, velocity) : undefined
    ),
    releaseSynthPreviewNote: (
      trackId: string,
      noteInstanceId: number,
      when?: number,
      force = false,
      generation?: number,
    ) => {
      if (activeKinds.get(trackId) === 'synth') {
        synthRuntime.releasePreviewNote(trackId, noteInstanceId, when, force, generation)
      }
    },
    resolveSynthAutomationBindings: (trackId: string, parameterId: string) => (
      synthRuntime.resolveAutomationBindings(trackId, parameterId)
    ),
    scheduleMidiClip: (
      track: RuntimeTrack,
      clip: RuntimeClip,
      playheadSec: number,
      nowCtx: number,
      endLimitSec?: number,
      scheduleOptions?: { scheduleVoiceAutomation?: boolean },
    ): boolean => {
      if (activeKinds.get(track.id) === 'drum-rack') return drumRackRuntime.scheduleMidiClip(track, clip, playheadSec, nowCtx, endLimitSec)
      if (activeKinds.get(track.id) === 'sampler') return samplerRuntime.scheduleMidiClip(track, clip, playheadSec, nowCtx, endLimitSec)
      if (activeKinds.get(track.id) === 'granular') {
        if (!clip.midi) return false
        const runtime = granularRuntimes.get(track.id)
        if (!runtime) return false
        const instanceId = granularInstanceIds.get(track.id)
        const envelopes = options.getAutomationEnvelopes?.().filter((envelope) => {
          const key = parseGranularAutomationKey(envelope.parameterId)
          return key?.trackId === track.id && key.instanceId === instanceId
        }) ?? []
        const events = getScheduledMidiEvents({ clip, bpm: options.getBpm(), notes: clip.midi.notes, rangeStartSec: playheadSec, rangeEndSec: endLimitSec, arp: arpeggiators.get(track.id) })
        for (const note of events) {
          const timelineStartSec = note.startSec
          const durationSec = note.endSec - note.startSec
          runtime.scheduleNote({
            clipId: clip.id,
            when: Math.max(nowCtx, options.timelineToCtxTime(timelineStartSec)),
            durationSec,
            timelineStartSec,
            timelineToCtxTime: options.timelineToCtxTime,
            automationEnvelopes: envelopes,
          })
        }
        return events.length > 0
      }
      return synthRuntime.scheduleMidiClip(track, clip, playheadSec, nowCtx, endLimitSec, scheduleOptions)
    },
    previewDrumRackPad: drumRackRuntime.previewPad,
    previewDrumRackNote: drumRackRuntime.previewNote,
    previewSamplerNote: samplerRuntime.previewNote,
    startLiveDrumRackNote: drumRackRuntime.startLiveNote,
    startLiveSamplerNote: samplerRuntime.startLiveNote,
    startLiveGranularNote: (trackId: string, when: number, durationSec: number, liveId: string) => {
      if (activeKinds.get(trackId) !== 'granular') return undefined
      const runtime = granularRuntimes.get(trackId)
      if (!runtime) return undefined
      runtime.scheduleNote({
        clipId: liveId,
        when,
        durationSec,
        timelineStartSec: 0,
        timelineToCtxTime: (timeSec) => timeSec,
        automationEnvelopes: [],
      })
      return () => runtime.stopClip(liveId)
    },
    setSamplerRuntimeListeners: (listeners: {
      onNoteMiss?: (miss: SamplerNoteMiss) => void
      onAssetUse?: (assetKey: string, active: boolean) => void
    }) => {
      samplerNoteMissListener = listeners.onNoteMiss
      samplerAssetUseListener = listeners.onAssetUse
    },
    stopClip: (clipId: string) => {
      synthRuntime.stopClip(clipId)
      drumRackRuntime.stopClip(clipId)
      samplerRuntime.stopClip(clipId)
      for (const runtime of granularRuntimes.values()) runtime.stopClip(clipId)
    },
    stopAll: () => {
      synthRuntime.stopAll()
      drumRackRuntime.stopAll()
      samplerRuntime.stopAll()
      for (const runtime of granularRuntimes.values()) runtime.stop()
    },
    stopLiveNotes: (trackId: string, when: number) => {
      samplerRuntime.stopLiveNotes(trackId, when)
      drumRackRuntime.stopLiveNotes(trackId, when)
      granularRuntimes.get(trackId)?.stop()
    },
    disposeTrack: (trackId: string) => {
      activeKinds.delete(trackId)
      arpeggiators.delete(trackId)
      synthRuntime.disposeTrack(trackId)
      drumRackRuntime.disposeTrack(trackId)
      samplerRuntime.disposeTrack(trackId)
      disposeGranular(trackId)
    },
    clear: () => {
      activeKinds.clear()
      arpeggiators.clear()
      synthRuntime.clear()
      drumRackRuntime.clear()
      samplerRuntime.clear()
      for (const trackId of Array.from(granularRuntimes.keys())) disposeGranular(trackId)
    },
  }
}
