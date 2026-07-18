import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  FileCapabilityError,
  createFileCapabilityManager,
} from "./file-capabilities"
import {
  NativeFileCapabilityError,
  createNativeFileCapabilityHelper,
  type NativeFileCapabilityHelper,
} from "./native-file-capability-helper"

const run = promisify(execFile)
const sourcePath = path.join(import.meta.dirname, "native", "file-capability-helper.c")
const testDirectories: string[] = []
let compilerDirectory = ""
let nativeExecutable = ""
let nativeHelper: NativeFileCapabilityHelper

const scope = {
  requestId: "native-helper-test",
  rendererGeneration: 1,
}

beforeAll(async () => {
  compilerDirectory = await mkdtemp(path.join(tmpdir(), "daw-native-helper-"))
  nativeExecutable = path.join(compilerDirectory, "file-capability-helper")
  const platformDefinition = process.platform === "darwin" ? "-D_DARWIN_C_SOURCE" : "-D_GNU_SOURCE"
  await run("clang", [
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    platformDefinition,
    sourcePath,
    "-o",
    nativeExecutable,
  ])
  nativeHelper = createNativeFileCapabilityHelper(nativeExecutable)
  expect(await nativeHelper.selfTest()).toBe(true)
})

afterEach(async () => {
  for (const directory of testDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

afterAll(async () => {
  if (compilerDirectory) await rm(compilerDirectory, { recursive: true, force: true })
})

const createTestDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daw-native-capability-"))
  testDirectories.push(directory)
  return realpath(directory)
}

const createManager = (privateTempDirectory: string, savePath?: string) => {
  return createFileCapabilityManager({
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => savePath
        ? { canceled: false, filePath: savePath }
        : { canceled: true },
    },
    nativeHelper,
    nativeOutputEnabled: () => true,
    privateTempDirectory,
  })
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

const expectNativeError = async (
  operation: Promise<unknown>,
  code: NativeFileCapabilityError["code"],
) => {
  try {
    await operation
    throw new Error(`Expected a ${code} native helper error.`)
  } catch (error) {
    expect(error).toBeInstanceOf(NativeFileCapabilityError)
    if (error instanceof NativeFileCapabilityError) expect(error.code).toBe(code)
  }
}

describe("native POSIX file capability boundary", () => {
  test("rejects symbolic links in securely walked directory components", async () => {
    const root = await createTestDirectory()
    const realDirectory = path.join(root, "real", "nested")
    await mkdir(realDirectory, { recursive: true })
    await symlink(path.join(root, "real"), path.join(root, "linked"))

    await expectNativeError(
      nativeHelper.statDirectory(path.join(root, "linked", "nested")),
      "invalid-path",
    )
  })

  test("fails closed when the native helper self-test has not enabled output", async () => {
    const root = await createTestDirectory()
    const manager = createFileCapabilityManager({
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
      },
      nativeHelper,
      nativeOutputEnabled: () => false,
      privateTempDirectory: path.join(root, "private"),
    })

    await expectCapabilityError(
      manager.grantOutputFile(scope, path.join(root, "unavailable.wav")),
      "invalid-path",
    )
  })

  test("issues only a private writer and rejects a directory replaced before commit", async () => {
    const root = await createTestDirectory()
    const granted = path.join(root, "granted")
    const original = path.join(root, "original")
    const privateTemp = path.join(root, "private")
    await mkdir(granted)
    const manager = createManager(privateTemp)
    const capability = await manager.grantDirectory(scope, granted)

    await rename(granted, original)
    await mkdir(granted)

    const writer = await manager.beginWrite(scope, capability.token, "attacker.wav")
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([8]))
    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "invalid-path")
    expect(await readdir(granted)).toEqual([])
    expect(await readdir(original)).toEqual([])
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("rejects a nested parent swapped to a symlink after writer setup", async () => {
    const root = await createTestDirectory()
    const granted = path.join(root, "granted")
    const nested = path.join(granted, "nested")
    const originalNested = path.join(granted, "original-nested")
    const attacker = path.join(root, "attacker")
    const privateTemp = path.join(root, "private")
    await mkdir(nested, { recursive: true })
    await mkdir(attacker)
    const manager = createManager(privateTemp)
    const capability = await manager.grantDirectory(scope, granted)
    const writer = await manager.beginWrite(scope, capability.token, path.join("nested", "mix.wav"))
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([1, 2, 3]))

    await rename(nested, originalNested)
    await symlink(attacker, nested)

    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "invalid-path")
    expect(await readdir(attacker)).toEqual([])
    expect(await readdir(originalNested)).toEqual([])
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("rejects a granted directory replaced after writer setup", async () => {
    const root = await createTestDirectory()
    const granted = path.join(root, "granted")
    const original = path.join(root, "original")
    const privateTemp = path.join(root, "private")
    await mkdir(granted)
    const manager = createManager(privateTemp)
    const capability = await manager.grantDirectory(scope, granted)
    const writer = await manager.beginWrite(scope, capability.token, "mix.wav")
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([5]))

    await rename(granted, original)
    await mkdir(granted)

    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "invalid-path")
    expect(await readdir(granted)).toEqual([])
    expect(await readdir(original)).toEqual([])
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("preserves an attacker-created directory destination at commit", async () => {
    const root = await createTestDirectory()
    const privateTemp = path.join(root, "private")
    const manager = createManager(privateTemp)
    const capability = await manager.grantDirectory(scope, root)
    const writer = await manager.beginWrite(scope, capability.token, "race.wav")
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([6]))
    await writeFile(path.join(root, "race.wav"), "attacker")

    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "path-exists")
    expect(await readFile(path.join(root, "race.wav"), "utf8")).toBe("attacker")
    expect(await readdir(privateTemp)).toEqual([])
    expect((await readdir(root)).filter((entry) => entry.startsWith(".daw-browser-"))).toEqual([])
  })

  test("rejects a fixed parent renamed and replaced after grant", async () => {
    const root = await createTestDirectory()
    const parent = path.join(root, "parent")
    const originalParent = path.join(root, "original-parent")
    const privateTemp = path.join(root, "private")
    await mkdir(parent)
    const manager = createManager(privateTemp)
    const capability = await manager.grantOutputFile(scope, path.join(parent, "mix.wav"))
    const writer = await manager.beginWrite(scope, capability.token)
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([4]))

    await rename(parent, originalParent)
    await mkdir(parent)

    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "invalid-path")
    expect(await readdir(parent)).toEqual([])
    expect(await readdir(originalParent)).toEqual([])
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("preserves an attacker-created destination in a no-overwrite race", async () => {
    const root = await createTestDirectory()
    const privateTemp = path.join(root, "private")
    const outputPath = path.join(root, "mix.wav")
    const manager = createManager(privateTemp)
    const capability = await manager.grantOutputFile(scope, outputPath)
    const writer = await manager.beginWrite(scope, capability.token)
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([9]))
    await writeFile(outputPath, "attacker")

    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "path-exists")
    expect(await readFile(outputPath, "utf8")).toBe("attacker")
    expect((await readdir(root)).filter((entry) => entry.startsWith(".daw-browser-"))).toEqual([])
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("uses direct no-replace creation for a picker target that was new at grant", async () => {
    const root = await createTestDirectory()
    const privateTemp = path.join(root, "private")
    const outputPath = path.join(root, "picked.wav")
    const manager = createManager(privateTemp, outputPath)
    const selection = await manager.pickOutputFile(scope)
    if (selection.canceled) throw new Error("Expected an output selection.")
    const writer = await manager.beginWrite(scope, selection.file.token)
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([4]))
    await writeFile(outputPath, "attacker")

    await expectCapabilityError(manager.commitWrite(scope, writer.writerId), "path-exists")
    expect(await readFile(outputPath, "utf8")).toBe("attacker")
    expect((await readdir(root)).filter((entry) => entry.startsWith(".daw-browser-"))).toEqual([])
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("overwrites only the retained inode after the selected pathname is replaced", async () => {
    const root = await createTestDirectory()
    const privateTemp = path.join(root, "private")
    const selectedParent = path.join(root, "selected-parent")
    const originalParent = path.join(root, "original-parent")
    const outputPath = path.join(selectedParent, "mix.wav")
    const retainedLink = path.join(selectedParent, "retained.wav")
    await mkdir(selectedParent)
    await writeFile(outputPath, "selected")
    await link(outputPath, retainedLink)
    const manager = createManager(privateTemp, outputPath)
    const selection = await manager.pickOutputFile(scope)
    if (selection.canceled) throw new Error("Expected an output selection.")
    const writer = await manager.beginWrite(scope, selection.file.token)
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([7]))

    await rename(selectedParent, originalParent)
    await mkdir(selectedParent)
    await writeFile(outputPath, "attacker")
    await manager.commitWrite(scope, writer.writerId)
    expect(await readFile(outputPath, "utf8")).toBe("attacker")
    expect(await readFile(path.join(originalParent, path.basename(retainedLink)))).toEqual(Buffer.from([7]))
    expect((await readdir(root)).filter((entry) => entry.startsWith(".daw-browser-"))).toEqual([])
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("commits directory, new fixed, and overwrite outputs through private temporary files", async () => {
    const root = await createTestDirectory()
    const privateTemp = path.join(root, "private")
    const manager = createManager(privateTemp)

    const directoryCapability = await manager.grantDirectory(scope, root)
    const directoryWriter = await manager.beginWrite(scope, directoryCapability.token, "directory.wav")
    await manager.writeChunk(scope, directoryWriter.writerId, 0, new Uint8Array([1]))
    expect(await readdir(privateTemp)).toHaveLength(1)
    expect((await readdir(root)).filter((entry) => entry.startsWith(".daw-browser-"))).toEqual([])
    await manager.commitWrite(scope, directoryWriter.writerId)

    const fixedPath = path.join(root, "fixed.wav")
    const fixedCapability = await manager.grantOutputFile(scope, fixedPath)
    const fixedWriter = await manager.beginWrite(scope, fixedCapability.token)
    await manager.writeChunk(scope, fixedWriter.writerId, 0, new Uint8Array([2]))
    await manager.commitWrite(scope, fixedWriter.writerId)

    const overwritePath = path.join(root, "overwrite.wav")
    await writeFile(overwritePath, "old")
    const overwriteManager = createManager(privateTemp, overwritePath)
    const overwriteSelection = await overwriteManager.pickOutputFile(scope)
    if (overwriteSelection.canceled) throw new Error("Expected an overwrite selection.")
    const overwriteWriter = await overwriteManager.beginWrite(scope, overwriteSelection.file.token)
    await overwriteManager.writeChunk(scope, overwriteWriter.writerId, 0, new Uint8Array([3]))
    await overwriteManager.commitWrite(scope, overwriteWriter.writerId)

    expect(await readFile(path.join(root, "directory.wav"))).toEqual(Buffer.from([1]))
    expect(await readFile(fixedPath)).toEqual(Buffer.from([2]))
    expect(await readFile(overwritePath)).toEqual(Buffer.from([3]))
    expect(overwriteManager.activeCapabilityCount()).toBe(0)
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("closes and retires a retained overwrite target on abort", async () => {
    const root = await createTestDirectory()
    const privateTemp = path.join(root, "private")
    const outputPath = path.join(root, "overwrite.wav")
    await writeFile(outputPath, "old")
    const manager = createManager(privateTemp, outputPath)
    const selection = await manager.pickOutputFile(scope)
    if (selection.canceled) throw new Error("Expected an overwrite selection.")
    const writer = await manager.beginWrite(scope, selection.file.token)
    await manager.writeChunk(scope, writer.writerId, 0, new Uint8Array([3]))

    await manager.abortWrite(scope, writer.writerId)

    expect(await readFile(outputPath, "utf8")).toBe("old")
    expect(manager.activeCapabilityCount()).toBe(0)
    expect(await readdir(privateTemp)).toEqual([])
  })

  test("does not create hidden target names when direct creation fails", async () => {
    const root = await createTestDirectory()
    const privateTemp = path.join(root, "private")
    await mkdir(privateTemp)
    const outputPath = path.join(root, "occupied.wav")
    const sourcePath = path.join(privateTemp, "source")
    await writeFile(sourcePath, "new")
    const grant = await nativeHelper.statFile(outputPath)
    await writeFile(outputPath, "attacker")

    await expectNativeError(
      nativeHelper.commitFile({
        parentPath: root,
        parent: grant.parent,
        basename: grant.basename,
        tempPath: sourcePath,
      }),
      "path-exists",
    )

    expect(await readFile(outputPath, "utf8")).toBe("attacker")
    expect((await readdir(root)).filter((entry) => entry.startsWith(".daw-browser-"))).toEqual([])
    expect(await readFile(sourcePath, "utf8")).toBe("new")
  })

  test("removes only its proven direct-creation inode after a copy failure", async () => {
    const root = await createTestDirectory()
    const sourcePath = path.join(root, "source")
    const outputPath = path.join(root, "output.wav")
    const limitedHelperPath = path.join(compilerDirectory, "limited-file-capability-helper")
    await writeFile(sourcePath, new Uint8Array(4 * 1024))
    await writeFile(
      limitedHelperPath,
      `#!/bin/sh\nulimit -f 1\ntrap '' XFSZ\nexec "${nativeExecutable}" "$@"\n`,
      { mode: 0o700 },
    )
    const limitedHelper = createNativeFileCapabilityHelper(limitedHelperPath)
    const grant = await limitedHelper.statFile(outputPath)

    await expectNativeError(
      limitedHelper.commitFile({
        parentPath: root,
        parent: grant.parent,
        basename: grant.basename,
        tempPath: sourcePath,
      }),
      "io-error",
    )

    expect(await readdir(root)).toEqual(["source"])
    expect(await readFile(sourcePath)).toHaveLength(4 * 1024)
  })

  test("distinguishes pre-publication failure from an indeterminate retained commit", async () => {
    const root = await createTestDirectory()
    const missingSource = path.join(root, "missing-source")
    const outputPath = path.join(root, "new.wav")
    const newGrant = await nativeHelper.statFile(outputPath)

    await expectNativeError(
      nativeHelper.commitFile({
        parentPath: root,
        parent: newGrant.parent,
        basename: newGrant.basename,
        tempPath: missingSource,
      }),
      "source-invalid",
    )
    expect(await readdir(root)).toEqual([])

    const retainedPath = path.join(root, "retained.wav")
    const sourcePath = path.join(root, "source")
    await writeFile(retainedPath, "old")
    await writeFile(sourcePath, "new")
    const grant = await nativeHelper.statFile(retainedPath)
    if (!grant.file) throw new Error("Expected an existing retained target.")
    const readOnlyHandle = await open(retainedPath, "r")
    try {
      await expectNativeError(
        nativeHelper.commitRetainedFile({
          retained: { ...grant.file, handle: readOnlyHandle },
          tempPath: sourcePath,
        }),
        "commit-indeterminate",
      )
    } finally {
      await readOnlyHandle.close()
    }
    expect(await readFile(retainedPath, "utf8")).toBe("old")
  })

  test("classifies malformed commit transport replies as indeterminate", async () => {
    const root = await createTestDirectory()
    const malformedExecutable = path.join(root, "malformed-helper")
    await writeFile(
      malformedExecutable,
      "#!/bin/sh\nprintf '{\"ok\":true,\"extra\":true}\\n'\n",
      { mode: 0o700 },
    )
    const malformedHelper = createNativeFileCapabilityHelper(malformedExecutable)
    const outputPath = path.join(root, "output.wav")
    const sourcePath = path.join(root, "source")
    await writeFile(sourcePath, "new")
    const grant = await nativeHelper.statFile(outputPath)

    await expectNativeError(
      malformedHelper.commitFile({
        parentPath: root,
        parent: grant.parent,
        basename: grant.basename,
        tempPath: sourcePath,
      }),
      "commit-indeterminate",
    )
  })
})
