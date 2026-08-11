import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { audioCoreWasmAbiVersion } from "@daw-browser/audio-core-wasm"
import { portableGraphContractHash, processorContractHash } from "@daw-browser/audio-core-contract/generated"
import { maxVst3WorkerEventsPerBlock } from "@daw-browser/plugin-host-protocol"
import {
  createNativeAudioHostSupervisor,
  encodeNativeAudioHostControlFrame,
  NativeAudioHostCommandError,
  nativeVstEditorOwnershipProbe,
  packagedAudioHostPath,
  probeNativeAudioOutputDevice,
  renderNativeOffline,
  runAudioHostDiagnostic,
  type NativeAudioHostSupervisorOptions,
  type ResolvedVst3Attachment,
} from "./audio-host"
import { nativeAudioHostControlTypes, nativeAudioHostProtocolVersion } from "@daw-browser/desktop-protocol/native-audio-host"

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
  string("${portableGraphContractHash}"), string("daw-audio-host-macos/v4"), u32(0), u32(1),
]))
const device = () => frame(19, Buffer.concat([
  u32(1), string("coreaudio:fixture"), string("Fixture Output"), u32(48000), u32(2), u32(512), u32(1),
]))
const inputDevice = () => frame(35, Buffer.concat([
  u32(1), string("coreaudio:fixture-input"), string("Fixture Input"), u32(48000), u32(2), u32(512), u32(1),
]))
const ack = (type, success = 1) => frame(13, Buffer.concat([u32(type), u32(success)]))
const vstState = (instanceId = "11111111-1111-4111-8111-111111111111") => {
  const state = Buffer.from([1, 2, 3])
  return frame(27, Buffer.concat([
    stringLe(instanceId), u32Le(state.length), u32Le(64), state, Buffer.from("a".repeat(64)),
  ]))
}
const graphStatus = (code, requested, active, prepared, retired) => frame(40, Buffer.concat([
  u32(code), u32(requested), u32(active), u32(prepared), u32(retired), u64(4),
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
]))
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
    u32(1), u64(1), u32(0), u32(2), u32(1), f32(0.4), f32(0.5), samples,
  ]))
}
const recordingStatus = () => frame(33, Buffer.concat([
  u32(1), u64(1), u64(120), u64(2), u64(0), u32(0), u32(63), u32(0),
  f32(0.4), f32(0.5), u32(7),
]))
const editorStatus = () => frame(42, Buffer.concat([
  u32(1), u32(1), u32(1), u32(1), u32(640), u32(480),
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
      if (process.env.MODE === "schedule") process.stdout.write(scheduleProgress())
      if (process.env.MODE === "editor-interaction") process.stdout.write(editorInteractionNotification())
      if (process.env.MODE === "parameter-edit") process.stdout.write(parameterEditNotification())
      if (process.env.MODE === "loss") setTimeout(() => process.exit(1), 10)
    } else if (type === 12) {
      process.stdout.write(frame(12, Buffer.concat([
        u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u64(0),
        u32(0), u64(0), u64(0), u32(0), u32(0),
        u32(0), u32(0), u32(0), u32(0), u32(0),
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
    } else if (type === 41) {
      if (process.env.MODE === "editor-anchor"
        && (payload.length < 28
          || payload.readUInt32BE(12) !== 1
          || payload.readInt32BE(16) !== -320
          || payload.readInt32BE(20) !== -240)) process.exit(2)
      process.stdout.write(editorStatus())
    } else if (type === 43) {
      process.stdout.write(ack(type))
    } else if (type === 26) {
      if (process.env.MODE === "state-rejected") process.stdout.write(ack(type, 0))
      else if (process.env.MODE === "state-malformed") process.stdout.write(frame(27, Buffer.from([1, 2, 3])))
      else if (process.env.MODE === "state-mismatch") process.stdout.write(vstState("22222222-2222-4222-8222-222222222222"))
      else process.stdout.write(vstState())
    } else if (type === 10 && vstPlaybackFlag(payload) !== 0) {
      process.exit(2)
    } else {
      const requestType = process.env.MODE === "wrong-ack" ? 99 : type
      const success = process.env.MODE === "rejected-ack" && !rejectedAck ? 0 : 1
      rejectedAck = true
      const response = () => process.stdout.write(ack(requestType, success))
      if (process.env.MODE === "editor-queued" && type === 3) setTimeout(response, 30)
      else response()
      if (type === 17 && process.env.MODE !== "ignore-teardown") process.exit(0)
    }
  }
})
`

describe("native audio host protocol", () => {
  test("matches the native empty graph rollback frame fixture", () => {
    expect(encodeNativeAudioHostControlFrame(nativeAudioHostControlTypes.graphRollback)).toEqual(
      Buffer.from([
        0x44, 0x41, 0x57, 0x48,
        0x00, 0x00, 0x00, 0x10,
        0x00, 0x00, 0x00, 0x27,
        0x00, 0x00, 0x00, 0x00,
      ]),
    )
  })
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

const fixtureSupervisor = async (
  mode?: "incompatible" | "loss" | "wrong-ack" | "rejected-ack" | "state-rejected" | "state-malformed" | "state-mismatch" | "notification" | "meter" | "schedule" | "editor-interaction" | "parameter-edit" | "silent" | "editor-anchor" | "editor-queued" | "ignore-teardown",
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
        { env: { ...process.env, ...(mode ? { MODE: mode } : {}) }, stdio: ["pipe", "pipe", "pipe"] },
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

test("keeps the host alive after a recoverable negative acknowledgement", async () => {
  const fixture = await fixtureSupervisor("rejected-ack")
  try {
    const losses: string[] = []
    fixture.supervisor.onLoss((error) => losses.push(error.message))
    await fixture.supervisor.start()
    await expect(fixture.supervisor.configure({
      deviceId: "coreaudio:fixture",
      sampleRateHz: 48_000,
      maxFramesPerBlock: 512,
      channelCount: 2,
      revision: 1,
    })).rejects.toBeInstanceOf(NativeAudioHostCommandError)
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
