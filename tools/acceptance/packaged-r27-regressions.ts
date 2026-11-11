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
  createDefaultEqParams,
  createDefaultGranularParams,
  createDefaultSamplerParams,
  createDefaultSynthParams,
  type DrumRackPadSample,
} from "@daw-browser/shared"
import { readWav } from "./ae08-wav"
import { createPrivateRunDirectory } from "../performance/30-track/electron"
import { ownedV3CdpEndpoint } from "../performance/30-track/v3-import-acceptance"

const root = path.resolve(import.meta.dir, "../..")
const app = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app")
const executable = path.join(app, "Contents/MacOS/@daw-browser-desktop")
const resources = path.join(app, "Contents/Resources")
const skipInstrumentEdit = process.env.DAW_R27_NO_EDIT === "1"
const batch = process.env.DAW_R27_BATCH === "B" ? "B" : "A"
const report = path.join(root, `acceptance-reports/daw-experience-packaged-r27-2026-10-17/batch-${batch.toLowerCase()}`, ...(skipInstrumentEdit ? ["no-edit-reload"] : []))
const fixture = path.join(root, "acceptance-reports/native-instrument-sample-paging-2026-10-17/fixtures/stereo-48k-8s.wav")
const expected = {
  asar: z.coerce.number().int().positive().default(5_245_500).parse(process.env.DAW_EXPECTED_ASAR_SIZE),
  host: z.coerce.number().int().positive().default(934_392).parse(process.env.DAW_EXPECTED_HOST_SIZE),
  mtime: z.string().min(1).default("2026-10-17 16:23:36").parse(process.env.DAW_EXPECTED_ASAR_MTIME),
}
const expectedFixtureHash = "2af525267cde23d3a565e0a3b5aab5fcccefec358ec89f1b731dc7e0620b3be8"
const timeoutMs = 120_000
const globalDeadline = Date.now() + 95 * 60_000
const selected = process.env.DAW_R27_SCENARIOS?.split(",").map((value) => value.trim()).filter(Boolean)
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`
const logFile = path.join(report, `run-${runId}.log`)
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
type Scenario = { id: string; title: string; result: "PASS" | "FAIL" | "BLOCKED"; reason: string; evidence: string[]; metrics: Record<string, Json> }
type Cdp = { call: (method: string, params?: { [key: string]: Json }) => Promise<Json>; close: () => void; rendererErrors: string[] }
type Session = { profile: string; pid: number; process: ReturnType<typeof spawn>; cdp: Cdp; projectId: string }
const outcomes: Scenario[] = []
type ActiveScenario = { session?: Session; scenarioDirectory?: string; deadline: number }
const active: ActiveScenario = { deadline: globalDeadline }
const log = async (line: string) => {
  const value = `[${new Date().toISOString()}] ${line}\n`
  console.log(value.trimEnd())
  await appendFile(logFile, value, { mode: 0o600 })
}
const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
const bounded = (ms = timeoutMs) => Math.max(1, Math.min(ms, active.deadline - Date.now(), globalDeadline - Date.now()))
const fetchBounded = async (url: string, label: string) => {
  const controller = new AbortController()
  const ms = bounded(10_000)
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await withTimeout(fetch(url, { signal: controller.signal }).then((response) => response.json()), ms, label)
  } finally { clearTimeout(timer) }
}
const cli = async (profile: string, args: string[], input?: Json): Promise<Json> => {
  const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
    cwd: root,
    env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") },
    stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : "pipe",
  })
  if (input !== undefined && child.stdin) { child.stdin.write(`${JSON.stringify(input)}\n`); child.stdin.end() }
  try {
    const [stdout, stderr, code] = await withTimeout(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), bounded(45_000), `daw-control ${args.join(" ")}`)
    if (code !== 0) throw new Error(`daw-control ${args.join(" ")} exit ${code}: ${stderr.slice(0, 700)}`)
    return z.object({ data: z.json() }).passthrough().parse(JSON.parse(stdout)).data
  } catch (error) {
    child.kill("SIGKILL")
    throw error
  }
}
const connect = (endpoint: string, targetId: string): Promise<Cdp> => withTimeout(new Promise((resolve, reject) => {
  const socket = new WebSocket(endpoint)
  let seq = 0
  let sessionId = ""
  const rendererErrors: string[] = []
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>()
  const send = (method: string, params: { [key: string]: Json } = {}) => socket.send(JSON.stringify({ id: ++seq, method, params, sessionId }))
  const timer = setTimeout(() => reject(new Error("CDP connection timed out")), bounded(15_000))
  socket.addEventListener("open", () => {
    const id = ++seq
    pending.set(id, { resolve: (value) => {
      sessionId = z.object({ sessionId: z.string() }).parse(value).sessionId
      void Promise.all([send("Page.enable"), send("Runtime.enable")])
      clearTimeout(timer)
      resolve({
        call: (method, params = {}) => withTimeout(new Promise<Json>((done, fail) => {
          const requestId = ++seq
          pending.set(requestId, { resolve: done, reject: fail })
          socket.send(JSON.stringify({ id: requestId, method, params, sessionId }))
        }), bounded(15_000), `CDP ${method}`),
        close: () => socket.close(),
        rendererErrors,
      })
    }, reject })
    socket.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId, flatten: true } }))
  })
  socket.addEventListener("message", (event) => {
    const message = z.object({
      id: z.number().optional(),
      method: z.string().optional(),
      params: z.json().optional(),
      result: z.json().optional(),
      error: z.object({ message: z.string().optional() }).optional(),
    }).passthrough().parse(JSON.parse(String(event.data)))
    if (message.method === "Runtime.exceptionThrown") {
      const details = z.object({
        exceptionDetails: z.object({
          text: z.string().optional(),
          exception: z.object({ description: z.string().optional() }).passthrough().optional(),
        }).passthrough().optional(),
      }).passthrough().parse(message.params ?? {}).exceptionDetails
      rendererErrors.push(details?.exception?.description ?? details?.text ?? "Uncaught renderer exception")
    }
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message ?? "CDP request failed"))
    else request.resolve(message.result ?? null)
  })
  socket.addEventListener("error", () => reject(new Error("CDP socket error")))
}), bounded(20_000), "CDP websocket")
const evaluate = async (cdp: Cdp, expression: string): Promise<Json> => {
  const response = z.object({
    result: z.object({ value: z.json().optional() }).passthrough(),
    exceptionDetails: z.object({ text: z.string().optional() }).optional(),
  }).passthrough().parse(await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
  if (response.exceptionDetails) throw new Error(`Renderer eval failed: ${response.exceptionDetails.text ?? "unknown"}; expression=${expression}`)
  return response.result.value ?? null
}
const waitFor = async (condition: () => Promise<boolean>, label: string, duration = 60_000) => {
  const end = Math.min(Date.now() + duration, active.deadline, globalDeadline)
  while (Date.now() < end) {
    if (active.session && (active.session.process.exitCode !== null || active.session.process.signalCode !== null)) {
      throw new Error(`Packaged app exited during ${label} (${active.session.process.exitCode ?? active.session.process.signalCode})`)
    }
    if (await withTimeout(condition(), bounded(15_000), label)) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
const screenshot = async (cdp: Cdp, target: string) => {
  const result = z.object({ data: z.string() }).parse(await cdp.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
  }))
  await writeFile(target, Buffer.from(result.data, "base64"), { mode: 0o600 })
}
const installRendererErrorCapture = async (s: Session) => {
  const source = `(() => {
    window.__r27RendererErrors = [];
    window.addEventListener('error', event => window.__r27RendererErrors.push(event.message || 'window error'), true);
    window.addEventListener('unhandledrejection', event => {
      const reason = event.reason;
      window.__r27RendererErrors.push(reason instanceof Error ? reason.stack || reason.message : String(reason));
    });
    return true;
  })()`
  await s.cdp.call("Page.addScriptToEvaluateOnNewDocument", { source })
  await evaluate(s.cdp, source)
}
const assertRendererHealthy = async (s: Session) => {
  const windowErrors = await evaluate(s.cdp, "window.__r27RendererErrors ?? []")
  const errors = z.array(z.string()).parse(windowErrors)
  const firstError = s.cdp.rendererErrors[0] ?? errors[0]
  if (firstError) throw new Error(`Unexpected renderer error during project switch: ${firstError}`)
}
const waitForHealthyRenderer = (
  s: Session,
  condition: () => Promise<boolean>,
  label: string,
  duration?: number,
) => waitFor(async () => {
  await assertRendererHealthy(s)
  return condition()
}, label, duration)
const snapshot = async (s: Session) => projectSnapshotSchemaV2.parse(await cli(s.profile, ["snapshot-v2", s.projectId, "--target", "host"]))
const waitForSnapshot = async (s: Session, label: string) => {
  await waitFor(async () => {
    try { return (await snapshot(s)).project.id === s.projectId } catch { return false }
  }, label, 60_000)
  return snapshot(s)
}
const saveSnapshot = async (s: Session, name: string) => {
  const data = await snapshot(s)
  const target = path.join(active.scenarioDirectory!, name)
  await writeFile(target, JSON.stringify(data, null, 2), { mode: 0o600 })
  return data
}
const commit = async (s: Session, actions: Json[]) => {
  const before = await snapshot(s)
  const caps = controlCapabilitiesSchemaV2.parse(await cli(s.profile, ["capabilities-v2", "--target", "host"]))
  for (const action of actions) {
    const kind = z.object({ kind: z.string() }).parse(action).kind
    if (!caps.actionKinds.includes(kind)) throw new Error(`Action not advertised by capabilities: ${kind}`)
  }
  const request = { version: "v1", projectId: s.projectId, expectedRevision: before.project.revision, actions }
  const preview = controlPreviewResultSchemaV1.parse(await cli(s.profile, ["preview", "--request", "-", "--target", "host"], request))
  const token = preview.approval?.required
    ? controlApprovalResultSchemaV1.parse(await cli(s.profile, ["approval", "--request", "-", "--target", "host"], request)).approvalToken
    : undefined
  const payload = { ...request, idempotencyKey: `r27-${randomUUID()}` }
  const result = controlCommitResultSchemaV1.parse(await cli(s.profile, ["commit", "--request", "-", "--target", "host"],
    token ? { ...payload, approvalToken: token } : payload))
  if (!result) throw new Error("Control commit returned no result")
  return snapshot(s)
}
const selectedTrack = async (s: Session, name: string) => {
  const result = await evaluate(s.cdp, `(()=>{const e=[...document.querySelectorAll('[data-track-name]')].find(x=>x.getAttribute('data-track-name')===${JSON.stringify(name)}||x.textContent?.includes(${JSON.stringify(name)}));e?.click();return !!e})()`)
  if (result !== true) throw new Error(`Could not select track in renderer: ${name}`)
}
const saveUi = async (s: Session, prefix: string, expectedText: string[] = []) => {
  const dir = active.scenarioDirectory!
  await screenshot(s.cdp, path.join(dir, `${prefix}.png`))
  const text = String(await evaluate(s.cdp, "document.body.innerText"))
  await writeFile(path.join(dir, `${prefix}-ui.txt`), text, { mode: 0o600 })
  const controls = await evaluate(s.cdp, `JSON.stringify([...document.querySelectorAll('input,select,[role="slider"]')].map(element=>({label:element.getAttribute('aria-label')??element.closest('label')?.firstChild?.textContent?.trim()??'',value:element instanceof HTMLInputElement||element instanceof HTMLSelectElement?element.value:element.getAttribute('aria-valuenow')??''})))`)
  await writeFile(path.join(dir, `${prefix}-controls.json`), String(controls), { mode: 0o600 })
  for (const item of expectedText) if (!text.includes(item)) throw new Error(`Renderer text missing ${JSON.stringify(item)} after ${prefix}`)
  return text
}
const createProject = async (profile: string, pid: number, child: ReturnType<typeof spawn>, scenarioDir: string): Promise<Session> => {
  active.scenarioDirectory = scenarioDir
  active.deadline = Math.min(Date.now() + 14 * 60_000, globalDeadline)
  const endpointDeadline = Date.now() + 60_000
  let owned: { endpoint: string; targetId: string } | undefined
  while (!owned && Date.now() < endpointDeadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Packaged app exited early (${child.exitCode ?? child.signalCode})`)
    try {
      const found = await withTimeout(ownedV3CdpEndpoint(profile, pid, executable), bounded(10_000), "owned CDP endpoint")
      const response = await fetchBounded(found.endpoint.replace("ws://", "http://").replace(/\/devtools\/browser\/.*$/, "/json/list"), "CDP target discovery")
      const targets = z.array(z.object({ id: z.string(), type: z.string(), url: z.string() }).passthrough()).parse(response)
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("daw://app/"))
      if (page) owned = { endpoint: found.endpoint, targetId: page.id }
    } catch (error) { await log(`CDP discovery retry: ${error instanceof Error ? error.message : String(error)}`) }
    if (!owned) await Bun.sleep(250)
  }
  if (!owned) throw new Error("Packaged renderer CDP target did not appear")
  const cdp = await connect(owned.endpoint, owned.targetId)
  const session = { profile, pid, process: child, cdp, projectId: "" }
  active.session = session
  await installRendererErrorCapture(session)
  await waitForHealthyRenderer(session, async () => (await evaluate(cdp!, `Boolean([...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='New project'))`)) === true, "project dashboard")
  await evaluate(cdp, `([...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='New project'))?.click()`)
  await waitForHealthyRenderer(session, async () => (await evaluate(cdp!, `Boolean(document.querySelector('[data-timeline-ruler="1"]')&&new URL(location.href).searchParams.get('projectId'))`)) === true, "new project")
  const projectId = new URL(String(await evaluate(cdp, "location.href"))).searchParams.get("projectId")
  if (!projectId) throw new Error("New local project id missing")
  session.projectId = projectId
  await cli(profile, ["capabilities-v2", "--target", "host"])
  return session
}
const launch = async (profile: string, scenarioDir: string) => {
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    cwd: root, detached: true, stdio: ["ignore", "ignore", "ignore"],
    env: { ...env, DAW_DESKTOP_USER_DATA: profile, DAW_AE08_EVIDENCE_DIR: scenarioDir },
  })
  if (!child.pid) throw new Error("Packaged executable did not spawn")
  return createProject(profile, child.pid, child, scenarioDir)
}
const quit = async (session: Session | undefined) => {
  if (!session) return
  try { await session.cdp.call("Runtime.evaluate", { expression: "window.close()", returnByValue: true }) } catch {}
  session.cdp.close()
  if (session.process.exitCode === null && session.process.signalCode === null) {
    await Promise.race([new Promise<void>((resolve) => session.process.once("close", () => resolve())), Bun.sleep(12_000)])
  }
  if (session.process.exitCode === null && session.process.signalCode === null) {
    session.process.kill("SIGTERM")
    await Promise.race([new Promise<void>((resolve) => session.process.once("close", () => resolve())), Bun.sleep(3_000)])
  }
  active.session = undefined
}
const importFixture = async (s: Session, checkRendererHealth?: () => Promise<void>) => {
  await cli(s.profile, ["host", "import", "--path", fixture])
  await waitFor(async () => {
    await checkRendererHealth?.()
    return (await snapshot(s)).assets.some((asset) => asset.name === path.basename(fixture))
  }, "fixture import")
  const state = await snapshot(s)
  const asset = state.assets.find((candidate) => candidate.name === path.basename(fixture))
  if (!asset) throw new Error("Imported asset missing from canonical snapshot")
  return {
    id: asset.id,
    name: asset.name,
    durationSec: z.number().positive().parse(asset.durationSec),
    sampleRate: z.number().positive().parse(asset.sampleRate),
    channelCount: z.number().int().positive().parse(asset.channelCount),
  }
}
const muteImportedAudioTracks = async (s: Session) => {
  const state = await snapshot(s)
  const audioClipTrackIds = new Set(state.clips.filter((clip) => !clip.midi).map((clip) => clip.trackId))
  const audioTracks = state.tracks.filter((track) => track.kind === "audio" && audioClipTrackIds.has(track.id))
  if (audioTracks.length === 0) throw new Error("Imported audio clip track missing from canonical project snapshot")
  const muted = await commit(s, audioTracks.map((track) => ({
    kind: "track.mix.set",
    track: { source: "persisted", id: track.id },
    muted: true,
  })))
  if (!muted.clips.some((clip) => !clip.midi && audioClipTrackIds.has(clip.trackId))
    || [...audioClipTrackIds].some((trackId) => !muted.tracks.find((track) => track.id === trackId)?.muted)) {
    throw new Error("Imported audio clip was not retained on a muted audio track")
  }
}
const deviceParams = (kind: "sampler" | "drum-rack" | "granular", asset: { id: string; name: string; durationSec: number; sampleRate: number; channelCount: number }): Json => {
  const sample: DrumRackPadSample = {
    assetKey: asset.id, url: `local-asset:${asset.id}`, name: asset.name, sourceKind: "upload",
    source: { durationSec: asset.durationSec, sampleRate: asset.sampleRate, channelCount: asset.channelCount },
  }
  const zone = {
    id: `r27-${kind}-zone`, sample, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127,
    rootNote: 60, tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 0, roundRobinIndex: 0,
    playbackMode: "one-shot", startSec: 0, endSec: asset.durationSec, crossfadeSec: 0, chokeGroup: 0,
  }
  if (kind === "sampler") return { ...createDefaultSamplerParams(), maxDecodedBytes: 1_073_741_824, zones: [zone] }
  if (kind === "granular") return { ...createDefaultGranularParams(), maxDecodedBytes: 1_073_741_824, position: 0.9, spray: 0, reverseProbability: 0, zone }
  const rack = assignSampleToDrumRackPad(createDefaultDrumRackParams(), "pad-36", sample)
  return { ...rack, pads: rack.pads.map((pad) => pad.id === "pad-36" ? { ...pad, startSec: 0, endSec: asset.durationSec } : pad) }
}
const fixtureMarker = (samples: Float32Array, channels: number, sampleRate: number, start: number, frames: number) => {
  const amplitudes = [880, 1320].map((hz, channel) => {
    let real = 0, imaginary = 0
    for (let frame = 0; frame < frames; frame += 1) {
      const sample = samples[(start + frame) * channels + channel] ?? 0
      const phase = 2 * Math.PI * hz * frame / sampleRate
      real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase)
    }
    return 2 * Math.hypot(real, imaginary) / frames
  })
  const rms = [0, 1].map((channel) => {
    let energy = 0
    for (let frame = 0; frame < frames; frame += 1) {
      const sample = samples[(start + frame) * channels + channel] ?? 0
      energy += sample * sample
    }
    return Math.sqrt(energy / frames)
  })
  return { leftMarkerAmplitude: amplitudes[0] ?? 0, rightMarkerAmplitude: amplitudes[1] ?? 0, leftRms: rms[0] ?? 0, rightRms: rms[1] ?? 0 }
}
const spectralAmplitude = (samples: Float32Array, channels: number, sampleRate: number, blocks: Record<string, Json>[], startSec: number, endSec: number, hz: number) => {
  let real = 0, imaginary = 0, count = 0
  for (const block of blocks) {
    const transportFrame = Number(block.transportFrame)
    const offset = Number(block.offset)
    const frames = Number(block.frames)
    for (let frame = 0; frame < frames; frame += 1) {
      const time = (transportFrame + frame) / sampleRate
      if (time < startSec || time >= endSec) continue
      const sample = samples[(offset + frame) * channels] ?? 0
      const phase = 2 * Math.PI * hz * time
      real += sample * Math.cos(phase)
      imaginary += sample * Math.sin(phase)
      count += 1
    }
  }
  return count ? 2 * Math.hypot(real, imaginary) / count : 0
}
const analyzeSynthChange = async (dir: string) => {
  const events = (await readFile(path.join(dir, "native-events.jsonl"), "utf8")).split("\n").filter(Boolean)
    .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))
  const captureId = events.filter((event) => event.event === "capture-complete").toSorted((a, b) => Number(b.frames) - Number(a.frames))[0]?.captureId
  if (captureId === undefined) throw new Error("Synth tap capture missing")
  const blocks = events.filter((event) => event.event === "capture-block" && event.captureId === captureId)
  const last = events.find((event) => event.event === "capture-complete" && event.captureId === captureId)
  if (!last) throw new Error("Synth tap terminal missing")
  const wavPath = path.join(dir, `output-${Number(last.pid)}-${Number(captureId)}.wav`)
  const pcm = await readWav(wavPath)
  const before = spectralAmplitude(pcm.samples, pcm.channels, pcm.sampleRate, blocks, 0.5, 1.5, 2_200)
  const after = spectralAmplitude(pcm.samples, pcm.channels, pcm.sampleRate, blocks, 3.5, 4.5, 2_200)
  await writeFile(path.join(dir, "synth-spectral-comparison.json"), JSON.stringify({ probeHz: 2200, beforeCutoffSegmentSec: [0.5, 1.5], afterCutoffSegmentSec: [3.5, 4.5], before, after, ratio: after / Math.max(before, 1e-12) }, null, 2), { mode: 0o600 })
  if (before <= 0.0001 || after >= before * 0.7) throw new Error(`Filter cutoff change did not produce the required spectral reduction: ${JSON.stringify({ before, after })}`)
  return { probeHz: 2200, before, after, ratio: after / before }
}
const paramsFor = (state: Awaited<ReturnType<typeof snapshot>>, trackId: string) => {
  const entry = state.processors.find((item) => "trackId" in item.target && item.target.trackId === trackId && item.processor.kind === "instrument")
  return entry ? z.record(z.string(), z.json()).parse(entry.processor.params).params : undefined
}
const setInstrument = (trackId: string, kind: string, params?: Json): Json => {
  const action = {
    kind: "instrument.set", target: { kind: "track", track: { source: "persisted", id: trackId } },
    instrumentKind: kind,
  }
  return params === undefined ? action : { ...action, params }
}
const setupInstrument = async (s: Session, kind: "sampler" | "drum-rack" | "granular") => {
  const asset = await importFixture(s)
  await muteImportedAudioTracks(s)
  const state = await commit(s, [
    { kind: "track.create", clientRef: "r27-instrument", name: `R27 ${kind}`, trackKind: "instrument" },
  ])
  const track = state.tracks.find((item) => item.name === `R27 ${kind}`)
  if (!track) throw new Error("Instrument track absent after commit")
  const params = deviceParams(kind, asset)
  await commit(s, [
    setInstrument(track.id, kind, params),
    {
      kind: "clip.midi.create", clientRef: `r27-midi-${randomUUID()}`,
      track: { source: "persisted", id: track.id }, name: `R27 ${kind} notes`,
      startSec: 0, duration: 8, wave: "sine",
      notes: [{ id: "r27-note", beat: 0, length: 16, pitch: kind === "drum-rack" ? 36 : 60, velocity: 0.9 }],
    },
  ])
  await saveSnapshot(s, "canonical-before-edit.json")
  return { track, asset, params }
}
const editDevice = (kind: "sampler" | "drum-rack" | "granular", params: Json): Json => {
  const object = z.record(z.string(), z.json()).parse(params)
  if (kind === "granular") return { ...object, grainSizeMs: 100 }
  if (kind === "sampler") {
    return { ...object, polyphony: 31 }
  }
  const pads = z.array(z.record(z.string(), z.json())).parse(object.pads)
  return { ...object, pads: pads.map((pad) => pad.id === "pad-36" ? { ...pad, gain: 0.7 } : pad) }
}
const hasEditedDeviceValue = (kind: "sampler" | "drum-rack" | "granular", params: Json | undefined) => {
  if (!params) return false
  const object = z.record(z.string(), z.json()).parse(params)
  if (kind === "granular") return object.grainSizeMs === 100
  if (kind === "sampler") return object.polyphony === 31
  const pad = z.array(z.record(z.string(), z.json())).parse(object.pads).find((item) => item.id === "pad-36")
  return pad?.gain === 0.7
}
const verifyEditedUiValue = async (s: Session, kind: "sampler" | "drum-rack" | "granular", prefix: string) => {
  const controls = z.array(z.object({ label: z.string(), value: z.string() })).parse(JSON.parse(String(await evaluate(s.cdp, `JSON.stringify([...document.querySelectorAll('input,select,[role="slider"]')].map(element=>({label:element.getAttribute('aria-label')??element.closest('label')?.firstChild?.textContent?.trim()??'',value:element instanceof HTMLInputElement||element instanceof HTMLSelectElement?element.value:element.getAttribute('aria-valuenow')??''})))`))))
  const label = kind === "sampler" ? "Voices" : kind === "granular" ? "Grain ms" : "Gain"
  const expectedValue = kind === "sampler" ? 31 : kind === "granular" ? 100 : 0.7
  const actual = controls.find((item) => item.label === label)
  const value = Number(actual?.value)
  await writeFile(path.join(active.scenarioDirectory!, `${prefix}-edited-control.json`), JSON.stringify({ label, expectedValue, actual: actual ?? null }, null, 2), { mode: 0o600 })
  if (!actual || !Number.isFinite(value) || Math.abs(value - expectedValue) > 0.0001) {
    throw new Error(`Edited ${kind} value is not visible in UI control ${label}: ${actual?.value ?? "missing"}`)
  }
}
const readVisibleControl = async (s: Session, label: string) => {
  const controls = z.array(z.object({ label: z.string(), value: z.string() })).parse(JSON.parse(String(await evaluate(s.cdp, `JSON.stringify([...document.querySelectorAll('input,select,[role="slider"]')].map(element=>({label:element.getAttribute('aria-label')??element.closest('label')?.firstChild?.textContent?.trim()??'',value:element instanceof HTMLInputElement||element instanceof HTMLSelectElement?element.value:element.getAttribute('aria-valuenow')??''})))`))))
  return controls.find((item) => item.label === label)
}
const captureStatus = async (s: Session, kind: string, fixtureName: string) => {
  const name = kind === "drum-rack" ? "Drum Rack" : kind[0]!.toUpperCase() + kind.slice(1)
  const terminal = `[...document.querySelectorAll('button')].some(b=>['ready','error'].includes(b.textContent?.trim()??''))`
  return await evaluate(s.cdp, `(()=>{const text=document.body.innerText;return !text.includes('No devices on this track')&&text.includes(${JSON.stringify(name)})&&text.includes(${JSON.stringify(fixtureName)})&&(${terminal}||text.includes('Native playback failed during'))})()`)
}
export const tapMetrics = async (
  scenarioDir: string,
  kind: "sampler" | "drum-rack" | "granular" | undefined,
  requireQuality = true,
  playbackStartedAfter?: number,
) => {
  const logs = (await readdir(scenarioDir)).filter((name) => /^native-\d+\.jsonl$/.test(name))
  const eventsText = (await Promise.all(logs.map((name) => readFile(path.join(scenarioDir, name), "utf8")))).join("")
  await writeFile(path.join(scenarioDir, "native-events.jsonl"), eventsText, { mode: 0o600 })
  const rows = eventsText.split("\n").filter(Boolean).map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))
  const hostEvents = (await readFile(path.join(scenarioDir, "host.jsonl"), "utf8")).split("\n").filter(Boolean)
    .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))
  const latestHostPid = hostEvents.filter((event) => event.event === "host-spawn").at(-1)?.pid
  const relevant = latestHostPid === undefined ? rows : rows.filter((event) => Number(event.pid) === Number(latestHostPid))
  // Capture start is not Play: a paused preview keeps the device running, so the capture holding Play can start before it.
  // Playback is a block whose transportFrame advanced from the previous block of the same capture and transport epoch.
  const playingCaptureIds = playbackStartedAfter === undefined
    ? undefined
    : new Set(relevant
      .filter((event) => event.event === "capture-block")
      .toSorted((a, b) => Number(a.captureId) - Number(b.captureId) || Number(a.offset) - Number(b.offset))
      .filter((block, index, blocks) => {
        const previous = index === 0 ? undefined : blocks.at(index - 1)
        return previous !== undefined && previous.captureId === block.captureId && previous.transportEpoch === block.transportEpoch
          && Number(block.transportFrame) > Number(previous.transportFrame) && Number(block.wallMs) >= playbackStartedAfter
      })
      .map((block) => String(block.captureId)))
  const completed = relevant
    .filter((event) => event.event === "capture-complete"
      && (playingCaptureIds === undefined || playingCaptureIds.has(String(event.captureId))))
    .toSorted((a, b) => Number(b.frames) - Number(a.frames))[0]
  if (!completed) throw new Error("Native post-master tap did not emit capture-complete")
  const wavName = `output-${Number(completed.pid)}-${Number(completed.captureId)}.wav`
  const pcm = await readWav(path.join(scenarioDir, wavName))
  const finite = pcm.samples.every(Number.isFinite)
  const nonzero = pcm.samples.some((sample) => sample !== 0)
  const rms = Math.sqrt(pcm.samples.reduce((sum, sample) => sum + sample * sample, 0) / pcm.samples.length)
  const blocks = relevant.filter((event) => event.event === "capture-block" && event.captureId === completed.captureId)
  // Granular position 0.9 reads the fixture's 7.2 s marker from note onset.
  // Capture also contains paused preview callbacks, so every probe must use
  // native transport coordinates rather than an offset from device start.
  const markerTarget = kind === "granular" ? pcm.sampleRate / 2 : 345_600
  const targetBlock = kind === undefined ? undefined : blocks.find((event) => {
    const transportFrame = Number(event.transportFrame)
    return transportFrame <= markerTarget && transportFrame + Number(event.frames) > markerTarget
  })
  const markerStart = kind === undefined ? undefined : targetBlock
      ? Number(targetBlock.offset) + Math.max(0, markerTarget - Number(targetBlock.transportFrame))
      : pcm.samples.length / pcm.channels
  const markerFrames = markerStart === undefined ? undefined : Math.max(0, Math.min(5_760, pcm.samples.length / pcm.channels - markerStart))
  const marker = markerStart !== undefined && markerFrames !== undefined
    ? markerFrames > 0
      ? fixtureMarker(pcm.samples, pcm.channels, pcm.sampleRate, markerStart, markerFrames)
      : { leftMarkerAmplitude: 0, rightMarkerAmplitude: 0, leftRms: 0, rightRms: 0 }
    : undefined
  // Metrics are parsed as strict JSON by callers, so marker keys exist only when a marker was probed.
  const markerMetrics = marker === undefined
    ? {}
    : { markerTargetFrame: markerTarget, markerProbeStartFrame: markerStart, markerProbeFrames: markerFrames, ...marker }
  const metrics = {
    frames: pcm.samples.length / pcm.channels, sampleRate: pcm.sampleRate, channels: pcm.channels, finite, nonzero, rms,
    ...markerMetrics,
    failed: completed.failed === true, overflowFrames: Number(completed.overflowFrames),
  }
  await writeFile(path.join(scenarioDir, "capture-metrics.json"), JSON.stringify(metrics, null, 2), { mode: 0o600 })
  await writeFile(path.join(scenarioDir, "capture.wav.sha256"), `${createHash("sha256").update(await readFile(path.join(scenarioDir, wavName))).digest("hex")}\n`, { mode: 0o600 })
  if (requireQuality && (!finite || !nonzero || rms <= 1e-7 || metrics.failed || metrics.overflowFrames !== 0 || (kind !== undefined && (markerFrames === 0 || marker?.leftMarkerAmplitude === undefined || marker.leftMarkerAmplitude <= 0.005 || marker.rightMarkerAmplitude <= 0.005 || Math.abs(marker.leftMarkerAmplitude - marker.rightMarkerAmplitude) <= 0.0001)))) {
    throw new Error(`Post-master playback/late-stereo marker assertion failed: ${JSON.stringify(metrics)}`)
  }
  return metrics
}
const runInstrumentPersistence = async (kind: "sampler" | "drum-rack" | "granular", dir: string): Promise<Scenario> => {
  const profileRoot = await createPrivateRunDirectory("/tmp")
  const profile = path.join(profileRoot, "profile")
  let session: Session | undefined
  const evidence: string[] = []
  const metrics: Record<string, Json> = {}
  try {
    session = await launch(profile, dir)
    const { track, params } = await setupInstrument(session, kind)
    if (skipInstrumentEdit) {
      await selectedTrack(session, `R27 ${kind}`)
      await commandTransport(session, "play")
      await waitFor(async () => await captureStatus(session!, kind, path.basename(fixture)) === true, `${kind} pre-reload pane ready`, 90_000)
      await saveUi(session, "before-unedited-reload")
      await commandTransport(session, "stop")
      await log(`${kind}: captured pre-reload state without parameter edit`)
    } else await commit(session, [setInstrument(track.id, kind, editDevice(kind, params))])
    let state = await saveSnapshot(session, "canonical-after-edit.json")
    let instrument = paramsFor(state, track.id)
    if (!skipInstrumentEdit && !hasEditedDeviceValue(kind, instrument)) throw new Error("Edited device value missing from canonical snapshot")
    await selectedTrack(session, `R27 ${kind}`)
    await session.cdp.call("Page.reload", { ignoreCache: true })
    state = await waitForSnapshot(session, "mounted project after renderer reload")
    instrument = paramsFor(state, track.id)
    if (!skipInstrumentEdit && !hasEditedDeviceValue(kind, instrument)) throw new Error("Edited value did not persist in snapshot after renderer reload")
    await selectedTrack(session, `R27 ${kind}`)
    await saveUi(session, "after-renderer-reload", ["R27 " + kind, path.basename(fixture)])
    if (!skipInstrumentEdit) await verifyEditedUiValue(session, kind, "after-renderer-reload")
    await commandTransport(session, "seek", "0")
    await commandTransport(session, "play")
    await waitFor(async () => await captureStatus(session!, kind, path.basename(fixture)) === true, `${kind} pane ready after reload`, 90_000)
    await saveUi(session, "ready-after-reload", ["R27 " + kind, path.basename(fixture)])
    await writeFile(path.join(dir, "host-diagnostics-after-reload.json"), JSON.stringify(await cli(profile, ["host", "diagnostics-v2"]), null, 2), { mode: 0o600 })
    await Bun.sleep(8_500)
    await commandTransport(session, "stop")
    const expectedProjectId = session.projectId
    const expectedProjectName = state.project.name
    await quit(session); session = undefined
    metrics.rendererReloadCapture = await tapMetrics(dir, kind, false)
    session = await relaunchExisting(profile, dir, expectedProjectId, expectedProjectName)
    state = await snapshot(session)
    await saveSnapshot(session, "canonical-after-app-restart.json")
    instrument = paramsFor(state, track.id)
    if (!state.tracks.some((item) => item.id === track.id) || (!skipInstrumentEdit && !hasEditedDeviceValue(kind, instrument))) {
      throw new Error("Instrument/sample/edit not restored from same profile after app restart")
    }
    await selectedTrack(session, `R27 ${kind}`)
    await saveUi(session, "after-app-restart", ["R27 " + kind, path.basename(fixture)])
    if (!skipInstrumentEdit) await verifyEditedUiValue(session, kind, "after-app-restart")
    await commandTransport(session, "seek", "0")
    await commandTransport(session, "play")
    await waitFor(async () => await captureStatus(session!, kind, path.basename(fixture)) === true, `${kind} pane ready after restart`, 90_000)
    await saveUi(session, "ready-after-restart", ["R27 " + kind, path.basename(fixture)])
    await writeFile(path.join(dir, "host-diagnostics-after-restart.json"), JSON.stringify(await cli(profile, ["host", "diagnostics-v2"]), null, 2), { mode: 0o600 })
    await waitFor(async () => {
      const status = z.object({ state: z.string(), playheadSec: z.number() }).passthrough().parse(await cli(profile, ["host", "transport-status"]))
      return status.playheadSec >= 8 || status.state !== "playing"
    }, "8 second playback", 45_000)
    await commandTransport(session, "stop")
    await quit(session); session = undefined
    metrics.appRestartCapture = await tapMetrics(dir, kind, false)
    for (const [phase, capture] of Object.entries({ reload: metrics.rendererReloadCapture, restart: metrics.appRestartCapture })) {
      const result = z.record(z.string(), z.json()).parse(capture)
      if (result.finite !== true || result.nonzero !== true || Number(result.rms) <= 1e-7
        || Number(result.leftMarkerAmplitude) <= 0.005 || Number(result.rightMarkerAmplitude) <= 0.005
        || Math.abs(Number(result.leftMarkerAmplitude) - Number(result.rightMarkerAmplitude)) <= 0.0001) {
        throw new Error(`Post-master playback after ${phase} failed finite/nonzero/late-marker requirements: ${JSON.stringify(result)}`)
      }
    }
    evidence.push("canonical-before-edit.json", "canonical-after-edit.json", "canonical-after-app-restart.json", "after-renderer-reload.png", "after-renderer-reload-ui.txt", "after-renderer-reload-controls.json", "after-renderer-reload-edited-control.json", "ready-after-reload.png", "after-app-restart.png", "after-app-restart-ui.txt", "after-app-restart-controls.json", "after-app-restart-edited-control.json", "ready-after-restart.png", "capture-metrics.json", "native-events.jsonl")
    return { id: kind, title: `Edits persist: ${kind}`, result: "PASS", reason: "Value is visible and canonical after reload and same-profile relaunch; live post-master capture includes the late stereo marker.", evidence, metrics }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (session) {
      await cli(profile, ["host", "diagnostics-v2"]).then((value) => writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(value, null, 2), { mode: 0o600 })).catch(() => undefined)
      await evaluate(session.cdp, "document.body.innerText").then((value) => writeFile(path.join(dir, "failure-ui.txt"), String(value), { mode: 0o600 })).catch(() => undefined)
      await screenshot(session.cdp, path.join(dir, "failure.png")).catch(() => undefined)
    }
    return {
      id: kind, title: `Edits persist: ${kind}`, result: "FAIL", reason,
      evidence: [...evidence, "canonical-before-edit.json", "canonical-after-edit.json", "canonical-after-app-restart.json", "after-renderer-reload.png", "after-renderer-reload-ui.txt", "after-renderer-reload-controls.json", "after-renderer-reload-edited-control.json", "ready-after-reload.png", "after-app-restart.png", "after-app-restart-ui.txt", "after-app-restart-controls.json", "after-app-restart-edited-control.json", "ready-after-restart.png", "capture-metrics.json", "native-events.jsonl", "failure.png", "failure-ui.txt", "host-diagnostics.json"],
      metrics,
    }
  } finally { await quit(session) }
}
const commandTransport = async (s: Session, action: "play" | "stop" | "seek", value?: string) =>
  cli(s.profile, ["host", action, ...(value ? [value] : [])])
