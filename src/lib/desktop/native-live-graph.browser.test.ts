import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { build } from "vite"
import { z } from "zod"

// Added before implementation. This is a Chromium integration of the internal
// revision controller and session adapter, not a replacement DOM or a TS unit test.
test("bounded session revisions reconcile late replies and invalidate changed ownership", async () => {
  const directory = `/tmp/ae08-browser-${crypto.randomUUID()}`
  const session = `ae08-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(["agent-browser", "--session", session, ...args], { env, stdout: "pipe", stderr: "pipe" })
    const [out, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited !== 0) throw new Error(error || out)
    return out.trim()
  }
  await mkdir(directory)
  await Bun.write(`${directory}/fixture.js`, `
import { createNativeRevisionController } from "${import.meta.dir}/native-revision-controller.ts"
import { createNativeRevisionSession } from "${import.meta.dir}/native-revision-session.ts"
import { createNativeScheduleCoordinator } from "${import.meta.dir}/native-schedule-coordinator.ts"
import { compileLivePlaybackSnapshot } from "${import.meta.dir}/../live-playback-snapshot.ts"
import { createDefaultSynthParams } from "${import.meta.dir}/../../../packages/shared/src/index.ts"
import { compileLiveNativeProjection } from "${import.meta.dir}/../../../packages/audio-engine/src/live-native-projection.ts"
let projectId = "local_project-a", active = 5, next = 5, pending, release, loseReply = false
const calls = []
const proof = (revision, status) => ({ status, continuity: "accepted", requestedRevision: revision,
  activeRevision: active, preparedRevision: status === "prepared" ? revision : 0, retiredRevision: 0,
  publicationFrame: 9007199254740993n, renderEpoch: 9007199254740995n })
const bridge = createNativeRevisionSession(async (operation, value) => {
  calls.push(operation)
  if (value.projectId !== projectId) return { ok: false, error: "ownership changed" }
  if (operation === "prepare") {
    const revision = ++next
    if (pending) await pending
    return { ok: true, hostGeneration: 3, hostPid: 42, revision: proof(revision, "prepared") }
  }
  if (operation === "publish") {
    active = value.revision
    if (loseReply) throw new Error("lost publication reply")
    return { ok: true, hostGeneration: 3, hostPid: 42, revision: proof(active, "publish-pending") }
  }
  return { ok: true, hostGeneration: 3, hostPid: 42, revision: proof(value.revision, "published") }
})
const controller = createNativeRevisionController(bridge, () => projectId)
window.scenarios = async () => {
  const compiled = compileLivePlaybackSnapshot({ revision: 1, bpm: 120,
    transport: { state: "playing", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
    tracks: [{ id: "synth", name: "Synth", kind: "instrument", volume: 1,
      clips: [{ id: "notes", name: "Notes", color: "#fff", startSec: 0, duration: 3,
        midi: { wave: "sawtooth", notes: [{ pitch: 60, beat: 0, length: 4, velocity: 0.8 }] } }] }],
    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: { synth: { instances: [],
      instrument: { kind: "synth", instanceId: "synth", params: createDefaultSynthParams() } } } },
      automationEnvelopes: [] }, sidechainRoutes: [] })
  if (!compiled.supported) throw new Error(compiled.reasons.join(" "))
  const snapshot = compiled.snapshot
  const projected = compileLiveNativeProjection({ tracks: snapshot.tracks, bpm: 120, sampleRateHz: 48000,
    revision: 1, epoch: 7, firstSequence: 1, fx: snapshot.mixer.fx })
  if (!projected.supported) throw new Error(projected.reasons.join(" "))
  const windows = []
  const coordinator = createNativeScheduleCoordinator({
    bridge: { queueScheduleWindow: async (bytes) => { windows.push(bytes); return { ok: true } },
      queueInstrumentEvents: async () => ({ ok: true }), onScheduleProgress: () => () => {},
      onLoss: () => () => {} }, snapshot, graph: projected.graph, epoch: 7, sampleRateHz: 48000,
    capacity: { maximumFramesPerBlock: 128 }, assets: [], startFrame: 0, acceptsLiveMidi: true })
  await coordinator.prime(0)
  const staged = coordinator.stageRevision({ ...snapshot, revision: 2 }, { ...projected.graph, revision: 2 }, 48128)
  await staged.prime(48128)
  const initialCount = windows.length
  staged.dispose()
  const rebased = coordinator.stageRevision({ ...snapshot, revision: 2 }, { ...projected.graph, revision: 2 }, 49152)
  await rebased.prime(49152)
  const events = windows.flatMap((bytes, windowIndex) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (windowIndex > 0 && windowIndex < initialCount) return []
    return Array.from({ length: view.getUint32(44, true) }, (_, i) => ({
      frame: Number(view.getBigUint64(16, true)) + view.getUint32(72 + i * 48 + 28, true),
      type: view.getUint32(72 + i * 48 + 32, true), epoch: view.getUint32(4, true),
      note: view.getBigUint64(72 + i * 48 + 8, true).toString(), active: windowIndex === 0 }))
  }).filter(event => !event.active || event.frame < 49152)
  const bankSeam = JSON.stringify(events.map(({ frame, type, epoch }) => ({ frame, type, epoch })))
    === JSON.stringify([{ frame: 0, type: 1, epoch: 7 }, { frame: 96000, type: 2, epoch: 7 }])
    && events[0].note === events[1].note
  const rebaseWindow = new DataView(windows[initialCount].buffer)
  const bankRebase = rebaseWindow.getBigUint64(16, true) === 49152n
    && rebaseWindow.getBigUint64(64, true) === 49152n && rebaseWindow.getBigUint64(8, true) === 1n
  const proofGate = !rebased.activateRevision({ status: "prepared", activeRevision: 1, publicationFrame: 49152n })
    && rebased.activateRevision({ status: "published", activeRevision: 2, publicationFrame: 49152n })
  rebased.dispose()
  coordinator.dispose()
  const bytes = new Uint8Array(32)
  const a = await controller.prepare(bytes, 10)
  const b = await controller.prepare(bytes, 9)
  const publication = await controller.publish(b)
  const lost = await controller.prepare(bytes, 9)
  loseReply = true
  const recovered = await controller.publish(lost)
  loseReply = false
  const rollbackRejected = await controller.rollback(publication).then(() => false, () => true)
  pending = new Promise(resolve => { release = resolve })
  const stale = controller.prepare(bytes, 8).then(() => false, () => true)
  await Promise.resolve()
  projectId = "local_project-b"
  release()
  const staleRejected = await stale
  pending = undefined
  // Delayed older prepare must not replace the latest completion.
  projectId = "local_project-a"
  pending = new Promise(resolve => { release = resolve })
  const older = controller.prepare(bytes, 7).then(() => false, () => true)
  await Promise.resolve()
  pending = undefined
  const latest = await controller.prepare(bytes, 6)
  release()
  return { monotonicUndo: b.revision.requestedRevision > a.revision.requestedRevision,
    reconciled: publication.revision.activeRevision === b.revision.requestedRevision && calls.includes("inspect"),
    exact64: publication.revision.publicationFrame === 9007199254740993n,
    lostReply: recovered.revision.activeRevision === lost.revision.requestedRevision,
    noBlindRollback: rollbackRejected && !calls.includes("rollback"),
    ownership: staleRejected, outOfOrder: await older,
    latest: latest.revision.requestedRevision > b.revision.requestedRevision, bankSeam, bankRebase, proofGate }
}
`)
  try {
    const built = await build({ configFile: false, logLevel: "silent",
      resolve: { alias: { "~": new URL("../../", import.meta.url).pathname } },
      build: { write: false, rollupOptions: { input: `${directory}/fixture.js`, output: { format: "iife" } } } })
    if (!("output" in built)) throw new Error("Missing browser output")
    const chunk = built.output.find((value) => value.type === "chunk")
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing browser chunk")
    await Bun.write(`${directory}/index.html`, `<script>${chunk.code}</script>`)
    await browser("open", `file://${directory}/index.html`)
    const results = z.record(z.string(), z.boolean()).parse(JSON.parse(await browser("eval", "window.scenarios()")))
    await Bun.write(`${directory}/results.json`, JSON.stringify(results, null, 2))
    console.log(`AE-08 Chromium evidence: ${directory}/results.json`)
    expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
  } finally {
    await browser("close")
  }
}, 60_000)
