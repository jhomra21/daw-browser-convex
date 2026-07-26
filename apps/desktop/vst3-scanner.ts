import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import {
  maxPluginHostControlFrameBytes,
  parseVst3ScannerResponseV2,
  pluginHostProtocolCompatibility,
  type Vst3ScannerClassResult,
} from "@daw-browser/plugin-host-protocol"
import {
  canonicalizeVst3ScannerBundlePath,
  fingerprintPluginBinary,
  fingerprintVst3Bundle,
  type Vst3CatalogEntry,
  type Vst3WorkerLaunchEligibility,
} from "./plugin-catalog"

const run = promisify(execFile)
const timeoutMs = 10_000

const inside = (candidate: string, directory: string) => candidate === directory || candidate.startsWith(`${directory}${path.sep}`)

const binaryPathForBundle = async (bundlePath: string) => {
  const executable = path.join(bundlePath, "Contents", "MacOS", path.basename(bundlePath, ".vst3"))
  const details = await stat(executable)
  if (!details.isFile()) throw new Error("The VST3 bundle executable is unavailable.")
  return executable
}

export const packagedVst3ScannerPath = (resourcesPath: string, isPackaged: boolean, explicitPath?: string) => (
  isPackaged ? path.join(resourcesPath, "daw-vst3-scanner") : explicitPath
)

const readFrame = (bytes: Buffer) => {
  if (bytes.byteLength < 4) throw new Error("The scanner response was incomplete.")
  const size = bytes.readUInt32BE(0)
  if (size === 0 || size > maxPluginHostControlFrameBytes || size !== bytes.byteLength - 4) {
    throw new Error("The scanner response exceeded the frame limit.")
  }
  return bytes.subarray(4).toString("utf8")
}

const writeFrame = (body: string) => {
  const payload = Buffer.from(body, "utf8")
  if (payload.byteLength === 0 || payload.byteLength > maxPluginHostControlFrameBytes) throw new Error("The scanner request exceeded the frame limit.")
  const frame = Buffer.allocUnsafe(payload.byteLength + 4)
  frame.writeUInt32BE(payload.byteLength, 0)
  payload.copy(frame, 4)
  return frame
}

export const assertSafeVst3Bundle = async (bundlePath: string, directories: readonly string[]) => {
  const canonicalBundle = await canonicalizeVst3ScannerBundlePath(bundlePath)
  const canonicalDirectories = await Promise.all(directories.map((directory) => realpath(directory, "utf8")))
  if (!canonicalDirectories.some((directory) => inside(canonicalBundle, directory))) {
    throw new Error("The VST3 bundle is outside configured directories.")
  }
  const binaryPath = await binaryPathForBundle(canonicalBundle)
  try {
    await run("xattr", ["-p", "com.apple.quarantine", binaryPath])
    throw new Error("Quarantined VST3 binaries cannot be scanned.")
  } catch (error) {
    if (error instanceof Error && error.message === "Quarantined VST3 binaries cannot be scanned.") throw error
  }
  try {
    await run("codesign", ["--verify", "--strict", binaryPath])
  } catch {
    throw new Error("Unsigned VST3 binaries cannot be scanned.")
  }
  let architectures: string
  try {
    ({ stdout: architectures } = await run("lipo", ["-archs", binaryPath]))
  } catch {
    throw new Error("The VST3 binary architecture could not be verified.")
  }
  if (!architectures.split(/\s+/).includes("arm64")) {
    throw new Error("Only arm64 VST3 binaries can be scanned.")
  }
  return { bundlePath: canonicalBundle, binaryPath, codeSignVerifiedAtMs: Date.now() }
}

const runScanner = async (scannerPath: string, request: string) => new Promise<string>((resolve, reject) => {
  const child = spawn(scannerPath, [], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "ignore"],
  })
  const chunks: Buffer[] = []
  let outputLength = 0
  const timer = setTimeout(() => {
    child.kill("SIGKILL")
    reject(new Error("The VST3 scanner timed out."))
  }, timeoutMs)
  child.stdout.on("data", (chunk: Buffer) => {
    outputLength += chunk.byteLength
    if (outputLength > maxPluginHostControlFrameBytes + 4) {
      child.kill("SIGKILL")
      reject(new Error("The VST3 scanner response exceeded the frame limit."))
      return
    }
    chunks.push(chunk)
  })
  child.once("error", reject)
  child.once("close", (code) => {
    clearTimeout(timer)
    if (code !== 0 && chunks.length === 0) {
      reject(new Error("The VST3 scanner failed."))
      return
    }
    try {
      resolve(readFrame(Buffer.concat(chunks)))
    } catch (error) {
      reject(error)
    }
  })
  child.stdin.end(writeFrame(request))
})

const classesForCatalog = (classes: readonly Vst3ScannerClassResult[]) => classes.map((entry) => ({
  classId: entry.classId,
  vendor: entry.vendor,
  name: entry.name,
  version: entry.version,
  role: entry.role,
  source: entry.source,
  ...(entry.sdkVersion === undefined ? {} : { sdkVersion: entry.sdkVersion }),
}))

export const createVst3ScannerSupervisor = (options: {
  scannerPath?: string
  platform: NodeJS.Platform
  arch: string
}) => ({
  scan: async (entry: Vst3CatalogEntry, directories: readonly string[]): Promise<Partial<Vst3CatalogEntry>> => {
    if (options.platform !== "darwin" || options.arch !== "arm64" || !options.scannerPath) return {}
    await access(options.scannerPath)
    const safe = await assertSafeVst3Bundle(entry.bundlePath, directories)
    const requestId = randomUUID()
    const response = parseVst3ScannerResponseV2(await runScanner(options.scannerPath, JSON.stringify({
      version: 2,
      compatibility: pluginHostProtocolCompatibility,
      requestId,
      type: "scan",
      bundlePath: safe.bundlePath,
    })))
    if (response.requestId !== requestId || response.type === "error" || response.bundlePath !== safe.bundlePath) {
      throw new Error("The VST3 scanner returned an invalid result.")
    }
    const binaryFingerprint = await fingerprintPluginBinary(safe.binaryPath)
    const launchEligibility: Vst3WorkerLaunchEligibility = {
      canonicalBundlePath: safe.bundlePath,
      canonicalExecutablePath: safe.binaryPath,
      bundleFingerprint: await fingerprintVst3Bundle(safe.bundlePath),
      binaryFingerprint,
      architecture: "arm64",
      codeSignVerifiedAtMs: safe.codeSignVerifiedAtMs,
      quarantinePresent: false,
      scannerProtocolVersion: 2,
    }
    return {
      classes: classesForCatalog(response.classes),
      scanHealth: "scanned",
      scannerVersion: response.scannerVersion,
      sdkVersion: response.sdkVersion,
      binaryFingerprint,
      launchEligibility,
    }
  },
})