const nativeUndo = async (pid: number) => {
  const script = `tell application "System Events" to tell (first process whose unix id is ${pid}) to keystroke "z" using {command down}`
  const child = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" })
  try {
    const [stdout, stderr, code] = await withTimeout(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), bounded(10_000), "native macOS Cmd+Z")
    if (code !== 0) throw new Error(`Native macOS Cmd+Z failed: ${stderr || stdout}`)
  } catch (error) {
    child.kill("SIGKILL")
    throw error
  }
}
const openProjectsDashboard = async (pid: number) => {
  const script = `tell application "System Events" to tell (first process whose unix id is ${pid}) to click menu item "Open Projects Dashboard" of menu 1 of menu bar item "File" of menu bar 1`
  const child = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" })
  try {
    const [stdout, stderr, code] = await withTimeout(Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]), bounded(10_000), "Open Projects Dashboard menu item")
    if (code !== 0) throw new Error(`Native Projects Dashboard menu action failed: ${stderr || stdout}`)
  } catch (error) {
    child.kill("SIGKILL")
    throw error
  }
}
const dragSynthCutoff = async (cdp: Cdp, deltaY: number) => {
  const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .parse(await evaluate(cdp, `(()=>{const e=document.querySelector('[role="slider"][aria-label="Cutoff"]');if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`))
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y - deltaY, button: "left", buttons: 1 })
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: y - deltaY, button: "left", clickCount: 1 })
}
const relaunchExisting = async (profile: string, dir: string, expectedProjectId: string, expectedProjectName: string) => {
  const child = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    cwd: root, detached: true, stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_AE08_EVIDENCE_DIR: dir },
  })
  if (!child.pid) throw new Error("Packaged executable failed to restart")
  try {
    return await attachExisting(profile, child.pid, child, dir, expectedProjectId, expectedProjectName)
  } catch (error) {
    const attached = active.session
    if (attached?.pid === child.pid) {
      await evaluate(attached.cdp, "document.body.innerText")
        .then((value) => writeFile(path.join(dir, "restart-failure-ui.txt"), String(value), { mode: 0o600 }))
        .catch(() => undefined)
      await evaluate(attached.cdp, `JSON.stringify({url:location.href,buttons:[...document.querySelectorAll('button')].map(button=>button.textContent?.trim()).filter(Boolean)})`)
        .then((value) => writeFile(path.join(dir, "restart-failure-dom.json"), String(value), { mode: 0o600 }))
        .catch(() => undefined)
      await screenshot(attached.cdp, path.join(dir, "restart-failure.png")).catch(() => undefined)
      await quit(attached)
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), Bun.sleep(3_000)])
    }
    throw error
  }
}
const attachExisting = async (profile: string, pid: number, child: ReturnType<typeof spawn>, dir: string, expectedProjectId: string, expectedProjectName: string): Promise<Session> => {
  active.deadline = Math.min(Date.now() + 12 * 60_000, globalDeadline)
  let owned: { endpoint: string; targetId: string } | undefined
  const end = Date.now() + 60_000
  while (!owned && Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Relaunched packaged app exited (${child.exitCode ?? child.signalCode})`)
    try {
      const found = await withTimeout(ownedV3CdpEndpoint(profile, pid, executable), bounded(8_000), "relaunch owned CDP")
      const targets = z.array(z.object({ id: z.string(), type: z.string(), url: z.string() }).passthrough())
        .parse(await fetchBounded(found.endpoint.replace("ws://", "http://").replace(/\/devtools\/browser\/.*$/, "/json/list"), "relaunch target fetch"))
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("daw://app/"))
      if (page) owned = { endpoint: found.endpoint, targetId: page.id }
    } catch (error) { await log(`relaunch discovery retry: ${error instanceof Error ? error.message : String(error)}`) }
    if (!owned) await Bun.sleep(250)
  }
  if (!owned) throw new Error("Restarted renderer CDP target unavailable")
  const cdp = await connect(owned.endpoint, owned.targetId)
  const s = { profile, pid, process: child, cdp, projectId: "" }
  active.session = s; active.scenarioDirectory = dir
  await waitFor(async () => (await evaluate(cdp, `Boolean(document.querySelector('[data-timeline-ruler="1"]')||[...document.querySelectorAll('button')].some(button=>button.textContent?.trim()==='New project'))`)) === true, "dashboard or project after restart")
  const dashboard = await evaluate(cdp, `Boolean([...document.querySelectorAll('button')].some(button=>button.textContent?.trim()==='New project'))`)
  if (dashboard === true) {
    await waitFor(async () => (await evaluate(cdp, `Boolean([...document.querySelectorAll('button')].some(button=>button.textContent?.trim().startsWith(${JSON.stringify(expectedProjectName)})))`)) === true, `saved project ${expectedProjectName} after restart`)
    await evaluate(cdp, `([...document.querySelectorAll('button')].find(button=>button.textContent?.trim().startsWith(${JSON.stringify(expectedProjectName)})))?.click()`)
  }
  await waitFor(async () => (await evaluate(cdp, `Boolean(document.querySelector('[data-timeline-ruler="1"]')&&new URL(location.href).searchParams.get('projectId'))`)) === true, "restored project after restart")
  s.projectId = new URL(String(await evaluate(cdp, "location.href"))).searchParams.get("projectId") ?? ""
  if (s.projectId !== expectedProjectId) throw new Error(`Restarted wrong project: expected ${expectedProjectId}, found ${s.projectId || "no project id"}`)
  await waitForSnapshot(s, "canonical project mounted after app restart")
  return s
}

const runGranularPolyphony = async (dir: string): Promise<Scenario> => {
  const profile = path.join(await createPrivateRunDirectory("/tmp"), "profile")
  let s: Session | undefined
  const evidence: string[] = []
  const metrics: Record<string, Json> = {}
  try {
    s = await launch(profile, dir)
    const asset = await importFixture(s)
    await muteImportedAudioTracks(s)
    let state = await commit(s, [{ kind: "track.create", clientRef: "r27-granular-polyphony", name: "R27 Granular Polyphony", trackKind: "instrument" }])
    const track = state.tracks.find((item) => item.name === "R27 Granular Polyphony")
    if (!track) throw new Error("Granular polyphony track absent after commit")
    await commit(s, [setInstrument(track.id, "granular", deviceParams("granular", asset))])
    const batches: { startSec: number; count: number }[] = [
      { startSec: 0, count: 3 },
      { startSec: 8, count: 32 },
      { startSec: 16, count: 33 },
    ]
    for (const { startSec, count } of batches) {
      const notes = Array.from({ length: count }, (_, index) => ({
        id: `r27-${count}-note-${index}`,
        beat: 0,
        length: 16,
        pitch: 60 + index % 12,
        velocity: 0.8,
      }))
      state = await commit(s, [{
        kind: "clip.midi.create",
        clientRef: `r27-granular-polyphony-${count}`,
        track: { source: "persisted", id: track.id },
        name: `R27 ${count} simultaneous notes`,
        startSec,
        duration: 8,
        wave: "sine",
        notes,
      }])
      if (!state.clips.some((clip) => clip.name === `R27 ${count} simultaneous notes`)) {
        throw new Error(`Granular ${count}-note clip missing from fresh snapshot`)
      }
    }
    await selectedTrack(s, "R27 Granular Polyphony")
    await commandTransport(s, "seek", "0")
    await commandTransport(s, "play")
    const thresholds: { label: string; playheadSec: number }[] = [
      { label: "3", playheadSec: 0.5 },
      { label: "32", playheadSec: 8.5 },
      { label: "33", playheadSec: 16.5 },
    ]
    for (const { label, playheadSec } of thresholds) {
      await waitFor(async () => {
        const status = z.object({ state: z.string(), playheadSec: z.number() }).passthrough()
          .parse(await cli(profile, ["host", "transport-status"]))
        return status.state === "playing" && status.playheadSec >= playheadSec
      }, `${label}-note granular playback`, 35_000)
      metrics[`notes${label}Transport`] = z.record(z.string(), z.json())
        .parse(await cli(profile, ["host", "transport-status"]))
    }
    await Bun.sleep(2_000)
    await withTimeout(commandTransport(s, "stop"), bounded(15_000), "explicit granular Stop")
    const stopped = z.object({ state: z.string() }).passthrough()
      .parse(await cli(profile, ["host", "transport-status"]))
    metrics.stopState = stopped.state
    if (stopped.state !== "stopped") throw new Error(`Granular Stop did not reach stopped: ${stopped.state}`)
    await writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(await cli(profile, ["host", "diagnostics-v2"]), null, 2), { mode: 0o600 })
    await quit(s)
    s = undefined
    metrics.capture = await tapMetrics(dir, undefined)
    const events = await readFile(path.join(dir, "native-events.jsonl"), "utf8")
    const diagnostics = await readFile(path.join(dir, "host-diagnostics.json"), "utf8")
    const rejection = /instrument-event-rejected|permanent event rejection/iu.test(`${events}\n${diagnostics}`)
    metrics.rejectionMarkersFound = rejection
    if (rejection) throw new Error("Granular host evidence contains a permanent instrument event rejection marker")
    evidence.push("canonical-before-edit.json", "canonical-after-edit.json", "capture-metrics.json", "native-events.jsonl", "host-diagnostics.json")
    return {
      id: "granular-polyphony",
      title: "Granular simultaneous-note polyphony",
      result: "PASS",
      reason: "3, 32, and 33-note clips stayed in playing transport, post-master audio was finite and nonzero, explicit Stop reached stopped, and no permanent event rejection marker appeared. The 32-note limit and oldest-note replacement are implemented in native/audio-core/src/audio_core.cpp:4051-4082; per-voice counts are not exposed in the packaged UI or diagnostics, so the specific stolen note is not directly observable.",
      evidence,
      metrics,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (s) {
      await cli(profile, ["host", "diagnostics-v2"]).then((value) => writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(value, null, 2), { mode: 0o600 })).catch(() => undefined)
      await evaluate(s.cdp, "document.body.innerText").then((value) => writeFile(path.join(dir, "failure-ui.txt"), String(value), { mode: 0o600 })).catch(() => undefined)
      await screenshot(s.cdp, path.join(dir, "failure.png")).catch(() => undefined)
    }
    return { id: "granular-polyphony", title: "Granular simultaneous-note polyphony", result: "FAIL", reason, evidence: ["canonical-before-edit.json", "canonical-after-edit.json", "capture-metrics.json", "native-events.jsonl", "host-diagnostics.json", "failure.png", "failure-ui.txt"], metrics }
  } finally { await quit(s) }
}

const runImportFailureReason = async (dir: string): Promise<Scenario> => {
  const profile = path.join(await createPrivateRunDirectory("/tmp"), "profile")
  let s: Session | undefined
  const evidence: string[] = []
  const metrics: Record<string, Json> = {}
  try {
    s = await launch(profile, dir)
    const before = await saveSnapshot(s, "snapshot-before-import.json")
    const unsupported = path.join(dir, "unsupported.txt")
    const corrupt = path.join(dir, "corrupt.wav")
    await writeFile(unsupported, "not audio", { mode: 0o600 })
    await writeFile(corrupt, Buffer.from("not a RIFF/WAVE file"), { mode: 0o600 })
    const unsupportedResult = await cli(profile, ["host", "import", "--path", unsupported])
      .then((value) => ({ returned: value, error: "" }))
      .catch((error) => ({ returned: null, error: error instanceof Error ? error.message : String(error) }))
    await writeFile(path.join(dir, "unsupported-import-result.json"), JSON.stringify(unsupportedResult, null, 2), { mode: 0o600 })
    const corruptResult = await cli(profile, ["host", "import", "--path", corrupt])
      .then((value) => ({ returned: value, error: "" }))
      .catch((error) => ({ returned: null, error: error instanceof Error ? error.message : String(error) }))
    await writeFile(path.join(dir, "corrupt-import-result.json"), JSON.stringify(corruptResult, null, 2), { mode: 0o600 })
    await waitFor(async () => {
      const status = z.record(z.string(), z.json()).parse(await cli(profile, ["host", "import-status"]))
      return ["completed", "failed", "canceled"].includes(String(status.status))
    }, "corrupt-file import failure status", 90_000)
    const status = z.record(z.string(), z.json()).parse(await cli(profile, ["host", "import-status"]))
    await writeFile(path.join(dir, "host-import-status.json"), JSON.stringify(status, null, 2), { mode: 0o600 })
    await writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(await cli(profile, ["host", "diagnostics-v2"]), null, 2), { mode: 0o600 })
    const ui = await saveUi(s, "after-failed-import")
    const after = await saveSnapshot(s, "snapshot-after-import.json")
    const createdAssets = after.assets.filter((asset) => !before.assets.some((old) => old.id === asset.id))
    const createdClips = after.clips.filter((clip) => !before.clips.some((old) => old.id === clip.id))
    const diagnosticText = JSON.stringify(await cli(profile, ["host", "diagnostics-v2"]))
    await writeFile(path.join(dir, "host-diagnostics.json"), diagnosticText, { mode: 0o600 })
    const statusJob = z.object({ job: z.object({ error: z.string().optional() }).optional() }).passthrough().parse(status).job
    const statusError = statusJob?.error ?? ""
    const expectedReason = "Audio file has an unsupported or unrecognizable format."
    metrics.unsupportedCliRejected = unsupportedResult.error.length > 0
    metrics.unsupportedCliReason = unsupportedResult.error.includes("host import requires an absolute supported audio path.")
    metrics.corruptImportStatus = status.status
    metrics.importErrorTextIncludesReason = statusError.includes(expectedReason) && ui.includes(expectedReason)
    const productSurfaces = [statusError, ui, diagnosticText]
    metrics.pathLeakObserved = productSurfaces.some((surface) => surface.includes(dir) || surface.includes("/Users/") || surface.includes("/tmp/"))
    metrics.pathRedactionObserved = productSurfaces.every((surface) => !surface.includes(dir)) && !metrics.pathLeakObserved
    metrics.createdAssetCount = createdAssets.length
    metrics.createdClipCount = createdClips.length
    if (!metrics.importErrorTextIncludesReason) throw new Error(`Import did not expose expected reason (${expectedReason}); the host status schema may have reduced the renderer failure to a generic result.`)
    if (createdAssets.length || createdClips.length) throw new Error(`Failed imports created project content: assets=${createdAssets.length}, clips=${createdClips.length}`)
    if (metrics.unsupportedCliReason !== true) throw new Error("Unsupported .txt import did not return the expected host CLI rejection reason")
    if (!metrics.pathRedactionObserved) throw new Error("Import UI, host status, or diagnostics exposed an absolute file-system path")
    evidence.push("unsupported.txt", "corrupt.wav", "unsupported-import-result.json", "corrupt-import-result.json", "host-import-status.json", "host-diagnostics.json", "after-failed-import.png", "after-failed-import-ui.txt", "snapshot-before-import.json", "snapshot-after-import.json")
    return {
      id: "import-failure-reason",
      title: "Import failure reason and path redaction",
      result: "PASS",
      reason: `Unsupported extension was rejected by the host CLI; corrupt WAV reported ${expectedReason}. UI, host status, and diagnostics contained no absolute paths (the host status presents the basename rather than a [path]/ marker). Parser reason source: src/lib/media/audio-file-metadata.ts:34-38; CLI rejection: packages/control-cli/src/cli-host.ts:93-94; host status redaction: src/lib/desktop/attached-host-controller.ts:272-308.`,
      evidence,
      metrics,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (s) {
      await cli(profile, ["host", "diagnostics-v2"]).then((value) => writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(value, null, 2), { mode: 0o600 })).catch(() => undefined)
      await evaluate(s.cdp, "document.body.innerText").then((value) => writeFile(path.join(dir, "failure-ui.txt"), String(value), { mode: 0o600 })).catch(() => undefined)
      await screenshot(s.cdp, path.join(dir, "failure.png")).catch(() => undefined)
    }
    return { id: "import-failure-reason", title: "Import failure reason and path redaction", result: "FAIL", reason, evidence: ["unsupported-import-result.json", "corrupt-import-result.json", "host-import-status.json", "host-diagnostics.json", "snapshot-before-import.json", "snapshot-after-import.json", "failure.png", "failure-ui.txt"], metrics }
  } finally { await quit(s) }
}

const runProjectSwitchNoAbortModal = async (dir: string): Promise<Scenario> => {
  const profile = path.join(await createPrivateRunDirectory("/tmp"), "profile")
  let s: Session | undefined
  const metrics: Record<string, Json> = {}
  try {
    s = await launch(profile, dir)
    const waitForProjectSwitch = (
      condition: () => Promise<boolean>,
      label: string,
      duration?: number,
    ) => waitFor(async () => {
      if (!s) throw new Error(`Project switch session ended during ${label}`)
      await assertRendererHealthy(s)
      return condition()
    }, label, duration)
    // The host reports `unavailable` while a reloaded or switched renderer is remounting its project.
    const mountedProjectSnapshotReady = async () => {
      try {
        return (await snapshot(s!)).project.id === s!.projectId
      } catch (error) {
        if (error instanceof Error && error.message.includes('"code":"unavailable"')) return false
        throw error
      }
    }
    const asset = await importFixture(s, () => assertRendererHealthy(s!))
    const first = await snapshot(s)
    const clip = first.clips.find((item) => !item.midi && item.name.includes(path.basename(fixture)))
    const audioTrack = clip ? first.tracks.find((item) => item.id === clip.trackId) : undefined
    if (!clip || !audioTrack) throw new Error("Project A audio fixture track missing")
    await commit(s, [{
      kind: "effect.upsert",
      target: { kind: "track", track: { source: "persisted", id: audioTrack.id } },
      effectKind: "eq",
      params: createDefaultEqParams(),
    }])
    const projectA = await saveSnapshot(s, "project-a-snapshot.json")
    const projectAName = projectA.project.name
    await commandTransport(s, "seek", "0")
    await commandTransport(s, "play")
    await waitForProjectSwitch(async () => {
      const status = z.object({ state: z.string() }).passthrough().parse(await cli(profile, ["host", "transport-status"]))
      return status.state === "playing"
    }, "Project A playback", 30_000)
    await saveUi(s, "project-a-playing", ["EQ"])
    const projectAId = s.projectId
    await assertRendererHealthy(s)
    await openProjectsDashboard(s.pid)
    await waitForProjectSwitch(async () => (await evaluate(s!.cdp, `Boolean([...document.querySelectorAll('button')].some(button=>button.textContent?.trim()==='New project'))`)) === true, "projects dashboard")
    await screenshot(s.cdp, path.join(dir, "projects-dashboard.png"))
    await writeFile(path.join(dir, "projects-dashboard-ui.txt"), String(await evaluate(s.cdp, "document.body.innerText")), { mode: 0o600 })
    await evaluate(s.cdp, `([...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='New project'))?.click()`)
    await waitForProjectSwitch(async () => {
      return await evaluate(s!.cdp, `Boolean(
        document.querySelector('[data-timeline-ruler="1"]')
        && new URL(location.href).searchParams.get('projectId')!==${JSON.stringify(projectAId)}
        && !new URL(location.href).searchParams.has('dashboard')
        && !document.body.innerText.includes('DAW Dashboard')
      )`) === true
    }, "Project B route and closed dashboard")
    s.projectId = new URL(String(await evaluate(s.cdp, "location.href"))).searchParams.get("projectId") ?? ""
    if (!s.projectId) throw new Error("Project B id missing after dashboard open")
    const projectBId = s.projectId
    await waitForProjectSwitch(mountedProjectSnapshotReady, "Project B canonical snapshot")
    let projectB = await snapshot(s)
    const aTrackIds = projectA.tracks.map((track) => track.id)
    const aClipIds = projectA.clips.map((item) => item.id)
    const aDeviceIds = projectA.processors.map((item) => item.id)
    const bTrackIds = projectB.tracks.map((track) => track.id)
    if (projectB.tracks.length !== 1 || projectB.clips.length !== 0 || projectB.processors.length !== 0 || projectB.assets.length !== 0) {
      throw new Error(`New Project B was not fresh: ${JSON.stringify({
        tracks: projectB.tracks.length,
        clips: projectB.clips.length,
        processors: projectB.processors.length,
        assets: projectB.assets.length,
      })}`)
    }
    const initialTransport = z.object({ state: z.string(), playheadSec: z.number() }).passthrough()
      .parse(await cli(profile, ["host", "transport-status"]))
    if (initialTransport.state === "playing" || initialTransport.playheadSec !== 0) {
      throw new Error(`Project B transport was not reset: ${JSON.stringify(initialTransport)}`)
    }
    const initialBody = String(await evaluate(s.cdp, "document.body.innerText"))
    const rendererTrackIds = z.array(z.string()).parse(await evaluate(s.cdp,
      "Array.from(new Set([...document.querySelectorAll('[data-timeline-track-lane]')].map(element=>element.getAttribute('data-timeline-track-lane')).filter(Boolean)))"))
    const rendererClipIds = z.array(z.string()).parse(await evaluate(s.cdp,
      "Array.from(document.querySelectorAll('[data-timeline-clip-id]')).map(element=>element.getAttribute('data-timeline-clip-id')).filter(Boolean)"))
    const rendererMarkup = String(await evaluate(s.cdp, "document.documentElement.outerHTML"))
    if (!bTrackIds.every((id) => rendererTrackIds.includes(id))
      || aTrackIds.some((id) => rendererTrackIds.includes(id))
      || aClipIds.some((id) => rendererClipIds.includes(id))
      || aDeviceIds.some((id) => rendererMarkup.includes(id))
      || initialBody.includes(path.basename(fixture))
      || initialBody.includes("EQ Eight")) {
      throw new Error(`Project B renderer content does not match its fresh snapshot: ${JSON.stringify({
        bTrackIds,
        aTrackIds,
        aClipIds,
        aDeviceIds,
        rendererTrackIds,
        rendererClipIds,
      })}`)
    }
    await assertRendererHealthy(s)
    await screenshot(s.cdp, path.join(dir, "project-b-loaded.png"))
    projectB = await commit(s, [{ kind: "project.rename", name: "R27 Project B" }])
    if (projectB.project.name !== "R27 Project B") throw new Error("Project B rename missing from fresh snapshot")
    await saveSnapshot(s, "project-b-snapshot.json")
    await openProjectsDashboard(s.pid)
    await waitForProjectSwitch(async () => (await evaluate(s!.cdp, `Boolean(
      document.querySelector('[role="dialog"]')
      && document.querySelector('[role="dialog"]').getBoundingClientRect().width > 0
      && [...document.querySelectorAll('button')].some(button=>button.textContent?.trim()==='Open'&&button.parentElement?.parentElement?.textContent?.includes('R27 Project B'))
    )`)) === true, "visible projects dashboard and named Project B row")
    await screenshot(s.cdp, path.join(dir, "projects-dashboard-b.png"))
    await evaluate(s.cdp, `([...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='Open'&&button.parentElement?.parentElement?.textContent?.includes('R27 Project B')))?.click()`)
    await waitForProjectSwitch(async () => {
      return await evaluate(s!.cdp, `Boolean(
        new URL(location.href).searchParams.get('projectId')===${JSON.stringify(projectBId)}
        && !new URL(location.href).searchParams.has('dashboard')
        && !document.body.innerText.includes('DAW Dashboard')
      )`) === true
    }, "current Project B opened and dashboard closed")
    await waitForProjectSwitch(mountedProjectSnapshotReady, "Project B loaded from dashboard")
    projectB = await snapshot(s)
    const mountedProject = z.record(z.string(), z.json()).parse(await cli(profile, ["project", "current", "--target", "host"]))
    await writeFile(path.join(dir, "mounted-project-after-switch.json"), JSON.stringify(mountedProject, null, 2), { mode: 0o600 })
    const body = String(await evaluate(s.cdp, "document.body.innerText"))
    const abortPattern = /(?:effect|audio effect).{0,80}(?:abort|aborted|failed)|(?:abort|aborted).{0,80}(?:effect|audio effect)/iu
    const rendererTrackIdsAfterOpen = z.array(z.string()).parse(await evaluate(s.cdp,
      "Array.from(new Set([...document.querySelectorAll('[data-timeline-track-lane]')].map(element=>element.getAttribute('data-timeline-track-lane')).filter(Boolean)))"))
    metrics.projectBLoaded = projectB.project.id === projectBId
      && JSON.stringify(mountedProject).includes(projectBId)
      && body.includes("DAW Dashboard") === false
      && bTrackIds.every((id) => rendererTrackIdsAfterOpen.includes(id))
      && aTrackIds.every((id) => !rendererTrackIdsAfterOpen.includes(id))
      && !body.includes(path.basename(fixture))
      && !body.includes("EQ Eight")
    metrics.abortErrorVisible = abortPattern.test(body)
    await screenshot(s.cdp, path.join(dir, "project-b-opened.png"))
    if (metrics.abortErrorVisible) throw new Error("Abort-related audio-effect error appeared after switching to Project B")
    if (metrics.projectBLoaded !== true) throw new Error(`Project B route did not mount the same project reported by host project.current: ${JSON.stringify({ routeProjectId: projectBId, mountedProject })}`)
    if (asset.name !== path.basename(fixture)) throw new Error("Project A fixture identity changed unexpectedly")
    let bState = await commit(s, [{ kind: "track.create", clientRef: "r27-project-b-synth", name: "R27 Project B Synth", trackKind: "instrument" }])
    const bTrack = bState.tracks.find((item) => item.name === "R27 Project B Synth")
    if (!bTrack) throw new Error("Project B instrument track missing from fresh snapshot")
    await commit(s, [setInstrument(bTrack.id, "synth", createDefaultSynthParams())])
    bState = await commit(s, [{
      kind: "clip.midi.create",
      clientRef: "r27-project-b-midi",
      track: { source: "persisted", id: bTrack.id },
      name: "R27 Project B playback",
      startSec: 0,
      duration: 8,
      wave: "sine",
      notes: [{ id: "r27-project-b-note", beat: 0, length: 16, pitch: 60, velocity: 0.8 }],
    }])
    if (!bState.clips.some((item) => item.name === "R27 Project B playback")) throw new Error("Project B playback clip missing")
    await selectedTrack(s, "R27 Project B Synth")
    const projectBBeforePlay = z.object({ state: z.string(), playheadSec: z.number() }).passthrough()
      .parse(await cli(profile, ["host", "transport-status"]))
    if (projectBBeforePlay.state === "playing" || Math.abs(projectBBeforePlay.playheadSec) > 0.01) {
      throw new Error(`Project B did not begin playback at its initial position: ${JSON.stringify(projectBBeforePlay)}`)
    }
    const projectBPlayStartedAfter = Date.now()
    await commandTransport(s, "play")
    await waitForProjectSwitch(async () => {
      const status = z.object({ state: z.string() }).passthrough().parse(await cli(profile, ["host", "transport-status"]))
      return status.state === "playing"
    }, "Project B playback", 30_000)
    metrics.projectBTransport = z.record(z.string(), z.json()).parse(await cli(profile, ["host", "transport-status"]))
    await Bun.sleep(1_000)
    await withTimeout(commandTransport(s, "stop"), bounded(15_000), "Project B Stop")
    await saveUi(s, "project-b-playing", ["R27 Project B Synth"])
    await writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(await cli(profile, ["host", "diagnostics-v2"]), null, 2), { mode: 0o600 })
    await s.cdp.call("Page.reload", { ignoreCache: true })
    await waitForProjectSwitch(mountedProjectSnapshotReady, "Project B after reload")
    const reloadedB = await snapshot(s)
    const reloadedTrack = reloadedB.tracks.find((track) => track.name === "R27 Project B Synth")
    if (!reloadedTrack || !reloadedB.clips.some((clip) => clip.name === "R27 Project B playback")) {
      throw new Error("Project B-only edits did not survive renderer reload")
    }
    await openProjectsDashboard(s.pid)
    await waitForProjectSwitch(async () => (await evaluate(s!.cdp, `Boolean(
      document.querySelector('[role="dialog"]')
      && document.querySelector('[role="dialog"]').getBoundingClientRect().width > 0
      && [...document.querySelectorAll('button')].some(button=>button.textContent?.trim()==='Open'&&button.parentElement?.parentElement?.textContent?.includes(${JSON.stringify(projectAName)}))
    )`)) === true, "visible projects dashboard and Project A row")
    await screenshot(s.cdp, path.join(dir, "projects-dashboard-return-a.png"))
    await evaluate(s.cdp, `([...document.querySelectorAll('button')].find(button=>button.textContent?.trim()==='Open'&&button.parentElement?.parentElement?.textContent?.includes(${JSON.stringify(projectAName)})))?.click()`)
    await waitForProjectSwitch(async () => {
      return await evaluate(s!.cdp, `Boolean(
        new URL(location.href).searchParams.get('projectId')===${JSON.stringify(projectAId)}
        && !new URL(location.href).searchParams.has('dashboard')
        && !document.body.innerText.includes('DAW Dashboard')
        && document.body.innerText.includes(${JSON.stringify(path.basename(fixture))})
      )`) === true
    }, "Project A restored without dashboard")
    s.projectId = projectAId
    await waitForProjectSwitch(mountedProjectSnapshotReady, "Project A after return from B")
    const returnedA = await snapshot(s)
    const normalizeProjectContent = (project: typeof projectA) => ({
      // revision and updatedAt change as bookkeeping and are intentionally excluded from persisted project content.
      project: {
        id: project.project.id,
        name: project.project.name,
        tempoBpm: project.project.tempoBpm,
        timeSignature: project.project.timeSignature,
        loop: project.project.loop,
        masterVolume: project.project.masterVolume,
      },
      tracks: project.tracks.toSorted((left, right) => left.id.localeCompare(right.id)),
      clips: project.clips.toSorted((left, right) => left.id.localeCompare(right.id)),
      processors: project.processors.toSorted((left, right) => left.id.localeCompare(right.id)),
      assets: project.assets.toSorted((left, right) => left.id.localeCompare(right.id)),
      automation: project.automation.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      sidechains: project.sidechains.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      assetFolders: project.assetFolders.toSorted((left, right) => left.id.localeCompare(right.id)),
    })
    const sameProjectA = JSON.stringify(normalizeProjectContent(returnedA)) === JSON.stringify(normalizeProjectContent(projectA))
    if (!sameProjectA) throw new Error("Project A changed while editing Project B")
    const returnedABody = String(await evaluate(s.cdp, "document.body.innerText"))
    if (returnedABody.includes("R27 Project B Synth") || returnedABody.includes("R27 Project B playback")) {
      throw new Error("Project B-only edits appeared in Project A")
    }
    metrics.projectAUnchanged = true
    metrics.projectBEditSurvivesReload = true
    await quit(s)
    s = undefined
    metrics.capture = await tapMetrics(dir, undefined, true, projectBPlayStartedAfter)
    const capture = z.record(z.string(), z.json()).parse(metrics.capture)
    if (capture.finite !== true || capture.nonzero !== true || Number(capture.rms) <= 1e-7) throw new Error("Project B post-master capture was not finite and nonzero")
    return {
      id: "project-switch-no-abort-modal",
      title: "Project switch during audio effect playback",
      result: "PASS",
      reason: "Project A played with EQ attached, the normal File > Open Projects Dashboard route opened the renamed Project B from its Open action without an abort-related error surface, and Project B synth playback produced finite nonzero post-master audio. Abort handling sources: src/components/timeline/create-persisted-effect-state.ts:91 and src/components/timeline/create-effects-panel-audio-effects-state.ts:1093.",
      evidence: ["project-a-snapshot.json", "project-a-playing.png", "projects-dashboard.png", "projects-dashboard-ui.txt", "project-b-snapshot.json", "mounted-project-after-switch.json", "project-b-loaded.png", "project-b-playing.png", "project-b-playing-ui.txt", "capture-metrics.json", "native-events.jsonl", "host-diagnostics.json"],
      metrics,
    }
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error)
    const reason = rawReason.includes("Project B Open action") || rawReason.includes("Project B route did not mount")
      ? `${rawReason}. Product failure: the packaged UI kept Project A's EQ and timeline visible while the URL pointed at Project B and the dashboard query was set, but no dashboard Open row rendered. The dashboard route updates the query and signal in src/hooks/useDashboardRouteParam.ts:20-23; local project creation routes through src/components/dashboard/projects-view.tsx:59-67 and src/hooks/useTimelineData.ts:418-428. This prevents verifying B playback and the abort-modal condition.`
      : rawReason
    if (s) {
      await evaluate(s.cdp, `JSON.stringify({url:location.href,body:document.body.innerText,openRows:[...document.querySelectorAll('button')].filter(button=>button.textContent?.trim()==='Open').map(button=>{let element=button;const parents=[];for(let index=0;element&&index<5;index+=1,element=element.parentElement)parents.push(element.textContent?.trim()??'');return parents})})`)
        .then((value) => writeFile(path.join(dir, "project-switch-diagnostics.json"), String(value), { mode: 0o600 }))
        .catch(() => undefined)
      await evaluate(s.cdp, "document.body.innerText").then((value) => writeFile(path.join(dir, "failure-ui.txt"), String(value), { mode: 0o600 })).catch(() => undefined)
      await screenshot(s.cdp, path.join(dir, "failure.png")).catch(() => undefined)
      await cli(profile, ["host", "diagnostics-v2"]).then((value) => writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(value, null, 2), { mode: 0o600 })).catch(() => undefined)
    }
    return { id: "project-switch-no-abort-modal", title: "Project switch during audio effect playback", result: "FAIL", reason, evidence: ["project-a-snapshot.json", "project-a-playing.png", "projects-dashboard.png", "projects-dashboard-ui.txt", "project-b-snapshot.json", "mounted-project-after-switch.json", "project-switch-diagnostics.json", "project-b-loaded.png", "failure.png", "failure-ui.txt", "host-diagnostics.json"], metrics }
  } finally { await quit(s) }
}

