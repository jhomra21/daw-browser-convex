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
  getAutomationParameterDescriptor,
  type ArpParams,
  type AudioEffectKind,
  type AutomationEnvelope,
  type CompressorParamsLite,
  type DelayParamsLite,
  type DrumRackParams,
  type EqParamsLite,
  type ExportAudioFormat,
  type ReverbParamsLite,
  type SaturatorParamsLite,
  type SynthParamsInput,
  type TrackInstrumentParams,
} from '@daw-browser/shared'
import {
  createExportAudioOutputFormat,
  getExportAudioCodec,
  getExportAudioDefaultBitrate,
} from './export-audio-support'
import { createSynthVoiceOscillators, getSynthVoiceConfig, getSynthVoiceVelocity, scheduleSynthVoiceEnvelope } from './synth-voice'
import { DRUM_RACK_CHOKE_FADE_SEC, scheduleDrumRackHit, type DrumRackResolvedBuffers } from './drum-rack-runtime'
import { createOfflineMixerNodes } from './mixer/apply-offline-routing'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import type { Track } from '@daw-browser/timeline-core/types'
import type { ResolvedMixerGraph } from './mixer/types'
import { scheduleAutomationEnvelope } from './automation'

export type ExportRange =
  | { mode: 'whole' }
  | { mode: 'loop'; startSec: number; endSec: number }
  | { mode: 'custom'; startSec: number; endSec: number }

export type ExportFx = {
  masterVolume?: number
  masterEq?: EqParamsLite
  masterCompressor?: CompressorParamsLite
  masterSaturator?: SaturatorParamsLite
  masterDelay?: DelayParamsLite
  masterReverb?: ReverbParamsLite
  masterFxOrder?: AudioEffectKind[]
  trackFx?: Record<string, { order?: AudioEffectKind[]; eq?: EqParamsLite; compressor?: CompressorParamsLite; saturator?: SaturatorParamsLite; delay?: DelayParamsLite; reverb?: ReverbParamsLite; arp?: ArpParams; synth?: SynthParamsInput; instrument?: TrackInstrumentParams; drumRackBuffers?: DrumRackResolvedBuffers }>
}

export type ExportRequest = {
  tracks: Track<AudioBuffer>[]
  bpm: number
  range: ExportRange
  sampleRate?: number
  numberOfChannels?: number
  signal?: AbortSignal
  fx?: ExportFx
  automationEnvelopes?: AutomationEnvelope[]
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
  exportTrackFx?: ExportFx['trackFx']
  automationEnvelopes: AutomationEnvelope[]
  signal?: AbortSignal
}

type SourceIsolatedRenderOptions = {
  sourceTrackIds?: Set<string>
  includeMasterFx?: boolean
}

type SourceAutomationScope = {
  trackIds?: ReadonlySet<string>
  includeMasterFx: boolean
}

export function isAutomationEnvelopeInSourceScope(
  scope: SourceAutomationScope,
  envelope: AutomationEnvelope,
): boolean {
  if (scope.trackIds && envelope.target.kind === 'track' && !scope.trackIds.has(envelope.target.trackId)) return false
  if (!scope.includeMasterFx && envelope.target.kind === 'master' && envelope.parameterId !== 'volume') return false
  return true
}

type OfflineDrumRackHit = {
  source: AudioBufferSourceNode
  gain: GainNode
  chokeGroup: number
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

const readTrackInstrument = (
  fxCfg: NonNullable<ExportFx['trackFx']>[string] | undefined,
): TrackInstrumentParams | undefined => fxCfg?.instrument

function renderOfflineSynthEvents(input: {
  ctx: OfflineAudioContext
  destination: AudioNode
  events: ReturnType<typeof getScheduledMidiEvents>
  rangeStartSec: number
  synth: SynthParamsInput | undefined
  midi: NonNullable<Track<AudioBuffer>['clips'][number]['midi']>
}) {
  const voice = getSynthVoiceConfig({ synth: input.synth, midi: input.midi })
  for (const event of input.events) {
    const when = Math.max(0, event.startSec - input.rangeStartSec)
    const noteDur = event.endSec - event.startSec
    if (noteDur <= 0) continue

    const oscs = createSynthVoiceOscillators(input.ctx, {
      startTime: when,
      pitch: event.pitch,
      wave1: voice.wave1,
      wave2: voice.wave2,
    })
    const gain = input.ctx.createGain()
    const peakGain = (getSynthVoiceVelocity(event.velocity) * voice.clipGain * voice.synthGain) / oscs.length
    const envelope = scheduleSynthVoiceEnvelope(gain.gain, {
      startTime: when,
      durationSec: noteDur,
      attackSec: voice.attackSec,
      releaseSec: voice.releaseSec,
      peakGain,
    })
    for (const osc of oscs) osc.connect(gain)
    gain.connect(input.destination)
    for (const osc of oscs) {
      try { osc.start(when) } catch {}
      try { osc.stop(envelope.endTime) } catch {}
    }
  }
}

function renderOfflineDrumRackEvents(input: {
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
    const buffer = input.buffers.get(pad.id)
    if (!buffer) continue
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
        buffer,
        pad,
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
      masterCompressor: fx?.masterCompressor,
      masterSaturator: fx?.masterSaturator,
      masterDelay: fx?.masterDelay,
      masterReverb: fx?.masterReverb,
      masterVolume: fx?.masterVolume,
      masterFxOrder: fx?.masterFxOrder,
      trackFx: fx?.trackFx,
    }),
    exportTrackFx: fx?.trackFx,
    automationEnvelopes: req.automationEnvelopes ?? [],
    signal,
  }
}

