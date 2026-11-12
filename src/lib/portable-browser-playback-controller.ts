import {
  selectPortableWasmAudioWorkletBackend,
  portableWasmPagedPreparationCount,
  type PortableWasmCapability,
  type PortableWasmBackendSelection,
  type PortableWasmPlaybackSession,
  WasmAudioWorkletBackend,
} from "@daw-browser/audio-engine/wasm-audio-worklet-backend"
import { LIVE_SCHEDULE_HORIZON_SEC } from "@daw-browser/audio-engine/audio-engine"
import type { AudioAssetRef, AudioCoreGraphSnapshot, PlanarPcm } from "@daw-browser/audio-core-contract"
import type {
  PreparedPortableSession,
  PortableAssetRegistryInput,
  PortablePreparedQualification,
} from "@daw-browser/audio-engine/portable-session-compiler"
import {
  portableWasmPagedMaxChannels,
  portableWasmPagedPageFrames,
  portableWasmPagedSlotCount,
  portableWasmProtocolVersion,
  type PortableWasmPreparedSourceEvent,
  type PortableWasmStatusMessage,
  type PortableWasmInstrumentEvent,
} from "@daw-browser/audio-engine/portable-wasm-protocol"
import { RECORDER_BLOCK_FRAMES, RECORDER_MAX_QUEUED_BLOCKS } from "@daw-browser/audio-engine/recording-protocol"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import { arrangementFrameForLoop, effectiveLoopForStart, loopFramesForTransport, type LoopFrames } from "@daw-browser/audio-engine/loop-frame-schedule"
import { compilePreparedPortableLiveSession } from "~/lib/portable-live-session"
import type { LivePlaybackCompileContext, LivePlaybackSnapshot, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from "~/lib/live-playback-snapshot"
import { createPortableRecordingWriter } from "~/lib/recording/portable-recording-writer"
import type {
  LiveProcessorControl,
  LiveProcessorControlRequest,
  LiveProcessorControlResult,
} from "~/lib/live-processor-control"
import type { PortablePreparedStretchAsset } from "@daw-browser/audio-engine/portable-stretch-preparation"
import {
  preparePortablePagedStretchAssets,
  type PortablePagedStretchAsset,
} from "@daw-browser/audio-engine/portable-stretch-paging"
import {
  createPreparedStretchArtifactRepository,
  type PreparedStretchArtifactRepository,
} from "@daw-browser/audio-engine/prepared-stretch-store"
import type { AudioPcmSourceResolver } from "~/lib/audio-pcm-source-resolver"
import { isLiveEventOnlyInstrumentChange, isLiveParameterChange, mapNativeBuiltInParameterCommit, nativeBuiltInLiveStateCovered } from "~/lib/desktop/native-built-in-parameter-mapper"
import {
  mergeSynthParams, normalizeTrackInstrumentParams, parseJsonValue,
  type AudioPcmSourceDescriptor, type DecodedAudioPage, type SynthParamsUpdate, type TrackInstrumentParams,
} from "@daw-browser/shared"
import type { AudioEffectRuntimeInstance } from "@daw-browser/audio-engine/audio-engine"
import { createAudioEffectParameterPayload } from "~/components/timeline/audio-effect-parameter-payload"

type PortableStartResult = "started" | "unavailable"
export type PortableAdoptionResult = "adopted" | "unchanged" | "rebuild" | "failed" | "unavailable"
type PortablePreparedStretch = PortablePreparedStretchAsset | PortablePagedStretchAsset
type PortableOrdinaryDescriptor = {
  asset: AudioAssetRef
  descriptor: AudioPcmSourceDescriptor
}
type PortableScheduleRange = Extract<PreparedPortableSession, { supported: true }>["scheduleRange"]
type PortableSchedule = Extract<PreparedPortableSession, { supported: true }>["schedule"]
type PortableSessionFault = {
  error?: Error
}

type PortableSession = Pick<
  PortableWasmPlaybackSession,
  | "connectInput" | "dispose" | "installSchedule" | "markActive" | "onFault" | "onRecordingStatus" | "postRecordingControl" | "prepareGraph" | "publishGraph" | "registerAsset" | "scheduleSources" | "setTransport"
> & {
  pagedCapabilities?: PortableWasmPlaybackSession["pagedCapabilities"]
  registerPagedAsset?: PortableWasmPlaybackSession["registerPagedAsset"]
  writeAssetPage?: PortableWasmPlaybackSession["writeAssetPage"]
  prepareAssetRange?: PortableWasmPlaybackSession["prepareAssetRange"]
  schedulePreparedSources?: PortableWasmPlaybackSession["schedulePreparedSources"]
  replaceSources?: PortableWasmPlaybackSession["replaceSources"]
  resetSources?: PortableWasmPlaybackSession["resetSources"]
  releaseAssetPreparation?: PortableWasmPlaybackSession["releaseAssetPreparation"]
  trimAssetPages?: PortableWasmPlaybackSession["trimAssetPages"]
  queueProcessorEvents?: PortableWasmPlaybackSession["queueProcessorEvents"]
  queueInstrumentEvents?: PortableWasmPlaybackSession["queueInstrumentEvents"]
  reenableProcessorAutomation?: PortableWasmPlaybackSession["reenableProcessorAutomation"]
  onTransportPosition?: PortableWasmPlaybackSession["onTransportPosition"]
  onGraphContinuity?: PortableWasmPlaybackSession["onGraphContinuity"]
}

const isPagedStretchAsset = (
  asset: PortablePreparedStretch,
): asset is PortablePagedStretchAsset => "manifest" in asset

type PortableBackend = {
  createPlaybackSession: (
    context: BaseAudioContext,
    capability: Extract<PortableWasmCapability, { available: true }>,
    maxFramesPerBlock: number,
  ) => Promise<PortableSession>
}

const portableRecordingControlTimeoutMs = 2_000
const maxAdoptionResubmits = 8
// The native portable core reserves this fixed preparation table. It is not
// part of the wire capability payload, so the backend exposes the local
// default alongside the runtime paged capabilities.
const portablePagedPreparationCapacity = portableWasmPagedPreparationCount
export type PortableRecordingDiagnostics = Extract<PortableWasmStatusMessage, { type: "recording-capture-diagnostics" }>

const deferred = <T>() => {
  let resolve = (_value: T) => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const boundedControl = <T>(promise: Promise<T>, message: string) => new Promise<T>((resolve, reject) => {
  // Control acknowledgements are bounded so a lost worklet cannot leave input
  // monitoring or MediaStream resources active indefinitely.
  const deadline = setTimeout(() => reject(new Error(message)), portableRecordingControlTimeoutMs)
  promise.then((value) => {
    clearTimeout(deadline)
    resolve(value)
  }, (cause: unknown) => {
    clearTimeout(deadline)
    reject(cause)
  })
})

const planarPcm = (buffer: AudioBuffer): PlanarPcm => ({
  frameCount: buffer.length,
  planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel)),
})

const instrumentAssetKeys = (snapshot: LivePlaybackSnapshot) => new Set(
  Object.values(snapshot.mixer.fx.trackFx ?? {}).flatMap((entry) => {
    if (entry.instrument?.kind === 'sampler') {
      return entry.instrument.params.zones.map((zone) => zone.sample.assetKey)
    }
    if (entry.instrument?.kind === 'drum-rack') {
      return entry.instrument.params.pads.flatMap((pad) => pad.sample ? [pad.sample.assetKey] : [])
    }
    if (entry.instrument?.kind === 'granular' && entry.instrument.params.zone) {
      return [entry.instrument.params.zone.sample.assetKey]
    }
    return []
  }),
)

const unavailableInstrumentAssetKeys = (snapshot: LivePlaybackSnapshot) => [
  ...new Set(Object.values(snapshot.mixer.fx.trackFx ?? {}).flatMap(
    (entry) => entry.unavailableSampleAssetKeys ?? [],
  )),
]

const isInstalledSnapshotAsset = (
  snapshot: LivePlaybackSnapshot,
  assetId: string,
  instrumentKeys: ReadonlySet<string>,
) => {
  const usedByStretch = snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.sourceAssetKey === assetId
    && clip.audioWarp?.enabled === true
    && clip.audioWarp.mode === 'stretch'
  )))
  const usedByInstalledSource = snapshot.tracks.some((track) => track.clips.some((clip) => (
    clip.sourceAssetKey === assetId
    && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch')
  )))
  return !usedByStretch || usedByInstalledSource || instrumentKeys.has(assetId)
}

// The transport counts raw frames straight on through a loop. A segment says how to read raw frames from `fromFrame` on
// as arrangement frames: the loop in raw frames, and how far raw runs ahead of the arrangement (an adopted loop edit
// moves the seam to an arrangement position that is not its raw frame).
type PositionSegment = { fromFrame: number; loop: LoopFrames | undefined; deltaFrames: number }

const positionSegmentIndex = (segments: readonly PositionSegment[], frame: number) =>
  Math.max(0, segments.findLastIndex((segment) => segment.fromFrame <= frame))

const arrangementFrameAt = (segments: readonly PositionSegment[], frame: number) => {
  const segment = segments[positionSegmentIndex(segments, frame)]
  return segment ? arrangementFrameForLoop(frame, segment.loop) - segment.deltaFrames : frame
}

const initialPositionSegments = (transport: LivePlaybackTransport, sampleRateHz: number): PositionSegment[] =>
  [{ fromFrame: 0, loop: loopFramesForTransport(transport, sampleRateHz), deltaFrames: 0 }]

type AdoptionLoop = Pick<LivePlaybackTransport, "loopEnabled" | "loopStartSec" | "loopEndSec">

const assetRegistry = (
  snapshot: LivePlaybackSnapshot,
  generation: number,
  preparedStretchAssets: readonly PortablePreparedStretch[] = [],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
): PortableAssetRegistryInput => ({
  projectGeneration: generation,
  unavailableProjectAssetIds: unavailableInstrumentAssetKeys(snapshot),
  assets: [
    ...(() => {
      const instrumentKeys = instrumentAssetKeys(snapshot)
      return snapshot.assets.flatMap((asset) => {
        const buffer = asset.buffer
        const descriptor = ordinaryDescriptors.get(asset.assetId)
        if ((!buffer && !descriptor) || !isInstalledSnapshotAsset(snapshot, asset.assetId, instrumentKeys)) return []
        if (!buffer && instrumentKeys.has(asset.assetId)) return []
        return [{
          projectAssetId: asset.assetId,
          portableAssetId: asset.assetId,
          projectGeneration: generation,
          handle: { slot: 0, generation },
          decoded: {
            sampleRateHz: buffer?.sampleRate ?? descriptor?.descriptor.sampleRate ?? 0,
            channelCount: buffer?.numberOfChannels ?? descriptor?.descriptor.channelCount ?? 0,
            frameCount: buffer?.length ?? descriptor?.descriptor.frameCount ?? 0,
          },
        }]
      }).map((entry, slot) => ({ ...entry, handle: { ...entry.handle, slot } }))
    })(),
    ...[...new Map(preparedStretchAssets.map((prepared) => [prepared.portableAssetId, prepared])).values()]
      .map((prepared, slot) => ({
        projectAssetId: prepared.projectAssetId,
        portableAssetId: prepared.portableAssetId,
        projectGeneration: generation,
        handle: { slot: installedSnapshotAssetCount(snapshot, ordinaryDescriptors) + slot, generation },
        decoded: {
          sampleRateHz: prepared.asset.sampleRateHz,
          channelCount: prepared.asset.channelCount,
          frameCount: prepared.asset.frameCount,
        },
      })),
  ],
})

const installedSnapshotAssetCount = (
  snapshot: LivePlaybackSnapshot,
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
) => {
  const instrumentKeys = instrumentAssetKeys(snapshot)
  return snapshot.assets.reduce((count, asset) => {
    if (!asset.buffer && !ordinaryDescriptors.has(asset.assetId)) return count
    return count + (isInstalledSnapshotAsset(snapshot, asset.assetId, instrumentKeys) ? 1 : 0)
  }, 0)
}

const resolveOrdinaryDescriptors = async (
  snapshot: LivePlaybackSnapshot,
  resolveSource: AudioPcmSourceResolver | undefined,
  signal?: AbortSignal,
) => {
  const clipsByAsset = new Map<string, LivePlaybackSnapshot["tracks"][number]["clips"][number]>()
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      if (clip.sourceAssetKey
        && !clip.midi
        && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === "stretch")) {
        clipsByAsset.set(clip.sourceAssetKey, clip)
      }
    }
  }
  const descriptors = new Map<string, PortableOrdinaryDescriptor>()
  for (const asset of snapshot.assets) {
    if (asset.buffer || !clipsByAsset.has(asset.assetId)) continue
    if (!resolveSource) throw new Error(`Audio asset "${asset.assetId}" has no source resolver.`)
    const clip = clipsByAsset.get(asset.assetId)
    if (!clip) continue
    signal?.throwIfAborted()
    const descriptor = await resolveSource(clip, signal)
    if (descriptor.frameCount <= 0 || descriptor.channelCount > portableWasmPagedMaxChannels) {
      throw new Error(`Portable audio asset "${asset.assetId}" has incompatible paged metadata.`)
    }
    if (asset.source && (
      descriptor.sampleRate !== asset.source.sampleRate
      || descriptor.channelCount !== asset.source.channelCount
      || descriptor.frameCount !== Math.round(asset.source.durationSec * asset.source.sampleRate)
    )) throw new Error(`Portable audio asset "${asset.assetId}" descriptor metadata is inconsistent.`)
    descriptors.set(asset.assetId, {
      asset: {
        version: 1,
        assetId: asset.assetId,
        frameCount: descriptor.frameCount,
        sampleRateHz: descriptor.sampleRate,
        channelCount: descriptor.channelCount,
      },
      descriptor,
    })
  }
  return descriptors
}

const preparedSession = (
  snapshot: LivePlaybackSnapshot,
  sampleRateHz: number,
  epoch: number,
  projectGeneration: number,
  horizonSec: number,
  sourceFirstSequence = 1,
  preparedStretchAssets: readonly PortablePreparedStretch[] = [],
  sourceRangeStartSec?: number,
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map(),
  // The raw frame that plays the playhead, when it is not the playhead's own frame (see PositionSegment).
  originFrame = Math.round(snapshot.transport.playheadSec * sampleRateHz),
): PreparedPortableSession => compilePreparedPortableLiveSession(snapshot, {
  assetRegistry: assetRegistry(snapshot, projectGeneration, preparedStretchAssets, ordinaryDescriptors),
  preparedStretchAssets: new Map(preparedStretchAssets.map((asset) => [asset.clipId, asset])),
  sampleRateHz,
  transportEpoch: epoch,
  timeOrigin: {
    timelineSec: snapshot.transport.playheadSec,
    frame: originFrame,
  },
  rangeEndSec: Math.min(
    snapshot.transport.playheadSec + horizonSec,
    Number.MAX_SAFE_INTEGER / sampleRateHz,
  ),
  sourceRangeStartSec,
  clipSpanningNoteOn: true,
  // An id that depends on the note and not on the compile origin lets a seam reconcile match a sounding note to the
  // same note in a schedule compiled from a later origin.
  stableNoteIds: true,
  sourceFirstSequence,
  loop: snapshot.transport,
})

