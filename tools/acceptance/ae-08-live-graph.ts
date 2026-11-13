#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { createDefaultReverbParams, createDefaultSpectralParams, createDefaultUtilityParams, getSpectralLatencyFrames } from "@daw-browser/shared"
import { controlApprovalResultSchemaV1, controlCapabilitiesSchemaV2, controlCommitResultSchemaV1,
  controlPreviewResultSchemaV1, projectCurrentResultSchema, projectSnapshotSchemaV2 } from "@daw-browser/control"
import { browserCommand as browserCommandRaw } from "../performance/browser-harness"
import { createPrivateRunDirectory, electronRendererTarget } from "../performance/30-track/electron"
import { ownedV3CdpEndpoint } from "../performance/30-track/v3-import-acceptance"
import { command } from "../performance/30-track/v3-import-workload"
import { nested, waitForAcceptanceEvent } from "../performance/30-track/native-acceptance-ui"
import { analyzePhase3, analyzePhase4Campaign, analyzePhase5Campaign, analyzeRun, rawCaptureOffsetsValid } from "./analyze-ae-08-continuity"
import { buildPhase3Fixture } from "./ae-08-phase-3-fixture"
import { phase5Rows, runPhase5Fixture } from "./ae-08-phase-5-fixture"
import { phase8Rows, runPhase8Fixture } from "./ae-08-phase-8-fixture"
import { analyzePhase8Campaign } from "./analyze-ae-08-phase-8"
import { readWav, writeWav, type Pcm } from "./ae08-wav"
import { serializeNativeGraph } from "@daw-browser/audio-engine/native-host-wire"
import { audioCoreContractVersion } from "@daw-browser/audio-core-contract"

const root = path.resolve(import.meta.dir, "../..")
const app = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app")
const resources = path.join(app, "Contents/Resources")
const executable = path.join(app, "Contents/MacOS/@daw-browser-desktop")
// Bounded fixture dwell/readiness checks only. No app or audio scheduling.
const dwell = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const eventSchema = z.record(z.string(), z.json())
type Provenance = { phase: number; startedAt: string; app: string; telemetryOptIn: boolean; sourceHead: string;
  dirtyDiffSha256: string; artifacts: Record<string, string>; untrackedSourceManifestSha256?: string; fixture: string; ownedPids?: number[];
  device?: z.infer<typeof eventSchema>[]; failure?: string }
type FixtureKind = "combined" | "two-tone" | "held-note" | "reverb-tail" | "stop-restart" | "overlapping-moves" | "keep-latency-direct" | "keep-latency-group" | "product-maximum"
const phase4Fixtures: FixtureKind[] = ["two-tone", "held-note", "reverb-tail", "combined", "stop-restart",
  "overlapping-moves", "keep-latency-direct", "keep-latency-group", "product-maximum"]
const events = async (file: string) => (await readFile(file, "utf8")).split("\n").filter(Boolean)
  .map((line) => eventSchema.parse(JSON.parse(line)))
const stopOwnedProcess = async (child: ReturnType<typeof spawn>, pid: number,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>) => {
  if (child.exitCode !== null || child.signalCode !== null) return { exited: true, escalation: "none" }
  child.kill("SIGTERM")
  const graceful = await waitForAcceptanceEvent(exit, 3_000)
  if (graceful) return { exited: true, escalation: "SIGTERM" }
  child.kill("SIGKILL")
  const forced = await waitForAcceptanceEvent(exit, 3_000)
  return { exited: forced !== null, escalation: "SIGKILL" }
}

const packagedFiles = ["app.asar", "daw-audio-host-macos", "daw-vst3-worker", "daw-vst3-scanner", "daw-native-artifacts-v1.json"]
export const packagedArtifactHashes = async (directory: string) => {
  const artifacts: Record<string, string> = {}
  for (const name of packagedFiles) artifacts[name] = hash(await readFile(path.join(directory, name)))
  return artifacts
}
export const verifyPackagedArtifacts = async (directory: string, artifacts: Record<string, string>) => {
  for (const name of packagedFiles)
    if (hash(await readFile(path.join(directory, name))) !== artifacts[name])
      throw new Error(`Packaged artifact changed during acceptance: ${name}`)
}

const fixture = async (file: string, impulse: boolean, identifyContentTime = false) => {
  const sampleRate = 48000, frames = sampleRate * 30, channels = 2
  const samples = new Float32Array(frames * channels)
  for (let frame = 0; frame < frames; frame++) {
    const value = impulse ? (frame >= 24000 && (frame - 24000) % (sampleRate * 2) === 0 ? 0.25 : 0)
      : 0.08 * Math.sin(2 * Math.PI * 431 * frame / sampleRate)
        + 0.06 * Math.sin(2 * Math.PI * 997 * frame / sampleRate)
    // Keep Latency's delay search needs a unique content-time signature, not
    // pure tones that repeat exactly every second and can conceal compensation.
    const tagged = identifyContentTime ? value * (0.6 + 0.4 * Math.sin(frame * frame * 1e-9)) : value
    samples[frame * 2] = tagged; samples[frame * 2 + 1] = tagged
  }
  await writeWav(file, { sampleRate, channels, samples })
}

