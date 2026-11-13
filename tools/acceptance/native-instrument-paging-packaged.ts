#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import {
  controlApprovalResultSchemaV1,
  controlCapabilitiesSchemaV2,
  controlCommitResultSchemaV1,
  controlPreviewResultSchemaV1,
  projectSnapshotSchemaV2,
} from "@daw-browser/control"
import {
  assignSampleToDrumRackPad,
  createDefaultDrumRackParams,
  createDefaultGranularParams,
  createDefaultSamplerParams,
  type DrumRackPadSample,
} from "@daw-browser/shared"
import { readWav } from "./ae08-wav"
import { createPrivateRunDirectory } from "../performance/30-track/electron"
import { ownedV3CdpEndpoint } from "../performance/30-track/v3-import-acceptance"

const root = path.resolve(import.meta.dir, "../..")
const packagedApp = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app")
const executable = path.join(packagedApp, "Contents/MacOS/@daw-browser-desktop")
const resources = path.join(packagedApp, "Contents/Resources")
const reportDirectory = process.env.DAW_ACCEPTANCE_REPORT_DIRECTORY
  ? path.resolve(process.env.DAW_ACCEPTANCE_REPORT_DIRECTORY)
  : path.join(root, "acceptance-reports/native-instrument-sample-paging-2026-10-17/scripted")
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`
const runLogPath = path.join(reportDirectory, `packaged-harness-${runId}.log`)
const fixturesDirectory = path.join(root, "acceptance-reports/native-instrument-sample-paging-2026-10-17/fixtures")
// Pin the run to one packaged build so evidence can never mix builds.
const expectedAsarBytes = z.coerce.number().int().positive().parse(process.env.DAW_EXPECTED_ASAR_SIZE)
const expectedHostBytes = z.coerce.number().int().positive().parse(process.env.DAW_EXPECTED_HOST_SIZE)
const expectedAsarMtime = z.string().min(1).parse(process.env.DAW_EXPECTED_ASAR_MTIME)
const readyTimeoutMs = z.coerce.number().int().positive().default(90_000).parse(process.env.DAW_ACCEPTANCE_READY_TIMEOUT_MS)
const expectedFixtures = new Map([
  ["stereo-48k-8s.wav", "2af525267cde23d3a565e0a3b5aab5fcccefec358ec89f1b731dc7e0620b3be8"],
  ["stereo-48k-180s.wav", "25b30c4e9d14cc403cfd3d67e3d777697fa0bcf9a5db108776598d8ae89f15ec"],
])
type Device = "granular" | "sampler" | "drum-rack"
const devices: Device[] = ["granular", "sampler", "drum-rack"]
const modes: ("native live" | "native export")[] = ["native live", "native export"]
const sources: { file: string; seconds: number; frames: number; markerFrame: number }[] = [
  { file: "stereo-48k-8s.wav", seconds: 8, frames: 384_000, markerFrame: 345_600 },
  { file: "stereo-48k-180s.wav", seconds: 180, frames: 8_640_000, markerFrame: 7_776_000 },
]
const eventSchema = z.record(z.string(), z.json())
const exportStatusSchema = z.object({ status: z.json().optional(), job: z.object({ id: z.string() }).passthrough().optional() }).passthrough()
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type RunContext = {
  cell: string
  directory: string
  deadline: number
  appExit?: Promise<never>
  appExitInfo?: string
}
let runContext: RunContext | undefined
type Cdp = {
  call: (method: string, params?: { [key: string]: Json }) => Promise<Json>
  close: () => void
}
const globalDeadline = Date.now() + 95 * 60_000
const selectedCells = process.env.DAW_ACCEPTANCE_CELLS?.split(",").map((cell) => cell.trim()).filter(Boolean)
const log = async (message: string) => {
  const line = `[${new Date().toISOString()}] ${message}\n`
  console.log(line.trimEnd())
  await appendFile(runLogPath, line, { mode: 0o600 })
}
const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out at step "${label}" after ${timeoutMs} ms`)), timeoutMs)
  })
  const guarded = runContext?.appExit
    ? Promise.race([promise, runContext.appExit])
    : promise
  try {
    return await Promise.race([guarded, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const remaining = (fallback: number) => Math.max(1, Math.min(fallback, (runContext?.deadline ?? globalDeadline) - Date.now(), globalDeadline - Date.now()))
type Cell = {
  device: Device
  source: string
  durationSeconds: number
  mode: "native live" | "native export"
  result: "PASS" | "FAIL" | "BLOCKED"
  pass: boolean
  metrics: Record<string, number | boolean | string | null>
  evidence: string[]
  error?: string
}

const localTimestamp = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
const unwrap = (value: Json) => {
  const envelope = z.object({ data: z.json() }).passthrough().parse(value)
  return envelope.data
}
const command = async (profile: string, args: string[], input?: Json) => {
  const label = `daw-control ${args.join(" ")}`
  await log(`${runContext?.cell ?? "setup"}: start ${label}`)
  const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
    cwd: root,
    env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") },
    stdout: "pipe",
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : "pipe",
  })
  if (input !== undefined && child.stdin) {
    child.stdin.write(`${JSON.stringify(input)}\n`)
    child.stdin.end()
  }
  const finished = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  let stdout: string
  let stderr: string
  let exitCode: number
  try {
    [stdout, stderr, exitCode] = await withTimeout(finished, remaining(30_000), label)
  } catch (error) {
    child.kill("SIGKILL")
    await Promise.race([child.exited, Bun.sleep(2_000)])
    throw error
  }
  if (exitCode !== 0) throw new Error(`daw-control ${args.join(" ")} failed: ${stderr.slice(0, 700)}`)
  await log(`${runContext?.cell ?? "setup"}: done ${label}`)
  return unwrap(JSON.parse(stdout))
}
const waitFor = async (condition: () => Promise<boolean>, timeoutMs: number, label: string) => {
  const deadline = Math.min(Date.now() + timeoutMs, runContext?.deadline ?? globalDeadline, globalDeadline)
  await log(`${runContext?.cell ?? "setup"}: wait ${label}`)
  while (Date.now() < deadline) {
    if (await withTimeout(condition(), remaining(Math.min(15_000, deadline - Date.now())), label)) {
      await log(`${runContext?.cell ?? "setup"}: ready ${label}`)
      return
    }
    await Bun.sleep(200)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
const cdpConnect = (endpoint: string, targetId: string) => new Promise<Cdp>((resolve, reject) => {
  const socket = new WebSocket(endpoint)
  let sequence = 1
  let sessionId = ""
  const fail = (error: Error) => {
    clearTimeout(connectTimer)
    socket.close()
    reject(error)
  }
  const connectTimer = setTimeout(() => fail(new Error('Timed out at step "CDP WebSocket connect"')), remaining(15_000))
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>()
  const finish = () => {
    clearTimeout(connectTimer)
    resolve({
    call: (method, params = {}) => withTimeout(new Promise((done, fail) => {
      const id = sequence++
      pending.set(id, { resolve: done, reject: fail })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    }), remaining(15_000), `CDP ${method}`),
    close: () => socket.close(),
    })
  }
  socket.addEventListener("open", () => {
    const id = sequence++
    pending.set(id, { resolve: () => undefined, reject })
    socket.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId, flatten: true } }))
  })
  socket.addEventListener("message", (message) => {
    const parsed = z.object({
      id: z.number().optional(),
      result: z.json().optional(),
      error: z.object({ message: z.string().optional() }).optional(),
      sessionId: z.string().optional(),
    }).passthrough().parse(JSON.parse(String(message.data)))
    if (parsed.id === undefined) return
    const request = pending.get(parsed.id)
    if (!request) return
    pending.delete(parsed.id)
    if (parsed.error) {
      request.reject(new Error(parsed.error.message ?? "CDP request failed"))
      return
    }
    if (!sessionId) {
      sessionId = z.object({ sessionId: z.string() }).parse(parsed.result).sessionId
      void Promise.all([
        socket.send(JSON.stringify({ id: sequence++, method: "Page.enable", sessionId })),
        socket.send(JSON.stringify({ id: sequence++, method: "Runtime.enable", sessionId })),
      ])
      finish()
      return
    }
    request.resolve(parsed.result ?? null)
  })
  socket.addEventListener("error", () => fail(new Error("Packaged app CDP connection failed")))
})
const evaluate = async (cdp: Cdp, expression: string) => {
  const response = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  const parsed = z.object({
    result: z.object({ value: z.json().optional() }).passthrough(),
    exceptionDetails: z.object({ text: z.string().optional() }).optional(),
  }).passthrough().parse(response)
  if (parsed.exceptionDetails) throw new Error(`Renderer evaluation failed: ${parsed.exceptionDetails.text ?? expression}`)
  return parsed.result.value ?? null
}
const screenshot = async (cdp: Cdp, file: string) => {
  await log(`${runContext?.cell ?? "setup"}: CDP screenshot ${path.basename(file)}`)
  const response = z.object({ data: z.string() }).parse(await cdp.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  }))
  await writeFile(file, Buffer.from(response.data, "base64"), { mode: 0o600 })
}
const fetchJsonWithTimeout = async (url: string, timeoutMs: number, label: string) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await withTimeout(fetch(url, { signal: controller.signal }).then((response) => response.json()), timeoutMs, label)
  } finally {
    clearTimeout(timer)
  }
}
const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex")

