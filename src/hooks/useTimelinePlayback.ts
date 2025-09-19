import { createSignal, onCleanup } from 'solid-js'
import type { AudioEngine } from '~/lib/audio-engine'
import type { Track } from '~/types/timeline'

export function useTimelinePlayback(audioEngine: AudioEngine) {
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [playheadSec, setPlayheadSec] = createSignal(0)
  
  let rafId = 0
  let startedCtxTime = 0
  let startedPlayheadSec = 0

  function tick() {
    if (!isPlaying()) return
    const elapsed = audioEngine.currentTime - startedCtxTime
    setPlayheadSec(startedPlayheadSec + elapsed)
    rafId = requestAnimationFrame(tick)
  }

  async function handlePlay(tracks: Track[]) {
    audioEngine.ensureAudio()
    await audioEngine.resume()
    setIsPlaying(true)
    startedCtxTime = audioEngine.currentTime
    startedPlayheadSec = playheadSec()
    audioEngine.scheduleAllClipsFromPlayhead(tracks, playheadSec())
    rafId = requestAnimationFrame(tick)
  }

  function handlePause() {
    if (!isPlaying()) return
    setIsPlaying(false)
    audioEngine.stopAllSources()
    cancelAnimationFrame(rafId)
  }

  function handleStop() {
    handlePause()
    setPlayheadSec(0)
  }

  function setPlayhead(sec: number, tracks: Track[]) {
    setPlayheadSec(sec)
    if (isPlaying()) {
      startedCtxTime = audioEngine.currentTime
      startedPlayheadSec = sec
      audioEngine.scheduleAllClipsFromPlayhead(tracks, sec)
    }
  }

  onCleanup(() => {
    cancelAnimationFrame(rafId)
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