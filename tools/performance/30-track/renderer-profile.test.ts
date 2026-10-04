import { expect, test } from "bun:test"
import { rendererActivityDuringReturn, sanitizeRendererProfile, selectRendererProfileTarget } from "./renderer-profile"

test("renderer profile retains bounded timing and hashed frames without URLs or source text", () => {
  const profile = sanitizeRendererProfile({
    nodes: [{ id: 1, callFrame: { functionName: "private user name", url: "https://secret/token", scriptId: "3" }, children: [2] }],
    samples: [1], timeDeltas: [1000], startTime: 1, endTime: 2,
  })
  expect(profile.nodes[0]?.nameHash).toMatch(/^[a-f0-9]{16}$/)
  expect(JSON.stringify(profile)).not.toContain("private")
  expect(JSON.stringify(profile)).not.toContain("secret")
  expect(profile.samples).toEqual([1])
  expect(() => sanitizeRendererProfile({ nodes: [], samples: Array(100_001).fill(1), timeDeltas: [], startTime: 0, endTime: 1 })).toThrow()
})

test("profile target accepts the mounted project URL only for the single app page", () => {
  const target = { type: "page", url: "daw://app/?projectId=project%3Aexample", webSocketDebuggerUrl: "ws://127.0.0.1:45123/devtools/page/12345678-1234-1234-1234-123456789abc" }
  expect(selectRendererProfileTarget([target])).toEqual(target)
  expect(() => selectRendererProfileTarget([target, { ...target, url: "daw://app/" }])).toThrow()
  expect(() => selectRendererProfileTarget([{ ...target, url: "https://example.com/" }])).toThrow()
})

test("bounds renderer CPU activity to the worker return window", () => {
  const profile = { startedAtEpochMs: 1000, nodes: [
    { id: 1, nameHash: "c6509f06a5b98639" },
    { id: 2, nameHash: "ab00344a2303215c" },
    { id: 3, nameHash: "1234567890123456" },
  ], samples: [1, 3, 2, 3], timeDeltas: [100_000, 100_000, 100_000, 100_000] }
  expect(rendererActivityDuringReturn(profile, { returnedAtEpochMs: 1150, receivedAtEpochMs: 1350 })).toEqual({ idleSamples: 0, programSamples: 1, activeSamples: 1 })
  expect(rendererActivityDuringReturn(profile, { returnedAtEpochMs: 500, receivedAtEpochMs: 600 })).toBeNull()
})
