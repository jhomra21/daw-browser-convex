import { expect, test } from "bun:test"

import { audioCoreContractVersion, type AudioAssetRef, type AudioCoreGraphSnapshot } from "../../../audio-core-contract/src"
import { PortableWasmPlaybackSession } from "./wasm-audio-worklet-backend"

const responseFor = (message: Record<string, unknown>) => {
  const requestId = message.requestId
  if (typeof requestId !== "number") return undefined
  if (message.type === "prepare-graph") return { type: "graph-prepared", requestId, result: "prepared" }
  if (message.type === "publish-graph") return { type: "graph-published", requestId, result: "published" }
  if (message.type === "register-asset") return { type: "asset-registered", requestId, result: "registered", handle: { slot: 0, generation: 1 } }
  if (message.type === "install-schedule") return { type: "schedule-installed", requestId, result: "installed" }
  if (message.type === "schedule-sources") return { type: "sources-scheduled", requestId, result: "scheduled" }
  if (message.type === "transport") return { type: "transport-applied", requestId, result: "applied" }
  return undefined
}

const createSession = (
  reply = true,
  respond: (message: Record<string, unknown>) => Record<string, unknown> | undefined = responseFor,
  controlTimeoutMs?: number,
) => {
  const calls: string[] = []
  let handler: ((event: MessageEvent<unknown>) => void) | null = null
  const node: AudioWorkletNode = Object.assign(Object.create(null), {
    port: {
      get onmessage() {
        return handler
      },
      set onmessage(next: ((event: MessageEvent<unknown>) => void) | null) {
        handler = next
      },
      postMessage(message: unknown) {
        if (typeof message !== "object" || message === null || !("type" in message) || typeof message.type !== "string") return
        calls.push(message.type)
        const response = reply ? respond(message) : undefined
        if (response) handler?.(new MessageEvent("message", { data: response }))
      },
      close() {},
    },
    onprocessorerror: null,
    connect() {},
    disconnect() {},
  })
  return { calls, node, session: new PortableWasmPlaybackSession(node, undefined, controlTimeoutMs) }
}

test("requires acknowledged portable preparation before marking playback active", async () => {
  const fixture = createSession()
  const snapshot: AudioCoreGraphSnapshot = {
    version: audioCoreContractVersion,
    revision: 1,
    contractHash: "test",
    masterNodeId: "master",
    edges: [],
    assets: [],
    nodes: [{
      id: "master",
      kind: "master",
      inputLayout: "stereo",
      outputLayout: "stereo",
      latencyFrames: 0,
      processorOrder: [],
    }],
  }
  const asset: AudioAssetRef = { version: audioCoreContractVersion, assetId: "asset", frameCount: 1, sampleRateHz: 48_000, channelCount: 1 }
  const pcm = { frameCount: 1, planes: [new Float32Array([0])] }

  await fixture.session.prepareGraph(snapshot)
  expect((await fixture.session.registerAsset(asset, pcm, 1)).status).toBe("registered")
  await fixture.session.publishGraph(1)
  await fixture.session.setTransport(1, false, 0)
  await fixture.session.installSchedule({
    revision: 1,
    transportEpoch: 1,
    sampleRateHz: 48_000,
    bpm: 120,
    timeOrigin: { timelineSec: 0, frame: 0 },
    events: [],
  })
  await fixture.session.scheduleSources(1, 1, [])
  await fixture.session.setTransport(1, true, 0)
  fixture.session.markActive()

  expect(fixture.calls).toEqual([
    "prepare-graph",
    "register-asset",
    "publish-graph",
    "transport",
    "install-schedule",
    "schedule-sources",
    "transport",
  ])
  expect(fixture.session.isActive).toBeTrue()
})

test("mutes and reports an active worklet fault", () => {
  const fixture = createSession()
  const faults: string[] = []
  fixture.session.markActive()
  fixture.session.onFault((error) => faults.push(error.message))
  fixture.node.port.onmessage?.(new MessageEvent("message", { data: { type: "fault" } }))

  expect(fixture.session.isActive).toBeFalse()
  expect(fixture.calls).toEqual(["dispose"])
  expect(faults).toEqual(["Portable audio-core AudioWorklet control request failed."])
})

test("routes requestless graph continuity notifications to telemetry listeners", () => {
  const fixture = createSession()
  const continuity: string[] = []
  fixture.session.onGraphContinuity((message) => continuity.push(`${message.revision}:${message.result}`))

  fixture.node.port.onmessage?.(new MessageEvent("message", {
    data: { version: 1, type: "graph-continuity", revision: 7, result: "fallback" },
  }))

  expect(continuity).toEqual(["7:fallback"])
})

test("rejects an unacknowledged schedule installation", async () => {
  const fixture = createSession(true, (message) => (
    message.type === "install-schedule"
      ? { type: "schedule-installed", requestId: message.requestId, result: "rejected" }
      : responseFor(message)
  ))

  await expect(fixture.session.installSchedule({
    revision: 1,
    transportEpoch: 1,
    sampleRateHz: 48_000,
    bpm: 120,
    timeOrigin: { timelineSec: 0, frame: 0 },
    events: [],
  })).rejects.toThrow("schedule-installed was rejected")

  expect(fixture.session.isActive).toBeFalse()
  expect(fixture.calls).toEqual(["install-schedule"])
})

test("bounds an unacknowledged portable preparation request", async () => {
  const fixture = createSession(false, responseFor, 5)
  await expect(fixture.session.prepareGraph({
    version: audioCoreContractVersion,
    revision: 1,
    contractHash: "test",
    masterNodeId: "master",
    edges: [],
    assets: [],
    nodes: [{
      id: "master",
      kind: "master",
      inputLayout: "stereo",
      outputLayout: "stereo",
      latencyFrames: 0,
      processorOrder: [],
    }],
  })).rejects.toThrow("timed out")

  expect(fixture.calls).toEqual(["prepare-graph", "dispose"])
})

test("dispose rejects unresolved portable requests and closes the dispatcher", async () => {
  const fixture = createSession(false, responseFor, 1_000)
  const pending = fixture.session.prepareGraph({
    version: audioCoreContractVersion,
    revision: 1,
    contractHash: "test",
    masterNodeId: "master",
    edges: [],
    assets: [],
    nodes: [{
      id: "master",
      kind: "master",
      inputLayout: "stereo",
      outputLayout: "stereo",
      latencyFrames: 0,
      processorOrder: [],
    }],
  })
  fixture.session.dispose()

  await expect(pending).rejects.toThrow("disposed")
  expect(fixture.calls).toEqual(["prepare-graph", "dispose"])
  expect(fixture.node.port.onmessage).toBeNull()
})
