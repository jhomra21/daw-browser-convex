import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { audioCoreWasmAbiVersion } from "@daw-browser/audio-core-wasm"
import { portableGraphContractHash, processorContractHash } from "@daw-browser/audio-core-contract/generated"
import { maxVst3WorkerEventsPerBlock } from "@daw-browser/plugin-host-protocol"
import {
  createNativeAudioHostSupervisor,
  encodeNativeAudioHostControlFrame,
  packagedAudioHostPath,
  runAudioHostDiagnostic,
  type ResolvedVst3Attachment,
} from "./audio-host"
import { nativeAudioHostControlTypes } from "@daw-browser/desktop-protocol/native-audio-host"

const hostScript = `
const u32 = (value) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}
const frame = (type, payload = Buffer.alloc(0)) => Buffer.concat([
  u32(0x44415748), u32(7), u32(type), u32(payload.length), payload,
])
const string = (value) => Buffer.concat([u32(Buffer.byteLength(value)), Buffer.from(value)])
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
  u32(7), u32(0x1ff), u32(${audioCoreWasmAbiVersion}),
  string(process.env.MODE === "incompatible" ? "wrong" : "${processorContractHash}"),
  string("${portableGraphContractHash}"), string("daw-audio-host-macos/v3"), u32(0), u32(1),
]))
const device = () => frame(19, Buffer.concat([
  u32(1), string("coreaudio:fixture"), string("Fixture Output"), u32(48000), u32(2), u32(512), u32(1),
]))
const inputDevice = () => frame(35, Buffer.concat([
  u32(1), string("coreaudio:fixture-input"), string("Fixture Input"), u32(48000), u32(2), u32(512), u32(1),
]))
const ack = (type) => frame(13, Buffer.concat([u32(type), u32(1)]))
const graphStatus = (code, requested, active, prepared, retired) => frame(40, Buffer.concat([
  u32(code), u32(requested), u32(active), u32(prepared), u32(retired), u64(4),
]))
const workerNotification = () => frame(14, Buffer.concat([
  u32(1), u32(9), u64(17), u32(128), string("instance-1"),
]))
const recordingBlock = () => {
  const samples = Buffer.alloc(8)
  samples.writeFloatLE(0.25, 0)
  samples.writeFloatLE(-0.5, 4)
  return frame(32, Buffer.concat([
    u32(1), u64(1), u32(0), u32(2), u32(1), f32(0.4), f32(0.5), samples,
  ]))
}
const recordingStatus = () => frame(33, Buffer.concat([
  u32(1), u64(1), u64(120), u64(2), u64(0), u32(0), u32(63), u32(0),
  f32(0.4), f32(0.5), u32(7),
]))
const vstPlaybackFlag = (payload) => {
  let offset = 0
  for (let index = 0; index < 5; index += 1) {
    if (offset + 4 > payload.length) return undefined
    const length = payload.readUInt32BE(offset)
    offset += 4 + length
    if (offset > payload.length) return undefined
  }
  const flagOffset = offset + 8 + 1 + 32 + 32 + 4 + 3
  return flagOffset < payload.length ? payload[flagOffset] : undefined
}
let bytes = Buffer.alloc(0)
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
      if (process.env.MODE === "loss") setTimeout(() => process.exit(1), 10)
    } else if (type === 12) {
      process.stdout.write(frame(12, Buffer.concat([
        u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u64(0),
      ])))
    } else if (type === 36) {
      process.stdout.write(graphStatus(1, 2, 1, 2, 0))
    } else if (type === 37) {
      process.stdout.write(graphStatus(2, 2, 2, 0, 1))
    } else if (type === 38) {
      process.stdout.write(graphStatus(3, 1, 2, 0, 0))
    } else if (type === 39) {
      process.stdout.write(graphStatus(4, 2, 1, 0, 0))
    } else if (type === 19) {
      process.stdout.write(device())
    } else if (type === 34) {
      process.stdout.write(inputDevice())
    } else if (type === 29) {
      process.stdout.write(ack(type))
      process.stdout.write(recordingBlock())
      process.stdout.write(recordingStatus())
    } else if (type === 10 && vstPlaybackFlag(payload) !== 0) {
      process.exit(2)
    } else {
      process.stdout.write(ack(process.env.MODE === "wrong-ack" ? 99 : type))
      if (type === 17) process.exit(0)
    }
  }
})
`