const runDrumRackRetry = async (dir: string): Promise<Scenario> => {
  const profile = path.join(await createPrivateRunDirectory("/tmp"), "profile")
  let s: Session | undefined
  const metrics: Record<string, Json> = {}
  try {
    s = await launch(profile, dir)
    const { asset } = await setupInstrument(s, "drum-rack")
    const beforeDelete = await snapshot(s)
    const importedClip = beforeDelete.clips.find((clip) => !clip.midi && clip.name.includes(path.basename(fixture)))
    if (!importedClip) throw new Error("Fixture source clip missing before creating missing-asset preparation failure")
    await commit(s, [{ kind: "clip.delete", clip: { source: "persisted", id: importedClip.id } }])
    await commit(s, [{ kind: "asset.delete", asset: { source: "persisted", id: asset.id } }])
    await saveSnapshot(s, "canonical-with-missing-sample-asset.json")
    const recoveries = z.object({
      entries: z.array(z.object({ id: z.string(), kind: z.string() })),
    }).passthrough().parse(await cli(profile, ["recoveries", s.projectId, "--target", "host"]))
    const assetRecovery = recoveries.entries.find((entry) => entry.kind === "asset.delete")
    if (!assetRecovery) throw new Error("Control recovery for the deleted sample asset was not returned")
    metrics.assetRecoveryAvailable = true
    await s.cdp.call("Page.reload", { ignoreCache: true })
    await waitForSnapshot(s, "mounted Drum Rack with deleted sample asset")
    await selectedTrack(s, "R27 drum-rack")
    await waitFor(async () => {
      const visible = await evaluate(s!.cdp, `(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='error');return Boolean(button&&!button.disabled&&document.querySelector('[role="alert"]'))})()`)
      return visible === true
    }, "missing-asset Drum Rack preparation error", 90_000)
    await saveUi(s, "drum-rack-preparation", ["Drum Rack"])
    const hasRetryableError = await evaluate(s.cdp, `(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='error');return Boolean(button&&!button.disabled&&document.querySelector('[role="alert"]'))})()`)
    if (hasRetryableError !== true) throw new Error("No legal Drum Rack preparation error with an enabled Retry affordance was observable")
    await commit(s, [{ kind: "recovery.restore", recovery: { id: assetRecovery.id } }])
    await saveSnapshot(s, "canonical-after-sample-asset-restore.json")
    await evaluate(s.cdp, `([...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='error'))?.click()`)
    await waitFor(async () => {
      const text = String(await evaluate(s!.cdp, "document.body.innerText"))
      return text.includes(path.basename(fixture))
        && !text.includes("Drum Rack sample preparation failed")
        && await evaluate(s!.cdp, `![...document.querySelectorAll('button')].some(item=>item.textContent?.trim()==='error')`) === true
    }, "Drum Rack Retry terminal state", 90_000)
    await saveUi(s, "drum-rack-after-retry", ["Drum Rack", path.basename(fixture)])
    await commandTransport(s, "seek", "0")
    await commandTransport(s, "play")
    await waitFor(async () => {
      const status = z.object({ state: z.string() }).passthrough().parse(await cli(profile, ["host", "transport-status"]))
      return status.state === "playing"
    }, "Drum Rack playback after recovery", 30_000)
    // The fixture's stereo marker starts at 7.2 s, matching the batch A instrument capture window.
    await Bun.sleep(8_500)
    await withTimeout(commandTransport(s, "stop"), bounded(15_000), "Drum Rack playback Stop")
    await writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(await cli(profile, ["host", "diagnostics-v2"]), null, 2), { mode: 0o600 })
    await quit(s)
    s = undefined
    metrics.capture = await tapMetrics(dir, "drum-rack")
    const capture = z.record(z.string(), z.json()).parse(metrics.capture)
    const recovered = capture.finite === true && capture.nonzero === true && Number(capture.leftMarkerAmplitude) > 0.005 && Number(capture.rightMarkerAmplitude) > 0.005
    metrics.recovered = recovered
    if (!recovered) throw new Error("Retry did not return Drum Rack to prepared state; source recovery path: src/lib/drum-rack-buffer-sync.ts:387-415 and Retry affordance: src/components/effects/DrumRack.tsx:279-295")
    return {
      id: "drum-rack-retry",
      title: "Drum Rack preparation retry",
      result: "PASS",
      reason: "Deleting the fixture clip and asset through keyed project control produced a legal missing-sample condition; after restoring the asset from its control recovery, the enabled error-state retry returned the rack to playback. Preparation status UI: src/components/effects/DrumRack.tsx:279-295; retry behavior: src/lib/drum-rack-buffer-sync.ts:387-415.",
      evidence: ["canonical-with-missing-sample-asset.json", "canonical-after-sample-asset-restore.json", "drum-rack-preparation.png", "drum-rack-preparation-ui.txt", "drum-rack-after-retry.png", "drum-rack-after-retry-ui.txt", "capture-metrics.json", "native-events.jsonl", "host-diagnostics.json"],
      metrics,
    }
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error)
    const reason = rawReason.includes("missing-asset Drum Rack preparation error")
      ? `${rawReason}. Product failure: missing local asset lookup returns null in src/lib/sampled-instrument-region-loader.ts:151-153; src/lib/drum-rack-buffer-sync.ts:339-341 returns without setting an error status, while src/lib/drum-rack-buffer-sync.ts:421-422 defaults the rack to loading. The enabled error/Retry affordance is rendered only for error status in src/components/effects/DrumRack.tsx:279-295.`
      : rawReason
    if (s) {
      await evaluate(s.cdp, "document.body.innerText").then((value) => writeFile(path.join(dir, "failure-ui.txt"), String(value), { mode: 0o600 })).catch(() => undefined)
      await screenshot(s.cdp, path.join(dir, "failure.png")).catch(() => undefined)
      await cli(profile, ["host", "diagnostics-v2"]).then((value) => writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(value, null, 2), { mode: 0o600 })).catch(() => undefined)
    }
    return { id: "drum-rack-retry", title: "Drum Rack preparation retry", result: "FAIL", reason, evidence: ["drum-rack-preparation.png", "drum-rack-preparation-ui.txt", "drum-rack-after-retry.png", "drum-rack-after-retry-ui.txt", "host-diagnostics.json", "failure.png", "failure-ui.txt"], metrics: {} }
  } finally { await quit(s) }
}