// A live instrument edit the session accepted (rememberInstrumentParameters) outlives a compile that read the
// desired state before it.
const withAcceptedInstruments = (snapshot: LivePlaybackSnapshot, accepted: LivePlaybackSnapshot): LivePlaybackSnapshot => {
  const fx = snapshot.mixer.fx
  const trackFx = Object.fromEntries(Object.entries(fx.trackFx ?? {}).map(([id, entry]) => {
    const instrument = accepted.mixer.fx.trackFx?.[id]?.instrument
    // A compile that differs elsewhere read newer content, which carries the live values itself.
    return [id, instrument && entry.instrument && isLiveEventOnlyInstrumentChange(instrument, entry.instrument)
      ? { ...entry, instrument } : entry]
  }))
  return { ...snapshot, mixer: { ...snapshot.mixer, fx: { ...fx, trackFx } } }
}

// The eight synth fields the live events carry. A compile reads the project, which a knob drag only reaches on release,
// so the values the session accepted since `since` are laid over it; a field the accepted instrument did not move
// keeps what the compile read.
const withAcceptedLiveSynthValues = (
  snapshot: LivePlaybackSnapshot, since: LivePlaybackSnapshot, accepted: LivePlaybackSnapshot,
): LivePlaybackSnapshot => {
  const fx = snapshot.mixer.fx
  const trackFx = Object.fromEntries(Object.entries(fx.trackFx ?? {}).map(([id, entry]) => {
    const now = accepted.mixer.fx.trackFx?.[id]?.instrument
    const before = since.mixer.fx.trackFx?.[id]?.instrument
    const compiled = entry.instrument
    if (now?.kind !== "synth" || before?.kind !== "synth" || compiled?.kind !== "synth"
      || now.instanceId !== before.instanceId || now.instanceId !== compiled.instanceId) return [id, entry]
    const moved = (from: number, to: number) => !Object.is(from, to)
    const a = now.params, b = before.params
    const update: SynthParamsUpdate = {
      ...(moved(a.gain, b.gain) && { gain: a.gain }),
      ...(moved(a.pan, b.pan) && { pan: a.pan }),
      filter: {
        ...(moved(a.filter.frequencyHz, b.filter.frequencyHz) && { frequencyHz: a.filter.frequencyHz }),
        ...(moved(a.filter.q, b.filter.q) && { q: a.filter.q }),
      },
      ampEnvelope: {
        ...(moved(a.ampEnvelope.attackSec, b.ampEnvelope.attackSec) && { attackSec: a.ampEnvelope.attackSec }),
        ...(moved(a.ampEnvelope.decaySec, b.ampEnvelope.decaySec) && { decaySec: a.ampEnvelope.decaySec }),
        ...(moved(a.ampEnvelope.sustain, b.ampEnvelope.sustain) && { sustain: a.ampEnvelope.sustain }),
        ...(moved(a.ampEnvelope.releaseSec, b.ampEnvelope.releaseSec) && { releaseSec: a.ampEnvelope.releaseSec }),
      },
    }
    return [id, { ...entry, instrument: { ...compiled, params: mergeSynthParams(compiled.params, update) } }]
  }))
  return { ...snapshot, mixer: { ...snapshot.mixer, fx: { ...fx, trackFx } } }
}

// What a playing portable session adopts live (D5): track volume, mute, solo, sends and output, the mixer graph and
// its automation, master volume, and processor or instrument edits the parameter mapper takes live. `next` with all of
// that taken from `previous` fingerprints as `previous` exactly when nothing else changed.
const withLiveContentOf = (next: LivePlaybackSnapshot, previous: LivePlaybackSnapshot): LivePlaybackSnapshot => {
  const previousTracks = new Map(previous.tracks.map((track) => [track.id, track]))
  const liveInstance = (targetId: string, instance: AudioEffectRuntimeInstance, before: readonly AudioEffectRuntimeInstance[] = []) => {
    const installed = before.find((entry) => entry.id === instance.id)
    if (!installed || JSON.stringify({ ...installed, params: null }) !== JSON.stringify({ ...instance, params: null })) return instance
    return isLiveParameterChange(createAudioEffectParameterPayload(
      { targetId, instanceId: instance.id, kind: instance.kind }, installed.params, instance.params), next.bpm) ? installed : instance
  }
  const trackFx = next.mixer.fx.trackFx && Object.fromEntries(Object.entries(next.mixer.fx.trackFx).map(([id, entry]) => {
    const installed = previous.mixer.fx.trackFx?.[id]
    const instrument = installed?.instrument && entry.instrument && installed.instrument.instanceId === entry.instrument.instanceId
      && isLiveParameterChange({ targetId: id, effect: "instrument", from: installed.instrument, to: entry.instrument }, next.bpm)
      ? installed.instrument : entry.instrument
    return [id, { ...entry, instrument, instances: entry.instances.map((instance) => liveInstance(id, instance, installed?.instances)) }]
  }))
  return {
    ...next,
    tracks: next.tracks.map((track) => {
      const installed = previousTracks.get(track.id)
      return installed ? { ...track, volume: installed.volume, muted: installed.muted, soloed: installed.soloed,
        sends: installed.sends, outputTargetId: installed.outputTargetId } : track
    }),
    mixer: { ...next.mixer, graph: previous.mixer.graph, automationEnvelopes: previous.mixer.automationEnvelopes, fx: {
      ...next.mixer.fx,
      masterVolume: previous.mixer.fx.masterVolume,
      masterFxInstances: next.mixer.fx.masterFxInstances.map((instance) => liveInstance("master", instance, previous.mixer.fx.masterFxInstances)),
      trackFx,
    } },
  }
}

const hasWarpedAudio = (snapshot: LivePlaybackSnapshot) =>
  snapshot.tracks.some((track) => track.clips.some((clip) => clip.audioWarp?.enabled === true))

const hasAudioClips = (snapshot: LivePlaybackSnapshot) =>
  snapshot.tracks.some((track) => track.clips.some((clip) => !clip.midi))

// What a playing session adopts at a seam, beyond what it takes live: the tempo, the loop fields and the MIDI clips of
// tracks it already plays. `next` with that taken from `previous` fingerprints as `previous` when nothing else changed.
// A tempo moves warped audio, and a loop repeats audio clips; both need new sources (a class the seam does not carry),
// so with that audio the tempo or loop stays in `next` and the gate refuses it.
const withSeamContentOf = (next: LivePlaybackSnapshot, previous: LivePlaybackSnapshot): LivePlaybackSnapshot => {
  const previousTracks = new Map(previous.tracks.map((track) => [track.id, track]))
  const loopsAudio = hasAudioClips(next) || hasAudioClips(previous)
  return {
    ...next,
    bpm: hasWarpedAudio(next) || hasWarpedAudio(previous) ? next.bpm : previous.bpm,
    transport: loopsAudio ? next.transport : {
      ...next.transport,
      loopEnabled: previous.transport.loopEnabled,
      loopStartSec: previous.transport.loopStartSec,
      loopEndSec: previous.transport.loopEndSec,
    },
    tracks: next.tracks.map((track) => {
      const installed = previousTracks.get(track.id)
      if (!installed) return track
      const other = track.clips.filter((clip) => !clip.midi)
      let taken = 0
      const clips = installed.clips.flatMap((clip) => clip.midi ? [clip] : taken < other.length ? [other[taken++]] : [])
      return { ...track, clips: [...clips, ...other.slice(taken)] }
    }),
  }
}

// The worklet rejects a schedule with more events than this.
const maxScheduleEvents = 256

// How far before the end of its schedule a session extends it.
const scheduleLeadSec = (horizonSec: number) => Math.min(5, Math.max(0.05, horizonSec * 0.25))

// Rendered frames between the last position report and the seam an adoption publishes at: covers the report lag (up to
// max(block, sampleRate / 20) frames) and the prepare, install and publish round trips.
const adoptionSeamLeadSec = 0.25

// An adopted schedule starts at `seamFrame` while the session keeps sounding what the old schedule started before it.
// A note that sounds at the seam and is not the same note in `next` gets a note-off at the seam; one that survives keeps
// its voice, because a repeated note-on would stick a Synth (it then needs two note-offs) and double a Sampler.
const reconcileAtSeam = (input: {
  previous: PortableSchedule
  next: PortableSchedule
  seamFrame: number
  keepsVoices: (trackId: string) => boolean
}): PortableSchedule => {
  const { previous, next, seamFrame } = input
  const noteKey = (event: { target: { trackId: string }; noteId: number }) => `${event.target.trackId}\0${event.noteId}`
  const sounding = new Map<string, Extract<PortableSchedule["events"][number], { type: "note-on" }>>()
  for (const event of previous.events) {
    if (event.frame >= seamFrame) continue
    if (event.type === "note-on") sounding.set(noteKey(event), event)
    else if (event.type === "note-off") sounding.delete(noteKey(event))
  }
  const continued = new Set<PortableSchedule["events"][number]>()
  for (const event of next.events) {
    if (event.type !== "note-on" || event.frame !== seamFrame) continue
    const held = sounding.get(noteKey(event))
    if (held && held.pitch === event.pitch && held.velocity === event.velocity && input.keepsVoices(event.target.trackId)) {
      continued.add(event)
      sounding.delete(noteKey(event))
    }
  }
  const releases = [...sounding.values()].map((held): PortableSchedule["events"][number] => ({
    type: "note-off", target: held.target, noteId: held.noteId, pitch: held.pitch, frame: seamFrame, sequence: 0,
  }))
  // `next` starts at the seam, so the releases go first: a release precedes a note-on at the same frame.
  return {
    ...next,
    events: [...releases, ...next.events.filter((event) => !continued.has(event))]
      .map((event, index) => ({ ...event, sequence: index + 1 })),
  }
}

type PortablePagedPreparation = {
  id: number
  assetId: string
  pageKeys: readonly string[]
  stopFrame: number
  released: boolean
}

type PortablePreparedSource = PortableWasmPreparedSourceEvent & {
  preparation: PortablePagedPreparation
}

const pagedSourceCoverage = (
  asset: {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  },
  source: Extract<PreparedPortableSession, { supported: true }>["sources"][number],
) => {
  const sourceOffset = source.sourceOffsetFrame + (source.sourceOffsetFraction ?? 0)
  const lastPosition = sourceOffset + source.sourceFrameCount - 1
  const coverageEnd = Math.min(asset.asset.frameCount, Math.floor(lastPosition) + 2)
  if (
    !Number.isFinite(sourceOffset)
    || !Number.isSafeInteger(source.sourceOffsetFrame)
    || source.sourceOffsetFrame < 0
    || !Number.isSafeInteger(source.sourceFrameCount)
    || source.sourceFrameCount < 1
    || source.sourceOffsetFrame >= asset.asset.frameCount
    || source.sourceFrameCount > asset.asset.frameCount - source.sourceOffsetFrame
    || coverageEnd <= source.sourceOffsetFrame
  ) return undefined
  const firstPage = Math.floor(source.sourceOffsetFrame / asset.pageFrames)
  const lastPage = Math.floor((coverageEnd - 1) / asset.pageFrames)
  const pageKeys = Array.from(
    { length: lastPage - firstPage + 1 },
    (_, index) => `${asset.asset.assetId}:${firstPage + index}`,
  )
  return { firstPage, lastPage, coverageEnd, pageKeys }
}

const requiredPagedPagePlan = (
  sources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][],
  preparedStretchAssets: readonly PortablePreparedStretch[],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>,
) => {
  const pagedAssets = new Map<string, {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  }>([
    ...[...ordinaryDescriptors.values()].map((entry) => [entry.asset.assetId, {
      asset: entry.asset,
      pageFrames: portableWasmPagedPageFrames,
      descriptor: entry.descriptor,
    }] as const),
    ...preparedStretchAssets.filter(isPagedStretchAsset).map((asset) => [asset.asset.assetId, {
      asset: asset.asset,
      pageFrames: asset.manifest.pageFrames,
      artifactId: asset.artifactId,
    }] as const),
  ])
  const keys = new Set<string>()
  let preparationCount = 0
  for (const source of sources) {
    const asset = pagedAssets.get(source.assetId)
    if (!asset) continue
    const coverage = pagedSourceCoverage(asset, source)
    if (!coverage) return undefined
    preparationCount += 1
    for (const key of coverage.pageKeys) keys.add(key)
  }
  return { pageKeys: keys, preparationCount }
}

const pagedCapacityError = (input: {
  pageCount: number
  pageCapacity: number
  preparationCount: number
  preparationCapacity: number
  baselinePreparationCount?: number
}) => {
  if (input.pageCount > input.pageCapacity) {
    return new Error(
      `Portable paged playback requires ${input.pageCount} resident pages, `
        + `but only ${input.pageCapacity} are available.`,
    )
  }
  const totalPreparations = input.preparationCount + (input.baselinePreparationCount ?? 0)
  if (totalPreparations > input.preparationCapacity) {
    if (input.baselinePreparationCount === undefined) {
      return new Error(
        `Portable paged playback requires ${input.preparationCount} prepared ranges, `
          + `but only ${input.preparationCapacity} are available.`,
      )
    }
    return new Error(
      `Portable paged playback refresh requires ${totalPreparations} prepared ranges `
        + `(${input.baselinePreparationCount ?? 0} active baseline + ${input.preparationCount} continuation), `
        + `but only ${input.preparationCapacity} are available.`,
    )
  }
  return undefined
}

const fitPortableStartupHorizon = (input: {
  snapshot: LivePlaybackSnapshot
  sampleRateHz: number
  epoch: number
  projectGeneration: number
  requestedHorizonSec: number
  sourceFirstSequence: number
  preparedStretchAssets: readonly PortablePreparedStretch[]
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
  pageSlotCapacity: number
  preparationCapacity: number
  signal?: AbortSignal
}) => {
  const pageFrames = portableWasmPagedPageFrames
  const requestedFrames = Math.max(pageFrames, Math.round(input.requestedHorizonSec * input.sampleRateHz))
  for (
    let horizonFrames = requestedFrames;
    horizonFrames >= pageFrames;
    horizonFrames -= pageFrames
  ) {
    input.signal?.throwIfAborted()
    const horizonSec = horizonFrames / input.sampleRateHz
    const prepared = preparedSession(
      input.snapshot,
      input.sampleRateHz,
      input.epoch,
      input.projectGeneration,
      horizonSec,
      input.sourceFirstSequence,
      input.preparedStretchAssets,
      undefined,
      input.ordinaryDescriptors,
    )
    if (!prepared.supported) continue
    const plan = requiredPagedPagePlan(
      prepared.sources,
      input.preparedStretchAssets,
      input.ordinaryDescriptors,
    )
    if (!plan) throw new Error("Portable paged source range is outside its prepared asset.")
    if (
      plan.pageKeys.size <= input.pageSlotCapacity
      && plan.preparationCount <= input.preparationCapacity
    ) return prepared
  }
  const minimumPrepared = preparedSession(
    input.snapshot,
    input.sampleRateHz,
    input.epoch,
    input.projectGeneration,
    pageFrames / input.sampleRateHz,
    input.sourceFirstSequence,
    input.preparedStretchAssets,
    undefined,
    input.ordinaryDescriptors,
  )
  if (!minimumPrepared.supported) throw new Error("Portable paged playback minimum horizon is unsupported.")
  const minimumPlan = requiredPagedPagePlan(
    minimumPrepared.sources,
    input.preparedStretchAssets,
    input.ordinaryDescriptors,
  )
  if (!minimumPlan) throw new Error("Portable paged source range is outside its prepared asset.")
  const capacityError = pagedCapacityError({
    pageCount: minimumPlan.pageKeys.size,
    pageCapacity: input.pageSlotCapacity,
    preparationCount: minimumPlan.preparationCount,
    preparationCapacity: input.preparationCapacity,
  })
  if (capacityError) throw capacityError
  throw new Error(
    `Portable paged playback requires ${minimumPlan.preparationCount} prepared ranges, `
      + `but only ${input.preparationCapacity} are available.`,
  )
}

