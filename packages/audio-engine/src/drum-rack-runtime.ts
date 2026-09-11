import { getScheduledMidiEvents } from './audio-scheduling'
import { disconnectAudioNodes } from './effects/chain'
import { stopAndDisconnectSource, type SourceRegistry } from './source-registry'
import { MAX_SAMPLED_INSTRUMENT_VOICES, normalizeDrumRackParams, type ArpParams, type DrumRackPadParams, type DrumRackParams } from '@daw-browser/shared'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import {
  localizeSampledInstrumentSeconds,
  sampledInstrumentRegion,
  sampledInstrumentRegionIdentity,
  type SampledInstrumentBuffer,
} from './sampled-instrument-region'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

export type DrumRackResolvedBuffers = ReadonlyMap<string, SampledInstrumentBuffer>
export type DrumRackRegionUse = {
  trackId: string
  regionKey: string
  hitId: number
  active: boolean
}

type TrackDrumRackConfig = {
  inputParams: DrumRackParams
  params: DrumRackParams
  buffers: DrumRackResolvedBuffers
  padIndexByNote: Map<number, number>
}

type ActiveHit = {
  id: number
  clipId?: string
  regionKey: string
  source: AudioBufferSourceNode
  gain: GainNode
  pan: StereoPannerNode
  chokeGroup: number
  removed: boolean
  stopRequested: boolean
}

type DrumRackRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getBpm: () => number
  timelineToCtxTime: (timelineSec: number) => number
  ensureTrackInput: (trackId: string) => GainNode
  sources: SourceRegistry
  getArpeggiator: (trackId: string) => ArpParams | undefined
  onAssetUse?: (use: DrumRackRegionUse) => void
}

export const DRUM_RACK_CHOKE_FADE_SEC = 0.006
export const DRUM_RACK_MAX_DECODED_BYTES = 64 * 1024 * 1024
const EMPTY_DRUM_RACK_BUFFERS: DrumRackResolvedBuffers = new Map()

const getPadPlaybackDurationSec = (pad: DrumRackPadParams, buffer: AudioBuffer) => {
  const startSec = Math.min(Math.max(0, pad.startSec), buffer.duration)
  const endSec = Math.min(Math.max(startSec, pad.endSec ?? buffer.duration), buffer.duration)
  return {
    startSec,
    durationSec: Math.max(0, endSec - startSec),
  }
}

const localizePad = (pad: DrumRackPadParams, sampled: SampledInstrumentBuffer): DrumRackPadParams => {
  const sampleRate = pad.sample?.source.sampleRate ?? sampled.buffer.sampleRate
  return {
    ...pad,
    startSec: localizeSampledInstrumentSeconds(pad.startSec, sampled.sourceStartFrame, sampleRate),
    endSec: pad.endSec === undefined
      ? sampled.buffer.duration
      : localizeSampledInstrumentSeconds(pad.endSec, sampled.sourceStartFrame, sampleRate),
  }
}

export function scheduleDrumRackHit(input: {
  ctx: BaseAudioContext
  destination: AudioNode
  buffer: AudioBuffer
  pad: DrumRackPadParams
  when: number
  velocity: number
}): { source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode } | null {
  if (input.pad.mute) return null
  const playback = getPadPlaybackDurationSec(input.pad, input.buffer)
  if (playback.durationSec <= 0) return null

  const source = input.ctx.createBufferSource()
  source.buffer = input.buffer
  source.playbackRate.value = Math.pow(2, input.pad.transpose / 12)

  const gain = input.ctx.createGain()
  gain.gain.setValueAtTime(Math.max(0, input.velocity) * input.pad.gain, input.when)

  const pan = input.ctx.createStereoPanner()
  pan.pan.value = input.pad.pan

  source.connect(gain)
  gain.connect(pan)
  pan.connect(input.destination)
  source.start(input.when, playback.startSec, playback.durationSec)
  return { source, gain, pan }
}

