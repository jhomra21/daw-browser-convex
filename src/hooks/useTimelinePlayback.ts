import { createSignal, onCleanup, type Accessor } from 'solid-js'

import type { AudioEngine } from '~/lib/audio-engine'
import type { Track } from '~/types/timeline'

type LoopOptions = {
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
  getTracks?: Accessor<Track[]>
}

const LOOP_EPS = 1e-3

export function useTimelinePlayback(audioEngine: AudioEngine, loopOptions?: LoopOptions) {
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [playheadSec, setPlayheadSec] = createSignal(0)

  const [rafId, setRafId] = createSignal<number | null>(null)
  const [startedCtxTime, setStartedCtxTime] = createSignal(0)
  const [startedPlayheadSec, setStartedPlayheadSec] = createSignal(0)
  const [lastTracks, setLastTracks] = createSignal<Track[]>([])
  // Schedule a little ahead to avoid past-time starts under scheduling jitter.
  // This keeps metronome ticks and clip audio locked to the same transport timestamp.
  const SCHED_AHEAD_SEC = 0.02
  // Centralize loop state (start/end/active) so timing logic stays in sync across handlers
  const getLoopParams = () => {
    const enabled = loopOptions?.loopEnabled?.() ?? false
    const start = loopOptions?.loopStartSec?.() ?? 0
    const end = loopOptions?.loopEndSec?.() ?? 0
    const length = end - start
    const isActive = enabled && length > LOOP_EPS
    return { enabled, start, end, length, isActive }
  }

  const cancelRaf = () => {
    const id = rafId()
    if (id !== null) {
      cancelAnimationFrame(id)
      setRafId(null)
    }
  }

  const resolveTracks = () => {
    const fromAccessor = loopOptions?.getTracks?.()
    if (Array.isArray(fromAccessor)) {
      setLastTracks(fromAccessor)
      return fromAccessor
    }
    return lastTracks()
  }

  const applyLoopIfNeeded = (candidateSec: number) => {
    const { isActive, start, end } = getLoopParams()
    if (!isActive) return { sec: candidateSec, looped: false }
    if (candidateSec < start) return { sec: candidateSec, looped: false }
    if (candidateSec < end - LOOP_EPS) return { sec: candidateSec, looped: false }

    // Wrap cleanly to the start of the loop; schedule immediately with slight ahead offset
    const wrapped = start
    const tracks = resolveTracks()
    audioEngine.stopAllSources()
    audioEngine.onTransportSeek(wrapped, SCHED_AHEAD_SEC)
    audioEngine.scheduleAllClipsFromPlayhead(tracks, wrapped)
    setStartedCtxTime(audioEngine.currentTime)
    setStartedPlayheadSec(wrapped)
    return { sec: wrapped, looped: true }
  }

  const tick = () => {
    if (!isPlaying()) return
    const elapsedRaw = audioEngine.currentTime - startedCtxTime()
    const latency = audioEngine.outputLatencySec || 0
    const elapsed = Math.max(0, elapsedRaw - latency)
    const nextSec = startedPlayheadSec() + elapsed
    const { sec } = applyLoopIfNeeded(nextSec)
    setPlayheadSec(sec)
    setRafId(requestAnimationFrame(tick))
  }

  const handlePlay = async (tracks: Track[]) => {
    audioEngine.ensureAudio()
    await audioEngine.resume()
    setIsPlaying(true)
    setStartedCtxTime(audioEngine.currentTime)
    setStartedPlayheadSec(playheadSec())
    setLastTracks(tracks)
    audioEngine.onTransportStart(playheadSec())
    audioEngine.onTransportSeek(playheadSec(), SCHED_AHEAD_SEC)
    const { isActive, end } = getLoopParams()
    audioEngine.scheduleAllClipsFromPlayhead(tracks, playheadSec(), isActive ? { endLimitSec: end } : undefined)
    setRafId(requestAnimationFrame(tick))
  }

  const handlePause = () => {
    if (!isPlaying()) return
    setIsPlaying(false)
    audioEngine.stopAllSources()
    audioEngine.onTransportPause()
    cancelRaf()
  }

  const handleStop = () => {
    handlePause()
    setPlayheadSec(0)
    setStartedCtxTime(audioEngine.currentTime)
    setStartedPlayheadSec(0)
    audioEngine.onTransportStop()
  }

  const setPlayhead = (sec: number, tracks: Track[]) => {
    setPlayheadSec(sec)
    setLastTracks(tracks)
    if (isPlaying()) {
      setStartedCtxTime(audioEngine.currentTime)
      setStartedPlayheadSec(sec)
      // IMPORTANT: Update transport epoch BEFORE scheduling, so MIDI events use the correct mapping
      audioEngine.onTransportSeek(sec, SCHED_AHEAD_SEC)
      const { isActive, end } = getLoopParams()
      audioEngine.scheduleAllClipsFromPlayhead(tracks, sec, isActive ? { endLimitSec: end } : undefined)
    }
  }

  onCleanup(() => {
    cancelRaf()
  })

  return {
    isPlaying,
    playheadSec,
    handlePlay,
    handlePause,
    handleStop,
    setPlayhead
  }
}