const readPortableWasmPages = async function* (input: {
  descriptor: AudioPcmSourceDescriptor
  startFrame: number
  endFrame: number
  signal?: AbortSignal
}): AsyncGenerator<DecodedAudioPage> {
  const pageFrames = portableWasmPagedPageFrames
  const { descriptor, startFrame, endFrame, signal } = input
  let expectedStartFrame = startFrame
  let accumulatedFrames = 0
  let accumulatedPlanes: Float32Array[] | undefined

  for await (const page of descriptor.readPages({ startFrame, endFrame, signal })) {
    signal?.throwIfAborted()
    if (
      !Number.isSafeInteger(page.startFrame)
      || !Number.isSafeInteger(page.frameCount)
      || page.startFrame !== expectedStartFrame
      || page.frameCount <= 0
      || page.startFrame + page.frameCount > endFrame
      || page.sampleRate !== descriptor.sampleRate
      || page.channelCount !== descriptor.channelCount
      || page.planes.length !== descriptor.channelCount
      || page.planes.some((plane) => plane.length !== page.frameCount)
    ) {
      throw new Error("Portable ordinary source page metadata or coverage is invalid.")
    }
    const planes = accumulatedPlanes ?? Array.from(
      { length: descriptor.channelCount },
      () => new Float32Array(pageFrames),
    )
    accumulatedPlanes = planes
    let pageOffset = 0
    while (pageOffset < page.frameCount) {
      signal?.throwIfAborted()
      const copyFrames = Math.min(page.frameCount - pageOffset, pageFrames - accumulatedFrames)
      for (let channel = 0; channel < descriptor.channelCount; channel += 1) {
        const sourcePlane = page.planes[channel]
        const destinationPlane = planes[channel]
        if (!sourcePlane || !destinationPlane) {
          throw new Error("Portable ordinary source page channel metadata is invalid.")
        }
        destinationPlane.set(
          sourcePlane.subarray(pageOffset, pageOffset + copyFrames),
          accumulatedFrames,
        )
      }
      pageOffset += copyFrames
      accumulatedFrames += copyFrames
      expectedStartFrame += copyFrames
      if (accumulatedFrames === pageFrames) {
        yield {
          startFrame: expectedStartFrame - pageFrames,
          frameCount: pageFrames,
          sampleRate: descriptor.sampleRate,
          channelCount: descriptor.channelCount,
          planes,
        }
        accumulatedPlanes = undefined
        accumulatedFrames = 0
      }
    }
  }
  signal?.throwIfAborted()
  if (expectedStartFrame !== endFrame) {
    throw new Error("Portable ordinary source pages do not cover the requested range exactly.")
  }
  if (accumulatedFrames > 0) {
    if (!accumulatedPlanes) throw new Error("Portable ordinary source page accumulator is missing.")
    yield {
      startFrame: endFrame - accumulatedFrames,
      frameCount: accumulatedFrames,
      sampleRate: descriptor.sampleRate,
      channelCount: descriptor.channelCount,
      planes: accumulatedPlanes.map((plane) => plane.slice(0, accumulatedFrames)),
    }
  }
}

const preparePagedSources = async (input: {
  session: PortableSession
  sources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  preparedStretchAssets: readonly PortablePreparedStretch[]
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
  repository: PreparedStretchArtifactRepository
  generation: number
  preparationCapacity: number
  baselinePreparationCount?: number
  pinnedPageKeys?: ReadonlySet<string>
  signal?: AbortSignal
}): Promise<{
  events: readonly PortableWasmPreparedSourceEvent[]
  preparations: readonly PortablePagedPreparation[]
}> => {
  const pagedAssets = new Map<string, {
    asset: AudioAssetRef
    pageFrames: number
    descriptor?: AudioPcmSourceDescriptor
    artifactId?: string
  }>([
    ...[...input.ordinaryDescriptors.values()].map((entry) => [entry.asset.assetId, {
      asset: entry.asset,
      pageFrames: portableWasmPagedPageFrames,
      descriptor: entry.descriptor,
    }] as const),
    ...input.preparedStretchAssets.filter(isPagedStretchAsset).map((asset) => [asset.asset.assetId, {
      asset: asset.asset,
      pageFrames: asset.manifest.pageFrames,
      artifactId: asset.artifactId,
    }] as const),
  ])
  if (pagedAssets.size === 0) return { events: [], preparations: [] }
  if (!input.session.prepareAssetRange || !input.session.writeAssetPage || !input.session.releaseAssetPreparation) {
    throw new Error("Portable playback backend does not expose paged asset support.")
  }
  const requiredPages = new Map<string, Set<number>>()
  const pagePlan = requiredPagedPagePlan(input.sources, input.preparedStretchAssets, input.ordinaryDescriptors)
  if (!pagePlan) throw new Error("Portable Stretch source range is outside its prepared asset.")
  const pageKeys = pagePlan.pageKeys
  const pinnedPageKeys = input.pinnedPageKeys ?? new Set<string>()
  const unionPageCount = new Set([...pinnedPageKeys, ...pageKeys]).size
  const capacityError = pagedCapacityError({
    pageCount: unionPageCount,
    pageCapacity: input.session.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
    preparationCount: pagePlan.preparationCount,
    preparationCapacity: input.preparationCapacity,
    baselinePreparationCount: input.baselinePreparationCount,
  })
  if (capacityError) throw capacityError
  for (const source of input.sources) {
    const asset = pagedAssets.get(source.assetId)
    if (!asset) continue
    const coverage = pagedSourceCoverage(asset, source)
    if (!coverage) throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" is invalid.`)
    const pages = requiredPages.get(source.assetId) ?? new Set<number>()
    for (let page = coverage.firstPage; page <= coverage.lastPage; page += 1) pages.add(page)
    requiredPages.set(source.assetId, pages)
  }
  const availableSlots = input.session.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount
  if (unionPageCount > availableSlots) {
    throw new Error(`Portable paged playback requires ${unionPageCount} resident pages, but only ${availableSlots} are available.`)
  }
  const preparations: PortablePagedPreparation[] = []
  try {
    input.signal?.throwIfAborted()
    for (const [assetId, pages] of requiredPages) {
      const asset = pagedAssets.get(assetId)
      if (!asset) continue
      for (const pageIndex of pages) {
        input.signal?.throwIfAborted()
        const pageStart = pageIndex * asset.pageFrames
        const pageEnd = Math.min(asset.asset.frameCount, pageStart + asset.pageFrames)
        if (pageEnd <= pageStart) throw new Error(`Portable Stretch page ${pageIndex} is outside its asset.`)
        const range = await input.session.prepareAssetRange(
          assetId,
          input.generation,
          pageStart,
          pageEnd - pageStart,
          0,
        )
        if (range.status === "prepared") {
          const release = await input.session.releaseAssetPreparation(range.preparationId, input.generation)
          if (release !== "released") throw new Error(`Portable Stretch page preparation could not be released (${release}).`)
          continue
        }
        if (range.status !== "missing-page" || range.firstMissingPage === undefined) {
          throw new Error(`Portable Stretch page range for "${assetId}" was rejected (${range.status}).`)
        }
        const firstFrame = range.firstMissingPage * asset.pageFrames
        const endFrame = Math.min(asset.asset.frameCount, firstFrame + asset.pageFrames)
        const pages = asset.descriptor
          ? readPortableWasmPages({
            descriptor: asset.descriptor,
            startFrame: firstFrame,
            endFrame,
            signal: input.signal,
          })
          : asset.artifactId
            ? input.repository.read(asset.artifactId, firstFrame, endFrame)
            : undefined
        if (!pages) throw new Error(`Portable asset "${assetId}" has no page source.`)
        for await (const page of pages) {
          input.signal?.throwIfAborted()
          const pageIndex = page.startFrame / asset.pageFrames
          if (
            !Number.isSafeInteger(pageIndex)
            || pageIndex < 0
            || page.startFrame !== pageIndex * asset.pageFrames
            || page.frameCount <= 0
            || page.frameCount > asset.pageFrames
            || page.startFrame + page.frameCount > asset.asset.frameCount
            || page.sampleRate !== asset.asset.sampleRateHz
            || page.channelCount !== asset.asset.channelCount
            || page.planes.length !== asset.asset.channelCount
            || page.planes.some((plane) => plane.length !== page.frameCount)
          ) throw new Error(`Portable asset "${assetId}" page metadata or coverage is invalid.`)
          const result = await input.session.writeAssetPage(assetId, input.generation, pageIndex, page.frameCount, page.planes)
          input.signal?.throwIfAborted()
          if (result.status !== "written") throw new Error(`Portable page ${pageIndex} was rejected (${result.status}).`)
        }
      }
    }
    const events: PortableWasmPreparedSourceEvent[] = []
    for (const source of input.sources) {
      input.signal?.throwIfAborted()
      const asset = pagedAssets.get(source.assetId)
      if (!asset) continue
      const coverage = pagedSourceCoverage(asset, source)
      if (!coverage) throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" is invalid.`)
      const range = await input.session.prepareAssetRange(
        source.assetId,
        input.generation,
        source.sourceOffsetFrame,
        coverage.coverageEnd - source.sourceOffsetFrame,
        0,
      )
      input.signal?.throwIfAborted()
      if (range.status !== "prepared") {
        throw new Error(`Portable Stretch source range for "${source.sourceIdentity}" was rejected (${range.status}).`)
      }
      events.push({
        ...source,
        preparationId: range.preparationId,
      })
      preparations.push({
        id: range.preparationId,
        assetId: source.assetId,
        pageKeys: coverage.pageKeys,
        stopFrame: source.stopFrame,
        released: false,
      })
    }
    return { events, preparations }
  } catch (error) {
    await Promise.all(preparations.map((preparation) => input.session.releaseAssetPreparation?.(preparation.id, input.generation)))
    throw error
  }
}

const withPreparations = (
  events: readonly PortableWasmPreparedSourceEvent[],
  preparations: readonly PortablePagedPreparation[],
): PortablePreparedSource[] => events.map((event) => ({
  ...event,
  preparation: preparations.find((preparation) => preparation.id === event.preparationId)
    ?? (() => { throw new Error(`Portable preparation ${event.preparationId} is missing.`) })(),
}))

// The sources the worklet plays from a registered asset; the rest play from pages.
const ordinarySourcesOf = (
  sources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][],
  preparedStretchAssets: readonly PortablePreparedStretch[],
  ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>,
) => sources.filter((source) => (
  !preparedStretchAssets.some((candidate) => isPagedStretchAsset(candidate) && candidate.asset.assetId === source.assetId)
  && !ordinaryDescriptors.has(source.assetId)
))

// Shrinks a window a page at a time until its paged sources fit the session's page and preparation capacity. `refused`
// is a window that does not compile; `no-fit` is one that fits at no size.
const fitPagedWindow = async (input: {
  horizonSec: number
  pageSec: number
  compile: (horizonSec: number) => Extract<PreparedPortableSession, { supported: true }> | undefined
  // A refresh keeps the sources it holds and prepares the ones from this frame on.
  fromFrame?: number
  prepare: (sources: Extract<PreparedPortableSession, { supported: true }>["sources"]) => ReturnType<typeof preparePagedSources>
}): Promise<{
  candidate: Extract<PreparedPortableSession, { supported: true }>
  sources: Extract<PreparedPortableSession, { supported: true }>["sources"]
  paged: Awaited<ReturnType<typeof preparePagedSources>>
} | "refused" | "no-fit"> => {
  const { fromFrame } = input
  for (let horizonSec = input.horizonSec; horizonSec >= input.pageSec; horizonSec -= input.pageSec) {
    const candidate = input.compile(horizonSec)
    if (!candidate) return "refused"
    const sources = fromFrame === undefined ? candidate.sources : candidate.sources.filter((source) => source.startFrame >= fromFrame)
    try {
      return { candidate, sources, paged: await input.prepare(sources) }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("requires ")) throw error
    }
  }
  return "no-fit"
}

const scheduleSourcesInGlobalOrder = async (input: {
  session: PortableSession
  revision: number
  epoch: number
  ordinary: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  prepared: readonly PortableWasmPreparedSourceEvent[]
}) => {
  const ordinaryBySequence = new Map(input.ordinary.map((source) => [source.sequence, source]))
  const preparedBySequence = new Map(input.prepared.map((source) => [source.sequence, source]))
  const sequences = [...new Set([...ordinaryBySequence.keys(), ...preparedBySequence.keys()])].sort((left, right) => left - right)
  if (sequences.length === 0) {
    await input.session.scheduleSources(input.revision, input.epoch, [])
    return
  }
  let index = 0
  while (index < sequences.length) {
    const firstSequence = sequences[index]
    if (firstSequence === undefined) break
    const isPrepared = preparedBySequence.has(firstSequence)
    if (isPrepared) {
      if (!input.session.schedulePreparedSources) {
        throw new Error("Portable playback backend does not expose paged asset support.")
      }
      const group: PortableWasmPreparedSourceEvent[] = []
      while (index < sequences.length) {
        const sequence = sequences[index]
        if (sequence === undefined || !preparedBySequence.has(sequence)) break
        const event = preparedBySequence.get(sequence)
        if (!event) throw new Error(`Portable source sequence ${sequence} is missing from its schedule group.`)
        group.push(event)
        index += 1
      }
      await input.session.schedulePreparedSources(
        input.revision,
        input.epoch,
        group,
      )
    } else {
      const group: Extract<PreparedPortableSession, { supported: true }>["sources"][number][] = []
      while (index < sequences.length) {
        const sequence = sequences[index]
        if (sequence === undefined || preparedBySequence.has(sequence)) break
        const event = ordinaryBySequence.get(sequence)
        if (!event) throw new Error(`Portable source sequence ${sequence} is missing from its schedule group.`)
        group.push(event)
        index += 1
      }
      await input.session.scheduleSources(
        input.revision,
        input.epoch,
        group,
      )
    }
  }
}

const replaceSourcesAtomically = async (input: {
  session: PortableSession
  revision: number
  epoch: number
  ordinary: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
  prepared: readonly PortableWasmPreparedSourceEvent[]
}) => {
  if (input.session.replaceSources) {
    await input.session.replaceSources(input.revision, input.epoch, input.ordinary, input.prepared)
    return
  }
  await scheduleSourcesInGlobalOrder(input)
}

type PortableRecordingSession = {
  numericSessionId: number
  source: MediaStreamAudioSourceNode
  disconnectInput: () => void
  unsubscribeStatus: () => void
  unsubscribeTrack: () => void
  writer: ReturnType<typeof createPortableRecordingWriter>
  configured: ReturnType<typeof deferred<number>>
  finalized: ReturnType<typeof deferred<void>>
  cancelled: ReturnType<typeof deferred<void>>
  diagnostics?: PortableRecordingDiagnostics
  onFailure?: (error: Error) => void
  phase: "configuring" | "recording" | "finalizing" | "cancelling"
  configurationPending: boolean
  terminal: boolean
}

