#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { controlCapabilitiesSchemaV2, controlCommitResultSchemaV1, controlPreviewResultSchemaV1, projectSnapshotSchemaV2 } from "@daw-browser/control"
import { desktopTransportStatusSchemaV1 } from "@daw-browser/desktop-protocol"
import { browserCommand } from "../performance/browser-harness"
import { createPrivateRunDirectory, electronRendererTarget, writePrivateArtifact } from "../performance/30-track/electron"
import { ownedV3CdpEndpoint } from "../performance/30-track/v3-import-acceptance"

const root = path.resolve(import.meta.dir, "../..")
const appPath = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app")
const executable = path.join(appPath, "Contents/MacOS/@daw-browser-desktop")
const expectedBuild = process.env.DAW_EXPECTED_ASAR_SIZE === undefined ? undefined : {
  size: z.coerce.number().int().positive().parse(process.env.DAW_EXPECTED_ASAR_SIZE),
  mtime: z.string().min(1).parse(process.env.DAW_EXPECTED_ASAR_MTIME),
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const localTimestamp = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
const output = process.env.DAW_RULER_ACCEPTANCE_OUT
  ?? path.join(root, `acceptance-reports/daw-experience-packaged-r17-2026-10-16/run-${Date.now()}`)
const runDir = await createPrivateRunDirectory("/tmp")
const profile = path.join(runDir, "profile")
const stderrPath = path.join(output, "app.stderr")
const stdoutPath = path.join(output, "app.stdout")
const samplesPath = path.join(output, "samples.jsonl")
await mkdir(output, { recursive: true, mode: 0o700 })
for (const name of ["phases.jsonl", "samples.jsonl", "clicks.jsonl", "run-error.txt", "host-diagnostics-extract.txt", "assertions.jsonl"]) {
  await rm(path.join(output, name), { force: true })
}
const { stat } = await import("node:fs/promises")
const initialBuild = await stat(path.join(appPath, "Contents/Resources/app.asar"))
const initialIdentity = {
  size: initialBuild.size,
  mtime: localTimestamp(initialBuild.mtime),
}
await writeFile(path.join(output, "build-before.json"), JSON.stringify({
  ...initialIdentity,
  expected: expectedBuild,
  matchesExpected: expectedBuild === undefined ? null : initialIdentity.size === expectedBuild.size && initialIdentity.mtime === expectedBuild.mtime,
}, null, 2))
const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`], {
  cwd: root, detached: true,
  env: { ...process.env, DAW_DESKTOP_USER_DATA: profile },
  stdio: ["ignore", "pipe", "pipe"],
})
const pid = app.pid
if (!pid) throw new Error("Packaged app did not start.")
await mkdir(output, { recursive: true, mode: 0o700 })
const stderrFile = await import("node:fs").then(({ createWriteStream }) => createWriteStream(stderrPath, { flags: "w", mode: 0o600 }))
app.stderr?.pipe(stderrFile)
const stdoutFile = await import("node:fs").then(({ createWriteStream }) => createWriteStream(stdoutPath, { flags: "w", mode: 0o600 }))
app.stdout?.pipe(stdoutFile)

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
const cdpConnect = (endpoint: string) => new Promise<{
  call: (method: string, params?: { [key: string]: JsonValue }) => Promise<JsonValue>
  close: () => void
}>((resolve, reject) => {
  const socket = new WebSocket(endpoint)
  let sequence = 1
  let sessionId = ""
  const pending = new Map<number, { resolve: (value: JsonValue) => void; reject: (error: Error) => void }>()
  const attached = new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: sequence++, method: "Target.getTargets" })))
    socket.addEventListener("message", (event) => {
      const message = z.object({
        id: z.number().optional(),
        result: z.json().optional(),
        error: z.object({ message: z.string().optional() }).optional(),
        sessionId: z.string().optional(),
      }).passthrough().parse(JSON.parse(String(event.data)))
      if (message.id === 1) {
        const targets = z.object({ targetInfos: z.array(z.object({
          targetId: z.string(), type: z.string(), url: z.string(),
        }).passthrough()) }).parse(message.result)
        const target = targets.targetInfos.find((item) => item.type === "page" && item.url.startsWith("daw://app/"))
          ?? targets.targetInfos.find((item) => item.type === "page")
        if (!target) return fail(new Error("No packaged renderer target exists in CDP."))
        const attachId = sequence++
        socket.send(JSON.stringify({
          id: attachId, method: "Target.attachToTarget", params: { targetId: target.targetId, flatten: true },
        }))
      }
      const attachedTarget = z.object({ sessionId: z.string() }).safeParse(message.result)
      if (message.id === 2 && attachedTarget.success) {
        sessionId = attachedTarget.data.sessionId
        done()
      } else if (message.id === 2 && message.error) fail(new Error(message.error.message ?? "CDP attach failed."))
      if (message.id !== undefined && message.id > 2) {
        const request = pending.get(message.id)
        if (request) {
          pending.delete(message.id)
          if (message.error) request.reject(new Error(message.error.message ?? "CDP request failed."))
          else request.resolve(message.result ?? null)
        }
      }
    })
    socket.addEventListener("error", () => fail(new Error("CDP socket error.")))
  })
  void attached.then(() => resolve({
    call: async (method, params = {}) => {
      const id = sequence++
      const response = new Promise<JsonValue>((done, fail) => pending.set(id, { resolve: done, reject: fail }))
      socket.send(JSON.stringify({ id, method, params, sessionId }))
      return response
    },
    close: () => socket.close(),
  }), reject)
})

const command = async (args: string[], input?: JsonValue) => {
  const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
    cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") },
    stdout: "pipe", stderr: "pipe", stdin: input === undefined ? "ignore" : "pipe",
  })
  if (input !== undefined && child.stdin) { child.stdin.write(`${JSON.stringify(input)}\n`); child.stdin.end() }
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (await child.exited !== 0) throw new Error(`daw-control failed: ${stderr.slice(0, 500)}`)
  return z.object({ data: z.json() }).passthrough().parse(JSON.parse(stdout)).data
}
const mark = async (phase: string, action: () => Promise<void>) => {
  await appendFile(path.join(output, "phases.jsonl"), `${JSON.stringify({ event: "start", phase, at: new Date().toISOString() })}\n`)
  await action()
  await appendFile(path.join(output, "phases.jsonl"), `${JSON.stringify({ event: "end", phase, at: new Date().toISOString() })}\n`)
}
const cdpEval = async (cdp: Awaited<ReturnType<typeof cdpConnect>>, expression: string) => {
  const reply = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (z.object({ exceptionDetails: z.json() }).safeParse(reply).success) throw new Error(`Renderer evaluation failed: ${JSON.stringify(reply)}`)
  const result = z.object({ result: z.object({ value: z.json().optional() }) }).parse(reply)
  return result.result.value
}
const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await pause(200)
  }
  throw new Error("Timed out waiting for packaged app state.")
}

let cdp: Awaited<ReturnType<typeof cdpConnect>> | undefined
let endpoint: string | undefined
let targetId: string | undefined
let runError: string | undefined
const runResults: { [key: string]: string } = {}
try {
  const build = await stat(path.join(appPath, "Contents/Resources/app.asar"))
  const identity = { size: build.size, mtime: localTimestamp(build.mtime) }
  await writeFile(path.join(output, "build-before.json"), JSON.stringify({
    ...identity,
    expected: expectedBuild,
    matchesExpected: expectedBuild === undefined ? null : identity.size === expectedBuild.size && identity.mtime === expectedBuild.mtime,
  }, null, 2))
  await mark("launch", async () => {
    const owned = await waitFor(async () => {
      try {
        const result = await ownedV3CdpEndpoint(profile, pid, executable)
        endpoint = result.endpoint
        return true
      } catch { return false }
    }).then(() => endpoint)
    if (!owned) throw new Error("Owned CDP endpoint missing.")
  })
  const session = `ruler-r17-${crypto.randomUUID()}`
  await browserCommand(session, ["connect", endpoint!])
  const tabs = await browserCommand(session, ["tab"])
  targetId = electronRendererTarget(tabs)?.targetId ?? tabs.match(/\[(t\d+)\]/)?.[1]
  if (!targetId) throw new Error(`Packaged renderer missing: ${tabs}`)
  cdp = await cdpConnect(endpoint!)
  await cdp.call("Page.enable")
  await cdp.call("Runtime.enable")
  if (!electronRendererTarget(tabs)) {
    await cdp.call("Page.navigate", { url: "daw://app/?dashboard=projects" })
    await waitFor(async () => String(await cdpEval(cdp!, "location.href")).startsWith("daw://app/"))
  }
  if (process.env.DAW_STOP_HUNT === "1") await mark("stop-timeout-hunt", async () => {
    await waitFor(async () => Boolean(await cdpEval(cdp!, `[...document.querySelectorAll('button')].some(b => b.textContent?.trim() === "New project")`)))
    const cycles: JsonValue[] = []
    const returnToDashboard = async () => {
      if (await cdpEval(cdp!, `[...document.querySelectorAll('button')].some(b => b.textContent?.trim() === "New project")`) === true) return
      const menu = Bun.spawn(["osascript", "-e", `tell application "System Events" to tell (first process whose unix id is ${pid}) to click menu item "Open Projects Dashboard" of menu 1 of menu bar item "File" of menu bar 1`], {
        stdout: "pipe", stderr: "pipe",
      })
      const [menuError] = await Promise.all([new Response(menu.stderr).text(), new Response(menu.stdout).text(), menu.exited])
      if (menu.exitCode !== 0) throw new Error(`Native File > Open Projects Dashboard failed: ${menuError.trim()}`)
      await waitFor(async () => Boolean(await cdpEval(cdp!, `[...document.querySelectorAll('button')].some(b => b.textContent?.trim() === "New project")`)))
    }
    const createFromDashboard = async (cycle: number) => {
      const startedAt = new Date().toISOString()
      const page = await cdpEval(cdp!, `(()=>({url:location.href, buttons:[...document.querySelectorAll('button')].map(b=>b.textContent?.trim()).filter(Boolean)}))()`)
      await appendFile(path.join(output, "phases.jsonl"), `${JSON.stringify({ event: "cycle", cycle, action: "new-project", at: startedAt, page })}\n`)
      await cdpEval(cdp!, `([...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='New project'))?.click()`)
      await waitFor(async () => Boolean(await cdpEval(cdp!, `document.querySelector('[data-timeline-ruler="1"]') && new URL(location.href).searchParams.get('projectId')`)))
      await pause(3_000)
      const readyAt = new Date().toISOString()
      const project = await cdpEval(cdp!, `(()=>({url:location.href, title:document.title}))()`)
      await appendFile(path.join(output, "phases.jsonl"), `${JSON.stringify({ event: "cycle", cycle, action: "timeline-ready", at: readyAt, project })}\n`)
      cycles.push({ cycle, action: "new-project", startedAt, readyAt, project })
      if ([2, 7, 12].includes(cycle)) {
        await cdpEval(cdp!, `document.querySelector('button[aria-label="Play"]')?.click()`)
        await pause(2_000)
        await appendFile(path.join(output, "phases.jsonl"), `${JSON.stringify({ event: "cycle", cycle, action: "play-2s", at: new Date().toISOString() })}\n`)
      }
      await returnToDashboard()
    }
    for (let cycle = 1; cycle <= 15; cycle += 1) {
      if (cycle === 4 || cycle === 9 || cycle === 14) {
        const openAt = new Date().toISOString()
        const firstProject = await cdpEval(cdp!, `(()=>[...document.querySelectorAll('button')].filter(b=>b.textContent?.trim()==='Open').map(b=>({name:b.textContent?.trim(),x:b.getBoundingClientRect().x,y:b.getBoundingClientRect().y}))[0]??null)()`)
        const opened = await cdpEval(cdp!, `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent?.trim()==='Open');if(!b)return false;b.click();return true})()`)
        if (opened !== true) throw new Error("Dashboard existing-project row was not available.")
        await waitFor(async () => Boolean(await cdpEval(cdp!, `document.querySelector('[data-timeline-ruler="1"]') && new URL(location.href).searchParams.get('projectId')`)))
        await pause(3_000)
        const readyAt = new Date().toISOString()
        const project = await cdpEval(cdp!, `(()=>({url:location.href,title:document.title}))()`)
        await appendFile(path.join(output, "phases.jsonl"), `${JSON.stringify({ event: "cycle", cycle, action: "open-existing-project", at: openAt, readyAt, target: firstProject, project })}\n`)
        cycles.push({ cycle, action: "open-existing-project", openAt, readyAt, project })
        await returnToDashboard()
      } else {
        await createFromDashboard(cycle)
      }
    }
    await writeFile(path.join(output, "stop-timeout-cycles.json"), JSON.stringify(cycles, null, 2))
  })
  await mark("project-creation", async () => {
    await waitFor(async () => Boolean(await cdpEval(cdp!, `document.querySelector('[data-timeline-ruler="1"]') || [...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='New project')`)))
    if (!(await cdpEval(cdp!, `new URL(location.href).searchParams.get('projectId')`))) {
    await writeFile(path.join(output, "initial-ui.json"), JSON.stringify({
      url: await cdpEval(cdp!, "location.href"),
      buttons: await cdpEval(cdp!, "[...document.querySelectorAll('button')].map(b=>b.textContent?.trim()).filter(Boolean)"),
    }, null, 2))
    await cdpEval(cdp!, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.trim()==='New project')?.click()`)
    await waitFor(async () => Boolean(await cdpEval(cdp!, `document.querySelector('[data-timeline-ruler="1"]') && new URL(location.href).searchParams.get('projectId')`)))
    }
  })
  const projectId = new URL(String(await cdpEval(cdp, "location.href"))).searchParams.get("projectId")
  if (!projectId) throw new Error("Project ID was not present after local project creation.")
  const caps = controlCapabilitiesSchemaV2.parse(await command(["capabilities-v2", "--target", "host"]))
  const required = ["track.create", "instrument.set", "clip.midi.create", "project.settings.set"]
  const absent = required.filter((kind) => !caps.actionKinds.includes(kind))
  if (absent.length) throw new Error(`Required project-control capabilities are not advertised: ${absent.join(", ")}`)
  const mutate = async (phase: string, actions: JsonValue[]) => mark(phase, async () => {
    const current = projectSnapshotSchemaV2.parse(await command(["snapshot-v2", projectId, "--target", "host"]))
    const base = { version: "v1", projectId, expectedRevision: current.revision, actions }
    const preview = controlPreviewResultSchemaV1.parse(await command(["preview", "--request", "-", "--target", "host"], base))
    const approval = preview.approval.required
      ? await command(["approval", "--request", "-", "--target", "host"], base)
      : undefined
    const idempotencyKey = `r15-${phase}-${crypto.randomUUID()}`
    const commitRequest = approval
      ? { ...base, idempotencyKey, approvalToken: z.object({ approvalToken: z.string() }).parse(approval).approvalToken }
      : { ...base, idempotencyKey }
    const commit = controlCommitResultSchemaV1.parse(await command(["commit", "--request", "-", "--target", "host"], commitRequest))
    if (!commit) throw new Error(`Commit failed: ${phase}`)
    const fresh = projectSnapshotSchemaV2.parse(await command(["snapshot-v2", projectId, "--target", "host"]))
    await writeFile(path.join(output, `${phase}-snapshot.json`), JSON.stringify(fresh, null, 2))
  })
  await mutate("track-create", [{ kind: "track.create", clientRef: "r13-track", name: "Ruler Acceptance", trackKind: "instrument" }])
  let snapshot = projectSnapshotSchemaV2.parse(await command(["snapshot-v2", projectId, "--target", "host"]))
  const track = snapshot.tracks.find((item) => item.name === "Ruler Acceptance")
  if (!track) throw new Error("Control commit did not create the instrument track.")
  await mutate("synth-create", [{ kind: "instrument.set", target: { kind: "track", track: { source: "persisted", id: track.id } }, instrumentKind: "synth" }])
  const clips = [0, 8, 16, 24, 32, 80].map((startSec, index) => ({
    kind: "clip.midi.create", track: { source: "persisted", id: track.id }, name: `R15 ${index + 1}`,
    startSec, duration: 8, wave: "sine",
    notes: [{ id: `r15-note-${index}`, beat: 0, length: startSec === 8 ? 16 : 1, pitch: 60, velocity: 0.85 }],
  }))
  await mutate("midi-clips", clips)
  snapshot = projectSnapshotSchemaV2.parse(await command(["snapshot-v2", projectId, "--target", "host"]))
  if (!snapshot.tracks.some((item) => item.id === track.id) || snapshot.clips.length < 5) throw new Error("Fresh snapshot does not confirm the acceptance project.")
  await writeFile(path.join(output, "confirmed-project.json"), JSON.stringify(snapshot, null, 2))
  await browserCommand(session, ["tab", targetId])
  await cdp.call("Page.enable")
  await cdp.call("Runtime.enable")
  await cdpEval(cdp, `(()=>{const b=document.querySelector('button[aria-label="Toggle snap to grid"]');if(b?.getAttribute('aria-pressed')==='true')b.click();return b?.getAttribute('aria-pressed')})()`)
  await cdpEval(cdp, `(()=>{const b=document.querySelector('button[aria-label="Toggle Follow"]');if(b?.getAttribute('aria-pressed')==='true')b.click();return b?.getAttribute('aria-pressed')})()`)
  // Capture actual pointer delivery, including the hit-tested element. A CDP
  // dispatch alone is not evidence that the ruler received the event.
  const installObservers = async () => cdpEval(cdp!, `(()=>{
    window.acceptancePointers=[];window.acceptanceTransitions=[];
    document.addEventListener('pointerdown',e=>window.acceptancePointers.push({at:Date.now(),x:e.clientX,y:e.clientY,target:e.target?.outerHTML?.slice(0,250),clipId:e.target?.closest('[data-timeline-clip-id]')?.getAttribute('data-timeline-clip-id'),lane:!!e.target?.matches('[data-timeline-track-lane]'),ruler:!!e.target?.closest('[data-timeline-ruler="1"]')}),true);
    let last='';
    window.acceptanceUnsubscribe=window.dawDesktop.audioHost.session.onScheduleProgress(p=>{
      const id=String(p.appliedTransportTransitionId);
      if(id===last)return;last=id;
      window.acceptanceTransitions.push({at:Date.now(),id,epoch:p.epoch,running:p.running,frame:String(p.renderedThroughFrame)});
    });
  })()`)
  await installObservers()
  const rulerGeometry = async () => z.object({
    rect: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }),
    pps: z.number().positive(), start: z.number(), scrollLeft: z.number(), anchor: z.number(), playheadX: z.number(),
  }).parse(await cdpEval(cdp!, `(()=>{
    const r=document.querySelector('[data-timeline-ruler="1"]');
    const s=document.querySelector('[data-timeline-scroll-viewport="1"]');
    if(!r||!s)throw Error('Missing ruler/viewport');
    const rect=r.getBoundingClientRect();
    // Use the rendered local left attributes, not label bounding boxes. The
    // physical scroll runway is recentered by useTimelineViewport, not time 0.
    const ticks=[...r.querySelectorAll(':scope > .absolute.bottom-0')].map(e=>({x:parseFloat(e.style.left),sec:Number(e.textContent.trim().replace(/s$/,''))})).filter(t=>Number.isFinite(t.x)&&Number.isFinite(t.sec));
    if(ticks.length<2)throw Error('Ruler has fewer than two time markers');
    const pps=(ticks[1].x-ticks[0].x)/(ticks[1].sec-ticks[0].sec);
    const start=ticks[0].sec-ticks[0].x/pps;
    const playhead=[...document.querySelectorAll('.bg-red-500.pointer-events-none')].find(e=>e.getBoundingClientRect().width<=2&&e.getBoundingClientRect().height>100);
    return {rect:rect.toJSON(),pps,start,scrollLeft:s.scrollLeft,anchor:(s.scrollWidth-s.clientWidth)/2,playheadX:playhead?playhead.getBoundingClientRect().left-rect.left:-1};
  })()`))
  const readTransport = async () => desktopTransportStatusSchemaV1.parse(await command(["host", "transport-status"]))
  const observe = async (label: string) => {
    const transport = await readTransport()
    const geometry = await rulerGeometry()
    await appendFile(samplesPath, `${JSON.stringify({ at: new Date().toISOString(), label, transport, geometry })}\n`)
    return transport
  }
  const record = async <T>(check: string, pass: boolean, evidence: T) => {
    runResults[check] = pass ? "PASS" : "FAIL"
    await appendFile(path.join(output, "assertions.jsonl"), `${JSON.stringify({ check, pass, evidence })}\n`)
    await writeFile(path.join(output, "r-checks.json"), JSON.stringify({ results: runResults }, null, 2))
  }
  const button = async (label: string) => cdpEval(cdp!, `(()=>{const b=document.querySelector('button[aria-label="${label}"]');if(!b)throw Error('Missing button: ${label}');b.click()})()`)
  const toggle = async (label: string, enabled: boolean) => cdpEval(cdp!, `(()=>{const b=document.querySelector('button[aria-label="${label}"]');if(!b)throw Error('Missing toggle: ${label}');if((b.getAttribute('aria-pressed')==='true')!==${enabled})b.click()})()`)
  const reset = async (label: string, loop = false, follow = false) => {
    await cdpEval(cdp!, `document.querySelector('button[aria-label="Stop recording"]')?.click()`)
    await cdpEval(cdp!, `[...document.querySelectorAll('button[aria-label]')].filter(b=>b.getAttribute('aria-label').startsWith('Disarm track')).forEach(b=>b.click())`)
    await button("Stop")
    await waitFor(async () => (await readTransport()).state !== "playing")
    await mutate(`reset-${label}`, [{ kind: "project.settings.set", loopEnabled: loop, loopStartSec: 0, loopEndSec: 8 }])
    await toggle("Toggle Follow", follow)
    await toggle("Toggle snap to grid", false)
    await pause(350)
    await observe(`reset-${label}`)
  }
  const play = async () => {
    await button("Play")
    await waitFor(async () => (await readTransport()).state === "playing", 5_000)
  }
  const visible = async (seconds: number) => {
    let g = await rulerGeometry()
    if(seconds < g.start || seconds >= g.start + g.rect.width/g.pps) {
      // Native scroll coordinates are a bounded runway centered at anchor.
      // Logical time changes only by the delta from that current anchor.
      const delta = (Math.max(0,seconds-g.rect.width/g.pps/2)-g.start)*g.pps
      await cdpEval(cdp!, `(()=>{const s=document.querySelector('[data-timeline-scroll-viewport="1"]');s.scrollLeft=${g.anchor}+${delta};s.dispatchEvent(new Event('scroll'))})()`)
      await pause(100)
      g = await rulerGeometry()
    }
    if(seconds<g.start-0.01 || seconds>=g.start+g.rect.width/g.pps)throw Error(`Target ${seconds} outside ruler at ${g.start}`)
    return g
  }
  const mouse = async (type: string, x: number, y: number) => cdp!.call("Input.dispatchMouseEvent", {
    type,x,y,button:"left",buttons:type === "mouseReleased" ? 0 : 1,clickCount:type === "mouseMoved" ? 0 : 1,
  })
  const rulerClick = async (seconds: number, landing = true) => {
    const g = await visible(seconds)
    const x = g.rect.left+(seconds-g.start)*g.pps
    const y = g.rect.top+g.rect.height*.75
    const hit = await cdpEval(cdp!, `!!document.elementFromPoint(${x},${y})?.closest('[data-timeline-ruler="1"]')`)
    if(hit !== true)throw Error(`Ruler target ${seconds} is occluded`)
    const at = Date.now()
    await mouse("mouseMoved",x,y)
    await mouse("mousePressed",x,y)
    await mouse("mouseReleased",x,y)
    const state = landing ? await observe(`click-${seconds}`) : undefined
    await appendFile(path.join(output,"clicks.jsonl"),`${JSON.stringify({at,targetSec:seconds,x,y,geometry:g,hit,state,elapsedMs:Date.now()-at})}\n`)
    return { state, at }
  }
  const landed = (state: Awaited<ReturnType<typeof readTransport>> | undefined, sec: number, playing: boolean) =>
    state !== undefined && (playing ? state.state === "playing" : state.state !== "playing") && Math.abs(state.playheadSec-sec)<.25
  const samples = async (label: string, ms: number) => {
    const values: Array<Awaited<ReturnType<typeof readTransport>>> = []
    const end = Date.now()+ms
    // Bounded acceptance sampling, not a product polling loop.
    while(Date.now()<end){values.push(await observe(label));await pause(100)}
    return values
  }
  const wrapped = (values: Awaited<ReturnType<typeof readTransport>>[]) => values.some((v,i)=>i>0 && values[i-1]!.playheadSec>7.5 && v.playheadSec<.5)
  const key = async (key: string, code: string, value: number) => {
    await cdp!.call("Input.dispatchKeyEvent",{type:"keyDown",key,code,windowsVirtualKeyCode:value})
    await cdp!.call("Input.dispatchKeyEvent",{type:"keyUp",key,code,windowsVirtualKeyCode:value})
  }
  const transitions = async () => z.array(z.object({at:z.number(),id:z.string(),epoch:z.number(),running:z.boolean(),frame:z.string()})).parse(await cdpEval(cdp!, 'window.acceptanceTransitions'))
  await reset("R1")
  await play()
  const forward = await rulerClick(30)
  const backward = await rulerClick(10)
  await record("R1",landed(forward.state,30,true)&&landed(backward.state,10,true),{forward,backward})

  await reset("R2")
  await rulerClick(9)
  await play()
  const meter = async () => z.array(z.number()).parse(await cdpEval(cdp!, `[...document.querySelectorAll('.track-meter-strip .bg-green-500,.track-meter-strip .bg-red-500')].map(e=>parseFloat(e.style.height)||0)`))
  await pause(350)
  const heldMeter = await meter()
  const held = await observe("R2-held-note")
  await rulerClick(70)
  await pause(500)
  const releasedMeter = await meter()
  const released = await observe("R2-released-note")
  await record("R2",held.state==="playing"&&heldMeter.some(v=>v>0)&&landed(released,70.5,true)&&releasedMeter.length>0&&releasedMeter.every(v=>v===0),{held,heldMeter,released,releasedMeter})

  await reset("R3")
  await rulerClick(15)
  const stoppedSeek = await samples("R3-stopped-seek",500)
  await record("R3",stoppedSeek.length>0&&stoppedSeek.every(v=>landed(v,15,false)),stoppedSeek)

  await reset("rapid")
  await play()
  for(const sec of [11,17,22,28,35]){await rulerClick(sec,false);await pause(80)}
  const rapid = await observe("rapid-final")
  await record("rapid",landed(rapid,35.08,true),rapid)

  await reset("R4",true)
  await play()
  const inside = await rulerClick(6)
  const loopSamples = await samples("R4-wrap",3_000)
  await record("R4",landed(inside.state,6,true)&&wrapped(loopSamples),{inside,loopSamples})

  await reset("R5",true)
  await play()
  const outside = await rulerClick(35)
  const linear = await samples("R5-linear",1_000)
  await button("Stop")
  await writeFile(path.join(output,"renderer-before-cold.json"),JSON.stringify(await cdpEval(cdp!,"({pointers:window.acceptancePointers,transitions:window.acceptanceTransitions})"),null,2))
  await cdp.call("Page.reload")
  await waitFor(async () => Boolean(await cdpEval(cdp!, `document.querySelector('button[aria-label="Play"]') && document.querySelector('[data-timeline-ruler="1"]')`)))
  await pause(500)
  await toggle("Toggle Follow",false)
  await toggle("Toggle snap to grid",false)
  await installObservers()
  const coldSeek = await rulerClick(35)
  await play()
  const cold = await samples("R5-cold",1_000)
  const settings = projectSnapshotSchemaV2.parse(await command(["snapshot-v2",projectId,"--target","host"])).project.loop
  await record("R5",landed(outside.state,35,true)&&linear.every(v=>v.state==="playing"&&v.playheadSec>34.75&&v.playheadSec<37)&&landed(coldSeek.state,35,false)&&cold.every(v=>v.state==="playing"&&v.playheadSec>=35&&v.playheadSec<37)&&settings.enabled&&settings.startSec===0&&settings.endSec===8,{outside,linear,coldSeek,cold,settings})

  await reset("R5b",true)
  await rulerClick(1)
  await play()
  const drag = async (cancel: boolean) => {
    const g = await visible(8)
    const x = g.rect.left+(8-g.start)*g.pps
    const y = g.rect.top+g.rect.height*.25
    await pause(150)
    const before = await transitions()
    await mouse("mouseMoved",x,y)
    await mouse("mousePressed",x,y)
    for(let step=1;step<=10;step++){await mouse("mouseMoved",x-step*10,y);await pause(20)}
    await pause(100)
    const during = await transitions()
    if(cancel)await key("Escape","Escape",27)
    await mouse("mouseReleased",x-100,y)
    await pause(400)
    const after = await transitions()
    const loop = projectSnapshotSchemaV2.parse(await command(["snapshot-v2",projectId,"--target","host"])).project.loop
    return {during:during.slice(before.length),release:after.slice(during.length),loop,transport:await observe(cancel?"R5b-cancel":"R5b-release")}
  }
  const canceled = await drag(true)
  const committed = await drag(false)
  const resizedSamples=await samples("R5b-resized-wrap",5_000)
  const resizedWrap=resizedSamples.some((value,index)=>index>0&&resizedSamples[index-1]!.playheadSec>6.5&&value.playheadSec<.5)
  await record("R5b",resizedWrap&&canceled.during.length===0&&canceled.release.length===0&&canceled.loop.endSec===8&&committed.during.length===0&&committed.release.length===2&&committed.release[0]?.running===false&&committed.release[1]?.running===true&&Math.abs(committed.loop.endSec-7)<.01&&committed.transport.state==="playing",{canceled,committed,resizedWrap,resizedSamples})

  await reset("R6")
  await play()
  const beforeToggle = await observe("R6-before")
  const beforeMessages = await transitions()
  const hostStops = async () => {
    const logs = await readFile(stdoutPath,"utf8")
    return logs.split(/\r?\n/).filter(line=>line.includes('[native-audio-host-control]')&&line.includes('"phase":"enqueue"')&&/"request":"(start|stop|teardown)"/.test(line))
  }
  const beforeHostStops = await hostStops()
  await button("Toggle loop region")
  await pause(300)
  const afterToggle = await observe("R6-enabled")
  await button("Toggle loop region")
  await pause(300)
  const afterDisable = await observe("R6-disabled")
  const toggleMessages = (await transitions()).slice(beforeMessages.length)
  const toggleHostStops = (await hostStops()).slice(beforeHostStops.length)
  await record("R6",toggleHostStops.length===0&&beforeToggle.state==="playing"&&afterToggle.state==="playing"&&afterDisable.state==="playing"&&afterToggle.playheadSec>beforeToggle.playheadSec&&afterDisable.playheadSec>afterToggle.playheadSec&&toggleMessages.length===4&&toggleMessages.filter(message=>message.running).length===2,{beforeToggle,afterToggle,afterDisable,toggleMessages,toggleHostStops})

  await reset("R8")
  await play()
  await pause(250)
  await button("Stop")
  // No wait between Stop dispatch and ruler pointer delivery.
  const immediate = await rulerClick(15)
  const sticking = await samples("R8-immediate-stopped-seek",500)
  const resumeAt=Date.now()
  await play()
  const resumed = await observe("R8-resumed")
  const resumeElapsedMs=Date.now()-resumeAt
  await record("R8",landed(immediate.state,15,false)&&sticking.every(v=>landed(v,15,false))&&resumed.state==="playing"&&resumed.playheadSec>=15&&resumed.playheadSec<=15+resumeElapsedMs/1000+.25,{immediate,sticking,resumed,resumeElapsedMs})

  await reset("lane-clip-space")
  await visible(2)
  await play()
  const interactionStates = []
  const interactionTransitionsBefore=await transitions()
  const interactionStopsBefore=await hostStops()
  for(const selector of [`[data-timeline-clip-id="${snapshot.clips.find(clip=>clip.name==='R15 1')?.id}"]`, '[data-timeline-track-lane]']){
    const point=z.object({x:z.number(),y:z.number()}).parse(await cdpEval(cdp!, `(()=>{
      if(${selector.includes('clip-id')}){const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.left+30,y:r.top+40}}
      const viewport=document.querySelector('[data-timeline-scroll-viewport="1"]').getBoundingClientRect();
      for(const lane of document.querySelectorAll('[data-timeline-track-lane]')){
        const r=lane.getBoundingClientRect();const y=Math.max(r.top,viewport.top)+Math.min(30,r.height/2);
        if(y>=Math.min(r.bottom,viewport.bottom))continue;
        for(let x=Math.max(r.left,viewport.left)+20;x<Math.min(r.right,viewport.right)-20;x+=30){
          const hit=document.elementFromPoint(x,y);
          if(hit===lane)return {x,y};
        }
      }
      throw Error('No visible empty lane background');
    })()`))
    const hitTarget = await cdpEval(cdp!, `(()=>{const hit=document.elementFromPoint(${point.x},${point.y});const intended=document.querySelector('${selector}');return {hit:hit?.outerHTML?.slice(0,250),intendedHit:!!intended&&!!hit&&(${selector.includes('clip-id')}?(hit===intended||intended.contains(hit)):(hit.matches('[data-timeline-track-lane]')&&!hit.closest('[data-timeline-clip-id]')&&!hit.closest('[data-timeline-ruler]')))}})()`)
    if(!hitTarget.intendedHit)throw Error(`Interaction target ${selector} was occluded: ${hitTarget.hit}`)
    const pointersBefore = await cdpEval(cdp!,"window.acceptancePointers.length")
    await mouse("mouseMoved",point.x,point.y);await mouse("mousePressed",point.x,point.y);await mouse("mouseReleased",point.x,point.y)
    const deliveredPointer = await cdpEval(cdp!, `(()=>{const event=window.acceptancePointers.slice(${pointersBefore}).find(value=>value.x===${point.x}&&value.y===${point.y});const clip=${selector.includes('clip-id')};const expectedId=clip?document.querySelector('${selector}')?.getAttribute('data-timeline-clip-id'):undefined;return {target:event?.target,intendedTarget:!!event&&(clip?event.clipId===expectedId:event.lane===true&&!event.clipId&&!event.ruler)}})()`)
    if(!deliveredPointer.intendedTarget)throw Error(`Pointer was not delivered to ${selector}: ${deliveredPointer.target}`)
    const immediateInteraction = await observe("lane-clip-immediate")
    await pause(500)
    const settledInteraction = await observe("lane-clip-settled")
    interactionStates.push(immediateInteraction,settledInteraction)
    await appendFile(path.join(output,"interaction-settlement.jsonl"),`${JSON.stringify({selector,immediateInteraction,settledInteraction})}\n`)
    await appendFile(path.join(output,"pointers.jsonl"),`${JSON.stringify({selector,point,pointers:await cdpEval(cdp!,"window.acceptancePointers")})}\n`)
  }
  const interactionTransitions=(await transitions()).slice(interactionTransitionsBefore.length)
  const interactionStops=(await hostStops()).slice(interactionStopsBefore.length)
  await key(" ","Space",32)
  await pause(150)
  const spacePaused=await observe("space-paused")
  await key(" ","Space",32)
  await pause(150)
  const spacePlaying=await observe("space-playing")
  await record("lane-clip-space",interactionStops.length===0&&interactionTransitions.every(message=>message.running)&&interactionStates.length===4&&interactionStates.every(v=>v.state==="playing")&&spacePaused.state!=="playing"&&spacePlaying.state==="playing",{interactionStates,interactionTransitions,interactionStops,spacePaused,spacePlaying})

  await reset("Follow",false,true)
  const followForward=await rulerClick(70)
  await play()
  await pause(300)
  const right=await rulerGeometry()
  const followBackward=await rulerClick(10)
  await pause(300)
  const left=await rulerGeometry()
  await record("Follow",landed(followForward.state,70,false)&&right.playheadX>=0&&right.playheadX<right.rect.width&&landed(followBackward.state,10,true)&&left.playheadX>=0&&left.playheadX<left.rect.width,{right,left,followForward,followBackward})
  await reset("R7")
  await cdpEval(cdp!, `[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label').startsWith('Arm track'))?.click()`)
  await button("Start recording")
  await pause(500)
  const recording = await cdpEval(cdp!, `!!document.querySelector('button[aria-label="Stop recording"]')`)
  const recordBefore = await observe("R7-before")
  await rulerClick(30)
  const recordAfter = await observe("R7-after")
  const stillRecording = await cdpEval(cdp!, `!!document.querySelector('button[aria-label="Stop recording"]')`)
  await record("R7",recording===true&&stillRecording===true&&recordAfter.state==="playing"&&Math.abs(recordAfter.playheadSec-30)>5,{recording,stillRecording,recordBefore,recordAfter})

  await button("Stop")

} catch (error) {
  runError = error instanceof Error ? error.message : String(error)
  for(const check of ["R1","R2","R3","rapid","R4","R5","R5b","R6","R7","R8","lane-clip-space","Follow"]){
    if(!runResults[check])runResults[check]="FAIL: not completed; see run-error.txt"
  }
  await writeFile(path.join(output, "run-error.txt"), `${runError}\n`)
} finally {
  if (cdp) {
    await writeFile(path.join(output,"renderer-evidence.json"),JSON.stringify(await cdpEval(cdp,"({pointers:window.acceptancePointers,transitions:window.acceptanceTransitions})").catch(()=>null),null,2))
    await cdp.call("Runtime.evaluate", { expression: "window.close()", returnByValue: true }).catch(() => null)
    await Promise.race([new Promise<void>((resolve) => app.once("exit", () => resolve())), pause(10_000)])
    cdp.close()
  }
  stderrFile.end()
  stdoutFile.end()
  await pause(100)
  const diagnosticText = (await (await import("node:fs/promises")).readFile(stderrPath, "utf8"))
    + "\n" + (await (await import("node:fs/promises")).readFile(stdoutPath, "utf8"))
  const diagnosticLines = diagnosticText.split(/\r?\n/)
  await writeFile(path.join(output, "diagnostic-lines.txt"), diagnosticLines.filter((line) =>
    /\[native-audio-session-stop\]|\[native-audio-host-control\]|\[native-audio-host-control-timeout\]|\[native-audio-host-stack-capture\]|\[native-audio-host-stop\]|\[native-audio-host-termination-request\]|native audio host spawned|native audio host closed/.test(line),
  ).join("\n") + "\n")
  const diagnostics = diagnosticLines.flatMap((line) => {
    const marker = line.includes("native-audio-host-termination-request") ? "teardown"
      : line.includes("native audio host spawned") ? "spawn"
        : line.includes("native audio host closed") ? "close"
          : undefined
    if (!marker) return []
    const jsonStart = line.indexOf("{")
    const data = jsonStart >= 0 ? z.record(z.string(), z.json()).safeParse(JSON.parse(line.slice(jsonStart))) : undefined
    return [{ marker, line, data: data?.success ? data.data : null }]
  })
  await writeFile(path.join(output, "host-diagnostics-extract.txt"), diagnostics.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  const build = await stat(path.join(appPath, "Contents/Resources/app.asar"))
  await writeFile(path.join(output, "build-after.json"), JSON.stringify({
    size: build.size, mtime: localTimestamp(build.mtime),
  }, null, 2))
  if (app.exitCode === null && app.signalCode === null) {
    try { process.kill(pid, "SIGTERM") } catch {}
  }
  await writePrivateArtifact(path.join(output, "run-summary.json"), JSON.stringify({
    profile, pid, endpointObserved: Boolean(endpoint), rendererObserved: Boolean(targetId), error: runError ?? null,
  }, null, 2))
  await writeFile(path.join(output, "r-checks.json"), JSON.stringify({ results: runResults }, null, 2))
}
if (runError || Object.values(runResults).some(value => value !== "PASS")) process.exitCode = 1
