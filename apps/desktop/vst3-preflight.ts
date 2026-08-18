import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import path from "node:path"
import {
  decodeNativeVst3WorkerHello,
  nativeVst3PreflightProtocolVersion,
  nativeVst3WorkerArtifactId,
  nativeVst3WorkerArtifactVersion,
  nativeVst3WorkerControlProtocolVersion,
  nativeVst3WorkerStartupProtocolVersion,
  nativeVst3WorkerTransportAbiVersion,
  type NativeVst3PreflightRequest,
  type NativeVst3PreflightResult,
} from "@daw-browser/plugin-host-protocol"
import type { ResolvedVst3Attachment } from "./audio-host"

const maximumWorkerHelloBytes = 16 * 1024
const defaultPreflightDeadlineMs = 5_000

const requirements: NativeVst3PreflightRequest["requirements"] = {
  artifact: {
    id: nativeVst3WorkerArtifactId,
    version: nativeVst3WorkerArtifactVersion,
  },
  startupProtocolVersion: nativeVst3WorkerStartupProtocolVersion,
  controlProtocolVersion: nativeVst3WorkerControlProtocolVersion,
  transportAbiVersion: nativeVst3WorkerTransportAbiVersion,
  architecture: "arm64",
}

type SpawnWorker = (workerPath: string, arguments_: readonly string[]) => ChildProcessWithoutNullStreams

export const packagedVst3WorkerPath = (resourcesPath: string, isPackaged: boolean, explicitPath?: string) => (
  isPackaged ? path.join(resourcesPath, nativeVst3WorkerArtifactId) : explicitPath
)

const readWorkerHelloFrame = (bytes: Buffer) => {
  if (bytes.byteLength < 4) throw new Error("The native VST3 worker response was incomplete.")
  const bodyBytes = bytes.readUInt32BE(0)
  if (bodyBytes === 0 || bodyBytes > maximumWorkerHelloBytes || bytes.byteLength !== bodyBytes + 4) {
    throw new Error("The native VST3 worker response exceeded the frame limit.")
  }
  return decodeNativeVst3WorkerHello(bytes.subarray(4).toString("utf8"))
}

export const preflightNativeVst3Worker = async (input: {
  workerPath: string
  attachment: ResolvedVst3Attachment & { stateRevision: number }
  sampleRateHz: number
  deadlineMs?: number
  signal?: AbortSignal
  spawnWorker?: SpawnWorker
  accessWorker?: typeof access
}): Promise<NativeVst3PreflightResult> => {
  const requestId = randomUUID()
  const unavailable = (
    code: Extract<NativeVst3PreflightResult, { status: "unavailable" }>["code"],
    message: string,
  ): NativeVst3PreflightResult => ({
    version: nativeVst3PreflightProtocolVersion,
    type: "preflight-result",
    requestId,
    status: "unavailable",
    code,
    message,
    requirements,
  })
  try {
    await (input.accessWorker ?? access)(input.workerPath)
  } catch {
    return unavailable("worker-unavailable", "The packaged native VST3 worker is unavailable.")
  }
  if (!Number.isFinite(input.sampleRateHz) || input.sampleRateHz <= 0 || input.sampleRateHz > 384_000) {
    return unavailable("worker-unavailable", "The native VST3 worker preflight sample rate is invalid.")
  }
  input.signal?.throwIfAborted()
  const attachment = input.attachment
  const arguments_ = [
    "--preflight",
    "--instance-id", attachment.instanceId,
    "--bundle-path", attachment.canonicalBundlePath,
    "--executable-path", attachment.canonicalExecutablePath,
    "--bundle-fingerprint", attachment.bundleFingerprint,
    "--binary-fingerprint", attachment.binaryFingerprint,
    "--class-id", attachment.classId,
    "--sample-rate", String(input.sampleRateHz),
    "--maximum-frames", String(attachment.workerTransport.maximumFrames),
    "--input-channels", String(attachment.workerTransport.inputChannels),
    "--output-channels", String(attachment.workerTransport.outputChannels),
    "--slot-count", String(attachment.workerTransport.slotCount),
    "--maximum-events", String(attachment.workerTransport.maximumEventsPerBlock),
    "--state-revision", String(attachment.stateRevision),
  ]
  return new Promise((resolve, reject) => {
    const launch = input.spawnWorker ?? ((workerPath, workerArguments) => spawn(workerPath, [...workerArguments], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    }))
    let child: ChildProcessWithoutNullStreams
    try {
      child = launch(input.workerPath, arguments_)
    } catch {
      resolve(unavailable("worker-unavailable", "The native VST3 worker could not start."))
      return
    }
    child.stdin.end()
    child.stderr.resume()
    const chunks: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let abort = () => {}
    const finish = (result: NativeVst3PreflightResult) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      input.signal?.removeEventListener("abort", abort)
      resolve(result)
    }
    abort = () => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      child.kill("SIGKILL")
      reject(new DOMException("Native VST3 worker preflight canceled.", "AbortError"))
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    if (settled) return
    // A hard deadline contains a hung native worker; every other terminal path clears it in finish().
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(unavailable("worker-timeout", "The native VST3 worker preflight timed out."))
    }, input.deadlineMs ?? defaultPreflightDeadlineMs)
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > maximumWorkerHelloBytes + 4) {
        child.kill("SIGKILL")
        finish(unavailable("worker-invalid-response", "The native VST3 worker preflight exceeded the output limit."))
      } else {
        chunks.push(chunk)
      }
    })
    child.once("error", () => {
      finish(unavailable("worker-unavailable", "The native VST3 worker could not start."))
    })
    child.once("close", (code) => {
      if (settled) return
      if (code !== 0) {
        finish(unavailable("worker-crashed", "The native VST3 worker preflight failed."))
        return
      }
      try {
        const hello = readWorkerHelloFrame(Buffer.concat(chunks))
        finish({
          version: nativeVst3PreflightProtocolVersion,
          type: "preflight-result",
          requestId,
          status: "available",
          requirements,
          hello,
        })
      } catch {
        finish(unavailable("worker-invalid-response", "The native VST3 worker returned an invalid preflight response."))
      }
    })
  })
}