/**
 * Activates the browser portable renderer only after its immutable payload,
 * worklet, graph, assets, source schedule, and running transport are all
 * acknowledged. A failure before activation leaves the caller on legacy;
 * a fault after activation disconnects the portable node without fallback.
 */
export const createPortableBrowserPlaybackController = (input: {
  compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
  // The content identity of a compiled snapshot, as native adoption compares it; without it nothing is adopted live.
  fingerprintSnapshot?: (snapshot: LivePlaybackSnapshot) => string
  getAudioContext: () => AudioContext | null
  scheduleHorizonSec?: number
  getProjectGeneration?: () => number
  resolveSource?: AudioPcmSourceResolver
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  reportFault?: (message: string) => void
  onGraphContinuity?: (message: Extract<PortableWasmStatusMessage, { type: "graph-continuity" }>) => void
  // A resubmitted adoption or seek ended without failing: the caller compares its baseline against what is now playing.
  onAdoptionResubmitted?: (result: PortableAdoptionResult | PortableStartResult) => void
  backend?: PortableBackend
  select?: (project: PortablePreparedQualification) => Promise<PortableWasmBackendSelection>
  createRecordingWriter?: typeof createPortableRecordingWriter
  createPreparedStretchRepository?: () => PreparedStretchArtifactRepository
}) => {
  const backend = input.backend ?? new WasmAudioWorkletBackend()
  const select = input.select ?? ((project) => selectPortableWasmAudioWorkletBackend(undefined, project))
  const safeProjectGeneration = (generation: number) =>
    Number.isSafeInteger(generation) && generation > 0 ? generation : 1
  let active: PortableSession | undefined
  let activeProjectGeneration: number | undefined
  let activeTransport: LivePlaybackTransport | undefined
  let activeScheduleRange: PortableScheduleRange | undefined
  let playing = false
  let pendingStart: Promise<PortableStartResult> | undefined
  let pendingStartMode: "play" | "preview" | undefined
  let lifecycleGeneration = 0
  let recording: PortableRecordingSession | undefined
  let epoch = 0
  // Paged assets and their preparations belong to the session's creation epoch. The transport epoch moves on a locate and
  // must not: the worklet answers a paged call under any other generation as stale, or releases every asset.
  let assetGeneration = 0
  let positionFrame = 0
  // Oldest first; the segment in effect is the last one that starts at or before the reported raw frame.
  let positionSegments: readonly PositionSegment[] = []
  const arrangementFrame = () => arrangementFrameAt(positionSegments, positionFrame)
  let positionSequence = 0
  let activeSourceSequence = 0
  let refreshPromise: Promise<PortableStartResult> | undefined
  let transportIntent = 0
  let failedRefreshEndFrame: number | undefined
  let activeRevision: number | undefined
  let activeGraph: AudioCoreGraphSnapshot | undefined
  let activeSnapshot: LivePlaybackSnapshot | undefined
  let activeFrameSchedule: Extract<PreparedPortableSession, { supported: true }>["schedule"] | undefined
  let activePreparedStretchAssets: readonly PortablePreparedStretch[] = []
  let activeOrdinarySources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][] = []
  let activeOrdinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor> = new Map()
  let activePreparedSources: readonly PortablePreparedSource[] = []
  let activePreparations: readonly PortablePagedPreparation[] = []
  let nextLiveProcessorSequence = 0
  let adopting = false
  let adoptionQueued: Promise<PortableAdoptionResult> | undefined
  // The newest loop an adoption was asked for: the waiting adoption compiles with it, and so does a resubmit.
  let latestLoop: AdoptionLoop = { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 }
  let adoptionTail: Promise<unknown> = Promise.resolve()
  let adoptionPublish: Promise<PortableAdoptionResult> | undefined
  // Synth sends past the adoption barrier and not yet answered; an adoption folds the values they carry once they settle.
  const liveInstrumentSends = new Set<Promise<unknown>>()
  // Failed operations waiting for rendered-frame reports to run again (UD 8): `wait` more reports, `resubmits` made so far.
  const retries = new Map<"adoption" | "seek", { resubmits: number; wait: number; run: (resubmits: number) => Promise<void> }>()
  // Locates run one after the other; the newest wins through `transportIntent`.
  let seekTail: Promise<unknown> = Promise.resolve()
  let pendingSeeks = 0
  let nextRecordingSessionId = 1
  let unsubscribeFault: (() => void) | undefined
  let startupAbortController: AbortController | undefined
  const stretchRepository = input.createPreparedStretchRepository?.() ?? createPreparedStretchArtifactRepository()
  let repositoryDisposed = false
  const releasePreparedStretchAssets = async (assets: readonly PortablePreparedStretch[]) => {
    const leases = new Set(assets.filter(isPagedStretchAsset).map((asset) => asset.lease))
    await Promise.all([...leases].map((lease) => lease.release().catch(() => undefined)))
  }

  const clearActiveSessionState = () => {
    const session = active
    const cleanup: Promise<unknown>[] = []
    active = undefined
    activeProjectGeneration = undefined
    activeTransport = undefined
    positionSegments = []
    activeScheduleRange = undefined
    activeRevision = undefined
    activeGraph = undefined
    activeSnapshot = undefined
    activeFrameSchedule = undefined
    retries.clear()
    if (session?.releaseAssetPreparation) {
      for (const preparation of activePreparations) {
        if (!preparation.released) {
          cleanup.push(session.releaseAssetPreparation(preparation.id, assetGeneration).then((result) => {
            if (result === "released") preparation.released = true
          }).catch(() => undefined))
        }
      }
    }
    activePreparations = []
    activeOrdinarySources = []
    activeOrdinaryDescriptors = new Map()
    activePreparedSources = []
    cleanup.push(releasePreparedStretchAssets(activePreparedStretchAssets))
    activePreparedStretchAssets = []
    playing = false
    return Promise.all(cleanup)
  }

  // The session owns its graph revision: an adoption advances it past the Timeline's nativePlaybackRevision, so a
  // compile made while a session is active carries the revision that session publishes. That holds only for content the
  // session can carry, what it plays apart from what it takes live; any other content needs a rebuild. A refresh or
  // adoption never installs it on this session (the worklet rejects a schedule for nodes it lacks).
  const compileSnapshot = async (
    transport: LivePlaybackTransport,
    context?: LivePlaybackCompileContext,
  ): Promise<LivePlaybackSnapshotCompilation> => {
    const compilation = await input.compileSnapshot(transport, context)
    const fingerprint = input.fingerprintSnapshot
    if (!compilation.supported || activeRevision === undefined || !activeSnapshot || !fingerprint) return compilation
    // An adoption installs its schedule at a seam, so it also takes tempo, loop and MIDI edits; a refresh or a start does not.
    const adoptable = context?.liveAdoption ? withSeamContentOf(compilation.snapshot, activeSnapshot) : compilation.snapshot
    if (fingerprint(withLiveContentOf(adoptable, activeSnapshot)) !== fingerprint(activeSnapshot)) {
      return { supported: false, reasons: ["Portable playback requires a schedule rebuild."] }
    }
    return { ...compilation, snapshot: { ...compilation.snapshot, revision: activeRevision } }
  }

  const releaseRuntime = async (runtime: PreparedRuntime | undefined) => {
    if (!runtime || runtime.released) return
    runtime.released = true
    const releases: Promise<unknown>[] = []
    for (const preparation of runtime.preparations) {
      if (!preparation.released) {
        const release = runtime.session.releaseAssetPreparation?.(preparation.id, runtime.assetGeneration)
        if (release) {
          releases.push(release.then((result) => {
            if (result === "released") preparation.released = true
          }).catch(() => undefined))
        }
      }
    }
    await Promise.all(releases)
    await releasePreparedStretchAssets(runtime.preparedStretchAssets)
    runtime.unsubscribeFault()
    runtime.session.dispose()
  }

  const releaseExpiredPreparations = async (session: PortableSession, frame: number) => {
    const expired = activePreparations.filter((preparation) => !preparation.released && preparation.stopFrame <= frame)
    if (!session.releaseAssetPreparation || expired.length === 0) return
    const results = await Promise.all(expired.map(async (preparation) => ({
      preparation,
      result: await session.releaseAssetPreparation?.(preparation.id, assetGeneration),
    })))
    const released = new Set(
      results.filter((entry) => entry.result === "released").map((entry) => entry.preparation.id),
    )
    for (const preparation of expired) {
      if (released.has(preparation.id)) preparation.released = true
    }
    activePreparations = activePreparations.filter((preparation) => !released.has(preparation.id))
  }

  const teardownSession = () => {
    unsubscribeFault?.()
    unsubscribeFault = undefined
    const session = active
    const cleanup = clearActiveSessionState()
    session?.dispose()
    return cleanup
  }

  const clearRecording = (session: PortableRecordingSession) => {
    if (recording === session) recording = undefined
    session.unsubscribeStatus()
    session.unsubscribeTrack()
    try { session.disconnectInput() } catch {}
    try { session.source.disconnect() } catch {}
  }

  const failRecording = (session: PortableRecordingSession, error: Error) => {
    if (session.terminal) return
    session.terminal = true
    try {
      active?.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-cancel" })
    } catch {}
    void session.writer.abort().catch(() => undefined)
    session.writer.terminate()
    if (session.phase === "configuring" && session.configurationPending) session.configured.reject(error)
    else if (session.phase === "finalizing") session.finalized.reject(error)
    else if (session.phase === "cancelling") session.cancelled.reject(error)
    if (session.phase !== "configuring") session.onFailure?.(error)
    clearRecording(session)
  }

  const dispose = () => {
    lifecycleGeneration += 1
    transportIntent += 1
    pendingStart = undefined
    pendingStartMode = undefined
    refreshPromise = undefined
    startupAbortController?.abort()
    startupAbortController = undefined
    const recordingSession = recording
    if (recordingSession) failRecording(recordingSession, new Error("Portable recording stopped with playback."))
    const sessionCleanup = teardownSession()
    if (!repositoryDisposed) {
      repositoryDisposed = true
      void sessionCleanup
        .catch(() => undefined)
        .then(() => stretchRepository.dispose?.())
        .catch(() => undefined)
    }
  }

  type PreparedRuntime = {
    session: PortableSession
    prepared: Extract<PreparedPortableSession, { supported: true }>
    snapshot: LivePlaybackSnapshot
    projectGeneration: number
    epoch: number
    assetGeneration: number
    transport: LivePlaybackTransport
    requestedFrame: number
    unsubscribeFault: () => void
    sessionFault: PortableSessionFault
    preparedStretchAssets: readonly PortablePreparedStretch[]
    preparations: readonly PortablePagedPreparation[]
    ordinarySources: readonly Extract<PreparedPortableSession, { supported: true }>["sources"][number][]
    ordinaryDescriptors: ReadonlyMap<string, PortableOrdinaryDescriptor>
    preparedSources: readonly PortablePreparedSource[]
    released: boolean
  }
  // During a rolling handoff, live deliveries also reach the replacement.
  // This closes the async reconciliation gap without waiting for quiet input.
  let parameterReplacement: PreparedRuntime | undefined

  const prepareRuntime = async (
    transport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
    nextEpoch: number,
    sourceFirstSequence: number,
    compileContext?: LivePlaybackCompileContext,
    parameterSnapshot?: LivePlaybackSnapshot,
  ): Promise<PreparedRuntime | undefined> => {
    const context = input.getAudioContext()
    if (!context) return undefined
    const preparationAbortController = new AbortController()
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
      || preparationAbortController.signal.aborted
    const requestedFrame = Math.round(transport.playheadSec * context.sampleRate)
    let session: PortableSession | undefined
    let unsubscribeSessionFault: (() => void) | undefined
    let preparedStretchAssets: readonly PortablePreparedStretch[] = []
    let runtimePreparations: readonly PortablePagedPreparation[] = []
    const sessionFault: PortableSessionFault = {}
    let transferredStretchOwnership = false
    startupAbortController = preparationAbortController
    try {
      let compilation = await compileSnapshot(transport, compileContext)
      if (cancelled()) return undefined
      if (!compilation.supported) return undefined
      if (parameterSnapshot) compilation = { ...compilation, snapshot: withAcceptedInstruments(compilation.snapshot, parameterSnapshot) }
      if (compilation.snapshot.tracks.some((track) => track.clips.some((clip) => (
        clip.audioWarp?.enabled === true && clip.audioWarp.mode === "stretch"
      )))) {
        const preparation = await preparePortablePagedStretchAssets({
          tracks: compilation.snapshot.tracks,
          projectBpm: compilation.snapshot.bpm,
          projectGeneration: safeProjectGeneration(projectGeneration),
          repository: stretchRepository,
          resolveSource: input.resolveSource,
          signal: preparationAbortController.signal,
        })
        if (!preparation.supported) {
          input.reportFault?.(preparation.message)
          return undefined
        }
        preparedStretchAssets = preparation.assets
      }
      if (cancelled()) return undefined
      const ordinaryDescriptors = await resolveOrdinaryDescriptors(
        compilation.snapshot,
        input.resolveSource,
        preparationAbortController.signal,
      )
      if (cancelled()) return undefined
      const prepared = preparedSession(
        compilation.snapshot,
        context.sampleRate,
        nextEpoch,
        safeProjectGeneration(projectGeneration),
        input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC,
        sourceFirstSequence,
        preparedStretchAssets,
        undefined,
        ordinaryDescriptors,
      )
      if (!prepared.supported) return undefined
      const selection = await select(prepared.qualification)
      if (cancelled()) return undefined
      if (!selection.selected) return undefined
      const playbackSession = await backend.createPlaybackSession(context, selection.capability, 8_192)
      session = playbackSession
      unsubscribeSessionFault = playbackSession.onFault((error: Error) => {
        if (active !== playbackSession) {
          sessionFault.error = error
          return
        }
        const recordingSession = recording
        if (recordingSession) failRecording(recordingSession, error)
        input.reportFault?.(error.message)
        unsubscribeFault = undefined
        clearActiveSessionState()
      })
      const hasPagedAssets = preparedStretchAssets.some(isPagedStretchAsset) || ordinaryDescriptors.size > 0
      const startupPrepared = hasPagedAssets
        ? fitPortableStartupHorizon({
          snapshot: compilation.snapshot,
          sampleRateHz: context.sampleRate,
          epoch: nextEpoch,
          projectGeneration: safeProjectGeneration(projectGeneration),
          requestedHorizonSec: input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC,
          sourceFirstSequence,
          preparedStretchAssets,
          ordinaryDescriptors,
          pageSlotCapacity: playbackSession.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
          preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
          signal: preparationAbortController.signal,
        })
        : prepared
      await playbackSession.prepareGraph(startupPrepared.graph)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      if (hasPagedAssets && (
        !playbackSession.registerPagedAsset
        || !playbackSession.writeAssetPage
        || !playbackSession.prepareAssetRange
        || !playbackSession.schedulePreparedSources
        || playbackSession.pagedCapabilities?.pageFrames !== portableWasmPagedPageFrames
        || playbackSession.pagedCapabilities?.maxChannels !== portableWasmPagedMaxChannels
      )) {
        throw new Error("Portable playback backend does not expose paged asset support.")
      }
      const registerPagedAsset = playbackSession.registerPagedAsset
      for (const asset of startupPrepared.graph.assets) {
        const source = compilation.snapshot.assets.find((candidate) => candidate.assetId === asset.assetId)
        const preparedSource = preparedStretchAssets.find((candidate) => candidate.asset.assetId === asset.assetId)
        const ordinaryDescriptor = ordinaryDescriptors.get(asset.assetId)
        if ((preparedSource && isPagedStretchAsset(preparedSource)) || ordinaryDescriptor) {
          if (preparedSource && isPagedStretchAsset(preparedSource)
            && preparedSource.manifest.pageFrames !== portableWasmPagedPageFrames) {
            throw new Error(`Portable Stretch artifact "${preparedSource.artifactId}" has an incompatible page size.`)
          }
          if (!registerPagedAsset) throw new Error("Portable playback backend does not expose paged asset support.")
          const registration = await registerPagedAsset(asset, nextEpoch)
          if (registration.status !== "registered") {
            throw new Error(`Portable paged audio asset "${asset.assetId}" was rejected (${registration.status}).`)
          }
          continue
        }
        const pcm = preparedSource?.pcm ?? (source?.buffer ? planarPcm(source.buffer) : undefined)
        if (!pcm) throw new Error(`Portable playback asset "${asset.assetId}" is not hydrated.`)
        const result = await playbackSession.registerAsset(asset, pcm, nextEpoch)
        if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
        if (result.status !== "registered") throw new Error(`Portable audio asset "${asset.assetId}" was rejected.`)
      }
      await playbackSession.publishGraph(startupPrepared.graph.revision)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.setTransport(nextEpoch, false, startupPrepared.schedule.timeOrigin.frame)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      await playbackSession.installSchedule(startupPrepared.schedule)
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      const paged = await preparePagedSources({
        session: playbackSession,
        sources: startupPrepared.sources,
        preparedStretchAssets,
        ordinaryDescriptors,
        repository: stretchRepository,
        generation: nextEpoch,
        preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
        signal: preparationAbortController.signal,
      })
      const preparedSourceEvents = paged.events
      const preparations = paged.preparations
      runtimePreparations = preparations
      const ordinarySources = ordinarySourcesOf(startupPrepared.sources, preparedStretchAssets, ordinaryDescriptors)
      await replaceSourcesAtomically({
        session: playbackSession,
        revision: startupPrepared.graph.revision,
        epoch: nextEpoch,
        ordinary: ordinarySources,
        prepared: preparedSourceEvents,
      })
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      if (runTransport) {
        if (
          !Number.isSafeInteger(requestedFrame)
          || requestedFrame < startupPrepared.scheduleRange.startFrame
          || requestedFrame >= startupPrepared.scheduleRange.endFrame
        ) throw new Error("Portable browser playback requested transport is outside its prepared schedule.")
        await playbackSession.setTransport(nextEpoch, true, requestedFrame)
      }
      if (cancelled()) throw new Error("Portable browser playback startup was cancelled.")
      if (sessionFault.error) throw sessionFault.error
      playbackSession.onTransportPosition?.((position) => {
        if (
          active !== playbackSession
          // The live epoch: a locate moves it on this session, and the replacement of a refresh is gated by `active`.
          || position.epoch !== epoch
          || position.sequence <= positionSequence
        ) return
        if (position.frame < positionFrame && position.running) return
        positionSequence = position.sequence
        positionFrame = position.frame
        void releaseExpiredPreparations(playbackSession, position.frame).catch(() => undefined)
        for (const [kind, retry] of retries) {
          if (--retry.wait > 0) continue
          retries.delete(kind)
          void retry.run(retry.resubmits).catch(() => undefined)
        }
      })
      playbackSession.onGraphContinuity?.((message) => input.onGraphContinuity?.(message))
      if (runTransport) playbackSession.markActive()
      const runtime = {
        session: playbackSession,
        prepared: startupPrepared,
        snapshot: compilation.snapshot,
        projectGeneration,
        epoch: nextEpoch,
        assetGeneration: nextEpoch,
        transport: { ...transport },
        requestedFrame,
        unsubscribeFault: unsubscribeSessionFault,
        sessionFault,
        preparedStretchAssets,
        ordinaryDescriptors,
        preparations,
        ordinarySources,
        preparedSources: withPreparations(preparedSourceEvents, preparations),
        released: false,
      }
      transferredStretchOwnership = true
      return runtime
    } catch (error) {
      unsubscribeSessionFault?.()
      await Promise.all(runtimePreparations.map(async (preparation) => {
        if (!preparation.released) {
          const result = await session?.releaseAssetPreparation?.(preparation.id, nextEpoch)
          if (result === "released") preparation.released = true
        }
      }))
      session?.dispose()
      if (!cancelled()) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not start.")
      }
      return undefined
    } finally {
      if (startupAbortController === preparationAbortController) {
        startupAbortController = undefined
      }
      if (!transferredStretchOwnership) await releasePreparedStretchAssets(preparedStretchAssets)
    }
  }

  const commitRuntime = (runtime: PreparedRuntime, runTransport: boolean) => {
    active = runtime.session
    activeProjectGeneration = runtime.projectGeneration
    activeTransport = runtime.transport
    positionSegments = initialPositionSegments(runtime.transport, runtime.prepared.schedule.sampleRateHz)
    activeScheduleRange = runtime.prepared.scheduleRange
    activeFrameSchedule = runtime.prepared.schedule
    activeRevision = runtime.prepared.graph.revision
    activeGraph = runtime.prepared.graph
    activeSnapshot = runtime.snapshot
    activeOrdinarySources = runtime.ordinarySources
    activeOrdinaryDescriptors = runtime.ordinaryDescriptors
    activePreparedSources = runtime.preparedSources
    activePreparedStretchAssets = runtime.preparedStretchAssets
    activePreparations = runtime.preparations
    playing = runTransport
    epoch = runtime.epoch
    assetGeneration = runtime.assetGeneration
    positionFrame = runTransport ? runtime.requestedFrame : runtime.prepared.schedule.timeOrigin.frame
    positionSequence = 0
    unsubscribeFault = runtime.unsubscribeFault
    activeSourceSequence = runtime.prepared.sources.length === 0
      ? 0
      : runtime.prepared.sources[runtime.prepared.sources.length - 1]?.sequence ?? 0
    failedRefreshEndFrame = undefined
  }

  const startAttempt = async (
    configuredTransport: LivePlaybackTransport,
    generation: number,
    projectGeneration: number,
    runTransport: boolean,
    compileContext?: LivePlaybackCompileContext,
  ): Promise<PortableStartResult> => {
    const context = input.getAudioContext()
    if (!context) return "unavailable"
    const transport = effectiveLoopForStart(
      configuredTransport,
      Math.round(configuredTransport.playheadSec * context.sampleRate),
      context.sampleRate,
    )
    const cancelled = () => generation !== lifecycleGeneration
      || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
    const requestedFrame = Math.round(transport.playheadSec * context.sampleRate)
    const horizonSec = input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC
    const requestedScheduleEndFrame = requestedFrame
      + Math.round(horizonSec * context.sampleRate)
    const compatibleWithActiveSchedule = activeTransport !== undefined
      && activeScheduleRange !== undefined
      && !activeTransport.loopEnabled
      && !transport.loopEnabled
      && Number.isSafeInteger(requestedFrame)
      && requestedFrame >= activeScheduleRange.startFrame
      && Number.isSafeInteger(requestedScheduleEndFrame)
      && requestedScheduleEndFrame <= activeScheduleRange.endFrame
    if (active && activeProjectGeneration === projectGeneration && compatibleWithActiveSchedule) {
      try {
        await active.setTransport(epoch, runTransport, requestedFrame)
        positionFrame = requestedFrame
        if (cancelled()) {
          void teardownSession()
          return "unavailable"
        }
        if (runTransport) active.markActive()
        playing = runTransport
        return "started"
      } catch (error) {
        if (!cancelled()) {
          input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not resume.")
        }
        void teardownSession()
        return "unavailable"
      }
    }
    if (active) {
      void teardownSession()
    }
    const nextEpoch = epoch + 1
    const runtime = await prepareRuntime(
      transport,
      generation,
      projectGeneration,
      runTransport,
      nextEpoch,
      1,
      compileContext,
    )
    if (!runtime || cancelled()) {
      if (runtime) await releaseRuntime(runtime)
      return "unavailable"
    }
    commitRuntime(runtime, runTransport)
    return "started"
  }

  const refreshSchedule = (): Promise<PortableStartResult> => {
    // An adoption in flight owns the session's revision and schedule; the next tick refreshes after it.
    if (!playing || !active || refreshPromise || adopting || pendingSeeks > 0) return refreshPromise ?? Promise.resolve<PortableStartResult>("started")
    const context = input.getAudioContext()
    if (!context) return Promise.resolve("started")
    const horizonSec = input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC
    const leadSec = scheduleLeadSec(horizonSec)
    const currentFrame = positionFrame
    const endFrame = activeScheduleRange?.endFrame
    if (failedRefreshEndFrame !== undefined && currentFrame >= failedRefreshEndFrame) {
      const session = active
      playing = false
      failedRefreshEndFrame = undefined
      activeTransport = activeTransport ? { ...activeTransport, state: "paused" } : undefined
      void session?.setTransport(epoch, false, currentFrame).catch(() => undefined)
      input.reportFault?.("Portable playback reached the end of its active schedule after refresh failed.")
      return Promise.resolve("unavailable")
    }
    if (endFrame === undefined || endFrame - currentFrame > Math.round(leadSec * context.sampleRate)) {
      return Promise.resolve("started")
    }
    const previousSession = active
    const previousUnsubscribeFault = unsubscribeFault
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const intent = transportIntent
    // The refresh builds a new session whose raw frames are arrangement frames, so it starts from the arrangement position.
    const transport: LivePlaybackTransport = {
      ...(activeTransport ?? {
        state: "playing",
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
      state: "playing",
      playheadSec: arrangementFrame() / context.sampleRate,
    }
    const refreshAbortController = new AbortController()
    startupAbortController = refreshAbortController
    const request: Promise<PortableStartResult> = (async (): Promise<PortableStartResult> => {
      if (recording) {
        const nextEpoch = epoch
        await releaseExpiredPreparations(previousSession, currentFrame)
        activeOrdinarySources = activeOrdinarySources.filter((source) => source.stopFrame > currentFrame)
        activePreparedSources = activePreparedSources.filter((source) => !source.preparation.released)
        const baselineOrdinarySources = activeOrdinarySources
        const baselinePreparedSources = activePreparedSources
        const baselineSchedule = activeFrameSchedule
        const baselineScheduleRange = activeScheduleRange
        const baselinePreparations = activePreparations
        const baselineEndFrame = activeScheduleRange?.endFrame ?? currentFrame
        const compilation = await compileSnapshot(transport)
        if (
          generation !== lifecycleGeneration
          || intent !== transportIntent
          || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
          || active !== previousSession
          || !playing
          || !compilation.supported
          || compilation.snapshot.transport.loopEnabled
          || compilation.snapshot.revision !== activeRevision
        ) return "unavailable"
        const extensionStartFrame = baselineEndFrame
        const pageSec = portableWasmPagedPageFrames / context.sampleRate
        const requestedExtensionSec = horizonSec + (extensionStartFrame - currentFrame) / context.sampleRate
        const restoreBaseline = async () => {
          if (!baselineSchedule) throw new Error("Portable scheduler cannot roll back a failed refresh.")
          await replaceSourcesAtomically({
            session: previousSession,
            revision: baselineSchedule.revision,
            epoch: nextEpoch,
            ordinary: baselineOrdinarySources,
            prepared: baselinePreparedSources,
          })
          await previousSession.installSchedule(baselineSchedule)
        }
        let prepared: Extract<PreparedPortableSession, { supported: true }> | undefined
        let paged: Awaited<ReturnType<typeof preparePagedSources>> | undefined
        let extensionSources: Extract<PreparedPortableSession, { supported: true }>["sources"] = []
        try {
          const fit = await fitPagedWindow({
            horizonSec: requestedExtensionSec,
            pageSec,
            fromFrame: extensionStartFrame,
            compile: (candidateHorizonSec) => {
              const candidate = preparedSession(
                compilation.snapshot,
                context.sampleRate,
                nextEpoch,
                safeProjectGeneration(projectGeneration),
                candidateHorizonSec,
                activeSourceSequence + 1,
                activePreparedStretchAssets,
                extensionStartFrame / context.sampleRate,
                activeOrdinaryDescriptors,
              )
              return candidate.supported
                && candidate.graph.revision === activeRevision
                && !candidate.graph.assets.some((asset) => !activeGraph?.assets.some((current) => current.assetId === asset.assetId))
                ? candidate : undefined
            },
            prepare: (sources) => preparePagedSources({
              session: previousSession,
              sources,
              preparedStretchAssets: activePreparedStretchAssets,
              ordinaryDescriptors: activeOrdinaryDescriptors,
              repository: stretchRepository,
              generation: assetGeneration,
              preparationCapacity: previousSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
              baselinePreparationCount: baselinePreparations.length,
              signal: refreshAbortController.signal,
              pinnedPageKeys: new Set(baselinePreparations.flatMap((preparation) => preparation.pageKeys)),
            }),
          })
          if (fit === "refused") return "unavailable"
          if (fit === "no-fit") throw new Error("Portable schedule refresh could not fit the pinned page horizon.")
          prepared = fit.candidate
          paged = fit.paged
          extensionSources = fit.sources
          const ordinarySources = ordinarySourcesOf(extensionSources, activePreparedStretchAssets, activeOrdinaryDescriptors)
          await replaceSourcesAtomically({
            session: previousSession,
            revision: prepared.graph.revision,
            epoch: nextEpoch,
            ordinary: [...baselineOrdinarySources, ...ordinarySources],
            prepared: [...baselinePreparedSources.map((source) => ({
              ...source,
              preparationId: source.preparation.id,
            })), ...paged.events],
          })
          await previousSession.installSchedule(prepared.schedule)
          if (
            generation !== lifecycleGeneration
            || intent !== transportIntent
            || projectGeneration !== (input.getProjectGeneration?.() ?? 0)
            || active !== previousSession
            || !playing
          ) throw new Error("Portable schedule refresh was cancelled.")
          activeScheduleRange = prepared.scheduleRange
          activeFrameSchedule = prepared.schedule
          activePreparations = [...baselinePreparations, ...paged.preparations]
          activeOrdinarySources = [...baselineOrdinarySources, ...ordinarySources]
          activePreparedSources = [...baselinePreparedSources, ...withPreparations(paged.events, paged.preparations)]
          activeSourceSequence = extensionSources.length === 0
            ? activeSourceSequence
            : extensionSources[extensionSources.length - 1]?.sequence ?? activeSourceSequence
          activeTransport = { ...transport }
          return "started"
        } catch (error) {
          try {
            await restoreBaseline()
            activePreparations = baselinePreparations
            activeOrdinarySources = baselineOrdinarySources
            activePreparedSources = baselinePreparedSources
            activeScheduleRange = baselineScheduleRange
            activeFrameSchedule = baselineSchedule
          } catch (rollbackError) {
            void teardownSession()
            input.reportFault?.(rollbackError instanceof Error ? rollbackError.message : "Portable schedule refresh rollback failed.")
            return "unavailable"
          }
          if (paged) {
            await Promise.all(paged.preparations.map(async (preparation) => {
              if (!preparation.released) {
                const result = await previousSession.releaseAssetPreparation?.(preparation.id, assetGeneration)
                if (result === "released") preparation.released = true
              }
            }))
          }
          failedRefreshEndFrame = activeScheduleRange?.endFrame
          input.reportFault?.(error instanceof Error ? error.message : "Portable schedule refresh failed.")
          return "unavailable"
        }
      }

      const stillCurrent = () => generation === lifecycleGeneration
        && intent === transportIntent
        && projectGeneration === (input.getProjectGeneration?.() ?? 0)
      const preservesActiveGraph = (runtime: PreparedRuntime | undefined) => runtime !== undefined
        && runtime.prepared.graph.revision === activeRevision
        && runtime.prepared.graph.assets.length === (activeGraph?.assets.length ?? 0)
        && runtime.prepared.graph.assets.every((asset) => (
          activeGraph?.assets.some((current) => current.assetId === asset.assetId)
        ))
      const hasPagedSources = (runtime: PreparedRuntime) => (
        runtime.ordinaryDescriptors.size > 0
        || runtime.preparedStretchAssets.some(isPagedStretchAsset)
      )
      const hasContinuationCoverage = (runtime: PreparedRuntime, frame: number, handoff = false) => {
        const requiredEndFrame = frame + (
          hasPagedSources(runtime)
            ? portableWasmPagedPageFrames
            // Preparation targets a full horizon. At handoff, allow the old
            // transport to advance while retaining the refresh lead.
            : Math.round((handoff ? leadSec : horizonSec) * context.sampleRate)
        )
        return Number.isSafeInteger(frame)
          && frame >= runtime.prepared.scheduleRange.startFrame
          && frame < runtime.prepared.scheduleRange.endFrame
          && Number.isSafeInteger(requiredEndFrame)
          && requiredEndFrame <= runtime.prepared.scheduleRange.endFrame
      }
      const replacementTransport = (frame: number): LivePlaybackTransport => ({
        ...transport,
        playheadSec: frame / context.sampleRate,
      })

      let runtime = await prepareRuntime(
        transport,
        generation,
        projectGeneration,
        false,
        epoch + 1,
        1,
        undefined,
        activeSnapshot,
      )
      let latestFrame = arrangementFrame()
      let valid = runtime !== undefined
        && preservesActiveGraph(runtime)
        && runtime.sessionFault.error === undefined
        && stillCurrent()
        && active === previousSession
        && playing
      if (valid && runtime && !hasContinuationCoverage(runtime, latestFrame)) {
        await releaseRuntime(runtime)
        runtime = await prepareRuntime(
          replacementTransport(arrangementFrame()),
          generation,
          projectGeneration,
          false,
          epoch + 1,
          1,
          undefined,
          activeSnapshot,
        )
        latestFrame = arrangementFrame()
        valid = runtime !== undefined
          && preservesActiveGraph(runtime)
          && runtime.sessionFault.error === undefined
          && stillCurrent()
          && active === previousSession
          && playing
          && runtime !== undefined
          && hasContinuationCoverage(runtime, latestFrame)
      }
      if (!valid || !runtime) {
        if (runtime && !preservesActiveGraph(runtime)) {
          input.reportFault?.("Portable schedule refresh changed the active graph.")
        }
        if (runtime?.sessionFault.error) {
          input.reportFault?.(runtime.sessionFault.error.message)
        }
        if (
          (!runtime
            || !preservesActiveGraph(runtime)
            || runtime.sessionFault.error !== undefined
            || !hasContinuationCoverage(runtime, latestFrame))
          && stillCurrent()
          && active === previousSession
          && playing
        ) failedRefreshEndFrame = activeScheduleRange?.endFrame
        await releaseRuntime(runtime)
        return "unavailable"
      }

      // The old session remains audible during preparation. Once all checks
      // pass, make the handoff a hard boundary before starting the prepared
      // replacement so two sessions can never run at once.
      parameterReplacement = runtime
      try {
        const acceptedSnapshot = activeSnapshot
        const events: PortableWasmInstrumentEvent[] = []
        for (const node of runtime.prepared.graph.nodes) {
          const accepted = acceptedSnapshot?.mixer.fx.trackFx?.[node.id]?.instrument
          const preparedInstrument = runtime.snapshot.mixer.fx.trackFx?.[node.id]?.instrument
          if (!accepted || accepted.kind !== "synth" || node.instrument?.kind !== "synth"
            || !preparedInstrument || accepted.instanceId !== preparedInstrument.instanceId) continue
          const mapped = mapNativeBuiltInParameterCommit({
            targetId: node.id, effect: "instrument", from: preparedInstrument, to: accepted,
          }, acceptedSnapshot?.bpm ?? runtime.snapshot.bpm)
          for (const value of mapped?.values ?? []) {
            const target = node.instrument.parameterTargets.find(entry => entry.id === value.parameterId)
            if (target) events.push({
              nodeId: node.id, type: "parameter", noteId: 1, sequence: ++nextLiveProcessorSequence,
              frameOffset: 0, channel: 0, note: target.target, value: value.value,
            })
          }
        }
        if (events.length > 0) {
          if (!runtime.session.queueInstrumentEvents) throw new Error("Portable replacement cannot reconcile instrument parameters.")
          await runtime.session.queueInstrumentEvents(runtime.epoch, events, {
            revision: runtime.prepared.graph.revision, sequence: nextLiveProcessorSequence,
          })
        }
        // rememberInstrumentParameters keeps this snapshot current while the
        // applied acknowledgement is in flight.
        if (acceptedSnapshot && activeSnapshot === acceptedSnapshot) runtime.snapshot = acceptedSnapshot
      } catch (error) {
        parameterReplacement = undefined
        await releaseRuntime(runtime)
        failedRefreshEndFrame = activeScheduleRange?.endFrame
        input.reportFault?.(error instanceof Error ? error.message : "Portable parameter reconciliation failed.")
        return "unavailable"
      }
      latestFrame = arrangementFrame()
      if (!hasContinuationCoverage(runtime, latestFrame, true) || runtime.sessionFault.error !== undefined || !stillCurrent()
        || active !== previousSession || !playing) {
        parameterReplacement = undefined
        await releaseRuntime(runtime)
        if (stillCurrent() && active === previousSession && playing) {
          failedRefreshEndFrame = activeScheduleRange?.endFrame
        }
        return "unavailable"
      }
      previousUnsubscribeFault?.()
      unsubscribeFault = undefined
      clearActiveSessionState()
      try {
        previousSession.dispose()
      } catch (error) {
        parameterReplacement = undefined
        await releaseRuntime(runtime)
        if (stillCurrent()) {
          input.reportFault?.(error instanceof Error ? error.message : "Portable schedule refresh could not dispose the old session.")
        }
        return "unavailable"
      }
      try {
        await runtime.session.setTransport(runtime.epoch, true, latestFrame)
        if (!stillCurrent() || runtime.sessionFault.error) {
          throw runtime.sessionFault.error ?? new Error("Portable schedule refresh was cancelled.")
        }
        runtime.session.markActive()
        if (!stillCurrent() || runtime.sessionFault.error) {
          throw runtime.sessionFault.error ?? new Error("Portable schedule refresh was cancelled.")
        }
        commitRuntime(runtime, true)
        parameterReplacement = undefined
        positionFrame = latestFrame
        activeTransport = {
          ...runtime.transport,
          state: "playing",
          playheadSec: latestFrame / context.sampleRate,
        }
        return "started"
      } catch (error) {
        parameterReplacement = undefined
        await releaseRuntime(runtime)
        if (stillCurrent()) {
          input.reportFault?.(
            error instanceof Error && error.message !== "Portable schedule refresh was cancelled."
              ? error.message
              : "Portable schedule refresh could not start the replacement.",
          )
        }
        return "unavailable"
      }
    })().catch((cause: unknown): PortableStartResult => {
      failedRefreshEndFrame = activeScheduleRange?.endFrame
      input.reportFault?.(cause instanceof Error ? cause.message : "Portable schedule refresh failed.")
      return "unavailable"
    }).finally(() => {
      parameterReplacement = undefined
      if (startupAbortController === refreshAbortController) {
        startupAbortController = undefined
      }
    })
    refreshPromise = request
    void request.finally(() => {
      if (refreshPromise === request) refreshPromise = undefined
    })
    return request
  }

  // Native adoption on the portable session: compile the newest desired state from a seam a quarter second ahead of the
  // rendered position, reconcile the notes sounding at the seam against the schedule they started in, then prepare,
  // install and publish at exactly that frame on the same core. A publication that is refused or late is a failed
  // adoption that a resubmit retries; what the session cannot carry yet is a rebuild. A paused session adopts the same
  // way at the frame it stands on, with no lead and an immediate publish.
  const adoptLive = async (loop: AdoptionLoop): Promise<PortableAdoptionResult> => {
    // A locate rebuilds the schedule the adoption would reconcile against; the follow adopts again after it.
    if (pendingSeeks > 0) return "unavailable"
    while (refreshPromise) await refreshPromise
    const session = active
    const audioContext = input.getAudioContext()
    const previous = activeSnapshot
    const schedule = activeFrameSchedule
    const range = activeScheduleRange
    const transport = activeTransport
    const revision = activeRevision
    const fingerprint = input.fingerprintSnapshot
    if (!session || !audioContext || !previous || !schedule || !range || !transport || revision === undefined) return "unavailable"
    if (!fingerprint) return "rebuild"
    const generation = lifecycleGeneration
    const intent = transportIntent
    const wasPlaying = playing
    const current = () => active === session && playing === wasPlaying && generation === lifecycleGeneration && intent === transportIntent
    // A compile that throws has changed nothing, and an edit that cannot be installed leaves the old graph playing for
    // the next adoption to retry; a rebuild would end the take and gap the audio for an edit the user expects to hear
    // without either.
    const failed = (): PortableAdoptionResult => current() ? "failed" : "unavailable"
    const sampleRate = audioContext.sampleRate
    const projectGeneration = safeProjectGeneration(activeProjectGeneration ?? 0)
    const publishing = Promise.withResolvers<PortableAdoptionResult>()
    adopting = true
    try {
      // A run keeps its loop off while the playhead is at or past the loop's end, as a start would.
      const arrangementNow = arrangementFrame()
      const compilation = await compileSnapshot({
        ...transport, ...effectiveLoopForStart(loop, arrangementNow, sampleRate), state: wasPlaying ? "playing" : "paused", playheadSec: arrangementNow / sampleRate,
      }, { liveAdoption: true })
      if (!current()) return "unavailable"
      // Audio clips, tracks, instrument kinds, assets, effect structure and warped audio under a tempo edit are not
      // carried at a seam yet; those still rebuild.
      if (!compilation.supported) return "rebuild"
      const next = compilation.snapshot
      if (fingerprint(next) === fingerprint(previous)) return "unchanged"
      // From here live sends wait for the publish (R2) and so reach the revision that carries them; sends already in
      // flight settle first, so the candidate holds every live value the session accepted while the compile ran.
      adoptionPublish = publishing.promise
      await Promise.all(liveInstrumentSends)
      if (!current()) return "unavailable"
      const folded = withAcceptedLiveSynthValues(next, previous, activeSnapshot ?? previous)
      // The schedule plays the arrangement from `arrangementAt` at raw frame `rawFrame`, with the loop as given.
      const compileFrom = (rawFrame: number, arrangementAt: number, scheduleLoop: AdoptionLoop, horizonFrames: number) => preparedSession(
        { ...folded, revision: revision + 1, transport: { ...folded.transport, ...scheduleLoop, playheadSec: arrangementAt / sampleRate } },
        sampleRate, epoch, projectGeneration, horizonFrames / sampleRate, 1, activePreparedStretchAssets, undefined, activeOrdinaryDescriptors, rawFrame)
      // The graph does not depend on the origin, so it is prepared first and the seam is chosen after that round trip.
      const provisional = compileFrom(positionFrame, arrangementNow, folded.transport, range.endFrame - positionFrame)
      if (!provisional.supported) return "rebuild"
      await session.prepareGraph(provisional.graph)
      if (!current()) return "unavailable"
      const leadFrames = Math.round(scheduleLeadSec(input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC) * sampleRate)
      // A stopped transport has no publish race: the seam is where it stands and the publish below is immediate.
      const seamFrame = wasPlaying ? positionFrame + Math.round(adoptionSeamLeadSec * sampleRate) : positionFrame
      const keepsVoices = (trackId: string) => previous.mixer.fx.trackFx?.[trackId]?.instrument?.instanceId
        === folded.mixer.fx.trackFx?.[trackId]?.instrument?.instanceId
      // Raw frames run on through a loop, so the seam's arrangement position is rarely its raw frame. The schedule is
      // compiled in raw frames: its loop is shifted by the difference, and the loop is off for the run when the
      // arrangement position at the seam is at or past the loop's end.
      const seamArrangement = arrangementFrameAt(positionSegments, seamFrame)
      const deltaFrames = seamFrame - seamArrangement
      const runLoop = effectiveLoopForStart(folded.transport, seamArrangement, sampleRate)
      const scheduleLoop: AdoptionLoop = {
        loopEnabled: runLoop.loopEnabled,
        loopStartSec: runLoop.loopStartSec + deltaFrames / sampleRate,
        loopEndSec: runLoop.loopEndSec + deltaFrames / sampleRate,
      }
      // The recording refresh reads raw frames as arrangement frames.
      if (recording && deltaFrames !== 0) return failed()
      // The window shrinks until the schedule fits what the worklet installs; the next refresh extends it. A seam too
      // close to the end of the schedule, or a graph that depends on the origin, leaves nothing to publish.
      const fitted = (() => {
        for (let horizonFrames = range.endFrame - seamFrame; horizonFrames > leadFrames; horizonFrames = Math.floor(horizonFrames / 2)) {
          const compiled = compileFrom(seamFrame, seamArrangement, scheduleLoop, horizonFrames)
          if (!compiled.supported || JSON.stringify(compiled.graph) !== JSON.stringify(provisional.graph)) return undefined
          const reconciled = reconcileAtSeam({ previous: schedule, next: compiled.schedule, seamFrame, keepsVoices })
          if (reconciled.events.length <= maxScheduleEvents) return { candidate: compiled, adopted: reconciled }
        }
        return undefined
      })()
      if (!fitted) return failed()
      const { candidate, adopted } = fitted
      await session.installSchedule(adopted)
      if (!current()) return "unavailable"
      // Once posted, the publish decides which revision the worklet plays, whatever the transport did meanwhile.
      const graph = activeGraph
      activeRevision = candidate.graph.revision
      activeGraph = candidate.graph
      const published = session.publishGraph(candidate.graph.revision, wasPlaying ? { requireContinuity: true, publicationFrame: seamFrame } : { requireContinuity: true }).then((): PortableAdoptionResult => {
        if (active !== session) return "unavailable"
        // The compiled schedule, not the installed one: it still holds the note-on of a voice that continues from before
        // the seam, which the next reconcile needs to know that voice sounds.
        activeFrameSchedule = candidate.schedule
        activeScheduleRange = candidate.scheduleRange
        activeSnapshot = {
          ...folded,
          revision: candidate.graph.revision,
          transport: { ...folded.transport, loopEnabled: runLoop.loopEnabled },
        }
        activeTransport = { ...transport, loopEnabled: runLoop.loopEnabled, loopStartSec: runLoop.loopStartSec, loopEndSec: runLoop.loopEndSec }
        positionSegments = [
          ...positionSegments.slice(positionSegmentIndex(positionSegments, positionFrame)),
          { fromFrame: seamFrame, loop: loopFramesForTransport(scheduleLoop, sampleRate), deltaFrames },
        ]
        return "adopted"
      }, (): PortableAdoptionResult => {
        // A refusal, or a publication that came too late, leaves the worklet on the revision it plays; so does the session.
        if (active === session) {
          activeRevision = revision
          activeGraph = graph
        }
        return failed()
      })
      publishing.resolve(published)
      return await published
    } catch {
      return failed()
    } finally {
      adopting = false
      publishing.resolve("unavailable")
      adoptionPublish = undefined
    }
  }

  // At most one adoption runs and one waits; the waiting one compiles when it starts, so it carries the newest edit.
  const adoptQueued = (loop: AdoptionLoop): Promise<PortableAdoptionResult> => {
    latestLoop = loop
    if (adoptionQueued) return adoptionQueued
    const run = adoptionTail.then(() => {
      adoptionQueued = undefined
      return adoptLive(latestLoop)
    })
    adoptionQueued = run
    adoptionTail = run.catch(() => undefined)
    return run
  }

  // UD 8: a failed instrument staging keeps the playing graph and is resubmitted after min(2^r, 16(r+1)) rendered-frame
  // reports (the worklet's transport-position messages are the block boundary; no timer), up to 8 times. Exhaustion is a
  // defect: the edit stays in the project and the next adoption publishes it.
  const retryWaitReports = (resubmits: number) => Math.min(2 ** resubmits, 16 * (resubmits + 1))

  const settleAdoption = (result: PortableAdoptionResult, resubmits: number) => {
    retries.delete("adoption")
    if (result !== "failed") return
    if (resubmits >= maxAdoptionResubmits) {
      console.error(`[portable-playback] defect: instrument adoption failed after ${maxAdoptionResubmits} resubmits; the edit applies on the next successful publication`)
      return
    }
    console.warn(`[portable-playback] instrument adoption failed; resubmit ${resubmits + 1} of ${maxAdoptionResubmits} at a later block boundary`)
    retries.set("adoption", { resubmits, wait: retryWaitReports(resubmits), run: resubmitAdoption })
  }

  const adoptSchedule = async (loop: AdoptionLoop): Promise<PortableAdoptionResult> => {
    const result = await adoptQueued(loop)
    settleAdoption(result, 0)
    return result
  }

  const resubmitAdoption = async (resubmits: number) => {
    const result = await adoptQueued(latestLoop)
    settleAdoption(result, resubmits + 1)
    if (result !== "failed") input.onAdoptionResubmitted?.(result)
  }

  // A locate in place, in native's order: stop at the new position and epoch (the core clears its sources there), free the
  // old pages and prepare the target's, install the schedule and its sources, then run. It compiles the snapshot the
  // session holds, not the project: an edit that landed meanwhile is adopted by the follow after the locate.
  const seekAttempt = async (sec: number, loop: AdoptionLoop, intent: number, resubmits: number): Promise<PortableStartResult> => {
    while (refreshPromise) await refreshPromise
    await adoptionTail
    const session = active
    const audioContext = input.getAudioContext()
    const snapshot = activeSnapshot
    const revision = activeRevision
    if (!session || !audioContext || !snapshot || revision === undefined
      || activeProjectGeneration !== (input.getProjectGeneration?.() ?? 0)) return "unavailable"
    const generation = lifecycleGeneration
    const superseded = () => active !== session || generation !== lifecycleGeneration
    const sampleRate = audioContext.sampleRate
    const frame = Math.round(sec * sampleRate)
    const nextEpoch = epoch + 1
    const running = playing
    const target = effectiveLoopForStart({ ...snapshot.transport, ...loop, playheadSec: sec }, frame, sampleRate)
    const horizonSec = Math.max(input.scheduleHorizonSec ?? LIVE_SCHEDULE_HORIZON_SEC, portableWasmPagedPageFrames / sampleRate)
    const compile = (windowSec: number) => {
      const candidate = preparedSession({ ...snapshot, transport: target }, sampleRate, nextEpoch, safeProjectGeneration(activeProjectGeneration ?? 0),
        windowSec, 1, activePreparedStretchAssets, undefined, activeOrdinaryDescriptors)
      return candidate.supported && candidate.graph.revision === revision ? candidate : undefined
    }
    if (!compile(horizonSec)) {
      console.warn("[portable-playback] seek refused: the active snapshot does not compile at the target")
      return "unavailable"
    }
    try {
      await session.setTransport(nextEpoch, false, frame)
      if (superseded()) return "unavailable"
      epoch = nextEpoch
      positionFrame = frame
      positionSequence = 0
      positionSegments = initialPositionSegments(target, sampleRate)
      // The core cleared its sources at the epoch change, so every preparation has ended.
      await releaseExpiredPreparations(session, Number.POSITIVE_INFINITY)
      const held = activePreparations
      const fit = await fitPagedWindow({
        horizonSec,
        pageSec: portableWasmPagedPageFrames / sampleRate,
        compile,
        prepare: (sources) => preparePagedSources({
          session,
          sources,
          preparedStretchAssets: activePreparedStretchAssets,
          ordinaryDescriptors: activeOrdinaryDescriptors,
          repository: stretchRepository,
          generation: assetGeneration,
          preparationCapacity: session.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
          baselinePreparationCount: held.length,
          pinnedPageKeys: new Set(held.flatMap((preparation) => preparation.pageKeys)),
        }),
      })
      if (fit === "refused" || fit === "no-fit") throw new Error("Portable playback could not fit the window at the seek target.")
      await session.installSchedule(fit.candidate.schedule)
      const ordinary = ordinarySourcesOf(fit.sources, activePreparedStretchAssets, activeOrdinaryDescriptors)
      await replaceSourcesAtomically({ session, revision, epoch: nextEpoch, ordinary, prepared: fit.paged.events })
      if (superseded()) return "unavailable"
      activeFrameSchedule = fit.candidate.schedule
      activeScheduleRange = fit.candidate.scheduleRange
      activeOrdinarySources = ordinary
      activePreparations = [...held, ...fit.paged.preparations]
      activePreparedSources = withPreparations(fit.paged.events, fit.paged.preparations)
      activeSourceSequence = fit.sources.at(-1)?.sequence ?? 0
      activeTransport = { ...target, state: running ? "playing" : "paused" }
      activeSnapshot = { ...snapshot, transport: { ...snapshot.transport, loopEnabled: target.loopEnabled, loopStartSec: target.loopStartSec, loopEndSec: target.loopEndSec } }
      failedRefreshEndFrame = undefined
      // A newer locate or a pause leaves the session stopped at the schedule this one installed.
      if (running && intent === transportIntent) {
        await session.setTransport(nextEpoch, true, frame)
        session.markActive()
      }
      return "started"
    } catch (cause) {
      if (superseded()) return "unavailable"
      // The old schedule belongs to the old epoch, and what was installed may be partial: nothing may refresh, adopt or
      // resume on it until a locate completes.
      activeScheduleRange = undefined
      activeFrameSchedule = undefined
      const failure = cause instanceof Error ? cause : new Error("Portable playback could not seek.")
      // Rendered-frame reports are the retry clock, so a running transport keeps running (silent) while it waits.
      const waiting = running && resubmits < maxAdoptionResubmits
        && await session.setTransport(epoch, true, frame).then(() => true, () => false)
      if (waiting) {
        session.markActive()
        console.warn(`[portable-playback] seek failed; resubmit ${resubmits + 1} of ${maxAdoptionResubmits} at a later block boundary`)
        retries.set("seek", {
          resubmits,
          wait: retryWaitReports(resubmits),
          run: (done) => intent === transportIntent && generation === lifecycleGeneration
            ? queueSeek(arrangementFrame() / sampleRate, loop, intent, done + 1).then((result) => {
              if (result === "started") input.onAdoptionResubmitted?.(result)
            })
            : Promise.resolve(),
        })
        return "unavailable"
      }
      console.error(`[portable-playback] defect: seek failed${running ? ` after ${resubmits} resubmits` : ""}: ${failure.message}`)
      input.reportFault?.(failure.message)
      void teardownSession()
      return "unavailable"
    }
  }

  const queueSeek = (sec: number, loop: AdoptionLoop, intent: number, resubmits: number): Promise<PortableStartResult> => {
    pendingSeeks += 1
    const run = seekTail
      .then((): Promise<PortableStartResult> | PortableStartResult =>
        intent === transportIntent ? seekAttempt(sec, loop, intent, resubmits) : active ? "started" : "unavailable")
      .finally(() => { pendingSeeks -= 1 })
    seekTail = run.catch(() => undefined)
    return run
  }

  const seek = async (sec: number, loop: AdoptionLoop): Promise<PortableStartResult> => {
    if (recording) throw new Error("Portable recording must stop before playback can seek.")
    retries.delete("seek")
    return queueSeek(sec, loop, ++transportIntent, 0)
  }

  const start = (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (playing) return Promise.resolve("started")
    if (pendingStart) {
      if (pendingStartMode === "play") return pendingStart
      const previewRequest = pendingStart
      const generation = lifecycleGeneration
      const projectGeneration = input.getProjectGeneration?.() ?? 0
      const request = previewRequest.then((result) => result === "started"
        ? startAttempt(transport, generation, projectGeneration, true, compileContext)
        : result)
      pendingStart = request
      pendingStartMode = "play"
      void request.finally(() => {
        if (pendingStart === request) {
          pendingStart = undefined
          pendingStartMode = undefined
        }
      })
      return request
    }
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = startAttempt(transport, generation, projectGeneration, true, compileContext)
    pendingStart = request
    pendingStartMode = "play"
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
      }
    })
    return request
  }

  const ensurePrepared = (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (pendingStart) return pendingStart
    // A paused session is prepared only where it stands: another playhead seeks it in place.
    const context = input.getAudioContext()
    const keptPaused = active && !playing && activeProjectGeneration === (input.getProjectGeneration?.() ?? 0) && context
    if (keptPaused && positionFrame === Math.round(transport.playheadSec * keptPaused.sampleRate)) {
      return Promise.resolve("started")
    }
    const generation = lifecycleGeneration
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const request = keptPaused ? seek(transport.playheadSec, transport)
      : startAttempt(transport, generation, projectGeneration, false, compileContext)
    pendingStart = request
    pendingStartMode = "preview"
    void request.finally(() => {
      if (pendingStart === request) {
        pendingStart = undefined
        pendingStartMode = undefined
      }
    })
    return request
  }

  const rebuildPrepared = async (transport: LivePlaybackTransport, compileContext?: LivePlaybackCompileContext): Promise<PortableStartResult> => {
    if (!active) return "unavailable"
    lifecycleGeneration += 1
    transportIntent += 1
    pendingStart = undefined
    pendingStartMode = undefined
    refreshPromise = undefined
    startupAbortController?.abort()
    startupAbortController = undefined
    await teardownSession()
    return ensurePrepared(transport, compileContext)
  }

  const pause = async (playheadSec: number) => {
    transportIntent += 1
    startupAbortController?.abort()
    startupAbortController = undefined
    // A locate in flight finishes its burst without running; the pause then stops it at the epoch it left.
    await seekTail
    const session = active
    if (!session || !playing) return
    if (recording) throw new Error("Portable recording must stop before playback can pause.")
    const context = input.getAudioContext()
    if (!context) throw new Error("Portable audio context is unavailable.")
    try {
      await session.setTransport(epoch, false, Math.round(playheadSec * context.sampleRate))
      positionFrame = Math.round(playheadSec * context.sampleRate)
      // The transport now stands at the arrangement frame itself.
      positionSegments = []
      if (active === session) playing = false
    } catch (error) {
      if (active === session) {
        input.reportFault?.(error instanceof Error ? error.message : "Portable browser playback could not pause.")
        await teardownSession()
      }
      throw error
    }
  }

  const ensureRecordingRefreshCapacity = async (playbackSession: PortableSession) => {
    if (activePreparations.length === 0) return
    const context = input.getAudioContext()
    const baselineSchedule = activeFrameSchedule
    const baselineScheduleRange = activeScheduleRange
    if (!context || !baselineSchedule || !baselineScheduleRange || activeRevision === undefined || !activeGraph) {
      throw new Error("Portable recording requires an active schedule.")
    }
    await releaseExpiredPreparations(playbackSession, positionFrame)
    const projectGeneration = input.getProjectGeneration?.() ?? 0
    const transport: LivePlaybackTransport = {
      ...(activeTransport ?? {
        state: "playing",
        playheadSec: positionFrame / context.sampleRate,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      }),
      state: "playing",
      playheadSec: positionFrame / context.sampleRate,
    }
    const compilation = await compileSnapshot(transport)
    if (
      !compilation.supported
      || compilation.snapshot.transport.loopEnabled
      || compilation.snapshot.revision !== activeRevision
    ) {
      throw new Error("Portable recording is unavailable because playback requires a schedule rebuild.")
    }
    const pageFrames = portableWasmPagedPageFrames
    const extensionStartFrame = baselineScheduleRange.endFrame
    const minimum = preparedSession(
      compilation.snapshot,
      context.sampleRate,
      epoch,
      safeProjectGeneration(projectGeneration),
      (extensionStartFrame - positionFrame + pageFrames) / context.sampleRate,
      activeSourceSequence + 1,
      activePreparedStretchAssets,
      extensionStartFrame / context.sampleRate,
      activeOrdinaryDescriptors,
    )
    if (!minimum.supported) {
      throw new Error("Portable recording is unavailable because its minimum continuation horizon is unsupported.")
    }
    const continuationSources = minimum.sources.filter((source) => source.startFrame >= extensionStartFrame)
    const plan = requiredPagedPagePlan(
      continuationSources,
      activePreparedStretchAssets,
      activeOrdinaryDescriptors,
    )
    if (!plan) throw new Error("Portable recording is unavailable because a continuation source range is invalid.")
    const capacityError = pagedCapacityError({
      pageCount: new Set([
        ...activePreparations.flatMap((preparation) => preparation.pageKeys),
        ...plan.pageKeys,
      ]).size,
      pageCapacity: playbackSession.pagedCapabilities?.slotCount ?? portableWasmPagedSlotCount,
      preparationCount: plan.preparationCount,
      preparationCapacity: playbackSession.pagedCapabilities?.preparationCount ?? portablePagedPreparationCapacity,
      baselinePreparationCount: activePreparations.length,
    })
    if (capacityError) {
      throw new Error(`Portable recording is unavailable: ${capacityError.message}`)
    }
  }

  const startRecording = async (recordingInput: {
    appSessionId: string
    stream: MediaStream
    layout: "mono" | "stereo"
    inputChannel: number
    gain: number
    polarity: 1 | -1
    monitoring: boolean
    punchStartFrame: number
    punchEndFrame?: number
    onDiagnostics?: (diagnostics: PortableRecordingDiagnostics) => void
    onFailure?: (error: Error) => void
  }) => {
    const playbackSession = active
    const context = input.getAudioContext()
    if (!playbackSession || !playing || !context || recording) throw new Error("Portable playback is not active for recording.")
    const track = recordingInput.stream.getAudioTracks()[0]
    if (!track || track.readyState === "ended") throw new Error("Portable recording input is unavailable.")
    const channelCount = recordingInput.layout === "stereo" ? 2 : 1
    const inputChannels = channelCount === 2
      ? [recordingInput.inputChannel, recordingInput.inputChannel + 1]
      : [recordingInput.inputChannel]
    const availableChannels = Math.min(track.getSettings().channelCount ?? 1, 2)
    if (inputChannels.some((channel) => channel < 0 || channel >= availableChannels)) {
      throw new Error("Selected portable recording input channels are unavailable.")
    }
    await ensureRecordingRefreshCapacity(playbackSession)
    const numericSessionId = nextRecordingSessionId
    nextRecordingSessionId += 1
    let latestDiagnostics: PortableRecordingDiagnostics | undefined
    let writerQueuedFrames = 0
    let coreDrainPending = false
    let requestNextDrain = () => {}
    const writer = (input.createRecordingWriter ?? createPortableRecordingWriter)({
      generation: epoch,
      sessionId: recordingInput.appSessionId,
      sampleRate: context.sampleRate,
      channelCount,
      onQueuedFrames: (queuedFrames) => {
        writerQueuedFrames = queuedFrames
        recordingInput.onDiagnostics?.({
          version: portableWasmProtocolVersion,
          type: "recording-capture-diagnostics",
          generation: epoch,
          sessionId: numericSessionId,
          capturedFrames: latestDiagnostics?.capturedFrames ?? 0,
          droppedFrames: latestDiagnostics?.droppedFrames ?? 0,
          droppedBlocks: latestDiagnostics?.droppedBlocks ?? 0,
          availableBlocks: latestDiagnostics?.availableBlocks ?? 0,
          queuedBlocks: Math.ceil(queuedFrames / RECORDER_BLOCK_FRAMES),
          rms: latestDiagnostics?.rms ?? 0,
          peak: latestDiagnostics?.peak ?? 0,
          fatal: false,
          active: true,
        })
        requestNextDrain()
      },
    })
    const source = context.createMediaStreamSource(recordingInput.stream)
    const configured = deferred<number>()
    const finalized = deferred<void>()
    const cancelled = deferred<void>()
    const session: PortableRecordingSession = {
      numericSessionId,
      source,
      disconnectInput: () => undefined,
      unsubscribeStatus: () => undefined,
      unsubscribeTrack: () => undefined,
      writer,
      configured,
      finalized,
      cancelled,
      onFailure: recordingInput.onFailure,
      phase: "configuring",
      configurationPending: false,
      terminal: false,
    }
    requestNextDrain = () => {
      if (recording === session && session.phase !== "cancelling" && coreDrainPending
        && writerQueuedFrames < RECORDER_BLOCK_FRAMES * RECORDER_MAX_QUEUED_BLOCKS) {
        coreDrainPending = false
        playbackSession.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-drain" })
      }
    }
    session.unsubscribeStatus = playbackSession.onRecordingStatus((message) => {
      if (!("generation" in message) || !("sessionId" in message)
        || message.generation !== epoch || message.sessionId !== numericSessionId) return
      if (message.type === "recording-capture-available") {
        coreDrainPending = true
        requestNextDrain()
        return
      }
      if (message.type === "recording-capture-block") {
        try {
          writer.write(message)
        } catch (error) {
          failRecording(session, error instanceof Error ? error : new Error("Portable recording writer failed."))
        }
        return
      }
      if (message.type === "recording-capture-diagnostics") {
        latestDiagnostics = message
        coreDrainPending = message.queuedBlocks > 0
        session.diagnostics = message
        recordingInput.onDiagnostics?.(message)
        if (message.fatal) failRecording(session, new Error("Portable recording capture overflowed."))
        else requestNextDrain()
        return
      }
      if (message.type !== "recording-capture-applied") return
      if (message.action === "configured") configured.resolve(message.frame)
      else if (message.action === "finalized") finalized.resolve()
      else cancelled.resolve()
    })
    const onEnded = () => failRecording(session, new Error("Portable recording device ended."))
    track.addEventListener("ended", onEnded, { once: true })
    session.unsubscribeTrack = () => track.removeEventListener("ended", onEnded)
    recording = session
    try {
      await writer.ready
      session.disconnectInput = playbackSession.connectInput(source)
      session.configurationPending = true
      playbackSession.postRecordingControl({
        version: portableWasmProtocolVersion,
        type: "recording-capture-configure",
        generation: epoch,
        sessionId: numericSessionId,
        channelCount,
        inputChannels,
        gain: recordingInput.gain,
        polarity: recordingInput.polarity,
        monitoring: recordingInput.monitoring,
        punchStartFrame: recordingInput.punchStartFrame,
        punchEndFrame: recordingInput.punchEndFrame ?? null,
      })
      const startFrame = await boundedControl(configured.promise, "Portable recording configuration timed out.")
      session.configurationPending = false
      session.phase = "recording"
      return { sampleRate: context.sampleRate, channelCount, startFrame }
    } catch (error) {
      session.configurationPending = false
      failRecording(session, error instanceof Error ? error : new Error("Portable recording could not start."))
      throw error
    }
  }

  const stopRecording = async () => {
    const session = recording
    const playbackSession = active
    if (!session || !playbackSession || session.terminal) throw new Error("Portable recording is not active.")
    session.terminal = true
    session.phase = "finalizing"
    playbackSession.postRecordingControl({
      version: portableWasmProtocolVersion,
      type: "recording-capture-finalize",
      stopFrame: null,
    })
    try {
      await boundedControl(session.finalized.promise, "Portable recording finalization timed out.")
      const capturedFrames = session.diagnostics?.capturedFrames ?? 0
      const result = await session.writer.finalize(capturedFrames)
      clearRecording(session)
      return result
    } catch (error) {
      session.terminal = false
      failRecording(session, error instanceof Error ? error : new Error("Portable recording finalization failed."))
      throw error
    }
  }

  const cancelRecording = async () => {
    const session = recording
    const playbackSession = active
    if (!session || !playbackSession || session.terminal) return
    session.terminal = true
    session.phase = "cancelling"
    playbackSession.postRecordingControl({ version: portableWasmProtocolVersion, type: "recording-capture-cancel" })
    try {
      await boundedControl(session.cancelled.promise, "Portable recording cancellation timed out.")
    } finally {
      void session.writer.abort().catch(() => undefined)
      session.writer.terminate()
      clearRecording(session)
    }
  }

  const rememberInstrumentParameters = (targetId: string, instrument: TrackInstrumentParams) => {
    if (!activeSnapshot) return
    const trackFx = activeSnapshot.mixer.fx.trackFx ?? {}
    activeSnapshot = { ...activeSnapshot, mixer: { ...activeSnapshot.mixer,
      fx: { ...activeSnapshot.mixer.fx, trackFx: { ...trackFx, [targetId]: { ...trackFx[targetId], instrument } } } } }
    if (parameterReplacement) parameterReplacement.snapshot = activeSnapshot
  }

  const queueLiveProcessorControl = async (
    request: LiveProcessorControlRequest,
  ): Promise<LiveProcessorControlResult> => {
    // A start in flight may have compiled before this edit: it reaches the session that start commits.
    if (!active && pendingStart) await pendingStart.catch(() => undefined)
    // An adoption publish decides which revision the worklet plays; a send waits for its answer.
    if (adoptionPublish) await adoptionPublish
    if (!active || activeRevision === undefined || activeGraph === undefined) {
      return { accepted: false, reason: "unprepared" }
    }
    if (request.revision !== undefined && request.revision !== activeRevision
      || request.epoch !== undefined && request.epoch !== epoch) {
      return { accepted: false, reason: "stale" }
    }
    const snapshot = activeSnapshot
    const instrumentEntry = Object.entries(snapshot?.mixer.fx.trackFx ?? {})
      .find(([, fx]) => fx.instrument?.instanceId === request.instanceId)
    if (snapshot && instrumentEntry) {
      const session = active
      const node = activeGraph.nodes.find((entry) => entry.id === instrumentEntry[0])
      if (node?.instrument?.kind !== "synth" || !session.queueInstrumentEvents) return { accepted: false, reason: "unsupported" }
      // The live events carry the eight live parameters; every other change to the instrument reaches the session
      // through the published configuration of the next adoption, so it stays out of the prepared snapshot until then.
      const prepared = instrumentEntry[1].instrument
      const edited = request.edit && normalizeTrackInstrumentParams(parseJsonValue(request.edit.content.params) ?? null)
      if (request.edit && !(prepared && edited
        && isLiveParameterChange({ targetId: node.id, effect: "instrument", from: prepared, to: edited }, snapshot.bpm))) {
        return { accepted: false, reason: "unsupported" }
      }
      if (request.values.length === 0) {
        const sequence = ++nextLiveProcessorSequence
        return { accepted: true, sequence, appliedSequence: sequence }
      }
      const targets = new Map(node.instrument.parameterTargets.map((entry) => [entry.id, entry.target]))
      const events = request.values.map((value) => {
        const target = targets.get(value.parameterId)
        return target === undefined || !Number.isFinite(value.value) ? undefined : {
          nodeId: node.id, type: "parameter", noteId: 1, sequence: ++nextLiveProcessorSequence,
          frameOffset: 0, channel: 0, note: target, value: value.value,
        } satisfies PortableWasmInstrumentEvent
      })
      if (events.some((event) => event === undefined)) return { accepted: false, reason: "unsupported" }
      const revision = activeRevision
      const deliveryEpoch = epoch
      const sequence = nextLiveProcessorSequence
      const settled = Promise.withResolvers<void>()
      liveInstrumentSends.add(settled.promise)
      try {
        const acceptedEvents = events.flatMap(event => event === undefined ? [] : [event])
        await session.queueInstrumentEvents(deliveryEpoch, acceptedEvents, { revision, sequence })
        // Preparation can finish while the old session's applied ack is in
        // flight. Discover the replacement after that ack, not at submission.
        const replacement = parameterReplacement
        if (replacement?.session.queueInstrumentEvents) {
          const replacementEvents = acceptedEvents.map(event => ({ ...event, sequence: ++nextLiveProcessorSequence }))
          await replacement.session.queueInstrumentEvents(replacement.epoch, replacementEvents, {
            revision, sequence: nextLiveProcessorSequence,
          })
        }
        if (active !== session || activeRevision !== revision || epoch !== deliveryEpoch) return { accepted: false, reason: "stale" }
        // The session now plays the edit; the prepared snapshot follows, so the release announce finds nothing to rebuild.
        if (edited && prepared && isLiveEventOnlyInstrumentChange(prepared, edited)) rememberInstrumentParameters(node.id, edited)
        return { accepted: true, sequence, appliedSequence: sequence }
      } catch (error) {
        return { accepted: false, reason: "bridge-error", error: String(error) }
      } finally {
        liveInstrumentSends.delete(settled.promise)
        settled.resolve()
      }
    }
    if (!active.queueProcessorEvents) return { accepted: false, reason: "unsupported" }
    const processor = resolveGraphProcessor(activeGraph, request.instanceId)
    if (!processor) return { accepted: false, reason: "unsupported" }
    if (request.edit) {
      const targetId = processor.node.id === activeGraph.masterNodeId ? "master" : processor.node.id
      const installed = (targetId === "master" ? activeSnapshot?.mixer.fx.masterFxInstances
        : activeSnapshot?.mixer.fx.trackFx?.[targetId]?.instances)?.find(instance => instance.id === request.instanceId)
      const timing = request.edit.content.timing
      const values = Object.fromEntries(request.values.map(value => [value.parameterId, value.value]))
      if (!installed || !timing || request.edit.target.nodeId !== targetId
        || request.edit.target.kindId !== processor.processor.kindId
        || !nativeBuiltInLiveStateCovered({ enabled: !processor.processor.bypassed, input: installed }, timing, values)) {
        return { accepted: false, reason: "unsupported" }
      }
    }
    const events = request.values.map((value) => {
      const target = processor.parameterTargets.get(value.parameterId)
      return target === undefined || !Number.isFinite(value.value)
        ? undefined
        : {
            processorInstanceId: processor.processor.instanceId,
            parameterTarget: target,
            frameOffset: 0,
            value: value.value,
          }
    })
    if (events.some((event) => event === undefined)) return { accepted: false, reason: "unsupported" }
    const sequence = Math.max(nextLiveProcessorSequence + 1, request.sequence ?? 0)
    nextLiveProcessorSequence = sequence
    try {
      await active.queueProcessorEvents(
        activeRevision,
        epoch,
        sequence,
        events.flatMap((event) => event === undefined ? [] : [event]),
      )
      return { accepted: true, sequence, appliedSequence: sequence }
    } catch (error) {
      return { accepted: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) }
    }
  }

  const liveProcessorControl: LiveProcessorControl = {
    preview: queueLiveProcessorControl,
    flush: queueLiveProcessorControl,
    reenableAutomation: async (instanceId, parameterIds, revision, transportEpoch) => {
      if (adoptionPublish) await adoptionPublish
      if (revision !== activeRevision || transportEpoch !== epoch) return { accepted: false, reason: "stale" }
      if (!active || !active.reenableProcessorAutomation) return { accepted: false, reason: "unsupported" }
      const processor = activeGraph === undefined ? undefined : resolveGraphProcessor(activeGraph, instanceId)
      if (!processor || parameterIds.some((parameterId) => !processor.parameterTargets.has(parameterId))) {
        return { accepted: false, reason: "unsupported" }
      }
      const targets = parameterIds.map((parameterId) => processor.parameterTargets.get(parameterId))
        .filter((target): target is number => target !== undefined)
      const sequence = ++nextLiveProcessorSequence
      try {
        await active.reenableProcessorAutomation(revision, transportEpoch, processor.processor.instanceId, targets)
        return { accepted: true, sequence, appliedSequence: sequence }
      } catch (error) {
        return { accepted: false, reason: "bridge-error", error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
  const reenableProcessorAutomation = async (
    instanceId: string,
    parameterIds: readonly string[],
  ): Promise<LiveProcessorControlResult> => {
    if (adoptionPublish) await adoptionPublish
    if (activeRevision === undefined || activeGraph === undefined) {
      return { accepted: false, reason: "unprepared" }
    }
    return liveProcessorControl.reenableAutomation(instanceId, parameterIds, activeRevision, epoch)
  }

  return {
    start,
    pause,
    dispose,
    startRecording,
    stopRecording,
    cancelRecording,
    isActive: () => playing,
    isPrepared: () => active !== undefined,
    preparedInstrumentIdentity: (targetId: string) => {
      if (!active || !activeGraph) return undefined
      const instrument = activeSnapshot?.mixer.fx.trackFx?.[targetId]?.instrument
      return instrument ? { kind: instrument.kind, instanceId: instrument.instanceId } : null
    },
    preparedInstrument: (targetId: string) => activeSnapshot?.mixer.fx.trackFx?.[targetId]?.instrument,
    rememberInstrumentParameters,
    isPreparing: () => pendingStart !== undefined,
    liveProcessorControl,
    reenableProcessorAutomation,
    isRecording: () => recording !== undefined,
    ensurePrepared,
    rebuildPrepared,
    refreshSchedule,
    adoptSchedule,
    seek,
    currentPositionSec: () => {
      const context = input.getAudioContext()
      return context
        ? arrangementFrame() / context.sampleRate
        : undefined
    },
  }
}
