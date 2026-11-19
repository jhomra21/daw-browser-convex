import { expect, spyOn, test } from "bun:test"
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { NativeHostRecordingConfiguration, NativeHostRecordingStatus } from "@daw-browser/audio-engine/native-host-wire"
import { nativeRecordingSpoolImportVersion } from "@daw-browser/desktop-protocol/native-audio-host"
import { nativeDeliveryFailureKind, type NativeMainRecordingStatus } from "./audio-host"
import { createRecordingSessionOwner, type RecordingConfigureRequest } from "./recording-session-owner"
import { createRecordingSpoolRegistry } from "./recording-spool"
import { createRecordingStartDiagnostic } from "./recording-start-diagnostic"

// Failure modes: admission answers and their diagnostic order, a renderer lost
// mid-configure, Stop before or after Complete, a Complete that cannot be
// verified, capture inhibition, and quit while Complete is still being proven.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the argument is a catch-clause value, as in main's failure projection
const fail = (thrown?: unknown) => ({ ok: false as const, kind: nativeDeliveryFailureKind(thrown),
  error: thrown instanceof Error ? thrown.message : "unavailable" })
const configuration: NativeHostRecordingConfiguration = {
  projectId: "local:owner", projectGeneration: 7, deviceUid: "device", generation: 5, sessionId: 6n, channelCount: 2,
  inputChannels: [0, 1], gain: 1, polarity: 1, punchStartFrame: 0, punchEndFrame: null, monitoring: false, targetNodeId: 1n,
}
const request: RecordingConfigureRequest = { configuration, projectId: "local:owner", projectGeneration: 7,
  spoolImportVersion: nativeRecordingSpoolImportVersion }
const startRequest = { projectId: "local:owner", projectGeneration: 7, generation: 5, sessionId: 6n }
const spool = { state: 1, error: 0, systemError: 0, writtenFrames: 0, writtenBytes: 0, writtenBlocks: 0,
  published: false, partialRetained: false, sampleRateHz: 48000, channelCount: 2 }
const ready: NativeHostRecordingStatus = { generation: 5, sessionId: 6n, capturedFrames: 0, droppedFrames: 0, droppedBlocks: 0,
  active: false, fatal: false, configured: true, availableBlocks: 32, queuedBlocks: 0, rms: 0, peak: 0, timelineFrame: 0, spool }

const fixture = async (options: { registry?: boolean; captureInhibited?: boolean; admissionAvailable?: boolean } = {}) => {
  const userData = await mkdtemp("/private/tmp/daw-recording-owner-")
  const events: Array<{ kind: string; outcome?: string; category?: string }> = []
  const sent: Array<{ channel: string; message: object }> = []
  const calls: string[] = []
  let generation = 3
  let allowed = true
  let spoolConfig: { rootPath: string; token: string } | undefined
  let releaseOutcome: () => void = () => {}
  let outcomeWait = Promise.resolve()
  let configureHook = () => {}
  const registry = createRecordingSpoolRegistry({ userData })
  const owner = createRecordingSessionOwner({
    diagnostic: createRecordingStartDiagnostic(true, (event) => events.push(event)),
    captureInhibited: options.captureInhibited ?? false,
    currentRendererGeneration: () => generation,
    userData: () => userData,
    verifyDirectory: undefined,
    sendToRenderer: (channel, message) => sent.push({ channel, message }),
    statusChannel: "status",
    failureChannel: "failure",
  })
  if (options.registry !== false) owner.attachRegistry(registry)
  const supervisor = {
    recordingAdmissionAvailable: () => options.admissionAvailable ?? true,
    async configureRecording(_input: NativeHostRecordingConfiguration, config: { rootPath: string; token: string }) {
      calls.push("configure")
      spoolConfig = config
      configureHook()
      return ready
    },
    async startRecording() { calls.push("start") },
    async stopRecording(frame?: number) { calls.push(`stop:${frame}`) },
    waitForRecordingOutcome: () => { calls.push("outcome"); return outcomeWait },
  }
  const configure = () => owner.configure({ rendererGeneration: generation, hostGeneration: 1, senderAllowed: () => allowed, fail }, supervisor, request)
  const start = (value: typeof startRequest | null = startRequest) =>
    owner.start({ rendererGeneration: generation, fail }, supervisor, value ?? undefined)
  const stop = () => owner.stop({ fail }, supervisor, { endFrame: 12 })
  // The native Complete status the registry independently verifies against the written file.
  const completeStatus = async (): Promise<NativeMainRecordingStatus> => {
    if (!spoolConfig) throw new Error("configure first")
    const source = path.join(spoolConfig.rootPath, `${spoolConfig.token}.pcm`)
    const bytes = Buffer.alloc(28)
    bytes.writeUInt32LE(3)
    await writeFile(source, bytes, { mode: 0o600 })
    const stat = await lstat(source, { bigint: true })
    return { ...ready, capturedFrames: 3, timelineFrame: 3, fileDevice: stat.dev, fileInode: stat.ino,
      spool: { ...spool, state: 2, writtenFrames: 3, writtenBytes: 28, writtenBlocks: 1, published: true } }
  }
  return {
    userData, registry, owner, events, sent, calls, configure, start, stop, completeStatus,
    setGeneration: (value: number) => { generation = value },
    denySender: () => { allowed = false },
    onConfigure: (hook: () => void) => { configureHook = hook },
    holdOutcome: () => { outcomeWait = new Promise<void>((resolve) => { releaseOutcome = resolve }); return () => releaseOutcome() },
    cleanup: () => rm(userData, { recursive: true, force: true }),
  }
}

