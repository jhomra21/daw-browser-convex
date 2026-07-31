import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'

import {
  clampTimelineMidiBounds,
  timelineMidiBoundsEqual,
  type TimelineMidiBounds,
} from '~/lib/timeline-midi-bounds'
import type { AudioEngine, LiveMidiNoteHandle } from '@daw-browser/audio-engine/audio-engine'
import { canUseLocalStorage } from '~/lib/timeline-storage'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import type { Track } from '@daw-browser/timeline-core/types'
import { automationTargetKey, compileMidiMappingSourceIndex, isClipKindCompatibleWithTrack, midiMappingValue, normalizeLegacyMidiClip, type MidiMappingSourceEvent } from '@daw-browser/shared'
import { useMidiKeyboardInput } from './useMidiKeyboardInput'
import { useMidiAccess } from '~/context/midi-access'
import { createLiveMidiRouter } from '~/lib/midi/live-midi-router'
import { shouldUseNativeLiveMidi } from '~/lib/midi/live-midi-backend'
import { projectMidiProjectTracks, subscribeMidiProjectProjection } from '~/lib/midi/editor-persistence'

import type { TimelineSelectionController } from './useTimelineSelectionState'
import type { NativeLiveMidiNoteHandle } from '~/lib/desktop/native-playback-controller'

type UseTimelineMidiOverlayOptions = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  projectId: Accessor<string>
  isPlaying: Accessor<boolean>
  playheadSec: Accessor<number>
  selection: TimelineSelectionController
  activeRecordingTargetId?: Accessor<string | null>
  canOpenMidiEditorFor?: (clipId: string) => boolean
  nativeLiveMidi?: {
    isActive: () => boolean
    isAvailable: () => boolean
    start: (note: { trackId: string; pitch: number; velocity: number }) => NativeLiveMidiNoteHandle | undefined
    stop: (handle: NativeLiveMidiNoteHandle, force?: boolean) => void
  }
}

type UseTimelineMidiOverlayReturn = {
  midiEditorClipId: Accessor<string | null>
  midiCard: Accessor<TimelineMidiBounds>
  closeMidiEditor: () => void
  openMidiEditorFor: (clipId: string) => void
  changeMidiCardBounds: (next: TimelineMidiBounds) => void
  auditionNote: (pitch: number, velocity?: number, durSec?: number) => void
  midiKeyboard: {
    enabled: Accessor<boolean>
    canPlay: Accessor<boolean>
    targetLabel: Accessor<string | null>
    octave: Accessor<number>
    toggle: () => void
    isActive: (pitch: number) => boolean
  }
}

type LiveNote =
  | { handle: NativeLiveMidiNoteHandle; backend: "native" }
  | { handle: LiveMidiNoteHandle; backend: "browser" }

function readMidiBounds(value: unknown): TimelineMidiBounds | null {
  if (!value || typeof value !== 'object') return null
  if (!('x' in value) || !('y' in value) || !('w' in value) || !('h' in value)) return null
  const x = value.x
  const y = value.y
  const w = value.w
  const h = value.h
  if (typeof x !== 'number' || !Number.isFinite(x)) return null
  if (typeof y !== 'number' || !Number.isFinite(y)) return null
  if (typeof w !== 'number' || !Number.isFinite(w)) return null
  if (typeof h !== 'number' || !Number.isFinite(h)) return null
  return { x, y, w, h }
}

