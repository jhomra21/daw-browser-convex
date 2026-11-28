import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor, onSettled, createTrackedEffect } from 'solid-js'

import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { createStoredValue } from '~/lib/stored-value'
import { DEFAULT_NOTE_VELOCITY } from '~/lib/midi-editor-grid'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { Track } from '@daw-browser/timeline-core/types'
import { automationTargetKey, compileMidiMappingSourceIndex, isClipKindCompatibleWithTrack, midiMappingValue, normalizeLegacyMidiClip, type MidiMappingSourceEvent, bestEffort } from '@daw-browser/shared'
import { useMidiKeyboardInput } from './useMidiKeyboardInput'
import { useMidiAccess } from '~/context/midi-access'
import { createLiveMidiRouter } from '~/lib/midi/live-midi-router'
import { shouldUseNativeLiveMidi } from '~/lib/midi/live-midi-backend'
import { projectMidiProjectTracks, subscribeMidiProjectProjection } from '~/lib/midi/editor-persistence'
import { createDesktopAudioLifecycleReconciler } from '~/lib/desktop-audio-lifecycle'
import { createLiveMidiArpeggiator, type LiveMidiArpeggiatorRelease } from '~/lib/midi/live-midi-arpeggiator'
import { createAuditionReleaseTimerOwnership } from '~/lib/audition-release-timer-ownership'

import type { TimelineSelectionController } from '~/lib/timeline-selection'
import type { NativeLiveMidiNoteHandle } from '~/lib/desktop/native-live-midi'
import type { PortableLiveNoteHandle } from '~/lib/portable-browser-playback-controller'
import { desktopBridge } from '~/lib/runtime'

type UseTimelineMidiOverlayOptions = {
  audioEngine: AudioEngine
  requiresNativeAudio?: boolean
  tracks: Accessor<Track[]>
  projectId: Accessor<string>
  bpm: Accessor<number>
  isPlaying: Accessor<boolean>
  playheadSec: Accessor<number>
  selection: TimelineSelectionController
  activeRecordingTargetId?: Accessor<string | null>
  dockedMidiClipId: Accessor<string | null>
  nativeLiveMidi?: {
    isActive: () => boolean
    isAvailable: () => boolean
    start: (note: { trackId: string; pitch: number; velocity: number }) => NativeLiveMidiNoteHandle | undefined
    stop: (handle: NativeLiveMidiNoteHandle, force?: boolean) => void
    subscribeReset?: (listener: () => void) => () => boolean
  }
  effectsPanelOpen: Accessor<boolean>
  portableLiveMidi?: {
    prepare: () => void
    start: (note: { trackId: string; pitch: number; velocity: number }) => PortableLiveNoteHandle | undefined
    stop: (handle: PortableLiveNoteHandle, force?: boolean) => void
  }
}

type UseTimelineMidiOverlayReturn = {
  midiEditorClipId: Accessor<string | null>
  auditionNote: (trackId: string, pitch: number, velocity?: number, durSec?: number) => void
  midiKeyboard: {
    enabled: Accessor<boolean>
    canPlay: Accessor<boolean>
    targetLabel: Accessor<string | null>
    octave: Accessor<number>
    toggle: () => void
    isActive: (pitch: number) => boolean
  }
}

type LiveBackendHandle = NativeLiveMidiNoteHandle | PortableLiveNoteHandle

type LiveNote =
  | { handle: number; arpeggiator: ReturnType<typeof createLiveMidiArpeggiator<LiveBackendHandle>> }