describe("native audio host protocol", () => {
  test("matches the native empty graph rollback frame fixture", () => {
    expect(encodeNativeAudioHostControlFrame(nativeAudioHostControlTypes.graphRollback)).toEqual(
      Buffer.from([
        0x44, 0x41, 0x57, 0x48,
        0x00, 0x00, 0x00, 0x07,
        0x00, 0x00, 0x00, 0x27,
        0x00, 0x00, 0x00, 0x00,
      ]),
    )
  })
})

const fixtureSupervisor = async (
  mode?: "incompatible" | "loss" | "wrong-ack" | "notification" | "silent",
  onSpawn?: () => void,
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-audio-host-"))
  const executable = path.join(directory, "host.mjs")
  await writeFile(executable, hostScript)
  return {
    supervisor: createNativeAudioHostSupervisor(executable, (hostPath) => {
      onSpawn?.()
      return spawn(
        process.execPath,
        [hostPath],
        { env: { ...process.env, ...(mode ? { MODE: mode } : {}) }, stdio: ["pipe", "pipe", "pipe"] },
      )
    }),
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

const vstAttachment = (instanceId: string): ResolvedVst3Attachment => ({
  graphNodeId: 17n,
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

test("rejects a native host with incompatible contract identity before use", async () => {
  const fixture = await fixtureSupervisor("incompatible")
  try {
    await expect(fixture.supervisor.start()).rejects.toThrow("incompatible protocol response")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
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

test("acknowledges diagnostics and tears down without reporting host loss", async () => {
  const fixture = await fixtureSupervisor()
  try {
    const losses: string[] = []
    fixture.supervisor.onLoss((error) => losses.push(error.message))
    await fixture.supervisor.start()
    await expect(fixture.supervisor.diagnostics()).resolves.toEqual({
      state: "idle",
      activeRevision: 0,
      preparedRevision: 0,
      retiredRevision: 0,
      transportEpoch: 0,
      renderEpoch: 0n,
      installedAssets: 0,
      callbacks: 0,
      rejectedBlocks: 0,
    })
    await fixture.supervisor.teardown()
    expect(fixture.supervisor.status().running).toBeFalse()
    expect(losses).toEqual([])
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
    await expect(fixture.supervisor.prepareGraphRevision(new Uint8Array(13))).resolves.toMatchObject({
      status: "prepared",
      requestedRevision: 2,
      activeRevision: 1,
      preparedRevision: 2,
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

test("resolves the host default recording input and sends bounded recording controls", async () => {
  const fixture = await fixtureSupervisor()
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
    })
    const block = new Promise((resolve) => fixture.supervisor.onRecordingBlock(resolve))
    const status = new Promise((resolve) => fixture.supervisor.onRecordingStatus(resolve))
    await fixture.supervisor.startRecording()
    const recordingBlockMessage = await block
    expect(recordingBlockMessage).toMatchObject({
      generation: 1,
      sessionId: 1n,
      sequence: 0,
      frameCount: 2,
      channelCount: 1,
      peak: 0.5,
    })
    expect(recordingBlockMessage).toHaveProperty("rms")
    if (typeof recordingBlockMessage === "object" && recordingBlockMessage !== null
      && "rms" in recordingBlockMessage && typeof recordingBlockMessage.rms === "number") {
      expect(recordingBlockMessage.rms).toBeCloseTo(0.4)
    }
    await expect(status).resolves.toMatchObject({
      generation: 1,
      sessionId: 1n,
      timelineFrame: 120,
      capturedFrames: 2,
      fatal: true,
      active: true,
      configured: true,
    })
    await fixture.supervisor.stopRecording(1024)
    await fixture.supervisor.cancelRecording()
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
    })).rejects.toThrow("native recording configuration is invalid")
  } finally {
    await fixture.supervisor.teardown()
    await fixture.dispose()
  }
})

test("keeps deterministic host lifecycle attachments control-only", async () => {
  const fixture = await fixtureSupervisor()
  try {
    await fixture.supervisor.beginTransaction()
    const attachment: ResolvedVst3Attachment & { playbackEnabled: true } = {
      graphNodeId: 17n,
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
    await fixture.supervisor.attachVst(attachment)
    await fixture.supervisor.commitTransaction()
    await expect(fixture.supervisor.attachVst({
      ...attachment,
      instanceId: "c0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1",
      workerTransport: {
        ...attachment.workerTransport,
        maximumEventsPerBlock: maxVst3WorkerEventsPerBlock + 1,
      },
    })).rejects.toThrow("native VST attachment is invalid")
    await fixture.supervisor.beginTransaction()
    await fixture.supervisor.rollbackTransaction()
    await expect(fixture.supervisor.attachVst({
      graphNodeId: 17n,
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
