import {
  Output,
  BufferTarget,
  StreamTarget,
  WavOutputFormat,
  Mp3OutputFormat,
  OggOutputFormat,
  FlacOutputFormat,
  AudioBufferSource,
  canEncodeAudio,
  type AudioCodec,
  type OutputFormat,
  type StreamTargetChunk,
  type Target,
} from 'mediabunny'

import { getPlayableAudioWindow, getScheduledMidiEvents } from './audio-scheduling'
import {
  exportAudioFormats,
  getExportAudioFormatMetadata,
  type ArpParams,
  type EqParamsLite,
  type ExportAudioFormat,
  type ReverbParamsLite,
  type SynthParamsInput,
} from '@daw-browser/shared'
import { createSynthVoiceOscillators, getSynthVoiceConfig, getSynthVoiceVelocity, scheduleSynthVoiceEnvelope } from './synth-voice'
import { createOfflineMixerNodes } from './mixer/apply-offline-routing'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { Track } from '@daw-browser/timeline-core/types'

export type ExportRange =
  | { mode: 'whole' }
  | { mode: 'loop'; startSec: number; endSec: number }
  | { mode: 'custom'; startSec: number; endSec: number }

type ExportRequest = {
  tracks: Track<AudioBuffer>[]
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

type ExportResult = {
  audioBuffer: AudioBuffer
  blob?: Blob
  format: ExportAudioFormat
  mimeType: string
  fileExtension: string
  durationSec: number
  sampleRate: number
  sizeBytes: number
}

type EncodeTarget =
  | { mode: 'buffer' }
  | {
    mode: 'stream'
    writable: WritableStream<StreamTargetChunk>
    close?: () => Promise<void>
    abort?: (reason?: unknown) => Promise<void>
  }

export type ExportWritableStream = WritableStream<StreamTargetChunk>

type EncodeAudioBufferOptions = {
  format?: ExportAudioFormat
  bitrate?: number
  target?: EncodeTarget
  onWrite?: (sizeBytes: number) => void
}

type ExportAudioSupportRequest = {
  sampleRate?: number
  numberOfChannels?: number
}

function lastClipEndSec(tracks: Track<AudioBuffer>[]): number {
  let maxEnd = 0
  for (const track of tracks) {
    for (const clip of track.clips) {
      maxEnd = Math.max(maxEnd, clip.startSec + clip.duration)
    }
  }
  return Math.max(0.001, maxEnd)
}

function computeRangeSec(tracks: Track<AudioBuffer>[], range: ExportRange): { start: number; end: number } {
  if (range.mode === 'whole') {
    return { start: 0, end: lastClipEndSec(tracks) }
  }
  const start = Math.max(0, range.startSec)
  const end = Math.max(start, range.endSec)
  return { start, end }
}

type ExportAudioEncodingDescriptor = {
  codec: AudioCodec
  createOutputFormat: () => OutputFormat
  defaultBitrate?: number
}

const exportAudioEncodingDescriptors: Record<ExportAudioFormat, ExportAudioEncodingDescriptor> = {
  wav: {
    codec: 'pcm-s16',
    createOutputFormat: () => new WavOutputFormat(),
  },
  mp3: {
    codec: 'mp3',
    createOutputFormat: () => new Mp3OutputFormat(),
    defaultBitrate: 192000,
  },
  'ogg-opus': {
    codec: 'opus',
    createOutputFormat: () => new OggOutputFormat(),
    defaultBitrate: 128000,
  },
  flac: {
    codec: 'flac',
    createOutputFormat: () => new FlacOutputFormat(),
    defaultBitrate: 128000,
  },
}

export async function renderMixdown(req: ExportRequest): Promise<AudioBuffer> {
  const { tracks, bpm, range, sampleRate = 44100, numberOfChannels = 2, fx } = req
  const { start, end } = computeRangeSec(tracks, range)
  const duration = Math.max(0.001, end - start)
  const length = Math.ceil(duration * sampleRate)
  const ctx = new OfflineAudioContext(numberOfChannels, length, sampleRate)
  const trackIndex = createTimelineTrackIndex(tracks)
  const mixerGraph = resolveMixerGraph({
    channels: createMixerChannels(tracks),
    masterEq: fx?.masterEq,
    masterReverb: fx?.masterReverb,
    trackFx: fx?.trackFx,
  })
  const { trackNodes } = createOfflineMixerNodes(ctx, mixerGraph)

  for (const resolvedTrack of mixerGraph.channels) {
    const track = trackIndex.trackById.get(resolvedTrack.channel.id)
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

          const oscs = createSynthVoiceOscillators(ctx, {
            startTime: when,
            pitch: event.pitch,
            wave1: voice.wave1,
            wave2: voice.wave2,
          })
          const gain = ctx.createGain()
          const peakGain = (getSynthVoiceVelocity(event.velocity) * voice.clipGain * voice.synthGain) / oscs.length
          const envelope = scheduleSynthVoiceEnvelope(gain.gain, {
            startTime: when,
            durationSec: noteDur,
            attackSec: voice.attackSec,
            releaseSec: voice.releaseSec,
            peakGain,
          })
          for (const osc of oscs) osc.connect(gain)
          gain.connect(trackInput)
          for (const osc of oscs) {
            try { osc.start(when) } catch {}
            try { osc.stop(envelope.endTime) } catch {}
          }
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

const getAudioCodec = (format: ExportAudioFormat): AudioCodec => {
  return exportAudioEncodingDescriptors[format].codec
}

const getDefaultBitrate = (format: ExportAudioFormat): number | undefined => {
  return exportAudioEncodingDescriptors[format].defaultBitrate
}

const createOutputFormat = (format: ExportAudioFormat): OutputFormat => {
  return exportAudioEncodingDescriptors[format].createOutputFormat()
}

type EncodeTargetState = {
  target: Target
  close: () => Promise<void>
  abort: (reason?: unknown) => Promise<void>
}

const createManagedWritable = (
  target: Extract<EncodeTarget, { mode: 'stream' }>,
  abortTarget: (reason?: unknown) => Promise<void>,
): WritableStream<StreamTargetChunk> => {
  if (!target.close && !target.abort) return target.writable
  let writer: WritableStreamDefaultWriter<StreamTargetChunk> | undefined
  return new WritableStream<StreamTargetChunk>({
    start() {
      writer = target.writable.getWriter()
    },
    write(chunk) {
      if (!writer) throw new Error('Export stream writer was not initialized.')
      return writer.write(chunk)
    },
    close() {
      writer?.releaseLock()
    },
    abort(reason) {
      writer?.releaseLock()
      return abortTarget(reason)
    },
  })
}

const createEncodeTarget = (target: EncodeTarget | undefined): EncodeTargetState => {
  if (target?.mode !== 'stream') {
    return {
      target: new BufferTarget(),
      close: async () => {},
      abort: async () => {},
    }
  }
  let aborted = false
  const abortTarget = async (reason?: unknown) => {
    if (aborted) return
    aborted = true
    await target.abort?.(reason)
  }
  return {
    target: new StreamTarget(createManagedWritable(target, abortTarget), { chunked: true }),
    close: target.close ?? (async () => {}),
    abort: abortTarget,
  }
}

const getBufferTargetBlob = (target: Target, mimeType: string): Blob | undefined => {
  if (!(target instanceof BufferTarget)) return
  if (!target.buffer) return
  return new Blob([target.buffer], { type: mimeType })
}

export async function getSupportedExportAudioFormats(req: ExportAudioSupportRequest = {}): Promise<ExportAudioFormat[]> {
  const sampleRate = req.sampleRate ?? 44100
  const numberOfChannels = req.numberOfChannels ?? 2
  const supportChecks = exportAudioFormats.map(async (format): Promise<ExportAudioFormat | undefined> => {
    const codec = getAudioCodec(format)
    if (format === 'wav') return format
    const canEncode = await canEncodeAudio(codec, {
      sampleRate,
      numberOfChannels,
      bitrate: getDefaultBitrate(format),
    })
    return canEncode ? format : undefined
  })
  const checkedFormats = await Promise.all(supportChecks)
  return checkedFormats.filter((format) => format !== undefined)
}

export async function encodeAudioBuffer(buffer: AudioBuffer, options: EncodeAudioBufferOptions = {}): Promise<ExportResult> {
  const format = options.format ?? 'wav'
  const metadata = getExportAudioFormatMetadata(format)
  const sampleRate = buffer.sampleRate
  const encodeTarget = createEncodeTarget(options.target)
  const output = new Output({ format: createOutputFormat(format), target: encodeTarget.target })
  let sizeBytes = 0
  encodeTarget.target.onwrite = (_start, end) => {
    sizeBytes = Math.max(sizeBytes, end)
    options.onWrite?.(sizeBytes)
  }
  const src = new AudioBufferSource({
    codec: getAudioCodec(format),
    bitrate: options.bitrate ?? getDefaultBitrate(format),
  })
  try {
    output.addAudioTrack(src)
    await output.start()
    await src.add(buffer)
    src.close()
    await output.finalize()
    await encodeTarget.close()
  } catch (error) {
    if (output.state !== 'canceled' && output.state !== 'finalized') {
      try {
        await output.cancel()
      } catch {}
    }
    try {
      await encodeTarget.abort(error)
    } catch {}
    throw error
  }
  const blob = getBufferTargetBlob(encodeTarget.target, metadata.mimeType)
  return {
    audioBuffer: buffer,
    blob,
    format,
    mimeType: metadata.mimeType,
    fileExtension: metadata.fileExtension,
    durationSec: buffer.duration,
    sampleRate,
    sizeBytes: blob?.size ?? sizeBytes,
  }
}
