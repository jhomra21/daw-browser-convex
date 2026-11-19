// DV01 boundary: targeted runs of the real supervisor against the acceptance host (section 6.2). Not a campaign.
// Run: bun tools/acceptance/dv01-boundary-acceptance.ts [path to daw-audio-host-macos-acceptance]
// The acceptance executable is the production host plus the always-on claim hold (a taken patch waits sample_rate+1 frames,
// so the control thread's one-second wait expires and the reply is a claim). It needs a real output device.
// Not covered here, because Electron is required: main's `ipcMain.handle` wrapper and preload's `ipcRenderer.invoke`
// bridge. Their reply shape is checked with `nativeProcessorPatchReply` (the exact function main calls) and the type
// preload declares (`NativeProcessorPatchReply`); IPC itself is simulated with `structuredClone`.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createNativeAudioHostSupervisor, nativeProcessorPatchReply } from "../../apps/desktop/audio-host"
import type { NativeProcessorPatchStatus, NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"
import type { NativeProcessorPatchReply } from "../../src/types/desktop-bridge"

const root = path.resolve(import.meta.dirname, "../..")
const hostPath = process.argv[2] ?? path.join(root, "native/build/audio-host-macos-debug/audio-host-macos/daw-audio-host-macos-acceptance")
const reportDirectory = path.join(root, "acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/witnesses")

// Little-endian bytes of the native test's GraphSnapshot(2, 1, 0, with_utility) and ProcessorStatePatch(2, gain).
const u32 = (...values: readonly number[]) => {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value, true))
  return bytes
}
const f32 = (...values: readonly number[]) => {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return bytes
}
const u64 = (...values: readonly bigint[]) => {
  const bytes = new Uint8Array(values.length * 8)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setBigUint64(index * 8, value, true))
  return bytes
}
const join = (...parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.byteLength }
  return out
}
const graphNode = (id: bigint, kind: number) => join(
  u64(id), u32(kind, 2, 2, 0, 0), u32(...Array<number>(20).fill(0)), u64(0n), f32(0, 0), u32(0, 0),
)
const utilityState = (gainDb: number) => join(u32(1), f32(gainDb), u32(0, 0), f32(0, 0, 1), u32(0, 0, 0))
const graphFrame = (revision: number) => {
  const payload = join(
    u32(3, revision, 2, 1, 1, 0), graphNode(1n, 1), graphNode(2n, 6),
    u64(3n, 1n, 2n, 0n), f32(1), u32(3, 0, 0),
    u64(2n), u32(1, 1, 40, 77, 0, 2, 2, 1, 0, 0), utilityState(0), u32(1),
  )
  const header = new Uint8Array(12)
  const view = new DataView(header.buffer)
  view.setBigUint64(0, BigInt(revision))
  view.setUint32(8, payload.byteLength)
  return join(header, payload)
}
const patchBytes = (revision: number, gainDb: number) => join(
  u32(1, revision), u64(2n), u32(77, 1, 1, 40, 0, 2, 2, 1, 0, 0), utilityState(gainDb), u32(1),
)

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER)
const deadlineMs = 8_000
type Observed = { at: number; progress: NativeScheduleProgress }

const rig = async () => {
  const supervisor = createNativeAudioHostSupervisor(hostPath)
  const frames: Observed[] = []
  const waiters = new Set<() => void>()
  supervisor.onScheduleProgress((progress) => {
    frames.push({ at: performance.now(), progress })
    for (const wake of waiters) wake()
  })
  await supervisor.start()
  const device = await supervisor.resolveOutputDevice()
  if (!device) throw new Error("No native output device: the acceptance host cannot run its callback")
  const transaction = await supervisor.beginTransaction()
  await supervisor.configure({ deviceId: device.deviceId, sampleRateHz: 48000, maxFramesPerBlock: 512, channelCount: 2, revision: 1 }, transaction)
  await supervisor.publishGraph(graphFrame(2), transaction)
  await supervisor.setTransport({ epoch: 1, running: false, frame: 0 }, transaction)
  await supervisor.commitTransaction(transaction)
  await supervisor.startAudio()
  // Bounded wait on the next progress frame that satisfies `done`; the deadline only turns a missing frame into a failure.
  const until = async (done: () => boolean) => {
    const timeout = performance.now() + deadlineMs
    while (!done()) {
      if (performance.now() >= timeout) throw new Error("No progress frame satisfied the wait before the deadline")
      await new Promise<void>((resolve) => {
        const wake = () => { waiters.delete(wake); clearTimeout(timer); resolve() }
        const timer = setTimeout(wake, Math.max(1, timeout - performance.now()))
        waiters.add(wake)
      })
    }
  }
  const resolved = (token: bigint) => frames.find(({ progress }) => progress.processorPatchResolved?.token === token.toString())
  return { supervisor, frames, until, resolved, close: () => supervisor.teardown() }
}
type Rig = Awaited<ReturnType<typeof rig>>

