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
    const enabled = loopOptions?.loopEnabled?.() ?? false
    if (!enabled) return { sec: candidateSec, looped: false }
    const start = loopOptions?.loopStartSec?.() ?? 0
    const end = loopOptions?.loopEndSec?.() ?? 0
    const length = end - start
    if (!(length > LOOP_EPS)) return { sec: candidateSec, looped: false }
    if (candidateSec < start) return { sec: candidateSec, looped: false }
    if (candidateSec < end - LOOP_EPS) return { sec: candidateSec, looped: false }

    const range = Math.max(length, LOOP_EPS)
    const offset = candidateSec - start
    const wrapped = start + (offset % range)
    const tracks = resolveTracks()
    audioEngine.stopAllSources()
    audioEngine.onTransportSeek(wrapped)
    audioEngine.scheduleAllClipsFromPlayhead(tracks, wrapped)
    setStartedCtxTime(audioEngine.currentTime)
    setStartedPlayheadSec(wrapped)
    return { sec: wrapped, looped: true }
  }

  const tick = () => {
    if (!isPlaying()) return
    const elapsed = audioEngine.currentTime - startedCtxTime()
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
    audioEngine.scheduleAllClipsFromPlayhead(tracks, playheadSec())
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
      audioEngine.onTransportSeek(sec)
      audioEngine.scheduleAllClipsFromPlayhead(tracks, sec)
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