import { expect, test } from "bun:test"
import {
  assertThirtyTrackSemanticManifest,
  sampleThirtyTrackSource,
  thirtyTrackTotalClipCount,
  thirtyTrackTotalTrackCount,
  thirtyTrackSemanticManifest,
  triangle,
  planThirtyTrackMixedRateSources,
  sampleThirtyTrackMixedRatePage,
} from "./spec"

test("mixed-rate pages are deterministic, bounded, and continuous", () => {
  const sources = planThirtyTrackMixedRateSources()
  expect(new Set(sources.map((source) => source.durationSec))).toEqual(new Set([3, 10, 30, 60, 120, 360, 600]))
  expect(sources).toHaveLength(30)
  for (const source of sources) {
    const first = sampleThirtyTrackMixedRatePage(source, 0, 257)
    const next = sampleThirtyTrackMixedRatePage(source, 257, 17)
    expect(first).toHaveLength(source.channelCount)
    expect(first[0]).toHaveLength(257)
    expect(first[0]?.[256]).toBe(sampleThirtyTrackMixedRatePage(source, 256, 1)[0]?.[0])
    expect(next[0]?.[0]).toBe(sampleThirtyTrackMixedRatePage(source, 257, 1)[0]?.[0])
    expect(first[0]?.[0]).toBe(sampleThirtyTrackMixedRatePage(source, 0, 1)[0]?.[0])
    expect(first.every((channel) => channel.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1))).toBe(true)
    expect(() => sampleThirtyTrackMixedRatePage(source, source.sampleRate * source.durationSec - 1, 2)).toThrow()
  }
  expect(() => sampleThirtyTrackMixedRatePage(sources[0]!, 0, 16_385)).toThrow()
})

test("mixed-rate expansion plan preserves 30 audio lanes and bounds long-source storage", () => {
  const plan = planThirtyTrackMixedRateSources()
  expect(plan).toHaveLength(30)
  expect(new Set(plan.map((source) => source.sampleRate))).toEqual(new Set([44_100, 48_000, 96_000]))
  expect(new Set(plan.map((source) => source.channelCount))).toEqual(new Set([1, 2]))
  expect(plan.filter((source) => source.durationSec >= 600)).toHaveLength(1)
  expect(plan[0]).toEqual({
    trackIndex: 0, sampleRate: 44_100, channelCount: 1, durationSec: 600,
    uncompressedBytes: 600 * 44_100 * 4,
  })
  expect(plan[29]?.trackIndex).toBe(29)
  expect(plan.every((source) => source.durationSec >= 3)).toBe(true)
  expect(plan.reduce((total, source) => total + source.uncompressedBytes, 0)).toBeGreaterThan(900_000_000)
})
import { createTierTwoControlRequest } from "./tier-two"

test("30-track semantic manifest is canonical and complete", () => {
  expect(() => assertThirtyTrackSemanticManifest(thirtyTrackSemanticManifest)).not.toThrow()
  expect(thirtyTrackSemanticManifest.timeline.sourceOffsetsSec).toEqual(
    Array.from({ length: 30 }, (_, index) => index),
  )
  expect(thirtyTrackSemanticManifest.timeline.colors).toHaveLength(6)
  expect(thirtyTrackSemanticManifest.timeline.clipCount).toBe(31)
  expect(thirtyTrackSemanticManifest.projectName).toBe("30 Track Performance v2")
  expect(thirtyTrackSemanticManifest.timeline.colors).toEqual([
    "#ff5f57", "#febc2e", "#28c840", "#4da3ff", "#a78bfa", "#f472b6",
  ])
  expect(thirtyTrackSemanticManifest.timeline.tracks[0]).toEqual({
    index: 0, name: "Benchmark 01", kind: "audio", volume: 1, color: "#ff5f57",
  })
  expect(thirtyTrackSemanticManifest.timeline.tracks[29]?.name).toBe("Benchmark 30")
  expect(thirtyTrackSemanticManifest.timeline.clips[0]?.name).toBe("Benchmark 01 Clip")
  expect(thirtyTrackTotalTrackCount).toBe(31)
  expect(thirtyTrackTotalClipCount).toBe(31)
  expect(thirtyTrackSemanticManifest.tier2.track).toEqual({
    id: "tier2-track",
    name: "Tier 2 Synth",
    index: 30,
    kind: "instrument",
    volume: 1,
  })
  expect(thirtyTrackSemanticManifest.tier2.midiClip.notes).toHaveLength(16)
  expect(thirtyTrackSemanticManifest.tier2.midiClip.notes.map((note) => note.pitch)).toEqual([
    60, 64, 67, 71, 60, 64, 67, 71, 60, 64, 67, 71, 60, 64, 67, 71,
  ])
  expect(thirtyTrackSemanticManifest.tier2.effects.map((effect) => effect.kind)).toEqual([
    "saturator",
    "utility",
  ])
  expect(thirtyTrackSemanticManifest.tier2.automation).toEqual({
    effectKind: "saturator",
    parameterId: "saturator.driveDb",
    enabled: true,
    points: [
      { id: "tier2-saturator-drive-0", timeSec: 0, value: 0, interpolation: "linear" },
      { id: "tier2-saturator-drive-4", timeSec: 4, value: 12, interpolation: "linear" },
      { id: "tier2-saturator-drive-8", timeSec: 8, value: 0, interpolation: "linear" },
    ],
  })
})

