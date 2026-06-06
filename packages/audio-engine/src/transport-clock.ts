export type TransportClock = {
  getBpm: () => number
  setBpm: (bpm: number) => boolean
  secondsPerBeat: () => number
  timelineToCtxTime: (timelineSec: number) => number
  ctxTimeToTimeline: (ctxTime: number) => number
  start: (ctxTime: number, playheadSec: number) => void
  pause: () => void
  stop: (ctxTime: number) => void
  seek: (ctxTime: number, playheadSec: number, offsetSec?: number) => void
  isRunning: () => boolean
}

export function createTransportClock(): TransportClock {
  let bpm = 120
  let epochCtxTime = 0
  let epochTimelineSec = 0
  let running = false

  return {
    getBpm: () => bpm,
    setBpm: (nextBpm) => {
      const sanitized = Math.min(300, Math.max(30, Math.round(nextBpm)))
      if (sanitized === bpm) return false
      bpm = sanitized
      return true
    },
    secondsPerBeat: () => 60 / Math.max(1, bpm),
    timelineToCtxTime: (timelineSec) => {
      const delta = timelineSec - epochTimelineSec
      return epochCtxTime + Math.max(0, delta)
    },
    ctxTimeToTimeline: (ctxTime) => {
      const delta = ctxTime - epochCtxTime
      return epochTimelineSec + Math.max(0, delta)
    },
    start: (ctxTime, playheadSec) => {
      epochCtxTime = ctxTime
      epochTimelineSec = Math.max(0, playheadSec)
      running = true
    },
    pause: () => {
      running = false
    },
    stop: (ctxTime) => {
      running = false
      epochTimelineSec = 0
      epochCtxTime = ctxTime
    },
    seek: (ctxTime, playheadSec, offsetSec = 0) => {
      epochCtxTime = ctxTime + Math.max(0, offsetSec)
      epochTimelineSec = Math.max(0, playheadSec)
    },
    isRunning: () => running,
  }
}