const run = async (out: string, edited: boolean, fixtureKind: string, phase = 1) => {
  await mkdir(out, { mode: 0o700 })
  const privateDirectory = await createPrivateRunDirectory("/tmp")
  const profile = path.join(privateDirectory, "profile")
  await mkdir(profile, { mode: 0o700 })
  // Exclusive lock is deliberately retained on failure; no other invocation can
  // attach to this disposable profile or reuse incomplete evidence.
  const lock = await open(path.join(profile, "ae08-owner.lock"), "wx", 0o600)
  await lock.writeFile(JSON.stringify({ pid: process.pid }))
  await lock.close()
  const session = `daw-30-track-electron-ae08-${crypto.randomUUID()}`
  const mark = async (event: string, fields: Record<string, string | number | boolean> = {}) =>
    appendFile(path.join(out, "actions.jsonl"), `${JSON.stringify({
      event, wallMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...fields,
    })}\n`, { mode: 0o600 })
  await writeFile(path.join(out, "host.jsonl"), "", { mode: 0o600 })
  await mark("launch", { edited, fixtureKind })
  const child = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DAW_DESKTOP_USER_DATA: profile, DAW_AE08_EVIDENCE_DIR: out,
      // The phase-3 fixture owns the singleton native session from startup; the renderer's playback never touches it.
      DAW_AE08_EXTERNAL_NATIVE_SESSION: phase === 3 ? "1" : "0" } })
  if (!child.pid) throw new Error("Owned packaged app PID unavailable")
  const pid = child.pid
  const exit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })))
  // Never retain general app stdout/stderr, which can include unrelated content.
  child.stdout?.resume(); child.stderr?.resume()
  let attached = false
  let failure: Error | undefined
  let endpoint = ""
  // Pin every invocation to the proven endpoint. A daemon/config change must
  // never silently create an unrelated blank browser in place of the DAW.
  const browserCommand = (sessionId: string, args: readonly string[]) =>
    browserCommandRaw(sessionId, ["--cdp", endpoint, ...args])
  const waitForBrowserValue = async (sessionId: string, expression: string, timeout: number) => {
    await browserCommand(sessionId, ["wait", "--fn",
      `(()=>{const value=(${expression});return value!==null&&value!==undefined})()`, "--timeout", String(timeout)])
    return browserCommand(sessionId, ["eval", `JSON.stringify(${expression})`])
  }
  try {
    // OS CDP startup file has no readiness event; bounded 30s, owned PID checked
    // by the existing packaged runner helper before every attachment.
    for (let attempt = 0; attempt < 60 && !endpoint; attempt++) {
      try { endpoint = (await ownedV3CdpEndpoint(profile, pid, executable)).endpoint }
      catch { await dwell(500) }
    }
    if (!endpoint) throw new Error("Owned packaged CDP endpoint unavailable")
    await browserCommand(session, ["tab"]); attached = true
    let target: string | undefined
    for (let attempt = 0; attempt < 30 && !target; attempt++) {
      target = electronRendererTarget(await browserCommand(session, ["tab"]))?.targetId
      if (!target) await dwell(500)
    }
    if (!target) throw new Error("Packaged renderer unavailable")
    await browserCommand(session, ["tab", target])
    await waitForBrowserValue(session, "[...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='New project')?true:null", 60000)
    await browserCommand(session, ["find", "role", "button", "click", "--name", "New project"])
    const projectId = z.string().parse(nested(await waitForBrowserValue(session,
      "new URL(location.href).searchParams.get('projectId')&&document.querySelector('[data-timeline-ruler=\"1\"]')?new URL(location.href).searchParams.get('projectId'):null", 60000)))
    const current = projectCurrentResultSchema.parse(await command(profile, ["project", "current", "--target", "host"]))
    if (current.status !== "present" || current.project.projectId !== projectId) throw new Error("Mounted project ownership mismatch")
    if (phase === 2 && edited) {
      // Acceptance-only consumer of the normal typed session bridge. This
      // disposable empty graph never enters production playback/edit routing.
      const graph = serializeNativeGraph({ version: audioCoreContractVersion, revision: 1,
        contractHash: "", masterNodeId: "master", assets: [], edges: [],
        nodes: [{ id: "master", kind: "master", inputLayout: "stereo", outputLayout: "stereo",
          processorOrder: [], latencyFrames: 0 }] })
      const result = nested(await browserCommand(session, ["eval", `(async()=>{
        const host=window.dawDesktop.audioHost, session=host.session, projectId=${JSON.stringify(projectId)};
        const check=reply=>{if(!reply.ok)throw new Error(reply.error);return reply};
        const bytes=new Uint8Array(${JSON.stringify([...graph])});
        const device=check(await host.resolveOutputDevice()).device;
        if(!device)throw new Error("No native output device");
        const transaction=check(await session.beginTransaction()).transactionToken;
        check(await session.configure({deviceId:device.deviceId,sampleRateHz:48000,
          maxFramesPerBlock:512,channelCount:2,revision:1},transaction));
        check(await session.publishGraph(bytes,transaction));
        check(await session.setTransport({epoch:1,running:false,frame:0},transaction));
        check(await session.commitTransaction(transaction));
        const revisions=session.revisions;
        const deniedOwner=await revisions.prepare({projectId:"local_ae08-other-project",bytes,projectRevision:10});
        const first=check(await revisions.prepare({projectId,bytes,projectRevision:10}));
        const input=value=>({projectId,revision:value.revision.requestedRevision,hostGeneration:value.hostGeneration});
        const rollback=check(await revisions.rollback(input(first)));
        const second=check(await revisions.prepare({projectId,bytes,projectRevision:9}));
        const published=check(await revisions.publish(input(second)));
        const inspected=check(await revisions.inspect(input(second)));
        const deniedGeneration=await revisions.inspect({...input(second),hostGeneration:second.hostGeneration+1});
        const deniedRollback=check(await revisions.rollback(input(second)));
        const retired=check(await revisions.retire({...input(second),revision:published.revision.retiredRevision||1}));
        if(first.hostPid!==second.hostPid||second.hostPid!==published.hostPid||published.hostPid!==inspected.hostPid
          ||first.hostGeneration!==inspected.hostGeneration
          ||second.revision.requestedRevision<=first.revision.requestedRevision
          ||inspected.revision.activeRevision!==second.revision.requestedRevision
          ||inspected.revision.status!=="published"||deniedRollback.revision.status!=="stale-revision"
          ||deniedOwner.ok||deniedGeneration.ok||rollback.revision.status!=="rolled-back"
          ||retired.revision.status!=="retired")
          throw new Error("Native revision roundtrip identity/publication mismatch");
        const result={first,rollback,second,published,inspected,deniedRollback,retired,deniedOwner,deniedGeneration};
        check(await session.teardown("acceptance-complete"));
        return JSON.stringify(result,(_,value)=>typeof value==="bigint"?value.toString():value);
      })()`]))
      const roundtrip = eventSchema.parse(result)
      await writeFile(path.join(out, "revision-roundtrip.json"), JSON.stringify(roundtrip, null, 2))
      await mark("revision-roundtrip-pass")
    }
    // Acceptance-only graph on the typed session bridge (no UI, no native-frame bypass). The app is launched with the
    // singleton session left to this fixture; edits publish whole revisions. A failed configure or teardown fails the run.
    const internalFixture = async () => {
      const plan = buildPhase3Fixture()
      const script = `(async()=>{
        const host=window.dawDesktop.audioHost, session=host.session, projectId=${JSON.stringify(projectId)};
        const check=reply=>{if(!reply.ok)throw new Error(reply.error);return reply};
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const bytes=value=>new Uint8Array(value);
        const revisions=${JSON.stringify(plan.revisions.map((revision) => [...revision]))};
        const device=check(await host.resolveOutputDevice()).device;
        if(!device)throw new Error("No native output device");
        const transaction=check(await session.beginTransaction()).transactionToken;
        check(await session.configure({deviceId:device.deviceId,sampleRateHz:48000,maxFramesPerBlock:512,channelCount:2,revision:1},transaction));
        check(await session.publishGraph(bytes(revisions[0]),transaction));
        check(await session.configureInstrumentStates(bytes(${JSON.stringify([...plan.instrumentStates])}),transaction));
        check(await session.setTransport({epoch:1,running:false,frame:0},transaction));
        check(await session.commitTransaction(transaction));
        check(await session.start());
        check(await session.setTransport({epoch:1,running:true,frame:0}));
        await wait(250);
        check(await session.queueInstrumentEvents(bytes(${JSON.stringify([...plan.noteOn])})));
        const noteOnWallMs=Date.now(), edits=[];
        const input=value=>({projectId,revision:value.revision.requestedRevision,hostGeneration:value.hostGeneration});
        // Phase 4 made publication asynchronous. Reconcile on callback progress
        // with a bounded failure deadline; never treat publish-pending as success.
        const settle=async(value,operation,expected)=>{
          const deadline=Date.now()+5000;
          for(;;){
            let unsubscribe, timer;
            const progress=new Promise(resolve=>{
              unsubscribe=session.onScheduleProgress(resolve);
              timer=setTimeout(resolve,Math.max(0,deadline-Date.now()));
            });
            try{
              const reply=check(await operation(input(value)));
              if(reply.revision.status===expected)return reply;
              if(!["publish-pending","retirement-not-safe"].includes(reply.revision.status))
                throw new Error("Unexpected revision status: "+reply.revision.status);
              if(Date.now()>=deadline)throw new Error("Revision settlement deadline exceeded");
              await progress;
            }finally{unsubscribe();clearTimeout(timer)}
          }
        };
        const names=${JSON.stringify(edited ? ["add-connected-node", "remove-connected-node", "delete-sounding-source"] : [])};
        for(const [index,name] of names.entries()){
          await wait(Math.max(0,noteOnWallMs+[1000,2500,4000][index]-Date.now()));
          const prepared=check(await session.revisions.prepare({projectId,bytes:bytes(revisions[index+1]),projectRevision:10+index}));
          const requested=check(await session.revisions.publish(input(prepared)));
          const published=await settle(requested,value=>session.revisions.inspect(value),"published");
          const publishWallMs=Date.now();
          const retiredRevision=published.revision.retiredRevision;
          if(!retiredRevision)throw new Error("Published revision has no retired predecessor");
          const retired=await settle({...published,revision:{requestedRevision:retiredRevision}},
            value=>session.revisions.retire(value),"retired");
          edits.push({name,publishWallMs,prepared,published,retired});
        }
        await wait(Math.max(0,noteOnWallMs+6500-Date.now()));
        check(await session.stop("acceptance-complete"));
        check(await session.teardown("acceptance-complete"));
        return JSON.stringify({noteOnWallMs,edits},(_,value)=>typeof value==="bigint"?value.toString():value);
      })()`
      const result = nested(await browserCommand(session, ["eval", script]))
      await writeFile(path.join(out, "phase3-edits.json"), JSON.stringify(eventSchema.parse(result), null, 2))
    }
    // Each phase-3 run is a fresh app: the captured interval brackets the whole fixture.
    if (phase === 3) {
      await mark("capture-start")
      await internalFixture()
      await mark("capture-end")
      await dwell(500)
    } else {
      const capabilities = controlCapabilitiesSchemaV2.parse(await command(profile, ["capabilities-v2", "--target", "host"]))
      const snapshot = async () => projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
      const mutate = async (actions: z.infer<ReturnType<typeof z.json>>[]) => {
        const state = await snapshot()
        const request = { version: "v1", projectId, expectedRevision: state.project.revision, actions }
        for (const action of actions) {
          const parsed = z.object({ kind: z.string() }).parse(action)
          if (!capabilities.actionKinds.some((kind) => kind === parsed.kind)) throw new Error(`Action not advertised: ${parsed.kind}`)
        }
        const payload = JSON.stringify(request)
        const preview = controlPreviewResultSchemaV1.parse(await command(profile, ["preview", "--request", "-", "--target", "host"], payload))
        const approvalToken = preview.approval?.required
          ? controlApprovalResultSchemaV1.parse(await command(profile, ["approval", "--request", "-", "--target", "host"], payload)).approvalToken : undefined
        const committed = controlCommitResultSchemaV1.parse(await command(profile, ["commit", "--request", "-", "--target", "host"],
          JSON.stringify({ ...request, approvalToken, idempotencyKey: `ae08-${crypto.randomUUID()}` })))
        await snapshot()
        return committed
      }
      if (phase === 5 || phase === 8) {
        await (phase === 5 ? runPhase5Fixture : runPhase8Fixture)({ out, profile, row: fixtureKind, snapshot, mark,
          mutate: async (actions) => { await mutate(actions) },
          interact: async (args) => { await browserCommand(session, args) },
          evaluate: async (script) => { await browserCommand(session, ["eval", script]) },
          read: async (script, schema) => schema.parse(nested(await browserCommand(session, ["eval", script]))),
          reload: async () => {
            await browserCommand(session, ["reload"])
            await waitForBrowserValue(session, "document.querySelector('[data-timeline-ruler=\"1\"]')?true:null", 30000)
          } })
      } else {
      const toneFile = path.join(out, "two-tone.wav"), impulseFile = path.join(out, "impulse.wav")
      await fixture(toneFile, false, fixtureKind === "keep-latency-direct" || fixtureKind === "keep-latency-group")
      await fixture(impulseFile, true)
      await command(profile, ["host", "import", "--path", toneFile])
      await waitForBrowserValue(session, "document.body.textContent?.includes('two-tone')?true:null", 60000)
      let state = await snapshot()
      const tone = state.clips.find((clip) => clip.name.includes("two-tone"))
      if (!tone) throw new Error("Imported two-tone fixture absent")
      const toneTrack = state.tracks.find((track) => track.id === tone.trackId)
      if (!toneTrack) throw new Error("Two-tone track absent")
      await mutate([{ kind: "track.create", name: "Held synth", trackKind: "instrument" }])
      state = await snapshot()
      const synth = state.tracks.find((track) => track.name === "Held synth")
      if (!synth) throw new Error("Held synth track absent")
      await mutate([
        { kind: "instrument.set", target: { kind: "track", track: { source: "persisted", id: synth.id } }, instrumentKind: "synth" },
        { kind: "clip.midi.create", track: { source: "persisted", id: synth.id }, name: "Held note", startSec: 0, duration: 30,
          wave: "sine", gain: 0.12, notes: [{ id: "ae08-held", beat: 0, length: 60, pitch: 69, velocity: 0.3 }] },
      ])
      await mutate([{ kind: "track.create", name: "Long reverb", trackKind: "audio" }])
      await browserCommand(session, ["eval", "(()=>{const b=[...document.querySelectorAll('button[aria-label]')].find(b=>b.getAttribute('aria-label')?.endsWith(': Long reverb'));if(!b)throw new Error('Reverb track selector missing');b.click();return true})()"])
      await writeFile(path.join(out, "impulse-import.json"), JSON.stringify(await command(profile, ["host", "import", "--path", impulseFile]), null, 2))
      await waitForBrowserValue(session, "document.body.textContent?.includes('impulse')?true:null", 60000)
      state = await snapshot()
      const impulse = state.clips.find((clip) => clip.name.includes("impulse"))
      if (!impulse) throw new Error("Impulse fixture absent")
      await mutate([{ kind: "effect.upsert", target: { kind: "track", track: { source: "persisted", id: impulse.trackId } },
        effectKind: "reverb", params: { ...createDefaultReverbParams(), enabled: true, wet: 1, decaySec: 12 } }])
      if (phase === 4) {
        // Channel isolation gives the unchanged left path an exact null oracle,
        // while the right channel carries actual audio through the edited FFT.
        // Only canonical project control and ordinary UI controls mutate state.
        await mutate([{ kind: "track.create", name: "Latency edit", trackKind: "audio" }])
        state = await snapshot()
        const latencyTrack = state.tracks.find((track) => track.name === "Latency edit")
        if (!latencyTrack) throw new Error("Latency fixture track absent")
        if (!tone.source) throw new Error("Latency input asset missing")
        await mutate([{ kind: "clip.audio.create", track: { source: "persisted", id: latencyTrack.id },
          asset: { source: "persisted", id: tone.source.assetId }, name: "Audible FFT input", startSec: 0, duration: 30, gain: 0.4 }])
        const target = { kind: "track", track: { source: "persisted", id: latencyTrack.id } }
        if (fixtureKind === "overlapping-moves") await mutate([{ kind: "effect.upsert", target, clientRef: "overlap-first",
          effectKind: "spectral", params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512 } } }])
        if (fixtureKind === "product-maximum") {
          // 15 fixed 4096-frame stages plus the edited 512→4096 stage:
          // one supported built-in chain reaches the exact 65,536-frame bound.
          for (let stage = 0; stage < 15; stage++) await mutate([{ kind: "effect.upsert", target, clientRef: `maximum-stage-${stage}`,
            effectKind: "spectral", params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 4096 } } }])
        }
        await mutate([{ kind: "effect.upsert", target, clientRef: "latency-edited-stage",
          effectKind: "spectral", params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 512,
            mix: fixtureKind === "stop-restart" ? 0 : 1 } } },
          { kind: "effect.upsert", target, effectKind: "utility",
            params: { version: 1, state: { ...createDefaultUtilityParams(), balance: 1 } } }])
        let latencyGroupId: string | undefined
        if (fixtureKind === "keep-latency-group") {
          await mutate([{ kind: "track.create", name: "Keep Latency group", channelRole: "group", trackKind: "audio" }])
          state = await snapshot()
          latencyGroupId = state.tracks.find((track) => track.name === "Keep Latency group")?.id
          if (!latencyGroupId) throw new Error("Keep Latency group absent")
          await mutate([{ kind: "track.routing.set", track: { source: "persisted", id: latencyTrack.id },
            output: { source: "persisted", id: latencyGroupId } }])
        }
        const retainedId = fixtureKind === "two-tone" ? tone.trackId : fixtureKind === "held-note" ? synth.id : impulse.trackId
        state = await snapshot()
        const retainedIds = fixtureKind === "combined" ? new Set([tone.trackId, synth.id, impulse.trackId])
          : new Set([["stop-restart", "overlapping-moves", "keep-latency-direct", "keep-latency-group", "product-maximum"].includes(fixtureKind) ? tone.trackId : retainedId])
        await mutate(state.tracks.map((track) => ({ kind: "track.mix.set",
          track: { source: "persisted", id: track.id }, muted: !retainedIds.has(track.id)
            && track.id !== latencyTrack.id && track.id !== latencyGroupId })))
        for (const id of retainedIds) await mutate([{ kind: "effect.upsert",
          target: { kind: "track", track: { source: "persisted", id } }, effectKind: "utility",
          params: { version: 1, state: { ...createDefaultUtilityParams(), balance: -1 } } }])
        const index = state.tracks.findIndex((track) => track.id === latencyTrack.id)
        await browserCommand(session, ["eval", `(()=>{
          const button=document.querySelector(${JSON.stringify(`button[aria-label="Select track ${index + 1}: Latency edit"]`)});
          if(!button)throw new Error("Latency track selector missing");button.click();return true;
        })()`])
        await waitForBrowserValue(session, "document.querySelector('.device-spectral')?true:null", 30000)
        if (fixtureKind === "keep-latency-direct" || fixtureKind === "keep-latency-group") {
          await browserCommand(session, ["eval", `(()=>{
            const button=document.querySelector(${JSON.stringify(`button[aria-label="Arm track ${index + 1} for recording"]`)});
            if(!button)throw new Error("Record arm unavailable");button.click();return true;
          })()`])
          await waitForBrowserValue(session, `document.querySelector(${JSON.stringify(`button[aria-label="Disarm track ${index + 1} for recording"]`)})?.getAttribute('aria-pressed')==='true'?true:null`, 15000)
        }
        await writeFile(path.join(out, "fixture-snapshot.json"), JSON.stringify(await snapshot(), null, 2))
        await browserCommand(session, ["screenshot", path.join(out, "fixture.png")])
        await command(profile, ["host", "seek", "0"])
        await mark("capture-start")
        await command(profile, ["host", "play"])
        const edits: { name: string; fromLatencyFrames: number; toLatencyFrames: number; wallMs: number }[] = []
        await dwell(3000)
        if (edited) {
          const changeFft = async (name: string, fftSize: 512 | 2048 | 4096, fromFftSize: 512 | 2048 | 4096, deviceIndex = -1) => {
            const wallMs = Date.now()
            await mark("latency-edit", { name, fftSize })
            await browserCommand(session, ["eval", `(()=>{
              const device=[...document.querySelectorAll('.device-spectral')].at(${deviceIndex});
              const button=[...(device?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim()===${JSON.stringify(String(fftSize))});
              if(!button||button.disabled)throw new Error("FFT button unavailable");button.click();return true;
            })()`])
            await waitForBrowserValue(session, `(()=>{
              const device=[...document.querySelectorAll('.device-spectral')].at(${deviceIndex});
              const button=[...(device?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim()===${JSON.stringify(String(fftSize))});
              return button?.getAttribute('aria-pressed')==='true'?true:null;
            })()`, 15000)
            const baseLatency = fixtureKind === "product-maximum" ? 15 * 4096
              : fixtureKind === "overlapping-moves" ? (deviceIndex === 0 ? 512 : 2048) : 0
            edits.push({ name, fromLatencyFrames: baseLatency + getSpectralLatencyFrames(fromFftSize, 4),
              toLatencyFrames: baseLatency + getSpectralLatencyFrames(fftSize, 4), wallMs })
            await snapshot()
            await browserCommand(session, ["screenshot", path.join(out, `${name}.png`)])
          }
          if (fixtureKind === "overlapping-moves") {
            // Distinct processors prevent same-instance coalescing. Both UI
            // intents enter in one renderer turn, before either move completes.
            const wallMs = Date.now()
            await mark("latency-edit", { name: "overlapping-raises" })
            await browserCommand(session, ["eval", `(()=>{
              const devices=[...document.querySelectorAll('.device-spectral')];
              for(const [index,size] of [[0,2048],[1,4096]]){
                const button=[...(devices[index]?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim()===String(size));
                if(!button||button.disabled)throw new Error("Overlap FFT control missing");button.click();
              }
              return true;
            })()`])
            edits.push({ name: "latency-raise", fromLatencyFrames: 1024, toLatencyFrames: 2560, wallMs },
              { name: "latency-raise-overlap", fromLatencyFrames: 2560, toLatencyFrames: 6144, wallMs })
          } else await changeFft("latency-raise", 4096, 512)
          await dwell(3000)
          await changeFft("latency-lower", 512, 4096)
          if (fixtureKind === "overlapping-moves") {
            await dwell(1000)
            await changeFft("latency-lower", 512, 2048, 0)
          }
        } else await dwell(3000)
        await dwell(4000)
        await mark("capture-end")
        await writeFile(path.join(out, "phase4-edits.json"), JSON.stringify({ phase: 4, fixtureKind, edits }, null, 2))
        await writeFile(path.join(out, "diagnostics-active.json"),
          JSON.stringify(await command(profile, ["host", "diagnostics-v2"]), null, 2))
        await command(profile, ["host", "stop"])
        if (fixtureKind === "stop-restart") {
          await mark("shrink-stop")
          await command(profile, ["host", "seek", "0"])
          await mark("restart-capture-start")
          await command(profile, ["host", "play"])
          await dwell(3000)
          await mark("restart-capture-end")
          await command(profile, ["host", "stop"])
        }
      } else {
      await mutate([{ kind: "track.create", name: "Sacrificial wet", trackKind: "audio" },
        { kind: "track.create", name: "Trusted VST", trackKind: "audio" }])
      state = await snapshot()
      const sacrificial = state.tracks.find((track) => track.name === "Sacrificial wet")
      const vstTrack = state.tracks.find((track) => track.name === "Trusted VST")
      if (!sacrificial || !vstTrack || !impulse.source) throw new Error("Wet/VST fixtures missing")
      await mutate([
        { kind: "clip.audio.create", track: { source: "persisted", id: sacrificial.id },
          asset: { source: "persisted", id: impulse.source.assetId }, name: "Sacrificial impulse", startSec: 0, duration: 30 },
        { kind: "clip.audio.create", track: { source: "persisted", id: vstTrack.id },
          asset: { source: "persisted", id: impulse.source.assetId }, name: "Trusted VST impulse", startSec: 0, duration: 30, gain: 0.2 },
        { kind: "effect.upsert", target: { kind: "track", track: { source: "persisted", id: sacrificial.id } },
          effectKind: "reverb", params: { ...createDefaultReverbParams(), enabled: true, wet: 1, decaySec: 12 } },
      ])
      // Product trust/scan/insertion UI, preserving all native trust/preflight gates.
      await browserCommand(session, ["eval", "(()=>{const url=new URL(location.href);url.searchParams.set('dashboard','plugins');history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));return true})()"])
      await waitForBrowserValue(session, "document.body.textContent?.includes('VST3 Plug-ins')?true:null", 30000)
      await browserCommand(session, ["eval", "(()=>{const input=document.querySelector('input[type=checkbox]');if(!(input instanceof HTMLInputElement))throw new Error('Trust acknowledgement unavailable');input.click();return true})()"])
      await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[role=\"dialog\"] *')].find(e=>e.textContent?.trim()==='Catalog scan');return row?.parentElement?.textContent?.match(/[1-9]\\d* VST3 bundles? discovered/)?true:null})()", 60000)
      await browserCommand(session, ["press", "Escape"])
      await waitForBrowserValue(session, "document.querySelector('[data-timeline-left-browser=\"1\"]')?true:null", 30000)
      state = await snapshot()
      const vstIndex = state.tracks.findIndex((track) => track.id === vstTrack.id)
      await browserCommand(session, ["eval", `(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="Select track ${vstIndex + 1}: ${vstTrack.name}"]`)});if(!button)throw new Error('Fixture track selector missing');button.click();return true})()`])
      await browserCommand(session, ["click", "[data-timeline-left-browser='1'] > div:first-child button:nth-child(2)"])
      // Reload through the product before capture. The current packaged browser
      // model persists tab changes but can leave the displayed tree stale.
      await browserCommand(session, ["reload"])
      await waitForBrowserValue(session, "document.querySelector('[data-timeline-ruler=\"1\"]')?true:null", 30000)
      await waitForBrowserValue(session, "document.querySelector('[data-timeline-left-browser=\"1\"] input[type=\"search\"]')?.getAttribute('placeholder')==='Search effects'?true:null", 15000)
      await browserCommand(session, ["eval", `(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="Select track ${vstIndex + 1}: ${vstTrack.name}"]`)});if(!button)throw new Error('VST selector missing after reload');button.click();return true})()`])
      await waitForBrowserValue(session, "(()=>{const b=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find(b=>b.textContent?.trim()==='ValhallaSupermassive');return b&&!b.disabled?true:null})()", 60000)
      await browserCommand(session, ["eval", "(()=>{const b=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find(b=>b.textContent?.trim()==='ValhallaSupermassive');if(!b)throw new Error('Trusted plugin missing');b.click();return true})()"])
      await waitForBrowserValue(session, "(()=>{const b=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find(b=>b.textContent?.trim()==='ValhallaSupermassive');return b?.getAttribute('aria-description')?.includes('Enabled · Preflight passed')?true:null})()", 60000)
      if (fixtureKind !== "combined") {
        const retainedId = fixtureKind === "two-tone" ? tone.trackId : fixtureKind === "held-note" ? synth.id : impulse.trackId
        state = await snapshot()
        await mutate(state.tracks.map((track) => ({ kind: "track.mix.set", track: { source: "persisted", id: track.id },
          muted: track.id !== retainedId })))
      }
      await writeFile(path.join(out, "fixture-snapshot.json"), JSON.stringify(await snapshot(), null, 2))
      await browserCommand(session, ["screenshot", path.join(out, "fixture.png")])
      const edit = async (operation: string, playing: boolean, perform: () => Promise<string | void>) => {
        const id = crypto.randomUUID()
        await mark("edit-start", { id, operation, playing })
        await perform()
        await dwell(1500)
        await writeFile(path.join(out, `diagnostics-${id}.json`), JSON.stringify(await command(profile, ["host", "diagnostics-v2"]), null, 2))
        await mark("edit-end", { id, operation, playing })
      }
      const addDeleteUndo = async (playing: boolean) => {
        const before = await snapshot()
        await edit("add-track", playing, () => browserCommand(session, ["eval",
          "(()=>{document.activeElement?.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'T',code:'KeyT',shiftKey:true,bubbles:true}));return true})()"]))
        const added = (await snapshot()).tracks.filter((track) => !before.tracks.some((old) => old.id === track.id))
        if (added.length !== 1 || !added[0]) throw new Error("UI add-track did not create exactly one track")
        const wet = (await snapshot()).tracks.find((track) => track.name === "Sacrificial wet")
        if (!wet) throw new Error("Sacrificial wet track absent before delete")
        const id = wet.id
        await edit("delete-track", playing, async () => {
          const fresh = await snapshot(), index = fresh.tracks.findIndex((track) => track.id === id)
          const name = `Select track ${index + 1}: ${wet.name}`
          await browserCommand(session, ["eval", `(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="${name}"]`)});if(!button)throw new Error('Track selector missing');button.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:250,clientY:250}));return true})()`])
          await browserCommand(session, ["find", "text", "Delete track", "click", "--exact"])
          const dialog = nested(await browserCommand(session, ["eval", "Boolean(document.querySelector('[role=\"dialog\"]'))"]))
          if (dialog) await browserCommand(session, ["find", "role", "button", "click", "--name", "Delete Track", "--exact"])
        })
        if ((await snapshot()).tracks.some((track) => track.id === id)) throw new Error("UI delete-track failed")
        await edit("undo-delete", playing, () => browserCommand(session, ["eval",
          "(()=>{document.activeElement?.blur();window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true}));return true})()"]))
        if ((await snapshot()).tracks.length !== before.tracks.length + 1) throw new Error("UI undo-delete failed")
        await browserCommand(session, ["screenshot", path.join(out, playing ? "playing-edits.png" : "paused-edits.png")])
      }
      if (edited) await addDeleteUndo(false)
      await command(profile, ["host", "seek", "0"])
      await mark("capture-start")
      const captureStarted = performance.now()
      await command(profile, ["host", "play"])
      await dwell(3000)
      if (edited) await addDeleteUndo(true)
      await dwell(Math.max(2000, 16000 - (performance.now() - captureStarted)))
      await mark("capture-end")
      await writeFile(path.join(out, "diagnostics-active.json"), JSON.stringify(await command(profile, ["host", "diagnostics-v2"]), null, 2))
      await command(profile, ["host", "stop"])
      await writeFile(path.join(out, "diagnostics-final.json"), JSON.stringify(await command(profile, ["host", "diagnostics-v2"]), null, 2))
      await browserCommand(session, ["screenshot", path.join(out, "final.png")])
      }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
    if (attached) {
      await browserCommand(session, ["screenshot", path.join(out, "failure.png")]).catch(() => undefined)
      await writeFile(path.join(out, "failure-ui.txt"),
        await browserCommand(session, ["eval", "document.body.innerText"]).catch(() => "unavailable"))
    }
    await mark("harness-failure", { message: error instanceof Error ? error.message : String(error) })
  } finally {
    if (attached) {
      await mark("quit-request", { cause: "normal-window-close" })
      await browserCommand(session, ["eval", "window.close()"]).catch(() => undefined)
      const normal = await waitForAcceptanceEvent(exit, 20000)
      await mark("normal-quit", { completed: normal !== null })
      if (!normal && !failure) failure = new Error(`Owned app ${pid} did not quit normally`)
      await browserCommandRaw(session, ["close"]).catch(() => undefined)
    }
    if (child.exitCode === null && child.signalCode === null) {
      const shutdown = await stopOwnedProcess(child, pid, exit)
      await mark(shutdown.exited ? "owned-process-stopped" : "owned-process-survived",
        { pid, escalation: shutdown.escalation })
      if (!shutdown.exited && !failure)
        failure = new Error(`Owned packaged app ${pid} survived bounded SIGTERM/SIGKILL cleanup`)
      else if (!shutdown.exited)
        failure = new Error(`${failure.message}; owned packaged app ${pid} survived bounded SIGTERM/SIGKILL cleanup`)
    }
  }
  const native = (await readdir(out)).filter((name) => /^native-\d+\.jsonl$/.test(name))
  for (const file of native) await appendFile(path.join(out, "host.jsonl"), await readFile(path.join(out, file)))
  const records = await events(path.join(out, "host.jsonl"))
  const quit = (await events(path.join(out, "actions.jsonl"))).find((entry) => entry.event === "quit-request")
  for (const entry of records) {
    if (entry.event === "host-exit" && quit && Number(entry.wallMs) >= Number(quit.wallMs)) {
      entry.requestCause = entry.cause ?? null
      entry.cause = "quit"
    }
  }
  records.sort((left, right) => Number(left.wallMs) - Number(right.wallMs))
  await writeFile(path.join(out, "host.jsonl"), records.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  await writeFile(path.join(out, "revisions.jsonl"), records.filter((entry) => String(entry.event).startsWith("graph-"))
    .map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  if (failure) throw failure
  return { out, pid, profile, records }
}

// Preserve wall-clock holes between proven live capture segments. No offline
// export, interpolation, or stretching of surviving audio to conceal restarts.
const assemble = async (directory: string, prefix = ""): Promise<Pcm> => {
  const actions = await events(path.join(directory, "actions.jsonl"))
  const records = await events(path.join(directory, "host.jsonl"))
  const start = actions.find((entry) => entry.event === `${prefix}capture-start`)
  const end = actions.find((entry) => entry.event === `${prefix}capture-end`)
  if (!start || !end) throw new Error("Capture interval missing")
  const sampleRate = 48000, channels = 2
  const frames = Math.round((Number(end.wallMs) - Number(start.wallMs)) * sampleRate / 1000)
  const samples = new Float32Array(frames * channels)
  let capturedFrames = 0
  const segments: { pid: z.infer<ReturnType<typeof z.json>>; captureId: z.infer<ReturnType<typeof z.json>>;
    sourceFrame: number; outputFrame: number; frames: number; originWallMs: number }[] = []
  for (const entry of records.filter((record) => record.event === "capture-first-drain")) {
    const blocks = records.filter((block) => block.event === "capture-block" && block.pid === entry.pid && block.captureId === entry.captureId)
      .sort((left, right) => Number(left.offset) - Number(right.offset))
    if (!blocks.length) throw new Error("Capture block timestamps missing")
    const lastBlock = blocks.at(-1)
    if (!lastBlock) continue
    const lastCallbackWall = Number(lastBlock.wallMs)
      + (Number(lastBlock.callbackMonotonicNs) - Number(lastBlock.monotonicNs)) / 1e6
    // Superseded fixture-start hosts can be terminated before a capture exists.
    // They are retained as lifecycle evidence, never spliced into measured PCM.
    if (lastCallbackWall + Number(lastBlock.frames) / sampleRate * 1000 < Number(start.wallMs)
      || Number(entry.wallMs) > Number(end.wallMs)) continue
    const file = path.join(directory, `output-${entry.pid}-${entry.captureId}.wav`)
    const pcm = await readWav(file)
    if (pcm.sampleRate !== sampleRate || pcm.channels !== channels) throw new Error("Unexpected live capture format")
    const completion = records.find((record) => record.event === "capture-complete"
      && record.pid === entry.pid && record.captureId === entry.captureId)
    if (!rawCaptureOffsetsValid(blocks, pcm.samples.length / channels, completion))
      throw new Error("Capture block offsets are noncontiguous or disagree with WAV/completion frame counts")
    let sourceFrame = 0, first = blocks[0]
    if (!first) continue
    let previous = first
    const copySegment = (lastFrame: number) => {
      const callbackWall = Number(first.wallMs) + (Number(first.callbackMonotonicNs) - Number(first.monotonicNs)) / 1e6
      const at = Math.round((callbackWall - Number(start.wallMs)) * sampleRate / 1000)
      const begin = Math.max(0, -at), count = Math.min(lastFrame - sourceFrame - begin, frames - at - begin)
      if (count <= 0) return
      samples.set(pcm.samples.subarray((sourceFrame + begin) * channels, (sourceFrame + begin + count) * channels), (at + begin) * channels)
      capturedFrames += count
      segments.push({ pid: entry.pid ?? null, captureId: entry.captureId ?? null,
        sourceFrame: sourceFrame + begin, outputFrame: at + begin, frames: count, originWallMs: callbackWall })
    }
    for (const block of blocks.slice(1)) {
      const elapsedMs = (Number(block.callbackMonotonicNs) - Number(previous.callbackMonotonicNs)) / 1e6
      if (elapsedMs > Number(previous.frames) / sampleRate * 1000 + 20) {
        copySegment(Number(block.offset))
        sourceFrame = Number(block.offset); first = block
      }
      previous = block
    }
    copySegment(pcm.samples.length / channels)
  }
  if (!capturedFrames) throw new Error("No actual live post-master PCM captured")
  await writeFile(path.join(directory, `${prefix}capture-segments.json`), JSON.stringify({ frames, capturedFrames, segments }, null, 2))
  return { sampleRate, channels, samples }
}

const usage = "Usage: ae-08-live-graph.ts --phase 1|2|3|4|5|6|6i|7|8 [--out /absolute/dir] [--rows a,b,…] [--matrix] [--repetitions N] [--vst-repetitions N]"
const knownPhases = ["1", "2", "3", "4", "5", "6", "6i", "7", "8"]
const positiveInteger = (flag: string, value: string) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} needs a positive integer, got ${value}`)
  return number
}
// Only phases 5 and 8 have rows to filter, only phase 5 repeats them, and only phases 6, 6i and 7 will have VST rows. `--matrix` (optionally spelled
// `--matrix full`) selects every row, so it contradicts `--rows`.
export const parseRunnerArgs = (args: string[]) => {
  const values = new Map<string, string>()
  let matrix = false
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === "--matrix") {
      matrix = true
      if (args[index + 1] === "full") index++
      continue
    }
    const value = args[index + 1]
    if (key === undefined || value === undefined || !["--phase", "--out", "--rows", "--repetitions", "--vst-repetitions"].includes(key) || values.has(key))
      throw new Error(usage)
    values.set(key, value)
    index++
  }
  const phase = values.get("--phase")
  if (phase === undefined || !knownPhases.includes(phase)) throw new Error(usage)
  const out = values.get("--out") ?? `/tmp/ae08-phase-${phase}-${Date.now()}`
  if (!path.isAbsolute(out)) throw new Error(usage)
  const rowsValue = values.get("--rows")
  const rows = rowsValue?.split(",")
  if (rows && (rows.some((row) => row === "") || new Set(rows).size !== rows.length)) throw new Error(`--rows needs distinct, non-empty names, got ${rowsValue}`)
  if (rows && matrix) throw new Error("--rows and --matrix contradict each other")
  const phaseRows = phase === "5" ? phase5Rows : phase === "8" ? phase8Rows : []
  if (rows && (!phaseRows.length || rows.some((row) => !phaseRows.includes(row))))
    throw new Error(`--rows names phase 5 rows: ${phase5Rows.join(", ")}; or phase 8 rows: ${phase8Rows.join(", ")}`)
  const repetitionsValue = values.get("--repetitions")
  const repetitions = repetitionsValue === undefined ? 1 : positiveInteger("--repetitions", repetitionsValue)
  if (repetitions > 1 && phase !== "5") throw new Error("--repetitions repeats phase 5 rows")
  const vstValue = values.get("--vst-repetitions")
  const vstRepetitions = vstValue === undefined ? 1 : positiveInteger("--vst-repetitions", vstValue)
  if (vstValue !== undefined && !["6", "6i", "7"].includes(phase)) throw new Error("--vst-repetitions repeats the VST rows of phases 6, 6i and 7")
  return { phase, out, rows, matrix, repetitions, vstRepetitions }
}
// Only a complete, single pass over every row can certify: the campaign analysis needs all rows (analyze-ae-08-continuity.ts).
export const nonCertifyingReason = (parsed: ReturnType<typeof parseRunnerArgs>) =>
  parsed.rows ? "filtered" : parsed.repetitions > 1 ? "repeated" : undefined