function collectOutputPathChannelIds(
  channelId: string,
  outputTargetByChannelId: ReadonlyMap<string, string | undefined>,
): string[] {
  const path: string[] = []
  const visited = new Set<string>()
  let currentId: string | undefined = channelId

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    path.push(currentId)
    currentId = outputTargetByChannelId.get(currentId)
  }

  return path
}

export function createSourceAutomationScope(
  graph: ResolvedMixerGraph,
  options: SourceIsolatedRenderOptions,
): SourceAutomationScope {
  const { sourceTrackIds, includeMasterFx = true } = options
  if (!sourceTrackIds) return { includeMasterFx }

  const channelById = new Map(
    graph.channels.map((resolvedTrack) => [resolvedTrack.channel.id, resolvedTrack] as const),
  )
  const outputTargetByChannelId = new Map(
    graph.channels.map((resolvedTrack) => [resolvedTrack.channel.id, resolvedTrack.outputTargetId] as const),
  )
  const scopedTrackIds = new Set<string>()

  const addReachableChannel = (channelId: string, queue: string[]) => {
    if (!channelById.has(channelId) || scopedTrackIds.has(channelId)) return
    scopedTrackIds.add(channelId)
    queue.push(channelId)
  }

  const queue: string[] = []
  for (const sourceTrackId of sourceTrackIds) {
    addReachableChannel(sourceTrackId, queue)
  }

  for (let index = 0; index < queue.length; index += 1) {
    const channelId = queue[index]
    const channel = channelById.get(channelId)
    if (!channel) continue
    const outputPath = collectOutputPathChannelIds(channelId, outputTargetByChannelId)
    for (const pathChannelId of outputPath) addReachableChannel(pathChannelId, queue)
    for (const send of channel.sends) addReachableChannel(send.targetId, queue)
  }

  return { trackIds: scopedTrackIds, includeMasterFx }
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
  const graph = includeMasterFx ? prepared.mixerGraph : { ...prepared.mixerGraph, master: { volume: prepared.mixerGraph.master.volume } }
  const automationScope = createSourceAutomationScope(graph, options)
  const mixerNodes = await createOfflineMixerNodes(ctx, graph, prepared.bpm)
  const { trackNodes } = mixerNodes

  for (const envelope of prepared.automationEnvelopes) {
    if (!envelope.enabled) continue
    if (!isAutomationEnvelopeInSourceScope(automationScope, envelope)) continue
    const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
    const fallback = descriptor?.defaultValue ?? 0
    const bindings = envelope.target.kind === 'master'
      ? mixerNodes.resolveMasterAutomationBindings(envelope.parameterId)
      : mixerNodes.resolveTrackAutomationBindings(envelope.target.trackId, envelope.parameterId)
    scheduleAutomationEnvelope(
      bindings,
      envelope,
      {
        playheadSec: prepared.range.startSec,
        startLimitSec: prepared.range.startSec,
        endLimitSec: prepared.range.endSec,
      },
      (timeSec) => Math.max(0, timeSec - prepared.range.startSec),
      fallback,
    )
  }

  for (const resolvedTrack of graph.channels) {
    const track = prepared.trackById.get(resolvedTrack.channel.id)
    if (!track) continue
    if (sourceTrackIds && !sourceTrackIds.has(track.id)) continue
    const trackInput = trackNodes.get(track.id)?.input
    if (!trackInput) continue
    const fxCfg = resolvedTrack.fx
    const exportFxCfg = prepared.exportTrackFx?.[track.id]
    const instrument = readTrackInstrument(exportFxCfg)
    const drumRackPadsByNote = instrument?.kind === 'drum-rack'
      ? new Map(instrument.params.pads.map((pad) => [pad.note, pad]))
      : undefined
    const activeDrumRackHitsByChokeGroup = new Map<number, OfflineDrumRackHit[]>()

    for (const clip of track.clips) {
      const midi = clip.midi
      if (midi && Array.isArray(midi.notes)) {
        const events = getScheduledMidiEvents({
          clip,
          bpm: prepared.bpm,
          notes: midi.notes,
          rangeStartSec: prepared.range.startSec,
          rangeEndSec: prepared.range.endSec,
          arp: fxCfg?.arp,
        })
        if (instrument?.kind === 'drum-rack' && drumRackPadsByNote) {
          renderOfflineDrumRackEvents({
            ctx,
            destination: trackInput,
            events,
            padsByNote: drumRackPadsByNote,
            rangeStartSec: prepared.range.startSec,
            buffers: exportFxCfg?.drumRackBuffers,
            activeHitsByChokeGroup: activeDrumRackHitsByChokeGroup,
          })
        } else {
          renderOfflineSynthEvents({
            ctx,
            destination: trackInput,
            events,
            rangeStartSec: prepared.range.startSec,
            synth: instrument?.kind === 'synth' ? instrument.params : fxCfg?.synth,
            midi,
          })
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
