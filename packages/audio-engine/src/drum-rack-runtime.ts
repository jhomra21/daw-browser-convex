import { getScheduledMidiEvents } from './audio-scheduling'
import { disconnectAudioNodes } from './effects/chain'
import { stopAndDisconnectSource, type SourceRegistry } from './source-registry'
import { normalizeDrumRackParams, type ArpParams, type DrumRackPadParams, type DrumRackParams } from '@daw-browser/shared'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

export type DrumRackResolvedBuffers = ReadonlyMap<string, AudioBuffer>

type TrackDrumRackConfig = {
  inputParams: DrumRackParams
  params: DrumRackParams
  buffers: DrumRackResolvedBuffers
  padIndexByNote: Map<number, number>
}

type ActiveHit = {
  clipId?: string
  source: AudioBufferSourceNode
  gain: GainNode
  pan: StereoPannerNode
  chokeGroup: number
}

type DrumRackRuntimeOptions = {
  ensureAudio: () => void
  getAudioContext: () => AudioContext | null
  getBpm: () => number
  timelineToCtxTime: (timelineSec: number) => number
  ensureTrackInput: (trackId: string) => GainNode
  sources: SourceRegistry
  getArpeggiator: (trackId: string) => ArpParams | undefined
}

const CHOKE_FADE_SEC = 0.006
const EMPTY_DRUM_RACK_BUFFERS: DrumRackResolvedBuffers = new Map()

const getPadPlaybackDurationSec = (pad: DrumRackPadParams, buffer: AudioBuffer) => {
  const startSec = Math.min(Math.max(0, pad.startSec), buffer.duration)
  const endSec = Math.min(Math.max(startSec, pad.endSec ?? buffer.duration), buffer.duration)
  return {
    startSec,
    durationSec: Math.max(0, endSec - startSec),
  }
}

function scheduleDrumRackHit(input: {
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

  const buildPadIndex = (params: DrumRackParams) => {
    const padIndexByNote = new Map<number, number>()
    params.pads.forEach((pad, index) => {
      padIndexByNote.set(pad.note, index)
    })
    return padIndexByNote
  }

  const removeActiveHit = (trackId: string, hit: ActiveHit) => {
    const hits = activeHitsByTrack.get(trackId)
    if (hits) {
      hits.delete(hit)
      if (hits.size === 0) activeHitsByTrack.delete(trackId)
    }
    if (hit.clipId) options.sources.remove(hit.clipId, hit.source)
    disconnectAudioNodes([hit.gain, hit.pan])
  }

  const stopHit = (trackId: string, hit: ActiveHit, stopAt?: number) => {
    stopAndDisconnectSource(hit.source, stopAt)
    removeActiveHit(trackId, hit)
  }

  const stopHitAfterFade = (trackId: string, hit: ActiveHit, stopAt: number) => {
    try {
      hit.source.stop(stopAt)
    } catch {
      stopHit(trackId, hit)
    }
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
        hit.gain.gain.linearRampToValueAtTime(0, when + CHOKE_FADE_SEC)
      } catch {}
      stopHitAfterFade(trackId, hit, when + CHOKE_FADE_SEC)
    }
  }

  const triggerPad = (trackId: string, pad: DrumRackPadParams, buffer: AudioBuffer, when: number, velocity: number, clipId?: string) => {
    const ctx = options.getAudioContext()
    if (!ctx) return false
    chokeGroup(trackId, pad.chokeGroup, when)
    const scheduled = scheduleDrumRackHit({
      ctx,
      destination: options.ensureTrackInput(trackId),
      buffer,
      pad,
      when,
      velocity,
    })
    if (!scheduled) return false
    const hit: ActiveHit = { ...scheduled, clipId, chokeGroup: pad.chokeGroup }
    let hits = activeHitsByTrack.get(trackId)
    if (!hits) {
      hits = new Set()
      activeHitsByTrack.set(trackId, hits)
    }
    hits.add(hit)
    scheduled.source.onended = () => removeActiveHit(trackId, hit)
    if (clipId) options.sources.add(clipId, scheduled.source)
    return true
  }

  const disposeTrack = (trackId: string) => {
    const hits = activeHitsByTrack.get(trackId)
    if (hits) for (const hit of Array.from(hits)) stopHit(trackId, hit)
    activeHitsByTrack.delete(trackId)
    configs.delete(trackId)
  }

  return {
    setTrackDrumRack: (trackId: string, params: DrumRackParams, buffers: DrumRackResolvedBuffers = EMPTY_DRUM_RACK_BUFFERS) => {
      const current = configs.get(trackId)
      if (current?.inputParams === params && current.buffers === buffers) return
      const normalized = normalizeDrumRackParams(params)
      configs.set(trackId, {
        inputParams: params,
        params: normalized,
        buffers,
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
        const buffer = config.buffers.get(pad.id)
        if (!buffer) continue
        didSchedule = triggerPad(track.id, pad, buffer, Math.max(nowCtx, options.timelineToCtxTime(note.startSec)), note.velocity ?? 1, clip.id) || didSchedule
      }
      return didSchedule
    },
    previewPad: (trackId: string, padId: string, velocity: number) => {
      options.ensureAudio()
      const config = configs.get(trackId)
      const ctx = options.getAudioContext()
      if (!config || !ctx) return
      const pad = config.params.pads.find((candidate) => candidate.id === padId)
      const buffer = pad ? config.buffers.get(pad.id) : undefined
      if (!pad || !buffer) return
      triggerPad(trackId, pad, buffer, ctx.currentTime, velocity)
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
