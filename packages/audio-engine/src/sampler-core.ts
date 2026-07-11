import type { SamplerEnvelope, SamplerParams, SamplerZone } from '@daw-browser/shared'

export type SamplerRoundRobinState = ReadonlyMap<number, number>

export function selectSamplerZone(
  zones: readonly SamplerZone[],
  note: number,
  velocity: number,
  roundRobin: SamplerRoundRobinState,
): { zone?: SamplerZone; roundRobin: SamplerRoundRobinState } {
  const matches = zones.filter((zone) => note >= zone.keyLow && note <= zone.keyHigh && velocity >= zone.velocityLow && velocity <= zone.velocityHigh)
  if (matches.length === 0) return { roundRobin }
  const group = matches[0]?.roundRobinGroup ?? 0
  const grouped = group > 0
    ? matches.filter((zone) => zone.roundRobinGroup === group).sort((a, b) => a.roundRobinIndex - b.roundRobinIndex || a.id.localeCompare(b.id))
    : matches
  if (group <= 0 || grouped.length === 1) return { zone: grouped[0], roundRobin }
  const cursor = roundRobin.get(group) ?? 0
  const next = new Map(roundRobin)
  next.set(group, (cursor + 1) % grouped.length)
  return { zone: grouped[cursor % grouped.length], roundRobin: next }
}

export const resetSamplerRoundRobin = (): SamplerRoundRobinState => new Map()

type SamplerLoopSegment = {
  offsetSec: number
  startTime: number
  durationSec: number
  fadeInSec: number
  fadeOutSec: number
}

type SamplerVoicePlan = {
  zone: SamplerZone
  detuneCents: number
  peakGain: number
  startTime: number
  releaseTime: number
  endTime: number
  ampEnvelope: ReturnType<typeof getSamplerEnvelopeTimes>
  filterEnvelope: ReturnType<typeof getSamplerEnvelopeTimes>
  filterBaseHz: number
  filterPeakHz: number
  segments: readonly SamplerLoopSegment[]
  chokeGroup: number
  polyphony: number
}

export function createSamplerVoicePlan(input: {
  zone: SamplerZone
  params: SamplerParams
  note: number
  velocity: number
  when: number
  durationSec: number
}): SamplerVoicePlan {
  const releaseTime = input.when + Math.max(0, input.durationSec)
  const ampEnvelope = getSamplerEnvelopeTimes(input.params.ampEnvelope, input.when, releaseTime)
  const filterEnvelope = getSamplerEnvelopeTimes(input.params.filterEnvelope, input.when, releaseTime)
  const endSec = input.zone.endSec ?? input.zone.sample.source.durationSec
  const loop = getSamplerLoopBounds(input.zone)
  const segments: SamplerLoopSegment[] = []
  const detuneCents = (input.note - input.zone.rootNote) * 100 + input.zone.tuneCents
  const playbackRate = 2 ** (detuneCents / 1200)
  if (!loop) {
    segments.push({
      offsetSec: input.zone.startSec,
      startTime: input.when,
      durationSec: Math.max(0, Math.min(endSec - input.zone.startSec, ampEnvelope.endTime - input.when)),
      fadeInSec: 0,
      fadeOutSec: 0,
    })
  } else if (input.zone.playbackMode === 'forward-loop') {
    segments.push({
      offsetSec: input.zone.startSec,
      startTime: input.when,
      durationSec: Math.max(0, ampEnvelope.endTime - input.when),
      fadeInSec: 0,
      fadeOutSec: 0,
    })
  } else {
    const introDuration = Math.max(0, loop.endSec - input.zone.startSec) / playbackRate
    const loopDuration = (loop.endSec - loop.startSec) / playbackRate
    const crossfadeDuration = loop.crossfadeSec / playbackRate
    const step = loopDuration - crossfadeDuration
    let startTime = input.when
    let offsetSec = input.zone.startSec
    let first = true
    while (startTime < ampEnvelope.endTime && segments.length < 512) {
      const available = first ? introDuration : loopDuration
      const durationSec = Math.min(available, ampEnvelope.endTime - startTime)
      if (durationSec <= 0) break
      segments.push({
        offsetSec,
        startTime,
        durationSec,
        fadeInSec: first ? 0 : Math.min(crossfadeDuration, durationSec),
        fadeOutSec: Math.min(crossfadeDuration, durationSec),
      })
      startTime += first ? Math.max(0.001, introDuration - loop.crossfadeSec) : Math.max(0.001, step)
      offsetSec = loop.startSec
      first = false
    }
  }
  return {
    zone: input.zone,
    detuneCents,
    peakGain: Math.max(0, input.velocity / 127) * input.zone.gain,
    startTime: input.when,
    releaseTime,
    endTime: ampEnvelope.endTime,
    ampEnvelope,
    filterEnvelope,
    filterBaseHz: input.params.filterFrequencyHz,
    filterPeakHz: Math.max(20, Math.min(20_000, input.params.filterFrequencyHz + input.params.filterEnvelope.amount * 20_000)),
    segments,
    chokeGroup: input.zone.chokeGroup,
    polyphony: input.params.polyphony,
  }
}