export function createDrumRackRuntime(options: DrumRackRuntimeOptions) {
  const configs = new Map<string, TrackDrumRackConfig>()
  const activeHitsByTrack = new Map<string, Set<ActiveHit>>()
  let nextHitId = 1

  const buildPadIndex = (params: DrumRackParams) => {
    const padIndexByNote = new Map<number, number>()
    params.pads.forEach((pad, index) => {
      padIndexByNote.set(pad.note, index)
    })
    return padIndexByNote
  }

  const removeActiveHit = (trackId: string, hit: ActiveHit) => {
    if (hit.removed) return
    hit.removed = true
    hit.source.onended = null
    const hits = activeHitsByTrack.get(trackId)
    if (hits) {
      hits.delete(hit)
      if (hits.size === 0) activeHitsByTrack.delete(trackId)
    }
    if (hit.clipId) options.sources.remove(hit.clipId, hit.source)
    options.onAssetUse?.({ trackId, regionKey: hit.regionKey, hitId: hit.id, active: false })
    disconnectAudioNodes([hit.gain, hit.pan])
  }

  const stopHit = (trackId: string, hit: ActiveHit, stopAt?: number) => {
    if (hit.removed) return
    if (stopAt === undefined) {
      if (!hit.stopRequested) stopAndDisconnectSource(hit.source)
      removeActiveHit(trackId, hit)
      return
    }
    if (hit.stopRequested) return
    try {
      hit.source.stop(stopAt)
      hit.stopRequested = true
    } catch {
      stopAndDisconnectSource(hit.source)
      removeActiveHit(trackId, hit)
    }
  }

  const stopHitAfterFade = (trackId: string, hit: ActiveHit, stopAt: number) => {
    stopHit(trackId, hit, stopAt)
  }

  const chokeGroup = (trackId: string, chokeGroup: number, when: number) => {
    if (chokeGroup <= 0) return
    const hits = activeHitsByTrack.get(trackId)
    if (!hits) return
    for (const hit of Array.from(hits)) {
      if (hit.chokeGroup !== chokeGroup) continue
      try {
        hit.gain.gain.cancelScheduledValues(when)
        hit.gain.gain.setValueAtTime(hit.gain.gain.value, when)
        hit.gain.gain.linearRampToValueAtTime(0, when + DRUM_RACK_CHOKE_FADE_SEC)
      } catch {}
      stopHitAfterFade(trackId, hit, when + DRUM_RACK_CHOKE_FADE_SEC)
    }
  }

  const triggerPad = (trackId: string, pad: DrumRackPadParams, sampled: SampledInstrumentBuffer, when: number, velocity: number, clipId?: string, onEnded?: () => void): ((stopWhen: number) => void) | undefined => {
    const ctx = options.getAudioContext()
    if (!ctx) return undefined
    chokeGroup(trackId, pad.chokeGroup, when)
    const activeHits = activeHitsByTrack.get(trackId)
    if (activeHits && activeHits.size >= MAX_SAMPLED_INSTRUMENT_VOICES) {
      let oldest: ActiveHit | undefined
      for (const candidate of activeHits) {
        if (!oldest || candidate.id < oldest.id) oldest = candidate
      }
      if (oldest) stopHit(trackId, oldest, when)
    }
    const scheduled = scheduleDrumRackHit({
      ctx,
      destination: options.ensureTrackInput(trackId),
      buffer: sampled.buffer,
      pad: localizePad(pad, sampled),
      when,
      velocity,
    })
    if (!scheduled) return undefined
    const hit: ActiveHit = {
      ...scheduled,
      id: nextHitId++,
      clipId,
      chokeGroup: pad.chokeGroup,
      regionKey: pad.sample
        ? sampledInstrumentRegionIdentity(
          pad.sample,
          sampledInstrumentRegion(
            pad.sample.source,
            pad.startSec,
            pad.endSec ?? pad.sample.source.durationSec,
          ),
        )
        : '',
      removed: false,
      stopRequested: false,
    }
    let hits = activeHitsByTrack.get(trackId)
    if (!hits) {
      hits = new Set()
      activeHitsByTrack.set(trackId, hits)
    }
    hits.add(hit)
    options.onAssetUse?.({ trackId, regionKey: hit.regionKey, hitId: hit.id, active: true })
    scheduled.source.onended = () => {
      removeActiveHit(trackId, hit)
      onEnded?.()
    }
    if (clipId) options.sources.add(clipId, scheduled.source)
    return (stopWhen) => stopHit(trackId, hit, stopWhen)
  }

  const disposeTrack = (trackId: string) => {
    const hits = activeHitsByTrack.get(trackId)
    if (hits) for (const hit of Array.from(hits)) stopHit(trackId, hit)
    activeHitsByTrack.delete(trackId)
    configs.delete(trackId)
  }

  return {
    setTrackDrumRack: (trackId: string, params: DrumRackParams, buffers?: DrumRackResolvedBuffers) => {
      const current = configs.get(trackId)
      const resolvedBuffers = buffers ?? current?.buffers ?? EMPTY_DRUM_RACK_BUFFERS
      if (current?.inputParams === params && current.buffers === resolvedBuffers) return
      const normalized = normalizeDrumRackParams(params)
      configs.set(trackId, {
        inputParams: params,
        params: normalized,
        buffers: resolvedBuffers,
        padIndexByNote: buildPadIndex(normalized),
      })
    },
    clearTrackDrumRack: (trackId: string) => {
      disposeTrack(trackId)
    },
    scheduleMidiClip: (track: RuntimeTrack, clip: RuntimeClip, playheadSec: number, nowCtx: number, endLimitSec?: number): boolean => {
      const config = configs.get(track.id)
      const midi = clip.midi
      if (!config || !midi || !Array.isArray(midi.notes)) return false
      const scheduledNotes = getScheduledMidiEvents({
        clip,
        bpm: options.getBpm(),
        notes: midi.notes,
        rangeStartSec: playheadSec,
        rangeEndSec: endLimitSec,
        arp: options.getArpeggiator(track.id),
      })
      let didSchedule = false
      for (const note of scheduledNotes) {
        const padIndex = config.padIndexByNote.get(note.pitch)
        const pad = padIndex === undefined ? undefined : config.params.pads[padIndex]
        if (!pad) continue
        const sampled = config.buffers.get(pad.id)
        if (!sampled) continue
        didSchedule = Boolean(triggerPad(track.id, pad, sampled, Math.max(nowCtx, options.timelineToCtxTime(note.startSec)), note.velocity ?? 1, clip.id)) || didSchedule
      }
      return didSchedule
    },
    previewPad: (trackId: string, padId: string, velocity: number) => {
      options.ensureAudio()
      const config = configs.get(trackId)
      const ctx = options.getAudioContext()
      if (!config || !ctx) return
      const pad = config.params.pads.find((candidate) => candidate.id === padId)
      const sampled = pad ? config.buffers.get(pad.id) : undefined
      if (!pad || !sampled) return
      triggerPad(trackId, pad, sampled, ctx.currentTime, velocity)
    },
    previewNote: (trackId: string, pitch: number, velocity: number) => {
      options.ensureAudio()
      const config = configs.get(trackId)
      const ctx = options.getAudioContext()
      if (!config || !ctx) return false
      const padIndex = config.padIndexByNote.get(pitch)
      const pad = padIndex === undefined ? undefined : config.params.pads[padIndex]
      const sampled = pad ? config.buffers.get(pad.id) : undefined
      if (!pad || !sampled) return false
      return Boolean(triggerPad(trackId, pad, sampled, ctx.currentTime, velocity))
    },
    startLiveNote: (trackId: string, pitch: number, velocity: number, onEnded?: () => void) => {
      options.ensureAudio()
      const config = configs.get(trackId)
      const ctx = options.getAudioContext()
      if (!config || !ctx) return undefined
      const padIndex = config.padIndexByNote.get(pitch)
      const pad = padIndex === undefined ? undefined : config.params.pads[padIndex]
      const sampled = pad ? config.buffers.get(pad.id) : undefined
      if (!pad || !sampled) return undefined
      return triggerPad(trackId, pad, sampled, ctx.currentTime, velocity, undefined, onEnded)
    },
    stopLiveNotes: (trackId: string, when: number) => {
      for (const hit of Array.from(activeHitsByTrack.get(trackId) ?? [])) {
        if (hit.clipId === undefined) stopHit(trackId, hit, when)
      }
    },
    stopAll: () => {
      for (const trackId of Array.from(activeHitsByTrack.keys())) {
        const hits = activeHitsByTrack.get(trackId)
        if (hits) for (const hit of Array.from(hits)) stopHit(trackId, hit)
      }
    },
    stopClip: (clipId: string) => {
      for (const [trackId, hits] of Array.from(activeHitsByTrack.entries())) {
        for (const hit of Array.from(hits)) {
          if (hit.clipId === clipId) stopHit(trackId, hit)
        }
      }
    },
    disposeTrack,
    clear: () => {
      for (const trackId of Array.from(configs.keys())) disposeTrack(trackId)
      configs.clear()
      activeHitsByTrack.clear()
    },
  }
}