export function useTimelineMidiOverlay(
  options: UseTimelineMidiOverlayOptions,
): UseTimelineMidiOverlayReturn {
  const midiAccess = useMidiAccess()
  const [midiEditorClipId, setMidiEditorClipId] = createSignal<string | null>(null)
  const [midiKeyboardEnabled, setMidiKeyboardEnabled] = createSignal(false)
  const [projectionRevision, setProjectionRevision] = createSignal(0)
  const [midiCard, setMidiCard] = createSignal<TimelineMidiBounds>(
    clampTimelineMidiBounds({ x: 80, y: 80, w: 720, h: 360 }),
  )
  const activeLiveNotes = new Map<number, LiveNote>()
  const nativeHardwareLiveNotes = new WeakMap<LiveMidiNoteHandle, NativeLiveMidiNoteHandle>()
  const activeMappingTargets = new Map<string, {
    sourceId: string
    trackId: string
    target: { parameterId: string; effectInstanceId?: string }
  }>()
  let scheduledMappingTargetKeys = new Set<string>()
  let midiCardPersistTimer: number | null = null
  const projectedTracks = createMemo(() => {
    projectionRevision()
    return projectMidiProjectTracks(options.projectId(), options.tracks())
  })
  const trackIndex = createMemo(() => createTimelineTrackIndex(projectedTracks()))

  const midiKeyboardStorageKey = () => {
    const projectId = options.projectId() || 'default'
    return `mb:midi_kb:${projectId}`
  }

  const midiCardStorageKey = () => {
    const projectId = options.projectId() || 'default'
    return `mb:midi_card:${projectId}`
  }

  const schedulePersistMidiCard = () => {
    if (midiCardPersistTimer) {
      clearTimeout(midiCardPersistTimer)
      midiCardPersistTimer = null
    }
    const storageKey = midiCardStorageKey()
    const bounds = midiCard()
    midiCardPersistTimer = window.setTimeout(() => {
      midiCardPersistTimer = null
      if (!canUseLocalStorage()) return
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(bounds))
      } catch {}
    }, 250)
  }

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

  const stopLiveNote = (pitch: number) => {
    try {
      const entry = activeLiveNotes.get(pitch)
      if (!entry) return
      activeLiveNotes.delete(pitch)
      if (entry.backend === "native") {
        options.nativeLiveMidi?.stop(entry.handle)
      } else {
        options.audioEngine.releaseLiveMidiNote(entry.handle, options.audioEngine.currentTime)
      }
    } catch {}
  }

  const stopAllLiveNotes = () => {
    for (const pitch of Array.from(activeLiveNotes.keys())) {
      stopLiveNote(pitch)
    }
  }

  const closeMidiEditor = () => setMidiEditorClipId(null)

  const openMidiEditorFor = (clipId: string) => {
    if (options.canOpenMidiEditorFor && !options.canOpenMidiEditorFor(clipId)) return
    const match = trackIndex().clipEntryById.get(clipId)
    if (match?.clip.midi) {
      setMidiEditorClipId(clipId)
    }
  }

  const changeMidiCardBounds = (next: TimelineMidiBounds) => {
    const clamped = clampTimelineMidiBounds(next)
    if (timelineMidiBoundsEqual(midiCard(), clamped)) return
    setMidiCard(clamped)
    schedulePersistMidiCard()
  }

  const previewInstrumentNote = (trackId: string, pitch: number, velocity: number) => {
    const instrumentKind = options.audioEngine.getTrackInstrumentKind(trackId)
    if (instrumentKind === 'drum-rack') return options.audioEngine.previewDrumRackNote(trackId, pitch, velocity)
    if (instrumentKind === 'sampler') return options.audioEngine.previewSamplerNote(trackId, pitch, velocity)
    if (instrumentKind === 'synth') return options.audioEngine.previewSynthNote(trackId, pitch, velocity) !== undefined
    return false
  }

  const auditionNote = (pitch: number, velocity = 0.9, durSec = 0.35) => {
    try {
      options.audioEngine.ensureAudio()
      void options.audioEngine.resume().catch(() => undefined)
      const trackId = resolveTargetTrackId()
      if (!trackId) return
      if (options.audioEngine.getTrackInstrumentKind(trackId) === 'synth') {
        options.audioEngine.previewSynthNote(trackId, pitch, velocity, durSec)
        return
      }
      previewInstrumentNote(trackId, pitch, velocity)
    } catch {}
  }

  const startLiveNote = (pitch: number, velocity = 0.9) => {
    try {
      if (activeLiveNotes.has(pitch)) return
      const trackId = resolveTargetTrackId()
      if (!trackId) return
      if (options.nativeLiveMidi && shouldUseNativeLiveMidi(options.nativeLiveMidi)) {
        const handle = options.nativeLiveMidi.start({ trackId, pitch, velocity })
        if (handle) activeLiveNotes.set(pitch, { handle, backend: "native" })
        return
      }
      options.audioEngine.ensureAudio()
      void options.audioEngine.resume().catch(() => undefined)
      const handle = options.audioEngine.startLiveMidiNote({
        trackId,
        pitch,
        velocity,
        when: options.audioEngine.currentTime,
      })
      if (handle) activeLiveNotes.set(pitch, { handle, backend: "browser" })
    } catch {}
  }

  createEffect(() => {
    const key = midiCardStorageKey()
    if (!canUseLocalStorage()) return
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return
      const parsed = readMidiBounds(JSON.parse(raw))
      if (parsed) {
        setMidiCard(clampTimelineMidiBounds(parsed))
      }
    } catch {}
  })

  createEffect(() => {
    const unsubscribe = subscribeMidiProjectProjection(options.projectId(), () => {
      setProjectionRevision((revision) => revision + 1)
    })
    onCleanup(unsubscribe)
  })

  createEffect(() => {
    const clipId = midiEditorClipId()
    if (!clipId) return
    const match = trackIndex().clipEntryById.get(clipId)
    if (!match?.clip.midi) {
      setMidiEditorClipId(null)
    }
  })

  createEffect(() => {
    const key = midiKeyboardStorageKey()
    if (!canUseLocalStorage()) {
      setMidiKeyboardEnabled(false)
      return
    }
    try {
      setMidiKeyboardEnabled(window.localStorage.getItem(key) === '1')
    } catch {
      setMidiKeyboardEnabled(false)
    }
  })

  createEffect(() => {
    if (!canUseLocalStorage()) return
    try {
      window.localStorage.setItem(midiKeyboardStorageKey(), midiKeyboardEnabled() ? '1' : '0')
    } catch {}
  })

  const midiKeyboard = useMidiKeyboardInput({
    projectId: () => options.projectId(),
    enabled: midiKeyboardEnabled,
    canPlay: midiKeyboardCanPlay,
    onStartLiveNote: startLiveNote,
    onStopLiveNote: stopLiveNote,
  })

  const hardwareRouter = createLiveMidiRouter({
    acceptsChannel: (channel) => {
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
        if (options.nativeLiveMidi && shouldUseNativeLiveMidi(options.nativeLiveMidi)) {
          const handle = options.nativeLiveMidi.start({
            trackId,
            pitch: event.note,
            velocity: event.velocity,
          })
          if (!handle) return undefined
          const routerHandle: LiveMidiNoteHandle = { id: handle.noteId }
          nativeHardwareLiveNotes.set(routerHandle, handle)
          return routerHandle
        }
        options.audioEngine.ensureAudio()
        void options.audioEngine.resume().catch(() => undefined)
        const times = options.audioEngine.midiEventTimes(event.timeStamp)
        return times
          ? options.audioEngine.startLiveMidiNote({
              trackId,
              pitch: event.note,
              velocity: event.velocity,
              when: times.scheduledContextTime,
            })
          : undefined
      } catch {
        return undefined
      }
    },
    releaseNote: (handle, timeStamp, force) => {
      const nativeHandle = nativeHardwareLiveNotes.get(handle)
      if (nativeHandle) {
        options.nativeLiveMidi?.stop(nativeHandle, force)
        return
      }
      const times = options.audioEngine.midiEventTimes(timeStamp)
      options.audioEngine.releaseLiveMidiNote(handle, times?.scheduledContextTime ?? 0, force)
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
          ...(mapping.target.effectInstanceId === undefined ? {} : { effectInstanceId: mapping.target.effectInstanceId }),
        }, mapping.target.parameterId)
        activeMappingTargets.set(`${event.sourceId}\u0000${targetKey}`, {
          sourceId: event.sourceId,
          trackId,
          target: mapping.target,
        })
      }
    },
  })

  createEffect(() => {
    options.projectId()
    options.selection.selectedTrackId()
    options.selection.selectedFXTarget()
    midiEditorClipId()
    restoreLiveMappings()
  })

  createEffect(() => {
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
            ...(mapping.target.effectInstanceId === undefined ? {} : { effectInstanceId: mapping.target.effectInstanceId }),
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

  createEffect(() => {
    activeInputChannel()
    restoreLiveMappings()
  })

  createEffect(() => {
    const unsubscribe = midiAccess.subscribe(hardwareRouter.receive)
    const unsubscribeReset = midiAccess.subscribeSourceReset((event) => {
      hardwareRouter.resetSource(event.sourceId)
      restoreLiveMappings(event.sourceId)
    })
    const onVisibilityChange = () => {
      if (document.hidden) {
        hardwareRouter.panic()
        restoreLiveMappings()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    onCleanup(() => {
      unsubscribe()
      unsubscribeReset()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      hardwareRouter.panic()
      restoreLiveMappings()
      options.audioEngine.panicLiveMidi()
    })
  })

  onCleanup(() => {
    if (midiCardPersistTimer) {
      clearTimeout(midiCardPersistTimer)
      midiCardPersistTimer = null
    }
    stopAllLiveNotes()
    hardwareRouter.panic()
    restoreLiveMappings()
    options.audioEngine.panicLiveMidi()
  })

  return {
    midiEditorClipId,
    midiCard,
    closeMidiEditor,
    openMidiEditorFor,
    changeMidiCardBounds,
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
