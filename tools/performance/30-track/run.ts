#!/usr/bin/env bun
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { $ } from "bun"
import path from "node:path"
import { spawn } from "node:child_process"
import { browserCommand, buildBrowserRuntime, waitForBrowserValue, withProductionBrowserServer } from "../browser-harness"
import { browserProbeOutputSchema, browserProbeResultSchema, type BrowserProbeResult } from "./probe"
import {
  cleanupSurvivors,
  createCleanupPlan,
  createNativeDiagnosticDelta,
  createPrivateRunDirectory,
  descendantsOf,
  electronRendererTarget,
  nativeCallbacksIncreased,
  processMetricsAvailability,
  verifyElectronLaunchIdentity,
  writePrivateArtifact,
  type CleanupPlan,
  type ProcessIdentity,
  type ProcessMetric,
} from "./electron"
import { deriveProbeErrors, deriveUnavailable, type ElectronBenchmarkEvidence, type ElectronBenchmarkProgress, type SourceIdentity } from "./run-result"
import { z } from "zod"
import { assertThirtyTrackSemanticManifest, thirtyTrackSemanticManifest, thirtyTrackFixtureVersion } from "./spec"
import { desktopDiagnosticsSchemaV2, desktopHostStatusSchemaV1, desktopTransportStatusSchemaV1 } from "@daw-browser/desktop-protocol"

type Surface = "browser" | "electron"
type CliOptions = {
  readonly surface: Surface
  readonly out: string
}
export type BaselineRunResult = {
  version: "30-track-baseline-v1"
  runId: string
  startedAt: string
  surface: Surface
  fixtureVersion: string
  source: SourceIdentity
  build: { mode: "production"; identity: "vite-production" | "electron-forge-production"; status: "not-run" | "verified" }
  fixture: {
    semanticManifest: typeof thirtyTrackSemanticManifest
    archive: { status: "not-checked" | "verified"; path: string; bytes?: number }
    integrity: { status: "not-checked" | "verified"; sha256: string | null }
  }
  phases: { fixtureIntegrity: "pending" | "complete" | "failed"; probeCollection: "pending" | "complete" | "failed" | "skipped" | "unsupported" }
  probe: BrowserProbeResult | null
  electron: ElectronBenchmarkProgress | null
  unavailable: string[]
  errors: string[]
}

const parseOptions = (arguments_: readonly string[]): CliOptions => {
  let surface: Surface | undefined
  let out: string | undefined
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--surface") {
      const value = arguments_[index + 1]
      if (surface !== undefined || (value !== "browser" && value !== "electron")) throw new Error("Invalid --surface.")
      surface = value
      index += 1
      continue
    }
    if (argument === "--out") {
      const value = arguments_[index + 1]
      if (out !== undefined || value === undefined || !path.isAbsolute(value)) throw new Error("--out must be an absolute path.")
      out = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  if (surface === undefined || out === undefined) throw new Error("Usage: run.ts --surface browser|electron --out <absolute-path>.")
  return { surface, out }
}

