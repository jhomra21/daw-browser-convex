#!/usr/bin/env bun
import { mkdir, readFile, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { $ } from "bun"
import path from "node:path"
import { browserCommand, buildBrowserRuntime, waitForBrowserValue, withProductionBrowserServer } from "../browser-harness"
import { browserProbeOutputSchema, browserProbeResultSchema, type BrowserProbeResult } from "./probe"
import { deriveProbeErrors, deriveUnavailable, type SourceIdentity } from "./run-result"
import { z } from "zod"
import { assertThirtyTrackSemanticManifest, thirtyTrackSemanticManifest, thirtyTrackFixtureVersion } from "./spec"

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
  build: { mode: "production"; identity: "vite-production"; status: "not-run" | "verified" }
  fixture: {
    semanticManifest: typeof thirtyTrackSemanticManifest
    archive: { status: "not-checked" | "verified"; path: string; bytes?: number }
    integrity: { status: "not-checked" | "verified"; sha256: string | null }
  }
  phases: { fixtureIntegrity: "pending" | "complete" | "failed"; probeCollection: "pending" | "complete" | "failed" | "skipped" | "unsupported" }
  probe: BrowserProbeResult | null
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
    await mkdir(path.dirname(options.out), { recursive: true })
    await Bun.write(options.out, JSON.stringify(result, null, 2))
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
      await mkdir(path.dirname(options.out), { recursive: true })
      await Bun.write(options.out, JSON.stringify(result, null, 2))
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
          const statuses = z.array(z.object({ path: z.string(), status: z.number().int(), body: z.string() }).strict()).parse(JSON.parse(endpointStatuses))
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
          const importedState = z.object({
            localProjectId: z.string().nullable(),
            trackLabels: z.array(z.string()),
            clipTitles: z.array(z.string()),
            serviceWorkerControllerAbsent: z.boolean(),
          }).strict().parse(JSON.parse(await browserCommand(session, ["eval", "(()=>{const state=window.__thirtyTrackBenchmark.state();return {localProjectId:state.localProjectId,trackLabels:state.trackLabels,clipTitles:state.clipTitles,serviceWorkerControllerAbsent:state.serviceWorkerControllerAbsent}})()"])))
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
            const parsed = z.object({ timeline: z.number(), sidebar: z.number() }).strict().parse(JSON.parse(result))
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
          const encoded = z.union([z.string(), z.null()]).or(browserProbeOutputSchema).parse(JSON.parse(output))
          const encodedString = z.string().safeParse(encoded)
          const decoded = encodedString.success ? JSON.parse(encodedString.data) : encoded
          if (decoded === null) throw new Error("Timed out waiting for browser probe.")
          const parsed = browserProbeOutputSchema.parse(decoded)
          if ("error" in parsed) throw new Error(parsed.error)
          return browserProbeResultSchema.parse(parsed)
        } catch (error) {
          const diagnostics = await Promise.all([
            browserCommand(session, ["get", "url"]).catch((diagnosticError) => `url unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`),
            browserCommand(session, ["snapshot", "-c"]).catch((diagnosticError) => `snapshot unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`),
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
    result.phases = { fixtureIntegrity: "complete", probeCollection: "unsupported" }
  }
  await mkdir(path.dirname(options.out), { recursive: true })
  await Bun.write(options.out, JSON.stringify(result, null, 2))
  if (result.errors.length > 0) {
    throw new Error(`Browser probe reported errors: ${result.errors.join("; ")}`)
  }
  console.log(JSON.stringify({ runId, out: options.out, surface: options.surface }, null, 2))
}

await main()
