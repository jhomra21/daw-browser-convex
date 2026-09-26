import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { CommandTimings } from "./command-timings"

type HarnessServer = {
  readonly url: URL
  readonly uploadToken: string
  upload?: (body: Uint8Array) => Promise<Response>
  uploadStream?: (body: ReadableStream<Uint8Array>) => Promise<Response>
  stop: (closeActiveConnections?: boolean) => void
}

export const performanceUploadMaxBytes = 40 * 1024 * 1024
export const performanceStreamUploadMaxBytes = 1024 * 1024 * 1024
export async function* boundedFixtureStream(
  body: ReadableStream<Uint8Array>,
  maxBytes = performanceStreamUploadMaxBytes,
): AsyncGenerator<Uint8Array> {
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error("Fixture stream exceeds its fixed byte limit.")
    yield chunk
  }
}
export const browserCommandTimeoutMs = (args: readonly string[]) => {
  const timeoutIndex = args.indexOf("--timeout")
  const waitMs = timeoutIndex < 0 ? NaN : Number(args[timeoutIndex + 1])
  return Number.isSafeInteger(waitMs) && waitMs >= 0
    ? Math.max(30_000, waitMs + 10_000)
    : 30_000
}

type UploadGateState = "ready" | "in-progress" | "accepted"
type UploadGateInput = {
  readonly method: string
  readonly token: string | null
  readonly contentLength: number | null
}
type UploadGateDecision =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly status: 401 | 405 | 409 | 413 }

export const createUploadGate = (token: string, maxBytes = performanceUploadMaxBytes) => {
  let state: UploadGateState = "ready"
  return {
    begin(input: UploadGateInput): UploadGateDecision {
      if (input.method !== "POST") return { accepted: false, status: 405 }
      if (input.token !== token) return { accepted: false, status: 401 }
      if (state !== "ready") return { accepted: false, status: 409 }
      if (input.contentLength !== null && input.contentLength > maxBytes) return { accepted: false, status: 413 }
      state = "in-progress"
      return { accepted: true }
    },
    finish(success: boolean) {
      state = success ? "accepted" : "ready"
    },
  }
}

export const resolveContainedPath = (rootDirectory: string, pathname: string): string | undefined => {
  try {
    const decodedPath = decodeURIComponent(pathname)
    const root = path.resolve(rootDirectory)
    const resolved = path.resolve(root, `.${decodedPath}`)
    return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : undefined
  } catch {
    return undefined
  }
}

const readBoundedBody = async (request: Request, maxBytes: number): Promise<Uint8Array | undefined> => {
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return undefined
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export const browserCommand = async (session: string, args: readonly string[], timings?: CommandTimings) => {
  const environment = { ...process.env }
  delete environment.AGENT_BROWSER_CDP
  delete environment.AGENT_BROWSER_SESSION
  if (!session.startsWith("daw-30-track-electron-") && !environment.AGENT_BROWSER_EXECUTABLE_PATH && environment.HOME) {
    const browserGlob = new Bun.Glob("Library/Caches/ms-playwright/**/chrome-headless-shell")
    const candidates: string[] = []
    for await (const executablePath of browserGlob.scan({ cwd: environment.HOME, absolute: true })) {
      candidates.push(executablePath)
    }
    for (const executablePath of candidates.sort((left, right) => right.localeCompare(left))) {
      const details = await stat(executablePath).catch(() => undefined)
      if (details?.isFile() && (details.mode & 0o111) !== 0) {
        environment.AGENT_BROWSER_EXECUTABLE_PATH = executablePath
        break
      }
    }
  }
  const startedAt = Date.now()
  const start = performance.now()
  let exitCode: number | null = null
  let stdout: string
  let stderr: string
  try {
    // A stuck CDP daemon must not strand the runner or its disposable app.
    const childProcess = Bun.spawn(["agent-browser", "--session", session, ...args], {
      env: environment,
      signal: AbortSignal.timeout(browserCommandTimeoutMs(args)),
      stdout: "pipe",
      stderr: "pipe",
    })
    ;[stdout, stderr] = await Promise.all([
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ])
    exitCode = await childProcess.exited
  } finally {
    timings?.record("browser", args[0] ?? "unknown", startedAt, performance.now() - start, exitCode)
  }
  if (exitCode !== 0) throw new Error(`agent-browser ${args[0] ?? "command"} failed: ${stderr || stdout}`)
  return stdout.trim()
}

export const waitForBrowserValue = async (
  session: string,
  expression: string,
  timeoutMs: number,
  timings?: CommandTimings,
) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Browser wait bounds are invalid.")
  }
  try {
    await browserCommand(session, ["wait", "--fn", `(()=>{const value=(${expression});return value!==null&&value!==undefined})()`, "--timeout", String(timeoutMs)], timings)
    return await browserCommand(session, ["eval", `JSON.stringify(${expression})`], timings)
  } catch (error) {
    let diagnostics = ""
    try {
      diagnostics = await browserCommand(session, ["eval", `JSON.stringify({
        url: location.href,
        readyState: document.readyState,
        title: document.title,
        benchmarkPresent: typeof window.__thirtyTrackBenchmark !== "undefined",
        probePresent: typeof window.__thirtyTrackProbeResult !== "undefined",
        moduleScripts: [...document.querySelectorAll('script[type="module"]')].map((script) => script.getAttribute("src")),
        bodyText: document.body?.innerText?.slice(0, 500) ?? "",
      })`], timings)
    } catch (diagnosticError) {
      diagnostics = `diagnostics unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`
    }
    throw new Error(`Browser wait timed out for ${expression.slice(0, 240)}: ${error instanceof Error ? error.message : String(error)}; ${diagnostics}`)
  }
}

