import type { useTrackRecording } from './useTrackRecording'
import type { createMidiTrackRecordingController } from '~/lib/midi/midi-recording-controller'
import { onCleanup } from 'solid-js'

type RecordingStartResult = {
  ok: boolean
  trackId?: string
  reason?: string
}

type RecordingDispatchOptions = {
  audioStarting: () => boolean
  midiStarting: () => boolean
  cleanupPending: () => boolean
  isRecording: () => boolean
  recordingTrackId: () => string | null
  armedTrack: () => { id: string; kind?: string } | undefined
  stopRecording: () => Promise<void>
  toggleAudioRecording: () => Promise<RecordingStartResult>
  startMidiRecording: () => Promise<boolean>
}

type PendingCleanupOptions = {
  cleanupPending: () => boolean
  stopRecording: () => Promise<void>
}

type TransportSpaceOptions = {
  recordingBusy: () => boolean
  isPlaying: () => boolean
  pauseRecording: () => void | Promise<void>
  pausePlayback: () => void | Promise<void>
  play: () => void | Promise<void>
}

export const dispatchTransportSpace = (options: TransportSpaceOptions): void => {
  if (options.recordingBusy()) {
    void options.pauseRecording()
  } else if (options.isPlaying()) {
    void options.pausePlayback()
  } else {
    void options.play()
  }
}

export const retryPendingRecordingCleanup = async (
  options: PendingCleanupOptions,
): Promise<boolean> => {
  if (!options.cleanupPending()) return true
  try {
    await options.stopRecording()
  } catch {
    // The failed attempt was already announced by the controller; cleanup stays protected.
  }
  return !options.cleanupPending()
}

export const dispatchRecordingToggle = async (
  options: RecordingDispatchOptions,
): Promise<RecordingStartResult> => {
  if (options.cleanupPending() && !await retryPendingRecordingCleanup(options)) {
    return { ok: false, reason: 'cleanup-pending' }
  }
  if (options.audioStarting()) return options.toggleAudioRecording()
  const armedTrack = options.armedTrack()
  if (options.midiStarting()) {
    const ok = await options.startMidiRecording()
    return { ok, trackId: ok ? options.recordingTrackId() ?? armedTrack?.id : undefined }
  }
  if (options.isRecording()) {
    await options.stopRecording()
    return { ok: true, trackId: options.recordingTrackId() ?? undefined }
  }
  if (armedTrack?.kind === 'instrument') {
    const ok = await options.startMidiRecording()
    return { ok, trackId: ok ? armedTrack.id : undefined }
  }
  return options.toggleAudioRecording()
}

type RecordingTransportOptions = {
  audio: Pick<ReturnType<typeof useTrackRecording>,
    'isRecording' | 'isStarting' | 'recordingTrackId' | 'toggleRecording' | 'stopRecording'>
  midi: ReturnType<typeof createMidiTrackRecordingController>
  playback: {
    isPlaying: () => boolean
    play: () => Promise<void>
    pause: () => void | Promise<void>
    stop: () => void | Promise<void>
  }
  armedTrack: RecordingDispatchOptions['armedTrack']
  notify: (title: string, message: string) => void
  project: {
    id: () => string | undefined
    provisionalClipId: () => string | null
    cancelImports: () => void
    navigate: (projectId: string) => void | Promise<void>
  }
}