const instrumentParams = (device: Device, asset: { id: string; name: string; durationSec: number; sampleRate: number; channelCount: number }) => {
  const sample: DrumRackPadSample = {
    assetKey: asset.id,
    url: `local-asset:${asset.id}`,
    name: asset.name,
    sourceKind: "upload",
    source: { durationSec: asset.durationSec, sampleRate: asset.sampleRate, channelCount: asset.channelCount },
  }
  const zone = {
    id: `paging-${device}-zone`,
    sample,
    keyLow: 0,
    keyHigh: 127,
    velocityLow: 1,
    velocityHigh: 127,
    rootNote: 60,
    tuneCents: 0,
    gain: 1,
    pan: 0,
    roundRobinGroup: 0,
    roundRobinIndex: 0,
    playbackMode: "one-shot",
    startSec: 0,
    endSec: asset.durationSec,
    crossfadeSec: 0,
    chokeGroup: 0,
  }
  if (device === "sampler") return { ...createDefaultSamplerParams(), maxDecodedBytes: 1_073_741_824, zones: [zone] }
  if (device === "granular") return {
    ...createDefaultGranularParams(),
    maxDecodedBytes: 1_073_741_824,
    position: 0.9,
    spray: 0,
    reverseProbability: 0,
    zone,
  }
  const rack = assignSampleToDrumRackPad(createDefaultDrumRackParams(), "pad-36", sample)
  return {
    ...rack,
    pads: rack.pads.map((pad) => pad.id === "pad-36" ? { ...pad, startSec: 0, endSec: asset.durationSec } : pad),
  }
}

