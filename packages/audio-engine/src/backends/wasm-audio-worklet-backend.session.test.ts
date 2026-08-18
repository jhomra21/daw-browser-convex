import { expect, test } from "bun:test"

import { audioCoreContractVersion, type AudioAssetRef, type AudioCoreGraphSnapshot } from "../../../audio-core-contract/src"
import { PortableWasmPlaybackSession } from "./wasm-audio-worklet-backend"
import {
  portableWasmProtocolVersion,
  type PortableWasmControlMessage,
  type PortableWasmStatusMessage,
} from "../portable-wasm-protocol"

type PortableRequest = Extract<PortableWasmControlMessage, { requestId: number }>

const responseFor = (message: PortableRequest): PortableWasmStatusMessage => {
  if (message.type === "prepare-graph") return { version: portableWasmProtocolVersion, type: "graph-prepared", requestId: message.requestId, revision: message.snapshot.revision, result: "prepared" }
  if (message.type === "publish-graph") return { version: portableWasmProtocolVersion, type: "graph-published", requestId: message.requestId, revision: message.revision, result: "published" }
  if (message.type === "register-asset") return { version: portableWasmProtocolVersion, type: "asset-registered", requestId: message.requestId, generation: message.generation, assetId: message.asset.assetId, result: "registered", handle: { slot: 0, generation: message.generation } }
  if (message.type === "install-schedule") return { version: portableWasmProtocolVersion, type: "schedule-installed", requestId: message.requestId, revision: message.schedule.revision, epoch: message.schedule.transportEpoch, result: "installed" }
  if (message.type === "schedule-sources") return { version: portableWasmProtocolVersion, type: "sources-scheduled", requestId: message.requestId, revision: message.revision, epoch: message.epoch, result: "scheduled" }
  if (message.type === "transport") return { version: portableWasmProtocolVersion, type: "transport-applied", requestId: message.requestId, epoch: message.epoch, result: "applied" }
  if (message.type === "processor-events") return { version: portableWasmProtocolVersion, type: "processor-events-applied", requestId: message.requestId, revision: message.revision, epoch: message.epoch, sequence: message.sequence, result: "applied" }
  if (message.type === "release-asset") return { version: portableWasmProtocolVersion, type: "asset-released", requestId: message.requestId, generation: message.generation, assetId: message.assetId, result: "released" }
  return { version: portableWasmProtocolVersion, type: "processor-automation-reenabled", requestId: message.requestId, revision: message.revision, epoch: message.epoch, result: "applied" }
}

const isPortableRequest = (message: PortableWasmControlMessage): message is PortableRequest =>
  "requestId" in message

const createSession = (
  reply = true,
  respond: (message: PortableRequest) => PortableWasmStatusMessage = responseFor,
  controlTimeoutMs?: number,
) => {
  const calls: string[] = []
  let handler: ((event: MessageEvent<PortableWasmStatusMessage>) => void) | null = null
  const node: AudioWorkletNode = Object.assign(Object.create(null), {
    port: {
      get onmessage() {
        return handler
      },
      set onmessage(next: ((event: MessageEvent<PortableWasmStatusMessage>) => void) | null) {
        handler = next
      },
      postMessage(message: PortableWasmControlMessage) {
        calls.push(message.type)
        const response = reply && isPortableRequest(message) ? respond(message) : undefined
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
  fixture.node.port.onmessage?.(new MessageEvent("message", {
    data: { version: portableWasmProtocolVersion, type: "fault", code: "core-error" },
  }))

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
      ? {
        version: portableWasmProtocolVersion,
        type: "schedule-installed",
        requestId: message.requestId,
        revision: message.schedule.revision,
        epoch: message.schedule.transportEpoch,
        result: "rejected",
      }
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