export const buildBrowserRuntime = async (input: {
  readonly entrypoint: string
  readonly name: string
}) => {
  const temporaryRoot = path.join(process.env.TMPDIR ?? "/tmp", `daw-performance-${crypto.randomUUID()}`)
  await mkdir(temporaryRoot, { recursive: true })
  const build = await Bun.build({
    entrypoints: [input.entrypoint],
    target: "browser",
    format: "esm",
    outdir: temporaryRoot,
    naming: `${input.name}.js`,
    alias: { "~": path.resolve(import.meta.dir, "../../src") },
  })
  if (!build.success) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw new Error(build.logs.map((log) => log.message).join("\n"))
  }
  return `${temporaryRoot}/${input.name}.js`
}

export const withBrowserServer = async <Value>(
  runtimePath: string,
  callback: (server: HarnessServer) => Promise<Value>,
): Promise<Value> => {
  const uploadToken = crypto.randomUUID()
  const uploadGate = createUploadGate(uploadToken)
  const streamUploadGate = createUploadGate(uploadToken, performanceStreamUploadMaxBytes)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: performanceStreamUploadMaxBytes,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/fixture-stream") {
        const length = request.headers.get("content-length")
        const size = length === null ? null : Number(length)
        const decision = streamUploadGate.begin({
          method: request.method,
          token: url.searchParams.get("token"),
          contentLength: Number.isSafeInteger(size) && size >= 0 ? size : null,
        })
        if (!decision.accepted) return new Response("Fixture upload rejected.", { status: decision.status })
        if (!request.body || !serverState.uploadStream) {
          streamUploadGate.finish(false)
          return new Response("Fixture stream unavailable.", { status: 413 })
        }
        try {
          const chunks = boundedFixtureStream(request.body)
          const boundedBody = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await chunks.next()
                if (next.done) return controller.close()
                controller.enqueue(next.value)
              } catch (error) {
                controller.error(error)
              }
            },
            cancel: () => chunks.return(),
          })
          const response = await serverState.uploadStream(boundedBody)
          streamUploadGate.finish(response.ok)
          return response
        } catch {
          streamUploadGate.finish(false)
          return new Response("Fixture stream failed.", { status: 500 })
        }
      }
      if (url.pathname === "/fixture") {
        const contentLengthHeader = request.headers.get("content-length")
        const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader)
        const decision = uploadGate.begin({
          method: request.method,
          token: url.searchParams.get("token"),
          contentLength: Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null,
        })
        if (!decision.accepted) return new Response("Fixture upload rejected.", { status: decision.status })
        const body = await readBoundedBody(request, performanceUploadMaxBytes)
        if (!body || !serverState.upload) {
          uploadGate.finish(false)
          return new Response("Fixture upload rejected.", { status: 413 })
        }
        try {
          const response = await serverState.upload(body)
          uploadGate.finish(response.ok)
          return response
        } catch {
          uploadGate.finish(false)
          return new Response("Fixture upload failed.", { status: 500 })
        }
      }
      if (url.pathname === "/") {
        return new Response(
          '<!doctype html><meta name="viewport" content="width=device-width"><script type="module" src="/runtime.js"></script>',
          { headers: { "content-type": "text/html" } },
        )
      }
      if (url.pathname === "/runtime.js") {
        return new Response(Bun.file(runtimePath), {
          headers: { "content-type": "text/javascript" },
        })
      }
      return new Response("Not found", { status: 404 })
    },
  })
  const serverState: HarnessServer = {
    url: server.url,
    uploadToken,
    stop: (closeActiveConnections = false) => server.stop(closeActiveConnections),
  }
  try {
    return await callback(serverState)
  } finally {
    server.stop(true)
    await rm(path.dirname(runtimePath), { recursive: true, force: true })
  }
}

export const withProductionBrowserServer = async <Value>(
  clientDirectory: string,
  runtimePath: string,
  callback: (server: HarnessServer) => Promise<Value>,
): Promise<Value> => {
  const indexPath = path.join(clientDirectory, "index.html")
  const index = await Bun.file(indexPath).text()
  const appModulePattern = /<script type="module"[^>]+src="[^"]+"[^>]*><\/script>/
  const appModule = index.match(appModulePattern)?.[0]
  if (!appModule) throw new Error("Production index does not contain an application module.")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/perf-runtime.js") {
        return new Response(Bun.file(runtimePath), { headers: { "content-type": "text/javascript" } })
      }
      if (url.pathname === "/api/convex-auth/token") {
        return new Response('{"token":null}', {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.pathname === "/api/auth/get-session") {
        return new Response("null", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.pathname.startsWith("/api/")) {
        return new Response("Not found", { status: 404 })
      }
      if (url.pathname === "/sw.js") {
        return new Response("/* benchmark no-op service worker */", {
          headers: { "content-type": "application/javascript" },
        })
      }
      if (url.pathname === "/") {
        const instrumentedIndex = index.replace(
          appModulePattern,
          (appScript) => `<script type="module" src="/perf-runtime.js"></script>${appScript}`,
        )
        return new Response(instrumentedIndex, {
          headers: { "content-type": "text/html" },
        })
      }
      const filePath = resolveContainedPath(clientDirectory, url.pathname)
      if (!filePath) return new Response("Not found", { status: 404 })
      if (!await Bun.file(filePath).exists()) return new Response("Not found", { status: 404 })
      return new Response(Bun.file(filePath))
    },
  })
  const serverState: HarnessServer = {
    url: server.url,
    stop: (closeActiveConnections = false) => server.stop(closeActiveConnections),
  }
  try {
    return await callback(serverState)
  } finally {
    server.stop(true)
  }
}
