import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { connectSourceWithClipGain, getAudioBufferPlaybackParams, getScheduledMidiEvents } from './audio-scheduling'
import { createAudioStretchCache } from './audio-stretch-cache'
import {
  getAutomationParameterDescriptor,
  assert,
  type ArpParams,
  type AutomationEnvelope,
  type DrumRackParams,
  normalizeSynthParams,
  type SynthParamsInput,
  type SynthAutomationParameterId,
  type TrackInstrumentParams,
  parseInstrumentAutomationKey,
  parseGranularAutomationKey,
  parseSynthAutomationKey,
  SYNTH_AUTOMATION_DESCRIPTORS,
} from '@daw-browser/shared'
import { createSynthOutputChain, scheduleSynthVoice, type SynthVoiceHandle } from './synth-voice'
import { chooseSynthVoiceVictim, isSynthVoiceSoundingAt, pruneSynthVoiceAllocations } from './synth-voice-allocation'
import { DRUM_RACK_CHOKE_FADE_SEC, scheduleDrumRackHit, type DrumRackResolvedBuffers } from './drum-rack-runtime'
import { scheduleSamplerVoice, type SamplerResolvedBuffers } from './sampler-runtime'
import { resetSamplerRoundRobin, selectSamplerZone } from './sampler-core'
import { createGranularRuntime, type GranularInstalledBuffer } from './granular-runtime'
import { createOfflineMixerNodes } from './mixer/apply-offline-routing'
import { createMixerChannels } from './mixer/channels'
import { resolveMixerGraph } from './mixer/resolve-routing'
import type { ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import { normalizeClipFades } from '@daw-browser/timeline-core/clip-fades'
import type { ResolvedMixerGraph } from './mixer/types'
import { scheduleAutomationEnvelope } from './automation'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { getExportRangeBounds, type ExportRange } from './export-range'
import { convertStereoToMonoSample } from './mixer/channel-layout'
import { scanTruePeak } from './true-peak-scanner'
import { observeResource, type ResourceObserver } from './runtime-diagnostics'
export { encodeAudioBuffer, type EncodeAudioBufferOptions, type EncodeAudioBufferTarget } from './export-encoding'

export type { AudioEffectRuntimeInstance }
export type { ExportRange } from './export-range'

export type ExportFx = {
  masterVolume?: number
  masterFxInstances: AudioEffectRuntimeInstance[]
  trackFx?: Record<string, { instances: AudioEffectRuntimeInstance[]; arp?: ArpParams; synth?: SynthParamsInput; instrument?: TrackInstrumentParams; drumRackBuffers?: DrumRackResolvedBuffers; samplerBuffers?: SamplerResolvedBuffers; granularBuffer?: GranularInstalledBuffer }>
}

export type ExportRequest = {
  tracks: Track<AudioBuffer>[]
  bpm: number
  range: ExportRange
  sourceEndSec?: number
  sampleRate?: number
  numberOfChannels?: number
  signal?: AbortSignal
  fx?: ExportFx
  automationEnvelopes?: AutomationEnvelope[]
  sidechainRoutes?: ExternalSidechainRoute[]
  cueTrackIds?: readonly string[]
  resourceObserver?: ResourceObserver
}

export type StemMode =
  | 'dry-source'
  | 'post-track-fx'
  | 'reachable-routing'
  | 'channel-output'
  | 'full-master-contribution'

export type StemDefinition = {
  id: string
  name: string
  mode: StemMode
  targetTrackId: string
}

export type StemRecombinationMetadata = {
  recombinesToMaster: boolean
  conditions: readonly string[]
}

export type RenderedStem = {
  id: string
  name: string
  buffer: AudioBuffer
  metadata: StemRecombinationMetadata
}

type PreparedExportRange = {
  startSec: number
  endSec: number
  sourceEndSec: number
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
  sidechainRoutes: ExternalSidechainRoute[]
  signal?: AbortSignal
  resourceObserver?: ResourceObserver
}

type SourceIsolatedRenderOptions = {
  sourceTrackIds?: ReadonlySet<string>
  detectorOnlyTrackIds?: ReadonlySet<string>
  includeMasterFx?: boolean
  graph?: ResolvedMixerGraph
}

type SourceAutomationScope = {
  trackIds?: ReadonlySet<string>
  includeMasterFx: boolean
}

export function resolveExportLimiterCeilingDbtp(
  graph: ResolvedMixerGraph,
): number | undefined {
  const ceilings: number[] = []
  for (const instance of graph.master.instances) {
    if (instance.kind === 'limiter' && instance.params.state.enabled) {
      ceilings.push(instance.params.state.ceilingDbtp)
    }
  }
  return ceilings.length === 0 ? undefined : Math.min(...ceilings)
}

export function assertExportTruePeakWithinLimiterCeiling(
  buffer: {
    numberOfChannels: number
    length: number
    getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
  },
  ceilingDbtp: number | undefined,
  signal?: AbortSignal,
): void {
  if (ceilingDbtp === undefined) return
  const measured = scanTruePeak(buffer, signal)
  if (measured.peakDbtp > ceilingDbtp + 0.1) {
    throw new Error(
      `Export true peak ${measured.peakDbtp.toFixed(2)} dBTP exceeds the reachable limiter ceiling ${ceilingDbtp.toFixed(2)} dBTP (+0.10 dB tolerance).`,
    )
  }
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

type AudioSampleBuffer = Pick<AudioBuffer, 'numberOfChannels' | 'getChannelData'>
type StereoSampleBuffer = Pick<AudioBuffer, 'numberOfChannels' | 'length' | 'sampleRate' | 'getChannelData'>

export const getAudioBufferPeak = (buffer: AudioSampleBuffer): number => {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) {
      const sample = Math.abs(data[index])
      if (Number.isFinite(sample)) peak = Math.max(peak, sample)
    }
  }
  return peak
}

