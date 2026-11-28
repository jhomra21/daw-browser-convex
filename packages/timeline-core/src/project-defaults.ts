export const DEFAULT_BPM = 120
export const MIN_BPM = 30
export const MAX_BPM = 300

export const DEFAULT_GRID = { enabled: true, denominator: 4 }

export const DEFAULT_LOOP = { enabled: false, startSec: 0, endSec: 8 }

export const clampBpm = (bpm: number) => Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)))