const main = async () => {
  const options = parseOptions(Bun.argv.slice(2))
  const root = path.resolve(import.meta.dir, "../../..")
  const commit = (await $`git -C ${root} rev-parse HEAD`.text()).trim()
  const status = await $`git -C ${root} status --porcelain --untracked-files=all`.text()
  const runId = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const result: BaselineRunResult = {
    version: "30-track-baseline-v1",
    runId,
    startedAt,
    surface: options.surface,
    fixtureVersion: thirtyTrackFixtureVersion,
    source: { commit, dirty: status.trim().length > 0 },
    build: {
      mode: "production",
      identity: "vite-production",
      status: "not-run",
    },
    fixture: {
      semanticManifest: thirtyTrackSemanticManifest,
      archive: { status: "not-checked", path: path.join(root, "tools/performance/fixtures/30-track-v1.dawproject") },
      integrity: { status: "not-checked", sha256: null },
    },
    phases: {
      fixtureIntegrity: "pending",
      probeCollection: "pending",
    },
    probe: null,
    electron: null,
    unavailable: deriveUnavailable(options.surface, null),
    errors: [],
  }
  assertThirtyTrackSemanticManifest(thirtyTrackSemanticManifest)
  const archivePath = path.join(root, "tools/performance/fixtures/30-track-v1.dawproject")
  const hashPath = `${archivePath}.sha256`
  try {
    const archive = await readFile(archivePath)
    const hashLine = (await readFile(hashPath, "utf8")).trim()
    const actualHash = createHash("sha256").update(archive).digest("hex")
    if (!hashLine.startsWith(actualHash)) throw new Error("Fixture archive SHA-256 does not match.")
    result.fixture = {
      semanticManifest: thirtyTrackSemanticManifest,
      archive: { status: "verified", path: archivePath, bytes: archive.byteLength },
      integrity: { status: "verified", sha256: actualHash },
    }
    result.phases = { fixtureIntegrity: "complete", probeCollection: "pending" }
  } catch (error) {
    result.phases = { fixtureIntegrity: "failed", probeCollection: "skipped" }
    result.errors = [error instanceof Error ? error.message : String(error)]
    await writeResult(options.out, result)
    throw error
  }
  if (options.surface === "browser") {
    try {
      await $`bun run build`
      result.build = { mode: "production", identity: "vite-production", status: "verified" }
    } catch (error) {
      result.build = { mode: "production", identity: "vite-production", status: "not-run" }
      result.phases = { fixtureIntegrity: "complete", probeCollection: "skipped" }
      result.errors = [error instanceof Error ? error.message : String(error)]
      await writeResult(options.out, result)
      throw error
    }
    const runtimePath = await buildBrowserRuntime({
      entrypoint: path.join(import.meta.dir, "run-runtime.ts"),
      name: "30-track-probe",
    })
    try {
      const probe = await withProductionBrowserServer(path.join(root, "dist/client"), runtimePath, async (server) => {
        const session = `daw-30-track-probe-${runId}`
        try {
          await browserCommand(session, ["set", "viewport", "1440", "900"])
          await browserCommand(session, ["open", server.url.toString()])
          await waitForBrowserValue(session, "window.__thirtyTrackBenchmark", 30_000)
          const endpointStatuses = await browserCommand(session, ["eval", `(async()=>{const paths=['/api/convex-auth/token','/api/auth/get-session','/api/unexpected'];const results=[];for(const path of paths){const response=await fetch(path);results.push({path,status:response.status,body:await response.text()})}return results})()`])
          const statuses = parseJsonOutput(
            z.array(z.object({ path: z.string(), status: z.number().int(), body: z.string() }).strict()),
            endpointStatuses,
            "endpoint statuses",
          )
          const authToken = statuses.find((entry) => entry.path === "/api/convex-auth/token")
          const sessionResponse = statuses.find((entry) => entry.path === "/api/auth/get-session")
          const unexpected = statuses.find((entry) => entry.path === "/api/unexpected")
          if (authToken?.status !== 401 || authToken.body !== '{"token":null}') throw new Error("Signed-out Convex auth endpoint contract failed.")
          if (sessionResponse?.status !== 200 || sessionResponse.body !== "null") throw new Error("Signed-out session endpoint contract failed.")
          if (unexpected?.status !== 404) throw new Error("Unexpected /api endpoint was not observable as 404.")
          await browserCommand(session, ["wait", "--fn", "navigator.serviceWorker.controller === null"])
          await browserCommand(session, ["eval", "(()=>{const button=[...document.querySelectorAll('button')].find((element)=>element.textContent?.trim()==='New project');if(!button)throw new Error('Accessible New project button is missing.');button.click()})()"])
          await waitForBrowserValue(session, "location.search.includes('projectId=') && document.querySelector('[data-timeline-ruler=\"1\"]') !== null ? location.search : null", 60_000)
          await waitForBrowserValue(session, "window.__thirtyTrackBenchmark.state().saveStatus", 30_000)
          const starterUrl = await browserCommand(session, ["get", "url"])
          const starterProjectId = new URL(starterUrl).searchParams.get("projectId")
          if (!starterProjectId) throw new Error("Starter local project ID was not mounted.")
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.setIntegrity({fixtureHashVerified:true})"])
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('import',{selector:'input[accept=\".dawproject,application/vnd.dawproject,application/zip\"]',expectedTracks:30,expectedClips:30})"])
          await browserCommand(session, ["upload", "input[accept='.dawproject,application/vnd.dawproject,application/zip']", archivePath])
          await browserCommand(session, ["wait", "--url", "**projectId=**", "--timeout", "60000"])
          await waitForBrowserValue(session, `(()=>{const labels=[...document.querySelectorAll('[aria-label^="Select track "]')].map((e)=>e.getAttribute('aria-label'));const clips=[...document.querySelectorAll('[title$=" Clip"]')].map((e)=>e.getAttribute('title'));const url=new URL(location.href);return url.searchParams.get('projectId') && url.searchParams.get('projectId')!==${JSON.stringify(starterProjectId)} && labels.length===30 && clips.length===30 ? true : null})()`, 60_000)
          const importedState = parseJsonOutput(z.object({
            localProjectId: z.string().nullable(),
            trackLabels: z.array(z.string()),
            clipTitles: z.array(z.string()),
            serviceWorkerControllerAbsent: z.boolean(),
          }).strict(), await browserCommand(session, ["eval", "(()=>{const state=window.__thirtyTrackBenchmark.state();return {localProjectId:state.localProjectId,trackLabels:state.trackLabels,clipTitles:state.clipTitles,serviceWorkerControllerAbsent:state.serviceWorkerControllerAbsent}})()"]), "browser fixture state")
          const expectedLabels = Array.from({ length: 30 }, (_, index) => `Select track ${index + 1}: Benchmark ${String(index + 1).padStart(2, "0")}`)
          const expectedTitles = Array.from({ length: 30 }, (_, index) => `Benchmark ${String(index + 1).padStart(2, "0")} Clip`)
          if (JSON.stringify(importedState.trackLabels) !== JSON.stringify(expectedLabels)) throw new Error("Imported track accessibility manifest is not canonical.")
          if (JSON.stringify([...importedState.clipTitles].sort()) !== JSON.stringify([...expectedTitles].sort())) throw new Error("Imported clip title manifest is not canonical.")
          if (!importedState.serviceWorkerControllerAbsent) throw new Error("An active service-worker controller is present.")
          await browserCommand(session, ["eval", `window.__thirtyTrackBenchmark.setIntegrity({semanticManifestVerified:true,starterProjectId:${JSON.stringify(starterProjectId)},importedProjectId:${JSON.stringify(importedState.localProjectId)},importedProjectDifferent:${JSON.stringify(importedState.localProjectId !== starterProjectId)},trackCount:${importedState.trackLabels.length},clipCount:${importedState.clipTitles.length},expectedTrackLabels:30,expectedClipTitles:30,serviceWorkerControllerAbsent:true});window.__thirtyTrackBenchmark.finishPhase()`])

          const waitForState = async (expression: string, timeout = 30_000) => {
            try {
              return await waitForBrowserValue(session, expression, timeout)
            } catch (error) {
              throw new Error(`State wait failed for ${expression.slice(0, 180)}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const clickText = async (text: string) => {
            await browserCommand(session, ["find", "role", "menuitem", "click", "--name", text])
          }
          const scroll = async (position: "top" | "bottom", durationMs: number) => {
            const result = await browserCommand(session, ["eval", `(async()=>{const state=window.__thirtyTrackBenchmark.state();if(!state.timeline||!state.sidebar)throw new Error('Timeline/sidebar scroll surfaces unavailable.');const top=${position === "top" ? "0" : "Math.max(0,state.timeline.scrollHeight-state.timeline.clientHeight)"};state.timeline.scrollTop=top;state.timeline.dispatchEvent(new Event('scroll'));await new Promise(requestAnimationFrame);return {timeline:state.timeline.scrollTop,sidebar:state.sidebar.scrollTop}})()`])
            const parsed = parseJsonOutput(z.object({ timeline: z.number(), sidebar: z.number() }).strict(), result, "browser scroll state")
            if (Math.abs(parsed.timeline - parsed.sidebar) > 1) throw new Error("Timeline/sidebar vertical scroll synchronization failed.")
            if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, durationMs))
          }
          const zoom = async (label: "Zoom In" | "Zoom Out") => {
            const before = await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.state().ruler?.getAttribute('style') ?? ''"])
            await clickText("View")
            await clickText(label)
            await waitForState(`(()=>{const r=window.__thirtyTrackBenchmark.state().ruler;return r&&r.getAttribute('style')!==${JSON.stringify(before)}?true:null})()`)
          }

          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('warmup',{sweeps:2,returnToTop:true,pacingMs:1000})"])
          await scroll("top", 0); await scroll("bottom", 1000); await scroll("top", 1000); await scroll("bottom", 1000); await scroll("top", 1000)
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase()"])

          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('zoom',{actions:20,balanced:true,menuDriven:true})"])
          for (let index = 0; index < 10; index += 1) { await zoom("Zoom In"); await zoom("Zoom Out") }
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase()"])

          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('horizontal-pan',{passes:10,logicalDirections:'left-right',readiness:'scroll-event+ruler-style'})"])
          for (let index = 0; index < 10; index += 1) {
            const direction = index % 2 === 0 ? 1 : -1
            const before = await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.state().ruler?.getAttribute('style') ?? ''"])
            await browserCommand(session, ["eval", `(async()=>{const state=window.__thirtyTrackBenchmark.state();if(!state.timeline||!state.ruler)throw new Error('Timeline pan surface unavailable.');state.timeline.scrollLeft+=${direction * 800};state.timeline.dispatchEvent(new Event('scroll'));await new Promise(requestAnimationFrame);return true})()`])
            await waitForState(`(()=>{const r=window.__thirtyTrackBenchmark.state().ruler;return r&&r.getAttribute('style')!==${JSON.stringify(before)}?true:null})()`)
          }
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase()"])

          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('vertical-scroll',{sweeps:4,minActivityDurationMs:8000,pacingMs:1000,pattern:'top-bottom-top',synchronization:'timeline-sidebar'})"])
          for (let index = 0; index < 4; index += 1) { await scroll("top", 0); await scroll("bottom", 1000); await scroll("top", 1000) }
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase()"])

          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('playback',{activation:'agent-browser-role-click',minimumActivityDurationMs:10000,zoomPairs:5,verticalSweeps:5,pacingMs:1000})"])
          await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
          await waitForState("document.querySelector(\"button[aria-label='Pause']\") !== null")
          for (let index = 0; index < 5; index += 1) {
            await zoom("Zoom In")
            await scroll(index % 2 === 0 ? "bottom" : "top", 1000)
            await scroll(index % 2 === 0 ? "top" : "bottom", 1000)
          }
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.setIntegrity({transportPlaybackUiVerified:true})"])
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase()"])
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('stop',{action:'real-stop-click',expectedPlayhead:'0.00s'})"])
          await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])
          await waitForState("document.querySelector(\"button[aria-label='Play']\") !== null && [...document.querySelectorAll('span')].some((e)=>e.textContent?.trim()==='0.00s')")
          await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.setIntegrity({transportStopUiVerified:true});window.__thirtyTrackBenchmark.finishPhase();window.__thirtyTrackBenchmark.finish()"])
          const output = await waitForBrowserValue(session, "window.__thirtyTrackProbeResult", 30_000)
          const parsed = parseJsonOutput(browserProbeOutputSchema, output, "browser probe output")
          if ("error" in parsed) throw new Error(parsed.error)
          return browserProbeResultSchema.parse(parsed)
        } catch (error) {
          const diagnostics = await Promise.all([
            browserCommand(session, ["get", "url"]).catch((diagnosticError) => `url unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`),
            browserCommand(session, ["console"]).catch((diagnosticError) => `console unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`),
            browserCommand(session, ["errors"]).catch((diagnosticError) => `errors unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`),
          ])
          throw new Error(`${error instanceof Error ? error.message : String(error)}; browser diagnostics: ${diagnostics.join(" | ")}`)
        } finally {
          await browserCommand(session, ["close"]).catch(() => undefined)
        }
      })
      result.phases = { fixtureIntegrity: "complete", probeCollection: "complete" }
      result.probe = probe
      result.unavailable = deriveUnavailable(options.surface, probe)
      result.errors = deriveProbeErrors(probe)
      if (result.errors.length > 0) result.phases = { fixtureIntegrity: "complete", probeCollection: "failed" }
    } catch (error) {
      result.phases = { fixtureIntegrity: "complete", probeCollection: "failed" }
      result.errors = [error instanceof Error ? error.message : String(error)]
    } finally {
      await rm(path.dirname(runtimePath), { recursive: true, force: true }).catch(() => undefined)
    }
  } else {
    try {
      await $`bun run build`
      await $`cd ${path.join(root, "packages/control-cli")} && bun run build`
      if (!process.env.VST3_SDK_PATH) throw new Error("VST3_SDK_PATH is required for a fresh packaged Electron Tier 1 run.")
      await $`cd ${path.join(root, "apps/desktop")} && bun run package`
      result.build = { mode: "production", identity: "electron-forge-production", status: "verified" }
      const runtimePath = await buildBrowserRuntime({
        entrypoint: path.join(import.meta.dir, "run-runtime.ts"),
        name: "30-track-probe",
      })
      const evidence = await runElectronBenchmark(root, archivePath, runId, runtimePath, (progress) => {
        result.electron = progress
        if (progress.rendererProbe) result.probe = progress.rendererProbe
      })
      result.phases = { fixtureIntegrity: "complete", probeCollection: "complete" }
      result.probe = evidence.rendererProbe
      result.electron = evidence
      result.unavailable = deriveUnavailable(options.surface, evidence.rendererProbe)
      result.errors = deriveProbeErrors(evidence.rendererProbe)
      if (!evidence.hardGates.packageFresh || !evidence.hardGates.hostReady
        || !evidence.hardGates.diagnosticsClean || !evidence.hardGates.transportVerified
        || !evidence.hardGates.nativeCallbacksIncreased || !evidence.hardGates.noRendererErrors) {
        result.errors.push("Electron Tier 1 hard gate failed.")
        result.phases = { fixtureIntegrity: "complete", probeCollection: "failed" }
      }
    } catch (error) {
      result.phases = { fixtureIntegrity: "complete", probeCollection: "failed" }
      result.errors = [error instanceof Error ? conciseError(error) : "Electron benchmark failed."]
      if (result.electron?.status !== "failed") {
        result.electron = { status: "failed", stage: "setup", error: "Electron benchmark failed." }
      }
    }
  }
  await writeResult(options.out, result)
  if (result.errors.length > 0) {
    throw new Error(options.surface === "electron"
      ? "Electron benchmark reported errors."
      : `Browser probe reported errors: ${result.errors.join("; ")}`)
  }
  console.log(JSON.stringify({ runId, surface: options.surface }, null, 2))
}

type ChildProcess = ReturnType<typeof spawn>

const writeResult = async (outputPath: string, result: BaselineRunResult): Promise<void> => {
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 })
  await writePrivateArtifact(outputPath, JSON.stringify(result, null, 2))
}

type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue }

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]))

const parseEncodedJson = (input: string, label: string): JsonValue => {
  let value: JsonValue
  try {
    value = jsonValueSchema.parse(JSON.parse(input))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (let depth = 0; depth < 5; depth += 1) {
    const encoded = z.string().safeParse(value)
    if (!encoded.success) return value
    try {
      value = jsonValueSchema.parse(JSON.parse(encoded.data))
    } catch {
      return value
    }
  }
  throw new Error(`${label} exceeded the maximum JSON encoding depth.`)
}

const parseJsonOutput = <Value>(schema: z.ZodType<Value>, input: string, label: string): Value => (
  schema.parse(parseEncodedJson(input, label))
)

const commandJson = async (root: string, profile: string, arguments_: readonly string[]): Promise<JsonValue> => {
  const cli = path.join(root, "packages/control-cli/dist/daw-control.js")
  const child = Bun.spawn(["bun", cli, ...arguments_], {
    cwd: root,
    env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`daw-control ${arguments_.join(" ")} failed: ${stderr.slice(0, 512)}`)
  if (stdout.trim().length === 0) {
    throw new Error(`daw-control ${arguments_.join(" ")} returned an empty response${stderr.trim() ? `: ${stderr.trim().slice(0, 512)}` : "."}`)
  }
  return parseEncodedJson(stdout, `daw-control ${arguments_.join(" ")}`)
}

const commandData = <Value>(schema: z.ZodType<Value>, envelopeValue: JsonValue): Value => {
  const envelopeResult = z.object({ data: jsonValueSchema }).passthrough().safeParse(envelopeValue)
  if (!envelopeResult.success) throw new Error(`${envelopeResult.error.message}; command response: ${JSON.stringify(envelopeValue).slice(0, 1_000)}`)
  const envelope = envelopeResult.data
  const data = parseEncodedJsonValue(envelope.data, "command data")
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new Error(`${parsed.error.message}; command data: ${JSON.stringify(data).slice(0, 1_000)}`)
  return parsed.data
}

const parseEncodedJsonValue = (value: JsonValue, label: string): JsonValue => (
  jsonValueSchema.parse(parseEncodedJson(JSON.stringify(value), label))
)

const conciseError = (error: Error): string => error.message.replace(/\s+/g, " ").trim().slice(0, 512) || "Electron benchmark failed."

type ProcessRow = ProcessIdentity & {
  readonly cpu: number
  readonly rss: number
}

const processRows = async (): Promise<ProcessRow[]> => {
  const output = await $`ps -axo pid=,ppid=,pgid=,pcpu=,rss=,command=`.text()
  const rows = output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
    if (!match) return []
    const [, pidField, parentPidField, processGroupField, cpuField, rssField, command] = match
    if (!pidField || !parentPidField || !processGroupField || !cpuField || !rssField || !command) return []
    const processPid = Number(pidField)
    const parentPid = Number(parentPidField)
    const processGroupId = Number(processGroupField)
    const cpu = Number(cpuField)
    const rss = Number(rssField)
    return Number.isInteger(processPid) && Number.isInteger(parentPid) && Number.isInteger(processGroupId)
      && Number.isFinite(cpu) && Number.isFinite(rss)
      ? [{ pid: processPid, parentPid, processGroupId, cpu, rss, command }]
      : []
  })
  return rows
}

const processMetrics = async (pid: number): Promise<ProcessMetric[]> => {
  const rows = await processRows()
  const ownedPids = new Set([pid, ...descendantsOf(rows, pid)])
  return rows.filter((row) => ownedPids.has(row.pid)).map((row) => ({
    pid: row.pid,
    role: row.pid === pid ? "main" : "child",
    cpuPercent: row.cpu,
    rssBytes: row.rss * 1024,
  }))
}

const listenerPids = async (port: number): Promise<number[]> => {
  const process = Bun.spawn(["lsof", "-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(process.stdout).text()
  const exitCode = await process.exited
  if (exitCode !== 0 && exitCode !== 1) throw new Error("Could not inspect the Electron debugging listener.")
  return output.split(/\s+/).flatMap((field) => {
    const pid = Number(field)
    return Number.isInteger(pid) && pid > 0 ? [pid] : []
  })
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForCleanup = async (plan: CleanupPlan, timeoutMs: number): Promise<number[]> => {
  const deadline = Date.now() + timeoutMs
  let survivors: number[] = []
  do {
    survivors = cleanupSurvivors(plan, await processRows())
    if (survivors.length === 0) return []
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  return survivors
}

const terminate = async (child: ChildProcess | undefined, establishedPlan: CleanupPlan | undefined) => {
  if (!child?.pid) return
  const rootAlive = processExists(child.pid)
  const plan = rootAlive
    ? createCleanupPlan(await processRows(), child.pid)
    : establishedPlan
  if (!plan) {
    if (!rootAlive) return
    throw new Error("Refusing to terminate an Electron process without runner-owned process-group identity.")
  }
  if (rootAlive) process.kill(-plan.processGroupId, "SIGTERM")
  const survivors = await waitForCleanup(plan, 5_000)
  if (survivors.length > 0) {
    for (const pid of survivors) process.kill(pid, "SIGKILL")
  }
  const finalSurvivors = await waitForCleanup(plan, 2_000)
  if (finalSurvivors.length > 0) {
    throw new Error(`Runner-owned Electron cleanup failed for ${finalSurvivors.length} process(es).`)
  }
}

type CdpEndpoint = {
  readonly websocketUrl: string
}

const assertCdpIdentity = async (
  profile: string,
  rootPid: number,
  executablePath: string,
  port: number,
  websocketUrl: string,
): Promise<void> => {
  const identity = verifyElectronLaunchIdentity({
    rootPid,
    executablePath,
    profilePath: profile,
    port,
    listenerPids: await listenerPids(port),
    processes: await processRows(),
    websocketUrl,
  })
  if (!identity.verified) throw new Error(identity.reason)
}

const waitForCdp = async (
  profile: string,
  rootPid: number,
  executablePath: string,
): Promise<CdpEndpoint> => {
  let lastError = "CDP did not become available."
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const fields = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/)
      const port = Number(fields[0])
      const browserPath = fields[1]
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || !browserPath) {
        throw new Error("Electron debugging capability file is invalid.")
      }
      const websocketUrl = `ws://127.0.0.1:${port}${browserPath}`
      await assertCdpIdentity(profile, rootPid, executablePath, port, websocketUrl)
      return { websocketUrl }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(lastError)
}

const selectElectronRenderer = async (session: string, getAppOutput: () => string) => {
  let lastError = "Electron renderer target did not become available."
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const tabs = await browserCommand(session, ["tab"])
      const target = electronRendererTarget(tabs)?.targetId
      if (target) {
        await browserCommand(session, ["tab", target])
        const url = await browserCommand(session, ["get", "url"])
        if (url !== "daw://app/") throw new Error("Electron renderer identity changed during attachment.")
        return
      }
      lastError = `Electron renderer target not listed: ${tabs}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(`${lastError}; packaged app output: ${getAppOutput().slice(-4_000)}`)
}

type ElectronProgressReporter = (progress: ElectronBenchmarkProgress) => void

const runElectronBenchmark = async (
  root: string,
  archivePath: string,
  runId: string,
  runtimePath: string,
  reportProgress: ElectronProgressReporter,
): Promise<ElectronBenchmarkEvidence> => {
  const packageRoot = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64")
  const appPath = path.join(packageRoot, "@daw-browser-desktop.app")
  const executablePath = path.join(appPath, "Contents/MacOS/@daw-browser-desktop")
  // macOS Unix-domain socket paths are short; a private directory directly
  // under /tmp keeps the desktop control socket within the kernel limit.
  const runDirectory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(runDirectory, "profile")
  let app: ChildProcess | undefined
  let cleanupPlan: CleanupPlan | undefined
  let browserAttached = false
  let retainFailureEvidence = false
  const session = `daw-30-track-electron-${runId}`
  let stage = "launch"
  let progress: ElectronBenchmarkProgress = { status: "running", stage }
  const report = (next: ElectronBenchmarkProgress) => {
    progress = next
    reportProgress(next)
  }
  try {
    await mkdir(profile, { recursive: true, mode: 0o700 })
    const packageStat = await stat(path.join(appPath, "Contents/Resources/app.asar"))
    if (!packageStat.isFile()) throw new Error("Packaged Electron app.asar is missing.")
    const appHash = createHash("sha256").update(await readFile(path.join(appPath, "Contents/Resources/app.asar"))).digest("hex")
    report({
      status: "running",
      stage: "package-verified",
      package: { identity: "electron-forge-production", platform: "darwin", architecture: "arm64", electronVersion: "43.1.1", appVersion: "0.0.0", asarSha256: appHash, sourceCommit: (await $`git -C ${root} rev-parse HEAD`.text()).trim() },
    })
    // agent-browser only supports TCP/WebSocket CDP attachment, not
    // --remote-debugging-pipe. Port 0 lets Chromium atomically bind an
    // unpredictable loopback port and publish its UUID browser capability in
    // the private profile, avoiding the release-before-launch port race.
    app = spawn(executablePath, [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
    ], {
      cwd: root,
      env: { ...process.env, DAW_DESKTOP_USER_DATA: profile },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    let appOutput = ""
    app.stdout?.on("data", (chunk: Buffer) => { appOutput += chunk.toString().slice(-4_000) })
    app.stderr?.on("data", (chunk: Buffer) => { appOutput += chunk.toString().slice(-4_000) })
    if (!app.pid) throw new Error("Packaged Electron launch did not return a process ID.")
    const cdp = await waitForCdp(profile, app.pid, executablePath).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; packaged app output: ${appOutput.slice(-4_000)}`)
    })
    await browserCommand(session, ["connect", cdp.websocketUrl])
    browserAttached = true
    const cdpUrl = new URL(cdp.websocketUrl)
    await assertCdpIdentity(profile, app.pid, executablePath, Number(cdpUrl.port), cdp.websocketUrl)
    cleanupPlan = createCleanupPlan(await processRows(), app.pid)
    if (!cleanupPlan) throw new Error("Electron cleanup ownership could not be established.")
    await selectElectronRenderer(session, () => appOutput)
    await browserCommand(session, ["set", "viewport", "1440", "900"])
    await browserCommand(session, ["wait", "--load", "networkidle"])
    const runtime = await readFile(runtimePath, "utf8")
    const runtimeChunks = runtime.match(/[\s\S]{1,8192}/g) ?? []
    await browserCommand(session, ["eval", "window.__thirtyTrackRuntimeSource=''"])
    for (const chunk of runtimeChunks) {
      await browserCommand(session, ["eval", `window.__thirtyTrackRuntimeSource+=atob(${JSON.stringify(Buffer.from(chunk).toString("base64"))})`])
    }
    await browserCommand(session, ["eval", "eval(window.__thirtyTrackRuntimeSource);delete window.__thirtyTrackRuntimeSource"])
    await waitForBrowserValue(session, "window.__thirtyTrackBenchmark", 30_000)
    stage = "host-status-before-import"
    const cliStatus = await commandJson(root, profile, ["host", "status"])
    const beforeImport = commandData(desktopHostStatusSchemaV1, cliStatus)
    report({ ...progress, stage, host: { beforeImport } })
    if (!beforeImport.ready) throw new Error("Packaged host is not ready.")
    await browserCommand(session, ["eval", "(()=>{const button=[...document.querySelectorAll('button')].find((element)=>element.textContent?.trim()==='New project');if(!button)throw new Error('Accessible New project button is missing.');button.click()})()"])
    await waitForBrowserValue(session, "location.search.includes('projectId=') && document.querySelector('[data-timeline-ruler=\"1\"]') !== null ? location.search : null", 60_000)
    await waitForBrowserValue(session, "window.__thirtyTrackBenchmark.state().saveStatus", 30_000)
    const starterProjectId = new URL(await browserCommand(session, ["get", "url"])).searchParams.get("projectId")
    if (!starterProjectId) throw new Error("Starter local project ID was not mounted.")
    stage = "host-status-mounted"
    const mounted = commandData(desktopHostStatusSchemaV1, await commandJson(root, profile, ["host", "status"]))
    report({ ...progress, stage, host: { ...progress.host, mounted } })
    if (!mounted.ready || mounted.project === null) throw new Error("Packaged host did not mount the blank local project.")
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.setIntegrity({fixtureHashVerified:true})"])
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('import',{selector:'input[accept=\".dawproject,application/vnd.dawproject,application/zip\"]',expectedTracks:30,expectedClips:30})"])
    await browserCommand(session, ["upload", "input[accept='.dawproject,application/vnd.dawproject,application/zip']", archivePath])
    await waitForBrowserValue(session, `(()=>{const labels=[...document.querySelectorAll('[aria-label^="Select track "]')];const clips=[...document.querySelectorAll('[title$=" Clip"]')];const url=new URL(location.href);return url.searchParams.get('projectId') && url.searchParams.get('projectId')!==${JSON.stringify(starterProjectId)} && labels.length===30 && clips.length===30 ? true : null})()`, 60_000)
    const imported = parseJsonOutput(z.object({
      localProjectId: z.string().nullable(),
      trackLabels: z.array(z.string()),
      clipTitles: z.array(z.string()),
      serviceWorkerControllerAbsent: z.boolean(),
    }).strict(), await browserCommand(session, ["eval", "(()=>{const state=window.__thirtyTrackBenchmark.state();return JSON.stringify({localProjectId:state.localProjectId,trackLabels:state.trackLabels,clipTitles:state.clipTitles,serviceWorkerControllerAbsent:state.serviceWorkerControllerAbsent})})()"]), "Electron fixture state")
    const expectedLabels = Array.from({ length: 30 }, (_, index) => `Select track ${index + 1}: Benchmark ${String(index + 1).padStart(2, "0")}`)
    const expectedTitles = Array.from({ length: 30 }, (_, index) => `Benchmark ${String(index + 1).padStart(2, "0")} Clip`)
    if (JSON.stringify(imported.trackLabels) !== JSON.stringify(expectedLabels) || JSON.stringify([...imported.clipTitles].sort()) !== JSON.stringify([...expectedTitles].sort())) throw new Error("Imported Electron DOM manifest is not canonical.")
    await browserCommand(session, ["eval", `window.__thirtyTrackBenchmark.setIntegrity({semanticManifestVerified:true,starterProjectId:${JSON.stringify(starterProjectId)},importedProjectId:${JSON.stringify(imported.localProjectId)},importedProjectDifferent:${JSON.stringify(imported.localProjectId !== starterProjectId)},trackCount:30,clipCount:30,expectedTrackLabels:30,expectedClipTitles:30,serviceWorkerControllerAbsent:${String(imported.serviceWorkerControllerAbsent)}});window.__thirtyTrackBenchmark.finishPhase()`])
    const waitForState = async (expression: string) => waitForBrowserValue(session, expression, 30_000)
    const scroll = async (position: "top" | "bottom", durationMs: number) => {
      const value = parseJsonOutput(z.object({ timeline: z.number(), sidebar: z.number() }).strict(), await browserCommand(session, ["eval", `(async()=>{const s=window.__thirtyTrackBenchmark.state();if(!s.timeline||!s.sidebar)throw new Error('Timeline/sidebar unavailable.');s.timeline.scrollTop=${position === "top" ? "0" : "Math.max(0,s.timeline.scrollHeight-s.timeline.clientHeight)"};s.timeline.dispatchEvent(new Event('scroll'));await new Promise(requestAnimationFrame);return {timeline:s.timeline.scrollTop,sidebar:s.sidebar.scrollTop}})()`]), "Electron scroll state")
      if (Math.abs(value.timeline - value.sidebar) > 1) throw new Error("Timeline/sidebar vertical scroll synchronization failed.")
      if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, durationMs))
    }
    const zoom = async (label: "Zoom In" | "Zoom Out") => {
      const before = await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.state().ruler?.getAttribute('style') ?? ''"])
      const deltaY = label === "Zoom In" ? -240 : 240
      await browserCommand(session, ["eval", `(async()=>{const timeline=window.__thirtyTrackBenchmark.state().timeline;if(!timeline)throw new Error('Timeline zoom surface unavailable.');timeline.dispatchEvent(new WheelEvent('wheel',{deltaY:${deltaY},deltaMode:0,ctrlKey:true,bubbles:true}));await new Promise(requestAnimationFrame);return true})()`])
      await waitForState(`(()=>{const r=window.__thirtyTrackBenchmark.state().ruler;return r&&r.getAttribute('style')!==${JSON.stringify(before)}?true:null})()`)
    }
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.startPhase('warmup',{sweeps:2,returnToTop:true,pacingMs:1000})"])
    await scroll("top", 0); await scroll("bottom", 1000); await scroll("top", 1000); await scroll("bottom", 1000); await scroll("top", 1000)
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase();window.__thirtyTrackBenchmark.startPhase('zoom',{actions:20,balanced:true,menuDriven:true})"])
    for (let index = 0; index < 10; index += 1) { await zoom("Zoom In"); await zoom("Zoom Out") }
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase();window.__thirtyTrackBenchmark.startPhase('horizontal-pan',{passes:10,logicalDirections:'left-right',readiness:'scroll-event+ruler-style'})"])
    for (let index = 0; index < 10; index += 1) {
      const direction = index % 2 === 0 ? 1 : -1
      const before = await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.state().ruler?.getAttribute('style') ?? ''"])
      await browserCommand(session, ["eval", `(async()=>{const s=window.__thirtyTrackBenchmark.state();if(!s.timeline||!s.ruler)throw new Error('Timeline unavailable.');s.timeline.scrollLeft+=${direction * 800};s.timeline.dispatchEvent(new Event('scroll'));await new Promise(requestAnimationFrame);return true})()`])
      await waitForState(`(()=>{const r=window.__thirtyTrackBenchmark.state().ruler;return r&&r.getAttribute('style')!==${JSON.stringify(before)}?true:null})()`)
    }
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase();window.__thirtyTrackBenchmark.startPhase('vertical-scroll',{sweeps:4,minActivityDurationMs:8000,pacingMs:1000,pattern:'top-bottom-top',synchronization:'timeline-sidebar'})"])
    for (let index = 0; index < 4; index += 1) { await scroll("top", 0); await scroll("bottom", 1000); await scroll("top", 1000) }
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.finishPhase();window.__thirtyTrackBenchmark.startPhase('playback',{activation:'agent-browser-role-click',minimumActivityDurationMs:10000,zoomPairs:5,verticalSweeps:5,pacingMs:1000})"])
    stage = "diagnostics-before-playback"
    const beforePlayback = commandData(desktopDiagnosticsSchemaV2, await commandJson(root, profile, ["host", "diagnostics-v2"]))
    report({ ...progress, stage, host: { ...progress.host, beforePlayback } })
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
    await waitForState("document.querySelector(\"button[aria-label='Pause']\") !== null")
    for (let index = 0; index < 5; index += 1) { await zoom("Zoom In"); await scroll(index % 2 === 0 ? "bottom" : "top", 1000); await scroll(index % 2 === 0 ? "top" : "bottom", 1000) }
    stage = "transport-playing"
    const playing = commandData(desktopTransportStatusSchemaV1, await commandJson(root, profile, ["host", "transport-status"]))
    const duringPlayback = await processMetrics(app.pid ?? 0)
    stage = "diagnostics-after-playback"
    const afterPlayback = commandData(desktopDiagnosticsSchemaV2, await commandJson(root, profile, ["host", "diagnostics-v2"]))
    report({ ...progress, stage, host: { ...progress.host, afterPlayback }, transport: { playing }, processMetrics: { ...progress.processMetrics, duringPlayback } })
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.setIntegrity({transportPlaybackUiVerified:true});window.__thirtyTrackBenchmark.finishPhase();window.__thirtyTrackBenchmark.startPhase('stop',{action:'real-stop-click',expectedPlayhead:'0.00s'})"])
    const stopButtonVisible = parseJsonOutput(z.boolean(), await browserCommand(session, ["eval", "document.querySelector(\"button[aria-label='Stop']\") !== null"]), "stop button visibility")
    if (!stopButtonVisible) {
      await browserCommand(session, ["find", "role", "button", "click", "--name", "OK"]).catch(() => undefined)
    }
    if (parseJsonOutput(z.boolean(), await browserCommand(session, ["eval", "document.querySelector(\"button[aria-label='Stop']\") !== null"]), "stop button visibility")) {
      await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])
    }
    await waitForState("document.querySelector(\"button[aria-label='Play']\") !== null && [...document.querySelectorAll('span')].some((e)=>e.textContent?.trim()==='0.00s')")
    stage = "transport-stopped"
    const stopped = commandData(desktopTransportStatusSchemaV1, await commandJson(root, profile, ["host", "transport-status"]))
    const afterStop = commandData(desktopDiagnosticsSchemaV2, await commandJson(root, profile, ["host", "diagnostics-v2"]))
    report({ ...progress, stage, host: { ...progress.host, afterStop }, transport: { ...progress.transport, stopped } })
    await browserCommand(session, ["eval", "window.__thirtyTrackBenchmark.setIntegrity({transportStopUiVerified:true});window.__thirtyTrackBenchmark.finishPhase();window.__thirtyTrackBenchmark.finish()"])
    stage = "probe-result"
    const parsed = parseJsonOutput(browserProbeOutputSchema, await waitForBrowserValue(session, "window.__thirtyTrackProbeResult", 30_000), "Electron probe output")
    if ("error" in parsed) throw new Error(parsed.error)
    const delta = afterPlayback.native.status === "available" && beforePlayback.native.status === "available"
      ? createNativeDiagnosticDelta(
        { state: beforePlayback.native.diagnostics.state, sampleRate: beforePlayback.audio.sampleRate, workletFaultCount: beforePlayback.audio.workletFaultCount, inferredApplicationStallCount: beforePlayback.audio.inferredApplicationStallCount, callbacks: beforePlayback.native.diagnostics.callbacks, rejectedBlocks: beforePlayback.native.diagnostics.rejectedBlocks },
        { state: afterPlayback.native.diagnostics.state, sampleRate: afterPlayback.audio.sampleRate, workletFaultCount: afterPlayback.audio.workletFaultCount, inferredApplicationStallCount: afterPlayback.audio.inferredApplicationStallCount, callbacks: afterPlayback.native.diagnostics.callbacks, rejectedBlocks: afterPlayback.native.diagnostics.rejectedBlocks },
      )
      : null
    const beforeMetrics = await processMetrics(app.pid ?? 0)
    const processAvailability = processMetricsAvailability([...beforeMetrics, ...duringPlayback])
    const evidence = {
      package: { identity: "electron-forge-production", platform: "darwin", architecture: "arm64", electronVersion: "43.1.1", appVersion: "0.0.0", asarSha256: appHash, sourceCommit: (await $`git -C ${root} rev-parse HEAD`.text()).trim() },
      rendererProbe: parsed,
      host: { beforeImport, mounted, beforePlayback, afterPlayback, afterStop, nativePlaybackDelta: delta },
      transport: { playing, stopped },
      processMetrics: { availability: processAvailability.available ? "available" : "unavailable", reason: processAvailability.available ? null : processAvailability.reason, before: beforeMetrics, duringPlayback, afterStop: await processMetrics(app.pid ?? 0) },
      hardGates: {
        packageFresh: true,
        hostReady: beforeImport.ready,
        diagnosticsClean: afterPlayback.audio.workletFaultCount === beforePlayback.audio.workletFaultCount && afterPlayback.recording.lastFailurePresent === false && (delta?.rejectedBlocksIncrease ?? 0) === 0,
        transportVerified: playing.state === "playing" && stopped.state === "stopped" && stopped.playheadSec === 0,
        nativeCallbacksIncreased: nativeCallbacksIncreased(delta),
        noRendererErrors: parsed.startupErrors.length === 0 && parsed.phases.every((phase) => phase.errors.length === 0),
      },
    }
    report({ status: "complete", stage: "complete", ...evidence })
    return evidence
  } catch (error) {
    retainFailureEvidence = true
    const privateError = error instanceof Error ? conciseError(error) : "Electron benchmark failed."
    const failureEvidencePath = path.join(runDirectory, "failure.json")
    const diagnostics = browserAttached
      ? await Promise.all([
        browserCommand(session, ["get", "url"]).catch(() => "url unavailable"),
        browserCommand(session, ["console"]).catch(() => "console unavailable"),
        browserCommand(session, ["errors"]).catch(() => "errors unavailable"),
        browserCommand(session, ["eval", "document.querySelector('[role=\"dialog\"]')?.textContent ?? 'dialog unavailable'"]).catch(() => "dialog unavailable"),
      ])
      : ["Browser attachment was not verified."]
    await writePrivateArtifact(
      failureEvidencePath,
      JSON.stringify({ ...progress, status: "failed", stage, error: privateError, diagnostics }, null, 2),
    )
    report({ ...progress, status: "failed", stage, error: "Electron benchmark failed." })
    throw new Error(`Electron benchmark failed at ${stage}.`)
  } finally {
    await browserCommand(session, ["close"]).catch(() => undefined)
    await terminate(app, cleanupPlan)
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
    if (!retainFailureEvidence) {
      await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
    await rm(path.dirname(runtimePath), { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
