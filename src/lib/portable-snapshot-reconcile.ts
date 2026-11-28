import type { PreparedPortableSession } from "@daw-browser/audio-engine/portable-session-compiler"
import type { LivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
/* oxlint-disable eslint/no-restricted-imports -- the live-parameter rules stay in the desktop mapper until the batch that owns the certification-pinned playback files moves it */
import { isLiveEventOnlyInstrumentChange, isLiveParameterChange } from "~/lib/desktop/native-built-in-parameter-mapper"
/* oxlint-enable eslint/no-restricted-imports */
import { mergeSynthParams, type TrackInstrumentParams } from "@daw-browser/shared"
import type { AudioEffectRuntimeInstance } from "@daw-browser/audio-engine/audio-engine"
import { runtimeInstanceKey } from "@daw-browser/audio-engine/effects/runtime-instance"
import { createAudioEffectParameterPayload } from "~/lib/audio-effect-parameter-payload"
import { movedSynthLiveFields } from "~/lib/processor-edit-semantics"

type PortableSchedule = Extract<PreparedPortableSession, { supported: true }>["schedule"]

// A compile reads the project, which a knob drag only reaches on release,
// so the values the session accepted since `since` are laid over it; a field the accepted instrument did not move
// keeps what the compile read.
export const withAcceptedLiveSynthValues = (
  snapshot: LivePlaybackSnapshot, since: LivePlaybackSnapshot, accepted: LivePlaybackSnapshot,
): LivePlaybackSnapshot => {
  const fx = snapshot.mixer.fx

  const trackFx = Object.fromEntries(Object.entries(fx.trackFx ?? {}).map(([id, entry]) => {
    const now = accepted.mixer.fx.trackFx?.[id]?.instrument
    const before = since.mixer.fx.trackFx?.[id]?.instrument
    const compiled = entry.instrument

    if (now?.kind !== "synth" || before?.kind !== "synth" || compiled?.kind !== "synth"
      || now.instanceId !== before.instanceId || now.instanceId !== compiled.instanceId) return [id, entry]
    const update = movedSynthLiveFields(before.params, now.params)

    return [id, { ...entry, instrument: { ...compiled, params: mergeSynthParams(compiled.params, update) } }]
  }))

  return { ...snapshot, mixer: { ...snapshot.mixer, fx: { ...fx, trackFx } } }
}

// What a playing portable session adopts live: track volume, mute, solo, sends and output, the mixer graph and
// its automation, master volume, and processor or instrument edits the parameter mapper takes live. `next` with all of
// that taken from `previous` fingerprints as `previous` exactly when nothing else changed.
export const withLiveContentOf = (next: LivePlaybackSnapshot, previous: LivePlaybackSnapshot): LivePlaybackSnapshot => {
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

type SnapshotClip = LivePlaybackSnapshot["tracks"][number]["clips"][number]

export const hasStretchClips = (snapshot: LivePlaybackSnapshot) => snapshot.tracks.some((track) => track.clips.some((clip) => (
  clip.audioWarp?.enabled === true && clip.audioWarp.mode === "stretch"
)))

// The clips of a track the seam carries, as `installed` has them: every MIDI clip, and of the audio clips their start,
// duration, trim offset, gain, fades, warp and the asset they play, and their addition or deletion. A warped clip's
// Stretch artifact is prepared for the candidate before the seam, so its placement and warp are carried like any other.
const withSeamClips = (next: readonly SnapshotClip[], installed: readonly SnapshotClip[]): SnapshotClip[] => {
  const incoming = new Map(next.map((clip) => [clip.id, clip]))

  return installed.map((clip) => {
    const edited = incoming.get(clip.id)

    if (clip.midi || !edited) return clip

    const { startSec, duration, bufferOffsetSec, gain, fades, audioWarp, sourceAssetKey, sourceKind, sourceDurationSec, sourceSampleRate,
      sourceChannelCount, sampleUrl, buffer } = clip

    return { ...edited, startSec, duration, bufferOffsetSec, gain, fades, audioWarp, sourceAssetKey, sourceKind, sourceDurationSec,
      sourceSampleRate, sourceChannelCount, sampleUrl, buffer }
  })
}

// The instances of `next` as `installed` has them where an edit leaves the same effect (the id and kind), whatever else of
// its parameters moved: the core reconfigures it under continuity, keeping its history when its structure allows and
// starting it again otherwise, and moves the read heads where its delay changed, as native does through the same calls
// (the core's graph publication). A Spectral fftSize change is replaced instead: the old stage fades out as a ghost and a
// fresh stage of the new size starts (`replaced_by_spectral_size_change`).
const withInstalledEffectParams = (next: readonly AudioEffectRuntimeInstance[], installed: readonly AudioEffectRuntimeInstance[] = []): AudioEffectRuntimeInstance[] => {
  const installedByKey = new Map(installed.map((instance) => [runtimeInstanceKey(instance), instance]))

  return next.map((instance) => installedByKey.get(runtimeInstanceKey(instance)) ?? instance)
}

// What a playing session adopts at a seam, beyond what it takes live: the tempo, the loop fields, the clips of tracks it
// already plays (`withSeamClips`, the warp and the asset a clip plays included), the assets the instruments and clips it
// plays name, the instrument of each track it plays (an edit, another kind or another instance: the core crossfades the
// replaced one out, and the held notes follow `keepsInstrumentVoices`), and the parameters of the effects
// it plays that the live path does not take (`withInstalledEffectParams`). `next` with that taken from `previous`
// fingerprints as `previous` when nothing else changed. The tracks added or deleted are no part of the comparison
// (`onSharedTracks`), nor are the effects those tracks have inserted, removed or moved (`onKeptEffects`). Still refused: a
// sample that becomes or ceases to be available.
export const withSeamContentOf = (next: LivePlaybackSnapshot, previous: LivePlaybackSnapshot): LivePlaybackSnapshot => {
  const previousTracks = new Map(previous.tracks.map((track) => [track.id, track]))

  const trackFx = next.mixer.fx.trackFx && Object.fromEntries(Object.entries(next.mixer.fx.trackFx).map(([id, entry]) => {
    const installed = previous.mixer.fx.trackFx?.[id]

    return [id, installed ? { ...entry, instrument: installed.instrument, instances: withInstalledEffectParams(entry.instances, installed.instances) } : entry]
  }))

  return {
    ...next,
    assets: previous.assets,
    bpm: previous.bpm,
    transport: {
      ...next.transport,
      loopEnabled: previous.transport.loopEnabled,
      loopStartSec: previous.transport.loopStartSec,
      loopEndSec: previous.transport.loopEndSec,
    },
    tracks: next.tracks.map((track) => {
      const installed = previousTracks.get(track.id)

      return installed ? { ...track, channelRole: installed.channelRole, groupId: installed.groupId, clips: withSeamClips(track.clips, installed.clips) } : track
    }),
    mixer: { ...next.mixer, fx: { ...next.mixer.fx, masterFxInstances: withInstalledEffectParams(next.mixer.fx.masterFxInstances, previous.mixer.fx.masterFxInstances), trackFx } },
  }
}

export const onSharedTracks = (snapshot: LivePlaybackSnapshot, other: LivePlaybackSnapshot): LivePlaybackSnapshot => {
  const shared = new Set(other.tracks.map((track) => track.id))
  const trackFx = snapshot.mixer.fx.trackFx && Object.fromEntries(Object.entries(snapshot.mixer.fx.trackFx).filter(([id]) => shared.has(id)))

  return { ...snapshot, tracks: snapshot.tracks.filter((track) => shared.has(track.id)), mixer: { ...snapshot.mixer, fx: { ...snapshot.mixer.fx, trackFx } } }
}

// `snapshot` with the effects an adoption carries taken out of the comparison: every one inserted, removed, replaced
// (another kind under the same id) or moved leaves only what both sides keep, by id. The core keeps a survivor's history
// by instance id, fades a removed one over its 5 ms ghost, dips a node whose stages were reordered and moves the read
// heads where the node's delay changed. A surviving effect's own edit stays in the comparison (`withLiveContentOf` decides
// which are live). Both snapshots hold the tracks both sides play (`onSharedTracks`), so each track has an entry on both,
// empty when it has no effects.
export const onKeptEffects = (snapshot: LivePlaybackSnapshot, other: LivePlaybackSnapshot): LivePlaybackSnapshot => {
  const own = snapshot.mixer.fx.trackFx ?? {}
  const theirs = other.mixer.fx.trackFx ?? {}

  const trackFx = Object.fromEntries(snapshot.tracks.map(({ id }) => {
    const entry = own[id]
    const kept = new Set((theirs[id]?.instances ?? []).map(runtimeInstanceKey))

    return [id, { ...entry, instances: (entry?.instances ?? []).filter((instance) => kept.has(runtimeInstanceKey(instance))).sort((left, right) => left.id.localeCompare(right.id)) }]
  }))

  return { ...snapshot, mixer: { ...snapshot.mixer, fx: { ...snapshot.mixer.fx, trackFx } } }
}

// `next` in the order the session built its graph in, with the tracks it adds after the rest. A track's place among the
// others sounds like nothing, so a reorder is the session's own graph again, and the node and edge lists keep their places.
export const inSessionOrder = (next: LivePlaybackSnapshot, previous: LivePlaybackSnapshot): LivePlaybackSnapshot => {
  const ranked = <T>(items: readonly T[], id: (item: T) => string, before: readonly string[]) => {
    const rank = new Map(before.map((entry, index) => [entry, index]))

    return [...items].sort((left, right) => (rank.get(id(left)) ?? rank.size) - (rank.get(id(right)) ?? rank.size))
  }

  const trackIds = previous.tracks.map((track) => track.id)

  const trackFx = next.mixer.fx.trackFx
    && Object.fromEntries(ranked(Object.entries(next.mixer.fx.trackFx), ([id]) => id, Object.keys(previous.mixer.fx.trackFx ?? {})))

  return {
    ...next,
    tracks: ranked(next.tracks, (track) => track.id, trackIds),
    assets: ranked(next.assets, (asset) => asset.assetId, previous.assets.map((asset) => asset.assetId)),
    mixer: {
      ...next.mixer,
      graph: { ...next.mixer.graph, channels: ranked(next.mixer.graph.channels, (entry) => entry.channel.id, trackIds) },
      fx: { ...next.mixer.fx, trackFx },
    },
  }
}

// An adopted schedule starts at `seamFrame` while the session keeps sounding what the old schedule started before it.
// A note that sounds at the seam and is not the same note in `next` gets a note-off at the seam; one that survives keeps
// its voice, because a repeated note-on would stick a Synth (it then needs two note-offs) and double a Sampler.
// Whether an edit leaves an instrument its voices, as native's retained-instruments rule (`retainedInstruments` in native-schedule-coordinator.ts) and the core's
// `same_instrument_configuration` do: the same instance with the same configuration and the same samples.
// A Synth moves the eight fields its live events carry without replacing its slot.
export const keepsInstrumentVoices = (before: TrackInstrumentParams | undefined, after: TrackInstrumentParams | undefined) =>
  before !== undefined && after !== undefined && before.instanceId === after.instanceId && before.kind === after.kind
  && (before.kind === "synth" && after.kind === "synth" ? isLiveEventOnlyInstrumentChange(before, after) : JSON.stringify(before) === JSON.stringify(after))

export const reconcileAtSeam = (input: {
  previous: PortableSchedule
  next: PortableSchedule
  seamFrame: number
  keepsVoices: (trackId: string) => boolean
  // A deleted track's node is not in the candidate, so a note-off for it would reject the staged schedule; the core's
  // 5 ms deletion fade ends its voices.
  hasTrack: (trackId: string) => boolean
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

  const releases = [...sounding.values()].flatMap((held): PortableSchedule["events"][number][] => input.hasTrack(held.target.trackId) ? [{
    type: "note-off", target: held.target, noteId: held.noteId, pitch: held.pitch, frame: seamFrame, sequence: 0,
  }] : [])

  // `next` starts at the seam, so the releases go first: a release precedes a note-on at the same frame.
  return {
    ...next,
    events: [...releases, ...next.events.filter((event) => !continued.has(event))]
      .map((event, index) => ({ ...event, sequence: index + 1 })),
  }
}
