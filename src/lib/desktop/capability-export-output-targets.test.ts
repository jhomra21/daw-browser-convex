import { expect, test } from "bun:test"

import { createDesktopCapabilityExportOutputTargetFactory } from "~/lib/desktop/capability-export-output-targets"

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
    firstFileName: "mix.wav",
    firstFileTypes: [],
  })
  const sink = await target.openFile("mix.wav")
  if (!sink) throw new Error("Expected desktop export sink.")
  await expect(sink.commit()).rejects.toBe(error)
  await sink.abort(error)
  expect(aborts).toBe(0)
})