const instrumentStatus = (device: Device, fixtureName: string) => {
  const deviceName = device === "drum-rack" ? "Drum Rack" : device === "sampler" ? "Sampler" : "Granular"
  const terminalStates = `[...document.querySelectorAll('button')].some(button=>['ready','error'].includes(button.textContent?.trim()??''))`
  return `(!document.body.innerText.includes('No devices on this track') && document.body.innerText.includes(${JSON.stringify(fixtureName)}) && document.body.innerText.includes(${JSON.stringify(deviceName)}) && (${terminalStates} || document.body.innerText.includes('Native playback failed during')))`
}

const analyzeMarker = (samples: Float32Array, channels: number, sampleRate: number, startFrame: number, frames: number) => {
  const targetHz = [880, 1320]
  const amplitudes = targetHz.map((frequency, channel) => {
    let real = 0
    let imaginary = 0
    for (let frame = 0; frame < frames; frame++) {
      const sample = samples[(startFrame + frame) * channels + channel] ?? 0
      const phase = 2 * Math.PI * frequency * frame / sampleRate
      real += sample * Math.cos(phase)
      imaginary += sample * Math.sin(phase)
    }
    return 2 * Math.hypot(real, imaginary) / frames
  })
  const rms = targetHz.map((_frequency, channel) => {
    let square = 0
    for (let frame = 0; frame < frames; frame++) {
      const sample = samples[(startFrame + frame) * channels + channel] ?? 0
      square += sample * sample
    }
    return Math.sqrt(square / frames)
  })
  return { leftMarkerAmplitude: amplitudes[0] ?? 0, rightMarkerAmplitude: amplitudes[1] ?? 0, leftRms: rms[0] ?? 0, rightRms: rms[1] ?? 0 }
}

const buildIdentity = async () => {
  const asar = await stat(path.join(resources, "app.asar"))
  const host = await stat(path.join(resources, "daw-audio-host-macos"))
  const actual = { asarBytes: asar.size, asarMtime: localTimestamp(asar.mtime), nativeHostBytes: host.size }
  if (actual.asarBytes !== expectedAsarBytes || actual.asarMtime !== expectedAsarMtime || actual.nativeHostBytes !== expectedHostBytes) {
    throw new Error(`Packaged build identity mismatch: ${JSON.stringify(actual)}`)
  }
  return actual
}