export const normalizeAudioBufferInPlace = (buffer: AudioSampleBuffer): number => {
  const peak = getAudioBufferPeak(buffer)
  if (peak === 0 || peak === 1) return 1
  const gain = 1 / peak
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) {
      data[index] *= gain
    }
  }
  return gain
}

export const downmixStereoBufferToMono = <Buffer extends StereoSampleBuffer>(
  buffer: StereoSampleBuffer,
  createBuffer: (channels: number, length: number, sampleRate: number) => Buffer,
): Buffer => {
  if (buffer.numberOfChannels === 1) {
    const mono = createBuffer(1, buffer.length, buffer.sampleRate)
    mono.getChannelData(0).set(buffer.getChannelData(0))
    return mono
  }
  const mono = createBuffer(1, buffer.length, buffer.sampleRate)
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  const output = mono.getChannelData(0)
  for (let index = 0; index < output.length; index += 1) {
    output[index] = convertStereoToMonoSample(left[index], right[index])
  }
  return mono
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted()
}

const readTrackInstrument = (
  fxCfg: NonNullable<ExportFx['trackFx']>[string] | undefined,
): TrackInstrumentParams | undefined => fxCfg?.instrument

function createOfflineSynthTrack(input: {
  ctx: OfflineAudioContext
  destination: AudioNode
  rangeStartSec: number
  synth: SynthParamsInput | undefined
  automationEnvelopes: readonly AutomationEnvelope[]
}) {
  const synth = normalizeSynthParams(input.synth)
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

function renderOfflineSamplerEvents(input: {
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
    const buffer = input.buffers.get(selected.zone.id)
    if (!buffer) throw new Error(`Sampler export is missing buffer for zone "${selected.zone.id}".`)
    scheduleSamplerVoice({
      ctx: input.ctx,
      destination: input.destination,
      buffer,
      zone: selected.zone,
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

async function createOfflineGranularTrack(input: {
  ctx: OfflineAudioContext
  destination: AudioNode
  instrument: Extract<TrackInstrumentParams, { kind: 'granular' }>
  installedBuffer: GranularInstalledBuffer | undefined
  resourceObserver?: ResourceObserver
}) {
  if (!input.installedBuffer) throw new Error('Granular export requires a preloaded sample.')
  const runtime = await createGranularRuntime({
    context: input.ctx,
    destination: input.destination,
    params: input.instrument.params,
    resourceObserver: input.resourceObserver,
  })
  try {
    await runtime.installSample(input.installedBuffer)
    runtime.resetSeed(input.instrument.params.seed)
    runtime.setFrozen(input.instrument.params.freeze)
    return runtime
  } catch (error) {
    runtime.close()
    throw error
  }
}

function createTrackById(tracks: Track<AudioBuffer>[]): Map<string, Track<AudioBuffer>> {
  const trackById = new Map<string, Track<AudioBuffer>>()
  for (const track of tracks) trackById.set(track.id, track)
  return trackById
}

const snapshotTracks = (tracks: Track<AudioBuffer>[]): Track<AudioBuffer>[] => tracks.map((track) => ({
  ...track,
  sends: track.sends?.map((send) => ({ ...send })),
  clips: track.clips.map((clip) => ({
    ...clip,
    audioWarp: clip.audioWarp ? { ...clip.audioWarp } : undefined,
    midi: clip.midi ? {
      ...clip.midi,
      notes: clip.midi.notes.map((note) => ({ ...note })),
    } : undefined,
  })),
}))

const snapshotAutomation = (envelopes: readonly AutomationEnvelope[]): AutomationEnvelope[] =>
  envelopes.map((envelope) => ({
    ...envelope,
    target: { ...envelope.target },
    points: envelope.points.map((point) => ({ ...point })),
  }))

const snapshotInstrument = (instrument: TrackInstrumentParams): TrackInstrumentParams => {
  if (instrument.kind === 'drum-rack') {
    return { ...instrument, params: { ...instrument.params, pads: instrument.params.pads.map((pad) => ({ ...pad })) } }
  }
  if (instrument.kind === 'sampler') {
    return {
      ...instrument,
      params: {
        ...instrument.params,
        zones: instrument.params.zones.map((zone) => ({ ...zone, sample: { ...zone.sample } })),
      },
    }
  }
  if (instrument.kind === 'granular') {
    return {
      ...instrument,
      params: {
        ...instrument.params,
        zone: instrument.params.zone
          ? { ...instrument.params.zone, sample: { ...instrument.params.zone.sample } }
          : undefined,
      },
    }
  }
  return { ...instrument, params: { ...instrument.params } }
}

const snapshotTrackFx = (trackFx: ExportFx['trackFx']): ExportFx['trackFx'] => {
  if (!trackFx) return undefined
  return Object.fromEntries(Object.entries(trackFx).map(([trackId, entry]) => [
    trackId,
    {
      ...entry,
      instances: [...entry.instances],
      instrument: entry.instrument ? snapshotInstrument(entry.instrument) : undefined,
    },
  ]))
}

export function resolveExportMixerGraph(req: Pick<ExportRequest, 'tracks' | 'fx'>): ResolvedMixerGraph {
  const { tracks, fx } = req
  return resolveMixerGraph({
    channels: createMixerChannels(tracks),
    sourceChannelCounts: Object.fromEntries(tracks.map((track) => [
      track.id,
      track.clips.flatMap((clip) => clip.buffer ? [clip.buffer.numberOfChannels] : []),
    ])),
    masterFxInstances: fx?.masterFxInstances ?? [],
    trackFx: fx?.trackFx,
  })
}

function prepareExportRender(req: ExportRequest): PreparedExportRender {
  const { bpm, range, sampleRate = 44100, numberOfChannels = 2, fx, signal } = req
  const tracks = snapshotTracks(req.tracks)
  throwIfAborted(signal)
  if (req.cueTrackIds && req.cueTrackIds.length > 0) {
    throw new Error('Cue routing is live-only and cannot be exported.')
  }
  const { startSec, endSec } = getExportRangeBounds(tracks, range)
  const sourceEndSec = Math.min(endSec, req.sourceEndSec ?? endSec)
  const durationSec = endSec - startSec
  return {
    bpm,
    range: { startSec, endSec, sourceEndSec, durationSec },
    sampleRate,
    numberOfChannels,
    trackById: createTrackById(tracks),
    mixerGraph: resolveExportMixerGraph({ tracks, fx }),
    exportTrackFx: snapshotTrackFx(fx?.trackFx),
    automationEnvelopes: snapshotAutomation(req.automationEnvelopes ?? []),
    sidechainRoutes: (req.sidechainRoutes ?? []).map((route) => ({ ...route })),
    signal,
    resourceObserver: req.resourceObserver,
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

const emptyMasterFx = (graph: ResolvedMixerGraph): ResolvedMixerGraph['master'] => ({
  volume: 1,
  instances: [],
  inputLayout: graph.master.inputLayout,
  outputLayout: graph.master.inputLayout,
})

const collectReachableChannelIds = (
  graph: ResolvedMixerGraph,
  sourceTrackIds: ReadonlySet<string>,
): Set<string> => new Set(createSourceAutomationScope(graph, {
  sourceTrackIds,
  includeMasterFx: false,
}).trackIds ?? [])

const collectUpstreamChannelIds = (
  graph: ResolvedMixerGraph,
  targetTrackId: string,
): Set<string> => {
  const upstream = new Set([targetTrackId])
  let changed = true
  while (changed) {
    changed = false
    for (const channel of graph.channels) {
      if (upstream.has(channel.channel.id)) continue
      if (channel.outputTargetId && upstream.has(channel.outputTargetId)) {
        upstream.add(channel.channel.id)
        changed = true
        continue
      }
      if (channel.sends.some((send) => upstream.has(send.targetId))) {
        upstream.add(channel.channel.id)
        changed = true
      }
    }
  }
  return upstream
}

export type StemRenderPlan = {
  sourceTrackIds: Set<string>
  detectorOnlyTrackIds: Set<string>
  graph: ResolvedMixerGraph
  metadata: StemRecombinationMetadata
}

export function createStemRenderPlan(
  graph: ResolvedMixerGraph,
  stem: StemDefinition,
  sidechainRoutes: readonly ExternalSidechainRoute[] = [],
): StemRenderPlan {
  const target = graph.channels.find((channel) => channel.channel.id === stem.targetTrackId)
  assert(target, `Missing stem target ${stem.targetTrackId}`)
  if (stem.mode === 'channel-output') {
    assert(target.channel.role === 'group' || target.channel.role === 'return', 'Channel-output stems require a group or return target.')
  } else {
    assert(target.channel.role === 'track', `${stem.mode} stems require a source track target.`)
  }

  const sourceTrackIds = stem.mode === 'channel-output'
    ? collectUpstreamChannelIds(graph, stem.targetTrackId)
    : new Set([stem.targetTrackId])
  const reachableIds = collectReachableChannelIds(graph, sourceTrackIds)
  const detectorOnlyTrackIds = new Set<string>()
  for (const route of sidechainRoutes) {
    if (reachableIds.has(route.targetTrackId) && !sourceTrackIds.has(route.sourceTrackId)) {
      detectorOnlyTrackIds.add(route.sourceTrackId)
    }
  }

  const graphForMode: ResolvedMixerGraph = {
    channels: graph.channels.map((channel) => {
      const id = channel.channel.id
      if (detectorOnlyTrackIds.has(id)) {
        return { ...channel, outputGain: 0, sends: [] }
      }
      if (stem.mode === 'dry-source') {
        const audible = !channel.channel.muted && channel.outputGain > 0
        return {
          ...channel,
          gain: id === stem.targetTrackId && audible ? 1 : 0,
          outputGain: id === stem.targetTrackId && audible ? 1 : 0,
          outputTargetId: undefined,
          sends: [],
          fx: undefined,
        }
      }
      if (stem.mode === 'post-track-fx') {
        return {
          ...channel,
          outputGain: id === stem.targetTrackId ? channel.outputGain : 0,
          outputTargetId: id === stem.targetTrackId ? undefined : channel.outputTargetId,
          sends: [],
        }
      }
      if (stem.mode === 'channel-output') {
        return {
          ...channel,
          outputGain: id === stem.targetTrackId ? channel.outputGain : channel.outputGain,
          outputTargetId: id === stem.targetTrackId ? undefined : channel.outputTargetId,
          sends: id === stem.targetTrackId ? [] : channel.sends,
        }
      }
      return channel
    }),
    master: stem.mode === 'full-master-contribution' ? graph.master : emptyMasterFx(graph),
  }
  const nonlinearMaster = graph.master.instances.some((instance) =>
    instance.kind === 'compressor' || instance.kind === 'saturator' || instance.kind === 'limiter' || instance.kind === 'gate',
  )
  return {
    sourceTrackIds,
    detectorOnlyTrackIds,
    graph: graphForMode,
    metadata: {
      recombinesToMaster: stem.mode !== 'full-master-contribution' || !nonlinearMaster,
      conditions: stem.mode === 'full-master-contribution'
        ? nonlinearMaster
          ? ['Shared nonlinear master processing prevents linear stem recombination.']
          : ['Master processing must remain linear and stem normalization must be disabled.']
        : ['Export every required stem over the same range with normalization disabled.'],
    },
  }
}

async function renderSourceIsolatedMixdownFromPrepared(
  prepared: PreparedExportRender,
  options: SourceIsolatedRenderOptions = {},
): Promise<AudioBuffer> {
  const { sourceTrackIds, includeMasterFx = true } = options
  throwIfAborted(prepared.signal)
  const length = Math.ceil(prepared.range.durationSec * prepared.sampleRate)
  const renderChannelCount = prepared.numberOfChannels === 1 ? 2 : prepared.numberOfChannels
  const ctx = new OfflineAudioContext(renderChannelCount, length, prepared.sampleRate)
  const releaseContext = observeResource(prepared.resourceObserver, 'audio-contexts', ctx)
  const stretchCache = createAudioStretchCache({
    createBuffer: (channels, frames, sampleRate) => ctx.createBuffer(channels, frames, sampleRate),
  })
  const graph = options.graph ?? (includeMasterFx ? prepared.mixerGraph : {
    ...prepared.mixerGraph,
    master: {
      volume: prepared.mixerGraph.master.volume,
      instances: [],
      inputLayout: prepared.mixerGraph.master.inputLayout,
      outputLayout: prepared.mixerGraph.master.inputLayout,
    },
  })
  const automationScope = createSourceAutomationScope(graph, options)
  const mixerNodes = await createOfflineMixerNodes(
    ctx,
    graph,
    prepared.bpm,
    prepared.sidechainRoutes,
    options.detectorOnlyTrackIds,
  ).catch((error: unknown) => {
    releaseContext()
    throw error
  })
  const { trackNodes } = mixerNodes
  const granularRuntimes: Array<Awaited<ReturnType<typeof createGranularRuntime>>> = []

  try {
    for (const envelope of prepared.automationEnvelopes) {
      if (!envelope.enabled) continue
      if (!isAutomationEnvelopeInSourceScope(automationScope, envelope)) continue
      const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
      const fallback = descriptor?.defaultValue ?? 0
      const bindings = envelope.target.kind === 'master'
        ? mixerNodes.resolveMasterAutomationBindings(envelope.target, envelope.parameterId)
        : mixerNodes.resolveTrackAutomationBindings(envelope.target, envelope.parameterId)
      scheduleAutomationEnvelope(
        bindings,
        envelope,
        {
          playheadSec: prepared.range.startSec,
          startLimitSec: prepared.range.startSec,
          endLimitSec: prepared.range.sourceEndSec,
        },
        (timeSec) => Math.max(0, timeSec - prepared.range.startSec),
        fallback,
      )
    }

    for (const resolvedTrack of graph.channels) {
      const track = prepared.trackById.get(resolvedTrack.channel.id)
      assert(track, `Missing prepared export track ${resolvedTrack.channel.id}`)
      if (sourceTrackIds && !sourceTrackIds.has(track.id) && !options.detectorOnlyTrackIds?.has(track.id)) continue
      const trackInput = trackNodes.get(track.id)?.input
      assert(trackInput, `Missing offline track input ${track.id}`)
      const fxCfg = resolvedTrack.fx
      const exportFxCfg = prepared.exportTrackFx?.[track.id]
      const instrument = readTrackInstrument(exportFxCfg)
      const drumRackPadsByNote = instrument?.kind === 'drum-rack'
        ? new Map(instrument.params.pads.map((pad) => [pad.note, pad]))
        : undefined
      const activeDrumRackHitsByChokeGroup = new Map<number, OfflineDrumRackHit[]>()
      const granularRuntime = instrument?.kind === 'granular'
        ? await createOfflineGranularTrack({
          ctx,
          destination: trackInput,
          instrument,
          installedBuffer: exportFxCfg?.granularBuffer,
          resourceObserver: prepared.resourceObserver,
        })
        : undefined
      if (granularRuntime) granularRuntimes.push(granularRuntime)
      const synthParams = instrument?.kind === 'synth'
        ? instrument.params
        : instrument
          ? undefined
          : fxCfg?.synth
      const synthTrack = synthParams || (!instrument && synthParams === undefined && track.kind === 'instrument')
        ? createOfflineSynthTrack({
            ctx,
            destination: trackInput,
            rangeStartSec: prepared.range.startSec,
            synth: synthParams,
            automationEnvelopes: prepared.automationEnvelopes.filter((envelope) => {
              const key = parseSynthAutomationKey(envelope.parameterId)
              return key?.trackId === track.id && key.instanceId === (instrument?.kind === 'synth' ? instrument.instanceId : undefined)
            }),
          })
        : undefined
      if (synthTrack) {
        const events = track.clips.flatMap((clip) => {
          const midi = clip.midi
          if (!midi || !Array.isArray(midi.notes)) return []
          return getScheduledMidiEvents({
            clip,
            bpm: prepared.bpm,
            notes: midi.notes,
            rangeStartSec: prepared.range.startSec,
            rangeEndSec: prepared.range.sourceEndSec,
            arp: fxCfg?.arp,
          }).map((event) => ({ ...event, clipGain: midi.gain }))
        }).toSorted((left, right) => left.startSec - right.startSec)
        synthTrack.scheduleEvents(events)
      }

      for (const clip of track.clips) {
        const midi = clip.midi
        if (midi && Array.isArray(midi.notes)) {
          const events = getScheduledMidiEvents({
            clip,
            bpm: prepared.bpm,
            notes: midi.notes,
            rangeStartSec: prepared.range.startSec,
            rangeEndSec: prepared.range.sourceEndSec,
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
          } else if (instrument?.kind === 'sampler') {
            renderOfflineSamplerEvents({
              ctx,
              destination: trackInput,
              events,
              rangeStartSec: prepared.range.startSec,
              instrument,
              buffers: exportFxCfg?.samplerBuffers,
              automationEnvelopes: prepared.automationEnvelopes.filter((envelope) => (
                parseInstrumentAutomationKey(envelope.parameterId)?.trackId === track.id
              )),
            })
          } else if (instrument?.kind === 'granular' && granularRuntime) {
            const automationEnvelopes = prepared.automationEnvelopes.filter((envelope) => (
              parseGranularAutomationKey(envelope.parameterId)?.trackId === track.id
            ))
            for (const event of events) {
              granularRuntime.scheduleNote({
                when: Math.max(0, event.startSec - prepared.range.startSec),
                durationSec: event.endSec - event.startSec,
                timelineStartSec: event.startSec,
                timelineToCtxTime: (timelineSec) => Math.max(0, timelineSec - prepared.range.startSec),
                automationEnvelopes,
              })
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
          rangeEndSec: prepared.range.sourceEndSec,
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
        connectSourceWithClipGain(ctx, src, trackInput, clip.gain, {
          fades: normalizeClipFades(clip.fades, clip.duration),
          clipStartSec: clip.startSec,
          clipDurationSec: clip.duration,
          timelineStartSec: map.timelineStartSec,
          timelineEndSec: map.timelineEndSec,
          contextStartTime: Math.max(0, map.timelineStartSec - prepared.range.startSec),
        })
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
    mixerNodes.assertCompressorProcessorsHealthy()
    throwIfAborted(prepared.signal)
    const output = prepared.numberOfChannels !== 1 || rendered.numberOfChannels === 1
      ? rendered
      : downmixStereoBufferToMono(
      rendered,
      (channels, frames, sampleRate) => ctx.createBuffer(channels, frames, sampleRate),
    )
    assertExportTruePeakWithinLimiterCeiling(
      output,
      resolveExportLimiterCeilingDbtp(graph),
      prepared.signal,
    )
    return output
  } finally {
    for (const runtime of granularRuntimes) runtime.close()
    mixerNodes.dispose()
    releaseContext()
  }
}

export async function renderMixdown(req: ExportRequest): Promise<AudioBuffer> {
  return renderSourceIsolatedMixdownFromPrepared(prepareExportRender(req))
}

export function createStemRenderSession(req: ExportRequest): {
  renderStem: (stem: StemDefinition) => Promise<RenderedStem>
} {
  const prepared = prepareExportRender(req)
  return {
    async renderStem(stem) {
      const plan = createStemRenderPlan(prepared.mixerGraph, stem, prepared.sidechainRoutes)
      const buffer = await renderSourceIsolatedMixdownFromPrepared(prepared, {
        sourceTrackIds: plan.sourceTrackIds,
        detectorOnlyTrackIds: plan.detectorOnlyTrackIds,
        graph: plan.graph,
      })
      return { id: stem.id, name: stem.name, buffer, metadata: plan.metadata }
    },
  }
}

export async function renderStemMixdown(req: ExportRequest & { stem: StemDefinition }): Promise<RenderedStem> {
  return createStemRenderSession(req).renderStem(req.stem)
}