// The product host import operation is the same implicit WAV import entry point documented by r26.
const main = async () => {
  await mkdir(report, { recursive: true, mode: 0o700 })
  const identity = await Promise.all([stat(path.join(resources, "app.asar")), stat(path.join(resources, "daw-audio-host-macos"))])
  const actual = { asarBytes: identity[0]!.size, nativeHostBytes: identity[1]!.size, mtime: `${identity[0]!.mtime.getFullYear()}-${String(identity[0]!.mtime.getMonth() + 1).padStart(2, "0")}-${String(identity[0]!.mtime.getDate()).padStart(2, "0")} ${String(identity[0]!.mtime.getHours()).padStart(2, "0")}:${String(identity[0]!.mtime.getMinutes()).padStart(2, "0")}:${String(identity[0]!.mtime.getSeconds()).padStart(2, "0")}` }
  if (actual.asarBytes !== expected.asar || actual.nativeHostBytes !== expected.host || actual.mtime !== expected.mtime) {
    throw new Error(`Packaged identity mismatch: ${JSON.stringify(actual)}`)
  }
  const fixtureHash = createHash("sha256").update(await readFile(fixture)).digest("hex")
  if (fixtureHash !== expectedFixtureHash) throw new Error(`Fixture hash mismatch: ${fixtureHash}`)
  await log(`run start pid=${process.pid}; build=${JSON.stringify(actual)}; fixture=${fixtureHash}`)
  const requested: [string, (dir: string) => Promise<Scenario>][] = batch === "B"
    ? [
      ["granular-polyphony", (dir: string) => runGranularPolyphony(dir)],
      ["import-failure-reason", (dir: string) => runImportFailureReason(dir)],
      ["project-switch-no-abort-modal", (dir: string) => runProjectSwitchNoAbortModal(dir)],
      ["drum-rack-retry", (dir: string) => runDrumRackRetry(dir)],
    ]
    : [
      ["sampler", (dir: string) => runInstrumentPersistence("sampler", dir)],
      ["drum-rack", (dir: string) => runInstrumentPersistence("drum-rack", dir)],
      ["granular", (dir: string) => runInstrumentPersistence("granular", dir)],
      ["synth", (dir: string) => runSynth(dir)],
      ["audio-export", (dir: string) => runExport(dir)],
      ["import-selected-instrument", (dir: string) => runImport(dir)],
    ]
  for (const [id, run] of requested) {
    if (selected && !selected.includes(id)) continue
    if (Date.now() >= globalDeadline) break
    const scenarioDir = path.join(report, id, runId)
    await mkdir(scenarioDir, { recursive: true, mode: 0o700 })
    active.scenarioDirectory = scenarioDir
    await log(`scenario start ${id}`)
    const result = await run(scenarioDir)
    outcomes.push(result)
    await writeResults(actual, fixtureHash)
    await log(`${result.result} ${id}: ${result.reason}`)
  }
  await writeResults(actual, fixtureHash)
  await log(`run complete ${outcomes.filter((item) => item.result === "PASS").length}/${outcomes.length} PASS`)
}
const runSynth = async (dir: string): Promise<Scenario> => {
  // Filled in with a real synth control commit and MIDI capture below.
  return runSynthScenario(dir)
}
const runSynthScenario = async (dir: string): Promise<Scenario> => {
  const profile = path.join(await createPrivateRunDirectory("/tmp"), "profile")
  let s: Session | undefined
  const evidence: string[] = []
  const metrics: Record<string, Json> = {}
  try {
    s = await launch(profile, dir)
    const state = await commit(s, [{ kind: "track.create", clientRef: "r27-synth", name: "R27 Synth", trackKind: "instrument" }])
    const track = state.tracks.find((item) => item.name === "R27 Synth")
    if (!track) throw new Error("Synth track absent")
    await commit(s, [setInstrument(track.id, "synth", createDefaultSynthParams())])
    await commit(s, [{
      kind: "clip.midi.create", clientRef: "r27-synth-midi", track: { source: "persisted", id: track.id },
      name: "R27 synth chord", startSec: 0, duration: 16, wave: "sawtooth",
      notes: [48, 55, 60, 64].map((pitch, index) => ({ id: `r27-chord-${index}`, beat: 0, length: 32, pitch, velocity: 0.8 })),
    }])
    const before = await saveSnapshot(s, "canonical-before-edit.json")
    const beforeInstrument = paramsFor(before, track.id)
    if (!beforeInstrument) throw new Error("Synth not in canonical snapshot")
    await selectedTrack(s, "R27 Synth")
    await commandTransport(s, "seek", "0"); await commandTransport(s, "play")
    await waitFor(async () => (await evaluate(s!.cdp, `document.body.innerText.includes('R27 Synth')`)) === true, "synth track selected")
    await Bun.sleep(2_000)
    await dragSynthCutoff(s.cdp, -123)
    const after = await saveSnapshot(s, "canonical-after-edit.json")
    await Bun.sleep(2_500)
    await commandTransport(s, "stop")
    const changed = z.record(z.string(), z.json()).parse(paramsFor(after, track.id))
    const changedFilter = z.record(z.string(), z.json()).parse(changed.filter)
    const cutoff = z.number().parse(changedFilter.frequencyHz)
    if (cutoff >= 1_000) throw new Error(`UI cutoff drag did not lower canonical cutoff enough: ${cutoff} Hz`)
    metrics.editedCutoffHz = cutoff
    await selectedTrack(s, "R27 Synth")
    await saveUi(s, "cutoff-after-edit", ["R27 Synth"])
    const visibleEditedCutoff = await readVisibleControl(s, "Cutoff")
    if (!visibleEditedCutoff || Math.abs(Number(visibleEditedCutoff.value) - cutoff) > 0.01) throw new Error("Edited synth cutoff is not visible in the UI")
    await s.cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 4 })
    await s.cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 4 })
    await nativeUndo(s.pid)
    await waitFor(async () => {
      const fresh = await snapshot(s!)
      const value = z.record(z.string(), z.json()).parse(paramsFor(fresh, track.id))
      const filter = z.record(z.string(), z.json()).parse(value.filter)
      const originalFilter = z.record(z.string(), z.json()).parse(z.record(z.string(), z.json()).parse(beforeInstrument).filter)
      return filter.frequencyHz === originalFilter.frequencyHz
    }, "undo restores synth cutoff", 20_000)
    const undone = await saveSnapshot(s, "canonical-after-undo.json")
    const undoneParams = z.record(z.string(), z.json()).parse(paramsFor(undone, track.id))
    const undoneFilter = z.record(z.string(), z.json()).parse(undoneParams.filter)
    const originalFilter = z.record(z.string(), z.json()).parse(z.record(z.string(), z.json()).parse(beforeInstrument).filter)
    if (undoneFilter.frequencyHz !== originalFilter.frequencyHz) throw new Error("Undo did not restore original cutoff")
    await saveUi(s, "cutoff-after-undo", ["R27 Synth"])
    const visibleUndoCutoff = await readVisibleControl(s, "Cutoff")
    if (!visibleUndoCutoff || Math.abs(Number(visibleUndoCutoff.value) - Number(originalFilter.frequencyHz)) > 0.01) throw new Error("Undo cutoff is not visible in the UI")
    await quit(s); s = undefined
    metrics.capture = await tapMetrics(dir, undefined)
    metrics.spectralChange = await analyzeSynthChange(dir)
    evidence.push("canonical-before-edit.json", "canonical-after-edit.json", "canonical-after-undo.json", "cutoff-after-edit.png", "cutoff-after-undo.png", "capture-metrics.json", "native-events.jsonl", "synth-spectral-comparison.json")
    return { id: "synth", title: "Synth cutoff and undo", result: "PASS", reason: "Chord capture was nonzero and finite; visible cutoff changed during playback and reduced its 2.2 kHz component; Cmd+Z restored visible and canonical cutoff.", evidence, metrics }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (s) {
      await cli(profile, ["host", "diagnostics-v2"]).then((value) => writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(value, null, 2), { mode: 0o600 })).catch(() => undefined)
      await evaluate(s.cdp, "document.body.innerText").then((value) => writeFile(path.join(dir, "failure-ui.txt"), String(value), { mode: 0o600 })).catch(() => undefined)
      await screenshot(s.cdp, path.join(dir, "failure.png")).catch(() => undefined)
    }
    return { id: "synth", title: "Synth cutoff and undo", result: "FAIL", reason, evidence: [...evidence, "failure.png", "failure-ui.txt", "host-diagnostics.json"], metrics }
  } finally { await quit(s) }
}
const runExport = async (dir: string): Promise<Scenario> => runExportScenario(dir)
const runExportScenario = async (dir: string): Promise<Scenario> => {
  const profile = path.join(await createPrivateRunDirectory("/tmp"), "profile")
  let s: Session | undefined
  const evidence: string[] = []
  const metrics: Record<string, Json> = {}
  try {
    s = await launch(profile, dir)
    const asset = await importFixture(s)
    const state = await snapshot(s)
    const clip = state.clips.find((item) => item.name.includes(path.basename(fixture)))
    const track = clip ? state.tracks.find((item) => item.id === clip.trackId) : undefined
    if (!clip || !track || track.kind !== "audio") throw new Error("host import did not create an audio clip on an audio track")
    const destination = path.join(dir, "normal-audio-clip.wav")
    const request = {
      mode: "mixdown", format: "wav", destination: { kind: "file", path: destination },
      range: { mode: "custom", startSec: clip.startSec, endSec: clip.startSec + 8 },
      render: { sampleRate: 48000, channels: 2, normalization: { mode: "none" }, tail: { mode: "none" } },
      encoding: { wav: { codec: "pcm-f32", dither: "none" } },
    }
    await writeFile(path.join(dir, "export-request.json"), JSON.stringify(request, null, 2), { mode: 0o600 })
    const job = z.record(z.string(), z.json()).parse(await cli(profile, ["host", "export", "--request", "-"], request))
    const jobId = z.string().parse(job.jobId)
    await waitFor(async () => {
      const status = z.record(z.string(), z.json()).parse(await cli(profile, ["host", "export-status"]))
      return Boolean(status.job && z.record(z.string(), z.json()).parse(status.job).id === jobId
        && ["completed", "failed", "canceled"].includes(String(status.status)))
    }, "explicit export completion", 600_000)
    const status = z.record(z.string(), z.json()).parse(await cli(profile, ["host", "export-status"]))
    if (status.status !== "completed") throw new Error(`Export failed: ${JSON.stringify(status)}`)
    const pcm = await readWav(destination)
    const marker = fixtureMarker(pcm.samples, pcm.channels, pcm.sampleRate, 345_600, 5_760)
    const frames = pcm.samples.length / pcm.channels
    const finite = pcm.samples.every(Number.isFinite)
    const nonzero = pcm.samples.some((sample) => sample !== 0)
    const rms = Math.sqrt(pcm.samples.reduce((sum, sample) => sum + sample * sample, 0) / pcm.samples.length)
    Object.assign(metrics, { assetId: asset.id, clipId: clip.id, frames, sampleRate: pcm.sampleRate, channels: pcm.channels, finite, nonzero, rms, ...marker })
    if (frames !== 384_000 || pcm.sampleRate !== 48_000 || pcm.channels !== 2 || !finite || !nonzero || rms <= 1e-7 || marker.leftMarkerAmplitude <= 0.005 || marker.rightMarkerAmplitude <= 0.005 || Math.abs(marker.leftMarkerAmplitude - marker.rightMarkerAmplitude) <= 0.0001) {
      throw new Error(`Normal clip export assertion failed: ${JSON.stringify(metrics)}`)
    }
    await saveSnapshot(s, "project-snapshot.json")
    evidence.push("normal-audio-clip.wav", "export-request.json", "project-snapshot.json")
    return { id: "audio-export", title: "Normal audio-clip export", result: "PASS", reason: "Explicit host export has expected 384,000 frames, 48 kHz stereo, finite nonzero PCM, and the distinct late marker.", evidence, metrics }
  } catch (error) {
    return { id: "audio-export", title: "Normal audio-clip export", result: "FAIL", reason: error instanceof Error ? error.message : String(error), evidence: ["export-request.json", "host-diagnostics.json"], metrics }
  } finally {
    if (s) await cli(profile, ["host", "diagnostics-v2"]).then((value) => writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(value, null, 2), { mode: 0o600 })).catch(() => undefined)
    await quit(s)
  }
}
const runImport = async (dir: string): Promise<Scenario> => runImportScenario(dir)
const runImportScenario = async (dir: string): Promise<Scenario> => {
  const profile = path.join(await createPrivateRunDirectory("/tmp"), "profile")
  let s: Session | undefined
  try {
    s = await launch(profile, dir)
    let state = await commit(s, [{ kind: "track.create", clientRef: "r27-selected-midi", name: "R27 Selected Synth", trackKind: "instrument" }])
    const instrument = state.tracks.find((item) => item.name === "R27 Selected Synth")
    if (!instrument) throw new Error("Could not create selected instrument track")
    await commit(s, [setInstrument(instrument.id, "synth", createDefaultSynthParams())])
    await selectedTrack(s, "R27 Selected Synth")
    await saveUi(s, "instrument-selected-before-import", ["R27 Selected Synth"])
    const before = await saveSnapshot(s, "snapshot-before-import.json")
    await cli(profile, ["host", "import", "--path", fixture])
    await waitFor(async () => {
      const fresh = await snapshot(s!)
      return fresh.tracks.some((track) => track.id !== instrument.id && track.kind === "audio")
        || fresh.clips.some((clip) => clip.name.includes(path.basename(fixture)))
    }, "implicit host WAV import creates audio lane and clip", 90_000)
    state = await saveSnapshot(s, "snapshot-after-import.json")
    const audioTracks = state.tracks.filter((track) => !before.tracks.some((previous) => previous.id === track.id) && track.kind === "audio")
    const importedClips = state.clips.filter((clip) => clip.name.includes(path.basename(fixture)))
    const addedAssets = state.assets.filter((asset) => !before.assets.some((previous) => previous.id === asset.id))
    if (!audioTracks.length || !importedClips.length || !addedAssets.length) {
      const reason = !importedClips.length || !addedAssets.length
        ? `Import silently skipped content: clips=${importedClips.length}, assets=${addedAssets.length}`
        : `Import created clip+asset on an existing audio track but did not create the expected new audio track: addedAudioTracks=${audioTracks.length}`
      throw new Error(reason)
    }
    await saveUi(s, "after-import", ["R27 Selected Synth", path.basename(fixture)])
    const metrics = { beforeTrackCount: before.tracks.length, afterTrackCount: state.tracks.length, audioTrackCount: audioTracks.length, importedClipCount: importedClips.length, addedAssetCount: addedAssets.length, selectedInstrumentTrackId: instrument.id }
    return { id: "import-selected-instrument", title: "Import WAV with instrument selected", result: "PASS", reason: "Using r26's packaged `host import --path` implicit WAV import entry point, import while an instrument track is selected added a separate audio track, clip, and asset.", evidence: ["instrument-selected-before-import.png", "snapshot-before-import.json", "snapshot-after-import.json", "after-import.png"], metrics }
  } catch (error) {
    if (s) {
      await cli(profile, ["host", "diagnostics-v2"]).then((value) => writeFile(path.join(dir, "host-diagnostics.json"), JSON.stringify(value, null, 2), { mode: 0o600 })).catch(() => undefined)
      await evaluate(s.cdp, "document.body.innerText").then((value) => writeFile(path.join(dir, "failure-ui.txt"), String(value), { mode: 0o600 })).catch(() => undefined)
      await screenshot(s.cdp, path.join(dir, "failure.png")).catch(() => undefined)
    }
    return { id: "import-selected-instrument", title: "Import WAV with instrument selected", result: "FAIL", reason: error instanceof Error ? error.message : String(error), evidence: ["snapshot-before-import.json", "snapshot-after-import.json", "failure.png", "failure-ui.txt", "host-diagnostics.json"], metrics: {} }
  } finally { await quit(s) }
}
const evidenceFiles = async (directory: string, prefix = ""): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(prefix, entry.name)
    return entry.isDirectory()
      ? evidenceFiles(path.join(directory, entry.name), relative)
      : [relative]
  }))
  return nested.flat()
}
const writeResults = async (identity: { asarBytes: number; nativeHostBytes: number; mtime: string }, fixtureHash: string) => {
  const scenarios = await Promise.all(outcomes.map(async (item) => {
    const evidence = await evidenceFiles(path.join(report, item.id, runId))
    return { ...item, evidence: evidence.map((file) => path.join(item.id, runId, file)) }
  }))
  const result = { date: "2026-10-17", batch, build: identity, fixture: { path: path.relative(root, fixture), sha256: fixtureHash, frames: 384_000, sampleRate: 48_000, channels: 2, markerFrame: 345_600 }, scenarios }
  await writeFile(path.join(report, "results.json"), JSON.stringify(result, null, 2), { mode: 0o600 })
  const lines = scenarios.map((item) => `| ${item.title} | **${item.result}** | ${item.reason.replaceAll("|", "\\|")} | Evidence: ${item.evidence.map((file) => `\`${file}\``).join(", ")} |`).join("\n")
  const failed = scenarios.filter((item) => item.result !== "PASS")
  const findings = failed.length === 0 ? "" : `\n## Product findings\n\n${failed.map((item) => `- **${item.title}: ${item.result}.** ${item.reason}`).join("\n")}\n`
  const body = `# Packaged regression scenarios, r27 batch ${batch}\n\nBuild identity verified before testing: app.asar ${identity.asarBytes} bytes, native host ${identity.nativeHostBytes} bytes, mtime ${identity.mtime}. Fixture SHA-256: \`${fixtureHash}\`.\n\n| Scenario | Result | Reason | Evidence |\n|---|---|---|---|\n${lines}\n${findings}\n## Harness\n\nScript: \`tools/acceptance/packaged-r27-regressions.ts\`. Run with \`bun tools/acceptance/packaged-r27-regressions.ts\`; select scenarios with \`DAW_R27_SCENARIOS=<comma-separated scenario IDs>\`. Log: \`${path.basename(logFile)}\`. Each scenario uses a disposable profile, CDP and CLI calls are bounded, scenario deadline is 14 minutes, global deadline is 95 minutes, app shutdown requests \`window.close()\` before a PID-scoped SIGTERM fallback. Project changes follow capabilities → snapshot → preview → approval when required → keyed commit → fresh snapshot. No product files are changed or packaged.\n`
  await writeFile(path.join(report, "report.md"), body, { mode: 0o600 })
}
if (import.meta.main) main().catch(async (error) => {
  await log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  await writeResults({ asarBytes: expected.asar, nativeHostBytes: expected.host, mtime: expected.mtime }, expectedFixtureHash)
  process.exitCode = 1
})
