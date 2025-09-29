import { createSignal, onCleanup } from 'solid-js'

import type { AudioEngine } from '~/lib/audio-engine'
import type { Track } from '~/types/timeline'

export function useTimelinePlayback(audioEngine: AudioEngine) {
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [playheadSec, setPlayheadSec] = createSignal(0)

  const [rafId, setRafId] = createSignal<number | null>(null)
  const [startedCtxTime, setStartedCtxTime] = createSignal(0)
  const [startedPlayheadSec, setStartedPlayheadSec] = createSignal(0)

  const cancelRaf = () => {
    const id = rafId()
    if (id !== null) {
      cancelAnimationFrame(id)
      setRafId(null)
    }
  }

  const tick = () => {
    if (!isPlaying()) return
    const elapsed = audioEngine.currentTime - startedCtxTime()
    setPlayheadSec(startedPlayheadSec() + elapsed)
    setRafId(requestAnimationFrame(tick))
  }

  const handlePlay = async (tracks: Track[]) => {
    audioEngine.ensureAudio()
    await audioEngine.resume()
    setIsPlaying(true)
    setStartedCtxTime(audioEngine.currentTime)
    setStartedPlayheadSec(playheadSec())
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