const claimOf = (status: NativeProcessorPatchStatus) => {
  if (status.outcome !== "claimed") throw new Error(`Expected a claim, got ${text(status)}`)
  return status.token
}
const text = (status: NativeProcessorPatchStatus) => {
  if (status.outcome === "applied") return "applied"
  if (status.outcome === "claimed") return `claimed ${status.token}`
  return `refused ${status.refusal}${status.token === undefined ? "" : ` blocked by ${status.token}`}`
}

type Detail = Readonly<Record<string, string>>
type Result = { name: string; ok: boolean; detail: Detail }
const results: Result[] = []
const scenario = async (name: string, body: (host: Rig) => Promise<Detail>) => {
  try {
    const host = await rig()
    try { results.push({ name, ok: true, detail: await body(host) }) }
    finally { await host.close() }
  } catch (error) {
    results.push({ name, ok: false, detail: { failure: error instanceof Error ? error.message : "failed" } })
  }
}
const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }

await scenario("consecutive-claims-and-quiet-paused-settlement", async (host) => {
  const first = claimOf(await host.supervisor.queueProcessorStatePatch(patchBytes(2, -6)))
  const framesAtClaim = host.frames.length
  const second = await host.supervisor.queueProcessorStatePatch(patchBytes(2, -3))
  check(second.outcome === "refused" && second.refusal === "claim-pending" && second.token === first, `second patch: ${text(second)}`)
  await host.until(() => host.resolved(first) !== undefined)
  const settled = host.resolved(first)
  if (!settled) throw new Error("first claim never resolved")
  check(settled.progress.processorPatchResolved?.result === 0, "first claim did not resolve OK")
  check(!settled.progress.running, "transport advanced: the settlement was not quiet and paused")
  const next = claimOf(await host.supervisor.queueProcessorStatePatch(patchBytes(2, -2)))
  check(next === first + 1n && first > maxSafe, `tokens ${first} then ${next}`)
  await host.until(() => host.resolved(next) !== undefined)
  return { first: first.toString(), blockedSecond: text(second), second: next.toString(), framesBetweenClaimAndResolution: String(host.frames.indexOf(settled) + 1 - framesAtClaim) }
})

await scenario("lost-reply-blocking-token-late-resolution", async (host) => {
  // A harness wrapper drops the first reply in place of main's handler: the caller never learns the token.
  const dropped = claimOf(await host.supervisor.queueProcessorStatePatch(patchBytes(2, -6)))
  const blocked = await host.supervisor.queueProcessorStatePatch(patchBytes(2, -4))
  check(blocked.outcome === "refused" && blocked.refusal === "claim-pending" && blocked.token === dropped, `blocked: ${text(blocked)}`)
  await host.until(() => host.resolved(dropped) !== undefined)
  const resend = await host.supervisor.queueProcessorStatePatch(patchBytes(2, -4))
  check(resend.outcome === "claimed" && resend.token === dropped + 1n, `resend: ${text(resend)}`)
  return { droppedToken: dropped.toString(), blocked: text(blocked), resendClaim: text(resend) }
})

await scenario("progress-before-reply-order-over-eight-claims", async (host) => {
  // The ack of a claim can land while the control thread is still returning the claim. It cannot be forced from here:
  // record the observed order and report both counts.
  const orders: string[] = []
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = claimOf(await host.supervisor.queueProcessorStatePatch(patchBytes(2, -6 + attempt)))
    const replied = performance.now()
    await host.until(() => host.resolved(token) !== undefined)
    orders.push((host.resolved(token)?.at ?? Infinity) < replied ? "frame-first" : "reply-first")
  }
  return { orders: orders.join(","), frameFirst: String(orders.filter((order) => order === "frame-first").length) }
})

await scenario("token-above-max-safe-integer-through-supervisor-reply-and-preload-type", async (host) => {
  const status = await host.supervisor.queueProcessorStatePatch(patchBytes(2, -6))
  const token = claimOf(status)
  check(token > maxSafe, `token ${token} is not above MAX_SAFE_INTEGER`)
  const reply: NativeProcessorPatchReply = nativeProcessorPatchReply(status)
  const crossed = structuredClone(reply)
  const crossedToken = crossed.outcome === "claimed" ? crossed.token : undefined
  check(crossedToken === token.toString(), `reply: ${JSON.stringify(crossed)}`)
  check(BigInt(Number(token)) !== token, "a JS number would have kept the token exact: the case does not prove the boundary")
  await host.until(() => host.resolved(token) !== undefined)
  check(host.resolved(token)?.progress.processorPatchResolved?.token === crossedToken, "progress token differs from the reply token")
  return { token: token.toString(), reply: JSON.stringify(crossed), asNumber: String(Number(token)) }
})

await mkdir(reportDirectory, { recursive: true })
await writeFile(path.join(reportDirectory, "step1-m2a-acceptance-executable.json"), `${JSON.stringify({ artifact: hostPath, recordedAt: new Date().toISOString(), results }, null, 2)}\n`)
for (const result of results) console.log(`${result.ok ? "pass" : "FAIL"}  ${result.name}  ${JSON.stringify(result.detail)}`)
process.exit(results.every((result) => result.ok) ? 0 : 1)
