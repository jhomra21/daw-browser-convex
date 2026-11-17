import { replaceEqualDeep } from '@tanstack/solid-query'
import { untrack, type Accessor } from 'solid-js'

import type { Track } from '@daw-browser/timeline-core/types'
import type { createNativePlaybackController } from '~/lib/desktop/native-playback-controller'
import { playbackClipFingerprint, type LivePlaybackSnapshot } from '~/lib/live-playback-snapshot'
import type { createPortableBrowserPlaybackController } from '~/lib/portable-browser-playback-controller'
import type {
  LoopOptions,
  NativePlaybackOptions,
  PortableBrowserPlaybackOptions,
  TimelineScheduleOptions,
} from './timeline-playback-types'

type ScheduleReconciliationInput = {
  loopOptions?: LoopOptions
  nativeOptions?: NativePlaybackOptions
  portableBrowserOptions?: PortableBrowserPlaybackOptions
  nativePlayback: ReturnType<typeof createNativePlaybackController>
  portableBrowserPlayback: ReturnType<typeof createPortableBrowserPlaybackController>
  getLoopParams: () => { enabled: boolean; start: number; end: number; length: number; isActive: boolean }
  isPlaying: Accessor<boolean>
  // The hook's transport state at the moment of the call: an adoption compares what it captured with what is current.
  host: {
    mounted: () => boolean
    transportIntentToken: () => number
    nativeLifecycleToken: () => number
    nativeSeekSequence: () => number
    rebuildInProgress: () => boolean
    playAttemptPending: () => boolean
    disposeNativePreview: (options?: { invalidateProjectArtifacts?: boolean }, reason?: string, after?: Promise<void>) => Promise<void>
    ensureLivePortableSession: () => Promise<void>
    applyTimelineSchedule: (tracks: Track[], options?: TimelineScheduleOptions) => Promise<void>
  }
}

type ScheduleReconciliationState = {
  previewProjectionBaseline: string | undefined
  // What the paused native preview in flight compiled, kept across the edits that land before it commits.
  nativePreviewCompiledFingerprint: string | undefined
  portableCompiledFingerprint: string | undefined
}