export function useTimelineMidiOverlay(
  options: UseTimelineMidiOverlayOptions,
): UseTimelineMidiOverlayReturn {
  const midiAccess = useMidiAccess()
  const requiresNativeAudio = options.requiresNativeAudio === true
  const [midiKeyboardEnabled, setMidiKeyboardEnabled] = createSignal(false)
  const [projectionRevision, setProjectionRevision] = createSignal(0)
  const activeLiveNotes = new Map<number, LiveNote>()

  const activeMappingTargets = new Map<string, {
    sourceId: string
    trackId: string
    target: { parameterId: string; effectInstanceId?: string }
  }>()

  let scheduledMappingTargetKeys = new Set<string>()

  const auditionReleaseTimers = createAuditionReleaseTimerOwnership({
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (timer) => window.clearTimeout(timer),
  })

  let liveTargetKey: string | undefined

  const projectedTracks = createMemo(() => {
    projectionRevision()

    return projectMidiProjectTracks(options.projectId(), options.tracks())
  })

  const trackIndex = createMemo(() => createTimelineTrackIndex(projectedTracks()))

  const midiEditorClipId = createMemo(() => {
    const clipId = options.dockedMidiClipId()

    return clipId && trackIndex().clipEntryById.get(clipId)?.clip.midi ? clipId : null
  })

  const storedMidiKeyboardEnabled = createStoredValue<boolean>({
    key: (scope) => `mb:midi_kb:${scope}`,
    fallback: () => false,
    parse: (raw) => raw === '1',
    serialize: (value) => value ? '1' : '0',
  })

  const midiKeyboardStorageScope = () => options.projectId() || 'default'

  const isPlayableMidiTrack = (track: Track | undefined) => isClipKindCompatibleWithTrack(track, 'midi')

  const resolveTargetTrack = () => {
    const recordingTrackId = options.activeRecordingTargetId?.()

    if (recordingTrackId) {
      const recordingTrack = trackIndex().trackById.get(recordingTrackId)

      if (isPlayableMidiTrack(recordingTrack)) return recordingTrack
    }

    const clipId = midiEditorClipId()

    if (clipId) {
      const match = trackIndex().clipEntryById.get(clipId)

      if (match && isPlayableMidiTrack(match.track)) return match.track
    }

    const fxTarget = options.selection.selectedFXTarget()

    if (fxTarget !== 'master') {
      const track = trackIndex().trackById.get(fxTarget)

      if (isPlayableMidiTrack(track)) return track
    }

    const selectedTrack = trackIndex().trackById.get(options.selection.selectedTrackId())

    if (isPlayableMidiTrack(selectedTrack)) return selectedTrack

    return undefined
  }

  const midiKeyboardTarget = createMemo(resolveTargetTrack)
  const audioHostBridge = desktopBridge()?.audioHost
  const hasAudioLifecycle = audioHostBridge !== undefined
  const lifecycleBridge = audioHostBridge
  let midiSuspended = false
  let nativeMidiReady = !hasAudioLifecycle
  const resolveTargetTrackId = () => midiKeyboardTarget()?.id
  const midiKeyboardCanPlay = createMemo(() => Boolean(midiKeyboardTarget()))
  const midiKeyboardTargetLabel = createMemo(() => midiKeyboardTarget()?.name ?? null)

  const activeMappingIndex = createMemo(() => {
    const clipId = midiEditorClipId()
    const clip = clipId ? trackIndex().clipEntryById.get(clipId)?.clip : undefined

    return clip?.midi ? compileMidiMappingSourceIndex(normalizeLegacyMidiClip(clip.midi).mappings) : undefined
  })

  const activeMappingFingerprint = createMemo(() => {
    const clipId = midiEditorClipId()
    const clip = clipId ? trackIndex().clipEntryById.get(clipId)?.clip : undefined

    return clip?.midi ? JSON.stringify(normalizeLegacyMidiClip(clip.midi).mappings) : ''
  })

  const activeInputChannel = createMemo(() => {
    const clipId = midiEditorClipId()
    const clip = clipId ? trackIndex().clipEntryById.get(clipId)?.clip : undefined

    return clip?.midi?.inputChannel
  })

  const restoreLiveMappings = (sourceId?: string) => {
    if (requiresNativeAudio) return

    for (const [key, mapping] of activeMappingTargets) {
      if (sourceId !== undefined && mapping.sourceId !== sourceId) continue
      options.audioEngine.restoreTransientMidiMapping(
        mapping.trackId,
        mapping.target,
        undefined,
        sourceId,
      )
      activeMappingTargets.delete(key)
    }
  }

  const usesNativeLiveMidi = (native: UseTimelineMidiOverlayOptions['nativeLiveMidi']): native is NonNullable<typeof native> =>
    native !== undefined
    && !midiSuspended
    && (requiresNativeAudio || (nativeMidiReady && shouldUseNativeLiveMidi(native)))

  // Every note, played or arpeggiated, goes to the native host or to the portable session; neither is timed from here.
  const liveNoteBackend = {
    start: (note: { trackId: string; pitch: number; velocity: number }): LiveBackendHandle | undefined => {
      if (usesNativeLiveMidi(options.nativeLiveMidi)) {
        const handle = options.nativeLiveMidi.start(note)

        if (handle) return handle
      }

      if (requiresNativeAudio) return undefined

      options.audioEngine.ensureAudio()
      bestEffort(options.audioEngine.resume(), 'the note starts without waiting for the context to resume')

      return options.portableLiveMidi?.start(note)
    },
    stop: (handle: LiveBackendHandle, release: LiveMidiArpeggiatorRelease = {}) => {
      const force = release.force === true

      if (handle.backend === 'native') options.nativeLiveMidi?.stop(handle, force)
      else options.portableLiveMidi?.stop(handle, force)
    },
  }

  const liveArpeggiator = createLiveMidiArpeggiator<LiveBackendHandle>({
    ...liveNoteBackend,
    getConfig: () => {
      const trackId = resolveTargetTrackId()

      return {
        trackId,
        params: trackId ? options.audioEngine.instruments.getTrackArpeggiator(trackId) : undefined,
        bpm: options.bpm(),
      }
    },
  })

  const stopLiveNote = (pitch: number, force = false) => {
    try {
      const entry = activeLiveNotes.get(pitch)

      if (!entry) return
      activeLiveNotes.delete(pitch)
      auditionReleaseTimers.cancel(pitch)
      entry.arpeggiator.noteOff(entry.handle, force)
    } catch {}
  }

  const forceStopAllLiveNotes = () => {
    for (const pitch of Array.from(activeLiveNotes.keys())) {
      stopLiveNote(pitch, true)
    }

    auditionReleaseTimers.clear()
    hardwareRouter.panic()
    liveArpeggiator.panic()
  }

  const stopNativeLiveNotes = () => {
    forceStopAllLiveNotes()
  }

  const auditionNote = (trackId: string, pitch: number, velocity = DEFAULT_NOTE_VELOCITY, durSec = 0.35) => {
    try {
      if (!isPlayableMidiTrack(trackIndex().trackById.get(trackId))) return

      const auditionArpeggiator = createLiveMidiArpeggiator<LiveBackendHandle>({
        ...liveNoteBackend,
        getConfig: () => ({
          trackId,
          params: options.audioEngine.instruments.getTrackArpeggiator(trackId),
          bpm: options.bpm(),
        }),
      })

      stopLiveNote(pitch, true)

      const sourceId = auditionArpeggiator.noteOn(pitch, velocity)

      if (sourceId === undefined) return
      activeLiveNotes.set(pitch, { handle: sourceId, arpeggiator: auditionArpeggiator })
      // UI audition notes have no sustained pointer lifecycle; this bounded
      // one-shot note-off prevents a successful preview from hanging.
      auditionReleaseTimers.schedule(pitch, Math.max(0, durSec * 1000), () => stopLiveNote(pitch, true))
    } catch {}
  }

  const startLiveNote = (pitch: number, velocity = DEFAULT_NOTE_VELOCITY) => {
    try {
      if (midiSuspended) return

      if (activeLiveNotes.has(pitch)) return
      const sourceId = liveArpeggiator.noteOn(pitch, velocity)

      if (sourceId !== undefined) activeLiveNotes.set(pitch, { handle: sourceId, arpeggiator: liveArpeggiator })
    } catch {}
  }

  createEffect(
    () => options.projectId(),
    (projectId) => {
      const unsubscribe = subscribeMidiProjectProjection(projectId, () => {
        setProjectionRevision((revision) => revision + 1)
      })

      return unsubscribe
    },
  )

  createEffect(
    () => storedMidiKeyboardEnabled.read(midiKeyboardStorageScope()),
    (enabled) => {
      setMidiKeyboardEnabled(enabled)
    },
  )

  createEffect(
    () => ({ scope: midiKeyboardStorageScope(), enabled: midiKeyboardEnabled() }),
    ({ scope, enabled }) => {
      storedMidiKeyboardEnabled.write(scope, enabled)
    },
  )

  // The browser's paused session is prepared where a note is about to be played: MIDI input is on, or the effects
  // panel shows the selected MIDI track's instrument. Preparing is a no-op once a session exists.
  createEffect(
    () => {
      if (requiresNativeAudio || !options.portableLiveMidi) return undefined
      const panelTrack = options.effectsPanelOpen() ? trackIndex().trackById.get(options.selection.selectedFXTarget()) : undefined

      return (midiKeyboardEnabled() && midiKeyboardCanPlay()) || isPlayableMidiTrack(panelTrack)
        ? midiKeyboardTarget()?.id ?? panelTrack?.id
        : undefined
    },
    (trackId) => {
      if (trackId === undefined || usesNativeLiveMidi(options.nativeLiveMidi)) return
      // The session needs the audio context, which the first note would otherwise be the one to create.
      options.audioEngine.ensureAudio()
      options.portableLiveMidi?.prepare()
    },
  )

  const midiKeyboard = useMidiKeyboardInput({
    projectId: () => options.projectId(),
    enabled: midiKeyboardEnabled,
    canPlay: midiKeyboardCanPlay,
    onStartLiveNote: startLiveNote,
    onStopLiveNote: stopLiveNote,
  })

  const hardwareRouter = createLiveMidiRouter({
    acceptsChannel: (channel) => {
      if (midiSuspended) return false
      const track = resolveTargetTrack()

      if (!track) return false
      const clipId = midiEditorClipId()
      const clip = clipId ? trackIndex().clipEntryById.get(clipId)?.clip : undefined

      return !clip?.midi?.inputChannel || clip.midi.inputChannel === channel
    },
    startNote: (event) => {
      try {
        const trackId = resolveTargetTrackId()

        if (!trackId) return undefined
        const times = options.audioEngine.midiEventTimes(event.timeStamp)
        const sourceId = liveArpeggiator.noteOn(event.note, event.velocity, times?.scheduledContextTime)

        return sourceId === undefined ? undefined : { id: sourceId }
      } catch {
        return undefined
      }
    },
    releaseNote: (handle, timeStamp, force) => {
      const times = options.audioEngine.midiEventTimes(timeStamp)
      liveArpeggiator.noteOff(handle.id, force, times?.scheduledContextTime)
    },
    applyExpression: (event) => {
      const trackId = resolveTargetTrackId()
      const index = activeMappingIndex()

      if (!trackId || !index) return

      const sourceEvent: MidiMappingSourceEvent | undefined = event.kind === 'control-change'
        ? { kind: 'cc', controller: event.controller, channel: event.channel, value: event.value }
        : event.kind === 'pitch-bend'
          ? { kind: 'pitch-bend', channel: event.channel, value: event.value }
          : event.kind === 'channel-pressure'
            ? { kind: 'channel-pressure', channel: event.channel, value: event.pressure }
            : event.kind === 'poly-pressure'
              ? { kind: 'poly-pressure', channel: event.channel, pitch: event.note, value: event.pressure }
              : undefined

      if (!sourceEvent) return

      if (requiresNativeAudio) return
      const times = options.audioEngine.midiEventTimes(event.timeStamp)

      for (const mapping of index.match(sourceEvent)) {
        const value = midiMappingValue(mapping, sourceEvent)

        if (value === undefined) continue
        options.audioEngine.writeTransientMidiMapping(
          trackId,
          mapping.target,
          value,
          times?.scheduledContextTime,
          event.sourceId,
        )

        const targetKey = automationTargetKey({
          kind: 'track',
          trackId,
          effectInstanceId: mapping.target.effectInstanceId,
        }, mapping.target.parameterId)

        activeMappingTargets.set(`${event.sourceId}\u0000${targetKey}`, {
          sourceId: event.sourceId,
          trackId,
          target: mapping.target,
        })
      }
    },
  })

  const removeNativeLiveMidiReset = options.nativeLiveMidi?.subscribeReset?.(() => {
    forceStopAllLiveNotes()
  })

  createTrackedEffect(() => {
    const targetKey = [
      options.projectId(),
      options.selection.selectedTrackId(),
      options.selection.selectedFXTarget(),
      midiEditorClipId(),
      resolveTargetTrackId(),
    ].join('\u0000')

    if (liveTargetKey !== undefined && liveTargetKey !== targetKey) {
      forceStopAllLiveNotes()
    }

    liveTargetKey = targetKey
    liveArpeggiator.configure()
    restoreLiveMappings()
  })

  onCleanup(options.audioEngine.subscribeArpeggiator((trackId) => {
    if (untrack(resolveTargetTrackId) !== trackId) return
    liveArpeggiator.configure()
  }))

  createEffect(
    () => options.bpm(),
    () => {
      liveArpeggiator.configure()
    },
  )

  createTrackedEffect(() => {
    if (requiresNativeAudio) return
    activeMappingFingerprint()
    const previousTargetKeys = scheduledMappingTargetKeys

    if (previousTargetKeys.size > 0) {
      options.audioEngine.cancelAutomationSchedules(previousTargetKeys)
    }

    const trackId = resolveTargetTrackId()
    const clipId = midiEditorClipId()
    const clip = clipId ? trackIndex().clipEntryById.get(clipId)?.clip : undefined
    scheduledMappingTargetKeys = new Set(
      trackId && clip?.midi
        ? normalizeLegacyMidiClip(clip.midi).mappings.map((mapping) => automationTargetKey({
            kind: 'track',
            trackId,
            effectInstanceId: mapping.target.effectInstanceId,
          }, mapping.target.parameterId))
        : [],
    )
    restoreLiveMappings()
    const affectedTargetKeys = new Set([...previousTargetKeys, ...scheduledMappingTargetKeys])
    const playheadSec = untrack(options.playheadSec)

    if (untrack(options.isPlaying)) {
      options.audioEngine.scheduleAutomationFromPlayhead(playheadSec, {
        targetKeys: affectedTargetKeys,
        tracks: projectedTracks(),
      })
    } else {
      options.audioEngine.applyAutomationAtTimelineSec(playheadSec)
    }
  })

  createEffect(
    () => activeInputChannel(),
    () => {
      restoreLiveMappings()
    },
  )

  onSettled(() => {
    const unsubscribe = midiAccess.subscribe(hardwareRouter.receive)

    const unsubscribeReset = midiAccess.subscribeSourceReset((event) => {
      hardwareRouter.resetSource(event.sourceId)
      restoreLiveMappings(event.sourceId)
    })

    const onVisibilityChange = () => {
      if (document.hidden) {
        forceStopAllLiveNotes()
        restoreLiveMappings()
      }
    }

    const removeAudioLifecycle = lifecycleBridge
      ? createDesktopAudioLifecycleReconciler(lifecycleBridge, (lifecycle) => {
        if (lifecycle.state === "suspended") {
          midiSuspended = true
          nativeMidiReady = false
          forceStopAllLiveNotes()
          restoreLiveMappings()
        } else {
          midiSuspended = false
          nativeMidiReady = lifecycle.state === "ready"

          if (!nativeMidiReady) stopNativeLiveNotes()
        }
        })
      : undefined

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      unsubscribe()
      unsubscribeReset()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      removeAudioLifecycle?.()
      forceStopAllLiveNotes()
      restoreLiveMappings()
    }
  })

  onCleanup(() => {
    removeNativeLiveMidiReset?.()
    forceStopAllLiveNotes()
    auditionReleaseTimers.clear()
    restoreLiveMappings()
  })

  return {
    midiEditorClipId,
    auditionNote,
    midiKeyboard: {
      enabled: midiKeyboardEnabled,
      canPlay: midiKeyboardCanPlay,
      targetLabel: midiKeyboardTargetLabel,
      octave: midiKeyboard.octave,
      toggle: () => setMidiKeyboardEnabled(value => !value),
      isActive: midiKeyboard.isActive,
    },
  }
}
