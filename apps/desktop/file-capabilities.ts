import { randomBytes as nodeRandomBytes } from "node:crypto"
import { constants } from "node:fs"
import * as nodeFileSystem from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FileHandle } from "node:fs/promises"
import {
  NativeFileCapabilityError,
  type FileIdentity,
  type NativeFileCapabilityHelper,
  type OutputFileGrant,
} from "./native-file-capability-helper"

const capabilityLifetimeMs = 4 * 60 * 60 * 1_000
const maximumActiveCapabilities = 16
const maximumReadBytes = 10 * 1024 * 1024
const maximumChunkBytes = 1024 * 1024
const maximumOutputBytes = 8 * 1024 * 1024 * 1024
const maximumOutputFiles = 1024

const supportedAudioTypes = new Map([
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".webm", "audio/webm"],
])

type FileCapabilityScope = {
  requestId: string
  rendererGeneration: number
}

type CapacityReservation = {
  scope: FileCapabilityScope
  revoked: boolean
  settled: Promise<void>
  assertActive: () => void
  release: () => void
}

type ReadCapabilityDescriptor = {
  token: string
  basename: string
  byteLength: number
  mime: string
}

type WriteCapabilityDescriptor = {
  token: string
  basename: string
  mime: string
}

type DirectoryCapabilityDescriptor = {
  token: string
  basename: string
}

type FilePickerResult =
  | { canceled: true }
  | { canceled: false; files: ReadCapabilityDescriptor[] }

type OutputPickerResult =
  | { canceled: true }
  | { canceled: false; file: WriteCapabilityDescriptor }

type DirectoryPickerResult =
  | { canceled: true }
  | { canceled: false; directory: DirectoryCapabilityDescriptor }

type MixdownFormat = "wav" | "mp3" | "ogg-opus" | "flac"

type FileCapabilityErrorCode =
  | "capacity-exceeded"
  | "expired"
  | "file-count-exceeded"
  | "invalid-capability"
  | "invalid-chunk"
  | "invalid-path"
  | "invalid-scope"
  | "commit-indeterminate"
  | "output-limit-exceeded"
  | "path-exists"
  | "unsupported-file"

export class FileCapabilityError extends Error {
  readonly code: FileCapabilityErrorCode

  constructor(code: FileCapabilityErrorCode, message: string) {
    super(message)
    this.name = "FileCapabilityError"
    this.code = code
  }
}

type OpenDialogOptions = {
  properties: ("openFile" | "multiSelections" | "openDirectory")[]
  filters?: { name: string; extensions: string[] }[]
}

type SaveDialogOptions = {
  filters: { name: string; extensions: string[] }[]
}