// What the desired timeline state is, what each backend last adopted of it, and the adoption of an edit into a running or
// paused session. The playback hook owns the effects that call into it.
export const createScheduleReconciliation = (input: ScheduleReconciliationInput) => {
  const { loopOptions, nativeOptions, portableBrowserOptions, nativePlayback, portableBrowserPlayback, getLoopParams, isPlaying, host } = input
  const { disposeNativePreview, ensureLivePortableSession, applyTimelineSchedule } = host
  const schedule: ScheduleReconciliationState = {
    previewProjectionBaseline: undefined,
    nativePreviewCompiledFingerprint: undefined,
    portableCompiledFingerprint: undefined,
  }
  // The newest key submitted to an adoption, native or portable, and not yet settled. An edit back to the baseline while
  // it differs must still be submitted: it supersedes, or is compiled after, the edit before it.
  let adoptionKey: string | undefined

  const requestTimelineSchedule = async (
    tracks: Track[],
    options?: TimelineScheduleOptions,
    explicit = false,
  ): Promise<void> => {
    // A kept paused native preview adopts what it carries, as a playing one does. An edit takes the owner and transport
    // state the session has when it commits, never the ones its intent captured. Only a lifecycle rebuild, which names
    // rebuildBackend, replaces the session.
    if (!((nativePlayback.isActive() || (nativePlayback.isPrepared() && !options?.rebuildBackend))
      && nativePlayback.canAdoptInPlace()
      && (!options?.rebuildBackend || !options.owner || options.owner === "native")
      && (options?.projectId === undefined || options.projectId === nativeOptions?.projectId?.())
      && (options?.projectGeneration === undefined || options.projectGeneration === nativeOptions?.projectGeneration?.()))) {
      // A prepared portable session, playing or paused, adopts every edit on its own core, as native does. Only a
      // lifecycle rebuild (a locate the session refused, a retried instrument preparation) names rebuildBackend.
      if (options?.rebuildBackend || !portableBrowserPlayback.isPrepared()) return applyTimelineSchedule(tracks, options)
      const paused = !untrack(isPlaying)
      // The key and the loop are read together, so both describe the state this adoption answers for.
      const key = readDesiredScheduleFingerprint(tracks)
      const { isActive, start, end } = getLoopParams()
      const transportIntent = host.transportIntentToken()
      const lifecycle = host.nativeLifecycleToken()
      adoptionKey = key
      const outcome = await portableBrowserPlayback.adoptSchedule({ loopEnabled: isActive, loopStartSec: start, loopEndSec: end })
        .finally(() => { if (adoptionKey === key) adoptionKey = undefined })
      if (!host.mounted() || transportIntent !== host.transportIntentToken() || lifecycle !== host.nativeLifecycleToken()) return
      if (paused) {
        if (outcome === "adopted" || outcome === "unchanged") schedule.previewProjectionBaseline = key
        // A session that went away is replaced where it stood; a failed staging keeps the session and the controller
        // resubmits it once Play reports frames.
        else if (outcome === "unavailable") {
          await disposeNativePreview(undefined, "paused-preview-structural-change")
          const token = host.nativeLifecycleToken()
          await ensureLivePortableSession()
          if (token === host.nativeLifecycleToken() && portableBrowserPlayback.isPrepared() && !portableBrowserPlayback.isActive()) schedule.previewProjectionBaseline = key
        }
        return
      }
      // A take holds the session's loop, so the desired state is not marked applied: the follow after the take adopts it.
      if (portableBrowserPlayback.isRecording()) return
      if (outcome === "adopted" || outcome === "unchanged") schedule.previewProjectionBaseline = key
      // A failed staging leaves the baseline behind: the controller resubmits it at block boundaries and logs each one.
      return
    }
    const key = readDesiredScheduleFingerprint(tracks)
    const transportIntent = host.transportIntentToken()
    const seekSequence = host.nativeSeekSequence()
    const lifecycle = host.nativeLifecycleToken()
    const projectId = nativeOptions?.projectId?.()
    const projectGeneration = nativeOptions?.projectGeneration?.()
    const { isActive, start, end } = getLoopParams()
    adoptionKey = key
    const outcome = await nativePlayback.adoptSchedule({
      key,
      schedule: JSON.stringify({ tracks: readNativePreviewTrackFingerprint(tracks), loop: getLoopParams(), bpm: loopOptions?.bpm?.() }),
      context: { instrumentOverride: options?.instrumentOverride, externalProcessor: options?.externalProcessor },
      loop: { loopEnabled: isActive, loopStartSec: start, loopEndSec: end },
    }, explicit).finally(() => { if (adoptionKey === key) adoptionKey = undefined })
    const current = () => host.mounted() && transportIntent === host.transportIntentToken() && seekSequence === host.nativeSeekSequence()
      && lifecycle === host.nativeLifecycleToken() && projectId === nativeOptions?.projectId?.()
      && projectGeneration === nativeOptions?.projectGeneration?.()
    // A locate ends the publication of an edit that was under way, and the fingerprint the Play recorded already counts the
    // edit as applied, so nothing follows it: the same request runs again against the moved transport.
    if (outcome.status === "superseded" && seekSequence !== host.nativeSeekSequence() && host.mounted() && lifecycle === host.nativeLifecycleToken()
      && transportIntent === host.transportIntentToken()) return requestTimelineSchedule(tracks, options, explicit)
    if (!current()) return
    if (outcome.status === "adopted" || outcome.status === "unchanged") schedule.previewProjectionBaseline = key
  }
  const bufferFingerprints = new WeakMap<object, number>()
  let nextBufferFingerprint = 1
  const readBufferFingerprint = (buffer: AudioBuffer | null | undefined) => {
    if (!buffer) return null
    const existing = bufferFingerprints.get(buffer)
    if (existing !== undefined) return existing
    const fingerprint = nextBufferFingerprint++
    bufferFingerprints.set(buffer, fingerprint)
    return fingerprint
  }
  // A track's compiler inputs are the fields the playback compiles read: its mixer channel (createMixerChannel), its
  // frame schedule (compilePortableFrameSchedule), its clip projection (projectPortableClipEvents) and its native
  // instruments (compileLiveNativeProjection). A name reaches only the mixer channel's label and a colour no compile, so
  // neither changes what plays.
  const readNativePreviewTrackFingerprint = (tracks = loopOptions?.getTracks?.() ?? []) => JSON.stringify({
    bpm: loopOptions?.bpm?.(),
    tracks: tracks.map(({ id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId, clips }) => ({
      id, kind, channelRole, groupId, volume, muted, soloed, sends, outputTargetId,
      clips: clips.map((clip) => {
        const buffer = "buffer" in clip && globalThis.AudioBuffer && clip.buffer instanceof AudioBuffer
          ? clip.buffer
          : undefined
        return { ...playbackClipFingerprint(clip), buffer: readBufferFingerprint(buffer) }
      }),
    })),
  })
  // The caller's memo may hand out a new object for unchanged content, so the identity advances only when the content
  // differs from the last one seen.
  // `replaceEqualDeep` hands back its first argument when the two hold the same plain data, sharing any reference.
  let lastPlaybackInputs: { value: object; identity: number } | undefined
  const readPlaybackInputsIdentity = () => {
    const inputs = nativeOptions?.playbackInputs?.()
    if (!inputs) return undefined
    const previous = lastPlaybackInputs
    lastPlaybackInputs = { value: inputs, identity: (previous?.identity ?? 0)
      + (previous && replaceEqualDeep(previous.value, inputs) === previous.value ? 0 : 1) }
    return lastPlaybackInputs.identity
  }
  const readDesiredScheduleFingerprint = (tracks = loopOptions?.getTracks?.() ?? []) => JSON.stringify({
    tracks: readNativePreviewTrackFingerprint(tracks), inputs: readPlaybackInputsIdentity(), loop: getLoopParams(),
  })
  const readScheduleSnapshotFingerprint = (snapshot: LivePlaybackSnapshot) => JSON.stringify({
    ...snapshot,
    revision: undefined,
    processorStateSequence: undefined,
    transport: { ...snapshot.transport, playheadSec: undefined, state: undefined },
    tracks: readNativePreviewTrackFingerprint([...snapshot.tracks]),
    // The resolved mixer graph is compiled from the tracks and fx above (compileLivePlaybackSnapshot); it also carries
    // each channel's label.
    mixer: { ...snapshot.mixer, graph: undefined },
    assets: snapshot.assets.map((asset) => ({ ...asset, buffer: readBufferFingerprint(asset.buffer) })),
  })
  const hasPendingAudioClipHydration = () => (loopOptions?.getTracks?.() ?? []).some((track) =>
    track.clips.some((clip) => (
      !clip.midi
      && Boolean(clip.sourceAssetKey)
      && !("buffer" in clip && clip.buffer)
      && clip.mediaStatus !== "missing"
      && clip.mediaStatus !== "permission-denied"
    )),
  )
  // The playing portable session follows the newest desired state, as native adoption does: what it carries live is
  // adopted on the same core, as is an edit that landed while its start was in flight.
  const adoptPortableEdits = () => {
    void untrack(() => requestTimelineSchedule(loopOptions?.getTracks?.() ?? [])).catch((cause: unknown) => {
      portableBrowserOptions?.reportFault?.(cause instanceof Error ? cause.message : 'Playback could not follow the edit.')
    })
  }
  // A paused session that finished preparing carries what it compiled; an edit that landed meanwhile is adopted into it.
  const adoptEditsPastBaseline = () => {
    if (untrack(() => readDesiredScheduleFingerprint()) !== schedule.previewProjectionBaseline) adoptPortableEdits()
  }
  const followPortableEdits = () => {
    if (host.rebuildInProgress() || host.playAttemptPending() || !untrack(isPlaying) || !(portableBrowserPlayback.isActive() || nativePlayback.isActive())
      || hasPendingAudioClipHydration()
      || untrack(() => {
        const desired = readDesiredScheduleFingerprint()
        return desired === schedule.previewProjectionBaseline && (adoptionKey === undefined || adoptionKey === desired)
      })) return
    adoptPortableEdits()
  }

  return {
    schedule,
    readDesiredScheduleFingerprint,
    readScheduleSnapshotFingerprint,
    hasPendingAudioClipHydration,
    adoptPortableEdits,
    adoptEditsPastBaseline,
    followPortableEdits,
    requestTimelineSchedule,
  }
}
