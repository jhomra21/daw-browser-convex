import { createHash } from "node:crypto"
import { z } from "zod"
import { writePrivateArtifact } from "./electron"

const rawProfile = z.object({
  startTime: z.number(), endTime: z.number(),
  nodes: z.array(z.object({
    id: z.number().int(), callFrame: z.object({ functionName: z.string() }).passthrough(),
    children: z.array(z.number().int()).optional(),
  }).passthrough()).max(100_000),
  samples: z.array(z.number().int()).max(100_000),
  timeDeltas: z.array(z.number()).max(100_000),
}).passthrough()
type RendererProfile = z.input<typeof rawProfile>
type CdpReply = { readonly id: number; readonly result?: { readonly profile?: RendererProfile }; readonly error?: { readonly message: string } }
const replySchema = z.object({
  id: z.number().int(),
  result: z.object({ profile: rawProfile.optional() }).passthrough().optional(),
  error: z.object({ message: z.string() }).passthrough().optional(),
}).passthrough()
const messageSchema = z.string().max(12_000_000)
const targetSchema = z.array(z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string() }).passthrough())

export const selectRendererProfileTarget = (targets: z.input<typeof targetSchema>) => {
  const matches = targetSchema.parse(targets).filter((target) => target.type === "page" && /^daw:\/\/app\/(?:\?[^#]*)?$/.test(target.url))
  if (matches.length !== 1 || !matches[0]) throw new Error("Verified renderer target unavailable for profiling.")
  return matches[0]
}

export const verifiedRendererSocket = async (browserUrl: string): Promise<URL> => {
  const endpoint = new URL(browserUrl)
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint.pathname)) throw new Error("Unverified browser endpoint.")
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)
  const text = await response.text()
  if (text.length > 1_000_000) throw new Error("Renderer target list exceeded size limit.")
  const socketUrl = new URL(selectRendererProfileTarget(JSON.parse(text)).webSocketDebuggerUrl)
  if (socketUrl.protocol !== "ws:" || socketUrl.hostname !== "127.0.0.1" || socketUrl.port !== endpoint.port
    || !/^\/devtools\/page\/[a-zA-Z0-9-]+$/.test(socketUrl.pathname)) throw new Error("Renderer CDP endpoint identity mismatch.")
  return socketUrl
}

export const sanitizeRendererProfile = (input: RendererProfile) => {
  const parsed = rawProfile.parse(input)
  return {
    startTime: parsed.startTime, endTime: parsed.endTime,
    nodes: parsed.nodes.map((node) => ({
      id: node.id,
      nameHash: createHash("sha256").update(node.callFrame.functionName).digest("hex").slice(0, 16),
      children: node.children,
    })),
    samples: parsed.samples, timeDeltas: parsed.timeDeltas,
  }
}

const profileActivitySchema = z.object({
  startedAtEpochMs: z.number().finite(),
  nodes: z.array(z.object({ id: z.number().int(), nameHash: z.string() }).passthrough()).max(100_000),
  samples: z.array(z.number().int()).max(100_000),
  timeDeltas: z.array(z.number().finite().nonnegative()).max(100_000),
}).passthrough()
export const rendererActivityDuringReturn = (
  input: z.input<typeof profileActivitySchema>,
  interval: { returnedAtEpochMs: number; receivedAtEpochMs: number },
) => {
  const profile = profileActivitySchema.parse(input)
  if (profile.samples.length !== profile.timeDeltas.length || interval.receivedAtEpochMs <= interval.returnedAtEpochMs) return null
  const hashes = new Map(profile.nodes.map((node) => [node.id, node.nameHash]))
  let elapsedMs = 0
  let idleSamples = 0
  let programSamples = 0
  let activeSamples = 0
  for (let index = 0; index < profile.samples.length; index += 1) {
    elapsedMs += profile.timeDeltas[index]! / 1_000
    const time = profile.startedAtEpochMs + elapsedMs
    if (time < interval.returnedAtEpochMs || time > interval.receivedAtEpochMs) continue
    const hash = hashes.get(profile.samples[index]!)
    if (hash === "c6509f06a5b98639") idleSamples += 1
    else if (hash === "ab00344a2303215c") programSamples += 1
    else activeSamples += 1
  }
  return idleSamples + programSamples + activeSamples > 0 ? { idleSamples, programSamples, activeSamples } : null
}

// Profiler sampling is intentionally narrow: CDP tracing can contain arbitrary
// request payloads and has no reliable bounded in-memory event queue.
export const startRendererProfile = async (browserUrl: string, artifactPath: string) => {
  const startedAtEpochMs = Date.now()
  const socketUrl = await verifiedRendererSocket(browserUrl)
  const socket = new WebSocket(socketUrl)
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("Renderer profiler connection failed.")), { once: true })
    socket.addEventListener("close", () => reject(new Error("Renderer profiler connection closed.")), { once: true })
  })
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Renderer profiler connection timed out.")), 3_000))])
  } catch (error) {
    socket.close()
    throw error
  }
  let nextId = 0
  const pending = new Map<number, { resolve: (value: CdpReply) => void; reject: (error: Error) => void }>()
  const failPending = () => {
    for (const entry of pending.values()) entry.reject(new Error("Renderer profiler connection lost."))
    pending.clear()
  }
  socket.addEventListener("message", (event) => {
    const message = messageSchema.safeParse(event.data)
    if (!message.success) { failPending(); socket.close(); return }
    try {
      const response = replySchema.safeParse(JSON.parse(message.data))
      if (!response.success) return
      const entry = pending.get(response.data.id)
      pending.delete(response.data.id)
      if (response.data.error) entry?.reject(new Error("Renderer profiler command failed."))
      else entry?.resolve(response.data)
    } catch {
      failPending()
      socket.close()
    }
  })
  socket.addEventListener("close", failPending)
  socket.addEventListener("error", failPending)
  const send = (method: string) => new Promise<CdpReply>((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    try { socket.send(JSON.stringify({ id, method })) } catch {
      pending.delete(id)
      reject(new Error("Renderer profiler command could not be sent."))
    }
  })
  try {
    await Promise.race([send("Profiler.enable").then(() => send("Profiler.start")), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Renderer profiler start timed out.")), 3_000))])
  } catch (error) {
    socket.close()
    throw error
  }
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    try {
      const result = await Promise.race([
        send("Profiler.stop"),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ])
      if (result?.result?.profile) {
        const sanitized = sanitizeRendererProfile(result.result.profile)
        const contents = JSON.stringify({ ...sanitized, startedAtEpochMs })
        if (Buffer.byteLength(contents) <= 8_000_000) await writePrivateArtifact(artifactPath, contents)
      }
    } finally {
      socket.close()
    }
  }
  // Hard stop bounds profiling even if the recording workload hangs.
  const deadline = setTimeout(() => { void stop().catch(() => undefined) }, 60_000)
  return async () => {
    clearTimeout(deadline)
    await stop()
  }
}
