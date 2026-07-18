import { spawn } from "node:child_process"
import { constants, existsSync } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import path from "node:path"

const maximumReplyBytes = 4 * 1024
const maximumErrorBytes = 4 * 1024
const helperTimeoutMs = 30_000

type NativeHelperErrorCode =
  | "file-too-large"
  | "commit-indeterminate"
  | "identity-mismatch"
  | "invalid-path"
  | "invalid-request"
  | "io-error"
  | "path-exists"
  | "source-invalid"
  | "target-changed"

type InvocationResult = {
  stdout: string
  exitCode: number
}

export type FileIdentity = {
  device: string
  inode: string
}

export type OutputFileGrant = {
  parent: FileIdentity
  basename: string
  file?: FileIdentity
  retained?: FileIdentity & { handle: FileHandle }
}

export type NativeFileCapabilityHelper = {
  available: () => boolean
  selfTest: (signal?: AbortSignal) => Promise<boolean>
  statDirectory: (directoryPath: string, signal?: AbortSignal) => Promise<FileIdentity>
  statFile: (filePath: string, signal?: AbortSignal) => Promise<OutputFileGrant>
  retainFile: (filePath: string, signal?: AbortSignal) => Promise<OutputFileGrant>
  commitDirectory: (input: {
    rootPath: string
    root: FileIdentity
    relativePath: string
    tempPath: string
    signal?: AbortSignal
  }) => Promise<void>
  commitFile: (input: {
    parentPath: string
    basename: string
    tempPath: string
    parent: FileIdentity
    signal?: AbortSignal
  }) => Promise<void>
  commitRetainedFile: (input: {
    retained: FileIdentity & { handle: FileHandle }
    tempPath: string
    signal?: AbortSignal
  }) => Promise<void>
}

export class NativeFileCapabilityError extends Error {
  readonly code: NativeHelperErrorCode

  constructor(code: NativeHelperErrorCode) {
    super(`Native file helper rejected the operation: ${code}.`)
    this.name = "NativeFileCapabilityError"
    this.code = code
  }
}

const isNativeHelperErrorCode = (value: string): value is NativeHelperErrorCode => {
  return value === "file-too-large"
    || value === "commit-indeterminate"
    || value === "identity-mismatch"
    || value === "invalid-path"
    || value === "invalid-request"
    || value === "io-error"
    || value === "path-exists"
    || value === "source-invalid"
    || value === "target-changed"
}