export const createRecordingTransportPolicy = (options: RecordingTransportOptions) => {
  const { audio, midi, playback, project } = options
  let settlement: Promise<void> | undefined
  let transportGeneration = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const isStarting = () => audio.isStarting() || midi.isStarting()
  const isRecording = () => audio.isRecording() || midi.hasLiveTake()
  const notifyCleanupBlocked = () => {
    if (disposed) return
    options.notify(
      'MIDI recording cleanup',
      'Finishing cleanup of a cancelled MIDI recording… retry.',
    )
  }
  // The audio side reports its own failure; cancelled-clip cleanup failures are reported by the controller.
  const stopAudio = async (): Promise<void> => {
    try {
      await audio.stopRecording(false)
    } catch (error) {
      if (!disposed) options.notify('Recording', 'Recording could not be finalized.')
      throw error
    }
  }
  const stopRecording = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (settlement) return settlement
    // Start both cancellations before awaiting either controller.
    const audioStop = audio.isRecording() || audio.isStarting() ? stopAudio() : Promise.resolve()
    const midiStop = midi.isRecording() || midi.hasPendingCleanup()
      ? midi.stopRecording(false) : Promise.resolve()
    const pending = Promise.all([audioStop, midiStop]).then(() => undefined).finally(() => {
      if (settlement === pending) settlement = undefined
    })
    // Fire-and-forget callers do not await this; awaiting callers still receive the rejection.
    pending.catch(() => undefined)
    settlement = pending
    return pending
  }
  const finishTransport = async (finish: () => void | Promise<void>) => {
    if (disposed) return
    transportGeneration += 1
    // With no recording to settle, apply the transport intent immediately.
    // Yielding here lets a newer ruler locate run before the older Stop.
    if (!settlement && !isStarting() && !isRecording() && !midi.hasPendingCleanup()) {
      return finish()
    }
    if (isStarting()) {
      // Pending setup must not delay Stop/Pause or stop a later transport action.
      void stopRecording()
      return finish()
    }
    if (midi.hasPendingCleanup() && !midi.hasLiveTake()) {
      // Retained cleanup never delays transport; a live audio take still finalizes before it.
      if (audio.isRecording()) await stopAudio().catch(() => undefined)
      if (disposed) return
      void stopRecording()
      return finish()
    }
    try {
      await stopRecording()
    } catch {
      // Reported by the settlement itself.
    } finally {
      if (!disposed) await finish()
    }
  }
  const pause = () => finishTransport(playback.pause)
  const stop = () => finishTransport(playback.stop)
  const canLeaveProject = async () => {
    if (disposed) return false
    transportGeneration += 1
    project.cancelImports()
    try {
      await stopRecording()
    } catch {
      return false
    }
    if (midi.hasPendingCleanup()) {
      notifyCleanupBlocked()
      return false
    }
    // A provisional clip after a failed save was already reported by the controller.
    if (project.provisionalClipId()) return false
    return !disposed
  }
  const leaveProject = async (nextProjectId?: string) => {
    if (disposed) return
    if (nextProjectId !== undefined && nextProjectId === project.id()) return
    if (!await canLeaveProject()) {
      if (nextProjectId === undefined) throw new Error('MIDI recording remains protected until it can be finalized.')
      return
    }
    if (!disposed && nextProjectId !== undefined) await project.navigate(nextProjectId)
  }
  const record = async (): Promise<RecordingStartResult> => {
    if (disposed) return { ok: false, reason: 'recording owner disposed' }
    if (settlement) {
      const generation = transportGeneration
      try {
        await settlement
      } catch {
        return { ok: false, reason: 'cleanup-pending' }
      }
      if (generation !== transportGeneration) return { ok: false, reason: 'Recording start cancelled' }
    }
    if (disposed) return { ok: false, reason: 'recording owner disposed' }
    return dispatchRecordingToggle({
      audioStarting: audio.isStarting,
      midiStarting: midi.isStarting,
      cleanupPending: midi.hasPendingCleanup,
      isRecording,
      recordingTrackId: () => audio.recordingTrackId() ?? midi.recordingTrackId(),
      armedTrack: options.armedTrack,
      stopRecording,
      toggleAudioRecording: () => disposed
        ? Promise.resolve({ ok: false, reason: 'recording owner disposed' })
        : audio.toggleRecording(),
      startMidiRecording: async () => !disposed && await midi.startRecording(),
    })
  }
  return {
    record,
    stop,
    pause,
    play: async () => {
      if (!disposed) await playback.play()
    },
    space: () => {
      if (disposed) return
      dispatchTransportSpace({
        // Retained cleanup is not transport activity: a stopped transport plays.
        recordingBusy: () => audio.isRecording() || isStarting() || midi.hasLiveTake(),
        isPlaying: playback.isPlaying,
        pauseRecording: pause,
        pausePlayback: playback.pause,
        play: playback.play,
      })
    },
    stopRecording,
    leaveProject,
  }
}
