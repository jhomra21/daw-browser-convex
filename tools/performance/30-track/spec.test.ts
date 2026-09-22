import { expect, test } from "bun:test"
import {
  assertThirtyTrackSemanticManifest,
  sampleThirtyTrackSource,
  thirtyTrackSemanticManifest,
  triangle,
} from "./spec"

test("30-track semantic manifest is canonical and complete", () => {
  expect(() => assertThirtyTrackSemanticManifest(thirtyTrackSemanticManifest)).not.toThrow()
  expect(thirtyTrackSemanticManifest.timeline.sourceOffsetsSec).toEqual(
    Array.from({ length: 30 }, (_, index) => index),
  )
  expect(thirtyTrackSemanticManifest.timeline.colors).toHaveLength(6)
  expect(thirtyTrackSemanticManifest.timeline.clipCount).toBe(30)
  expect(thirtyTrackSemanticManifest.projectName).toBe("30 Track Performance v1")
  expect(thirtyTrackSemanticManifest.timeline.colors).toEqual([
    "#ff5f57", "#febc2e", "#28c840", "#4da3ff", "#a78bfa", "#f472b6",
  ])
  expect(thirtyTrackSemanticManifest.timeline.tracks[0]).toEqual({
    index: 0, name: "Benchmark 01", kind: "audio", volume: 1, color: "#ff5f57",
  })
  expect(thirtyTrackSemanticManifest.timeline.tracks[29]?.name).toBe("Benchmark 30")
  expect(thirtyTrackSemanticManifest.timeline.clips[0]?.name).toBe("Benchmark 01 Clip")
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
