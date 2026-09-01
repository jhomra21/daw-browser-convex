import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import * as nodeFileSystem from "node:fs/promises"
import { mkdtemp, mkdir, open, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  FileCapabilityError,
  createFileCapabilityManager as createNativeFileCapabilityManager,
} from "./file-capabilities"
import {
  NativeFileCapabilityError,
  createNativeFileCapabilityHelper,
  type NativeFileCapabilityHelper,
} from "./native-file-capability-helper"

type OpenSelection = {
  canceled: boolean
  filePaths: string[]
}

type SaveSelection = {
  canceled: boolean
  filePath?: string
}

const temporaryDirectories: string[] = []
const run = promisify(execFile)
let compilerDirectory = ""
let nativeHelper: NativeFileCapabilityHelper

beforeAll(async () => {
  compilerDirectory = await mkdtemp(path.join(tmpdir(), "daw-file-capability-helper-"))
  const executable = path.join(compilerDirectory, "file-capability-helper")
  const platformDefinition = process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_GNU_SOURCE"
  await run("clang", [
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    platformDefinition,
    path.join(import.meta.dirname, "native", "file-capability-helper.c"),
    "-o",
    executable,
  ])
  nativeHelper = createNativeFileCapabilityHelper(executable)
  expect(await nativeHelper.selfTest()).toBe(true)
})

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

afterAll(async () => {
  if (compilerDirectory) await rm(compilerDirectory, { recursive: true, force: true })
})

const createFileCapabilityManager = (
  options: Parameters<typeof createNativeFileCapabilityManager>[0],
) => createNativeFileCapabilityManager({
  ...options,
  nativeHelper: options.nativeHelper ?? nativeHelper,
  nativeOutputEnabled: options.nativeOutputEnabled ?? (() => true),
})

const createTemporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-file-capabilities-"))
  temporaryDirectories.push(directory)
  return realpath(directory)
}

const createDeterministicRandom = () => {
  let value = 0
  return (length: number) => {
    value += 1
    return new Uint8Array(length).fill(value)
  }
}

const createDialog = (
  openSelections: OpenSelection[] = [],
  saveSelections: SaveSelection[] = [],
) => ({
  showOpenDialog: async () => openSelections.shift() ?? { canceled: true, filePaths: [] },
  showSaveDialog: async () => saveSelections.shift() ?? { canceled: true },
})

const scope = {
  requestId: "request-1",
  rendererGeneration: 7,
}

const expectCapabilityError = async (
  operation: Promise<unknown>,
  code: FileCapabilityError["code"],
) => {
  try {
    await operation
    throw new Error(`Expected a ${code} file capability error.`)
  } catch (error) {
    expect(error).toBeInstanceOf(FileCapabilityError)
    if (error instanceof FileCapabilityError) expect(error.code).toBe(code)
  }
}

