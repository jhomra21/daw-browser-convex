import { z } from "zod"
import { writePrivateArtifact } from "./electron"
import { verifiedRendererSocket } from "./renderer-profile"

const names = ["RunTask", "ThreadControllerImpl::RunTask", "MessageLoop::RunTask", "PostMessage", "MessagePort::dispatch", "MessagePortMessage", "FunctionCall", "EvaluateScript", "V8.Execute", "V8.RunMicrotasks"] as const
const eventSchema = z.object({ name: z.enum(names), ts: z.number().finite(), dur: z.number().finite().nonnegative().optional() }).passthrough()
export const rendererTraceCategories = "devtools.timeline"
export const rendererTraceWindowMs = 1_000
export const traceEpochRange = (
  range: { startedAtEpochMs: number; stoppedAtEpochMs: number },
  interval: { returnedAtEpochMs: number; receivedAtEpochMs: number },
) => range.startedAtEpochMs <= interval.returnedAtEpochMs && range.stoppedAtEpochMs >= interval.receivedAtEpochMs
export const onceAsync = (work: () => Promise<void>) => {
  let pending: Promise<void> | undefined
  return () => pending ??= work()
}

export const summarizeRendererTrace = (raw: string) => {
  if (Buffer.byteLength(raw) > 8_000_000) throw new Error("Renderer trace exceeded byte limit.")
  const parsed = z.object({ traceEvents: z.array(z.unknown()).max(100_000) }).passthrough().parse(JSON.parse(raw))
  const events = parsed.traceEvents.flatMap((entry) => {
    const event = eventSchema.safeParse(entry)
    if (!event.success) return []
    return [{ name: event.data.name, ts: event.data.ts, dur: event.data.dur ?? 0 }]
  })
  const counts: Record<string, number> = {}
  if (events.length > 20_000) throw new Error("Relevant renderer trace events exceeded limit.")
  for (const event of events) counts[event.name] = (counts[event.name] ?? 0) + 1
  return { events, counts }
}

// CDP only exposes a raw stream; keep it in memory for the minimum duration,
// reject oversized chunks before decoding, and never persist unfiltered events.
export const startRendererTrace = async (browserUrl: string, artifactPath: string) => {
  const socket = new WebSocket(await verifiedRendererSocket(browserUrl))
  const pending = new Map<number, { resolve: (value: z.infer<typeof replySchema>["result"]) => void; reject: (error: Error) => void }>()
  let nextId = 0
  const fail = () => {
    for (const entry of pending.values()) entry.reject(new Error("Renderer trace connection lost."))
    pending.clear()
  }
  socket.addEventListener("close", fail)
  socket.addEventListener("error", fail)
  const replySchema = z.object({ id: z.number().optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).passthrough()
  socket.addEventListener("message", (message) => {
    const text = z.string().max(8_100_000).safeParse(message.data)
    if (!text.success) { fail(); socket.close(); return }
    try {
      const reply = replySchema.parse(JSON.parse(text.data))
      if (reply.method === "Tracing.tracingComplete") { complete?.(reply.params); return }
      if (reply.id === undefined) return
      const entry = pending.get(reply.id)
      pending.delete(reply.id)
      if (reply.error) entry?.reject(new Error("Renderer trace command failed."))
      else entry?.resolve(reply.result)
    } catch { fail(); socket.close() }
  })
  let complete: ((params: z.infer<typeof replySchema>["params"]) => void) | undefined
  const command = (method: string, params?: { categories?: string; transferMode?: string; handle?: string; size?: number }) => new Promise<z.infer<typeof replySchema>["result"]>((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    try { socket.send(JSON.stringify({ id, method, params })) } catch { pending.delete(id); reject(new Error("Renderer trace command failed.")) }
  })
  const deadline = AbortSignal.timeout(65_000)
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) => deadline.addEventListener("abort", () => reject(new Error("Renderer trace deadline exceeded.")), { once: true }))])
  let startedAtEpochMs = 0
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) resolve()
      else { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Renderer trace connection failed.")), { once: true }) }
    }))
    await bounded(command("Tracing.start", { categories: rendererTraceCategories, transferMode: "ReturnAsStream" }))
    startedAtEpochMs = Date.now()
  } catch (error) { socket.close(); throw error }
  const stop = onceAsync(async () => {
    const stoppedAtEpochMs = Date.now()
    try {
      const stream = bounded(new Promise<string>((resolve, reject) => {
        complete = (params) => {
          const result = z.object({ stream: z.string() }).safeParse(params)
          if (result.success) resolve(result.data.stream)
          else reject(new Error("Renderer trace stream unavailable."))
        }
      }))
      await bounded(command("Tracing.end"))
      const handle = await stream
      let raw = ""
      try {
        while (true) {
          const response = z.object({ data: z.string().max(8_000_000), eof: z.boolean().optional(), base64Encoded: z.boolean().optional() }).parse(await bounded(command("IO.read", { handle, size: 65_536 })))
          const chunk = response.base64Encoded ? Buffer.from(response.data, "base64").toString("utf8") : response.data
          if (Buffer.byteLength(raw) + Buffer.byteLength(chunk) > 8_000_000) throw new Error("Renderer trace exceeded byte limit.")
          raw += chunk
          if (response.eof) break
        }
        await writePrivateArtifact(artifactPath, JSON.stringify({
          ...summarizeRendererTrace(raw), startedAtEpochMs, stoppedAtEpochMs,
        }))
      } finally { await bounded(command("IO.close", { handle })).catch(() => undefined) }
    } finally { socket.close() }
  })
  // Recording can hang; close this runner-owned CDP trace after a fixed window.
  const timer = setTimeout(() => { void stop().catch(() => undefined) }, rendererTraceWindowMs)
  return async () => {
    clearTimeout(timer)
    await stop()
  }
}