test("admission answers keep their text and the diagnostic order", async () => {
  const f = await fixture({ registry: false })
  try {
    expect(await f.configure()).toEqual({ ok: false, error: "Native recording storage is unavailable. Sources remain retained; check the desktop log." })
    expect(f.events.map((event) => event.kind)).toEqual(["configure-request", "backend", "configure-result"])
    expect(f.events[2]).toMatchObject({ outcome: "rejected", category: "admission-failed" })
    expect(f.calls).toEqual([])
  } finally { await f.cleanup() }
  const g = await fixture()
  try {
    const supervisor = { recordingAdmissionAvailable: () => true, configureRecording: async () => ready, startRecording: async () => {},
      stopRecording: async () => {}, waitForRecordingOutcome: async () => {} }
    const call = { rendererGeneration: 3, hostGeneration: 1, senderAllowed: () => true, fail }
    expect(await g.owner.configure(call, supervisor, undefined)).toEqual(fail())
    expect(g.events.map((event) => event.kind)).toEqual(["configure-request", "configure-result"])
    expect(await g.owner.configure(call, supervisor, { ...request, spoolImportVersion: undefined }))
      .toEqual({ ok: false, error: "Native recording import is not ready." })
    expect(await g.owner.configure(call, undefined, request)).toEqual(fail())
  } finally { await g.cleanup() }
  const busy = await fixture({ admissionAvailable: false })
  try { expect(await busy.configure()).toEqual(fail()) } finally { await busy.cleanup() }
})

test("a second configure while one is admitting is refused, and admission reopens afterwards", async () => {
  const f = await fixture()
  try {
    const first = f.configure()
    expect(await f.configure()).toEqual(fail())
    expect(await first).toMatchObject({ ok: true, sampleRateHz: 48000, channelCount: 2 })
    expect(await f.configure()).toMatchObject({ ok: true })
  } finally { await f.cleanup() }
})

test("configure binds the take, reports readiness and permits only the matching start", async () => {
  const f = await fixture()
  try {
    expect(await f.start()).toEqual(fail())
    const reply = await f.configure()
    expect(reply).toMatchObject({ ok: true, sampleRateHz: 48000, channelCount: 2 })
    expect(f.events.map((event) => `${event.kind}:${event.category ?? ""}`))
      .toEqual(["configure-request:", "backend:", "readiness:", "readiness:", "configure-result:success"])
    for (const wrong of [{ ...startRequest, sessionId: 7n }, { ...startRequest, generation: 6 }, { ...startRequest, projectGeneration: 8 },
      { ...startRequest, projectId: "local:other" }, null]) expect(await f.start(wrong)).toEqual(fail())
    expect(f.calls).toEqual(["configure"])
    expect(await f.start()).toEqual({ ok: true })
    expect(f.calls).toEqual(["configure", "start"])
    expect(f.events.at(-1)).toMatchObject({ kind: "native-start-result", outcome: "succeeded" })
  } finally { await f.cleanup() }
})

test("an inhibited capture answers diagnostic-capture-blocked without a native start", async () => {
  const f = await fixture({ captureInhibited: true })
  try {
    await f.configure()
    expect(await f.start()).toEqual({ ok: false, error: "diagnostic-capture-blocked" })
    expect(f.calls).toEqual(["configure"])
    expect(f.events.at(-1)).toMatchObject({ kind: "native-start-blocked" })
  } finally { await f.cleanup() }
})

