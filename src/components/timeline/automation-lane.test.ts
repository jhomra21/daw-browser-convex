import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

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
