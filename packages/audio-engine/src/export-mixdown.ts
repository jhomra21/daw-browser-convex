import {
  Output,
  BufferTarget,
  StreamTarget,
  AudioBufferSource,
  type StreamTargetChunk,
  type Target,
} from 'mediabunny'

import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { connectSourceWithClipGain, getAudioBufferPlaybackParams, getScheduledMidiEvents } from './audio-scheduling'
import { createAudioStretchCache } from './audio-stretch-cache'
import {
  getExportAudioFormatMetadata,
  type ArpParams,
  type EqParamsLite,
  type ExportAudioFormat,
  type ReverbParamsLite,
  type SynthParamsInput,
} from '@daw-browser/shared'
import {
  createExportAudioOutputFormat,
  getExportAudioCodec,
  getExportAudioDefaultBitrate,
} from './export-audio-support'
import { createSynthVoiceOscillators, getSynthVoiceConfig, getSynthVoiceVelocity, scheduleSynthVoiceEnvelope } from './synth-voice'
import { createOfflineMixerNodes } from './mixer/apply-offline-routing'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import type { Track } from '@daw-browser/timeline-core/types'
import type { ResolvedMixerGraph } from './mixer/types'

export type ExportRange =
  | { mode: 'whole' }
  | { mode: 'loop'; startSec: number; endSec: number }
  | { mode: 'custom'; startSec: number; endSec: number }

export type ExportFx = {
  masterEq?: EqParamsLite
  masterReverb?: ReverbParamsLite
  trackFx?: Record<string, { eq?: EqParamsLite; reverb?: ReverbParamsLite; arp?: ArpParams; synth?: SynthParamsInput }>
}

export type ExportRequest = {
  tracks: Track<AudioBuffer>[]
  bpm: number
  range: ExportRange
  sampleRate?: number
  numberOfChannels?: number
  signal?: AbortSignal
  fx?: ExportFx
}

type StemDefinition = {
  id: string
  name: string
  sourceTrackIds: string[]
  includeMasterFx: boolean
}

type RenderedStem = {
  id: string
  name: string
  buffer: AudioBuffer
}

type PreparedExportRange = {
  startSec: number
  endSec: number
  durationSec: number
}

type PreparedExportRender = {
  bpm: number
  range: PreparedExportRange
  sampleRate: number
  numberOfChannels: number
  trackById: Map<string, Track<AudioBuffer>>
  mixerGraph: ResolvedMixerGraph
  signal?: AbortSignal
}

type SourceIsolatedRenderOptions = {
  sourceTrackIds?: Set<string>
  includeMasterFx?: boolean
}

type ExportResult = {
  blob?: Blob
  format: ExportAudioFormat
  durationSec: number
  sampleRate: number
  sizeBytes: number
}

export type EncodeAudioBufferTarget =
  | { mode: 'buffer' }
  | {
    mode: 'stream'
    writable: WritableStream<StreamTargetChunk>
    close?: () => Promise<void>
    abort?: (reason?: unknown) => Promise<void>
  }

