import { expect, test } from "bun:test"

import {
  createDesktopCapabilityExportOutputTargetFactory,
  createDesktopRendererExportOutputTargetFactory,
} from "~/lib/desktop/capability-export-output-targets"

test("commit indeterminate leaves a desktop sink terminal without aborting it", async () => {
  const error = Object.assign(new Error("indeterminate terminal state"), { code: "commit-indeterminate" })
  let aborts = 0
  const factory = createDesktopCapabilityExportOutputTargetFactory({
    beginWrite: async () => ({ writerId: "writer-1" }),
    writeChunk: async (_requestId, _writerId, offset, chunk) => ({ nextOffset: offset + chunk.byteLength }),
    commit: async () => {
      throw error
    },
    abort: async () => {
      aborts += 1
    },
  }, "request-1", { token: "token-1", directory: false })

  const target = await factory.createMixdownTarget({
    projectId: "project-1",
    localProject: true,
    multiFormat: false,
    firstFormat: "wav",
    firstFileName: "mix.wav",
    firstFileTypes: [],
  })
  const sink = await target.openFile("mix.wav")
  if (!sink) throw new Error("Expected desktop export sink.")
  await expect(sink.commit()).rejects.toBe(error)
  await sink.abort(error)
  expect(aborts).toBe(0)
})

test("desktop renderer output picks a basename and streams chunks without browser writable handles", async () => {
  const writes: Array<{ offset: number; bytes: number[] }> = []
  const pickerRequests: Array<{ requestId: string; format: string }> = []
  let releases = 0
  const factory = createDesktopRendererExportOutputTargetFactory({
    pickOutputFile: async (requestId, format) => {
      pickerRequests.push({ requestId, format })
      return { canceled: false, file: { token: "a".repeat(64), basename: "selected.wav" } }
    },
    pickOutputDirectory: async () => ({ canceled: true }),
    releaseExportOutput: async () => { releases += 1 },
    beginWrite: async () => ({ writerId: "writer-1" }),
    writeChunk: async (_requestId, _writerId, offset, chunk) => {
      writes.push({ offset, bytes: [...chunk] })
      return { nextOffset: offset + chunk.byteLength }
    },
    commit: async () => ({ basename: "selected.wav", byteLength: 3, mime: "audio/wav" }),
    abort: async () => undefined,
  })

  const target = await factory.createMixdownTarget({
    projectId: "project-1",
    localProject: true,
    multiFormat: false,
    firstFormat: "wav",
    firstFileName: "mix.wav",
    firstFileTypes: [],
  })
  const sink = await target.openFile("mix.wav")
  if (!sink) throw new Error("Expected desktop export sink.")
  const writer = sink.target.writable.getWriter()
  await writer.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3]) })
  await writer.close()

  expect(pickerRequests).toHaveLength(1)
  expect(pickerRequests[0]?.format).toBe("wav")
  expect(pickerRequests[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/)
  expect(writes).toEqual([{ offset: 0, bytes: [1, 2, 3] }])
  expect(sink.name).toBe("selected.wav")
  expect(await sink.commit()).toEqual({ byteLength: 3 })
  await target.dispose?.()
  expect(releases).toBe(1)
})

test("desktop renderer output treats a canceled native picker as an abort", async () => {
  let releases = 0
  const factory = createDesktopRendererExportOutputTargetFactory({
    pickOutputFile: async () => ({ canceled: true }),
    pickOutputDirectory: async () => ({ canceled: true }),
    releaseExportOutput: async () => { releases += 1 },
    beginWrite: async () => ({ writerId: "unused" }),
    writeChunk: async () => ({ nextOffset: 0 }),
    commit: async () => ({ basename: "unused.wav", byteLength: 0, mime: "audio/wav" }),
    abort: async () => undefined,
  })

  await expect(factory.createMixdownTarget({
    projectId: "project-1",
    localProject: true,
    multiFormat: false,
    firstFormat: "wav",
    firstFileName: "mix.wav",
    firstFileTypes: [],
  })).rejects.toMatchObject({ name: "AbortError" })
  expect(releases).toBe(1)
})

test("desktop renderer output uses a directory capability for multi-format mixdowns", async () => {
  let relativePath: string | undefined
  let releases = 0
  const factory = createDesktopRendererExportOutputTargetFactory({
    pickOutputFile: async () => ({ canceled: true }),
    pickOutputDirectory: async () => ({
      canceled: false,
      directory: { token: "b".repeat(64), basename: "Exports" },
    }),
    releaseExportOutput: async () => { releases += 1 },
    beginWrite: async (_requestId, _token, path) => {
      relativePath = path
      return { writerId: "writer-1" }
    },
    writeChunk: async (_requestId, _writerId, offset, chunk) => ({ nextOffset: offset + chunk.byteLength }),
    commit: async () => ({ basename: "mixdown.wav", byteLength: 1, mime: "audio/wav" }),
    abort: async () => undefined,
  })

  const target = await factory.createMixdownTarget({
    projectId: "project-1",
    localProject: true,
    multiFormat: true,
    firstFormat: "wav",
    firstFileName: "mix.wav",
    firstFileTypes: [],
  })
  const sink = await target.openFile("mixdown_20260101.ogg")
  if (!sink) throw new Error("Expected desktop export sink.")
  expect(relativePath).toBe("mixdown_20260101.ogg")
  expect(sink.name).toBe("mixdown_20260101.ogg")
  await sink.abort()
  await target.dispose?.()
  expect(releases).toBe(1)
})