test("a renderer replaced during native configure rejects the take and leaves it unbound for start", async () => {
  const f = await fixture()
  try {
    f.onConfigure(() => f.setGeneration(4))
    expect(await f.configure()).toMatchObject({ ok: false, error: "Recording renderer binding changed." })
    expect(f.events.at(-1)).toMatchObject({ kind: "configure-result", outcome: "rejected", category: "readiness-validation-failed" })
    expect(await f.start()).toEqual(fail())
  } finally { await f.cleanup() }
  const g = await fixture()
  try {
    g.denySender()
    expect(await g.configure()).toMatchObject({ ok: false, error: "Recording renderer binding changed." })
    expect(g.events.at(-1)).toMatchObject({ outcome: "rejected", category: "admission-failed" })
    expect(g.calls).toEqual([])
  } finally { await g.cleanup() }
})

test("Stop before Complete stops the host, waits for the outcome and returns after the proof", async () => {
  const f = await fixture()
  try {
    await f.configure()
    await f.start()
    const release = f.holdOutcome()
    const stopped = f.stop()
    await Promise.resolve()
    expect(f.calls).toEqual(["configure", "start", "stop:12", "outcome"])
    f.owner.onStatus(await f.completeStatus())
    release()
    expect(await stopped).toEqual({ ok: true })
    expect(f.sent.map((entry) => entry.channel)).toEqual(["status"])
    expect(f.sent[0]?.message).not.toHaveProperty("fileDevice")
    expect(f.sent[0]?.message).not.toHaveProperty("fileInode")
  } finally { await f.cleanup() }
})

test("Complete before Stop is awaited once and Stop does not touch the host again", async () => {
  const f = await fixture()
  try {
    await f.configure()
    await f.start()
    f.owner.onStatus(await f.completeStatus())
    f.owner.onStatus(await f.completeStatus())
    expect(await f.stop()).toEqual({ ok: true })
    expect(f.calls).toEqual(["configure", "start"])
    expect(f.sent.map((entry) => entry.channel)).toEqual(["status", "status"])
  } finally { await f.cleanup() }
})

test("Stop without a Complete proof fails, and an unverifiable Complete sends the failure and fails Stop", async () => {
  const f = await fixture()
  try {
    await f.configure()
    expect(await f.stop()).toMatchObject({ ok: false, error: "Native recording Complete proof is unavailable." })
    expect(f.sent).toEqual([])
    const status = await f.completeStatus()
    f.owner.onStatus({ ...status, fileInode: status.fileInode + 1n })
    expect(await f.stop()).toMatchObject({ ok: false })
    expect(f.sent).toEqual([{ channel: "failure", message: { generation: 5, sessionId: 6n,
      message: "Native recording source verification failed; native source retained." } }])
  } finally { await f.cleanup() }
})

test("Stop with no binding at all fails after stopping the host", async () => {
  const f = await fixture()
  try {
    expect(await f.stop()).toMatchObject({ ok: false, error: "Native recording Complete proof is unavailable." })
    expect(f.calls).toEqual(["stop:12", "outcome"])
  } finally { await f.cleanup() }
})

test("a status for another session passes through without starting Complete, and terminal states resolve the source", async () => {
  const f = await fixture()
  const warn = spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    await f.configure()
    f.owner.onStatus({ ...await f.completeStatus(), sessionId: 9n })
    expect(f.sent.map((entry) => entry.channel)).toEqual(["status"])
    f.owner.onStatus({ ...ready, fileDevice: 0n, fileInode: 0n, spool: { ...spool, state: 3 } })
    await f.owner.waitForSettlement()
    expect(f.sent.map((entry) => entry.channel)).toEqual(["status", "status"])
    expect(await f.stop()).toMatchObject({ ok: false })
  } finally { warn.mockRestore(); await f.cleanup() }
})

test("quit waits for a Complete proof that is still being written", async () => {
  const f = await fixture()
  try {
    await f.configure()
    f.owner.onStatus(await f.completeStatus())
    await f.owner.waitForSettlement()
    const listed = await f.registry.list({ projectId: "local:owner", projectGeneration: 7, rendererGeneration: 3 })
    expect(listed.takes[0]).toMatchObject({ state: "complete", frames: 3 })
  } finally { await f.cleanup() }
})

test("a renderer invalidation ends the registry scope, so the same take can no longer start", async () => {
  const f = await fixture()
  try {
    await f.configure()
    f.owner.invalidateRenderer()
    expect(await f.start()).toEqual(fail())
    expect(f.calls).toEqual(["configure"])
    expect(() => f.owner.spool()).not.toThrow()
  } finally { await f.cleanup() }
  const g = await fixture({ registry: false })
  try { expect(() => g.owner.spool()).toThrow("Recording spool is unavailable.") } finally { await g.cleanup() }
})
