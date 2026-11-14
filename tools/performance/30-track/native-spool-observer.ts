import { z } from "zod"
import { verifiedRendererSocket } from "./renderer-profile"
import { waitForAcceptanceEvent } from "./native-acceptance-ui"

export const instrumentSavedSpoolRelease = (source: string) => {
  const pattern = /await ([A-Za-z_$][\w$]*)\.release\(([A-Za-z_$][\w$]*)\.scope,\2\.takeId,\{([^{}]*savedClip[^{}]*)\}\)/g
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) throw new Error("Expected exactly one saved native source release boundary.")
  return source.replace(pattern, (_matched, bridge: string, take: string, receipt: string) =>
    `await globalThis.__nativeSpoolObservedRelease(()=>${bridge}.release(${take}.scope,${take}.takeId,{${receipt}}),${take}.scope,${take}.takeId,{${receipt}})`)
}
export const instrumentSpoolImport = (source: string) => {
  const matches = [...source.matchAll(/return await\s*\([A-Za-z_$][\w$]*\.importRecordingSpool\s*\?\?\s*[A-Za-z_$][\w$]*\)\s*\(/g)]
  if (matches.length !== 1 || matches[0]?.index === undefined) throw new Error("Expected exactly one native importer invocation.")
  const match = matches[0]
  const callStart = match.index + "return await".length
  const argumentStart = match.index + match[0].length - 1
  let depth = 1
  let quote = ""
  let escaped = false
  let end = argumentStart + 1
  for (; end < source.length && depth > 0; end++) {
    const character = source[end]!
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = ""
    } else if (character === "'" || character === '"' || character === "`") quote = character
    else if (character === "(") depth++
    else if (character === ")") depth--
  }
  if (depth !== 0) throw new Error("Unbalanced native importer invocation.")
  return source.slice(0, match.index) + "return await globalThis.__nativeSpoolObservedImport(()=>"
    + source.slice(callStart, end).trim() + ")" + source.slice(end)
}
export const instrumentSpoolScriptResponse = (body: string, base64Encoded: boolean) => {
  const source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body
  return Buffer.from(instrumentSpoolImport(instrumentSavedSpoolRelease(source)), "utf8").toString("base64")
}
export const parseSpoolEvaluation = (input: z.infer<ReturnType<typeof z.json>>) => {
  const reply = z.object({ result: z.object({ value: z.string().optional() }).passthrough(),
    exceptionDetails: z.json().optional() }).passthrough().parse(input)
  if (reply.exceptionDetails !== undefined || reply.result.value === undefined) throw new Error("Spool observation evaluation failed.")
  return reply.result.value
}
const ownedRendererTarget = z.object({
  targetId: z.string(), type: z.string(), url: z.string(),
}).passthrough()
const rendererTargetUrl = /^daw:\/\/app\/(?:\?[^#]*)?$/
const targetInfoFromEvent = z.object({ targetInfo: ownedRendererTarget }).passthrough()

// Subscribe before discovery and snapshot so renderer creation cannot race a
// one-shot target-list read. The caller already verified the owned app endpoint.
const waitForOwnedRendererTarget = async (endpoint: string) => {
  const browser = new URL(endpoint)
  if (browser.protocol !== "ws:" || browser.hostname !== "127.0.0.1"
    || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browser.pathname))
    throw new Error("Unverified owned browser endpoint.")
  const socket = new WebSocket(browser)
  const targets = new Map<string, z.infer<typeof ownedRendererTarget>>()
  let snapshotReady = false
  let onMessage: ((event: MessageEvent) => void) | undefined
  let onClose: (() => void) | undefined
  let onError: (() => void) | undefined
  let nextId = 0
  const pending = new Map<number, { resolve: (result: Record<string, z.infer<ReturnType<typeof z.json>>>) => void;
    reject: (error: Error) => void }>()
  const selected = new Promise<z.infer<typeof ownedRendererTarget>>((resolve, reject) => {
    const decide = () => {
      if (!snapshotReady) return
      if (targets.size > 1) reject(new Error("Ambiguous owned renderer targets."))
      else if (targets.size === 1) resolve([...targets.values()][0]!)
    }
    const opened = new Promise<void>((open, fail) => {
      socket.addEventListener("open", () => open(), { once: true })
      socket.addEventListener("error", () => fail(new Error("Owned browser inspector connection failed.")), { once: true })
      socket.addEventListener("close", () => fail(new Error("Owned browser inspector connection closed.")), { once: true })
    })
    onMessage = (event) => {
      const text = z.string().max(1_000_000).safeParse(event.data)
      if (!text.success) return
      try {
        const message = z.object({
          id: z.number().optional(), method: z.string().optional(),
          params: z.record(z.string(), z.json()).optional(),
          result: z.record(z.string(), z.json()).optional(),
          error: z.object({ message: z.string() }).optional(),
        }).passthrough().safeParse(JSON.parse(text.data))
        if (!message.success) return
        const data = message.data
        if (data.id !== undefined) {
          const request = pending.get(data.id)
          if (request) {
            pending.delete(data.id)
            if (data.error) request.reject(new Error(data.error.message))
            else request.resolve(data.result ?? {})
          }
        }
        if (data.method === "Target.targetDestroyed") {
          const destroyed = z.object({ targetId: z.string() }).safeParse(data.params)
          if (destroyed.success) targets.delete(destroyed.data.targetId)
          decide()
        }
        if (data.method === "Target.targetCreated" || data.method === "Target.targetInfoChanged") {
          const target = targetInfoFromEvent.safeParse(data.params)
          if (target.success) {
            if (target.data.targetInfo.type === "page" && rendererTargetUrl.test(target.data.targetInfo.url))
              targets.set(target.data.targetInfo.targetId, target.data.targetInfo)
            else targets.delete(target.data.targetInfo.targetId)
            decide()
          }
        }
      } catch { reject(new Error("Owned target discovery message was invalid.")) }
    }
    onClose = () => reject(new Error("Owned browser inspector closed."))
    onError = () => reject(new Error("Owned browser inspector failed."))
    socket.addEventListener("message", onMessage)
    socket.addEventListener("close", onClose)
    socket.addEventListener("error", onError)
    const send = (method: string, params: Record<string, z.infer<ReturnType<typeof z.json>>> = {}) =>
      new Promise<Record<string, z.infer<ReturnType<typeof z.json>>>>((accept, fail) => {
        const id = ++nextId
        pending.set(id, { resolve: accept, reject: fail })
        socket.send(JSON.stringify({ id, method, params }))
      })
    void opened.then(async () => {
      await send("Target.setDiscoverTargets", { discover: true })
      const snapshot = z.object({ targetInfos: z.array(ownedRendererTarget) }).parse(await send("Target.getTargets"))
      for (const target of snapshot.targetInfos) {
        if (target.type === "page" && rendererTargetUrl.test(target.url)) targets.set(target.targetId, target)
      }
      snapshotReady = true
      decide()
    }).catch(reject)
  })
  try {
    const target = await waitForAcceptanceEvent(selected, 15000)
    if (!target) throw new Error("Owned renderer target readiness deadline.")
    return target
  } finally {
    if (onMessage) socket.removeEventListener("message", onMessage)
    if (onClose) socket.removeEventListener("close", onClose)
    if (onError) socket.removeEventListener("error", onError)
    for (const request of pending.values()) request.reject(new Error("Owned target discovery closed."))
    pending.clear()
    socket.close()
  }
}
const replySchema = z.object({
  id: z.number().optional(), method: z.string().optional(),
  result: z.record(z.string(), z.json()).optional(),
  params: z.record(z.string(), z.json()).optional(),
  error: z.object({ message: z.string() }).passthrough().optional(),
}).passthrough()

// Shared owned-renderer transport. Callers must verify launch/PID/profile/listener
// ownership before passing the endpoint; this additionally checks renderer identity.
export const openAcceptanceInspector = async (endpoint: string) => {
  await waitForOwnedRendererTarget(endpoint)
  const socket = new WebSocket(await verifiedRendererSocket(endpoint))
  const opened = new Promise<true>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(true), { once: true })
    socket.addEventListener("error", () => reject(new Error("Acceptance observation socket failed.")), { once: true })
    socket.addEventListener("close", () => reject(new Error("Acceptance observation socket closed.")), { once: true })
  })
  try {
    if (!await waitForAcceptanceEvent(opened, 15000)) throw new Error("Acceptance observation connection deadline.")
  } catch (error) { socket.close(); throw error }
  let nextId = 0
  type InspectorFields = Record<string, z.infer<ReturnType<typeof z.json>>>
  const pending = new Map<number, { resolve: (result: InspectorFields) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const listeners = new Set<(message: z.infer<typeof replySchema>) => void>()
  const closed = Promise.withResolvers<void>()
  const closePending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error("Acceptance observer closed."))
    }
    pending.clear()
  }
  const send = (method: string, params: InspectorFields = {}) =>
    new Promise<InspectorFields>((resolve, reject) => {
      const id = ++nextId
      // Existing bounded inspector deadline, never a native queue/drain deadline.
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Acceptance inspector ${method} deadline.`)) }, 15000)
      pending.set(id, { resolve, reject, timer })
      try { socket.send(JSON.stringify({ id, method, params })) } catch {
        clearTimeout(timer); pending.delete(id); reject(new Error("Acceptance inspector send failed."))
      }
    })
  socket.addEventListener("message", (event) => {
    const text = z.string().max(12000000).safeParse(event.data)
    if (!text.success) return
    try {
      const parsed = replySchema.safeParse(JSON.parse(text.data))
      if (!parsed.success) return
      const message = parsed.data
      if (message.id !== undefined) {
        const request = pending.get(message.id)
        if (request) {
          clearTimeout(request.timer); pending.delete(message.id)
          if (message.error) request.reject(new Error(message.error.message))
          else request.resolve(message.result ?? {})
        }
      }
      for (const listener of listeners) listener(message)
    } catch { closePending(); socket.close() }
  })
  const close = () => { closePending(); closed.resolve() }
  socket.addEventListener("close", close)
  socket.addEventListener("error", close)
  return {
    send,
    closed: closed.promise,
    listen: (listener: (message: z.infer<typeof replySchema>) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => { listeners.clear(); socket.close(); closePending() },
  }
}

// Response-stage CDP observation changes only two disposable invocation wrappers,
// not packaged/source bytes or any gate. The awaited observation makes a public snapshot
// and bounded file/proof checks before invoking the exact original release.
// No sampling/profiler or recurring task is installed.
export const installSpoolReleaseObserver = async (
  endpoint: string, observeSaved: (input: string, evaluate: (expression: string) => Promise<string>) => Promise<void>,
) => {
  const inspector = await openAcceptanceInspector(endpoint)
  const send = inspector.send
  let observerError: Error | undefined
  let changed = 0
  let bootstrapId = ""
  let resolveIntercepted = () => {}
  let rejectIntercepted = (_error: Error) => {}
  const intercepted = new Promise<void>((resolve, reject) => { resolveIntercepted = resolve; rejectIntercepted = reject })
  inspector.listen((message) => {
    if (message.method === "Fetch.requestPaused") {
      const paused = z.object({ requestId: z.string(), responseStatusCode: z.number().optional() }).parse(message.params)
      void (async () => {
        const response = await send("Fetch.getResponseBody", { requestId: paused.requestId })
        const body = z.object({ body: z.string(), base64Encoded: z.boolean() }).parse(response)
        const observed = instrumentSpoolScriptResponse(body.body, body.base64Encoded)
        if (++changed !== 1) throw new Error("Repeated release script interception.")
        await send("Fetch.fulfillRequest", { requestId: paused.requestId, responseCode: paused.responseStatusCode ?? 200,
          responseHeaders: [{ name: "Content-Type", value: "text/javascript" }], body: observed })
        resolveIntercepted()
      })().catch((error) => rejectIntercepted(error instanceof Error ? error : new Error("Script observation failed.")))
    }
    if (message.method === "Runtime.bindingCalled" && message.params?.name === "__nativeSpoolSavedBinding") {
      const payload = z.string().max(4096).parse(message.params.payload)
      const evaluate = async (expression: string) => parseSpoolEvaluation(await send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true,
      }))
      void observeSaved(payload, evaluate).then(() => send("Runtime.evaluate", {
        expression: "globalThis.__nativeSpoolSavedObservationResolve()", returnByValue: true,
      })).catch((error) => {
        observerError = error instanceof Error ? error : new Error("Saved observation failed.")
        void send("Runtime.evaluate", {
          expression: "globalThis.__nativeSpoolObservationFailure=true;globalThis.__nativeSpoolSavedObservationReject(new Error('Bounded saved-clip observation failed; source retained.'))",
          returnByValue: true,
        }).catch(() => undefined)
      })
    }
  })
  try {
    await send("Runtime.enable")
    await send("Runtime.addBinding", { name: "__nativeSpoolSavedBinding" })
    await send("Page.enable")
    const releaseBootstrap = `globalThis.__nativeSpoolReleaseEvents=[];globalThis.__nativeSpoolObservedRelease=async(call,scope,takeId,acknowledgment)=>{const events=globalThis.__nativeSpoolReleaseEvents;if(events.length>=4)throw new Error('Release observer bound exceeded.');events.push({kind:'release-request',atEpochMs:Date.now(),frames:acknowledgment.frames,bytes:acknowledgment.bytes,blocks:acknowledgment.blocks,sampleRateHz:acknowledgment.sampleRateHz,channelCount:acknowledgment.channelCount,finalized:acknowledgment.finalized,savedClipPresent:!!acknowledgment.savedClip});await new Promise((resolve,reject)=>{globalThis.__nativeSpoolSavedObservationResolve=resolve;globalThis.__nativeSpoolSavedObservationReject=reject;globalThis.__nativeSpoolSavedBinding(JSON.stringify({scope,takeId,acknowledgment}))});globalThis.__nativeSpoolOriginalReleaseInvoked=true;await call();events.push({kind:'release-success',atEpochMs:Date.now()})};`
    const importBootstrap = "globalThis.__nativeSpoolImportEvidence=null;globalThis.__nativeSpoolObservedImport=async(call)=>{const start=performance.now();try{const result=await call();const a=result.nativeTake?.acknowledgment;globalThis.__nativeSpoolImportEvidence={durationMs:performance.now()-start,frames:a?.frames??null,bytes:a?.bytes??null,blocks:a?.blocks??null,sampleRateHz:a?.sampleRateHz??null,channelCount:a?.channelCount??null,finalized:a?.finalized??false};return result}catch(error){globalThis.__nativeSpoolImportEvidence={durationMs:performance.now()-start,failed:true};throw error}}"
    const bootstrap = await send("Page.addScriptToEvaluateOnNewDocument", { source: releaseBootstrap + importBootstrap })
    bootstrapId = z.string().parse(bootstrap.identifier)
    await send("Fetch.enable", { patterns: [{ urlPattern: "daw://app/*index-*.js", requestStage: "Response" }] })
    await send("Page.reload", { ignoreCache: true })
    // Bound supported response interception; no indefinite pending reload.
    const deadline = setTimeout(() => rejectIntercepted(new Error("Packaged response observation deadline.")), 15000)
    try { await intercepted } finally { clearTimeout(deadline) }
    await send("Fetch.disable")
    return {
      error: () => observerError,
      close: async () => {
        await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: bootstrapId })
        inspector.close()
      },
    }
  } catch (error) { inspector.close(); throw error }
}