export function getSamplerEnvelopeTimes(envelope: SamplerEnvelope, startTime: number, releaseTime: number) {
  const attackEnd = startTime + envelope.attackSec
  const decayEnd = attackEnd + envelope.decaySec
  return {
    startTime,
    attackEnd,
    decayEnd,
    releaseTime: Math.max(releaseTime, decayEnd),
    endTime: Math.max(releaseTime, decayEnd) + envelope.releaseSec,
    sustain: envelope.sustain,
  }
}

export function getSamplerLoopBounds(zone: SamplerZone) {
  if (zone.playbackMode === 'one-shot' || zone.loopStartSec === undefined || zone.loopEndSec === undefined) return undefined
  const length = zone.loopEndSec - zone.loopStartSec
  if (length <= 0) return undefined
  return {
    startSec: zone.loopStartSec,
    endSec: zone.loopEndSec,
    crossfadeSec: zone.playbackMode === 'crossfade-loop' ? Math.min(zone.crossfadeSec, length / 2) : 0,
  }
}

type CacheEntry<Value> = { value: Value; bytes: number; pins: number }

export function createSamplerBufferCache<Value>(
  maxBytes: number,
  onEvict?: (key: string, value: Value) => void,
) {
  const entries = new Map<string, CacheEntry<Value>>()
  let byteLimit = maxBytes
  let bytes = 0
  const touch = (key: string, entry: CacheEntry<Value>) => {
    entries.delete(key)
    entries.set(key, entry)
  }
  const evict = () => {
    while (bytes > byteLimit) {
      const candidate = Array.from(entries).find(([, entry]) => entry.pins === 0)
      if (!candidate) break
      entries.delete(candidate[0])
      bytes -= candidate[1].bytes
      onEvict?.(candidate[0], candidate[1].value)
    }
  }

  return {
    get: (key: string) => {
      const entry = entries.get(key)
      if (!entry) return undefined
      touch(key, entry)
      return entry.value
    },
    set: (key: string, value: Value, entryBytes: number) => {
      const existing = entries.get(key)
      if (existing) bytes -= existing.bytes
      const normalizedBytes = Math.max(0, entryBytes)
      entries.set(key, { value, bytes: normalizedBytes, pins: existing?.pins ?? 0 })
      bytes += normalizedBytes
      evict()
    },
    pin: (key: string) => {
      const entry = entries.get(key)
      if (!entry) return false
      entry.pins += 1
      touch(key, entry)
      return true
    },
    unpin: (key: string) => {
      const entry = entries.get(key)
      if (!entry || entry.pins === 0) return
      entry.pins -= 1
      evict()
    },
    delete: (key: string) => {
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      bytes -= entry.bytes
    },
    clear: () => {
      entries.clear()
      bytes = 0
    },
    keys: () => Array.from(entries.keys()),
    byteLength: () => bytes,
    maxByteLength: () => byteLimit,
    setMaxByteLength: (nextMaxBytes: number) => {
      byteLimit = Math.max(0, nextMaxBytes)
      evict()
    },
    overBudgetPinned: () => bytes > byteLimit,
  }
}