type EncodeAudioBufferOptions = {
  format?: ExportAudioFormat
  bitrate?: number
  target?: EncodeAudioBufferTarget
  signal?: AbortSignal
  onWrite?: (sizeBytes: number) => void
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted()
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

function createTrackById(tracks: Track<AudioBuffer>[]): Map<string, Track<AudioBuffer>> {
  const trackById = new Map<string, Track<AudioBuffer>>()
  for (const track of tracks) trackById.set(track.id, track)
  return trackById
}

function prepareExportRender(req: ExportRequest): PreparedExportRender {
  const { tracks, bpm, range, sampleRate = 44100, numberOfChannels = 2, fx, signal } = req
  throwIfAborted(signal)
  const { start, end } = computeRangeSec(tracks, range)
  const durationSec = Math.max(0.001, end - start)
  return {
    bpm,
    range: { startSec: start, endSec: end, durationSec },
    sampleRate,
    numberOfChannels,
    trackById: createTrackById(tracks),
    mixerGraph: resolveMixerGraph({
      channels: createMixerChannels(tracks),
      masterEq: fx?.masterEq,
      masterReverb: fx?.masterReverb,
      trackFx: fx?.trackFx,
    }),
    signal,
  }
}

async function renderSourceIsolatedMixdownFromPrepared(
  prepared: PreparedExportRender,
  options: SourceIsolatedRenderOptions = {},
): Promise<AudioBuffer> {
  const { sourceTrackIds, includeMasterFx = true } = options
  throwIfAborted(prepared.signal)
  const length = Math.ceil(prepared.range.durationSec * prepared.sampleRate)
  const ctx = new OfflineAudioContext(prepared.numberOfChannels, length, prepared.sampleRate)
  const stretchCache = createAudioStretchCache({
    createBuffer: (channels, frames, sampleRate) => ctx.createBuffer(channels, frames, sampleRate),
  })
  const graph = includeMasterFx ? prepared.mixerGraph : { ...prepared.mixerGraph, master: {} }
  const { trackNodes } = createOfflineMixerNodes(ctx, graph)

  for (const resolvedTrack of graph.channels) {
    const track = prepared.trackById.get(resolvedTrack.channel.id)
    if (!track) continue
    if (sourceTrackIds && !sourceTrackIds.has(track.id)) continue
    const trackInput = trackNodes.get(track.id)?.input
    if (!trackInput) continue
    const fxCfg = resolvedTrack.fx

    for (const clip of track.clips) {
      const midi = clip.midi
      if (midi && Array.isArray(midi.notes)) {
        const voice = getSynthVoiceConfig({ synth: fxCfg?.synth, midi })
        const events = getScheduledMidiEvents({
          clip,
          bpm: prepared.bpm,
          notes: midi.notes,
          rangeStartSec: prepared.range.startSec,
          rangeEndSec: prepared.range.endSec,
          arp: fxCfg?.arp,
        })

        for (const event of events) {
          const when = Math.max(0, event.startSec - prepared.range.startSec)
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
      const map = getAudioClipTimeMap({
        clip,
        bufferDurationSec: clip.buffer.duration,
        projectBpm: prepared.bpm,
        rangeStartSec: prepared.range.startSec,
        rangeEndSec: prepared.range.endSec,
      })
      if (!map) continue

      const src = ctx.createBufferSource()
      const stretched = map.mode === 'stretch'
        ? await stretchCache.renderNow(clip, prepared.bpm).catch((error) => {
          throw new Error(`Failed to render Stretch warp for clip "${clip.name}": ${error instanceof Error ? error.message : String(error)}`)
        })
        : null
      const playback = getAudioBufferPlaybackParams({
        sourceBuffer: clip.buffer,
        map,
        stretched: stretched ? { ...stretched, bufferDurationSec: stretched.buffer.duration } : null,
      })
      if (playback.durationSec <= 0) continue
      src.buffer = playback.buffer
      src.playbackRate.value = playback.playbackRate
      connectSourceWithClipGain(ctx, src, trackInput, clip.gain)
      try {
        src.start(
          Math.max(0, map.timelineStartSec - prepared.range.startSec),
          playback.offsetSec,
          playback.durationSec,
        )
      } catch {}
    }
  }

  throwIfAborted(prepared.signal)
  const rendered = await ctx.startRendering()
  throwIfAborted(prepared.signal)
  return rendered
}

export async function renderMixdown(req: ExportRequest): Promise<AudioBuffer> {
  return renderSourceIsolatedMixdownFromPrepared(prepareExportRender(req))
}

export function createStemRenderSession(req: ExportRequest): {
  renderTrackStem: (track: Pick<Track<AudioBuffer>, 'id' | 'name'>) => Promise<AudioBuffer>
} {
  const prepared = prepareExportRender(req)
  return {
    renderTrackStem(track) {
      return renderSourceIsolatedMixdownFromPrepared(prepared, {
        sourceTrackIds: new Set([track.id]),
        includeMasterFx: false,
      })
    },
  }
}

export async function renderStemMixdown(req: ExportRequest & { stem: StemDefinition }): Promise<RenderedStem> {
  const buffer = await renderSourceIsolatedMixdownFromPrepared(prepareExportRender(req), {
    sourceTrackIds: new Set(req.stem.sourceTrackIds),
    includeMasterFx: req.stem.includeMasterFx,
  })
  return { id: req.stem.id, name: req.stem.name, buffer }
}

type EncodeTargetState = {
  target: Target
  close: () => Promise<void>
  abort: (reason?: unknown) => Promise<void>
}

const createManagedWritable = (
  target: Extract<EncodeAudioBufferTarget, { mode: 'stream' }>,
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

const createEncodeTarget = (target: EncodeAudioBufferTarget | undefined): EncodeTargetState => {
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

export async function encodeAudioBuffer(buffer: AudioBuffer, options: EncodeAudioBufferOptions = {}): Promise<ExportResult> {
  const format = options.format ?? 'wav'
  const metadata = getExportAudioFormatMetadata(format)
  const sampleRate = buffer.sampleRate
  const encodeTarget = createEncodeTarget(options.target)
  const output = new Output({ format: createExportAudioOutputFormat(format), target: encodeTarget.target })
  let sizeBytes = 0
  encodeTarget.target.onwrite = (_start, end) => {
    throwIfAborted(options.signal)
    sizeBytes = Math.max(sizeBytes, end)
    options.onWrite?.(sizeBytes)
  }
  const src = new AudioBufferSource({
    codec: getExportAudioCodec(format),
    bitrate: options.bitrate ?? getExportAudioDefaultBitrate(format),
  })
  try {
    throwIfAborted(options.signal)
    output.addAudioTrack(src)
    await output.start()
    throwIfAborted(options.signal)
    await src.add(buffer)
    throwIfAborted(options.signal)
    src.close()
    await output.finalize()
    throwIfAborted(options.signal)
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
    blob,
    format,
    durationSec: buffer.duration,
    sampleRate,
    sizeBytes: blob?.size ?? sizeBytes,
  }
}