type CapabilityDialog = {
  showOpenDialog: (options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>
  showSaveDialog: (options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>
}

type FileSystem = Pick<
  typeof nodeFileSystem,
  "lstat" | "stat" | "realpath" | "open" | "unlink" | "mkdir"
>

type FileCapabilityManagerOptions = {
  dialog: CapabilityDialog
  fileSystem?: FileSystem
  now?: () => number
  randomBytes?: (length: number) => Uint8Array
  nativeHelper?: NativeFileCapabilityHelper
  nativeOutputEnabled?: () => boolean
  privateTempDirectory?: string | (() => string)
}

type CapabilityBase = FileCapabilityScope & {
  token: string
  expiresAt: number
  outputBytes: number
  reservedOutputBytes: number
  outputFiles: number
  reservedWriterSlots: number
  writerIds: Set<string>
  revoked: boolean
  revocationPromise?: Promise<void>
}

type ReadCapability = CapabilityBase & {
  kind: "read"
  filePath: string
  byteLength: number
  mime: string
  device: number
  inode: number
}

type WriteCapability = CapabilityBase & {
  kind: "write"
  filePath: string
  mime: string
  allowOverwrite: boolean
  outputGrant: OutputFileGrant
  retainedOpen: boolean
}

type DirectoryCapability = CapabilityBase & {
  kind: "directory"
  directoryPath: string
  identity: FileIdentity
}

type Capability = ReadCapability | WriteCapability | DirectoryCapability

type Writer = {
  id: string
  capabilityToken: string
  finalPath: string
  tempPath: string
  handle: FileHandle
  highWaterMark: number
  closed: boolean
  poisoned: boolean
  operation: Promise<void>
  state: "open" | "committing" | "aborting" | "terminal"
  commitPromise?: Promise<CommittedOutput>
  abortPromise?: Promise<void>
  target:
    | {
      kind: "file"
      filePath: string
      allowOverwrite: boolean
      grant: OutputFileGrant
    }
    | {
      kind: "directory"
      rootPath: string
      root: FileIdentity
      relativePath: string
    }
}

type CommittedOutput = {
  basename: string
  byteLength: number
  mime: string
}

const audioDialogFilter = {
  name: "Audio",
  extensions: [...supportedAudioTypes.keys()].map((extension) => extension.slice(1)),
}
const outputFilterForFormat = (format: MixdownFormat) => ({
  name: format === "ogg-opus" ? "Ogg Opus audio" : `${format.toUpperCase()} audio`,
  extensions: [format === "ogg-opus" ? "ogg" : format],
})
const outputExtensionMatchesFormat = (format: MixdownFormat, filePath: string) =>
  path.extname(filePath).toLowerCase() === (format === "ogg-opus" ? ".ogg" : `.${format}`)

const pathsEqual = (left: string, right: string) =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right

const isNodeError = (error: Error): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error

const nativeError = (error: Error): never => {
  if (error instanceof NativeFileCapabilityError) {
    if (error.code === "commit-indeterminate") {
      throw new FileCapabilityError("commit-indeterminate", "The native commit reached an indeterminate terminal state.")
    }
    if (error.code === "path-exists") {
      throw new FileCapabilityError("path-exists", "The output path already exists.")
    }
    throw new FileCapabilityError("invalid-path", "The granted output location changed or could not be committed safely.")
  }
  throw error
}

const invalidPath = (message: string): never => {
  throw new FileCapabilityError("invalid-path", message)
}

const requireSafeReparseProtection = () => {
  if (process.platform === "win32") {
    throw new FileCapabilityError("invalid-path", "This host cannot safely anchor file capabilities on Windows without no-reparse support.")
  }
}

const requireAbsoluteNormalizedPath = (filePath: string) => {
  if (
    filePath.length === 0
    || filePath.includes("\0")
    || !path.isAbsolute(filePath)
    || path.normalize(filePath) !== filePath
  ) {
    invalidPath("The path must be absolute, normalized, and NUL-free.")
  }
}

const requireRelativeNormalizedPath = (filePath: string) => {
  if (
    filePath.length === 0
    || filePath.includes("\0")
    || path.isAbsolute(filePath)
    || path.normalize(filePath) !== filePath
    || filePath === "."
    || filePath === ".."
    || filePath.startsWith(`..${path.sep}`)
  ) {
    invalidPath("The output path must be relative, normalized, contained, and NUL-free.")
  }
}

const mimeForPath = (filePath: string) => {
  const mime = supportedAudioTypes.get(path.extname(filePath).toLowerCase())
  if (!mime) {
    throw new FileCapabilityError("unsupported-file", "The file extension is not supported.")
  }
  return mime
}

const bytesToHex = (bytes: Uint8Array) => {
  let value = ""
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0")
  return value
}

const isPrivateTempDirectoryFactory = (
  value: string | (() => string),
): value is () => string => typeof value === "function"

export const createFileCapabilityManager = ({
  dialog,
  fileSystem = nodeFileSystem,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  nativeHelper,
  nativeOutputEnabled = () => false,
  privateTempDirectory,
}: FileCapabilityManagerOptions) => {
  const capabilities = new Map<string, Capability>()
  const writers = new Map<string, Writer>()
  const pendingGrants = new Set<CapacityReservation>()
  let temporaryDirectoryPromise: Promise<string> | undefined
  let reservedCapabilities = 0

  const uniqueOpaqueId = (existing: { has: (key: string) => boolean }) => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const bytes = randomBytes(32)
      if (bytes.byteLength !== 32) {
        throw new Error("The random source must return exactly 32 bytes.")
      }
      const id = bytesToHex(bytes)
      if (!existing.has(id)) return id
    }
    throw new Error("The random source repeatedly returned duplicate identifiers.")
  }

  const removeTempFile = async (tempPath: string) => {
    try {
      await fileSystem.unlink(tempPath)
    } catch (error) {
      if (!(error instanceof Error) || !isNodeError(error) || error.code !== "ENOENT") throw error
    }
  }

  const releaseWriter = (writer: Writer) => {
    writers.delete(writer.id)
    const capability = capabilities.get(writer.capabilityToken)
    capability?.writerIds.delete(writer.id)
  }

  const cleanupPrivateWriter = async (writer: Writer) => {
    let closeError: unknown
    if (!writer.closed) {
      writer.closed = true
      try {
        await writer.handle.close()
      } catch (error) {
        closeError = error
      }
    }
    await removeTempFile(writer.tempPath)
    if (closeError !== undefined) throw closeError
  }

  const startAbortWriter = (writer: Writer) => {
    if (writer.state === "committing") {
      return writer.commitPromise?.then(() => undefined)
        ?? Promise.reject(new Error("The committing writer is missing its commit promise."))
    }
    if (writer.state === "aborting") {
      return writer.abortPromise
        ?? Promise.reject(new Error("The aborting writer is missing its abort promise."))
    }
    if (writer.state === "terminal") return Promise.resolve()
    writer.state = "aborting"
    const abortPromise = (async () => {
      try {
        await writer.operation
        await cleanupPrivateWriter(writer)
      } finally {
        try {
          const capability = capabilities.get(writer.capabilityToken)
          if (capability) {
            try {
              await closeRetainedFile(capability)
            } finally {
              retireRetainedCapability(capability)
            }
          }
        } finally {
          writer.state = "terminal"
          releaseWriter(writer)
        }
      }
    })()
    writer.abortPromise = abortPromise
    return abortPromise
  }

  const removeCapability = (capability: Capability) => {
    if (capability.revocationPromise) return capability.revocationPromise
    capability.revoked = true
    const revocationPromise = (async () => {
      const activeWriters = [...capability.writerIds]
      for (const writerId of activeWriters) {
        const writer = writers.get(writerId)
        if (writer) {
          try {
            await startAbortWriter(writer)
          } catch {
            // Revocation is a settlement barrier; commit callers receive the operation error.
          }
        }
      }
      try {
        await closeRetainedFile(capability)
      } finally {
        if (capabilities.get(capability.token) === capability) {
          capabilities.delete(capability.token)
        }
      }
    })()
    capability.revocationPromise = revocationPromise
    return revocationPromise
  }

  const pruneExpired = async () => {
    const currentTime = now()
    const expired = [...capabilities.values()].filter((capability) => capability.expiresAt <= currentTime)
    for (const capability of expired) await removeCapability(capability)
  }

  const reserveCapacity = (scope: FileCapabilityScope, count: number): CapacityReservation => {
    const currentTime = now()
    const activeCount = [...capabilities.values()].filter(
      (capability) => !capability.revoked && capability.expiresAt > currentTime,
    ).length
    if (count < 1 || activeCount + reservedCapabilities + count > maximumActiveCapabilities) {
      throw new FileCapabilityError("capacity-exceeded", "The active file capability limit was reached.")
    }
    reservedCapabilities += count
    let released = false
    let settle = () => {}
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const reservation: CapacityReservation = {
      scope,
      revoked: false,
      settled,
      assertActive: () => {
        if (reservation.revoked) {
          throw new FileCapabilityError("invalid-capability", "The capability grant was revoked before it settled.")
        }
      },
      release: () => {
        if (released) return
        released = true
        pendingGrants.delete(reservation)
        reservedCapabilities -= count
        settle()
      },
    }
    pendingGrants.add(reservation)
    return reservation
  }

  const revokePendingGrants = async (matches: (scope: FileCapabilityScope) => boolean) => {
    const matching = [...pendingGrants].filter((reservation) => matches(reservation.scope))
    for (const reservation of matching) reservation.revoked = true
    await Promise.all(matching.map((reservation) => reservation.settled))
  }

  const createBase = (scope: FileCapabilityScope): CapabilityBase => {
    if (scope.requestId.length === 0 || !Number.isSafeInteger(scope.rendererGeneration) || scope.rendererGeneration < 0) {
      throw new FileCapabilityError("invalid-scope", "The file capability scope is invalid.")
    }
    return {
      ...scope,
      token: uniqueOpaqueId(capabilities),
      expiresAt: now() + capabilityLifetimeMs,
      outputBytes: 0,
      reservedOutputBytes: 0,
      outputFiles: 0,
      reservedWriterSlots: 0,
      writerIds: new Set(),
      revoked: false,
    }
  }

  const requireCapability = async (scope: FileCapabilityScope, token: string) => {
    const capability = capabilities.get(token)
    if (!capability) {
      throw new FileCapabilityError("invalid-capability", "The file capability is not active.")
    }
    if (capability.revoked) {
      await capability.revocationPromise
      throw new FileCapabilityError("invalid-capability", "The file capability is not active.")
    }
    if (capability.expiresAt <= now()) {
      await removeCapability(capability)
      throw new FileCapabilityError("expired", "The file capability expired.")
    }
    if (
      capability.requestId !== scope.requestId
      || capability.rendererGeneration !== scope.rendererGeneration
    ) {
      throw new FileCapabilityError("invalid-scope", "The file capability does not belong to this request.")
    }
    return capability
  }

  const requireUnchangedRealPath = async (filePath: string) => {
    const [realPath, realParentPath] = await Promise.all([
      fileSystem.realpath(filePath),
      fileSystem.realpath(path.dirname(filePath)),
    ])
    if (!pathsEqual(path.dirname(realPath), realParentPath)) {
      invalidPath("Symbolic links and reparse points are not permitted.")
    }
    return realPath
  }

  const validateReadFile = async (filePath: string) => {
    requireSafeReparseProtection()
    requireAbsoluteNormalizedPath(filePath)
    const mime = mimeForPath(filePath)
    const linkStatus = await fileSystem.lstat(filePath)
    const status = await fileSystem.stat(filePath)
    if (linkStatus.isSymbolicLink() || !linkStatus.isFile() || !status.isFile()) {
      throw new FileCapabilityError("unsupported-file", "The selected path is not a regular file.")
    }
    await requireUnchangedRealPath(filePath)
    if (status.size > maximumReadBytes) {
      throw new FileCapabilityError("unsupported-file", "The selected file exceeds 10 MiB.")
    }
    return { byteLength: status.size, mime, device: status.dev, inode: status.ino }
  }

  const validateDirectory = async (directoryPath: string) => {
    requireSafeReparseProtection()
    requireAbsoluteNormalizedPath(directoryPath)
    const linkStatus = await fileSystem.lstat(directoryPath)
    const status = await fileSystem.stat(directoryPath)
    if (linkStatus.isSymbolicLink() || !linkStatus.isDirectory() || !status.isDirectory()) {
      invalidPath("The selected path is not a real directory.")
    }
    return requireUnchangedRealPath(directoryPath)
  }

  const useNativeOutput = (): NativeFileCapabilityHelper => {
    if (nativeHelper && nativeOutputEnabled() && nativeHelper.available()) {
      return nativeHelper
    }
    throw new FileCapabilityError("invalid-path", "Secure native output capabilities are unavailable on this host.")
  }

  const nativeOutputGrant = async (filePath: string, allowOverwrite: boolean): Promise<OutputFileGrant> => {
    const helper = useNativeOutput()
    try {
      const grant = allowOverwrite
        ? await helper.retainFile(filePath)
        : await helper.statFile(filePath)
      if (grant.file && !allowOverwrite) {
        throw new FileCapabilityError("path-exists", "The output path already exists.")
      }
      if (grant.file && !grant.retained) {
        invalidPath("The selected overwrite target could not be retained securely.")
      }
      return grant
    } catch (error) {
      if (error instanceof NativeFileCapabilityError || error instanceof FileCapabilityError) {
        return nativeError(error)
      }
      return invalidPath("The selected output could not be retained securely.")
    }
  }

  const nativeDirectoryGrant = async (directoryPath: string): Promise<FileIdentity> => {
    const helper = useNativeOutput()
    try {
      return await helper.statDirectory(directoryPath)
    } catch (error) {
      if (error instanceof Error) return nativeError(error)
      throw error
    }
  }

  const closeRetainedFile = async (capability: Capability) => {
    if (capability.kind !== "write" || !capability.retainedOpen || !capability.outputGrant.retained) return
    capability.retainedOpen = false
    await capability.outputGrant.retained.handle.close()
  }

  const retireRetainedCapability = (capability: Capability) => {
    if (capability.kind !== "write" || !capability.outputGrant.retained) return
    capability.revoked = true
    if (capabilities.get(capability.token) === capability) {
      capabilities.delete(capability.token)
    }
  }

  const temporaryDirectory = () => {
    if (temporaryDirectoryPromise) return temporaryDirectoryPromise
    temporaryDirectoryPromise = (async () => {
      if (privateTempDirectory) {
        const configuredPath = isPrivateTempDirectoryFactory(privateTempDirectory)
          ? privateTempDirectory()
          : privateTempDirectory
        requireAbsoluteNormalizedPath(configuredPath)
        await fileSystem.mkdir(configuredPath, { recursive: true, mode: 0o700 })
        const directoryHandle = await fileSystem.open(
          configuredPath,
          constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
        )
        try {
          const status = await directoryHandle.stat()
          if (!status.isDirectory() || (process.getuid && status.uid !== process.getuid())) {
            invalidPath("The private temporary output path is not an app-owned directory.")
          }
          await directoryHandle.chmod(0o700)
        } finally {
          await directoryHandle.close()
        }
        return configuredPath
      }
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = path.join(tmpdir(), `daw-browser-${bytesToHex(nodeRandomBytes(32))}`)
        try {
          await fileSystem.mkdir(candidate, { mode: 0o700 })
          return candidate
        } catch (error) {
          if (!(error instanceof Error) || !isNodeError(error) || error.code !== "EEXIST") throw error
        }
      }
      throw new Error("Unable to reserve a private temporary output directory.")
    })()
    return temporaryDirectoryPromise
  }

  const nextTempPath = async () => {
    const parentPath = await temporaryDirectory()
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const tempPath = path.join(parentPath, `.daw-browser-${bytesToHex(randomBytes(32))}.tmp`)
      try {
        const handle = await fileSystem.open(
          tempPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
          0o600,
        )
        return { tempPath, handle }
      } catch (error) {
        if (!(error instanceof Error) || !isNodeError(error) || error.code !== "EEXIST") throw error
      }
    }
    throw new Error("Unable to reserve a unique temporary output file.")
  }

  const requireWriter = async (scope: FileCapabilityScope, writerId: string) => {
    const writer = writers.get(writerId)
    if (!writer) {
      throw new FileCapabilityError("invalid-capability", "The output writer is not active.")
    }
    const capability = await requireCapability(scope, writer.capabilityToken)
    return { writer, capability }
  }

  return {
    async grantReadFile(scope: FileCapabilityScope, filePath: string): Promise<ReadCapabilityDescriptor> {
      const reservation = reserveCapacity(scope, 1)
      try {
        await pruneExpired()
        const { byteLength, mime, device, inode } = await validateReadFile(filePath)
        reservation.assertActive()
        const capability: ReadCapability = {
          ...createBase(scope),
          kind: "read",
          filePath,
          byteLength,
          mime,
          device,
          inode,
        }
        capabilities.set(capability.token, capability)
        return { token: capability.token, basename: path.basename(filePath), byteLength, mime }
      } finally {
        reservation.release()
      }
    },

    async grantOutputFile(scope: FileCapabilityScope, filePath: string): Promise<WriteCapabilityDescriptor> {
      const reservation = reserveCapacity(scope, 1)
      try {
        await pruneExpired()
        requireAbsoluteNormalizedPath(filePath)
        const mime = mimeForPath(filePath)
        const outputGrant = await nativeOutputGrant(filePath, false)
        reservation.assertActive()
        const capability: WriteCapability = {
          ...createBase(scope),
          kind: "write",
          filePath,
          mime,
          allowOverwrite: false,
          outputGrant,
          retainedOpen: false,
        }
        capabilities.set(capability.token, capability)
        return { token: capability.token, basename: path.basename(filePath), mime }
      } finally {
        reservation.release()
      }
    },

    async grantDirectory(scope: FileCapabilityScope, directoryPath: string): Promise<DirectoryCapabilityDescriptor> {
      const reservation = reserveCapacity(scope, 1)
      try {
        await pruneExpired()
        const realDirectoryPath = await validateDirectory(directoryPath)
        const identity = await nativeDirectoryGrant(realDirectoryPath)
        reservation.assertActive()
        const capability: DirectoryCapability = { ...createBase(scope), kind: "directory", directoryPath: realDirectoryPath, identity }
        capabilities.set(capability.token, capability)
        return { token: capability.token, basename: path.basename(realDirectoryPath) }
      } finally {
        reservation.release()
      }
    },

    async pickReadFiles(scope: FileCapabilityScope): Promise<FilePickerResult> {
      const reservation = reserveCapacity(scope, 1)
      try {
        await pruneExpired()
        const selection = await dialog.showOpenDialog({
          properties: ["openFile"],
          filters: [audioDialogFilter],
        })
        if (selection.canceled || selection.filePaths.length === 0) return { canceled: true }
        const filePath = selection.filePaths[0]
        const validated = [{ filePath, ...await validateReadFile(filePath) }]
        reservation.assertActive()
        const files = validated.map(({ filePath, byteLength, mime, device, inode }) => {
          const capability: ReadCapability = {
            ...createBase(scope),
            kind: "read",
            filePath,
            byteLength,
            mime,
            device,
            inode,
          }
          capabilities.set(capability.token, capability)
          return {
            token: capability.token,
            basename: path.basename(filePath),
            byteLength,
            mime,
          }
        })
        return { canceled: false, files }
      } finally {
        reservation.release()
      }
    },

    async pickOutputFile(scope: FileCapabilityScope, format?: MixdownFormat): Promise<OutputPickerResult> {
      const reservation = reserveCapacity(scope, 1)
      try {
        await pruneExpired()
        const selection = await dialog.showSaveDialog({ filters: [format ? outputFilterForFormat(format) : audioDialogFilter] })
        if (selection.canceled || selection.filePath === undefined) return { canceled: true }
        if (format && !outputExtensionMatchesFormat(format, selection.filePath)) {
          throw new FileCapabilityError("unsupported-file", "The selected output extension does not match the requested format.")
        }
        requireAbsoluteNormalizedPath(selection.filePath)
        const mime = mimeForPath(selection.filePath)
        const outputGrant = await nativeOutputGrant(selection.filePath, true)
        let capability: WriteCapability
        try {
          reservation.assertActive()
          capability = {
            ...createBase(scope),
            kind: "write",
            filePath: selection.filePath,
            mime,
            allowOverwrite: true,
            outputGrant,
            retainedOpen: outputGrant.retained !== undefined,
          }
        } catch (error) {
          await outputGrant.retained?.handle.close()
          throw error
        }
        capabilities.set(capability.token, capability)
        return {
          canceled: false,
          file: {
            token: capability.token,
            basename: path.basename(capability.filePath),
            mime,
          },
        }
      } finally {
        reservation.release()
      }
    },

    async pickDirectory(scope: FileCapabilityScope): Promise<DirectoryPickerResult> {
      const reservation = reserveCapacity(scope, 1)
      try {
        await pruneExpired()
        const selection = await dialog.showOpenDialog({ properties: ["openDirectory"] })
        if (selection.canceled || selection.filePaths.length === 0) return { canceled: true }
        const directoryPath = await validateDirectory(selection.filePaths[0])
        const identity = await nativeDirectoryGrant(directoryPath)
        reservation.assertActive()
        const capability: DirectoryCapability = {
          ...createBase(scope),
          kind: "directory",
          directoryPath,
          identity,
        }
        capabilities.set(capability.token, capability)
        return {
          canceled: false,
          directory: {
            token: capability.token,
            basename: path.basename(directoryPath),
          },
        }
      } finally {
        reservation.release()
      }
    },

    async readFile(scope: FileCapabilityScope, token: string) {
      const capability = await requireCapability(scope, token)
      if (capability.kind !== "read") {
        throw new FileCapabilityError("invalid-capability", "The capability does not permit reads.")
      }
      const current = await validateReadFile(capability.filePath)
      if (
        current.byteLength !== capability.byteLength
        || current.mime !== capability.mime
        || current.device !== capability.device
        || current.inode !== capability.inode
      ) {
        throw new FileCapabilityError("unsupported-file", "The selected file changed after access was granted.")
      }
      const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
      const handle = await fileSystem.open(capability.filePath, constants.O_RDONLY | noFollow)
      try {
        const status = await handle.stat()
        if (
          !status.isFile()
          || status.size !== capability.byteLength
          || status.dev !== capability.device
          || status.ino !== capability.inode
        ) {
          throw new FileCapabilityError("unsupported-file", "The selected file changed after access was granted.")
        }
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    },

    async beginWrite(scope: FileCapabilityScope, token: string, relativePath?: string) {
      const capability = await requireCapability(scope, token)
      if (capability.kind === "read") {
        throw new FileCapabilityError("invalid-capability", "The capability does not permit writes.")
      }
      if (
        capability.outputFiles + capability.reservedWriterSlots >= (capability.kind === "write" ? 1 : maximumOutputFiles)
        || capability.writerIds.size + capability.reservedWriterSlots >= 1
      ) {
        throw new FileCapabilityError("file-count-exceeded", "The output file limit was reached.")
      }
      capability.reservedWriterSlots += 1
      try {
        let finalPath: string
        let target: Writer["target"]
        if (capability.kind === "write") {
          if (relativePath !== undefined) invalidPath("A fixed output capability does not accept a relative path.")
          finalPath = capability.filePath
          target = {
            kind: "file",
            filePath: capability.filePath,
            allowOverwrite: capability.allowOverwrite,
            grant: capability.outputGrant,
          }
        } else {
          if (relativePath === undefined) {
            throw new FileCapabilityError("invalid-path", "A directory output capability requires a relative path.")
          }
          requireRelativeNormalizedPath(relativePath)
          finalPath = path.join(capability.directoryPath, relativePath)
          mimeForPath(finalPath)
          target = {
            kind: "directory",
            rootPath: capability.directoryPath,
            root: capability.identity,
            relativePath,
          }
        }
        const { tempPath, handle } = await nextTempPath()
        if (capabilities.get(capability.token) !== capability) {
          await handle.close()
          await removeTempFile(tempPath)
          throw new FileCapabilityError("invalid-capability", "The output capability was revoked during writer setup.")
        }
        const id = uniqueOpaqueId(writers)
        const writer: Writer = {
          id,
          capabilityToken: capability.token,
          finalPath,
          tempPath,
          handle,
          highWaterMark: 0,
          closed: false,
          poisoned: false,
          operation: Promise.resolve(),
          state: "open",
          target,
        }
        writers.set(id, writer)
        capability.writerIds.add(id)
        capability.outputFiles += 1
        return { writerId: id }
      } finally {
        capability.reservedWriterSlots -= 1
      }
    },

    async writeChunk(scope: FileCapabilityScope, writerId: string, offset: number, chunk: Uint8Array) {
      const { writer, capability } = await requireWriter(scope, writerId)
      if (writer.state !== "open" || writer.poisoned) {
        throw new FileCapabilityError("invalid-capability", "The output writer is not open.")
      }
      if (
        !Number.isSafeInteger(offset)
        || offset < 0
        || chunk.byteLength === 0
        || chunk.byteLength > maximumChunkBytes
      ) {
        writer.poisoned = true
        throw new FileCapabilityError("invalid-chunk", "Output chunks must be non-empty, at most 1 MiB, and write within or at the end of the output.")
      }
      const write = writer.operation.then(async () => {
        if (writer.closed || writer.poisoned || offset > writer.highWaterMark) {
          writer.poisoned = true
          throw new FileCapabilityError("invalid-chunk", "The output writer changed before the chunk could be written.")
        }
        const nextOffset = offset + chunk.byteLength
        const additionalBytes = Math.max(0, nextOffset - writer.highWaterMark)
        if (capability.outputBytes + capability.reservedOutputBytes + additionalBytes > maximumOutputBytes) {
          writer.poisoned = true
          throw new FileCapabilityError("output-limit-exceeded", "The aggregate output limit of 8 GiB was reached.")
        }
        capability.reservedOutputBytes += additionalBytes
        try {
          let written = 0
          while (written < chunk.byteLength) {
            const result = await writer.handle.write(
              chunk,
              written,
              chunk.byteLength - written,
              offset + written,
            )
            if (result.bytesWritten <= 0) throw new Error("The output file did not accept the chunk.")
            written += result.bytesWritten
          }
          capability.outputBytes += additionalBytes
          writer.highWaterMark = Math.max(writer.highWaterMark, nextOffset)
          return nextOffset
        } catch (error) {
          writer.poisoned = true
          throw error
        } finally {
          capability.reservedOutputBytes -= additionalBytes
        }
      })
      writer.operation = write.then(() => undefined, () => undefined)
      return { nextOffset: await write }
    },

    async commitWrite(scope: FileCapabilityScope, writerId: string) {
      const { writer } = await requireWriter(scope, writerId)
      if (writer.state !== "open" || writer.closed || writer.poisoned) {
        throw new FileCapabilityError("invalid-capability", "The output writer is already closed.")
      }
      writer.state = "committing"
      const commitPromise = (async (): Promise<CommittedOutput> => {
        try {
          await writer.operation
          if (writer.poisoned) {
            throw new FileCapabilityError("invalid-capability", "The output writer is poisoned and cannot be committed.")
          }
          await writer.handle.sync()
          await writer.handle.close()
          writer.closed = true
          const helper = useNativeOutput()
          if (writer.target.kind === "directory") {
            await helper.commitDirectory({
              rootPath: writer.target.rootPath,
              root: writer.target.root,
              relativePath: writer.target.relativePath,
              tempPath: writer.tempPath,
            })
          } else {
            if (writer.target.allowOverwrite && writer.target.grant.retained) {
              await helper.commitRetainedFile({
                retained: writer.target.grant.retained,
                tempPath: writer.tempPath,
              })
            } else {
              await helper.commitFile({
                parentPath: path.dirname(writer.target.filePath),
                parent: writer.target.grant.parent,
                basename: writer.target.grant.basename,
                tempPath: writer.tempPath,
              })
            }
          }
          await removeTempFile(writer.tempPath)
          return {
            basename: path.basename(writer.finalPath),
            byteLength: writer.highWaterMark,
            mime: mimeForPath(writer.finalPath),
          }
        } catch (error) {
          try {
            await cleanupPrivateWriter(writer)
          } catch {
            // Preserve the commit result while still attempting all private cleanup.
          }
          if (error instanceof NativeFileCapabilityError) nativeError(error)
          throw error
        } finally {
          try {
            const capability = capabilities.get(writer.capabilityToken)
            if (capability) {
              try {
                await closeRetainedFile(capability)
              } finally {
                retireRetainedCapability(capability)
              }
            }
          } finally {
            writer.state = "terminal"
            releaseWriter(writer)
          }
        }
      })()
      writer.commitPromise = commitPromise
      return commitPromise
    },

    async abortWrite(scope: FileCapabilityScope, writerId: string) {
      const { writer } = await requireWriter(scope, writerId)
      await startAbortWriter(writer)
    },

    async revoke(token: string) {
      const capability = capabilities.get(token)
      if (capability) await removeCapability(capability)
    },

    async revokeRendererGeneration(rendererGeneration: number) {
      const pending = revokePendingGrants(
        (reservationScope) => reservationScope.rendererGeneration === rendererGeneration,
      )
      const matching = [...capabilities.values()].filter(
        (capability) => capability.rendererGeneration === rendererGeneration,
      )
      for (const capability of matching) await removeCapability(capability)
      await pending
    },

    async revokeRequest(scope: FileCapabilityScope) {
      const pending = revokePendingGrants(
        (reservationScope) =>
          reservationScope.requestId === scope.requestId
          && reservationScope.rendererGeneration === scope.rendererGeneration,
      )
      const matching = [...capabilities.values()].filter(
        (capability) => capability.requestId === scope.requestId && capability.rendererGeneration === scope.rendererGeneration,
      )
      for (const capability of matching) await removeCapability(capability)
      await pending
    },

    async revokeAll() {
      const pending = revokePendingGrants(() => true)
      const active = [...capabilities.values()]
      for (const capability of active) await removeCapability(capability)
      await pending
    },

    activeCapabilityCount() {
      return [...capabilities.values()].filter((capability) => !capability.revoked).length
    },
  }
}