const readIdentityPart = (value: unknown, name: string) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Native file helper returned an invalid ${name}.`)
  }
  return value
}

const readIdentity = (device: unknown, inode: unknown, name: string): FileIdentity => {
  return {
    device: readIdentityPart(device, `${name} device`),
    inode: readIdentityPart(inode, `${name} inode`),
  }
}

const exactKeys = (value: object, keys: string[]) => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const parseObject = (result: InvocationResult) => {
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw new Error("Native file helper returned invalid JSON.")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Native file helper returned an invalid reply.")
  }
  return value
}

const expectedExitCode = (code: NativeHelperErrorCode) => {
  switch (code) {
    case "invalid-request": return 10
    case "invalid-path": return 11
    case "identity-mismatch": return 12
    case "path-exists": return 13
    case "target-changed": return 14
    case "source-invalid": return 15
    case "file-too-large": return 16
    case "io-error": return 17
    case "commit-indeterminate": return 19
  }
}

const parseFailure = (value: object, exitCode: number) => {
  if (!exactKeys(value, ["ok", "code"]) || !("ok" in value) || value.ok !== false || !("code" in value)) {
    throw new Error("Native file helper returned an invalid failure.")
  }
  if (typeof value.code !== "string" || !isNativeHelperErrorCode(value.code)) {
    throw new Error("Native file helper returned an unknown failure.")
  }
  if (exitCode !== expectedExitCode(value.code)) {
    throw new Error("Native file helper returned a mismatched failure code.")
  }
  throw new NativeFileCapabilityError(value.code)
}

const parseEmptySuccess = (result: InvocationResult) => {
  const value = parseObject(result)
  if ("ok" in value && value.ok === false) parseFailure(value, result.exitCode)
  if (result.exitCode !== 0) throw new Error("Native file helper exited unsuccessfully.")
  if (!exactKeys(value, ["ok"]) || !("ok" in value) || value.ok !== true) {
    throw new Error("Native file helper returned an invalid success reply.")
  }
}

const parseDirectorySuccess = (result: InvocationResult): FileIdentity => {
  const value = parseObject(result)
  if ("ok" in value && value.ok === false) parseFailure(value, result.exitCode)
  if (result.exitCode !== 0) throw new Error("Native file helper exited unsuccessfully.")
  if (!exactKeys(value, ["ok", "dev", "ino"]) || !("ok" in value) || value.ok !== true) {
    throw new Error("Native file helper returned an invalid directory reply.")
  }
  return readIdentity(
    "dev" in value ? value.dev : undefined,
    "ino" in value ? value.ino : undefined,
    "directory",
  )
}

const parseFileSuccess = (invocation: InvocationResult): OutputFileGrant => {
  const value = parseObject(invocation)
  if ("ok" in value && value.ok === false) parseFailure(value, invocation.exitCode)
  if (invocation.exitCode !== 0) throw new Error("Native file helper exited unsuccessfully.")
  if (
    !exactKeys(value, ["ok", "parentDev", "parentIno", "basename", "file"])
    || !("ok" in value)
    || value.ok !== true
    || !("basename" in value)
    || typeof value.basename !== "string"
    || value.basename.length === 0
    || value.basename.length > 255
    || value.basename === "."
    || value.basename === ".."
    || value.basename.includes("/")
  ) {
    throw new Error("Native file helper returned an invalid file reply.")
  }
  const grant: OutputFileGrant = {
    parent: readIdentity(
      "parentDev" in value ? value.parentDev : undefined,
      "parentIno" in value ? value.parentIno : undefined,
      "parent",
    ),
    basename: value.basename,
  }
  if (!("file" in value) || value.file === null) return grant
  if (
    typeof value.file !== "object"
    || Array.isArray(value.file)
    || !exactKeys(value.file, ["dev", "ino"])
  ) {
    throw new Error("Native file helper returned an invalid target identity.")
  }
  return {
    ...grant,
    file: readIdentity(
      "dev" in value.file ? value.file.dev : undefined,
      "ino" in value.file ? value.file.ino : undefined,
      "target",
    ),
  }
}

const helperPath = () => {
  const candidates = [
    ...(process.resourcesPath
      ? [path.join(process.resourcesPath, "file-capability-helper")]
      : []),
    path.join(import.meta.dirname, ".native", "file-capability-helper"),
    path.join(import.meta.dirname, "..", "..", ".native", "file-capability-helper"),
    path.join(process.cwd(), ".native", "file-capability-helper"),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

const invoke = (
  executable: string,
  arguments_: string[],
  signal?: AbortSignal,
  timeoutMs: number | undefined = helperTimeoutMs,
  inheritedFd?: number,
  indeterminateAfterSpawn = false,
) => new Promise<InvocationResult>((resolve, reject) => {
  try {
    signal?.throwIfAborted()
  } catch (error) {
    reject(error)
    return
  }
  const child = spawn(executable, arguments_, {
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: inheritedFd === undefined
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe", inheritedFd],
    windowsHide: true,
  })
  if (!child.stdout || !child.stderr) {
    child.kill()
    reject(indeterminateAfterSpawn
      ? new NativeFileCapabilityError("commit-indeterminate")
      : new Error("Native file helper pipes were unavailable."))
    return
  }
  const stdoutStream = child.stdout
  const stderrStream = child.stderr
  let output = ""
  let errorOutput = ""
  let settled = false
  let spawned = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const rejectTransport = (error: unknown) => {
    reject(indeterminateAfterSpawn && spawned
      ? new NativeFileCapabilityError("commit-indeterminate")
      : error)
  }
  const finish = (result: () => void) => {
    if (settled) return
    settled = true
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
    result()
  }
  const abort = () => {
    child.kill()
    finish(() => rejectTransport(signal?.reason ?? new Error("Native helper aborted.")))
  }
  child.once("spawn", () => {
    spawned = true
  })
  signal?.addEventListener("abort", abort, { once: true })
  if (timeoutMs !== undefined) {
    // Non-commit operations are safe to terminate because they cannot publish.
    timeout = setTimeout(() => {
      child.kill("SIGKILL")
      finish(() => rejectTransport(new Error("Native file helper timed out.")))
    }, timeoutMs)
  }
  child.once("error", (error) => finish(() => rejectTransport(error)))
  stdoutStream.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8")
    if (Buffer.byteLength(output) > maximumReplyBytes) {
      child.kill()
      finish(() => rejectTransport(new Error("Native file helper reply exceeded its limit.")))
    }
  })
  stderrStream.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString("utf8")
    if (Buffer.byteLength(errorOutput) > maximumErrorBytes) {
      child.kill("SIGKILL")
      finish(() => rejectTransport(new Error("Native file helper error output exceeded its limit.")))
    }
  })
  child.once("close", (code) => finish(() => {
    if (errorOutput.length > 0) {
      rejectTransport(new Error("Native file helper wrote unexpected error output."))
      return
    }
    if (code === null || code < 0) {
      rejectTransport(new Error("Native file helper terminated unexpectedly."))
      return
    }
    resolve({ stdout: output, exitCode: code })
  }))
})

export const createNativeFileCapabilityHelper = (executablePath?: string): NativeFileCapabilityHelper => {
  const executable = executablePath ?? helperPath()
  const supported = process.platform === "darwin" || process.platform === "linux"
  const commit = async (arguments_: string[], signal?: AbortSignal, inheritedFd?: number) => {
    signal?.throwIfAborted()
    const result = await invoke(executable, arguments_, undefined, undefined, inheritedFd, true)
    try {
      parseEmptySuccess(result)
    } catch (error) {
      if (error instanceof NativeFileCapabilityError) throw error
      throw new NativeFileCapabilityError("commit-indeterminate")
    }
  }
  return {
    available: () => supported && existsSync(executable),
    selfTest: async (signal) => {
      if (!supported || !existsSync(executable)) return false
      try {
        parseEmptySuccess(await invoke(executable, ["self-test"], signal))
        return true
      } catch {
        return false
      }
    },
    statDirectory: async (directoryPath, signal) => {
      return parseDirectorySuccess(await invoke(executable, ["stat-directory", directoryPath], signal))
    },
    statFile: async (filePath, signal) => {
      return parseFileSuccess(await invoke(executable, ["stat-file", filePath], signal))
    },
    retainFile: async (filePath, signal) => {
      const grant = parseFileSuccess(await invoke(executable, ["stat-file", filePath], signal))
      if (!grant.file) return grant
      signal?.throwIfAborted()
      const handle = await open(
        filePath,
        constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      )
      try {
        const status = await handle.stat({ bigint: true })
        if (
          !status.isFile()
          || `${status.dev}` !== grant.file.device
          || `${status.ino}` !== grant.file.inode
        ) {
          throw new NativeFileCapabilityError("target-changed")
        }
        return { ...grant, retained: { ...grant.file, handle } }
      } catch (error) {
        await handle.close()
        throw error
      }
    },
    commitDirectory: async (input) => {
      await commit([
        "commit-directory",
        input.rootPath,
        input.root.device,
        input.root.inode,
        input.relativePath,
        input.tempPath,
      ], input.signal)
    },
    commitFile: async (input) => {
      await commit([
        "commit-file",
        input.parentPath,
        input.parent.device,
        input.parent.inode,
        input.basename,
        input.tempPath,
      ], input.signal)
    },
    commitRetainedFile: async (input) => {
      await commit([
        "commit-retained-file",
        input.retained.device,
        input.retained.inode,
        input.tempPath,
      ], input.signal, input.retained.handle.fd)
    },
  }
}
