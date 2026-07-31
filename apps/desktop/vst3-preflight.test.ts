import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NativeVst3WorkerHello } from "@daw-browser/plugin-host-protocol"
import type { ResolvedVst3Attachment } from "./audio-host"
import { packagedVst3WorkerPath, preflightNativeVst3Worker } from "./vst3-preflight"

const instanceId = "b0c4db1e-bd48-46d4-a4bc-f5ad1fe6c6f1"

const attachment = (): ResolvedVst3Attachment & { stateRevision: number } => ({
  graphNodeId: 17n,
  chainIndex: 0,
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
  stateRevision: 7,
})

const hello: NativeVst3WorkerHello = {
  version: 1,
  type: "hello",
  instanceId,
  manifest: {
    version: 1,
    artifact: { id: "daw-vst3-worker", version: "2" },
    startupProtocolVersion: 1,
    controlProtocolVersion: 2,
    transportAbiVersion: 2,
    architecture: "arm64",
    role: "effect",
    inputBuses: [{ name: "Main Input", channels: 2, enabled: true }],
    outputBuses: [{ name: "Main Output", channels: 2, enabled: true }],
    transport: {
      slotCount: 2,
      maximumFrames: 512,
      inputChannels: 2,
      outputChannels: 2,
      maximumEventsPerBlock: 128,
    },
    latencyFrames: 32,
    tailFrames: 480,
    stateRevision: 7,
  },
}

const withScript = async (source: string, operation: (script: string) => Promise<void>) => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-vst3-preflight-"))
  const script = path.join(directory, "worker.mjs")
  try {
    await writeFile(script, source)
    await operation(script)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const spawnScript = (script: string) => (_workerPath: string, arguments_: readonly string[]) => spawn(
  process.execPath,
  [script, ...arguments_],
  { stdio: ["pipe", "pipe", "pipe"] },
)

test("uses the pinned worker artifact name for packaged launches", () => {
  expect(packagedVst3WorkerPath("/Resources", true, "/tmp/worker")).toBe("/Resources/daw-vst3-worker")
  expect(packagedVst3WorkerPath("/Resources", false, "/tmp/worker")).toBe("/tmp/worker")
})

test("accepts a bounded worker hello from the dedicated preflight mode", async () => {
  const body = JSON.stringify(hello)
  const script = `
const body = ${JSON.stringify(body)}
const frame = Buffer.alloc(4 + Buffer.byteLength(body))
frame.writeUInt32BE(Buffer.byteLength(body), 0)
frame.write(body, 4)
process.stdout.write(frame)
`
  await withScript(script, async (scriptPath) => {
    const result = await preflightNativeVst3Worker({
      workerPath: "/packaged/daw-vst3-worker",
      attachment: attachment(),
      sampleRateHz: 48_000,
      accessWorker: async () => undefined,
      spawnWorker: spawnScript(scriptPath),
    })
    expect(result.status).toBe("available")
    if (result.status === "available") expect(result.hello).toEqual(hello)
  })
})

test("fails closed when the worker crashes or exceeds its deadline", async () => {
  await withScript("process.exit(7)", async (scriptPath) => {
    const result = await preflightNativeVst3Worker({
      workerPath: "/packaged/daw-vst3-worker",
      attachment: attachment(),
      sampleRateHz: 48_000,
      accessWorker: async () => undefined,
      spawnWorker: spawnScript(scriptPath),
    })
    expect(result).toMatchObject({ status: "unavailable", code: "worker-crashed" })
  })
  await withScript("setTimeout(() => undefined, 10_000)", async (scriptPath) => {
    const result = await preflightNativeVst3Worker({
      workerPath: "/packaged/daw-vst3-worker",
      attachment: attachment(),
      sampleRateHz: 48_000,
      deadlineMs: 20,
      accessWorker: async () => undefined,
      spawnWorker: spawnScript(scriptPath),
    })
    expect(result).toMatchObject({ status: "unavailable", code: "worker-timeout" })
  })
})
