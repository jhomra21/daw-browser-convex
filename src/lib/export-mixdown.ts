import { Output, BufferTarget, WavOutputFormat, AudioBufferSource } from 'mediabunny'

import { getPlayableAudioWindow, getScheduledMidiEvents } from '~/lib/audio-scheduling'
import { type ArpParams, type EqParamsLite, type ReverbParamsLite, type SynthParamsInput } from '~/lib/effects/params'
import { createSynthVoiceOscillators, getSynthVoiceConfig, getSynthVoiceVelocity, scheduleSynthVoiceEnvelope } from '~/lib/synth-voice'
import { createOfflineMixerNodes } from '~/lib/mixer/apply-offline-routing'
import { createMixerChannels } from '~/lib/mixer/channels'
import { resolveMixerGraph } from '~/lib/mixer/resolve-routing'
import type { Track } from '~/types/timeline'

export type ExportRange =
  | { mode: 'whole' }
  | { mode: 'loop'; startSec: number; endSec: number }
  | { mode: 'custom'; startSec: number; endSec: number }

export type ExportRequest = {
  tracks: Track[]
  bpm: number
  range: ExportRange
  sampleRate?: number
  numberOfChannels?: number
  fx?: {
    masterEq?: EqParamsLite
    masterReverb?: ReverbParamsLite
    trackFx?: Record<string, { eq?: EqParamsLite; reverb?: ReverbParamsLite; arp?: ArpParams; synth?: SynthParamsInput }>
  }
}

export type ExportResult = {
  audioBuffer: AudioBuffer
  blob: Blob
  mimeType: string
  fileExtension: string
  durationSec: number
  sampleRate: number
}

function lastClipEndSec(tracks: Track[]): number {
  let maxEnd = 0
  for (const track of tracks) {
    for (const clip of track.clips) {
      maxEnd = Math.max(maxEnd, clip.startSec + clip.duration)
    }
  }
  return Math.max(0.001, maxEnd)
}

function computeRangeSec(tracks: Track[], range: ExportRange): { start: number; end: number } {
  if (range.mode === 'whole') {
    return { start: 0, end: lastClipEndSec(tracks) }
  }
  const start = Math.max(0, range.startSec)
  const end = Math.max(start, range.endSec)
  return { start, end }
}

export async function renderMixdown(req: ExportRequest): Promise<AudioBuffer> {
  const { tracks, bpm, range, sampleRate = 44100, numberOfChannels = 2, fx } = req
  const { start, end } = computeRangeSec(tracks, range)
  const duration = Math.max(0.001, end - start)
  const length = Math.ceil(duration * sampleRate)
  const ctx = new OfflineAudioContext(numberOfChannels, length, sampleRate)
  const trackById = new Map(tracks.map(track => [track.id, track]))
  const mixerGraph = resolveMixerGraph({
    channels: createMixerChannels(tracks),
    masterEq: fx?.masterEq,
    masterReverb: fx?.masterReverb,
    trackFx: fx?.trackFx,
  })
  const { trackNodes } = createOfflineMixerNodes(ctx, mixerGraph)

  for (const resolvedTrack of mixerGraph.channels) {
    const track = trackById.get(resolvedTrack.channel.id)
    if (!track) continue
    const trackInput = trackNodes.get(track.id)?.input
    if (!trackInput) continue
    const fxCfg = resolvedTrack.fx

    for (const clip of track.clips) {
      const midi = clip.midi
      if (midi && Array.isArray(midi.notes)) {
        const voice = getSynthVoiceConfig({ synth: fxCfg?.synth, midi })
        const events = getScheduledMidiEvents({
          clip,
          bpm,
          notes: midi.notes,
          rangeStartSec: start,
          rangeEndSec: end,
          arp: fxCfg?.arp,
        })

        for (const event of events) {
          const when = Math.max(0, event.startSec - start)
          const noteDur = event.endSec - event.startSec
          if (noteDur <= 0) continue

          const { osc1, osc2 } = createSynthVoiceOscillators(ctx, {
            startTime: when,
            pitch: event.pitch,
            wave1: voice.wave1,
            wave2: voice.wave2,
          })
          const gain = ctx.createGain()
          const peakGain = (getSynthVoiceVelocity(event.velocity) * voice.clipGain * voice.synthGain) / 2
          const envelope = scheduleSynthVoiceEnvelope(gain.gain, {
            startTime: when,
            durationSec: noteDur,
            attackSec: voice.attackSec,
            releaseSec: voice.releaseSec,
            peakGain,
          })
          osc1.connect(gain)
          osc2.connect(gain)
          gain.connect(trackInput)
          try { osc1.start(when) } catch {}
          try { osc2.start(when) } catch {}
          try { osc1.stop(envelope.endTime) } catch {}
          try { osc2.stop(envelope.endTime) } catch {}
        }
        continue
      }

      if (!clip.buffer) continue
      const window = getPlayableAudioWindow({
        clip,
        bufferDurationSec: clip.buffer.duration,
        rangeStartSec: start,
        rangeEndSec: end,
      })
      if (!window) continue

      const src = ctx.createBufferSource()
      src.buffer = clip.buffer
      src.connect(trackInput)
      try { src.start(Math.max(0, window.startSec - start), window.offsetSec, window.durationSec) } catch {}
    }
  }

  return await ctx.startRendering()
}

export async function encodeAudioBuffer(buffer: AudioBuffer): Promise<ExportResult> {
  const sampleRate = buffer.sampleRate
  const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() })
  const src = new AudioBufferSource({ codec: 'pcm-s16' })
  output.addAudioTrack(src)
  await output.start()
  await src.add(buffer)
  src.close()
  await output.finalize()
  const outBuffer = (output.target as BufferTarget).buffer!
  const blob = new Blob([outBuffer], { type: 'audio/wav' })
  return {
    audioBuffer: buffer,
    blob,
    mimeType: 'audio/wav',
    fileExtension: '.wav',
    durationSec: buffer.duration,
    sampleRate,
  }
}
