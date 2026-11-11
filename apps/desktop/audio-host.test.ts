import { describe, expect, spyOn, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { audioCoreWasmAbiVersion } from "@daw-browser/audio-core-wasm"
import { defaultDecodedAudioPageFrames } from "@daw-browser/audio-engine/media-pages"
import { portableGraphContractHash, processorContractHash } from "@daw-browser/audio-core-contract/generated"
import { maxVst3WorkerEventsPerBlock } from "@daw-browser/plugin-host-protocol"
import {
  nativeHostConfigurationIdentityFor,
  createNativeAudioHostSupervisor,
  encodeNativeAudioHostControlFrame,
  NativeAudioHostCommandError,
  NativeAudioHostNotSentError,
  decodeNativeProcessorPatchStatus,
  nativeDeliveryFailureKind,
  nativeProcessorPatchReply,
  nativeVstEditorOwnershipProbe,
  packagedAudioHostPath,
  probeNativeAudioOutputDevice,
  renderNativeOffline,
  createNativeOfflineFrameMailbox,
  createNativeOfflineStdoutPump,
  runAudioHostDiagnostic,
  isNativeOfflineTelemetryFrame,
  type NativeAudioHostSupervisorOptions,
  type ResolvedVst3Attachment,
} from "./audio-host"
import { createOfflinePcmAckTracker, deliverOfflinePcmChunk } from "./offline-pcm-ack"
import {
  nativeAudioHostArtifactId,
  nativeAudioHostControlTypes,
  nativeAudioHostProtocolVersion,
} from "@daw-browser/desktop-protocol/native-audio-host"
import type { NativeHostMappedAssetPage } from "@daw-browser/audio-engine/native-host-wire"

const hostScript = `
const u32 = (value) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
const frame = (type, payload = Buffer.alloc(0)) => Buffer.concat([
  u32(0x44415748), u32(${nativeAudioHostProtocolVersion}), u32(type), u32(payload.length), payload,
])
const string = (value) => Buffer.concat([u32(Buffer.byteLength(value)), Buffer.from(value)])
const stringLe = (value) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(Buffer.byteLength(value))
  return Buffer.concat([bytes, Buffer.from(value)])
}
const u32Le = (value) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}
const u64 = (value) => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(BigInt(value))
  return bytes
}
const f32 = (value) => {
  const bytes = Buffer.alloc(4)
  bytes.writeFloatBE(value)
  return bytes
}
const hello = () => frame(2, Buffer.concat([
  u32(${nativeAudioHostProtocolVersion}), u32(0x3ff), u32(${audioCoreWasmAbiVersion}),
  string(process.env.MODE === "incompatible" ? "wrong" : "${processorContractHash}"),
  string("${portableGraphContractHash}"), string("${nativeAudioHostArtifactId}"), u32(0), u32(1),
]))
const device = () => frame(19, Buffer.concat([
  u32(1), string("coreaudio:fixture"), string("Fixture Output"), u32(48000), u32(2), u32(512), u32(1),
]))
const inputDevice = () => frame(35, Buffer.concat([
  u32(1), string("coreaudio:fixture-input"), string("Fixture Input"), u32(48000), u32(2), u32(512), u32(1),
]))
const ack = (type, status = 1, text = "") => frame(13, Buffer.concat([u32(type), u32(status), Buffer.from(text)]))
const vstState = (instanceId = "11111111-1111-4111-8111-111111111111") => {
  const state = Buffer.from([1, 2, 3])
  return frame(27, Buffer.concat([
    stringLe(instanceId), u32Le(state.length), u32Le(64), state, Buffer.from("a".repeat(64)),
  ]))
}
const graphStatus = (code, requested, active, prepared, retired) => frame(40, Buffer.concat([
  u32(code), u32(0), u32(requested), u32(active), u32(prepared), u32(retired), u64(4), u64(0),
  u32(3), u64(256), u64(128), u32(1),
]))
const workerNotification = () => frame(14, Buffer.concat([
  u32(1), u32(9), u64(17), u32(128), string("instance-1"),
]))
const meterBatch = () => frame(44, Buffer.concat([
  u32(9), u32(1), u64(5), u32(2),
  u64(17), f32(0.25), f32(0.5),
  u64(23), f32(0.75), f32(1),
]))
const scheduleProgress = () => frame(46, Buffer.concat([
  u32(9), u32(1), u64(1), u64(180), u64(240), u64(7), u64(3), u64(0), u64(0),
  u32(1), u32(128), u32(64), u32(32),
  ...(process.env.MODE === "schedule-capacity" ? [u64(42)] : []),
  ...(process.env.MODE === "schedule-latency" ? [u64(42), u64(7)] : []),
  ...(process.env.MODE === "schedule-bad-length" ? [u32(42)] : []),
  ...(process.env.MODE === "schedule-bad-length-104" ? [u64(42), u64(7), u64(0)] : []),
  ...(process.env.MODE === "schedule-bad-length-120" ? [u64(42), u64(7), u64("9007199254740993"), u32(5), u32(0), u64(0)] : []),
  ...(process.env.MODE === "schedule-resolution" ? [u64(42), u64(7), u64("9007199254740993"), u32(5), u32(0)] : []),
  ...(process.env.MODE === "schedule-resolution-none" ? [u64(42), u64(7), u64(0), u32(0), u32(0)] : []),
  ...(process.env.MODE === "schedule-bad-reserved" ? [u64(42), u64(7), u64("9007199254740993"), u32(5), u32(1)] : []),
]))
const patchStatus = (outcome, refusal, core, token) => frame(61, Buffer.concat([u32(outcome), u32(refusal), u32(core), u64(token)]))
const patchStatusFor = (mode) => ({
  "patch-applied": () => patchStatus(1, 0, 0, 0),
  "patch-claimed": () => patchStatus(3, 0, 0, "9007199254740993"),
  "patch-refused-pending": () => patchStatus(2, 3, 0, "9007199254740993"),
  "patch-refused-stage": () => patchStatus(2, 6, 17, 0),
  "patch-bad-claim-token": () => patchStatus(3, 0, 0, 0),
  "patch-bad-refusal": () => patchStatus(2, 9, 0, 0),
  "patch-bad-core": () => patchStatus(2, 4, 3, 0),
  "patch-bad-length": () => frame(61, Buffer.alloc(19)),
})[mode]?.()
const editorInteractionNotification = () => frame(14, Buffer.concat([
  u32(6), u32(9), u64(17), u32(0), string("instance-1"),
]))
const parameterEditNotification = () => {
  const value = Buffer.alloc(8)
  value.writeDoubleBE(0.625)
  return frame(14, Buffer.concat([
    u32(7), u32(9), u64(17), u32(42), value,
    string("11111111-1111-4111-8111-111111111111"),
  ]))
}
const recordingBlock = () => {
  const samples = Buffer.alloc(8)
  samples.writeFloatLE(0.25, 0)
  samples.writeFloatLE(-0.5, 4)
  return frame(32, Buffer.concat([
    u32(1), u64(1), u64(0), u32(2), u32(1), f32(0.4), f32(0.5), samples,
  ]))
}
const recordingStatus = () => frame(33, Buffer.concat([
  u32(1), u64(1), u64(120), u64(2), u64(0), u32(0), u32(63), u32(0),
  f32(0.4), f32(0.5), u32(7),
]))
let recordingGeneration = 1
let recordingSessionId = 1n
const spoolStatus = (state, active = false) => frame(33, Buffer.concat([
  u32(recordingGeneration), u64(recordingSessionId), u64(120), u64(2), u64(0), u32(0), u32(32), u32(0),
  f32(0.4), f32(0.5), u32((active ? 2 : 0) | 4 | (state === 2 ? 8 : 16)),
  u32(state), u32(0), u32(0), u64(state === 2 ? 2 : 0), u64(state === 2 ? 20 : 0),
  u64(state === 2 ? 1 : 0), u64(state === 2 ? 1 : 0), u64(state === 2 ? 12 : 0), u32(48000), u32(2),
]))
process.on("SIGUSR1", () => {
  const status = spoolStatus(process.env.MODE === "spool-failed-finish" ? 3 : 2)
  if (process.env.MODE === "spool-bad-pool") status.writeUInt32BE(33, 16 + 40)
  if (process.env.MODE === "spool-bad-meter") status.writeFloatBE(NaN, 16 + 48)
  if (process.env.MODE === "spool-bad-active") status.writeUInt32BE(10, 16 + 56)
  if (process.env.MODE === "spool-bad-identity") status.writeUInt32BE(0, 16)
  if (process.env.MODE === "spool-bad-totals") status.writeBigUInt64BE(21n, 16 + 80)
  process.stdout.write(status)
  if (process.env.MODE === "spool-slow-stop") process.stdout.write(ack(30))
})
process.on("SIGUSR2", () => process.stdout.write(recordingBlock()))
const editorStatus = () => frame(42, Buffer.concat([
  u32(1), u32(1), u32(1), u32(1), u32(640), u32(480),
]))
const offlineChunk = (startFrame, value) => frame(54, Buffer.concat([
  u64(startFrame), u32(1), u32(1), f32(value),
]))
const offlineScheduleBurst = () => Buffer.concat([
  scheduleProgress(), scheduleProgress(), scheduleProgress(), scheduleProgress(), scheduleProgress(),
])
const offlineTelemetryBurst = () => Buffer.concat([
  workerNotification(), meterBatch(), scheduleProgress(),
])
const offlineError = (message) => frame(56, Buffer.concat([
  u32(Buffer.byteLength(message)), Buffer.from(message),
]))
const vstPlaybackFlag = (payload) => {
  let offset = 0
  for (let index = 0; index < 5; index += 1) {
    if (offset + 4 > payload.length) return undefined
    const length = payload.readUInt32BE(offset)
    offset += 4 + length
    if (offset > payload.length) return undefined
  }
  const flagOffset = offset + 4 + 8 + 1 + 32 + 32 + 4 + 4 + 3
  return flagOffset < payload.length ? payload[flagOffset] : undefined
}
let bytes = Buffer.alloc(0)
let rejectedAck = false
let mappedFrames = 0
let mappedWritten = 0
let mappedPrepared = false
if (process.env.MODE === "ignore-teardown") process.on("SIGTERM", () => {})
process.stdin.on("data", (chunk) => {
  bytes = Buffer.concat([bytes, chunk])
  while (bytes.length >= 16 && bytes.length >= 16 + bytes.readUInt32BE(12)) {
    const length = bytes.readUInt32BE(12)
    const type = bytes.readUInt32BE(8)
    const payload = bytes.subarray(16, 16 + length)
    bytes = bytes.subarray(16 + length)
    if (type === 1) {
      if (process.env.MODE !== "silent") process.stdout.write(hello())
      if (process.env.MODE === "notification") process.stdout.write(workerNotification())
      if (process.env.MODE === "meter") process.stdout.write(meterBatch())
      if (process.env.MODE?.startsWith("schedule")) process.stdout.write(scheduleProgress())
      if (process.env.MODE === "editor-interaction") process.stdout.write(editorInteractionNotification())
      if (process.env.MODE === "parameter-edit") process.stdout.write(parameterEditNotification())
      if (process.env.MODE === "loss") setTimeout(() => process.exit(1), 10)
    } else if (type === 12 || (type === 36 && process.env.MODE === "device-loss")) {
      process.stdout.write(frame(12, Buffer.concat([
        u32(process.env.MODE === "device-loss" ? 3 : 0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u64(0),
        u32(0), u64(0), u64(0), u32(0), u32(0),
        u32(0), u32(0), u32(0), u32(0), u32(0),
        u32(0), u32(0), u32(0), u32(0), u64(0),
        u32(0),
        u64(0), u32(0), u32(0),
        u64(0), u64(0), u64(0), u64(0), u64(0), u64(0),
        u32(0), u64(0), u64(0), u64(0), u64(0), u64(0), u64(0), u64(0), u64(0), u64(0),
      ])))
    } else if (type === 36) {
      process.stdout.write(graphStatus(process.env.MODE === "transition-pending" ? 11 : 1, 2, 1, 2, 0))
    } else if (type === 37) {
      process.stdout.write(graphStatus(process.env.MODE === "transition-pending" ? 11 : 2, 2, 2, 0, 1))
    } else if (type === 38) {
      process.stdout.write(graphStatus(process.env.MODE === "transition-pending" ? 9 : 3, 1, 2, 0, 0))
    } else if (type === 39) {
      process.stdout.write(graphStatus(4, 2, 1, 0, 0))
    } else if (type === 19) {
      process.stdout.write(device())
    } else if (type === 34) {
      process.stdout.write(inputDevice())
    } else if (type === 28 && process.env.MODE?.startsWith("spool")) {
      recordingGeneration = payload.readUInt32BE(0)
      recordingSessionId = payload.readBigUInt64BE(4)
      process.stdout.write(ack(type))
      process.stdout.write(spoolStatus(1))
    } else if (type === 30 && process.env.MODE?.startsWith("spool")) {
      if (process.env.MODE !== "spool-slow-stop") process.stdout.write(ack(type))
      process.stdout.write(spoolStatus(1))
    } else if (type === 29) {
      process.stdout.write(ack(type))
      if (process.env.MODE?.startsWith("spool")) process.stdout.write(spoolStatus(1, true))
      else { process.stdout.write(recordingBlock()); process.stdout.write(recordingStatus()) }
    } else if (type === 41) {
      if (process.env.MODE === "editor-anchor"
        && (payload.length < 28
          || payload.readUInt32BE(12) !== 1
          || payload.readInt32BE(16) !== -320
          || payload.readInt32BE(20) !== -240)) process.exit(2)
      process.stdout.write(editorStatus())
    } else if (type === 43) {
      process.stdout.write(ack(type))
    } else if (type === 51 && patchStatusFor(process.env.MODE)) {
      process.stdout.write(patchStatusFor(process.env.MODE))
    } else if (type === 53 && process.env.MODE === "offline-burst") {
      process.stdout.write(Buffer.concat([
        ack(type),
        offlineChunk(0, 0.1),
        offlineChunk(1, 0.2),
        offlineChunk(2, 0.3),
        offlineChunk(3, 0.4),
        offlineChunk(4, 0.5),
        frame(55, u64(5)),
      ]))
    } else if (type === 53 && process.env.MODE === "offline-schedule-burst") {
      process.stdout.write(Buffer.concat([
        offlineScheduleBurst(),
        ack(type),
        offlineChunk(0, 0.1),
        frame(55, u64(1)),
      ]))
    } else if (type === 53 && process.env.MODE === "offline-telemetry") {
      process.stdout.write(Buffer.concat([
        offlineTelemetryBurst(),
        offlineTelemetryBurst(),
        ack(type),
        offlineChunk(0, 0.1),
        offlineTelemetryBurst(),
        frame(55, u64(1)),
      ]))
    } else if (type === 53 && process.env.MODE === "offline-error-after-telemetry") {
      process.stdout.write(Buffer.concat([
        offlineTelemetryBurst(),
        offlineError("exact native offline error"),
      ]))
    } else if (type === 53 && process.env.MODE === "offline-periodic") {
      process.stdout.write(ack(type))
      let startFrame = 0
      const sendChunk = () => {
        process.stdout.write(offlineChunk(startFrame, 0.1 + startFrame / 100))
        startFrame += 1
        if (startFrame < 10) setTimeout(sendChunk, 15)
        else process.stdout.write(frame(55, u64(10)))
      }
      sendChunk()
    } else if (type === 57 && process.env.MODE === "offline-mapped-pages") {
      mappedFrames = Number(payload.readBigUInt64BE(4))
      mappedWritten = 0
      mappedPrepared = false
      process.stdout.write(ack(type))
    } else if (type === 58 && process.env.MODE === "offline-mapped-pages") {
      const start = Number(payload.readBigUInt64BE(4))
      const count = payload.readUInt32BE(12)
      if (start !== mappedWritten || count > 16384) process.exit(2)
      mappedWritten += count
      process.stdout.write(ack(type))
    } else if (type === 59 && process.env.MODE === "offline-mapped-pages") {
      mappedPrepared = mappedWritten === mappedFrames
      process.stdout.write(ack(type, mappedPrepared ? 1 : 0))
    } else if (type === 48 && process.env.MODE === "offline-mapped-pages") {
      process.stdout.write(ack(type, mappedPrepared ? 1 : 0))
    } else if (type === 48 && process.env.MODE === "offline-instrument-rejected") {
      process.stdout.write(frame(13, Buffer.concat([u32(type), u32(0), Buffer.from("Instrument sample upload is incomplete. Reload samples and retry.")])))
    } else if (type === 45 && process.env.MODE === "offline-schedule-rejected") {
      process.stdout.write(frame(13, Buffer.concat([u32(type), u32(0), Buffer.from("instrument target is missing or its parameter is unsupported")])))
    } else if (type === 53 && process.env.MODE === "offline-mapped-pages") {
      process.stdout.write(Buffer.concat([ack(type), frame(55, u64(0))]))
    } else if (type === 53 && process.env.MODE === "offline-stalled") {
      process.stdout.write(ack(type))
    } else if (type === 26) {
      if (process.env.MODE === "state-rejected") process.stdout.write(ack(type, 0))
      else if (process.env.MODE === "state-malformed") process.stdout.write(frame(27, Buffer.from([1, 2, 3])))
      else if (process.env.MODE === "state-mismatch") process.stdout.write(vstState("22222222-2222-4222-8222-222222222222"))
      else process.stdout.write(vstState())
    } else if (type === 20 && process.env.MODE === "begin-delayed") {
      setTimeout(() => process.stdout.write(ack(type)), 30)
    } else if (type === 21 && process.env.MODE === "commit-delayed") {
      setTimeout(() => process.stdout.write(ack(type)), 30)
    } else if (type === 22 && process.env.MODE === "rollback-rejected") {
      process.stdout.write(ack(type, 0))
    } else if (type === 3 && process.env.MODE === "close-on-configure") {
      process.exit(0)
    } else if (type === 16 && process.env.MODE === "stop-reason"
      && (payload.length !== 4 + payload.readUInt32BE(0)
        || payload.readUInt32BE(0) !== Buffer.byteLength("project-switch")
        || payload.subarray(4).toString("utf8") !== "project-switch")) {
      process.exit(2)
    } else if (type === 10 && vstPlaybackFlag(payload) !== 0) {
      process.exit(2)
    } else {
      const requestType = process.env.MODE === "wrong-ack" ? 99 : type
      // Both modes carry the same human text; only the status word differs.
      const unavailableText = "audio session is unavailable"
      const status = rejectedAck ? 1
        : process.env.MODE === "rejected-ack" ? 0
        : process.env.MODE === "unavailable-ack" ? 2
        : process.env.MODE === "bad-ack-status" ? 3
        : 1
      const text = status === 1 ? "" : unavailableText
      rejectedAck = true
      const response = () => process.stdout.write(ack(requestType, status, text))
      if (process.env.MODE === "editor-queued" && type === 3) setTimeout(response, 30)
      else response()
    }
  }
})
`

describe("native audio host protocol", () => {
  test("matches the native empty graph rollback frame fixture", () => {
    expect(encodeNativeAudioHostControlFrame(nativeAudioHostControlTypes.graphRollback)).toEqual(
      Buffer.from([
        0x44, 0x41, 0x57, 0x48,
        0x00, 0x00, 0x00, 0x1d,
        0x00, 0x00, 0x00, 0x27,
        0x00, 0x00, 0x00, 0x00,
      ]),
    )
  })
})

test("carries the bounded Stop reason on protocol and control diagnostics", async () => {
  const fixture = await fixtureSupervisor("stop-reason")
  const info = spyOn(console, "info").mockImplementation(() => undefined)
  try {
    await fixture.supervisor.stopAudio("project-switch")
    const stopLogs = info.mock.calls
      .map(([prefix, line]) => prefix === "[native-audio-host-control]" ? line : "")
      .filter((line) => line.includes('"request":"stop"'))
    expect(stopLogs.some((line) => line.includes('"phase":"enqueue"') && line.includes('"reason":"project-switch"'))).toBeTrue()
    expect(stopLogs.some((line) => line.includes('"phase":"write"') && line.includes('"reason":"project-switch"'))).toBeTrue()
    expect(stopLogs.some((line) => line.includes('"phase":"ack"') && line.includes('"reason":"project-switch"'))).toBeTrue()
    await expect(fixture.supervisor.stopAudio("x".repeat(121))).rejects.toThrow("stop reason is invalid")
    await expect(fixture.supervisor.stopAudio("bad reason")).rejects.toThrow("stop reason is invalid")
    await expect(fixture.supervisor.stopAudio("bad\nreason")).rejects.toThrow("stop reason is invalid")
  } finally {
    info.mockRestore()
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("propagates bounded offline renderer stderr and exit diagnostics", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-"))
  const hostPath = path.join(directory, "host.mjs")
  await writeFile(hostPath, '#!/bin/sh\necho "offline child failed to start" >&2\nexit 1\n')
  await chmod(hostPath, 0o755)
  try {
    await expect(renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 2,
        totalFrames: 1,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        instrumentStates: new Uint8Array([1]),
        assets: [],
        transport: { epoch: 1, running: true, frame: 0, transitionId: 1n },
        schedule: new Uint8Array([1]),
      },
      signal: new AbortController().signal,
      onChunk: () => undefined,
    })).rejects.toThrow("offline child failed to start")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("filters only the proven offline telemetry frame types", () => {
  expect(isNativeOfflineTelemetryFrame(nativeAudioHostControlTypes.notification)).toBeTrue()
  expect(isNativeOfflineTelemetryFrame(nativeAudioHostControlTypes.meterBatch)).toBeTrue()
  expect(isNativeOfflineTelemetryFrame(nativeAudioHostControlTypes.scheduleProgress)).toBeTrue()
  expect(isNativeOfflineTelemetryFrame(nativeAudioHostControlTypes.spectrumFrame)).toBeFalse()
  expect(isNativeOfflineTelemetryFrame(nativeAudioHostControlTypes.ack)).toBeFalse()
  expect(isNativeOfflineTelemetryFrame(nativeAudioHostControlTypes.offlineComplete)).toBeFalse()
  expect(isNativeOfflineTelemetryFrame(nativeAudioHostControlTypes.offlineError)).toBeFalse()
})

test("latches an offline mailbox failure after a resolved frame", async () => {
  const mailbox = createNativeOfflineFrameMailbox()
  const frame = encodeNativeAudioHostControlFrame(nativeAudioHostControlTypes.ack) ?? Buffer.alloc(0)
  const originalError = new Error("original failure")

  mailbox.push(frame)
  await expect(mailbox.next()).resolves.toBe(frame)
  mailbox.fail(originalError)

  await expect(mailbox.next()).rejects.toBe(originalError)
})

test("latches an offline mailbox failure before its first read", async () => {
  const mailbox = createNativeOfflineFrameMailbox()
  const originalError = new Error("original failure")

  mailbox.fail(originalError)

  await expect(mailbox.next()).rejects.toBe(originalError)
})

test("rejects a pending offline mailbox read with the original failure", async () => {
  const mailbox = createNativeOfflineFrameMailbox()
  const originalError = new Error("original failure")
  const pending = mailbox.next()

  mailbox.fail(originalError)

  await expect(pending).rejects.toBe(originalError)
})

test("delivers offline mailbox frames before and after reads", async () => {
  const mailbox = createNativeOfflineFrameMailbox()
  const firstFrame = encodeNativeAudioHostControlFrame(nativeAudioHostControlTypes.ack) ?? Buffer.alloc(0)
  const secondFrame = encodeNativeAudioHostControlFrame(nativeAudioHostControlTypes.offlineComplete) ?? Buffer.alloc(0)

  mailbox.push(firstFrame)
  await expect(mailbox.next()).resolves.toBe(firstFrame)
  const pending = mailbox.next()
  mailbox.push(secondFrame)
  await expect(pending).resolves.toBe(secondFrame)
})

test("offline mailbox terminal failure wins over queued frames", async () => {
  const mailbox = createNativeOfflineFrameMailbox()
  const queuedFrame = encodeNativeAudioHostControlFrame(nativeAudioHostControlTypes.ack) ?? Buffer.alloc(0)
  const originalError = new Error("original failure")

  mailbox.push(queuedFrame)
  mailbox.fail(originalError)

  await expect(mailbox.next()).rejects.toBe(originalError)
})

test("preserves required and unknown response queue overflow protection at four frames", async () => {
  const mailbox = createNativeOfflineFrameMailbox()
  const frames = [
    nativeAudioHostControlTypes.ack,
    nativeAudioHostControlTypes.offlineComplete,
    nativeAudioHostControlTypes.offlineError,
    0xffff_ff00,
    nativeAudioHostControlTypes.hostCapabilities,
  ].map((type) => encodeNativeAudioHostControlFrame(type) ?? Buffer.alloc(0))

  expect(mailbox.push(frames[0])).toBeTrue()
  expect(mailbox.push(frames[1])).toBeTrue()
  expect(mailbox.push(frames[2])).toBeTrue()
  expect(mailbox.push(frames[3])).toBeTrue()
  expect(mailbox.push(frames[4])).toBeFalse()
  await expect(mailbox.next()).resolves.toBe(frames[0])
})

test("drops more than four schedule progress frames before the response mailbox", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-schedule-burst-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  await writeFile(hostPath, `#!/bin/sh\nMODE=offline-schedule-burst exec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    const chunks: number[] = []
    await renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 1,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: new AbortController().signal,
      onChunk: (chunk) => { chunks.push(chunk.startFrame) },
    })
    expect(chunks).toEqual([0])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("drops mixed proven offline telemetry while preserving acknowledgement and completion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-telemetry-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  await writeFile(hostPath, `#!/bin/sh\nMODE=offline-telemetry exec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    const chunks: number[] = []
    await renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 1,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: new AbortController().signal,
      onChunk: (chunk) => { chunks.push(chunk.startFrame) },
    })
    expect(chunks).toEqual([0])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("preserves the exact native offline error after telemetry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-error-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  await writeFile(hostPath, `#!/bin/sh\nMODE=offline-error-after-telemetry exec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    await expect(renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 1,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: new AbortController().signal,
      onChunk: () => undefined,
    })).rejects.toThrow("exact native offline error")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("consumes offline PCM bursts while waiting for the start acknowledgement", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-burst-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript.replaceAll('process.env.MODE === "offline-burst"', "true"))
  await writeFile(hostPath, `#!/bin/sh\nexec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    const chunks: number[] = []
    await renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 5,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: new AbortController().signal,
      onChunk: (chunk) => {
        chunks.push(chunk.startFrame)
      },
    })
    expect(chunks).toEqual([0, 1, 2, 3, 4])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("cancels mapped-page rendering without leaving a provider rejection unhandled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-mapped-cancel-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  await writeFile(hostPath, `#!/bin/sh\nexec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    const controller = new AbortController()
    const providerCalled = Promise.withResolvers<void>()
    const render = renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 1,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        mappedAssets: [{
          sessionAssetId: 1,
          sourceAssetKey: "source-a",
          frameCount: 1,
          sampleRateHz: 48_000,
          channelCount: 1,
          ranges: [{ startFrame: 0, frameCount: 1 }],
        }],
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: controller.signal,
      onChunk: () => undefined,
      onMappedPage: async () => {
        providerCalled.resolve()
        return new Promise<NativeHostMappedAssetPage>(() => {})
      },
    })
    await providerCalled.promise
    controller.abort()
    await expect(render).rejects.toMatchObject({ name: "AbortError" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps mapped offline page requests within the bounded provider page size", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-mapped-pages-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  await writeFile(hostPath, `#!/bin/sh\nMODE=offline-mapped-pages exec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    const totalFrames = 6 * 60 * 48_000
    const pageFrames = defaultDecodedAudioPageFrames
    const pages: Array<{ startFrame: number; frameCount: number }> = []
    await renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 1,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        mappedAssets: [{
          sessionAssetId: 1,
          sourceAssetKey: "asset:local-6-minute",
          frameCount: totalFrames,
          sampleRateHz: 48_000,
          channelCount: 1,
          ranges: [{ startFrame: 0, frameCount: totalFrames }],
        }],
        instrumentStates: new Uint8Array([1]),
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: new AbortController().signal,
      onChunk: () => undefined,
      onMappedPage: async (request) => {
        if (request.frameCount > pageFrames) {
          throw new Error('Native audio asset "asset:local-6-minute" page is invalid.')
        }
        pages.push({ startFrame: request.startFrame, frameCount: request.frameCount })
        return {
          sessionAssetId: request.asset.sessionAssetId,
          startFrame: request.startFrame,
          frameCount: request.frameCount,
          planarPcm: new Uint8Array(request.frameCount * request.asset.channelCount * Float32Array.BYTES_PER_ELEMENT),
        }
      },
    })
    expect(pages).toHaveLength(Math.ceil(totalFrames / pageFrames))
    expect(pages[0]).toEqual({ startFrame: 0, frameCount: pageFrames })
    expect(pages.at(-1)).toEqual({
      startFrame: totalFrames - (totalFrames % pageFrames),
      frameCount: totalFrames % pageFrames || pageFrames,
    })
    expect(pages.reduce((total, page) => total + page.frameCount, 0)).toBe(totalFrames)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("offline instrument provider failures, invalid pages and native errors never complete output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-instrument-errors-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  try {
    for (const failure of ['read', 'identity', 'coverage', 'native', 'schedule']) {
      await writeFile(hostPath, `#!/bin/sh\nMODE=${failure === 'native' ? 'offline-instrument-rejected' : failure === 'schedule' ? 'offline-schedule-rejected' : 'offline-mapped-pages'} exec ${process.execPath} ${scriptPath}\n`)
      await chmod(hostPath, 0o755)
      let chunks = 0
      const rendering = renderNativeOffline({
        hostPath,
        plan: {
          version: 1, sampleRateHz: 48_000, channelCount: 2, totalFrames: 1, blockFrames: 1,
          graph: new Uint8Array([1]), instrumentStates: new Uint8Array([1]), assets: [],
          mappedAssets: [{ sessionAssetId: 1, sourceAssetKey: 'instrument', frameCount: 8 * 48_000,
            sampleRateHz: 48_000, channelCount: 2, ranges: [{ startFrame: 0, frameCount: 8 * 48_000 }] }],
          transport: { epoch: 1, running: false, frame: 0 }, schedule: new Uint8Array([1]),
        },
        signal: new AbortController().signal, onChunk: () => { chunks += 1 },
        onMappedPage: async (request) => {
          if (failure === 'read') throw new Error('Instrument source could not be read.')
          return {
            sessionAssetId: failure === 'identity' ? 2 : 1, startFrame: request.startFrame,
            frameCount: request.frameCount,
            planarPcm: new Uint8Array(request.frameCount * 8 - (failure === 'coverage' ? 4 : 0)),
          }
        },
      })
      await expect(rendering).rejects.toThrow(failure === 'read' ? 'could not be read'
        : failure === 'native' ? 'Reload samples and retry'
        : failure === 'schedule' ? 'Native export could not schedule playback: instrument target is missing or its parameter is unsupported. Reload the project and retry; no export was completed.'
        : 'returned invalid audio')
      expect(chunks).toBe(0)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("serializes the offline PCM sink and keeps completion behind the final sink", async () => {
  const deferred = Promise.withResolvers<void>()
  const delivered: string[] = []
  const pauses: string[] = []
  const pump = createNativeOfflineStdoutPump({
    isPcmFrame: (frame) => frame.readUInt32BE(8) === 54,
    onFrame: (frame) => delivered.push(frame.readUInt32BE(8) === 55 ? "complete" : "other"),
    onPcmFrame: async (frame) => {
      delivered.push(`pcm-${frame.readBigUInt64BE(16).toString()}`)
      if (frame.readBigUInt64BE(16) === 0n) await deferred.promise
    },
    onError: (error) => { throw error },
    pause: () => pauses.push("pause"),
    resume: () => pauses.push("resume"),
  })
  const pcmFrame = (startFrame: number) => {
    const payload = Buffer.alloc(20)
    payload.writeBigUInt64BE(BigInt(startFrame), 0)
    payload.writeUInt32BE(1, 8)
    payload.writeUInt32BE(1, 12)
    payload.writeFloatBE(startFrame + 0.25, 16)
    return encodeNativeAudioHostControlFrame(54, payload) ?? Buffer.alloc(0)
  }
  pump.push(Buffer.concat([
    pcmFrame(0),
    pcmFrame(1),
    encodeNativeAudioHostControlFrame(55) ?? Buffer.alloc(0),
  ]))
  await Promise.resolve()
  expect(delivered).toEqual(["pcm-0"])
  expect(pump.sinkBusy()).toBeTrue()
  deferred.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(delivered).toEqual(["pcm-0", "pcm-1", "complete"])
  expect(pauses).toEqual(["pause", "pause", "resume"])
  pump.stop()
})

test("preserves split frames and partial following PCM while one sink is pending", async () => {
  const deferred = Promise.withResolvers<void>()
  const delivered: number[] = []
  const pump = createNativeOfflineStdoutPump({
    isPcmFrame: (frame) => frame.readUInt32BE(8) === 54,
    onFrame: () => delivered.push(99),
    onPcmFrame: async (frame) => {
      const startFrame = Number(frame.readBigUInt64BE(16))
      delivered.push(startFrame)
      if (startFrame === 0) await deferred.promise
    },
    onError: (error) => { throw error },
    pause: () => undefined,
    resume: () => undefined,
  })
  const pcmFrame = (startFrame: number, frameCount: number) => {
    const payload = Buffer.alloc(16 + frameCount * 4)
    payload.writeBigUInt64BE(BigInt(startFrame), 0)
    payload.writeUInt32BE(frameCount, 8)
    payload.writeUInt32BE(1, 12)
    payload.fill(startFrame, 16)
    return encodeNativeAudioHostControlFrame(54, payload) ?? Buffer.alloc(0)
  }
  const first = pcmFrame(0, 32)
  const second = pcmFrame(32, 1_024)
  const completion = encodeNativeAudioHostControlFrame(55) ?? Buffer.alloc(0)
  pump.push(Buffer.concat([first, second.subarray(0, 2_600)]))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(delivered).toEqual([0])
  expect(pump.bufferedBytes()).toBe(2_600)
  deferred.resolve()
  await new Promise((resolve) => setTimeout(resolve, 10))
  pump.push(Buffer.concat([second.subarray(2_600), completion]))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(delivered).toEqual([0, 32, 99])
  expect(pump.bufferedBytes()).toBe(0)
})

test("fails and stops when the asynchronous offline sink rejects", async () => {
  const deferred = Promise.withResolvers<Error>()
  const pump = createNativeOfflineStdoutPump({
    isPcmFrame: (frame) => frame.readUInt32BE(8) === 54,
    onFrame: () => undefined,
    onPcmFrame: async () => { throw new Error("sink failed") },
    onError: (error) => deferred.resolve(error),
    pause: () => undefined,
    resume: () => undefined,
  })
  const payload = Buffer.alloc(20)
  payload.writeUInt32BE(1, 8)
  payload.writeUInt32BE(1, 12)
  pump.push(encodeNativeAudioHostControlFrame(54, payload) ?? Buffer.alloc(0))
  await expect(deferred.promise).resolves.toThrow("sink failed")
  expect(pump.sinkBusy()).toBeFalse()
  expect(pump.bufferedBytes()).toBe(0)
})

test("does not resume or process buffered PCM after abort stops the render", async () => {
  const deferred = Promise.withResolvers<void>()
  const delivered: number[] = []
  const pump = createNativeOfflineStdoutPump({
    isPcmFrame: (frame) => frame.readUInt32BE(8) === 54,
    onFrame: () => undefined,
    onPcmFrame: async (frame) => {
      delivered.push(Number(frame.readBigUInt64BE(16)))
      await deferred.promise
    },
    onError: () => undefined,
    pause: () => undefined,
    resume: () => { delivered.push(100) },
  })
  const payload = Buffer.alloc(20)
  payload.writeUInt32BE(1, 8)
  payload.writeUInt32BE(1, 12)
  const first = encodeNativeAudioHostControlFrame(54, payload) ?? Buffer.alloc(0)
  pump.push(Buffer.concat([first, first]))
  pump.stop()
  deferred.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(delivered).toEqual([0])
})

test("moves 128 MiB through one bounded asynchronous sink without loss or duplication", async () => {
  const frameCount = 128 * 1024 * 1024 / Float32Array.BYTES_PER_ELEMENT
  const framesPerChunk = 131_072
  const expectedChunks = frameCount / framesPerChunk
  let sinkInFlight = 0
  let maximumSinkInFlight = 0
  let renderedFrames = 0
  let renderedBytes = 0
  let complete = false
  const pump = createNativeOfflineStdoutPump({
    isPcmFrame: (frame) => frame.readUInt32BE(8) === 54,
    onFrame: (frame) => {
      expect(frame.readUInt32BE(8)).toBe(55)
      complete = true
    },
    onPcmFrame: async (frame) => {
      sinkInFlight += 1
      maximumSinkInFlight = Math.max(maximumSinkInFlight, sinkInFlight)
      const startFrame = Number(frame.readBigUInt64BE(16))
      const count = frame.readUInt32BE(24)
      expect(startFrame).toBe(renderedFrames)
      expect(count).toBe(framesPerChunk)
      renderedFrames += count
      renderedBytes += count * Float32Array.BYTES_PER_ELEMENT
      sinkInFlight -= 1
    },
    onError: (error) => { throw error },
    pause: () => undefined,
    resume: () => undefined,
  })
  for (let index = 0; index < expectedChunks; index += 1) {
    const payload = Buffer.alloc(16 + framesPerChunk * Float32Array.BYTES_PER_ELEMENT)
    payload.writeBigUInt64BE(BigInt(index * framesPerChunk), 0)
    payload.writeUInt32BE(framesPerChunk, 8)
    payload.writeUInt32BE(1, 12)
    payload.fill(index & 0xff, 16)
    pump.push(encodeNativeAudioHostControlFrame(54, payload) ?? Buffer.alloc(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  pump.push(encodeNativeAudioHostControlFrame(55) ?? Buffer.alloc(0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(renderedFrames).toBe(frameCount)
  expect(renderedBytes).toBe(128 * 1024 * 1024)
  expect(maximumSinkInFlight).toBe(1)
  expect(complete).toBeTrue()
  expect(pump.maximumBufferedBytes()).toBeLessThanOrEqual(1_048_576)
})

test("tracks only the exact active offline PCM acknowledgement", async () => {
  const tracker = createOfflinePcmAckTracker()
  const pending = tracker.begin({ jobId: "job-1", sequence: 1, endFrame: 512 })
  expect(() => tracker.begin({ jobId: "job-1", sequence: 2, endFrame: 1_024 })).toThrow("already pending")
  expect(tracker.acknowledge({ jobId: "job-2", sequence: 1, endFrame: 512 })).toBeFalse()
  expect(tracker.acknowledge({ jobId: "job-1", sequence: 2, endFrame: 512 })).toBeFalse()
  expect(tracker.acknowledge({ jobId: "job-1", sequence: 1, endFrame: 513 })).toBeFalse()
  expect(tracker.hasPending()).toBeTrue()
  expect(tracker.acknowledge({ jobId: "job-1", sequence: 1, endFrame: 512 })).toBeTrue()
  await expect(pending).resolves.toBeUndefined()
  expect(tracker.hasPending()).toBeFalse()
})

test("captures offline PCM acknowledgement before listener mutation", async () => {
  const tracker = createOfflinePcmAckTracker()
  const pending = tracker.begin({ jobId: "job-1", sequence: 1, endFrame: 512 })
  let sent: { jobId: string; sequence: number; endFrame: number } | undefined
  await deliverOfflinePcmChunk(
    "job-1",
    1,
    { startFrame: 256, frameCount: 256, channelCount: 1, planes: [new Float32Array(256)] },
    async (chunk) => {
      chunk.startFrame = 0
      chunk.frameCount = 1
    },
    (ack) => {
      sent = ack
      expect(tracker.acknowledge(ack)).toBeTrue()
    },
  )
  await expect(pending).resolves.toBeUndefined()
  expect(sent).toEqual({ jobId: "job-1", sequence: 1, endFrame: 512 })
})

test("cancels a pending offline PCM acknowledgement without allowing stale release", async () => {
  const tracker = createOfflinePcmAckTracker()
  const pending = tracker.begin({ jobId: "job-1", sequence: 1, endFrame: 512 })
  tracker.cancel(new DOMException("canceled", "AbortError"))
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(tracker.acknowledge({ jobId: "job-1", sequence: 1, endFrame: 512 })).toBeFalse()
  expect(tracker.hasPending()).toBeFalse()
})

test("allows offline completion after the aggregate deadline while valid PCM continues", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-periodic-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  await writeFile(hostPath, `#!/bin/sh\nMODE=offline-periodic exec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    const chunks: number[] = []
    let stageCount = 0
    const schedule = (callback: () => void, delayMs: number) => {
      if (delayMs !== 10_000) return setTimeout(callback, delayMs)
      stageCount += 1
      return setTimeout(callback, stageCount >= 7 ? 50 : 500)
    }
    await renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 10,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: new AbortController().signal,
      onChunk: (chunk) => {
        chunks.push(chunk.startFrame)
      },
      completionInactivityMs: 50,
      schedule,
    })
    expect(chunks).toEqual([...Array(10).keys()])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("times out stalled offline completion with the completion stage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-stalled-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  await writeFile(hostPath, `#!/bin/sh\nMODE=offline-stalled exec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    await expect(renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 1,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: new AbortController().signal,
      onChunk: () => undefined,
      completionInactivityMs: 20,
    })).rejects.toThrow("timed out during offline completion")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("cleans the offline completion watchdog on abort", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-offline-render-abort-"))
  const hostPath = path.join(directory, "host.mjs")
  const scriptPath = path.join(directory, "fixture.mjs")
  await writeFile(scriptPath, hostScript)
  await writeFile(hostPath, `#!/bin/sh\nMODE=offline-stalled exec ${process.execPath} ${scriptPath}\n`)
  await chmod(hostPath, 0o755)
  try {
    const controller = new AbortController()
    const completionWatchdog = Promise.withResolvers<void>()
    const canceled: ReturnType<typeof setTimeout>[] = []
    let completionTimer: ReturnType<typeof setTimeout> | undefined
    const schedule = (callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs === 20 ? 1_000 : delayMs)
      if (delayMs === 20) {
        completionTimer = timer
        completionWatchdog.resolve()
      }
      return timer
    }
    const cancelScheduled = (timer: ReturnType<typeof setTimeout>) => {
      canceled.push(timer)
      clearTimeout(timer)
    }
    const render = renderNativeOffline({
      hostPath,
      plan: {
        version: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
        totalFrames: 1,
        blockFrames: 1,
        graph: new Uint8Array([1]),
        assets: [],
        transport: { epoch: 1, running: false, frame: 0 },
        schedule: new Uint8Array([1]),
      },
      signal: controller.signal,
      onChunk: () => undefined,
      completionInactivityMs: 20,
      schedule,
      cancelScheduled,
    })
    await completionWatchdog.promise
    controller.abort()
    await expect(render).rejects.toMatchObject({ name: "AbortError" })
    expect(completionTimer).toBeDefined()
    expect(completionTimer === undefined ? false : canceled.includes(completionTimer)).toBeTrue()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

type ScheduleProgressMode =
  | "schedule-capacity" | "schedule-latency" | "schedule-resolution" | "schedule-resolution-none"
  | "schedule-bad-length" | "schedule-bad-length-104" | "schedule-bad-length-120" | "schedule-bad-reserved"
type PatchStatusMode =
  | "patch-applied" | "patch-claimed" | "patch-refused-pending" | "patch-refused-stage" | "patch-bad-claim-token"
  | "patch-bad-refusal" | "patch-bad-core" | "patch-bad-length"
const fixtureSupervisor = async (
  mode?: ScheduleProgressMode | PatchStatusMode | "device-loss" | "transition-pending" | "offline-instrument-rejected" | "spool-failed-finish" | "spool-slow-stop" | "spool-bad-pool" | "spool-bad-meter" | "spool-bad-active" | "spool-bad-identity" | "spool-bad-totals" | "spool-reserved" | "spool" | "incompatible" | "loss" | "wrong-ack" | "rejected-ack" | "unavailable-ack" | "bad-ack-status" | "state-rejected" | "state-malformed" | "state-mismatch" | "notification" | "meter" | "schedule" | "editor-interaction" | "parameter-edit" | "silent" | "editor-anchor" | "editor-queued" | "ignore-teardown" | "rollback-rejected" | "begin-delayed" | "commit-delayed" | "close-on-configure" | "stop-reason",
  onSpawn?: () => void,
  supervisorOptions?: NativeAudioHostSupervisorOptions,
  onChild?: (child: ChildProcessWithoutNullStreams) => void,
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-audio-host-"))
  const executable = path.join(directory, "host.mjs")
  await writeFile(executable, hostScript)
  return {
    supervisor: createNativeAudioHostSupervisor(executable, (hostPath) => {
      onSpawn?.()
      const child = spawn(
        process.execPath,
        [hostPath],
        { env: { ...process.env, MODE: mode ? mode : undefined }, stdio: ["pipe", "pipe", "pipe"] },
      )
      onChild?.(child)
      return child
    }, supervisorOptions),
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

const vstAttachment = (instanceId: string): ResolvedVst3Attachment => ({
  graphNodeId: 17n,
  stageIndex: 0,
  instanceId,
  classId: "0123456789abcdef0123456789abcdef",
  vendorId: "Example Vendor",
  canonicalBundlePath: "/private/catalog/Example.vst3",
  canonicalExecutablePath: "/private/catalog/Example.vst3/Contents/MacOS/Example",
  bundleFingerprint: "b".repeat(64),
  binaryFingerprint: "a".repeat(64),
  scannerProtocolVersion: 2,
  role: "effect",
  inputLayout: "stereo",
  outputLayout: "stereo",
  declaredLatencyFrames: 32,
  transportLatencyFrames: 512,
  workerTransport: {
    slotCount: 2,
    maximumFrames: 512,
    inputChannels: 2,
    outputChannels: 2,
    maximumEventsPerBlock: 128,
  },
  initialParameterValues: [{ id: 48, value: 0.592999 }],
})

test("uses an explicit development path and a fixed packaged CoreAudio host name", () => {
  expect(packagedAudioHostPath("/Resources", false, "/tmp/audio-host")).toBe("/tmp/audio-host")
  expect(packagedAudioHostPath("/Resources", true, "/tmp/audio-host")).toBe("/Resources/daw-audio-host-macos")
})

test("reports an unavailable CoreAudio host without launching a device", async () => {
  await expect(runAudioHostDiagnostic("/not/a/daw-audio-host-macos")).resolves.toEqual({
    ok: false,
    error: "The native audio host is unavailable.",
  })
})

test("planned suspend invalidates the handshake without reporting host loss", async () => {
  const fixture = await fixtureSupervisor()
  let lossCount = 0
  const removeLoss = fixture.supervisor.onLoss(() => {
    lossCount += 1
  })
  const start = fixture.supervisor.start()
  await fixture.supervisor.suspend()
  await expect(start).rejects.toThrow("startup was cancelled")
  expect(fixture.supervisor.status().running).toBeFalse()
  expect(lossCount).toBe(0)
  fixture.supervisor.resume()
  removeLoss()
  await fixture.supervisor.teardown()
  await fixture.dispose()
})

test("normal teardown and planned suspend retain parser and child until native Finish terminal", async () => {
  for (const shutdown of ["teardown", "suspend"]) {
    let child: ChildProcessWithoutNullStreams | undefined
    const fixture = await fixtureSupervisor("spool", undefined, undefined, (value) => { child = value })
    try {
      await fixture.supervisor.configureRecording({
        deviceUid: "coreaudio:fixture-input", generation: 1, sessionId: 1n, channelCount: 2,
        inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false,
      }, { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })
      await fixture.supervisor.startRecording()
      await fixture.supervisor.stopRecording()
      expect(fixture.supervisor.recordingFinalizationPending()).toBeTrue()
      let settled = false
      const stopping = (shutdown === "teardown" ? fixture.supervisor.teardown() : fixture.supervisor.suspend())
        .then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBeFalse()
      expect(child?.killed).toBeFalse()
      expect(fixture.supervisor.status().running).toBeTrue()
      child?.kill("SIGUSR1")
      await stopping
      expect(fixture.supervisor.recordingFinalizationPending()).toBeFalse()
    } finally {
      child?.kill("SIGKILL")
      await fixture.supervisor.teardown()
      await fixture.dispose()
    }
  }
})

test("the control timeout cannot kill persistence behind a blocked Stop ACK", async () => {
  let child: ChildProcessWithoutNullStreams | undefined
  const fixture = await fixtureSupervisor("spool-slow-stop", undefined, undefined, (value) => { child = value })
  try {
    await fixture.supervisor.configureRecording({
      deviceUid: "coreaudio:fixture-input", generation: 1, sessionId: 1n, channelCount: 2,
      inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false,
    }, { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })
    await fixture.supervisor.startRecording()
    const stop = fixture.supervisor.stopRecording()
    // Deliberately cross the existing 2s control watchdog; this is not a
    // production drain timer or a persistence timeout.
    await Bun.sleep(2200)
    expect(child?.killed).toBeFalse()
    expect(fixture.supervisor.recordingFinalizationPending()).toBeTrue()
    child?.kill("SIGUSR1")
    await stop
    await fixture.supervisor.waitForRecordingFinish()
  } finally {
    child?.kill("SIGKILL")
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})
test("resume waits for pending Finish suspend and starts a fresh host afterwards", async () => {
  let child: ChildProcessWithoutNullStreams | undefined
  const fixture = await fixtureSupervisor("spool", undefined, undefined, (value) => { child = value })
  try {
    await fixture.supervisor.configureRecording({
      deviceUid: "coreaudio:fixture-input", generation: 1, sessionId: 1n, channelCount: 2,
      inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false,
    }, { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })
    await fixture.supervisor.startRecording()
    await fixture.supervisor.stopRecording()
    const oldPid = child?.pid
    const suspend = fixture.supervisor.suspend()
    const resume = fixture.supervisor.resume()
    child?.kill("SIGUSR1")
    await Promise.all([suspend, resume])
    await fixture.supervisor.start()
    expect(child?.pid).not.toBe(oldPid)
  } finally {
    child?.kill("SIGKILL")
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})
test("rejects malformed native final status and reserved PCM frames instead of finalizing", async () => {
  const modes: NonNullable<Parameters<typeof fixtureSupervisor>[0]>[] =
    ["spool-bad-pool", "spool-bad-meter", "spool-bad-active", "spool-bad-identity", "spool-bad-totals", "spool-reserved"]
  for (const mode of modes) {
    let child: ChildProcessWithoutNullStreams | undefined
    const fixture = await fixtureSupervisor(mode, undefined, undefined, (value) => { child = value })
    try {
      await fixture.supervisor.configureRecording({
        deviceUid: "coreaudio:fixture-input", generation: 1, sessionId: 1n, channelCount: 2,
        inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false,
      }, { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })
      await fixture.supervisor.startRecording()
      await fixture.supervisor.stopRecording()
      const finishing = fixture.supervisor.waitForRecordingOutcome()
      child?.kill(mode === "spool-reserved" ? "SIGUSR2" : "SIGUSR1")
      await expect(finishing).rejects.toThrow()
    } finally {
      child?.kill("SIGKILL")
      await fixture.supervisor.teardown()
      await fixture.dispose()
    }
  }
})
test("actual native loss interrupts finalization rather than fabricating successful persistence", async () => {
  let child: ChildProcessWithoutNullStreams | undefined
  const fixture = await fixtureSupervisor("spool", undefined, undefined, (value) => { child = value })
  try {
    await fixture.supervisor.configureRecording({
      deviceUid: "coreaudio:fixture-input", generation: 1, sessionId: 1n, channelCount: 2,
      inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false,
    }, { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })
    await fixture.supervisor.startRecording()
    await fixture.supervisor.stopRecording()
    const waiting = fixture.supervisor.waitForRecordingOutcome()
    child?.kill("SIGKILL")
    await expect(waiting).rejects.toThrow()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("starts a fresh native host after suspend and resume", async () => {
  let spawnCount = 0
  const fixture = await fixtureSupervisor(undefined, () => {
    spawnCount += 1
  })
  try {
    await fixture.supervisor.start()
    await fixture.supervisor.suspend()
    fixture.supervisor.resume()
    await fixture.supervisor.start()
    expect(spawnCount).toBe(2)
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("starts configuration identity at zero for each respawned host generation", () => {
  const first = nativeHostConfigurationIdentityFor(undefined, { pid: 123, generation: 7 })
  expect(first).toEqual({ pid: 123, generation: 7, configurationGeneration: 0 })
  const configured = first && { ...first, configurationGeneration: 4 }
  expect(nativeHostConfigurationIdentityFor(configured, { pid: 123, generation: 7 })).toBe(configured)
  expect(nativeHostConfigurationIdentityFor(configured, { pid: 124, generation: 8 })).toEqual({
    pid: 124, generation: 8, configurationGeneration: 0,
  })
})

test("waits for bounded old-host termination before spawning after resume", async () => {
  let spawnCount = 0
  const fixture = await fixtureSupervisor("ignore-teardown", () => {
    spawnCount += 1
  })
  try {
    await fixture.supervisor.start()
    const suspend = fixture.supervisor.suspend()
    const resume = fixture.supervisor.resume()
    const nextStart = fixture.supervisor.start()
    expect(spawnCount).toBe(1)
    await suspend
    await resume
    await nextStart
    expect(spawnCount).toBe(2)
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("teardown cancels pending resume recovery without respawning", async () => {
  let spawnCount = 0
  const fixture = await fixtureSupervisor("ignore-teardown", () => {
    spawnCount += 1
  })
  try {
    await fixture.supervisor.start()
    const suspend = fixture.supervisor.suspend()
    const resume = fixture.supervisor.resume()
    const teardown = fixture.supervisor.teardown()
    await Promise.all([suspend, resume, teardown])
    await expect(fixture.supervisor.start()).rejects.toThrow("suspended")
    expect(spawnCount).toBe(1)
  } finally {
    await fixture.dispose()
  }
})

test("fails recovery when SIGKILL does not produce a close event", async () => {
  let oldChild: ChildProcessWithoutNullStreams | undefined
  let spawnCount = 0
  const fixture = await fixtureSupervisor(
    "ignore-teardown",
    () => {
      spawnCount += 1
    },
    {
      gracefulTerminationMs: 5,
      sigtermTerminationMs: 5,
      sigkillObservationMs: 10,
      kill: (child, signal) => signal === "SIGKILL" || child.kill(signal),
    },
    (child) => {
      if (spawnCount === 1) oldChild = child
    },
  )
  try {
    await fixture.supervisor.start()
    const suspend = fixture.supervisor.suspend()
    const resume = fixture.supervisor.resume()
    await expect(suspend).rejects.toThrow("did not close after SIGKILL")
    await expect(resume).rejects.toThrow("did not close after SIGKILL")
    expect(spawnCount).toBe(1)
    oldChild?.kill("SIGKILL")
  } finally {
    await fixture.dispose()
  }
})

test("serializes suspend-resume-suspend without reviving the old child", async () => {
  const fixture = await fixtureSupervisor("ignore-teardown")
  try {
    await fixture.supervisor.start()
    const firstSuspend = fixture.supervisor.suspend()
    const firstResume = fixture.supervisor.resume()
    const secondSuspend = fixture.supervisor.suspend()
    await Promise.all([firstSuspend, firstResume, secondSuspend])
    await expect(fixture.supervisor.start()).rejects.toThrow("suspended")
    await fixture.supervisor.resume()
    await expect(fixture.supervisor.start()).resolves.toBeDefined()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("rejects a native host with incompatible contract identity before use", async () => {
  const closed = Promise.withResolvers<void>()
  const errors = spyOn(console, "error").mockImplementation(() => undefined)
  const fixture = await fixtureSupervisor("incompatible", undefined, undefined, (child) => {
    child.once("close", () => closed.resolve())
  })
  try {
    await expect(fixture.supervisor.start()).rejects.toThrow("incompatible protocol response")
    await closed.promise
    const exit = errors.mock.calls.find(([label]) => label === "[native-vst3] native audio host closed")
    expect(exit?.[1]).toContain('"terminationReason":"supervisor-terminated: The native audio host returned an incompatible protocol response."')
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
    errors.mockRestore()
  }
})

test("shares one native host startup across concurrent callers", async () => {
  let spawns = 0
  const fixture = await fixtureSupervisor(undefined, () => {
    spawns += 1
  })
  try {
    const first = fixture.supervisor.start()
    const second = fixture.supervisor.start()
    expect(second).toBe(first)
    const [firstHello, secondHello] = await Promise.all([first, second])
    expect(secondHello).toEqual(firstHello)
    expect(spawns).toBe(1)
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("teardown cancels an in-flight native host handshake without reporting loss", async () => {
  const spawned = Promise.withResolvers<void>()
  const fixture = await fixtureSupervisor("silent", () => spawned.resolve())
  try {
    const losses: string[] = []
    fixture.supervisor.onLoss((error) => losses.push(error.message))
    const starting = fixture.supervisor.start()
    await spawned.promise
    const firstTeardown = fixture.supervisor.teardown()
    const secondTeardown = fixture.supervisor.teardown()
    const restartedDuringTeardown = fixture.supervisor.start()
    expect(secondTeardown).toBe(firstTeardown)

    await expect(firstTeardown).resolves.toBeUndefined()
    await expect(starting).rejects.toThrow("native audio host is tearing down")
    await expect(restartedDuringTeardown).rejects.toThrow("native audio host is tearing down")
    expect(fixture.supervisor.status().running).toBeFalse()
    expect(losses).toEqual([])
  } finally {
    await fixture.dispose()
  }
})

test("serializes scoped native host transactions and remains usable after rollback", async () => {
  const fixture = await fixtureSupervisor()
  try {
    const calls: string[] = []
    const firstAttached = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const first = fixture.supervisor.runTransaction(async (transaction) => {
      calls.push("first")
      await transaction.attachVst(vstAttachment("11111111-1111-4111-8111-111111111111"))
      firstAttached.resolve()
      await releaseFirst.promise
    })
    const second = fixture.supervisor.runTransaction(async (transaction) => {
      calls.push("second")
      await transaction.attachVst(vstAttachment("22222222-2222-4222-8222-222222222222"))
    })

    await firstAttached.promise
    await Promise.resolve()
    expect(calls).toEqual(["first"])
    releaseFirst.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(calls).toEqual(["first", "second"])

    await expect(fixture.supervisor.runTransaction(async (transaction) => {
      await transaction.attachVst(vstAttachment("33333333-3333-4333-8333-333333333333"))
      throw new Error("transaction failed")
    })).rejects.toThrow("transaction failed")
    await expect(fixture.supervisor.runTransaction(async (transaction) => {
      await transaction.attachVst(vstAttachment("44444444-4444-4444-8444-444444444444"))
    })).resolves.toBeUndefined()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("manual transaction invalidation is a no-op without spawning a host", async () => {
  let spawnCount = 0
  const fixture = await fixtureSupervisor(undefined, () => {
    spawnCount += 1
  })
  try {
    await fixture.supervisor.invalidateManualTransaction()
    expect(spawnCount).toBe(0)
    expect(fixture.supervisor.transactionOpen()).toBeFalse()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("manual invalidation after host loss does not respawn", async () => {
  let spawnCount = 0
  let child: ChildProcessWithoutNullStreams | undefined
  const fixture = await fixtureSupervisor(undefined, () => {
    spawnCount += 1
  }, undefined, (current) => {
    child = current
  })
  try {
    const lost = new Promise<void>((resolve) => fixture.supervisor.onLoss(() => resolve()))
    await fixture.supervisor.start()
    await fixture.supervisor.beginTransaction()
    child?.kill("SIGKILL")
    await lost
    await fixture.supervisor.invalidateManualTransaction()
    expect(spawnCount).toBe(1)
    expect(fixture.supervisor.transactionOpen()).toBeFalse()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("invalidates an open manual transaction and allows a fresh transaction", async () => {
  const fixture = await fixtureSupervisor()
  try {
    await fixture.supervisor.start()
    const first = await fixture.supervisor.beginTransaction()
    await fixture.supervisor.invalidateManualTransaction()
    expect(fixture.supervisor.transactionOpen()).toBeFalse()
    await expect(fixture.supervisor.commitTransaction(first)).rejects.toThrow("stale")
    const second = await fixture.supervisor.beginTransaction()
    await fixture.supervisor.rollbackTransaction(second)
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("rollback failure still releases manual transaction ownership", async () => {
  const fixture = await fixtureSupervisor("rollback-rejected")
  try {
    await fixture.supervisor.start()
    await fixture.supervisor.beginTransaction()
    await fixture.supervisor.invalidateManualTransaction()
    expect(fixture.supervisor.transactionOpen()).toBeFalse()
    const next = await fixture.supervisor.beginTransaction()
    await fixture.supervisor.commitTransaction(next)
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("invalidating an in-flight begin cannot publish a token", async () => {
  const fixture = await fixtureSupervisor("begin-delayed")
  try {
    await fixture.supervisor.start()
    const beginning = fixture.supervisor.beginTransaction()
    await Promise.resolve()
    await fixture.supervisor.invalidateManualTransaction()
    await expect(beginning).rejects.toThrow("cancelled")
    expect(fixture.supervisor.transactionOpen()).toBeFalse()
    const next = await fixture.supervisor.beginTransaction()
    await fixture.supervisor.rollbackTransaction(next)
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("invalidating an in-flight commit cannot publish a committed renderer state", async () => {
  const fixture = await fixtureSupervisor("commit-delayed")
  try {
    await fixture.supervisor.start()
    const token = await fixture.supervisor.beginTransaction()
    const committing = fixture.supervisor.commitTransaction(token)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await fixture.supervisor.invalidateManualTransaction()
    await expect(committing).rejects.toThrow("cancelled")
    expect(fixture.supervisor.transactionOpen()).toBeFalse()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("manual invalidation does not interrupt an internal transaction", async () => {
  const fixture = await fixtureSupervisor()
  try {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const transaction = fixture.supervisor.runTransaction(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    await fixture.supervisor.invalidateManualTransaction()
    expect(fixture.supervisor.transactionOpen()).toBeTrue()
    release.resolve()
    await expect(transaction).resolves.toBeUndefined()
    expect(fixture.supervisor.transactionOpen()).toBeFalse()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("correlates acknowledgements to the requested native session operation", async () => {
  const fixture = await fixtureSupervisor("wrong-ack")
  try {
    await fixture.supervisor.start()
    await expect(fixture.supervisor.configure({
      deviceId: "coreaudio:fixture",
      sampleRateHz: 48_000,
      maxFramesPerBlock: 512,
      channelCount: 2,
      revision: 1,
    })).rejects.toThrow("native audio host rejected a control request")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("keeps the host alive after a recoverable negative acknowledgement", async () => {
  const fixture = await fixtureSupervisor("rejected-ack")
  try {
    const losses: string[] = []
    fixture.supervisor.onLoss((error) => losses.push(error.message))
    await fixture.supervisor.start()
    const rejection = fixture.supervisor.configure({
      deviceId: "coreaudio:fixture",
      sampleRateHz: 48_000,
      maxFramesPerBlock: 512,
      channelCount: 2,
      revision: 1,
    })
    await expect(rejection).rejects.toBeInstanceOf(NativeAudioHostCommandError)
    await expect(rejection).rejects.toMatchObject({
      requestType: nativeAudioHostControlTypes.deviceConfigure,
      requestName: "deviceConfigure",
    })
    expect(fixture.supervisor.status().running).toBeTrue()
    expect(losses).toEqual([])
    await expect(fixture.supervisor.configure({
      deviceId: "coreaudio:fixture",
      sampleRateHz: 48_000,
      maxFramesPerBlock: 512,
      channelCount: 2,
      revision: 1,
    })).resolves.toBeUndefined()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("captures VST state and correlates the response identity", async () => {
  const fixture = await fixtureSupervisor()
  try {
    await fixture.supervisor.start()
    await expect(fixture.supervisor.getVstState("11111111-1111-4111-8111-111111111111")).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      sha256: "a".repeat(64),
    })
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("preserves live instrument preparation rejection text without losing the host", async () => {
  const fixture = await fixtureSupervisor("offline-instrument-rejected")
  const supervisor = fixture.supervisor
  try {
    await supervisor.start()
    await expect(supervisor.configureInstrumentStates(new Uint8Array(4))).rejects.toMatchObject({
      requestName: "instrumentStates",
      message: "Instrument sample upload is incomplete. Reload samples and retry.",
      recoverable: true,
    })
    await expect(supervisor.configure({
      deviceId: "coreaudio:fixture", sampleRateHz: 48_000,
      maxFramesPerBlock: 512, channelCount: 2, revision: 1,
    })).resolves.toBeUndefined()
  } finally {
    await supervisor.teardown()
    await fixture.dispose()
  }
})

test("keeps the host usable after VST state rejection or malformed response", async () => {
  for (const mode of ["state-rejected", "state-malformed", "state-mismatch"] as const) {
    const fixture = await fixtureSupervisor(mode)
    try {
      await fixture.supervisor.start()
      await expect(fixture.supervisor.getVstState("11111111-1111-4111-8111-111111111111"))
        .rejects.toBeInstanceOf(NativeAudioHostCommandError)
      expect(fixture.supervisor.status().running).toBeTrue()
      await expect(fixture.supervisor.configure({
        deviceId: "coreaudio:fixture",
        sampleRateHz: 48_000,
        maxFramesPerBlock: 512,
        channelCount: 2,
        revision: 1,
      })).resolves.toBeUndefined()
    } finally {
      await fixture.supervisor.teardown()
      await fixture.dispose()
    }
  }
})

test("round-trips a bounded native VST editor command and signed anchor", async () => {
  expect(nativeVstEditorOwnershipProbe("11111111-1111-4111-8111-111111111111")).toEqual({
    instanceId: "11111111-1111-4111-8111-111111111111",
    command: "status",
  })
  const fixture = await fixtureSupervisor("editor-anchor")
  try {
    await fixture.supervisor.start()
    await expect(fixture.supervisor.executeVstEditorCommand({
      instanceId: "11111111-1111-4111-8111-111111111111",
      command: "open",
      width: 640,
      height: 480,
      anchor: { x: -320, y: -240 },
    })).resolves.toEqual({
      success: true,
      owned: true,
      supported: true,
      open: true,
      width: 640,
      height: 480,
    })
    await expect(fixture.supervisor.executeVstEditorCommand({
      instanceId: "11111111-1111-4111-8111-111111111111",
      command: "focus",
      anchor: { x: -320, y: -240 },
    })).resolves.toEqual({
      success: true,
      owned: true,
      supported: true,
      open: true,
      width: 640,
      height: 480,
    })
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("queues editor commands behind an in-flight native host request", async () => {
  const fixture = await fixtureSupervisor("editor-queued")
  try {
    await fixture.supervisor.start()
    const configure = fixture.supervisor.configure({
      deviceId: "coreaudio:fixture",
      sampleRateHz: 48_000,
      maxFramesPerBlock: 512,
      channelCount: 2,
      revision: 1,
    })
    const editor = fixture.supervisor.executeVstEditorCommand({
      instanceId: "11111111-1111-4111-8111-111111111111",
      command: "open",
      width: 640,
      height: 480,
    })
    await expect(Promise.all([configure, editor])).resolves.toEqual([
      undefined,
      {
        success: true,
        owned: true,
        supported: true,
        open: true,
        width: 640,
        height: 480,
      },
    ])
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("starts diagnostic workers without using the playback start request", async () => {
  const fixture = await fixtureSupervisor()
  try {
    await expect(fixture.supervisor.startDiagnosticAudio()).resolves.toBeUndefined()
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("notifies subscribers when the native host is lost", async () => {
  const fixture = await fixtureSupervisor("loss")
  try {
    const lost = new Promise<string>((resolve) => {
      fixture.supervisor.onLoss((error) => resolve(error.message))
    })
    await fixture.supervisor.start()
    await expect(lost).resolves.toBe("The native audio host stopped.")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("names the pending request when the native host closes", async () => {
  const fixture = await fixtureSupervisor("close-on-configure")
  try {
    const lost = new Promise<string>((resolve) => {
      fixture.supervisor.onLoss((error) => resolve(error.message))
    })
    await fixture.supervisor.start()
    const configure = fixture.supervisor.configure({
      deviceId: "coreaudio:fixture",
      sampleRateHz: 48_000,
      maxFramesPerBlock: 512,
      channelCount: 2,
      revision: 1,
    })
    await expect(configure).rejects.toThrow("native audio host stopped during deviceConfigure request 3")
    await expect(lost).resolves.toBe("The native audio host stopped during deviceConfigure request 3.")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("acknowledges diagnostics and tears down the session without stopping its process", async () => {
  const fixture = await fixtureSupervisor()
  try {
    const losses: string[] = []
    fixture.supervisor.onLoss((error) => losses.push(error.message))
    await fixture.supervisor.start()
    await expect(fixture.supervisor.diagnostics()).resolves.toEqual({
      workerAutomation: null,
      transportFrame: 0n,
      realtimePerformance: {
        sampleRateHz: 0,
        framesPerCallback: 0,
        observationCount: 0n,
        processingP50Nanoseconds: 0n,
        processingP95Nanoseconds: 0n,
        processingP99Nanoseconds: 0n,
        processingMaximumNanoseconds: 0n,
        deadlineMisses: 0n,
      },
      vstWorkerPerformance: {
        activeWorkers: 0,
        observationCount: 0n,
        processingP50Nanoseconds: 0n,
        processingP95Nanoseconds: 0n,
        processingP99Nanoseconds: 0n,
        processingMaximumNanoseconds: 0n,
        deadlineMisses: 0n,
        watchdogMisses: 0n,
        faults: 0n,
        restarts: 0n,
      },
      state: "idle",
      activeRevision: 0,
      preparedRevision: 0,
      retiredRevision: 0,
      transportEpoch: 0,
      renderEpoch: 0n,
      installedAssets: 0,
      callbacks: 0,
      rejectedBlocks: 0,
      lastRejectedReason: 0,
      lastRejectedCallback: 0n,
      lastRejectedRenderEpoch: 0n,
      lastRejectedTransportEpoch: 0,
      lastRejectedCoreResult: 0,
      lastRejectedFrameCount: 0,
      lastRejectedChannelCount: 0,
      lastRejectedProcessorEventCount: 0,
      lastRejectedInstrumentEventCount: 0,
      lastRejectedGraphRevision: 0,
    })
    await fixture.supervisor.teardownSession("test-session-reset")
    expect(fixture.supervisor.status().running).toBeTrue()
    expect(losses).toEqual([])
    await fixture.supervisor.teardown()
    expect(fixture.supervisor.status().running).toBeFalse()
  } finally {
    await fixture.dispose()
  }
})

test("decodes revision statuses and event-driven worker notification identity", async () => {
  const fixture = await fixtureSupervisor("notification")
  try {
    const notification = new Promise((resolve) => fixture.supervisor.onWorkerNotification(resolve))
    await fixture.supervisor.start()
    await expect(notification).resolves.toEqual({
      kind: "latency",
      graphRevision: 9,
      graphNodeId: 17n,
      instanceId: "instance-1",
      value: 128,
    })
    const graph = new Uint8Array(13)
    new DataView(graph.buffer).setBigUint64(0, 2n)
    await expect(fixture.supervisor.prepareGraphRevision(graph)).resolves.toMatchObject({
      status: "prepared",
      requestedRevision: 2,
      activeRevision: 1,
      preparedRevision: 2,
      diagnosticCode: 3,
    })
    await expect(fixture.supervisor.publishGraphRevision(2)).resolves.toMatchObject({
      status: "published",
      activeRevision: 2,
      retiredRevision: 1,
    })
    await expect(fixture.supervisor.retireGraphRevision(1)).resolves.toMatchObject({
      status: "retired",
      retiredRevision: 0,
    })
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("pending graph replies leave diagnostics and Stop available without host loss", async () => {
  const fixture = await fixtureSupervisor("transition-pending")
  try {
    const losses: string[] = []
    fixture.supervisor.onLoss((error) => losses.push(error.message))
    await fixture.supervisor.start()
    const graph = new Uint8Array(13)
    new DataView(graph.buffer).setBigUint64(0, 2n)
    const start = performance.now()
    await expect(fixture.supervisor.prepareGraphRevision(graph)).resolves.toMatchObject({ status: "publish-pending" })
    await expect(fixture.supervisor.publishGraphRevision(2)).resolves.toMatchObject({ status: "publish-pending" })
    await expect(fixture.supervisor.retireGraphRevision(1)).resolves.toMatchObject({ status: "retirement-not-safe" })
    await fixture.supervisor.diagnostics()
    await fixture.supervisor.stopAudio("pending-transition-test")
    expect(performance.now() - start).toBeLessThan(500)
    expect(losses).toEqual([])
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("a revision request that was never sent is unavailable, a lost reply is unconfirmed", async () => {
  const notStarted = await fixtureSupervisor("transition-pending")
  try {
    // No child process yet, and an invalid revision: nothing reached native in either case.
    const unsent = await Promise.allSettled([
      notStarted.supervisor.prepareGraphRevision(new Uint8Array(13)),
      notStarted.supervisor.publishGraphRevision(0),
      notStarted.supervisor.inspectGraphRevision(2),
    ])
    for (const result of unsent) {
      expect(result.status).toBe("rejected")
      expect(nativeDeliveryFailureKind(result.status === "rejected" ? result.reason : undefined)).toBe("unavailable")
    }
  } finally {
    await notStarted.supervisor.teardown()
    await notStarted.dispose()
  }
  // Another control request is pending: the second queues and is sent after the first reply.
  const busy = await fixtureSupervisor("transition-pending")
  try {
    await busy.supervisor.start()
    const graph = new Uint8Array(13)
    new DataView(graph.buffer).setBigUint64(0, 2n)
    const first = busy.supervisor.prepareGraphRevision(graph)
    const second = busy.supervisor.publishGraphRevision(2)
    await expect(first).resolves.toMatchObject({ status: "publish-pending" })
    await expect(second).resolves.toMatchObject({ status: "publish-pending" })
  } finally {
    await busy.supervisor.teardown()
    await busy.dispose()
  }
})

test("decodes bounded native meter batches", async () => {
  const fixture = await fixtureSupervisor("meter")
  try {
    const batch = new Promise((resolve) => fixture.supervisor.onMeterBatch(resolve))
    await fixture.supervisor.start()
    await expect(batch).resolves.toEqual({
      graphRevision: 9,
      transportEpoch: 1,
      sequence: 5n,
      entries: [
        { nodeId: 17n, leftRms: 0.25, rightRms: 0.5 },
        { nodeId: 23n, leftRms: 0.75, rightRms: 1 },
      ],
    })
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("device loss diagnostics terminate pending revision work without waiting for a reply", async () => {
  const fixture = await fixtureSupervisor("device-loss")
  const errors: string[] = []
  const unsubscribe = fixture.supervisor.onLoss((error) => errors.push(error.message))
  try {
    await fixture.supervisor.start()
    await expect(fixture.supervisor.prepareGraphRevision(new Uint8Array(13)))
      .rejects.toThrow("Audio output device was disconnected. Select an available device in Audio Settings.")
    expect(errors).toEqual(["Audio output device was disconnected. Select an available device in Audio Settings."])
    expect(fixture.supervisor.status().running).toBeFalse()
  } finally {
    unsubscribe()
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("decodes schedule progress notifications", async () => {
  const fixture = await fixtureSupervisor("schedule")
  try {
    const progress = new Promise((resolve) => fixture.supervisor.onScheduleProgress(resolve))
    await fixture.supervisor.start()
    await expect(progress).resolves.toEqual({
      revision: 9,
      epoch: 1,
      progressSequence: 1n,
      renderedThroughFrame: 180n,
      acceptedThroughFrame: 240n,
      lastAcceptedWindowId: 7n,
      appliedTransportTransitionId: 3n,
      appliedUrgentSequence: 0n,
      appliedProcessorSequence: 0n,
      running: true,
      scheduleComplete: false,
      instrumentCredits: 128,
      sourceCredits: 64,
      automationCredits: 32,
    })
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

for (const mode of [
  "schedule-capacity", "schedule-latency", "schedule-resolution", "schedule-resolution-none",
  "schedule-bad-length", "schedule-bad-length-104", "schedule-bad-length-120", "schedule-bad-reserved",
] satisfies ScheduleProgressMode[]) {
  test(`strictly decodes progress trailer ${mode}`, async () => {
    const fixture = await fixtureSupervisor(mode)
    const received: unknown[] = []
    const losses = Promise.withResolvers<string>()
    fixture.supervisor.onLoss((error) => losses.resolve(error.message))
    fixture.supervisor.onScheduleProgress((progress) => received.push(progress))
    try {
      if (mode.startsWith("schedule-bad-")) {
        await fixture.supervisor.start().catch(() => undefined)
        expect(await losses.promise).toContain("invalid schedule progress")
        expect(received).toHaveLength(0)
        return
      }
      await fixture.supervisor.start()
      await fixture.supervisor.diagnostics()
      expect(received).toHaveLength(1)
      if (mode === "schedule-capacity") {
        expect(received[0]).toMatchObject({ admissionCapacityGeneration: 42n })
        expect(received[0]).not.toHaveProperty("latencyCompletionGeneration")
      } else if (mode === "schedule-latency") {
        expect(received[0]).toMatchObject({ admissionCapacityGeneration: 42n, latencyCompletionGeneration: 7n })
        expect(received[0]).not.toHaveProperty("processorPatchResolved")
      } else if (mode === "schedule-resolution") {
        // The token is above Number.MAX_SAFE_INTEGER and crosses the process boundary as decimal text.
        expect(received[0]).toMatchObject({
          admissionCapacityGeneration: 42n,
          latencyCompletionGeneration: 7n,
          processorPatchResolved: { token: "9007199254740993", result: 5 },
        })
      } else {
        expect(received[0]).toMatchObject({ admissionCapacityGeneration: 42n, latencyCompletionGeneration: 7n })
        expect(received[0]).not.toHaveProperty("processorPatchResolved")
      }
    } finally {
      await fixture.supervisor.teardown()
      await fixture.dispose()
    }
  })
}

const patchStatusPayload = (outcome: number, refusal: number, core: number, token: bigint) => {
  const payload = Buffer.alloc(20)
  payload.writeUInt32BE(outcome, 0)
  payload.writeUInt32BE(refusal, 4)
  payload.writeUInt32BE(core, 8)
  payload.writeBigUInt64BE(token, 12)
  return payload
}

test("validates every processor patch status outcome, refusal, core result and token combination", () => {
  expect(decodeNativeProcessorPatchStatus(patchStatusPayload(1, 0, 0, 0n))).toEqual({ outcome: "applied" })
  expect(decodeNativeProcessorPatchStatus(patchStatusPayload(3, 0, 0, 2n ** 53n + 1n))).toEqual({ outcome: "claimed", token: 2n ** 53n + 1n })
  expect(decodeNativeProcessorPatchStatus(patchStatusPayload(2, 3, 0, 2n ** 64n - 1n)))
    .toEqual({ outcome: "refused", refusal: "claim-pending", coreResult: 0, token: 2n ** 64n - 1n })
  expect(decodeNativeProcessorPatchStatus(patchStatusPayload(2, 6, 17, 0n))).toEqual({ outcome: "refused", refusal: "stage-failed", coreResult: 17 })
  expect(decodeNativeProcessorPatchStatus(patchStatusPayload(2, 8, 4, 0n))).toEqual({ outcome: "refused", refusal: "apply-failed", coreResult: 4 })
  for (const refusal of [1, 2, 4, 5, 7]) {
    expect(decodeNativeProcessorPatchStatus(patchStatusPayload(2, refusal, 0, 0n))).toMatchObject({ outcome: "refused" })
  }
  for (const invalid of [
    patchStatusPayload(1, 1, 0, 0n), patchStatusPayload(1, 0, 1, 0n), patchStatusPayload(1, 0, 0, 1n),
    patchStatusPayload(3, 0, 0, 0n), patchStatusPayload(3, 4, 0, 1n), patchStatusPayload(3, 0, 2, 1n),
    patchStatusPayload(2, 0, 0, 0n), patchStatusPayload(2, 9, 0, 0n), patchStatusPayload(2, 4, 0, 1n),
    patchStatusPayload(2, 3, 0, 0n), patchStatusPayload(2, 4, 3, 0n), patchStatusPayload(2, 7, 3, 0n),
    patchStatusPayload(0, 0, 0, 0n), patchStatusPayload(4, 0, 0, 1n),
    patchStatusPayload(1, 0, 0, 0n).subarray(0, 19), Buffer.concat([patchStatusPayload(1, 0, 0, 0n), Buffer.alloc(1)]),
  ]) expect(decodeNativeProcessorPatchStatus(invalid)).toBeUndefined()
})

for (const mode of [
  "patch-applied", "patch-claimed", "patch-refused-pending", "patch-refused-stage",
] satisfies PatchStatusMode[]) {
  test(`answers a processor patch with the typed status ${mode} and a lossless token`, async () => {
    const fixture = await fixtureSupervisor(mode)
    try {
      const status = await fixture.supervisor.queueProcessorStatePatch(new Uint8Array(56))
      if (mode === "patch-applied") expect(status).toEqual({ outcome: "applied" })
      if (mode === "patch-refused-stage") expect(status).toEqual({ outcome: "refused", refusal: "stage-failed", coreResult: 17 })
      if (mode === "patch-claimed" || mode === "patch-refused-pending") {
        expect(status).toMatchObject({ token: 9007199254740993n })
        // Supervisor (bigint) -> main (decimal text) -> structured-clone IPC -> preload hands the renderer the same object.
        const crossed = structuredClone(nativeProcessorPatchReply(status))
        expect(crossed).toMatchObject({ ok: true, token: "9007199254740993" })
        expect("token" in crossed && BigInt(String(crossed.token))).toBe(9007199254740993n)
        expect("token" in crossed && Number.isSafeInteger(Number(crossed.token))).toBeFalse()
      }
    } finally {
      await fixture.supervisor.teardown()
      await fixture.dispose()
    }
  })
}

for (const mode of [
  "patch-bad-claim-token", "patch-bad-refusal", "patch-bad-core", "patch-bad-length",
] satisfies PatchStatusMode[]) {
  test(`treats the invalid processor patch status ${mode} as a protocol error`, async () => {
    const fixture = await fixtureSupervisor(mode)
    const losses = Promise.withResolvers<string>()
    fixture.supervisor.onLoss((error) => losses.resolve(error.message))
    try {
      await expect(fixture.supervisor.queueProcessorStatePatch(new Uint8Array(56))).rejects.toThrow()
      expect(await losses.promise).toContain("invalid processor patch status")
    } finally {
      await fixture.supervisor.teardown()
      await fixture.dispose()
    }
  })
}

test("treats an ACK for a processor patch as a protocol error, never as proof it was taken", async () => {
  const fixture = await fixtureSupervisor()
  const losses = Promise.withResolvers<string>()
  fixture.supervisor.onLoss((error) => losses.resolve(error.message))
  try {
    await expect(fixture.supervisor.queueProcessorStatePatch(new Uint8Array(56))).rejects.toThrow()
    expect(await losses.promise).toContain("acknowledged a processor patch")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("classifies delivery failures as refused, unconfirmed or unavailable", async () => {
  const refused = await fixtureSupervisor("rejected-ack")
  let thrownRefusedWithUnavailableText: unknown
  try {
    const thrown = await refused.supervisor.queueParameterEvents(new Uint8Array(4)).catch((error: Error) => error)
    thrownRefusedWithUnavailableText = thrown
    expect(thrown).toBeInstanceOf(NativeAudioHostCommandError)
    expect(nativeDeliveryFailureKind(thrown)).toBe("refused")
  } finally {
    await refused.supervisor.teardown()
    await refused.dispose()
  }
  // The same text under a refused status is a refusal: only the ACK status word classifies.
  expect(thrownRefusedWithUnavailableText).toBeInstanceOf(NativeAudioHostCommandError)
  expect(thrownRefusedWithUnavailableText instanceof Error && thrownRefusedWithUnavailableText.message).toBe("audio session is unavailable")
  expect(nativeDeliveryFailureKind(thrownRefusedWithUnavailableText)).toBe("refused")
  const unavailableAck = await fixtureSupervisor("unavailable-ack")
  try {
    const thrown = await unavailableAck.supervisor.queueParameterEvents(new Uint8Array(4)).catch((error: Error) => error)
    expect(thrown).toBeInstanceOf(NativeAudioHostCommandError)
    expect(nativeDeliveryFailureKind(thrown)).toBe("unavailable")
  } finally {
    await unavailableAck.supervisor.teardown()
    await unavailableAck.dispose()
  }
  const badStatus = await fixtureSupervisor("bad-ack-status")
  try {
    const losses = Promise.withResolvers<string>()
    badStatus.supervisor.onLoss((error) => losses.resolve(error.message))
    await badStatus.supervisor.queueParameterEvents(new Uint8Array(4)).catch(() => undefined)
    expect(await losses.promise).toContain("invalid control acknowledgement")
  } finally {
    await badStatus.supervisor.teardown()
    await badStatus.dispose()
  }
  expect(nativeDeliveryFailureKind(new NativeAudioHostNotSentError("full"))).toBe("unavailable")
  expect(nativeDeliveryFailureKind(undefined)).toBe("unavailable")
  expect(nativeDeliveryFailureKind(new Error("The native audio host control request timed out."))).toBe("unconfirmed")
  const unavailable = await fixtureSupervisor()
  try {
    await unavailable.supervisor.teardown()
    const thrown = await unavailable.supervisor.queueParameterEvents(new Uint8Array(4)).catch((error: Error) => error)
    expect(nativeDeliveryFailureKind(thrown)).toBe("unavailable")
  } finally {
    await unavailable.dispose()
  }
})

test("decodes editor interaction notifications without treating them as faults", async () => {
  const fixture = await fixtureSupervisor("editor-interaction")
  try {
    const notification = new Promise((resolve) => fixture.supervisor.onWorkerNotification(resolve))
    await fixture.supervisor.start()
    await expect(notification).resolves.toEqual({
      kind: "editor-interaction",
      graphRevision: 9,
      graphNodeId: 17n,
      instanceId: "instance-1",
      value: 0,
    })
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("decodes bounded native VST parameter edit notifications", async () => {
  const fixture = await fixtureSupervisor("parameter-edit")
  try {
    const notification = new Promise((resolve) => fixture.supervisor.onWorkerNotification(resolve))
    await fixture.supervisor.start()
    await expect(notification).resolves.toEqual({
      kind: "parameter-edit",
      graphRevision: 9,
      graphNodeId: 17n,
      instanceId: "11111111-1111-4111-8111-111111111111",
      parameterId: 42,
      normalizedValue: 0.625,
    })
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("validates bounded planar PCM installs and allows idempotent releases", async () => {
  const fixture = await fixtureSupervisor()
  try {
    await fixture.supervisor.start()
    await expect(fixture.supervisor.installAsset({
      sessionAssetId: 1,
      frameCount: 2,
      sampleRateHz: 48_000,
      channelCount: 2,
      planarPcm: new Uint8Array(15),
    })).rejects.toThrow("native audio host asset is invalid")
    await expect(fixture.supervisor.installAsset({
      sessionAssetId: 1,
      frameCount: 1,
      sampleRateHz: 48_000,
      channelCount: 65,
      planarPcm: new Uint8Array(260),
    })).rejects.toThrow("native audio host asset is invalid")
    await expect(fixture.supervisor.installAsset({
      sessionAssetId: 1,
      frameCount: 262_144,
      sampleRateHz: 48_000,
      channelCount: 1,
      planarPcm: new Uint8Array(1_048_576),
    })).rejects.toThrow("native audio host asset is invalid")
    await fixture.supervisor.installAsset({
      sessionAssetId: 1,
      frameCount: 2,
      sampleRateHz: 48_000,
      channelCount: 2,
      planarPcm: new Uint8Array(16),
      contentHashPrefix: new Uint8Array(8),
    })
    await fixture.supervisor.releaseAsset(1)
    await fixture.supervisor.releaseAsset(1)
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("resolves the host default output device and rejects foreign device namespaces", async () => {
  const fixture = await fixtureSupervisor()
  try {
    await expect(fixture.supervisor.resolveOutputDevice()).resolves.toEqual({
      deviceId: "coreaudio:fixture",
      name: "Fixture Output",
      nominalSampleRateHz: 48_000,
      outputChannelCount: 2,
      maximumFramesPerBlock: 512,
      available: true,
    })
    await expect(fixture.supervisor.resolveOutputDevice("web:default")).rejects.toThrow("native audio host device request is invalid")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})
test("probes an output device through an isolated native host", async () => {
  const fixture = await fixtureSupervisor()
  let probe: ReturnType<typeof createNativeAudioHostSupervisor> | undefined
  try {
    const device = await probeNativeAudioOutputDevice(
      "isolated-probe",
      undefined,
      () => {
        probe = fixture.supervisor
        return fixture.supervisor
      },
    )
    expect(device?.nominalSampleRateHz).toBe(48_000)
  } finally {
    if (!probe) await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("resolves the host default recording input and sends bounded recording controls", async () => {
  let child: ChildProcessWithoutNullStreams | undefined
  const fixture = await fixtureSupervisor("spool", undefined, undefined, (value) => { child = value })
  try {
    await expect(fixture.supervisor.resolveInputDevice()).resolves.toEqual({
      deviceId: "coreaudio:fixture-input",
      name: "Fixture Input",
      nominalSampleRateHz: 48_000,
      inputChannelCount: 2,
      maximumFramesPerBlock: 512,
      available: true,
    })
    await fixture.supervisor.configureRecording({
      deviceUid: "coreaudio:fixture-input",
      generation: 1,
      sessionId: 1n,
      channelCount: 2,
      inputChannels: [0, 1],
      gain: 1,
      polarity: 1,
      punchStartFrame: 0,
      punchEndFrame: null,
      monitoring: false,
    }, { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })
    let blocks = 0
    const remove = fixture.supervisor.onRecordingBlock(() => { blocks += 1 })
    const status = new Promise((resolve) => fixture.supervisor.onRecordingStatus(resolve))
    await fixture.supervisor.startRecording()
    await expect(status).resolves.toMatchObject({ generation: 1, sessionId: 1n,
      active: true, configured: true, spool: { state: 1, sampleRateHz: 48000, channelCount: 2 } })
    expect(blocks).toBe(0)
    remove()
    await expect(fixture.supervisor.configureRecording({
      deviceUid: "coreaudio:fixture-input", generation: 1, sessionId: 1n, channelCount: 2,
      inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false,
    }, { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "b".repeat(64) }))
      .rejects.toThrow("already admitted")
    await fixture.supervisor.stopRecording(1024)
    await expect(fixture.supervisor.cancelRecording()).rejects.toThrow("cannot be cancelled")
    child?.kill("SIGUSR1")
    await fixture.supervisor.waitForRecordingFinish()
    await expect(fixture.supervisor.configureRecording({
      deviceUid: "web:fixture",
      generation: 1,
      sessionId: 1n,
      channelCount: 1,
      inputChannels: [0],
      gain: 1,
      polarity: 1,
      punchStartFrame: 0,
      punchEndFrame: null,
      monitoring: false,
    }, { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })).rejects.toThrow("native recording configuration is invalid")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("keeps deterministic host lifecycle attachments control-only", async () => {
  const fixture = await fixtureSupervisor()
  try {
    const transactionToken = await fixture.supervisor.beginTransaction()
    const attachment: ResolvedVst3Attachment & { playbackEnabled: true } = {
      graphNodeId: 17n,
      stageIndex: 0,
      instanceId: "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1",
      classId: "0123456789abcdef0123456789abcdef",
      vendorId: "Example Vendor",
      canonicalBundlePath: "/private/catalog/Example.vst3",
      canonicalExecutablePath: "/private/catalog/Example.vst3/Contents/MacOS/Example",
      bundleFingerprint: "b".repeat(64),
      binaryFingerprint: "a".repeat(64),
      scannerProtocolVersion: 2,
      role: "effect",
      inputLayout: "stereo",
      outputLayout: "stereo",
      declaredLatencyFrames: 32,
      transportLatencyFrames: 512,
      playbackEnabled: true,
      workerTransport: {
        slotCount: 2,
        maximumFrames: 512,
        inputChannels: 2,
        outputChannels: 2,
        maximumEventsPerBlock: 128,
      },
    }
    await expect(fixture.supervisor.startAudio()).rejects.toThrow("transaction")
    await expect(fixture.supervisor.attachVst(attachment, "wrong-token")).rejects.toThrow("transaction")
    await fixture.supervisor.attachVst(attachment, transactionToken)
    await fixture.supervisor.commitTransaction(transactionToken)
    await expect(fixture.supervisor.commitTransaction(transactionToken)).rejects.toThrow("transaction")
    await expect(fixture.supervisor.attachVst(attachment, transactionToken)).rejects.toThrow("transaction")
    await expect(fixture.supervisor.attachVst({
      ...attachment,
      instanceId: "c0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1",
      workerTransport: {
        ...attachment.workerTransport,
        maximumEventsPerBlock: maxVst3WorkerEventsPerBlock + 1,
      },
    })).rejects.toThrow("native VST attachment is invalid")
    const rollbackToken = await fixture.supervisor.beginTransaction()
    await fixture.supervisor.rollbackTransaction(rollbackToken)
    await expect(fixture.supervisor.attachVst({
      graphNodeId: 17n,
      stageIndex: 0,
      instanceId: "",
      classId: "class",
      vendorId: "vendor",
      canonicalBundlePath: "/private/catalog/Example.vst3",
      canonicalExecutablePath: "/private/catalog/Example.vst3/Contents/MacOS/Example",
      bundleFingerprint: "b".repeat(64),
      binaryFingerprint: "a".repeat(64),
      scannerProtocolVersion: 2,
      role: "effect",
      inputLayout: "stereo",
      outputLayout: "stereo",
      declaredLatencyFrames: 0,
      transportLatencyFrames: 512,
      workerTransport: {
        slotCount: 2,
        maximumFrames: 512,
        inputChannels: 2,
        outputChannels: 2,
        maximumEventsPerBlock: 128,
      },
    })).rejects.toThrow("native VST attachment is invalid")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})


test("M2 failed Finish outcome does not permanently veto playback stop or teardown", async () => {
  let child: ChildProcessWithoutNullStreams | undefined
  const fixture = await fixtureSupervisor("spool-failed-finish", undefined, undefined, (value) => { child = value })
  try {
    await fixture.supervisor.configureRecording({ deviceUid: "coreaudio:fixture-input", generation: 1,
      sessionId: 1n, channelCount: 2, inputChannels: [0, 1], gain: 1, polarity: 1,
      punchStartFrame: 0, punchEndFrame: null, monitoring: false },
      { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })
    await fixture.supervisor.startRecording()
    await fixture.supervisor.stopRecording()
    child?.kill("SIGUSR1")
    await expect(fixture.supervisor.waitForRecordingFinish()).resolves.toBeUndefined()
    await expect(fixture.supervisor.waitForRecordingOutcome()).rejects.toThrow("persistence failed")
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
    expect(fixture.supervisor.recordingFinalizationPending()).toBeFalse()
    await expect(fixture.supervisor.configureRecording({ deviceUid: "coreaudio:fixture-input", generation: 2,
      sessionId: 2n, channelCount: 2, inputChannels: [0, 1], gain: 1, polarity: 1,
      punchStartFrame: 0, punchEndFrame: null, monitoring: false },
      { rootPath: "/private/fixture", rootDevice: 1n, rootInode: 2n, token: "b".repeat(64) }))
      .resolves.toMatchObject({ generation: 2, sessionId: 2n, configured: true })
    await expect(fixture.supervisor.startRecording()).resolves.toBeUndefined()
    await fixture.supervisor.stopRecording(); child?.kill("SIGUSR1")
    await expect(fixture.supervisor.waitForRecordingOutcome()).rejects.toThrow("persistence failed")
    await expect(fixture.supervisor.stopAudio()).resolves.toBeUndefined()
    await expect(fixture.supervisor.teardown()).resolves.toBeUndefined()
  } finally {
    child?.kill("SIGKILL")
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

// Extend the framed process fixture locally; existing fixture modes and expectations stay unchanged.
const recordingFinishFixture = async (blocked?: "patch" | "graph", refused = false) => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-recording-finish-"))
  const executable = path.join(directory, "host.mjs")
  const script = hostScript
    .replace('process.on("SIGUSR2", () => process.stdout.write(recordingBlock()))',
      'process.on("SIGUSR2", () => process.stdout.write(spoolStatus(2)))\nprocess.on("SIGWINCH", () => process.stdout.write(ack(30)))\nprocess.on("SIGURG", () => process.stdout.write(patchStatus(1, 0, 0, 0)))')
    .replace('    } else if (type === 36) {', `    } else if (type === ${blocked === "patch" ? 51 : blocked === "graph" ? 36 : -1}) {
      process.stderr.write("recording-control-blocked\\n")
    } else if (type === 36) {`)
    .replace('    } else if (type === 30 && process.env.MODE?.startsWith("spool")) {',
      `    } else if (type === 30 && process.env.MODE?.startsWith("spool")) {
      process.stderr.write("recording-stop-dispatched\\n")
      ${refused ? 'process.stdout.write(ack(type, 0, "fixture Stop refused")); continue' : ""}`)
  await writeFile(executable, script)
  const blockedControl = Promise.withResolvers<void>()
  const stopDispatched = Promise.withResolvers<void>()
  const stopEnqueued = Promise.withResolvers<void>()
  let child: ChildProcessWithoutNullStreams | undefined
  let stopWrites = 0
  let terminated = false
  const supervisor = createNativeAudioHostSupervisor(executable, hostPath => {
    const spawned = spawn(process.execPath, [hostPath], {
      env: { ...process.env, MODE: "spool-slow-stop" }, stdio: ["pipe", "pipe", "pipe"],
    })
    child = spawned
    terminated = false
    const kill = spawned.kill.bind(spawned)
    spyOn(spawned, "kill").mockImplementation(signal => {
      if (signal === undefined || signal === "SIGTERM" || signal === "SIGKILL") terminated = true
      return kill(signal)
    })
    let stderr = ""
    spawned.stderr.on("data", chunk => {
      stderr += String(chunk)
      if (stderr.includes("recording-control-blocked")) blockedControl.resolve()
      if (stderr.includes("recording-stop-dispatched")) stopDispatched.resolve()
    })
    spawned.stdin.on("error", () => undefined)
    const write = spawned.stdin.write.bind(spawned.stdin)
    spyOn(spawned.stdin, "write").mockImplementation(chunk => {
      if (Buffer.isBuffer(chunk) && chunk.readUInt32BE(8) === nativeAudioHostControlTypes.recordingStop) stopWrites += 1
      return write(chunk)
    })
    return spawned
  })
  await supervisor.configureRecording({
    deviceUid: "coreaudio:fixture-input", generation: 1, sessionId: 1n, channelCount: 2,
    inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false,
  }, { rootPath: directory, rootDevice: 1n, rootInode: 2n, token: "a".repeat(64) })
  await supervisor.startRecording()
  const timers = spyOn(globalThis, "setTimeout")
  const logs = spyOn(console, "info").mockImplementation((prefix, line) => {
    if (prefix === "[native-audio-host-control]" && String(line).includes('"request":"recordingStop"')
      && String(line).includes('"phase":"enqueue"')) stopEnqueued.resolve()
  })
  const completeStackCapture = () => {
    // Complete the existing bounded capture deadline, not a new persistence timer.
    const sample = timers.mock.calls.findLast(([, delay]) => delay === 1_500)
    sample?.[0]()
  }
  return {
    supervisor, blockedControl: blockedControl.promise, stopDispatched: stopDispatched.promise,
    stopEnqueued: stopEnqueued.promise,
    stopWrites: () => stopWrites,
    killed: () => terminated,
    finish: () => child?.kill("SIGUSR1"),
    finishWithoutAck: () => child?.kill("SIGUSR2"),
    kill: () => child?.kill("SIGKILL"),
    acknowledgeStop: () => child?.kill("SIGWINCH"),
    releasePatch: () => child?.kill("SIGURG"),
    completeStackCapture,
    fireDeadline: (completeCapture = true) => {
      const timer = timers.mock.calls.findLast(([, delay]) => delay === 2_000)
      if (!timer) throw new Error("Missing dispatched control deadline")
      timer[0]()
      if (completeCapture) completeStackCapture()
    },
    dispose: async () => {
      timers.mockRestore()
      logs.mockRestore()
      child?.kill("SIGKILL")
      await supervisor.teardown()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("recording Finish watchdog: D6 queued Stop cannot mask a lost patch status", async () => {
  for (const tearingDown of [false, true]) {
    const fixture = await recordingFinishFixture("patch")
    const supervisor = fixture.supervisor
    let lossState: { pending: boolean; admission: boolean; running: boolean } | undefined
    supervisor.onLoss(() => {
      lossState = { pending: supervisor.recordingFinalizationPending(),
        admission: supervisor.recordingAdmissionAvailable(), running: supervisor.status().running }
    })
    try {
      const patch = supervisor.queueProcessorStatePatch(new Uint8Array(56))
      void patch.catch(() => undefined)
      await fixture.blockedControl
      expect(supervisor.recordingFinalizationPending()).toBeFalse()
      const stop = supervisor.stopRecording()
      void stop.catch(() => undefined)
      const outcome = supervisor.waitForRecordingOutcome()
      void outcome.catch(() => undefined)
      const finish = supervisor.waitForRecordingFinish()
      await fixture.stopEnqueued
      const teardown = tearingDown ? supervisor.teardown() : Promise.resolve()
      expect(supervisor.recordingFinalizationPending()).toBeTrue()
      expect(supervisor.recordingAdmissionAvailable()).toBeFalse()
      expect(fixture.stopWrites()).toBe(0)
      fixture.fireDeadline()
      expect(supervisor.status().running).toBeFalse()
      expect(lossState).toEqual({ pending: false, admission: true, running: false })
      expect(fixture.stopWrites()).toBe(0)
      await expect(patch).rejects.toThrow("control request timed out")
      await expect(stop).rejects.toThrow()
      await expect(outcome).rejects.toThrow("control request timed out")
      await expect(finish).resolves.toBeUndefined()
      await teardown
    } finally { await fixture.dispose() }
  }
})

test("recording Finish watchdog: dispatched Stop retains persistence before ACK", async () => {
  const fixture = await recordingFinishFixture()
  let losses = 0
  fixture.supervisor.onLoss(() => { losses += 1 })
  try {
    let stopped = false
    const stop = fixture.supervisor.stopRecording().then(() => { stopped = true })
    void stop.catch(() => undefined)
    await fixture.stopDispatched
    let finished = false
    const finish = fixture.supervisor.waitForRecordingFinish().then(() => { finished = true })
    fixture.fireDeadline()
    expect(fixture.supervisor.status().running).toBeTrue()
    expect(fixture.killed()).toBeFalse()
    expect(losses).toBe(0)
    expect(stopped).toBeFalse()
    expect(finished).toBeFalse()
    expect(fixture.supervisor.recordingFinalizationPending()).toBeTrue()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeFalse()
    await expect(fixture.supervisor.cancelRecording()).rejects.toThrow("cannot be cancelled")
    fixture.finish()
    await stop
    await finish
    await expect(fixture.supervisor.waitForRecordingOutcome()).resolves.toBeUndefined()
    expect(fixture.supervisor.recordingFinalizationPending()).toBeFalse()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
  } finally { await fixture.dispose() }
})

test("recording Finish watchdog: acknowledged Stop retains persistence behind another control", async () => {
  const fixture = await recordingFinishFixture("patch")
  try {
    const stop = fixture.supervisor.stopRecording()
    await fixture.stopDispatched
    fixture.acknowledgeStop()
    await stop
    const patch = fixture.supervisor.queueProcessorStatePatch(new Uint8Array(56))
    void patch.catch(() => undefined)
    await fixture.blockedControl
    fixture.fireDeadline()
    expect(fixture.supervisor.status().running).toBeTrue()
    expect(fixture.killed()).toBeFalse()
    expect(fixture.supervisor.recordingFinalizationPending()).toBeTrue()
    fixture.finishWithoutAck()
    await fixture.supervisor.waitForRecordingOutcome()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
    fixture.kill()
    await expect(patch).rejects.toThrow()
  } finally { await fixture.dispose() }
})

test("recording Finish watchdog: refused Stop retains admission and allows cancellation", async () => {
  const fixture = await recordingFinishFixture(undefined, true)
  try {
    const stop = fixture.supervisor.stopRecording()
    const outcome = fixture.supervisor.waitForRecordingOutcome()
    void outcome.catch(() => undefined)
    await expect(stop).rejects.toThrow("fixture Stop refused")
    await expect(outcome).rejects.toThrow("fixture Stop refused")
    await expect(fixture.supervisor.waitForRecordingFinish()).resolves.toBeUndefined()
    expect(fixture.supervisor.recordingFinalizationPending()).toBeFalse()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeFalse()
    expect(fixture.supervisor.status().running).toBeTrue()
    await expect(fixture.supervisor.cancelRecording()).resolves.toBeUndefined()
    expect(fixture.stopWrites()).toBe(1)
  } finally { await fixture.dispose() }
})

test("recording Finish watchdog: double Stop preserves the original Finish", async () => {
  const fixture = await recordingFinishFixture()
  try {
    const stop = fixture.supervisor.stopRecording()
    await fixture.stopDispatched
    const original = fixture.supervisor.waitForRecordingOutcome()
    await expect(fixture.supervisor.stopRecording()).rejects.toThrow("already finishing")
    expect(fixture.supervisor.waitForRecordingOutcome()).toBe(original)
    expect(fixture.stopWrites()).toBe(1)
    fixture.finish()
    await stop
    await original
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
  } finally { await fixture.dispose() }
})

test("recording Finish watchdog: teardown waits for dispatched persistence", async () => {
  const fixture = await recordingFinishFixture()
  try {
    const stop = fixture.supervisor.stopRecording()
    await fixture.stopDispatched
    let tornDown = false
    const teardown = fixture.supervisor.teardown().then(() => { tornDown = true })
    fixture.fireDeadline()
    expect(tornDown).toBeFalse()
    expect(fixture.killed()).toBeFalse()
    expect(fixture.supervisor.recordingFinalizationPending()).toBeTrue()
    fixture.acknowledgeStop()
    await stop
    expect(tornDown).toBeFalse()
    fixture.finishWithoutAck()
    await teardown
    expect(fixture.supervisor.recordingFinalizationPending()).toBeFalse()
    expect(fixture.killed()).toBeTrue()
  } finally { await fixture.dispose() }
})

test("recording Finish watchdog: Stop during teardown is rejected without releasing recording data", async () => {
  const fixture = await recordingFinishFixture()
  try {
    const teardown = fixture.supervisor.teardown()
    const stop = fixture.supervisor.stopRecording()
    const outcome = fixture.supervisor.waitForRecordingOutcome()
    void outcome.catch(() => undefined)
    await expect(stop).rejects.toThrow("tearing down")
    await expect(outcome).rejects.toThrow("tearing down")
    await expect(fixture.supervisor.waitForRecordingFinish()).resolves.toBeUndefined()
    expect(fixture.stopWrites()).toBe(0)
    expect(fixture.supervisor.recordingFinalizationPending()).toBeFalse()
    // Teardown, not the refused Stop, releases admission at its physical shutdown boundary.
    await teardown
    expect(fixture.supervisor.status().running).toBeFalse()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
  } finally { await fixture.dispose() }
})

test("recording Finish watchdog: queued Stop advances after graph reply deadline", async () => {
  const fixture = await recordingFinishFixture("graph")
  try {
    const graph = fixture.supervisor.prepareGraphRevision(new Uint8Array(13))
    void graph.catch(() => undefined)
    await fixture.blockedControl
    const stop = fixture.supervisor.stopRecording()
    void stop.catch(() => undefined)
    await fixture.stopEnqueued
    expect(fixture.stopWrites()).toBe(0)
    fixture.fireDeadline()
    expect(fixture.stopWrites()).toBe(1)
    await expect(graph).rejects.toThrow("inspect revision status")
    await fixture.stopDispatched
    expect(fixture.supervisor.status().running).toBeTrue()
    fixture.fireDeadline()
    expect(fixture.killed()).toBeFalse()
    fixture.finish()
    await stop
    await fixture.supervisor.waitForRecordingOutcome()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
  } finally { await fixture.dispose() }
})

test("recording Finish watchdog: actual host loss rejects queued Stop without dispatch", async () => {
  const fixture = await recordingFinishFixture("patch")
  try {
    const patch = fixture.supervisor.queueProcessorStatePatch(new Uint8Array(56))
    void patch.catch(() => undefined)
    await fixture.blockedControl
    const stop = fixture.supervisor.stopRecording()
    void stop.catch(() => undefined)
    const outcome = fixture.supervisor.waitForRecordingOutcome()
    void outcome.catch(() => undefined)
    await fixture.stopEnqueued
    fixture.kill()
    await expect(outcome).rejects.toThrow("stopped during processorStatePatch")
    expect(fixture.stopWrites()).toBe(0)
    await expect(stop).rejects.toThrow()
    await expect(patch).rejects.toThrow()
    await expect(fixture.supervisor.waitForRecordingFinish()).resolves.toBeUndefined()
    expect(fixture.stopWrites()).toBe(0)
    expect(fixture.supervisor.recordingFinalizationPending()).toBeFalse()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
  } finally { await fixture.dispose() }
})

test("recording Finish watchdog: loss notification cannot let an old Stop retire a replacement Finish", async () => {
  const fixture = await recordingFinishFixture("patch")
  let replacement: Promise<void> | undefined
  const remove = fixture.supervisor.onLoss(() => {
    remove()
    replacement = fixture.supervisor.stopRecording()
    void replacement.catch(() => undefined)
  })
  try {
    const patch = fixture.supervisor.queueProcessorStatePatch(new Uint8Array(56))
    void patch.catch(() => undefined)
    await fixture.blockedControl
    const stop = fixture.supervisor.stopRecording()
    void stop.catch(() => undefined)
    await fixture.stopEnqueued
    fixture.kill()
    await expect(patch).rejects.toThrow()
    expect(fixture.stopWrites()).toBe(0)
    await expect(stop).rejects.toThrow()
    remove()
    expect(fixture.supervisor.recordingFinalizationPending()).toBeTrue()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeFalse()
    await fixture.stopDispatched
    fixture.fireDeadline()
    expect(fixture.supervisor.status().running).toBeTrue()
    fixture.finish()
    await replacement
    await fixture.supervisor.waitForRecordingOutcome()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
  } finally {
    remove()
    await fixture.dispose()
    await replacement?.catch(() => undefined)
  }
})

test("recording Finish watchdog: late patch reply during stack capture preserves dispatched Finish", async () => {
  const fixture = await recordingFinishFixture("patch")
  let losses = 0
  fixture.supervisor.onLoss(() => { losses += 1 })
  try {
    const patch = fixture.supervisor.queueProcessorStatePatch(new Uint8Array(56))
    void patch.catch(() => undefined)
    await fixture.blockedControl
    const stop = fixture.supervisor.stopRecording()
    void stop.catch(() => undefined)
    await fixture.stopEnqueued
    fixture.fireDeadline(false)
    fixture.releasePatch()
    await expect(patch).resolves.toEqual({ outcome: "applied" })
    await fixture.stopDispatched
    fixture.completeStackCapture()
    expect(fixture.supervisor.status().running).toBeTrue()
    expect(fixture.killed()).toBeFalse()
    expect(losses).toBe(0)
    expect(fixture.supervisor.recordingFinalizationPending()).toBeTrue()
    fixture.finish()
    await stop
    await fixture.supervisor.waitForRecordingOutcome()
    expect(fixture.supervisor.recordingAdmissionAvailable()).toBeTrue()
  } finally { await fixture.dispose() }
})