describe("desktop file capability manager", () => {
  test("returns cancellation without issuing capabilities", async () => {
    const manager = createFileCapabilityManager({
      dialog: createDialog(
        [{ canceled: true, filePaths: ["/ignored.wav"] }],
        [{ canceled: true, filePath: "/ignored.wav" }],
      ),
      randomBytes: createDeterministicRandom(),
    })

    expect(await manager.pickReadFiles(scope)).toEqual({ canceled: true })
    expect(await manager.pickOutputFile(scope)).toEqual({ canceled: true })
    expect(manager.activeCapabilityCount()).toBe(0)
  })

  test("limits mixdown pickers to the requested format and rejects mismatches", async () => {
    const directory = await createTemporaryDirectory()
    const selectedPath = path.join(directory, "mix.mp3")
    const manager = createFileCapabilityManager({
      dialog: createDialog([], [{ canceled: false, filePath: selectedPath }]),
      randomBytes: createDeterministicRandom(),
    })
    await expectCapabilityError(manager.pickOutputFile(scope, "wav"), "unsupported-file")
    expect(manager.activeCapabilityCount()).toBe(0)
  })

  test("issues opaque scoped read descriptors and reads the selected file", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, "kick.WAV")
    const contents = new Uint8Array([1, 2, 3, 4])
    await writeFile(filePath, contents)
    const manager = createFileCapabilityManager({
      dialog: createDialog([{ canceled: false, filePaths: [filePath] }]),
      randomBytes: createDeterministicRandom(),
    })

    const result = await manager.pickReadFiles(scope)

    expect(result.canceled).toBe(false)
    if (result.canceled) throw new Error("Expected a selected file.")
    const descriptor = result.files[0]
    expect(Object.keys(descriptor).sort()).toEqual(["basename", "byteLength", "mime", "token"])
    expect(descriptor).toMatchObject({
      basename: "kick.WAV",
      byteLength: contents.byteLength,
      mime: "audio/wav",
    })
    expect(descriptor.token).toMatch(/^[0-9a-f]{64}$/)
    expect(await manager.readFile(scope, descriptor.token)).toEqual(Buffer.from(contents))
    await expectCapabilityError(
      manager.readFile({ ...scope, requestId: "request-2" }, descriptor.token),
      "invalid-scope",
    )
    await expectCapabilityError(
      manager.beginWrite(scope, descriptor.token),
      "invalid-capability",
    )
  })

  test("rejects unsupported, oversized, and symbolic-link read selections", async () => {
    const directory = await createTemporaryDirectory()
    const unsupportedPath = path.join(directory, "notes.txt")
    const oversizedPath = path.join(directory, "long.wav")
    const targetPath = path.join(directory, "target.wav")
    const symbolicPath = path.join(directory, "symbolic.wav")
    await writeFile(unsupportedPath, "notes")
    await writeFile(oversizedPath, new Uint8Array(10 * 1024 * 1024 + 1))
    await writeFile(targetPath, "audio")
    await symlink(targetPath, symbolicPath)

    const manager = createFileCapabilityManager({
      dialog: createDialog([
        { canceled: false, filePaths: [unsupportedPath] },
        { canceled: false, filePaths: [oversizedPath] },
        { canceled: false, filePaths: [symbolicPath] },
      ]),
      randomBytes: createDeterministicRandom(),
    })

    await expectCapabilityError(manager.pickReadFiles(scope), "unsupported-file")
    await expectCapabilityError(manager.pickReadFiles(scope), "unsupported-file")
    await expectCapabilityError(manager.pickReadFiles(scope), "unsupported-file")
    expect(manager.activeCapabilityCount()).toBe(0)
  })

  test("expires capabilities after four hours and enforces the active limit", async () => {
    const directory = await createTemporaryDirectory()
    const filePaths = await Promise.all(Array.from({ length: 17 }, async (_unused, index) => {
      const filePath = path.join(directory, `${index}.wav`)
      await writeFile(filePath, `${index}`)
      return filePath
    }))
    let now = 100
    const manager = createFileCapabilityManager({
      dialog: createDialog([
        { canceled: false, filePaths: filePaths.slice(0, 16) },
        { canceled: false, filePaths: [filePaths[16]] },
        { canceled: false, filePaths: [filePaths[16]] },
      ]),
      now: () => now,
      randomBytes: createDeterministicRandom(),
    })

    const concurrent = await Promise.allSettled(filePaths.map((filePath, index) =>
      manager.grantReadFile({ ...scope, requestId: `request-${index}` }, filePath)))
    const first = concurrent.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    expect(first).toHaveLength(16)
    const rejected = concurrent.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toBeInstanceOf(FileCapabilityError)
    if (rejected[0] instanceof FileCapabilityError) expect(rejected[0].code).toBe("capacity-exceeded")
    expect(manager.activeCapabilityCount()).toBe(16)
    await expectCapabilityError(manager.grantReadFile(scope, filePaths[16]), "capacity-exceeded")

    now += 4 * 60 * 60 * 1_000
    await expectCapabilityError(manager.readFile({ ...scope, requestId: "request-0" }, first[0].token), "expired")

    await manager.grantReadFile(scope, filePaths[16])
    expect(manager.activeCapabilityCount()).toBe(1)
  })

  test("writes ordered bounded chunks through an exclusive temporary file and commits", async () => {
    const directory = await createTemporaryDirectory()
    const outputPath = path.join(directory, "mix.flac")
    const manager = createFileCapabilityManager({
      dialog: createDialog([], [{ canceled: false, filePath: outputPath }]),
      randomBytes: createDeterministicRandom(),
    })
    const selection = await manager.pickOutputFile(scope)
    if (selection.canceled) throw new Error("Expected an output selection.")

    const { writerId } = await manager.beginWrite(scope, selection.file.token)
    expect(await manager.writeChunk(scope, writerId, 0, new Uint8Array([1, 2, 3]))).toEqual({
      nextOffset: 3,
    })
    expect(await manager.writeChunk(scope, writerId, 2, new Uint8Array([9]))).toEqual({
      nextOffset: 3,
    })
    await expectCapabilityError(
      manager.writeChunk(scope, writerId, 3, new Uint8Array(1024 * 1024 + 1)),
      "invalid-chunk",
    )
    await expectCapabilityError(
      manager.writeChunk(scope, writerId, 3, new Uint8Array([4])),
      "invalid-capability",
    )
    await expectCapabilityError(manager.commitWrite(scope, writerId), "invalid-capability")
    await manager.abortWrite(scope, writerId)
    expect(await readdir(directory)).toEqual([])

    const retryCapability = await manager.grantOutputFile(scope, outputPath)
    const retry = await manager.beginWrite(scope, retryCapability.token)
    expect(await manager.writeChunk(scope, retry.writerId, 0, new Uint8Array([1, 2, 9, 4, 5]))).toEqual({
      nextOffset: 5,
    })

    expect(await manager.commitWrite(scope, retry.writerId)).toEqual({
      basename: "mix.flac",
      byteLength: 5,
      mime: "audio/flac",
    })
    expect(await readFile(outputPath)).toEqual(Buffer.from([1, 2, 9, 4, 5]))
    expect(await readdir(directory)).toEqual(["mix.flac"])
  })

  test("streams sequential sparse output beyond 8 GiB without allocating the hole", async () => {
    const directory = await createTemporaryDirectory()
    const outputPath = path.join(directory, "large.wav")
    const chunkSize = 1024 * 1024
    const formerLimit = 8 * 1024 * 1024 * 1024
    const finalOffset = formerLimit + 2 * chunkSize
    const writes: { offset: number; length: number }[] = []
    const temporaryFileFlags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)
    const fileSystem: NonNullable<Parameters<typeof createNativeFileCapabilityManager>[0]["fileSystem"]> = {
      ...nodeFileSystem,
      open: async (
        filePath: Parameters<typeof nodeFileSystem.open>[0],
        flags: Parameters<typeof nodeFileSystem.open>[1],
        mode?: Parameters<typeof nodeFileSystem.open>[2],
      ): Promise<FileHandle> => {
        if (flags === temporaryFileFlags) {
          const backing = await open("/dev/null", "r+")
          const write = async <TBuffer extends NodeJS.ArrayBufferView>(
            buffer: TBuffer,
            offset?: number | null,
            length?: number | null,
            position?: number | null,
          ) => {
            const bytesWritten = length ?? buffer.byteLength - (offset ?? 0)
            if (position !== null) writes.push({ offset: position ?? 0, length: bytesWritten })
            return { buffer, bytesWritten }
          }
          return new Proxy(backing, {
            get: (target, property) => {
              if (property === "write") return write
              if (property === "close") return target.close.bind(target)
              if (property === "sync") return target.sync.bind(target)
              return undefined
            },
          })
        }
        return await nodeFileSystem.open(filePath, flags, mode)
      },
    }
    const manager = createFileCapabilityManager({
      dialog: createDialog(),
      fileSystem,
      randomBytes: createDeterministicRandom(),
    })
    const capability = await manager.grantOutputFile(scope, outputPath)
    const writer = await manager.beginWrite(scope, capability.token)
    const chunk = new Uint8Array(chunkSize)
    try {
      for (let offset = 0; offset < finalOffset; offset += chunkSize) {
        await manager.writeChunk(scope, writer.writerId, offset, chunk)
      }
      expect(writes.at(-1)).toEqual({ offset: finalOffset - chunkSize, length: chunkSize })
      expect(writes).toHaveLength(finalOffset / chunkSize)
      expect(await readdir(directory)).toEqual([])
    } finally {
      await manager.abortWrite(scope, writer.writerId)
    }
  })

  test("confines directory outputs and removes partial files on abort and revoke", async () => {
    const directory = await createTemporaryDirectory()
    const nestedDirectory = path.join(directory, "nested")
    await mkdir(nestedDirectory)
    const manager = createFileCapabilityManager({
      dialog: createDialog([{ canceled: false, filePaths: [directory] }]),
      randomBytes: createDeterministicRandom(),
    })
    const selection = await manager.pickDirectory(scope)
    if (selection.canceled) throw new Error("Expected a directory selection.")

    await expectCapabilityError(
      manager.beginWrite(scope, selection.directory.token, `..${path.sep}escape.wav`),
      "invalid-path",
    )
    await expectCapabilityError(
      manager.beginWrite(scope, selection.directory.token, "unsupported.txt"),
      "unsupported-file",
    )

    const first = await manager.beginWrite(
      scope,
      selection.directory.token,
      path.join("nested", "first.ogg"),
    )
    await manager.writeChunk(scope, first.writerId, 0, new Uint8Array([1]))
    await manager.abortWrite(scope, first.writerId)
    expect(await readdir(nestedDirectory)).toEqual([])

    const second = await manager.beginWrite(
      scope,
      selection.directory.token,
      path.join("nested", "second.webm"),
    )
    await manager.writeChunk(scope, second.writerId, 0, new Uint8Array([2]))
    await manager.revoke(selection.directory.token)
    expect(await readdir(nestedDirectory)).toEqual([])
    expect(manager.activeCapabilityCount()).toBe(0)
  })

  test("rejects existing output paths and revokes a renderer generation", async () => {
    const directory = await createTemporaryDirectory()
    const existingPath = path.join(directory, "existing.mp3")
    const availablePath = path.join(directory, "available.m4a")
    await writeFile(existingPath, "existing")
    const manager = createFileCapabilityManager({
      dialog: createDialog(
        [{ canceled: false, filePaths: [directory] }],
        [
          { canceled: false, filePath: existingPath },
          { canceled: false, filePath: availablePath },
        ],
      ),
      randomBytes: createDeterministicRandom(),
    })

    await expectCapabilityError(manager.grantOutputFile(scope, existingPath), "path-exists")
    const output = await manager.pickOutputFile(scope)
    const directorySelection = await manager.pickDirectory(scope)
    expect(output.canceled).toBe(false)
    expect(directorySelection.canceled).toBe(false)
    expect(manager.activeCapabilityCount()).toBe(2)

    await manager.revokeRendererGeneration(scope.rendererGeneration)
    expect(manager.activeCapabilityCount()).toBe(0)
  })

  test("canonicalizes symlinked output parents before granting a file", async () => {
    const directory = await createTemporaryDirectory()
    const alias = path.join(directory, "alias")
    await symlink(directory, alias)
    const manager = createFileCapabilityManager({
      dialog: createDialog(),
      randomBytes: createDeterministicRandom(),
    })

    const capability = await manager.grantOutputFile(scope, path.join(alias, "mix.wav"))
    const writer = await manager.beginWrite(scope, capability.token)
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([1, 2, 3]))
    expect(await manager.commitWrite(scope, writer.writerId)).toEqual({
      basename: "mix.wav",
      byteLength: 3,
      mime: "audio/wav",
    })
    expect(await readFile(path.join(directory, "mix.wav"))).toEqual(Buffer.from([1, 2, 3]))
  })

  test("releases terminal import capabilities so sequential imports cannot exhaust capacity", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, "input.wav")
    await writeFile(filePath, "audio")
    const manager = createFileCapabilityManager({
      dialog: createDialog(),
      randomBytes: createDeterministicRandom(),
    })
    for (let index = 0; index < 16; index += 1) {
      const capability = await manager.grantReadFile({ ...scope, requestId: `request-${index}` }, filePath)
      await manager.revoke(capability.token)
    }
    expect(manager.activeCapabilityCount()).toBe(0)
  })

  test("revocation waits for and cancels a matching in-flight grant", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, "pending.wav")
    await writeFile(filePath, "audio")
    let releaseSelection: () => void = () => {}
    let markSelectionStarted: () => void = () => {}
    const selectionGate = new Promise<void>((resolve) => {
      releaseSelection = resolve
    })
    const selectionStarted = new Promise<void>((resolve) => {
      markSelectionStarted = resolve
    })
    const manager = createFileCapabilityManager({
      dialog: {
        showOpenDialog: async () => {
          markSelectionStarted()
          await selectionGate
          return { canceled: false, filePaths: [filePath] }
        },
        showSaveDialog: async () => ({ canceled: true }),
      },
      randomBytes: createDeterministicRandom(),
    })

    const grant = manager.pickReadFiles(scope)
    await selectionStarted
    let revokeSettled = false
    const revoke = manager.revokeRequest(scope).then(() => {
      revokeSettled = true
    })
    await Promise.resolve()
    expect(revokeSettled).toBe(false)

    releaseSelection()
    await expectCapabilityError(grant, "invalid-capability")
    await revoke
    expect(revokeSettled).toBe(true)
    expect(manager.activeCapabilityCount()).toBe(0)
  })

  test("reserves an asynchronous grant before immediate revocation can inspect it", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, "pending.wav")
    await writeFile(filePath, "audio")
    let releaseSelection: () => void = () => {}
    const selectionGate = new Promise<void>((resolve) => {
      releaseSelection = resolve
    })
    const manager = createFileCapabilityManager({
      dialog: {
        showOpenDialog: async () => {
          await selectionGate
          return { canceled: false, filePaths: [filePath] }
        },
        showSaveDialog: async () => ({ canceled: true }),
      },
      randomBytes: createDeterministicRandom(),
    })

    const grant = manager.pickReadFiles(scope)
    const revoke = manager.revokeRequest(scope)
    releaseSelection()

    await expectCapabilityError(grant, "invalid-capability")
    await revoke
    expect(manager.activeCapabilityCount()).toBe(0)
  })

  test("rejects a read path swapped to a symbolic link after capability grant", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, "input.wav")
    const targetPath = path.join(directory, "target.wav")
    await writeFile(filePath, "audio")
    await writeFile(targetPath, "other")
    const manager = createFileCapabilityManager({ dialog: createDialog(), randomBytes: createDeterministicRandom() })
    const capability = await manager.grantReadFile(scope, filePath)
    await rm(filePath)
    await symlink(targetPath, filePath)
    await expectCapabilityError(manager.readFile(scope, capability.token), "unsupported-file")
  })

  test("fails a no-replace commit race without overwriting the destination", async () => {
    const directory = await createTemporaryDirectory()
    const outputPath = path.join(directory, "mix.wav")
    const manager = createFileCapabilityManager({ dialog: createDialog(), randomBytes: createDeterministicRandom() })
    const output = await manager.grantOutputFile(scope, outputPath)
    const { writerId } = await manager.beginWrite(scope, output.token)
    await manager.writeChunk(scope, writerId, 0, new Uint8Array([1]))
    await writeFile(outputPath, "original")
    await expectCapabilityError(manager.commitWrite(scope, writerId), "path-exists")
    expect(await readFile(outputPath, "utf8")).toBe("original")
  })

  test("reserves a fixed-file writer before asynchronous setup", async () => {
    const directory = await createTemporaryDirectory()
    const manager = createFileCapabilityManager({ dialog: createDialog(), randomBytes: createDeterministicRandom() })
    const capability = await manager.grantOutputFile(scope, path.join(directory, "reserved.wav"))
    const first = manager.beginWrite(scope, capability.token)
    await expectCapabilityError(manager.beginWrite(scope, capability.token), "file-count-exceeded")
    await manager.abortWrite(scope, (await first).writerId)
  })

  test("reserves the single directory writer before asynchronous setup", async () => {
    const directory = await createTemporaryDirectory()
    const manager = createFileCapabilityManager({ dialog: createDialog(), randomBytes: createDeterministicRandom() })
    const capability = await manager.grantDirectory(scope, directory)

    const first = manager.beginWrite(scope, capability.token, "first.wav")
    await expectCapabilityError(
      manager.beginWrite(scope, capability.token, "second.wav"),
      "file-count-exceeded",
    )
    await manager.abortWrite(scope, (await first).writerId)
  })

  test("poisons an out-of-order writer and rejects commit until private cleanup", async () => {
    const directory = await createTemporaryDirectory()
    const privateTemp = path.join(directory, "private")
    const outputPath = path.join(directory, "poisoned.wav")
    const manager = createFileCapabilityManager({
      dialog: createDialog(),
      privateTempDirectory: privateTemp,
      randomBytes: createDeterministicRandom(),
    })
    const capability = await manager.grantOutputFile(scope, outputPath)
    const writer = await manager.beginWrite(scope, capability.token)

    await expectCapabilityError(
      manager.writeChunk(scope, writer.writerId, 1, new Uint8Array([1])),
      "invalid-chunk",
    )
    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "invalid-capability")
    await manager.abortWrite(scope, writer.writerId)

    expect(await readdir(directory)).toEqual(["private"])
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("waits for an in-flight native commit before revocation completes", async () => {
    const directory = await createTemporaryDirectory()
    const privateTemp = path.join(directory, "private")
    const outputPath = path.join(directory, "delayed.wav")
    let commitFinished = false
    let releaseCommit: () => void = () => {}
    let markCommitStarted: () => void = () => {}
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve
    })
    const delayedHelper: NativeFileCapabilityHelper = {
      ...nativeHelper,
      commitFile: async () => {
        markCommitStarted()
        await commitGate
        await writeFile(outputPath, "published")
        commitFinished = true
      },
    }
    const manager = createFileCapabilityManager({
      dialog: createDialog(),
      nativeHelper: delayedHelper,
      privateTempDirectory: privateTemp,
      randomBytes: createDeterministicRandom(),
    })
    const capability = await manager.grantOutputFile(scope, outputPath)
    const writer = await manager.beginWrite(scope, capability.token)
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([1]))

    const commit = manager.commitWrite(scope, writer.writerId)
    await commitStarted
    let revokeSettled = false
    const revoke = manager.revoke(capability.token).then(() => {
      revokeSettled = true
    })
    await Promise.resolve()

    expect(revokeSettled).toBe(false)
    expect(await readdir(directory)).toEqual(["private"])
    releaseCommit()
    await commit
    await revoke
    expect(revokeSettled).toBe(true)
    expect(commitFinished).toBe(true)
    expect(await readFile(outputPath, "utf8")).toBe("published")
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("prevents a commit from starting after revocation completes", async () => {
    const directory = await createTemporaryDirectory()
    const outputPath = path.join(directory, "revoked.wav")
    let commitCalls = 0
    const observingHelper: NativeFileCapabilityHelper = {
      ...nativeHelper,
      commitFile: async () => {
        commitCalls += 1
      },
    }
    const manager = createFileCapabilityManager({
      dialog: createDialog(),
      nativeHelper: observingHelper,
      randomBytes: createDeterministicRandom(),
    })
    const capability = await manager.grantOutputFile(scope, outputPath)
    const writer = await manager.beginWrite(scope, capability.token)

    await manager.revoke(capability.token)
    await expectCapabilityError(
      manager.commitWrite(scope, writer.writerId),
      "invalid-capability",
    )
    expect(commitCalls).toBe(0)
    expect(await readdir(directory)).toEqual([])
  })

  test("preserves a destination and exposes an indeterminate native commit distinctly", async () => {
    const directory = await createTemporaryDirectory()
    const outputPath = path.join(directory, "indeterminate.wav")
    const privateTemp = path.join(directory, "private")
    const indeterminateHelper: NativeFileCapabilityHelper = {
      ...nativeHelper,
      commitFile: async () => {
        await writeFile(outputPath, "uncertain")
        throw new NativeFileCapabilityError("commit-indeterminate")
      },
    }
    const manager = createFileCapabilityManager({
      dialog: createDialog(),
      nativeHelper: indeterminateHelper,
      privateTempDirectory: privateTemp,
      randomBytes: createDeterministicRandom(),
    })
    const capability = await manager.grantOutputFile(scope, outputPath)
    const writer = await manager.beginWrite(scope, capability.token)
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([1]))

    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "commit-indeterminate")
    expect(await readFile(outputPath, "utf8")).toBe("uncertain")
    expect(await readdir(privateTemp)).toEqual([])
    expect(manager.activeCapabilityCount()).toBe(1)
    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "invalid-capability")
    await expectCapabilityError(manager.abortWrite(scope, writer.writerId), "invalid-capability")
    expect(await readFile(outputPath, "utf8")).toBe("uncertain")
  })
})