const selfTest = () => {
  const refused = (args: string[], message: RegExp) => {
    try { parseRunnerArgs(args) } catch (error) { if (error instanceof Error && message.test(error.message)) return }
    throw new Error(`Expected ${args.join(" ")} to be refused with ${message}`)
  }
  const accepted = parseRunnerArgs(["--phase", "5", "--out", "/tmp/x", "--rows", "held-note,raw-tempo", "--repetitions", "2"])
  if (accepted.rows?.join() !== "held-note,raw-tempo" || accepted.repetitions !== 2 || !nonCertifyingReason(accepted)) throw new Error("Filtered parse failed")
  if (nonCertifyingReason(parseRunnerArgs(["--phase", "5", "--out", "/tmp/x", "--matrix"]))) throw new Error("A full single pass must certify")
  if (nonCertifyingReason(parseRunnerArgs(["--phase", "5", "--out", "/tmp/x", "--matrix", "full"]))) throw new Error("`--matrix full` must stay accepted")
  if (parseRunnerArgs(["--phase", "6i", "--out", "/tmp/x", "--vst-repetitions", "3"]).vstRepetitions !== 3) throw new Error("6i parse failed")
  parseRunnerArgs(["--phase", "6", "--out", "/tmp/x"]); parseRunnerArgs(["--phase", "7", "--out", "/tmp/x"])
  refused(["--phase", "5", "--out", "/tmp/x", "--rows", "nope"], /--rows names phase 5 rows/)
  refused(["--phase", "5", "--out", "/tmp/x", "--rows", "paused-structural"], /--rows names phase 5 rows/)
  refused(["--phase", "8", "--out", "/tmp/x", "--rows", "held-note"], /phase 8 rows/)
  refused(["--phase", "4", "--out", "/tmp/x", "--rows", "held-note"], /--rows names phase 5 rows/)
  refused(["--phase", "5", "--out", "/tmp/x", "--rows", "held-note", "--matrix"], /contradict/)
  refused(["--phase", "5", "--out", "/tmp/x", "--rows", "held-note,held-note"], /distinct/)
  refused(["--phase", "5", "--out", "/tmp/x", "--repetitions", "0"], /positive integer/)
  refused(["--phase", "4", "--out", "/tmp/x", "--repetitions", "2"], /repeats phase 5 rows/)
  refused(["--phase", "5", "--out", "/tmp/x", "--vst-repetitions", "2"], /VST rows/)
  refused(["--phase", "9", "--out", "/tmp/x"], /Usage/)
  refused(["--phase", "8", "--out", "/tmp/x", "--repetitions", "2"], /repeats phase 5 rows/)
  const phase8 = parseRunnerArgs(["--phase", "8", "--out", "/tmp/x", "--rows", "paused-structural"])
  if (phase8.rows?.join() !== "paused-structural" || nonCertifyingReason(phase8) !== "filtered") throw new Error("Phase 8 filtered parse failed")
  if (nonCertifyingReason(parseRunnerArgs(["--phase", "8", "--out", "/tmp/x"]))) throw new Error("A full phase 8 pass must certify")
  refused(["--phase", "5", "--out", "relative"], /Usage/)
  refused(["--phase", "5", "--bogus", "1"], /Usage/)
  console.log("ae-08-live-graph argument self-test: pass")
}

