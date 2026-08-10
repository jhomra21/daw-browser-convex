const { app, BrowserWindow, net, protocol, session } = require("electron")
const { existsSync } = require("node:fs")
const path = require("node:path")

const fixtureRoot = process.argv.at(-2)
const sampleRate = Number(process.argv.at(-1))
const audioDiagnostics = []

if (!fixtureRoot || !existsSync(fixtureRoot) || ![44100, 48000, 96000].includes(sampleRate)) {
  throw new Error("A portable Wasm worklet fixture directory is required.")
}

protocol.registerSchemesAsPrivileged([{
  scheme: "daw-test",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}])
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")
app.commandLine.appendSwitch("use-fake-device-for-media-stream")

const fixturePath = (requestUrl) => {
  const relative = new URL(requestUrl).pathname
  const filePath = path.resolve(fixtureRoot, `.${relative === "/" ? "/index.html" : relative}`)
  return filePath.startsWith(`${fixtureRoot}${path.sep}`) || filePath === path.join(fixtureRoot, "index.html")
    ? filePath
    : null
}

app.whenReady().then(async () => {
  protocol.handle("daw-test", (request) => {
    const filePath = fixturePath(request.url)
    return filePath && existsSync(filePath)
      ? net.fetch(new URL(`file://${filePath}`).toString())
      : new Response("Not found", { status: 404 })
  })
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: {
      ...details.responseHeaders,
      "Content-Security-Policy": ["default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'"],
    },
  }))
  const window = new BrowserWindow({
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.debugger.attach("1.3")
  window.webContents.debugger.on("message", (_event, method, parameters) => {
    const node = parameters.node
    const context = parameters.context
    if ((method === "WebAudio.contextChanged" && context)
      || (method === "WebAudio.audioNodeCreated" && node && node.nodeType === "AudioWorklet")) {
      audioDiagnostics.push({ method, parameters })
    }
  })
  window.webContents.on("console-message", (_event, _level, message, line, sourceId) => {
    process.stderr.write(`renderer: ${message} (${sourceId}:${line})\n`)
  })
  window.webContents.on("did-fail-load", (_event, _code, description, validatedUrl) => {
    process.stderr.write(`load failed: ${description} (${validatedUrl})\n`)
  })
  await window.loadURL(`daw-test://fixture/index.html?sampleRate=${sampleRate}`)
  await window.webContents.debugger.sendCommand("WebAudio.enable")
  const result = await window.webContents.executeJavaScript(`(async () => {
    try {
      return { ok: true, value: await globalThis.runPortableWasmWorkletFixture }
    } catch (error) {
      return {
        ok: false,
        error: {
          name: error && error.name,
          message: error && error.message,
          stack: error && error.stack,
          value: String(error),
        },
      }
    }
  })()`, true)
  if (!result || result.ok !== true) {
    throw new Error(`Portable fixture rejected: ${JSON.stringify(result && result.error)}`)
  }
  process.stdout.write(`${JSON.stringify(result.value)}\n`)
  app.exit(0)
}).catch((error) => {
  if (audioDiagnostics.length > 0) process.stderr.write(`audio diagnostics: ${JSON.stringify(audioDiagnostics)}\n`)
  const details = error && typeof error === "object"
    ? JSON.stringify(error, Object.getOwnPropertyNames(error))
    : String(error)
  process.stderr.write(`${error instanceof Error ? error.stack : details}\n`)
  app.exit(1)
})