test("triangle source is deterministic at its integer periods", () => {
  expect(triangle(0, 240)).toBe(1)
  expect(triangle(120, 240)).toBe(-1)
  expect(triangle(240, 240)).toBe(1)
  expect(sampleThirtyTrackSource(0)).toEqual({ left: 0.18, right: 0.18 })
  expect(sampleThirtyTrackSource(240)).toEqual({ left: 0.18, right: -0.06 })
})

test("semantic validation rejects reordered source offsets", () => {
  expect(() => assertThirtyTrackSemanticManifest({
    ...thirtyTrackSemanticManifest,
    timeline: {
      ...thirtyTrackSemanticManifest.timeline,
      sourceOffsetsSec: [1, ...thirtyTrackSemanticManifest.timeline.sourceOffsetsSec.slice(1, 29), 0],
    },
  })).toThrow("source offsets")
})

test("semantic validation rejects altered Tier 2 notes", () => {
  expect(() => assertThirtyTrackSemanticManifest({
    ...thirtyTrackSemanticManifest,
    tier2: {
      ...thirtyTrackSemanticManifest.tier2,
      midiClip: {
        ...thirtyTrackSemanticManifest.tier2.midiClip,
        notes: thirtyTrackSemanticManifest.tier2.midiClip.notes.map((note, index) => (
          index === 5 ? { ...note, pitch: 65 } : note
        )),
      },
    },
  })).toThrow()
})

test("semantic validation rejects reordered Tier 2 processors", () => {
  expect(() => assertThirtyTrackSemanticManifest({
    ...thirtyTrackSemanticManifest,
    tier2: {
      ...thirtyTrackSemanticManifest.tier2,
      effects: [...thirtyTrackSemanticManifest.tier2.effects].reverse(),
    },
  })).toThrow()
})

test("semantic validation rejects disabled Tier 2 automation", () => {
  expect(() => assertThirtyTrackSemanticManifest({
    ...thirtyTrackSemanticManifest,
    tier2: {
      ...thirtyTrackSemanticManifest.tier2,
      automation: {
        ...thirtyTrackSemanticManifest.tier2.automation,
        enabled: false,
      },
    },
  })).toThrow()
})

test("Tier 2 control request uses same-request references and deterministic ordering", () => {
  expect(createTierTwoControlRequest("local-project:test", 7)).toEqual({
    version: "v1",
    projectId: "local-project:test",
    expectedRevision: 7,
    actions: [
      {
        kind: "track.create",
        clientRef: "tier2-track",
        name: "Tier 2 Synth",
        index: 30,
        trackKind: "instrument",
      },
      {
        kind: "clip.midi.create",
        clientRef: "tier2-midi-clip",
        track: { source: "client", clientRef: "tier2-track" },
        name: "Tier 2 Synth Clip",
        startSec: 0,
        duration: 8,
        wave: "sawtooth",
        notes: thirtyTrackSemanticManifest.tier2.midiClip.notes,
      },
      {
        kind: "track.mix.set",
        track: { source: "client", clientRef: "tier2-track" },
        volume: 1,
      },
      {
        kind: "instrument.set",
        target: { kind: "track", track: { source: "client", clientRef: "tier2-track" } },
        instrumentKind: "synth",
        params: thirtyTrackSemanticManifest.tier2.instrument.params,
      },
      {
        kind: "effect.upsert",
        clientRef: "tier2-saturator",
        target: { kind: "track", track: { source: "client", clientRef: "tier2-track" } },
        effectKind: "saturator",
        params: thirtyTrackSemanticManifest.tier2.effects[0]?.params,
      },
      {
        kind: "effect.upsert",
        clientRef: "tier2-utility",
        target: { kind: "track", track: { source: "client", clientRef: "tier2-track" } },
        effectKind: "utility",
        params: thirtyTrackSemanticManifest.tier2.effects[1]?.params,
      },
      {
        kind: "effect.reorder",
        target: { kind: "track", track: { source: "client", clientRef: "tier2-track" } },
        order: [
          { effect: { source: "client", clientRef: "tier2-saturator" }, kind: "saturator" },
          { effect: { source: "client", clientRef: "tier2-utility" }, kind: "utility" },
        ],
      },
      {
        kind: "automation.set",
        target: { kind: "track", track: { source: "client", clientRef: "tier2-track" } },
        effect: { source: "client", clientRef: "tier2-saturator" },
        parameterId: "saturator.driveDb",
        enabled: true,
        points: thirtyTrackSemanticManifest.tier2.automation.points,
      },
    ],
  })
})
