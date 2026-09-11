import { expect, test } from "bun:test"
import { createImportJobQueue } from "./import-job-queue"

test("keeps accepted imports independent from the request lifetime", async () => {
  const queue = createImportJobQueue(() => "import-1")
  const release = Promise.withResolvers<void>()
  const submitted = queue.submit("audio.wav", async (signal) => {
    await release.promise
    signal.throwIfAborted()
    return { outcomes: [{ fileName: "audio.wav", status: "created", assetId: "asset-1", clipId: "clip-1" }] }
  })

  expect(queue.status("import-1")?.status).toBe("queued")
  await Promise.resolve()
  expect(queue.status("import-1")?.status).toBe("running")
  release.resolve()
  await submitted.completion
  expect(queue.status("import-1")?.status).toBe("completed")
  queue.dispose()
})

test("cancels queued and active imports", async () => {
  const queue = createImportJobQueue(() => "import-1")
  const first = Promise.withResolvers<void>()
  const active = queue.submit("active.wav", async (signal) => {
    await first.promise
    signal.throwIfAborted()
    return { outcomes: [] }
  })
  await Promise.resolve()
  const queued = queue.submit("queued.wav", async () => ({ outcomes: [] }))
  queue.cancel(queued.id)
  expect(queue.status(queued.id)?.status).toBe("canceled")
  queue.cancel(active.id)
  first.resolve()
  await active.completion
  expect(queue.status(active.id)?.status).toBe("canceled")
  queue.dispose()
})

test("cancels every queued and active import during project transition", async () => {
  const queue = createImportJobQueue(() => `import-${crypto.randomUUID()}`)
  const release = Promise.withResolvers<void>()
  const active = queue.submit("active.wav", async (signal) => {
    await release.promise
    signal.throwIfAborted()
    return { outcomes: [] }
  })
  await Promise.resolve()
  const queued = queue.submit("queued.wav", async () => ({ outcomes: [] }))

  queue.cancelAll()
  release.resolve()
  await Promise.all([active.completion, queued.completion])

  expect(queue.status(active.id)?.status).toBe("canceled")
  expect(queue.status(queued.id)?.status).toBe("canceled")
  queue.dispose()
})

test("retains active jobs while bounding terminal history", async () => {
  let nextId = 0
  const queue = createImportJobQueue(() => `import-${++nextId}`)
  const completions = Array.from({ length: 17 }, (_, index) => queue.submit(
    `audio-${index}.wav`,
    async () => ({ outcomes: [{ fileName: `audio-${index}.wav`, status: "failed" }] }),
  ))

  await Promise.all(completions.map((entry) => entry.completion))

  expect(queue.status("import-1")).toBeUndefined()
  expect(queue.status("import-2")).toBeDefined()
  expect(queue.status("import-17")?.status).toBe("failed")
  queue.dispose()
})