const launchCell = async (cell: Omit<Cell, "result" | "pass" | "metrics" | "evidence">, output: string): Promise<Cell> => {
  const cellLabel = `${cell.device}-${cell.durationSeconds}s-${cell.mode === "native live" ? "live" : "export"}`
  runContext = {
    cell: cellLabel,
    directory: output,
    deadline: Math.min(Date.now() + (cell.durationSeconds === 8 ? 4 : 8) * 60_000, globalDeadline),
  }
  const cellDeadline = runContext.deadline
  const cellDirectory = path.join(output, runId, `${cell.device}-${cell.durationSeconds}s-${cell.mode === "native live" ? "live" : "export"}`)
  await mkdir(cellDirectory, { recursive: true, mode: 0o700 })
  const evidence: string[] = []
  const metrics: Cell["metrics"] = {}
  let cdp: Cdp | undefined
  let app: ReturnType<typeof spawn> | undefined
  let appClosed: Promise<void> | undefined
  let profilePath: string | undefined
  let attached = false
  let cellError: string | undefined
  let devicePreparationError: string | undefined
  let captureFile: string | undefined
  let completedCell: Cell | undefined
  try {
    const profileRoot = await createPrivateRunDirectory("/tmp")
    const profile = path.join(profileRoot, "profile")
    profilePath = profile
    await mkdir(profile, { mode: 0o700 })
    app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_AE08_EVIDENCE_DIR: cellDirectory },
    })
    if (!app.pid) throw new Error("Packaged app did not start")
    appClosed = new Promise<void>((resolve) => app?.once("close", () => resolve()))
    runContext.appExit = new Promise<never>((_resolve, reject) => {
      app?.once("exit", (code, signal) => {
        const reason = code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
        runContext!.appExitInfo = reason
        reject(new Error(`Packaged app exited before the cell completed (${reason})`))
      })
    })
    void runContext.appExit.catch(() => undefined)
    const endpointDeadline = Date.now() + 60_000
    let owned: { endpoint: string; targetId: string } | undefined
    await log(`${cellLabel}: start app pid=${app.pid}`)
    while (!owned && Date.now() < Math.min(endpointDeadline, cellDeadline, globalDeadline)) {
      try {
        const endpoint = (await withTimeout(ownedV3CdpEndpoint(profile, app.pid, executable), remaining(10_000), "verify owned CDP endpoint")).endpoint
        const targetBody = await fetchJsonWithTimeout(
          endpoint.replace("ws://", "http://").replace(/\/devtools\/browser\/.*$/, "/json/list"),
          remaining(10_000),
          "CDP target list fetch",
        )
        const targets = z.array(z.object({ id: z.string(), type: z.string(), url: z.string() }).passthrough()).parse(targetBody)
        const targetId = targets.find((item) => item.type === "page" && item.url.startsWith("daw://app/"))?.id
        if (targetId) owned = { endpoint, targetId }
      } catch (error) {
        await log(`${cellLabel}: CDP discovery retry: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!owned) await Bun.sleep(250)
    }
    if (!owned) throw new Error("Packaged renderer/CDP endpoint did not become ready")
    cdp = await cdpConnect(owned.endpoint, owned.targetId)
    attached = true
    await waitFor(async () => (await evaluate(cdp!, `Boolean([...document.querySelectorAll('button')].some(button=>button.textContent?.trim()==='New project'))`)) === true,
      60_000, "project dashboard")
    await evaluate(cdp, `([...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='New project'))?.click()`)
    await waitFor(async () => (await evaluate(cdp!, `Boolean(document.querySelector('[data-timeline-ruler="1"]')&&new URL(location.href).searchParams.get('projectId'))`)) === true,
      60_000, "new project")
    const projectId = new URL(String(await evaluate(cdp, "location.href"))).searchParams.get("projectId")
    if (!projectId) throw new Error("New project id missing")

    const capabilities = controlCapabilitiesSchemaV2.parse(await command(profile, ["capabilities-v2", "--target", "host"]))
    const required = ["track.create", "track.mix.set", "instrument.set", "clip.midi.create"]
    const missing = required.filter((kind) => !capabilities.actionKinds.includes(kind))
    if (missing.length) throw new Error(`Project control does not advertise: ${missing.join(", ")}`)

    const fixturePath = path.join(fixturesDirectory, cell.source)
    const expectedHash = expectedFixtures.get(cell.source)
    if (!expectedHash || await sha256(fixturePath) !== expectedHash) throw new Error(`Fixture hash mismatch: ${cell.source}`)
    const fixture = sources.find((source) => source.file === cell.source)
    if (!fixture) throw new Error(`Unknown fixture: ${cell.source}`)
    await command(profile, ["host", "import", "--path", fixturePath])
    const snapshot = async () => projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
    await waitFor(async () => (await snapshot()).assets.some((asset) => asset.name === cell.source), 60_000, "fixture import")
    const imported = (await snapshot()).assets.find((asset) => asset.name === cell.source)
    if (!imported) throw new Error("Imported sample missing in canonical project snapshot")
    metrics.fixtureSha256 = expectedHash
    metrics.fixtureFrames = fixture.frames
    const { durationSec, sampleRate, channelCount } = imported
    if (durationSec === undefined || sampleRate === undefined || channelCount === undefined) {
      throw new Error("Imported sample is missing canonical audio metadata in the project snapshot")
    }
    metrics.fixtureSampleRate = sampleRate
    metrics.fixtureChannels = channelCount

    const trackRef = `paging-${randomUUID()}`
    const notes = cell.device === "granular"
      ? [
        { id: "paging-note-begin", beat: 1, length: 0.25, pitch: 60, velocity: 0.9 },
        { id: "paging-note-middle", beat: fixture.seconds, length: 0.25, pitch: 60, velocity: 0.9 },
        { id: "paging-note-end", beat: Math.max(0, fixture.seconds * 2 - 1), length: 0.25, pitch: 60, velocity: 0.9 },
      ]
      : [{ id: "paging-note-one-shot", beat: 0, length: Math.max(1, fixture.seconds * 2), pitch: cell.device === "drum-rack" ? 36 : 60, velocity: 0.9 }]
    const before = await snapshot()
    const audioClipTrackIds = new Set(before.clips.filter((clip) => !clip.midi).map((clip) => clip.trackId))
    const audioTracks = before.tracks.filter((track) => track.kind === "audio" && audioClipTrackIds.has(track.id))
    if (audioTracks.length === 0) throw new Error("Imported audio clip track missing from canonical project snapshot")
    const actions: Json[] = [
      ...audioTracks.map((track) => ({
        kind: "track.mix.set",
        track: { source: "persisted", id: track.id },
        muted: true,
      })),
      { kind: "track.create", clientRef: trackRef, name: `Paging ${cell.device}`, trackKind: "instrument" },
      {
        kind: "instrument.set",
        target: { kind: "track", track: { source: "client", clientRef: trackRef } },
        instrumentKind: cell.device,
        params: instrumentParams(cell.device, {
          id: imported.id,
          name: imported.name,
          durationSec,
          sampleRate,
          channelCount,
        }),
      },
      {
        kind: "clip.midi.create",
        clientRef: `paging-midi-${randomUUID()}`,
        track: { source: "client", clientRef: trackRef },
        name: `Paging ${cell.device} MIDI`,
        startSec: 0,
        duration: fixture.seconds,
        wave: "sine",
        notes,
      },
    ]
    const request = { version: "v1", projectId, expectedRevision: before.project.revision, actions }
    const preview = controlPreviewResultSchemaV1.parse(await command(profile, ["preview", "--request", "-", "--target", "host"], request))
    const approval = preview.approval?.required
      ? controlApprovalResultSchemaV1.parse(await command(profile, ["approval", "--request", "-", "--target", "host"], request)).approvalToken
      : undefined
    const commitRequest = { ...request, idempotencyKey: `paging-${randomUUID()}` }
    const commit = controlCommitResultSchemaV1.parse(await command(
      profile,
      ["commit", "--request", "-", "--target", "host"],
      approval ? { ...commitRequest, approvalToken: approval } : commitRequest,
    ))
    if (!commit) throw new Error("Project control commit returned no result")
    const fresh = await snapshot()
    const track = fresh.tracks.find((candidate) => candidate.name === `Paging ${cell.device}`)
    const retainedAudioClips = fresh.clips.filter((clip) => !clip.midi)
    if (!track || !fresh.clips.some((clip) => clip.midi) || retainedAudioClips.length === 0
      || retainedAudioClips.some((clip) => !fresh.tracks.find((item) => item.id === clip.trackId)?.muted)
      || !fresh.assets.some((asset) => asset.id === imported.id)) {
      throw new Error("Fresh snapshot did not prove the sample asset and muted audio clip remain installed alongside the instrument MIDI clip")
    }
    await writeFile(path.join(cellDirectory, "project-snapshot.json"), JSON.stringify(fresh, null, 2), { mode: 0o600 })
    evidence.push(path.relative(output, path.join(cellDirectory, "project-snapshot.json")))

    await log(`${cellLabel}: reload renderer from canonical committed snapshot`)
    await evaluate(cdp, "location.reload()")
    await waitFor(async () => (await evaluate(cdp!, `Boolean(document.querySelector('[data-timeline-ruler="1"]')&&new URL(location.href).searchParams.get('projectId'))`)) === true,
      60_000, "renderer project reload")
    const selectedTrack = await evaluate(cdp, `(()=>{const selectors=[...document.querySelectorAll('[data-track-name]')];const row=selectors.find(element=>element.textContent?.includes(${JSON.stringify(`Paging ${cell.device}`)}));row?.click();return Boolean(row)})()`)
    await log(`${cellLabel}: selected instrument track=${String(selectedTrack)}`)
    await command(profile, ["host", "seek", "0"])
    await command(profile, ["host", "play"])
    await waitFor(async () => (await evaluate(cdp!, instrumentStatus(cell.device, cell.source))) === true,
      readyTimeoutMs, `${cell.device} native ready pane status`)
    await waitFor(async () => {
      const transport = z.object({ state: z.string(), playheadSec: z.number() }).passthrough()
        .parse(await command(profile, ["host", "transport-status"]))
      return transport.state === "playing" || transport.playheadSec > 0
    }, 30_000, "live transport start")
    const paneFailure = String(await evaluate(cdp,
      `(()=>{const text=document.body.innerText;const status=[...document.querySelectorAll('button')].map(button=>button.textContent?.trim()).find(value=>value==='error');const alert=[...document.querySelectorAll('[role="alert"]')].map(element=>element.textContent?.trim()).find(Boolean);const failure=text.match(/Native playback failed during[^\\n]*/)?.[0];const missing=text.includes('No devices on this track');return status||failure||missing?JSON.stringify({status,error:alert??failure??(missing?'Canonical instrument is absent from the loaded device pane':undefined)}):''})()`))
    if (paneFailure) {
      devicePreparationError = `Native device pane reports preparation failure: ${paneFailure}`
      await log(`${cellLabel}: ${devicePreparationError}`)
    }
    const paneShot = path.join(cellDirectory, "device-pane.png")
    await screenshot(cdp, paneShot)
    evidence.push(path.relative(output, paneShot))
    if (devicePreparationError && cell.mode === "native live") throw new Error(devicePreparationError)

    if (cell.mode === "native live") {
      const timeout = (fixture.seconds + 45) * 1000
      await waitFor(async () => {
        const transport = z.object({ state: z.string(), playheadSec: z.number() }).passthrough().parse(await command(profile, ["host", "transport-status"]))
        return transport.playheadSec >= fixture.seconds || transport.state !== "playing"
      }, timeout, "full-length live MIDI playback")
      const finalTransport = z.object({ state: z.string(), playheadSec: z.number() }).passthrough()
        .parse(await command(profile, ["host", "transport-status"]))
      if (finalTransport.state !== "playing" || finalTransport.playheadSec < fixture.seconds) {
        metrics.liveTransportState = finalTransport.state
        metrics.liveTransportPlayheadSec = finalTransport.playheadSec
        if (!devicePreparationError) throw new Error(`Live MIDI playback ended early at ${finalTransport.playheadSec}s`)
      }
      const diagnostics = await command(profile, ["host", "diagnostics-v2"])
      const diagnosticsPath = path.join(cellDirectory, "host-diagnostics.json")
      await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2), { mode: 0o600 })
      evidence.push(path.relative(output, diagnosticsPath))
      metrics.nativeRejections = Number(z.object({
        data: z.object({ native: z.object({ diagnostics: z.object({ lastRejectedInstrumentEventCount: z.number() }).passthrough() }).passthrough() }).passthrough(),
      }).parse({ data: diagnostics }).data.native.diagnostics.lastRejectedInstrumentEventCount)
      if (metrics.nativeRejections !== 0) throw new Error("Native host rejected instrument events")
      await command(profile, ["host", "stop"])
    } else {
      await command(profile, ["host", "stop"])
      const outputFile = path.join(cellDirectory, "mixdown.wav")
      const request = {
        mode: "mixdown",
        format: "wav",
        destination: { kind: "file", path: outputFile },
        range: { mode: "custom", startSec: 0, endSec: fixture.seconds },
        render: { sampleRate: 48000, channels: 2, normalization: { mode: "none" }, tail: { mode: "none" } },
        encoding: { wav: { codec: "pcm-f32", dither: "none" } },
      }
      const job = eventSchema.parse(await command(profile, ["host", "export", "--request", "-"], request))
      await writeFile(path.join(cellDirectory, "export-request.json"), JSON.stringify(request, null, 2), { mode: 0o600 })
      const jobId = z.string().safeParse(job.jobId).success ? z.string().parse(job.jobId) : undefined
      if (jobId) {
        const exportStatus = async () => exportStatusSchema.parse(await command(profile, ["host", "export-status"]))
        await waitFor(async () => {
          const status = await exportStatus()
          return status.job?.id === jobId && ["completed", "failed", "canceled"].includes(String(status.status))
        }, 600_000, "native export terminal status")
        const status = await exportStatus()
        if (status.status !== "completed" || status.job?.id !== jobId) throw new Error(`Native export did not complete: ${JSON.stringify(status)}`)
      }
      const fileStat = await stat(outputFile)
      if (fileStat.size <= 44) throw new Error("Native export output is absent or empty")
      const pcm = await readWav(outputFile)
      const markerFrame = cell.device === "granular" ? pcm.sampleRate / 2 : fixture.markerFrame
      const marker = analyzeMarker(pcm.samples, pcm.channels, pcm.sampleRate, markerFrame, Math.round(pcm.sampleRate * 0.12))
      const exportFrames = pcm.samples.length / pcm.channels
      const finite = pcm.samples.every(Number.isFinite)
      const nonzero = pcm.samples.some((sample) => sample !== 0)
      const rms = Math.sqrt(pcm.samples.reduce((square, sample) => square + sample * sample, 0) / Math.max(1, pcm.samples.length))
      metrics.exportFrames = exportFrames
      metrics.exportFinite = finite
      metrics.exportNonzero = nonzero
      metrics.exportRms = rms
      metrics.exportLateMarkerLeft = marker.leftMarkerAmplitude
      metrics.exportLateMarkerRight = marker.rightMarkerAmplitude
      metrics.exportLateMarkerDistinctStereo = Math.abs(marker.leftMarkerAmplitude - marker.rightMarkerAmplitude) > 0.0001
      if (pcm.sampleRate !== 48_000 || pcm.channels !== 2 || exportFrames !== fixture.frames
        || !finite || !nonzero || rms <= 1e-7
        || marker.leftMarkerAmplitude <= 0.005 || marker.rightMarkerAmplitude <= 0.005
        || metrics.exportLateMarkerDistinctStereo !== true) {
        throw new Error(`Export PCM failed frame/format/content/late-marker assertions: ${JSON.stringify(metrics)}`)
      }
      evidence.push(path.relative(output, outputFile))
      evidence.push(path.relative(output, path.join(cellDirectory, "export-request.json")))
      metrics.exportBytes = fileStat.size
      metrics.exportSha256 = await sha256(outputFile)
    }
    if (devicePreparationError) throw new Error(devicePreparationError)
    captureFile = (await readdir(cellDirectory)).find((name) => /^output-\d+-\d+\.wav$/.test(name))
    if (cell.mode === "native live" && !captureFile) {
      // The child writes its post-master WAV when the owned host exits.
      metrics.liveCaptureDeferredUntilNormalQuit = true
    }
    completedCell = { ...cell, result: "PASS", pass: true, metrics, evidence }
    return completedCell
  } catch (error) {
    cellError = error instanceof Error ? error.message : String(error)
    await log(`${cellLabel}: FAIL at step: ${cellError}`)
    if (profilePath && app?.exitCode === null) {
      try {
        const diagnostics = await command(profilePath, ["host", "diagnostics-v2"])
        await writeFile(path.join(cellDirectory, "host-diagnostics-on-failure.json"), JSON.stringify(diagnostics, null, 2), { mode: 0o600 })
        evidence.push(path.relative(output, path.join(cellDirectory, "host-diagnostics-on-failure.json")))
      } catch (diagnosticError) {
        await log(`${cellLabel}: diagnostic capture failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`)
      }
    }
  } finally {
    if (cellError && cdp) {
      const failureShot = path.join(cellDirectory, "failure.png")
      await screenshot(cdp, failureShot).then(() => evidence.push(path.relative(output, failureShot))).catch(() => undefined)
      const failureText = String(await evaluate(cdp, "document.body.innerText").catch(() => "Renderer text unavailable"))
      await writeFile(path.join(cellDirectory, "failure-ui.txt"), failureText, { mode: 0o600 })
      evidence.push(path.relative(output, path.join(cellDirectory, "failure-ui.txt")))
      const statusDetails = await evaluate(cdp,
        `JSON.stringify({url:location.href,buttons:[...document.querySelectorAll('button')].map(button=>button.textContent?.trim()).filter(Boolean),tracks:[...document.querySelectorAll('[data-track-name]')].map(element=>element.getAttribute('data-track-name'))})`)
        .catch(() => "DOM status unavailable")
      await writeFile(path.join(cellDirectory, "failure-dom.json"), String(statusDetails), { mode: 0o600 })
      evidence.push(path.relative(output, path.join(cellDirectory, "failure-dom.json")))
    }
    if (cdp && attached) {
      try {
        await cdp.call("Runtime.evaluate", { expression: "window.close()", returnByValue: true })
      } catch (error) {
        if (!cellError) cellError = `Cleanup window.close failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    cdp?.close()
    if (app) {
      const exitedNormally = app.exitCode !== null || app.signalCode !== null
      if (!exitedNormally) {
        await Promise.race([appClosed, Bun.sleep(10_000)])
      }
      if (app.exitCode === null && app.signalCode === null && app.pid) {
        app.kill("SIGTERM")
        await Promise.race([appClosed, Bun.sleep(3_000)])
      }
    }
    const nativeLogs = (await readdir(cellDirectory)).filter((name) => /^native-\d+\.jsonl$/.test(name))
    if (nativeLogs.length) {
      const joined = nativeLogs.map((name) => readFile(path.join(cellDirectory, name), "utf8"))
      await writeFile(path.join(cellDirectory, "native-events.jsonl"), (await Promise.all(joined)).join(""), { mode: 0o600 })
      evidence.push(path.relative(output, path.join(cellDirectory, "native-events.jsonl")))
    }
    const completedCaptures = (await readFile(path.join(cellDirectory, "native-events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => eventSchema.parse(JSON.parse(line)))
      .filter((event) => event.event === "capture-complete")
      .toSorted((left, right) => Number(right.frames) - Number(left.frames))
    const selectedCapture = completedCaptures[0]
    const selectedCaptureName = selectedCapture
      ? `output-${Number(selectedCapture.pid)}-${Number(selectedCapture.captureId)}.wav`
      : undefined
    const tap = (await readdir(cellDirectory)).find((name) => name === selectedCaptureName)
    if (tap && cell.mode === "native live") {
      const tapPath = path.join(cellDirectory, tap)
      evidence.push(path.relative(output, tapPath))
      let lateMarker: { left: number; right: number } | undefined
      try {
        const pcm = await readWav(tapPath)
        const finiteSamples = pcm.samples.every(Number.isFinite)
        const nonzeroSamples = pcm.samples.some((sample) => sample !== 0)
        const rms = Math.sqrt(pcm.samples.reduce((square, sample) => square + sample * sample, 0) / Math.max(1, pcm.samples.length))
        metrics.liveCaptureFrames = pcm.samples.length / pcm.channels
        metrics.liveCaptureFinite = finiteSamples
        metrics.liveCaptureNonzero = nonzeroSamples
        metrics.liveCaptureRms = rms
        const lateWindow = Math.round(pcm.sampleRate * 0.12)
        const blocksPath = path.join(cellDirectory, "native-events.jsonl")
        const events = (await readFile(blocksPath, "utf8")).split("\n").filter(Boolean)
          .map((line) => eventSchema.parse(JSON.parse(line)))
        // Only the selected capture's blocks map transport frames to offsets in its WAV.
        const blocks = events.filter((event) => event.event === "capture-block"
          && event.pid === selectedCapture?.pid && event.captureId === selectedCapture?.captureId)
        const markerTarget = cell.device === "granular"
          ? pcm.sampleRate / 2
          : sources.find((source) => source.file === cell.source)?.markerFrame ?? 0
        const targetBlock = blocks.find((event) => {
          const transportFrame = Number(event.transportFrame)
          return transportFrame <= markerTarget && transportFrame + Number(event.frames) > markerTarget
        })
        if (targetBlock) {
          const outputStart = Number(targetBlock.offset) + Math.max(0, markerTarget - Number(targetBlock.transportFrame))
          const probeFrames = Math.min(lateWindow, pcm.samples.length / pcm.channels - outputStart)
          const probe = analyzeMarker(pcm.samples, pcm.channels, pcm.sampleRate, outputStart, probeFrames)
          lateMarker = { left: probe.leftMarkerAmplitude, right: probe.rightMarkerAmplitude }
          metrics.liveLateMarkerLeft = lateMarker.left
          metrics.liveLateMarkerRight = lateMarker.right
          metrics.liveLateMarkerDistinctStereo = Math.abs(probe.leftMarkerAmplitude - probe.rightMarkerAmplitude) > 0.0001
        } else {
          metrics.liveLateMarkerFoundInTransportTap = false
        }
        const complete = selectedCapture
        if (!complete || complete.failed === true || Number(complete.overflowFrames) !== 0) {
          metrics.liveTapTerminalValid = false
          if (!cellError) cellError = "Native post-master live capture missing a clean capture-complete terminal"
        } else {
          metrics.liveTapTerminalValid = true
        }
        if (!finiteSamples || !nonzeroSamples || rms <= 1e-7 || metrics.liveTapTerminalValid !== true) {
          if (!cellError) cellError = "Live post-master PCM failed finite/nonzero/clean-terminal assertions"
        }
        if (lateMarker === undefined || lateMarker.left <= 0.005 || lateMarker.right <= 0.005
          || metrics.liveLateMarkerDistinctStereo !== true) {
          if (!cellError) cellError = "Live post-master PCM did not contain the expected distinct late marker"
        }
      } catch (error) {
        if (!cellError) cellError = error instanceof Error ? error.message : String(error)
      }
    } else if (cell.mode === "native live" && !cellError) {
      cellError = "Native post-master live capture WAV is missing"
    }
    if (completedCell) {
      completedCell.metrics = metrics
      completedCell.evidence = evidence
      if (cellError) {
        completedCell.result = "FAIL"
        completedCell.pass = false
        completedCell.error = cellError
      }
    }
    await log(`${cellLabel}: cleanup complete${runContext.appExitInfo ? `; app ${runContext.appExitInfo}` : ""}`)
    runContext = undefined
  }
  return completedCell ?? { ...cell, result: "FAIL", pass: false, metrics, evidence, error: cellError ?? "Cell failed without a recorded cause" }
}

const writeReport = async (output: string, build: Awaited<ReturnType<typeof buildIdentity>>, cells: Cell[]) => {
  const failures = cells.filter((cell) => !cell.pass).length
  const table = cells.map((cell) => `| ${cell.device} | ${cell.durationSeconds}s | ${cell.mode} | ${cell.result} |`).join("\n")
  const body = `# Packaged native instrument paging acceptance\n\n` +
    `**Build identity:** app.asar ${build.asarBytes} bytes, mtime ${build.asarMtime}; native host ${build.nativeHostBytes} bytes.\n\n` +
    `**Overall:** ${failures === 0 ? "PASS" : "INCOMPLETE/FAILED"} (${cells.length - failures}/${cells.length} passing cells).\n\n` +
    `| Device | Fixture | Mode | Result |\n|---|---:|---|---|\n${table}\n\n` +
    `Exports used the product's \`host export\` control operation with an explicit destination file, because a native Save-panel automation route was not available to this harness. The WAV exporter remains the packaged product host and renders the native offline graph.\n\n` +
    `## Failure analysis\n\n` +
    `Each cell retains the imported audio clip and mutes its audio track through the control platform, leaving the instrument as the only audible marker source while still exercising the multi-asset project. The nine-hour hang came from unbounded \`daw-control\` child exit and pending CDP work; all CLI subprocesses now have kill-on-timeout, and CDP, fetch, WebSocket, per-cell, and global waits are bounded. Timestamped log: \`${path.basename(runLogPath)}\`.\n\n` +
    `The earlier 0.8-second shutdown was the harness ReferenceError above, not a packaged-app crash, single-instance conflict, wrong CDP target, or missing environment variable. The observed clock_gettime sample alone does not prove a JavaScript tight loop. The harness's polling loops already slept 200/250 ms; the definite hang risks were its unbounded CLI-exit and CDP promises, now hard-bounded. The corrected packaged matrix verifies canonical project state after renderer reload. Any product failure is described per cell with its screenshot, diagnostics, native event log, and source boundary; no production source was changed.\n\n` +
    `Live captures use the existing opt-in post-master native tap. Each cell runs in its own disposable profile and is quit through \`window.close()\`; the tap WAV is finalized by normal host teardown. Screenshots are captured with CDP \`Page.captureScreenshot\`, not OS-window screenshots.\n\n` +
    `## Cell details\n\n${cells.map((cell) => `### ${cell.device}, ${cell.durationSeconds}s, ${cell.mode}: ${cell.result}\n\n` +
      `- ${cell.error ?? "Assertions completed."}\n- Metrics: \`${JSON.stringify(cell.metrics)}\`\n- Evidence: ${cell.evidence.map((item) => `\`${item}\``).join(", ") || "none"}\n`).join("\n")}` +
    `\n## Zero-capture diagnosis\n\nThe prior 180-second sampler capture was a genuine all-zero callback output, but its evidence did not prove the instrument reached native-ready or that MIDI events were admitted. Prior host diagnostics showed \`installedAssets: 2\`, \`lastRejectedInstrumentEventCount: 0\`, \`rejectedBlocks: 0\`, and no instrument admission log in \`native-45990.jsonl\`. Those facts do not prove sample state ACK or notes reached the host. The scripted run records the ready pane, callback tap, host diagnostics, and native event stream independently; where it fails, see the matching cell's evidence before assigning a production root cause.\n`
  await writeFile(path.join(output, "report.md"), body, { mode: 0o600 })
  await writeFile(path.join(output, "results.json"), JSON.stringify({
    runDate: "2026-10-17",
    overall: failures === 0 ? "PASS" : "INCOMPLETE/FAILED",
    build,
    fixtureHashes: Object.fromEntries(expectedFixtures),
    exportPath: "host export control operation with explicit file destination",
    cells,
  }, null, 2), { mode: 0o600 })
}

await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
await mkdir(path.join(reportDirectory, runId), { recursive: true, mode: 0o700 })
const build = await buildIdentity()
await log(`run start; pid=${process.pid}; global deadline=${new Date(globalDeadline).toISOString()}`)
const cells: Cell[] = []
const cellLimit = process.env.DAW_ACCEPTANCE_MAX_CELLS === undefined
  ? Number.POSITIVE_INFINITY
  : z.coerce.number().int().positive().parse(process.env.DAW_ACCEPTANCE_MAX_CELLS)
let launchedCells = 0
for (const device of devices) {
  for (const source of sources) {
    for (const mode of modes) {
      const label = `${device}-${source.seconds}s-${mode === "native live" ? "live" : "export"}`
      if (selectedCells && !selectedCells.includes(label)) continue
      if (launchedCells >= cellLimit || Date.now() >= globalDeadline) break
      const cell = await launchCell({ device, source: source.file, durationSeconds: source.seconds, mode }, reportDirectory)
      cells.push(cell)
      launchedCells += 1
      await writeReport(reportDirectory, build, cells)
      await log(`${cell.result}: ${cell.device} ${cell.durationSeconds}s ${cell.mode}${cell.error ? `: ${cell.error}` : ""}`)
    }
    if (launchedCells >= cellLimit || Date.now() >= globalDeadline) break
  }
  if (launchedCells >= cellLimit || Date.now() >= globalDeadline) break
}
await log(`run complete; ${cells.filter((cell) => cell.pass).length}/${cells.length} passing cells`)