const main = async () => {
  const parsed = parseRunnerArgs(Bun.argv.slice(2))
  const { out } = parsed
  const phase = Number.parseInt(parsed.phase)
  if (["6", "6i", "7"].includes(parsed.phase)) throw new Error(`Phase ${parsed.phase} is not implemented yet`)
  const processes = await Bun.$`ps -axo command=`.text()
  if (processes.split("\n").some((line) => line.trim().startsWith(`${executable} `)))
    throw new Error("Another packaged acceptance/app is active; wait for its normal quit")
  await mkdir(out, { mode: 0o700 })
  const provenance: Provenance = { phase, startedAt: new Date().toISOString(), app, telemetryOptIn: true,
    sourceHead: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(),
    dirtyDiffSha256: hash(await Bun.$`git -C ${root} diff HEAD --binary`.text()),
    artifacts: {}, fixture: "two-tone 431/997Hz, held A4 synth, impulse long reverb, trusted Valhalla, sacrificial track" }
  const artifacts = await packagedArtifactHashes(resources)
  provenance.artifacts = { ...artifacts }
  const untracked = (await Bun.$`git -C ${root} ls-files --others --exclude-standard -- apps native tools packages src`.text())
    .split("\n").filter(Boolean)
  const sourceHashes: Record<string, string> = {}
  for (const file of untracked) sourceHashes[file] = hash(await readFile(path.join(root, file)))
  await writeFile(path.join(out, "untracked-source-sha256.json"), JSON.stringify(sourceHashes, null, 2))
  provenance.untrackedSourceManifestSha256 = hash(JSON.stringify(sourceHashes))
  await writeFile(path.join(out, "provenance.json"), JSON.stringify(provenance, null, 2))
  try {
    if (phase === 5) {
      provenance.fixture = "Eight public-control source/schedule seam rows plus the effect-state UI row (FFT, gain preview/flush, pause); 180s paged assets; native frame oracle plus offline references"
      provenance.ownedPids = []
      const rows: { row: string; failure?: string }[] = []
      for (const row of parsed.rows ?? phase5Rows) {
        for (let repetition = 1; repetition <= parsed.repetitions; repetition++) {
          const name = parsed.repetitions === 1 ? row : `${row}-r${repetition}`
          try {
            const result = await run(path.join(out, name), true, row, 5)
            provenance.ownedPids.push(result.pid)
            rows.push({ row: name })
          } catch (error) {
            rows.push({ row: name, failure: error instanceof Error ? error.message : String(error) })
            // A normally closed failed row retains evidence and does not suppress
            // the other independent rows. Never launch alongside a surviving app.
            const active = await Bun.$`ps -axo command=`.text()
            if (active.split("\n").some((line) => line.trim().startsWith(`${executable} `))) throw error
          }
          await writeFile(path.join(out, "phase5-campaign.json"), JSON.stringify({ phase: 5, rows }, null, 2))
        }
      }
      await verifyPackagedArtifacts(resources, artifacts)
      const reason = nonCertifyingReason(parsed)
      if (reason) {
        const failed = rows.filter((entry) => entry.failure)
        // A filtered pass judges the rows it ran, so a smoke run still reports each row's verdict; it never certifies.
        const judged = reason === "filtered" ? await analyzePhase5Campaign(out, parsed.rows) : undefined
        const verdict = `AE-08 phase 5 NON-CERTIFYING (${reason}): ran ${rows.map((entry) => entry.row).join(", ")}; ${failed.length} failed.${judged ? ` ${judged.verdict}.` : ""} The campaign analysis needs every row, once.`
        await writeFile(path.join(out, "verdict.md"), `# AE-08 phase 5\n\n${verdict}\n\nNo continuity certification.\n${failed.map((entry) => `\n- ${entry.row}: ${entry.failure}`).join("")}\n`)
        console.log(`${out}\n${verdict}`)
        if (failed.length || judged?.passed === false) throw new Error(verdict)
        return
      }
      const result = await analyzePhase5Campaign(out)
      console.log(`${out}\n${result.verdict}`)
      if (!result.passed) throw new Error(result.verdict)
      return
    }
    if (phase === 8) {
      provenance.fixture = "180s retained source; one structural edit (new track) while paused, then while playing, judged from host.jsonl (one host, one device session, in-place publication)"
      provenance.ownedPids = []
      const rows: { row: string; failure?: string }[] = []
      for (const row of parsed.rows ?? phase8Rows) {
        try {
          const result = await run(path.join(out, row), true, row, 8)
          provenance.ownedPids.push(result.pid)
          rows.push({ row })
        } catch (error) {
          rows.push({ row, failure: error instanceof Error ? error.message : String(error) })
          const active = await Bun.$`ps -axo command=`.text()
          if (active.split("\n").some((line) => line.trim().startsWith(`${executable} `))) throw error
        }
        await writeFile(path.join(out, "phase8-campaign.json"), JSON.stringify({ phase: 8, rows }, null, 2))
      }
      await verifyPackagedArtifacts(resources, artifacts)
      const result = await analyzePhase8Campaign(out, parsed.rows)
      console.log(`${out}\n${result.verdict}`)
      if (!result.passed) throw new Error(result.verdict)
      return
    }
    if (phase === 4) {
      provenance.fixture = "audible right-channel FFT, exact retained left-channel oracle; nine phase-4 rows including maximum 65536"
      provenance.ownedPids = []
      const directories: string[] = []
      for (const kind of phase4Fixtures) {
        const directory = path.join(out, kind)
        await mkdir(directory, { mode: 0o700 })
        const reference = await run(path.join(directory, "reference"), false, kind, 4)
        const calibration = await run(path.join(directory, "calibration"), false, kind, 4)
        const baseline = await run(path.join(directory, "baseline"), true, kind, 4)
        provenance.ownedPids.push(reference.pid, calibration.pid, baseline.pid)
        for (const [name, capture] of [["reference", reference], ["calibration", calibration], ["output", baseline]] satisfies [string, Awaited<ReturnType<typeof run>>][])
          await writeWav(path.join(directory, `${name}.wav`), await assemble(capture.out))
        for (const name of ["host.jsonl", "actions.jsonl", "revisions.jsonl", "phase4-edits.json"])
          await writeFile(path.join(directory, name), await readFile(path.join(baseline.out, name)))
        if (kind === "stop-restart") {
          await writeWav(path.join(directory, "restart.wav"), await assemble(baseline.out, "restart-"))
          await writeWav(path.join(directory, "restart-reference.wav"), await assemble(reference.out, "restart-"))
        }
        directories.push(kind)
      }
      await verifyPackagedArtifacts(resources, artifacts)
      await writeFile(path.join(out, "phase4-campaign.json"), JSON.stringify({ phase: 4, directories,
        routedKeepLatency: { status: "enabled-single-output-group",
          expectedUnsupported: "Divergent mixed-bus fan-out with unequal remaining algorithm latency (native P1-3 diagnostic)." } }, null, 2))
      const result = await analyzePhase4Campaign(out)
      console.log(`${out}\n${result.verdict}`)
      if (!result.passed) throw new Error(result.verdict)
      return
    }
    const reference = await run(path.join(out, "reference"), false, "combined", phase)
    const edited = await run(path.join(out, "baseline"), true, "combined", phase)
    if (phase === 2) await writeFile(path.join(out, "revision-roundtrip.json"),
      await readFile(path.join(edited.out, "revision-roundtrip.json")))
    await verifyPackagedArtifacts(resources, artifacts)
    provenance.ownedPids = [reference.pid, edited.pid]
    provenance.device = edited.records.filter((entry) => entry.event === "device-session")
    await writeWav(path.join(out, "reference.wav"), await assemble(reference.out))
    await writeWav(path.join(out, "output.wav"), await assemble(edited.out))
    for (const name of ["host.jsonl", "actions.jsonl", "revisions.jsonl"])
      await writeFile(path.join(out, name), await readFile(path.join(edited.out, name)))
    if (phase === 3) {
      await writeFile(path.join(out, "phase3-edits.json"), await readFile(path.join(edited.out, "phase3-edits.json")))
      const result = await analyzePhase3(out)
      console.log(result.verdict)
      if (!result.passed) throw new Error(result.verdict)
      return
    }
    const result = await analyzeRun(out)
    console.log(result.verdict)
    if (result.captureFailures.length || !result.editFreeCapture.passed)
      throw new Error("Post-master capture integrity gate failed; see analysis.json")
    const isolated: { fixture: FixtureKind; verdict: string; directory: string }[] = []
    // These are phase-1 fixed source oracles, not the reserved phase-9 matrix.
    const fixtureKinds: FixtureKind[] = ["two-tone", "held-note", "reverb-tail"]
    for (const fixtureKind of fixtureKinds) {
      const directory = path.join(out, fixtureKind)
      await mkdir(directory, { mode: 0o700 })
      const pristine = await run(path.join(directory, "reference"), false, fixtureKind)
      const changed = await run(path.join(directory, "baseline"), true, fixtureKind)
      provenance.ownedPids.push(pristine.pid, changed.pid)
      await writeWav(path.join(directory, "reference.wav"), await assemble(pristine.out))
      await writeWav(path.join(directory, "output.wav"), await assemble(changed.out))
      for (const name of ["host.jsonl", "actions.jsonl", "revisions.jsonl"])
        await writeFile(path.join(directory, name), await readFile(path.join(changed.out, name)))
      const sourceAnalysis = await analyzeRun(directory)
      isolated.push({ fixture: fixtureKind, verdict: sourceAnalysis.verdict, directory })
      if (sourceAnalysis.captureFailures.length || !sourceAnalysis.editFreeCapture.passed)
        throw new Error(`${fixtureKind} capture integrity failed; see its analysis.json`)
    }
    await verifyPackagedArtifacts(resources, artifacts)
    await writeFile(path.join(out, "isolated-fixtures.json"), JSON.stringify(isolated, null, 2))
    await appendFile(path.join(out, "verdict.md"), "\n## Isolated source oracles\n\n" +
      isolated.map((entry) => `- ${entry.fixture}: ${entry.verdict} See ${entry.fixture}/analysis.json.`).join("\n") + "\n")
  } catch (error) {
    provenance.failure = error instanceof Error ? error.message : String(error)
    // A completed phase-5 campaign with red product assertions is not an
    // incomplete harness. Preserve the analyzer's per-row failure verdict.
    if (![5, 8].includes(phase) || !await Bun.file(path.join(out, "analysis.json")).exists())
      await writeFile(path.join(out, "verdict.md"), `# AE-08 phase ${phase}\n\nHARNESS INCOMPLETE: ${provenance.failure}\n\nNo continuity certification. See retained run evidence.\n`)
    throw error
  } finally {
    await writeFile(path.join(out, "provenance.json"), JSON.stringify(provenance, null, 2))
  }
}
if (import.meta.main) await (Bun.argv[2] === "--self-test" ? selfTest() : main())
