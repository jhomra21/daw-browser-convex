import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { windowAutomationPoints } from "./automation-lane-geometry"

test("recovers automation drags through pointer capture and pointer identity", async () => {
  const source = await readFile(new URL("./automation-lane.tsx", import.meta.url), "utf8")
  expect(source).toContain("setPointerCapture(pointerId)")
  expect(source).toContain("lostpointercapture")
  expect(source).toContain("moveEvent.pointerId !== pointerId")
  expect(source).toContain("upEvent.pointerId !== pointerId")
  expect(source).toContain("cancelEvent.pointerId !== pointerId")
  expect(source).toContain("hasPointerCapture(pointerId)")
  expect(source).toContain("const [draftPoints, setDraftPoints]")
  expect(source).toContain("setDraftPoints((currentPoints)")
  expect(source).toContain("if (finalPoints) commitPoints(finalPoints)")
  expect(source).not.toContain("previewPoints(")
})

test("orders and deduplicates automation viewport boundaries", () => {
  const points = windowAutomationPoints([
    { id: "late", timeSec: 8, value: 0.8, interpolation: "linear" },
    { id: "early", timeSec: 2, value: 0.2, interpolation: "linear" },
    { id: "boundary", timeSec: 4, value: 0.4, interpolation: "linear" },
  ], 4, 8, 0)
  expect(points.map((point) => point.timeSec)).toEqual([4, 8])
  expect(new Set(points.map((point) => point.timeSec)).size).toBe(points.length)
})

test("preserves hold interpolation at a synthetic viewport boundary", () => {
  const points = windowAutomationPoints([
    { id: "hold", timeSec: 2, value: 0.2, interpolation: "hold" },
    { id: "next", timeSec: 8, value: 0.8, interpolation: "linear" },
  ], 4, 6, 0)
  expect(points[0]).toMatchObject({
    timeSec: 4,
    value: 0.2,
    interpolation: "hold",
  })
})
