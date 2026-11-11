#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import {
  controlApprovalResultSchemaV1,
  controlCapabilitiesSchemaV2,
  controlCommitResultSchemaV1,
  controlPreviewResultSchemaV1,
  projectCurrentResultSchema,
  projectSnapshotSchemaV2,
} from "@daw-browser/control"
import {
  desktopDiagnosticsSchemaV2,
  desktopHostStatusSchemaV1,
  desktopHostVstInstancesResultSchemaV1,
} from "@daw-browser/desktop-protocol"
import { nativeAudioHostArtifactId, nativeAudioHostProtocolVersion } from "@daw-browser/desktop-protocol/native-audio-host"
import { browserCommand as browserCommandRaw, waitForBrowserValue } from "../browser-harness"
import { createPrivateRunDirectory, electronRendererTarget, writePrivateArtifact } from "./electron"
import { ownedV3CdpEndpoint } from "./v3-import-acceptance"
import { command } from "./v3-import-workload"
import { recordedAudioContentSchema, recordedAudioContentScript } from "./recorded-audio-content"
import { assessSpoolCapture, assessSpoolCompletion, assessNativeSpoolAsset, assessSpoolNativeIntegrity, assessSpoolProductDialog, observeSavedSpoolClip, spoolObservationLimit, type SpoolProof, type SpoolReleaseEvidence } from "./native-spool-evidence"
import { assessSpoolDurability, createSpoolOrderCollector } from "./native-spool-ordering"
import { createSpoolStatusObservation } from "./native-spool-status"
import { installSpoolReleaseObserver } from "./native-spool-observer"
import { stopOwnedSpoolProcesses } from "./native-spool-process"
import { createOwnedWindowControl, type RecordingWindowState } from "./window-occlusion"
import { recordingStartDiagnosticEventSchema, type RecordingStartDiagnosticEvent } from "../../../apps/desktop/recording-start-diagnostic"
import { acknowledgeRetainedSourcesNotice, nested, waitForAcceptanceEvent } from "./native-acceptance-ui"

const root = path.resolve(import.meta.dir, "../../..")
const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
type Json = z.infer<ReturnType<typeof z.json>>
type SpoolRunResult = {
  status: "failed" | "complete"; layout: string; startedAt: string; sourceCommit: string; asarSha256: string;
  nativeProtocol: number; nativeArtifact: string; nativeStatusBytes: number; profiled: boolean; performanceCertified: boolean;
  capabilitiesDiscovered?: boolean; viewport?: Json; hardware?: Json; preReleaseSavedContent?: Json;
  preReleaseObservedAtEpochMs?: number; recordingDurationMs?: number; saveObservationLimit?: Json;
  stopToSaveReleaseMs?: number; statuses?: Json; statusOverwrites?: number; import?: Json; releaseEvents?: Json;
  decodedContent?: Json; nativeIntegrity?: Json; normalQuit?: Json; error?: string; appOutputPresent?: boolean;
  latestStatus?: Json; dialog?: Json; stage?: string; proof?: SpoolProof | null; release?: SpoolReleaseEvidence;
  rendererPlaybackDiagnostics?: string[];
  receiptDurability?: Json; nativeStatusSummary?: Json; incidents?: Json; cleanupFailed?: boolean; observerError?: string;
  originalReleaseInvoked?: boolean;
  retainedSourcesNoticeAcknowledged?: { beforeRecord?: boolean; afterReload?: boolean };
  recordingStartEvidence?: RecordingStartDiagnosticEvent[]; recordingUiAfterAttempt?: Json;
  nativeIntegrityAssessment?: Json; incidentCollection?: Json;
  plugin?: Json; pluginIntegrity?: Json;
  windowBackground?: Json;
  visibilityEvents?: Json;
  visibilityGate?: { overflowedDuringCapture: boolean; intervalEventCount: number };
  runnerStepMarks?: { step: string; epochMs: number }[];
  preRecordTakeCount?: number; postReleaseTakeCount?: number;
  preexistingProofCount?: number; newProofCount?: number;
}
const proofSchema = z.object({ generation: z.number().int(), sessionId: z.string(),
  frames: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), blocks: z.number().int().nonnegative(),
  sampleRateHz: z.number().int().positive(), channelCount: z.number().int().min(1).max(2),
  fileDevice: z.string(), fileInode: z.string(), rootDevice: z.string(), rootInode: z.string() }).strict()
const observedReleaseSchema = z.object({
  scope: z.object({ projectId: z.string(), projectGeneration: z.number().int() }).strict(),
  takeId: z.string(),
  acknowledgment: z.object({ reason: z.literal("imported"), sessionId: z.string(),
    frames: z.number(), bytes: z.number(), blocks: z.number(), sampleRateHz: z.number(), channelCount: z.number(),
    finalized: z.literal(true), savedClip: z.object({ clipId: z.string(), sourceAssetKey: z.string() }).strict() }).strict(),
}).strict()
const recordingStartDiagnosticPrefix = "[recording-start-diagnostic] "
const nativeIntegritySample = (sample: Awaited<ReturnType<typeof desktopDiagnosticsSchemaV2.parse>>["native"]) => {
  if (sample.status !== "available") return {
    status: sample.status,
    artifactVerification: sample.status === "unavailable" ? null : sample.artifactVerification.status,
    errorCode: sample.status === "failed" ? sample.errorCode : null,
  }
  const vst = sample.diagnostics.vstWorkerPerformance
  return {
    status: sample.status,
    artifactVerification: sample.artifactVerification.status,
    callbacks: sample.diagnostics.callbacks,
    rejectedBlocks: sample.diagnostics.rejectedBlocks,
    state: sample.diagnostics.state,
    activeRevision: sample.diagnostics.activeRevision,
    preparedRevision: sample.diagnostics.preparedRevision,
    retiredRevision: sample.diagnostics.retiredRevision,
    transportEpoch: sample.diagnostics.transportEpoch,
    renderEpoch: sample.diagnostics.renderEpoch,
    installedAssets: sample.diagnostics.installedAssets,
    transportFrame: sample.diagnostics.transportFrame ?? null,
    realtimePerformance: sample.diagnostics.realtimePerformance ?? null,
    vst: vst ? {
      activeWorkers: vst.activeWorkers,
      observationCount: vst.observationCount,
      faults: vst.faults,
      watchdogMisses: vst.watchdogMisses,
      restarts: vst.restarts,
    } : null,
  }
}

// A private owned-profile proof is read only to compare scalar totals/identity.
// No manifest, token, dev/inode, scope or source bytes enter result artifacts.
const privateProof = async (directory: string, preexistingProofNames: ReadonlySet<string>, result: SpoolRunResult) => {
  const proofNames = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.complete\.json$/.test(name))
  const newProofNames = proofNames.filter((name) => !preexistingProofNames.has(name))
  result.preexistingProofCount = preexistingProofNames.size
  result.newProofCount = newProofNames.length
  if (newProofNames.length !== 1 || !newProofNames[0]) throw new Error("Exactly one independent Complete proof is required.")
  const proofFile = path.join(directory, newProofNames[0])
  const stat = await lstat(proofFile)
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error("Unsafe Complete proof file.")
  const proof = proofSchema.parse(JSON.parse(await readFile(proofFile, "utf8")))
  const nativeSource = proofFile.replace(/\.complete\.json$/, ".pcm")
  const source = await lstat(nativeSource, { bigint: true })
  const parent = await lstat(directory, { bigint: true })
  if (!source.isFile() || source.nlink !== 1n || (source.mode & 0o777n) !== 0o600n
    || source.uid !== BigInt(process.getuid?.() ?? -1) || parent.uid !== source.uid || (parent.mode & 0o777n) !== 0o700n
    || source.dev.toString() !== proof.fileDevice || source.ino.toString() !== proof.fileInode
    || source.size !== BigInt(proof.bytes) || parent.dev.toString() !== proof.rootDevice
    || parent.ino.toString() !== proof.rootInode) throw new Error("Independent Complete/source identity mismatch.")
  return { proof, nativeSource, receiptFile: proofFile.replace(/\.complete\.json$/, ".released.json") }
}
const main = async () => {
  const output = Bun.argv[2]
  const layout = Bun.argv[3] ?? "mono"
  const pluginProfileSource = Bun.argv[4]
  const preflightOnly = Bun.argv[5] === "--preflight"
  let backgroundState: RecordingWindowState | undefined
  if (Bun.argv[5] === "--minimized") backgroundState = "minimized"
  if (Bun.argv[5] === "--occluded") backgroundState = "occluded"
  if (!output || !path.isAbsolute(output) || (layout !== "mono" && layout !== "stereo")
    || (pluginProfileSource !== undefined && !path.isAbsolute(pluginProfileSource))
    || (Bun.argv[5] !== undefined && !preflightOnly && !backgroundState)
    || (preflightOnly && backgroundState))
    throw new Error("Usage: native-spool-acceptance.ts <absolute-result> [mono|stereo] [approved-plugin-profile] [--preflight|--minimized|--occluded]")
  const nativeIntegrityArtifact = `${output}.native-integrity.json`
  const directory = await createPrivateRunDirectory("/tmp")
  const profile = pluginProfileSource ?? path.join(directory, "profile")
  if (pluginProfileSource) {
    const sourceStat = await lstat(pluginProfileSource)
    if (!sourceStat.isDirectory() || sourceStat.uid !== (process.getuid?.() ?? -1) || (sourceStat.mode & 0o077) !== 0
      || path.basename(pluginProfileSource) !== "profile"
      || !path.basename(path.dirname(pluginProfileSource)).startsWith("daw-plugin-output-proof-"))
      throw new Error("Approved plugin profile must be an owned private directory.")
    const retainedRun = path.dirname(pluginProfileSource)
    for (const name of ["plugin-active.png", "probe-stereo.wav", "enabled.wav", "bypassed.wav"]) {
      const artifact = await lstat(path.join(retainedRun, name)).catch(() => undefined)
      if (!artifact?.isFile() || artifact.uid !== sourceStat.uid)
        throw new Error("Approved disposable plugin evidence set is incomplete.")
    }
  } else await mkdir(profile, { mode: 0o700 })
  const session = `daw-30-track-electron-spool-${crypto.randomUUID()}`
  const result: SpoolRunResult = { status: "failed", layout, startedAt: new Date().toISOString(),
    sourceCommit: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(),
    asarSha256: createHash("sha256").update(await readFile(path.join(path.dirname(path.dirname(executable)), "Resources/app.asar"))).digest("hex"),
    nativeProtocol: nativeAudioHostProtocolVersion, nativeArtifact: nativeAudioHostArtifactId, nativeStatusBytes: 120,
    profiled: false, performanceCertified: false }
  let stage = "launch"
  let attached = false
  let observer: Awaited<ReturnType<typeof installSpoolReleaseObserver>> | undefined
  let windowControl: ReturnType<typeof createOwnedWindowControl> | undefined
  let windowWasBackgrounded = false
  const order = createSpoolOrderCollector()
  const release: SpoolReleaseEvidence = { calls: 0, succeeded: false, savedClipObserved: false,
    assetObserved: false, sourcePresentBefore: false, sourceAbsentAfter: false, receiptPresent: false,
    receiptBeforeSourceUnlinkObserved: false, proofVerified: false, acknowledgmentFinalized: false,
    acknowledgmentMatchesProof: false, receiptMatchesAcknowledgment: false, listMatchesPreRecordAfter: false }
  let proof: SpoolProof | null = null
  let releasePrivate: Awaited<ReturnType<typeof privateProof>> | undefined
  let preexistingProofNames = new Set<string>()
  let releaseInput: z.infer<typeof observedReleaseSchema> | undefined
  let appOutput = ""
  const incidents: { kind: string; originCode: number | null }[] = []
  let incidentLines = 0
  let incidentOverwrites = 0
  let incidentMalformed = 0
  let incidentCollectorAvailable = false
  const recordingStartEvidence: RecordingStartDiagnosticEvent[] = []
  const runnerStepMarks: { step: string; epochMs: number }[] = []
  let captureMarksActive = false
  const markStep = (step: string) => {
    if (runnerStepMarks.length < 64) runnerStepMarks.push({ step, epochMs: Date.now() })
    result.runnerStepMarks = [...runnerStepMarks]
  }
  const browserCommand = async (sessionId: string, args: readonly string[]) => {
    if (captureMarksActive && args[0] === "eval") markStep("browserCommand eval")
    return browserCommandRaw(sessionId, args)
  }
  const acknowledgeNotice = async (label: "beforeRecord" | "afterReload") => {
    if (!await acknowledgeRetainedSourcesNotice(session, label, browserCommand)) return false
    await waitForBrowserValue(session, "!document.querySelector('[role=\"dialog\"]')?true:null", 15000)
    return true
  }
  const runBrowserCommand = async (args: string[]) => {
    return browserCommand(session, args)
  }
  const resolveInputEvidence = async () => {
    stage = "input-preflight"
    const input = nested(await browserCommand(session, ["eval",
      "(async()=>{const r=await window.dawDesktop.audioHost.resolveInputDevice();if(!r.ok)return JSON.stringify({resolverOutcome:'reply-failed',available:false,errorClass:r.error==='The native audio host is unavailable.'?'native-audio-host-unavailable':'other'});if(!r.device)return JSON.stringify({resolverOutcome:'no-device',available:false});return JSON.stringify({resolverOutcome:'device-resolved',available:r.device.available,inputChannels:r.device.inputChannelCount,sampleRateHz:r.device.nominalSampleRateHz})})()"]))
    result.hardware = input
    return input
  }
  const captureDiagnostics = async () => {
    if (captureMarksActive) markStep("diagnostics.start")
    const value = await command(profile, ["host", "diagnostics-v2"])
    if (captureMarksActive) markStep("diagnostics.end")
    return desktopDiagnosticsSchemaV2.parse(value)
  }
  const nativeIntegritySamples: Json[] = []
  const pluginIntegrity: { phase: string; activeWorkers: number; observationCount: string; faults: string;
    watchdogMisses: string; restarts: string }[] = []
  let lastPluginObservationCount: string | undefined
  const capturePluginObservation = (
    phase: string,
    sample: Awaited<ReturnType<typeof desktopDiagnosticsSchemaV2.parse>>["native"],
  ) => {
    const performance = sample.status === "available" ? sample.diagnostics.vstWorkerPerformance : undefined
    if (!performance || performance.activeWorkers !== 1
      || (lastPluginObservationCount !== undefined && BigInt(performance.observationCount) <= BigInt(lastPluginObservationCount))
      || BigInt(performance.observationCount) <= 0n
      || BigInt(performance.faults) !== 0n || BigInt(performance.watchdogMisses) !== 0n
      || BigInt(performance.restarts) !== 0n || sample.status !== "available"
      || sample.diagnostics.rejectedBlocks !== 0)
      throw new Error(`Enabled plugin worker failed ${phase} activity/integrity gate.`)
    lastPluginObservationCount = performance.observationCount
    pluginIntegrity.push({ phase, activeWorkers: performance.activeWorkers,
      observationCount: performance.observationCount, faults: performance.faults,
      watchdogMisses: performance.watchdogMisses, restarts: performance.restarts })
    result.pluginIntegrity = [...pluginIntegrity]
  }
  const activeIntegrityPairs: { lifecycle: string; first: Awaited<ReturnType<typeof desktopDiagnosticsSchemaV2.parse>>["native"];
    second: Awaited<ReturnType<typeof desktopDiagnosticsSchemaV2.parse>>["native"] }[] = []
  const retainNativeIntegritySamples = async () => {
    result.nativeIntegrity = [...nativeIntegritySamples]
    await writePrivateArtifact(nativeIntegrityArtifact, JSON.stringify({
      schemaVersion: 1,
      samples: nativeIntegritySamples,
    }, null, 2))
  }
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`],
    { cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile,
      DAW_RECORDING_SPOOL_ORDER_EVIDENCE: "1", DAW_RECORDING_START_EVIDENCE: "1",
      DAW_RECORDING_START_DIAGNOSTIC: "0" }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  const appPid = app.pid
  if (!appPid) throw new Error("Owned app PID unavailable.")
  if (backgroundState) windowControl = createOwnedWindowControl(appPid)
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    app.once("close", (code, signal) => resolve({ code, signal })))
  const observeOutput = (stream: "stdout" | "stderr") => {
    let tail = ""
    return (chunk: Buffer) => {
      appOutput = (appOutput + chunk.toString()).slice(-4096)
      const lines = (tail + chunk.toString()).split(/\r?\n/); tail = (lines.pop() ?? "").slice(-4096)
      for (const line of lines) {
        if (stream === "stdout") {
          order.observeLine(line)
          if (line.startsWith(recordingStartDiagnosticPrefix) && recordingStartEvidence.length < 64) {
            try {
              const event = recordingStartDiagnosticEventSchema.safeParse(JSON.parse(line.slice(recordingStartDiagnosticPrefix.length)))
              if (event.success) recordingStartEvidence.push(event.data)
            } catch { /* Invalid or truncated lines are not retained. */ }
          }
        }
        if (line.includes("worker-incident")) {
          incidentLines++
          const at = line.indexOf("{")
          try {
            if (at < 0) throw new Error("Missing incident payload")
            const value = z.object({ kind: z.string().min(1).max(64), originCode: z.number().int().nullable().optional() })
              .passthrough().parse(JSON.parse(line.slice(at)))
            if (incidents.length === 32) { incidents.shift(); incidentOverwrites++ }
            incidents.push({ kind: value.kind, originCode: value.originCode ?? null })
          } catch { incidentMalformed++ }
        }
      }
    }
  }
  incidentCollectorAvailable = app.stdout !== null && app.stderr !== null
  app.stdout?.on("data", observeOutput("stdout")); app.stderr?.on("data", observeOutput("stderr"))
  try {
    let endpoint = ""
    // OS-created CDP file/listener readiness has an explicit 30-second bound.
    for (let attempt = 0; attempt < 30 && !endpoint; attempt++) {
      try { const owned = await ownedV3CdpEndpoint(profile, appPid, executable); endpoint = owned.endpoint }
      catch { await delay(1000) }
    }
    if (!endpoint) throw new Error("Owned CDP launch unavailable.")
    await browserCommand(session, ["connect", endpoint]); attached = true
    let target: string | undefined
    for (let attempt = 0; attempt < 30 && !target; attempt++) {
      target = electronRendererTarget(await browserCommand(session, ["tab"]))?.targetId
      if (!target) await delay(1000)
    }
    if (!target) throw new Error("App renderer unavailable.")
    await browserCommand(session, ["tab", target])
    stage = "create-project"
    const host = desktopHostStatusSchemaV1.parse(await command(profile, ["host", "status"]))
    if (!host.ready) throw new Error("Host is not ready.")
    let projectId: string
    if (pluginProfileSource) {
      const mounted = projectCurrentResultSchema.parse(await command(profile, ["project", "current", "--target", "host"]))
      if (mounted.status === "present") {
        projectId = mounted.project.projectId
      } else {
        await browserCommand(session, ["eval",
          "(()=>{const url=new URL(location.href);url.searchParams.set('dashboard','projects');history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));return true})()"])
        await waitForBrowserValue(session, "document.body.textContent?.includes('Open a local project')?true:null", 30000)
        const localProjectCount = nested(await browserCommand(session, ["eval", "JSON.stringify(document.querySelectorAll('article button').length/3)"]))
        if (localProjectCount !== 1) throw new Error(`Approved local project is not uniquely discoverable in the product UI (${localProjectCount}).`)
        await browserCommand(session, ["eval",
          "(()=>{const button=document.querySelector('article button');if(!(button instanceof HTMLButtonElement))throw new Error('Local project UI entry unavailable.');button.click();return true})()"])
        projectId = z.string().parse(nested(await waitForBrowserValue(session,
          "new URL(location.href).searchParams.get('projectId')&&document.querySelector('[data-timeline-ruler=\"1\"]')?new URL(location.href).searchParams.get('projectId'):null", 30000)))
        const reopened = projectCurrentResultSchema.parse(await command(profile, ["project", "current", "--target", "host"]))
        if (reopened.status !== "present" || reopened.project.projectId !== projectId)
          throw new Error("Product UI opened a project that does not match the public mounted-project read.")
      }
      const routeReady = nested(await browserCommand(session, ["eval",
        `JSON.stringify(new URL(location.href).searchParams.get('projectId')===${JSON.stringify(projectId)})`]))
      if (routeReady !== true) await browserCommand(session, ["eval",
        `(()=>{const url=new URL(location.href);url.searchParams.set('projectId',${JSON.stringify(projectId)});history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));return true})()`])
      await waitForBrowserValue(session,
        `new URL(location.href).searchParams.get('projectId')===${JSON.stringify(projectId)}&&document.querySelector('[data-timeline-ruler="1"]')?true:null`, 30000)
    } else {
      await waitForBrowserValue(session, "[...document.querySelectorAll('button')].some(b=>b.textContent?.trim()==='New project')?true:null", 30000)
      await browserCommand(session, ["find", "role", "button", "click", "--name", "New project"])
      projectId = z.string().parse(nested(await waitForBrowserValue(session,
        "new URL(location.href).searchParams.get('projectId')&&document.querySelector('[data-timeline-ruler=\"1\"]')?new URL(location.href).searchParams.get('projectId'):null", 60000)))
    }
    const capabilities = controlCapabilitiesSchemaV2.parse(await command(profile, ["capabilities-v2", "--target", "host"]))
    result.capabilitiesDiscovered = capabilities.actionKinds.length > 0
    const discovered = projectCurrentResultSchema.parse(await command(profile, ["project", "current", "--target", "host"]))
    if (discovered.status !== "present" || discovered.project.projectId !== projectId)
      throw new Error("Disposable project is not the publicly reported mounted desktop project.")
    const snapshot = async () => projectSnapshotSchemaV2.parse(await command(profile, ["snapshot-v2", projectId, "--target", "host"]))
    const diagnostics = captureDiagnostics
    const before = await snapshot()
    let audio: typeof before.tracks
    let pluginTrackId: string | undefined
    let pluginInstanceId: string | undefined
    let playbackClipId: string | undefined
    let recordingTrackId: string | undefined
    if (pluginProfileSource) {
      const pluginProcessors = before.processors.filter((entry) => entry.processor.kind === "external-vst3"
        && entry.processor.params.identity.name === "ValhallaSupermassive" && !entry.processor.params.bypassed)
      if (pluginProcessors.length !== 1 || !pluginProcessors[0] || !("trackId" in pluginProcessors[0].target))
        throw new Error("Exactly one enabled ValhallaSupermassive processor is required in the retained project.")
      pluginTrackId = pluginProcessors[0].target.trackId
      const pluginInstances = desktopHostVstInstancesResultSchemaV1.parse(await command(profile, ["host", "vst-instances", projectId]))
      const attachedPlugin = pluginInstances.instances.find((entry) => entry.targetId === pluginTrackId
        && entry.identity.name === "ValhallaSupermassive" && entry.health.state === "ready")
      if (!attachedPlugin) throw new Error("Trusted ValhallaSupermassive native instance is not ready.")
      pluginInstanceId = attachedPlugin.instanceId
      audio = before.tracks.filter((track) => track.kind === "audio")
      const recordingTrack = audio.find((track) => track.id !== pluginTrackId)
      if (audio.length !== 2 || !recordingTrack) throw new Error("Separate stereo playback and mono recording tracks are required.")
      recordingTrackId = recordingTrack.id
      const playableClips = before.clips.filter((clip) => clip.trackId === pluginTrackId && clip.source?.channelCount === 2)
      if (playableClips.length !== 1 || !playableClips[0]) throw new Error("Unique stereo media clip on the enabled-plugin track is required.")
      playbackClipId = playableClips[0].id
      if (!pluginProfileSource) throw new Error("Plugin-active acceptance requires the isolated retained profile.")
      const capabilities = controlCapabilitiesSchemaV2.parse(await command(profile, ["capabilities-v2", "--target", "host"]))
      if (!capabilities.actionKinds.includes("project.settings.set")) throw new Error("Local loop-setting project action is not advertised.")
      const loopEndSec = playableClips[0].startSec + playableClips[0].duration
      const loopRequest = { version: "v1", projectId, expectedRevision: before.project.revision,
        actions: [{ kind: "project.settings.set", loopEnabled: true,
          loopStartSec: playableClips[0].startSec, loopEndSec }] }
      const loopPreview = controlPreviewResultSchemaV1.parse(await command(profile,
        ["preview", "--request", "-", "--target", "host"], JSON.stringify(loopRequest)))
      const loopApprovalToken = loopPreview.approval?.required
        ? controlApprovalResultSchemaV1.parse(await command(profile, ["approval", "--request", "-", "--target", "host"],
          JSON.stringify(loopRequest))).approvalToken
        : undefined
      controlCommitResultSchemaV1.parse(await command(profile, ["commit", "--request", "-", "--target", "host"],
        JSON.stringify({ ...loopRequest, idempotencyKey: `plugin-spool-loop-${crypto.randomUUID()}`, approvalToken: loopApprovalToken })))
      const loopSnapshot = await snapshot()
      if (!loopSnapshot.project.loop.enabled || loopSnapshot.project.loop.startSec !== playableClips[0].startSec
        || loopSnapshot.project.loop.endSec !== loopEndSec) throw new Error("Supported project loop did not persist.")
      const loopButtonPressed = nested(await browserCommand(session, ["eval",
        "JSON.stringify(document.querySelector('button[aria-label=\"Toggle loop region\"]')?.getAttribute('aria-pressed')==='true')"]))
      if (loopButtonPressed !== true) await browserCommand(session, ["find", "role", "button", "click", "--name", "Toggle loop region"])
      const loopButtonReady = nested(await browserCommand(session, ["eval",
        "JSON.stringify(document.querySelector('button[aria-label=\"Toggle loop region\"]')?.getAttribute('aria-pressed')==='true')"]))
      if (loopButtonReady !== true) throw new Error("Product loop transport control is not enabled.")
      result.plugin = { identity: "ValhallaSupermassive", enabled: true, instanceReady: true,
        instanceCount: 1, stereoTrackPresent: true, recordingTrackSeparate: true,
        loopEnabled: true, loopStartSec: loopSnapshot.project.loop.startSec, loopEndSec: loopSnapshot.project.loop.endSec,
        playbackClipDurationSec: playableClips[0].duration }
      const observedAudio = loopSnapshot.tracks.filter((track) => track.kind === "audio")
      if (observedAudio.length !== 2) throw new Error("Track layout changed during plugin preparation.")
      const recordTrack = observedAudio.find((track) => track.id !== pluginTrackId)
      if (!recordTrack) throw new Error("Separate recording track disappeared.")
      for (const [index, track] of observedAudio.entries()) {
        const trackNumber = index + 1
        const buttonSelector = `button[aria-label="Arm track ${trackNumber} for recording"],button[aria-label="Disarm track ${trackNumber} for recording"]`
        const pressed = nested(await browserCommand(session, ["eval",
          `JSON.stringify(document.querySelector(${JSON.stringify(buttonSelector)})?.getAttribute('aria-pressed')==='true')`]))
        if (pressed !== (track.id === recordTrack.id)) await browserCommand(session, ["eval",
          `(()=>{const button=document.querySelector(${JSON.stringify(buttonSelector)});if(!(button instanceof HTMLButtonElement))throw new Error('Track record-arm control unavailable.');button.click();return true})()`])
      }
      for (const [index, track] of observedAudio.entries()) {
        const trackNumber = index + 1
        const buttonSelector = `button[aria-label="Arm track ${trackNumber} for recording"],button[aria-label="Disarm track ${trackNumber} for recording"]`
        const pressed = nested(await browserCommand(session, ["eval",
          `JSON.stringify(document.querySelector(${JSON.stringify(buttonSelector)})?.getAttribute('aria-pressed')==='true')`]))
        if (pressed !== (track.id === recordTrack.id)) throw new Error("Recording arming does not isolate the mono track.")
      }
      result.viewport = nested(await browserCommand(session, ["eval", "JSON.stringify({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,body:{width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height}})"]))
      await browserCommand(session, ["screenshot", output.replace(/\.json$/, ".png")])
      const input = await resolveInputEvidence()
      if (!input.available || input.inputChannels !== 1) throw new Error("Native input hardware is not available as a mono source.")
      audio = observedAudio
    } else {
      audio = before.tracks.filter((track) => track.kind === "audio")
      if (audio.length !== 1 || !audio[0]) throw new Error("Starter audio track unavailable.")
      recordingTrackId = audio[0].id
    }
    if (!pluginProfileSource) {
      result.viewport = nested(await browserCommand(session, ["eval", "JSON.stringify({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,body:{width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height}})"]))
      await browserCommand(session, ["screenshot", output.replace(/\.json$/, ".png")])
      const input = await resolveInputEvidence()
      if (!input.available) throw new Error("Native input hardware unavailable.")
    }
    if (layout === "stereo") throw new Error("Stereo UI configuration has not been discovered; no substitute capture is allowed.")
    stage = "install-observer"
    if (!order.evidence().ready || order.evidence().invalid)
      throw new Error("Approved main-side durable-sync/unlink observer unavailable; recording must not start.")
    const spoolDirectory = path.join(profile, "recording-spool")
    const statusScript = `(()=>{const observed=(${createSpoolStatusObservation.toString()})();window.__nativeSpoolStatuses=observed.statuses;window.__nativeSpoolStatusSummary=observed.summary;window.__nativeSpoolStatusOff=window.dawDesktop.audioHost.session.onRecordingStatus(s=>{const value={capturedFrames:s.capturedFrames,droppedFrames:s.droppedFrames,droppedBlocks:s.droppedBlocks,availableBlocks:s.availableBlocks,queuedBlocks:s.queuedBlocks,fatal:s.fatal,active:s.active,configured:s.configured,spool:s.spool?{state:s.spool.state,error:s.spool.error,systemError:s.spool.systemError,writtenFrames:s.spool.writtenFrames,writtenBytes:s.spool.writtenBytes,writtenBlocks:s.spool.writtenBlocks,published:s.spool.published,partialRetained:s.spool.partialRetained,sampleRateHz:s.spool.sampleRateHz,channelCount:s.spool.channelCount}:null};observed.observe(value)});return true})()`
    observer = await installSpoolReleaseObserver(endpoint, async (payload, evaluate) => {
      release.calls++
      releaseInput = observedReleaseSchema.parse(JSON.parse(payload))
      releasePrivate = await privateProof(spoolDirectory, preexistingProofNames, result)
      const p = releasePrivate.proof
      proof = { frames: p.frames, bytes: p.bytes, blocks: p.blocks, sampleRateHz: p.sampleRateHz, channelCount: p.channelCount }
      release.proofVerified = true; release.sourcePresentBefore = true
      const acknowledgment = releaseInput.acknowledgment
      release.acknowledgmentFinalized = acknowledgment.finalized
      release.acknowledgmentMatchesProof = acknowledgment.frames === proof.frames && acknowledgment.bytes === proof.bytes
        && acknowledgment.blocks === proof.blocks && acknowledgment.sampleRateHz === proof.sampleRateHz
        && acknowledgment.channelCount === proof.channelCount
      const saved = await snapshot()
      const { asset } = observeSavedSpoolClip({ beforeClips: before.clips, clips: saved.clips,
        assets: saved.assets, trackId: recordingTrackId ?? audio[0].id, savedClip: acknowledgment.savedClip })
      release.savedClipObserved = true
      release.assetObserved = true
      if (!release.acknowledgmentMatchesProof) throw new Error("Saved recording acknowledgment does not match proof.")
      // Separate inspector channel avoids queueing eval behind the same
      // agent-browser session's outstanding wait for release success.
      const content = recordedAudioContentSchema.parse(nested(await evaluate(recordedAudioContentScript(projectId, asset.id))))
      const failures = assessNativeSpoolAsset(asset, content, proof)
      if (failures.length) throw new Error(`Saved content mismatch before release: ${failures.join(",")}`)
      result.preReleaseSavedContent = content
      result.preReleaseObservedAtEpochMs = Date.now()
    })
    await waitForBrowserValue(session, `new URL(location.href).searchParams.get('projectId')===${JSON.stringify(projectId)}&&document.querySelector('[data-timeline-ruler="1"]')?true:null`, 30000)
    await browserCommand(session, ["eval", statusScript])
    stage = "record"
    if (!incidentCollectorAvailable) throw new Error("Native worker incident collector unavailable before capture.")
    result.retainedSourcesNoticeAcknowledged = {
      ...result.retainedSourcesNoticeAcknowledged,
      beforeRecord: await acknowledgeNotice("beforeRecord"),
    }
    if (!pluginProfileSource) await browserCommand(session, ["find", "role", "button", "click", "--name", "Arm track 1 for recording"])
    if (pluginProfileSource) {
      if (!playbackClipId || !pluginTrackId || !pluginInstanceId || !recordingTrackId)
        throw new Error("Plugin acceptance setup identity was lost before transport start.")
      const sourceClip = before.clips.find((clip) => clip.id === playbackClipId)
      if (!sourceClip) throw new Error("Verified stereo source clip disappeared.")
      await command(profile, ["host", "seek", String(sourceClip.startSec)])
      await command(profile, ["host", "play"])
      const playbackStartedAt = performance.now()
      await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Pause\"]')?true:null", 15000)
      const playback = await diagnostics()
      capturePluginObservation("pre-capture-playback", playback.native)
      if (performance.now() - playbackStartedAt > 15000) throw new Error("Plugin-active source playback exceeded its bounded start window.")
      const playbackActive = nested(await browserCommand(session, ["eval",
        "JSON.stringify(!!document.querySelector('button[aria-label=\"Pause\"]')&&document.querySelector('button[aria-label=\"Toggle loop region\"]')?.getAttribute('aria-pressed')==='true')"]))
      if (playbackActive !== true) throw new Error("Enabled-plugin stereo loop stopped before the mono take began.")
      result.plugin = { ...result.plugin, preCaptureWorker: {
        activeWorkers: playback.native.status === "available"
          ? playback.native.diagnostics.vstWorkerPerformance?.activeWorkers ?? 0 : 0,
        observationCount: playback.native.status === "available"
          ? playback.native.diagnostics.vstWorkerPerformance?.observationCount ?? "0" : "0",
      } }
      result.viewport = nested(await browserCommand(session, ["eval", "JSON.stringify({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,body:{width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height}})"]))
      await browserCommand(session, ["screenshot", output.replace(/\.json$/, ".png")])
    }
    const beforeNative = await diagnostics()
    nativeIntegritySamples.push({ phase: "before", lifecycle: "pre-capture", ...nativeIntegritySample(beforeNative.native) })
    await retainNativeIntegritySamples()
    if (pluginProfileSource) {
      if (!pluginTrackId || !pluginInstanceId || !playbackClipId || !recordingTrackId) throw new Error("Plugin acceptance setup identity was lost.")
      if (nativeIntegritySamples.at(-1)?.lifecycle !== "pre-capture" || pluginIntegrity.at(-1)?.phase !== "pre-capture-playback")
        throw new Error("Active plugin playback was not verified before mono capture.")
    }
    if (preflightOnly) {
      if (!pluginProfileSource) throw new Error("Preflight mode requires the approved disposable plugin profile.")
      const productDialog = z.string().parse(nested(await browserCommand(session, ["eval",
        "JSON.stringify(document.querySelector('[role=\"dialog\"]')?.textContent?.slice(0,256)??'')"])))
      if (assessSpoolProductDialog(productDialog).length) throw new Error("Product dialog appeared during plugin preflight.")
      result.dialog = productDialog
      await command(profile, ["host", "stop"])
      await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Play\"]')?true:null", 15000)
      await browserCommand(session, ["eval", "window.close()"])
      const normalExit = await waitForAcceptanceEvent(exit, 15000)
      if (!normalExit || normalExit.code !== 0 || normalExit.signal !== null)
        throw new Error("Plugin preflight did not close normally.")
      result.normalQuit = normalExit
      result.status = "complete"
      stage = "plugin-preflight-ready"
      return
    }
    if (backgroundState) {
      if (!windowControl || !pluginProfileSource) throw new Error("Background capture requires the approved plugin profile and owned window controls.")
      const beforeWindowControl = nested(await browserCommand(session, ["eval",
        "JSON.stringify({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,body:{width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height}})"]))
      const entered = await windowControl.enter(backgroundState, 75)
      const afterWindowControl = await windowControl.restore()
      const afterViewport = nested(await browserCommand(session, ["eval",
        "JSON.stringify({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,body:{width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height}})"]))
      if (JSON.stringify(beforeWindowControl) !== JSON.stringify(afterViewport)
        || afterWindowControl.minimized !== (backgroundState === "minimized")
        || (backgroundState === "occluded" && (entered.screensCovered ?? 0) < 1))
        throw new Error("Owned window state or stable viewport preflight failed before Record.")
      result.windowBackground = { state: backgroundState, preflight: "passed", preflightViewportUnchanged: true,
        preflightWindowState: entered }
    }
    let captureWindowState: Json | undefined
    let backgroundStartedAt: number | undefined
    if (backgroundState) {
      if (!windowControl) throw new Error("Owned window control disappeared before capture.")
      await runBrowserCommand(["eval",
        "(()=>{const installedAt=performance.now();const events=[];let overflowEpochMs=null;window.__nativeSpoolVisibilityEvents=events;window.__nativeSpoolVisibilityOverflow=()=>overflowEpochMs;document.addEventListener('visibilitychange',()=>{if(events.length<32)events.push({visibilityState:document.visibilityState,hidden:document.hidden,msSinceInstall:performance.now()-installedAt,epochMs:Date.now()});else if(overflowEpochMs===null)overflowEpochMs=Date.now()});return true})()"])
      markStep("recorder.installed")
      captureMarksActive = true
      markStep("capture.enter.start")
      captureWindowState = await windowControl.enter(backgroundState, 75)
      markStep("capture.enter.end")
      windowWasBackgrounded = true
      backgroundStartedAt = performance.now()
    }
    preexistingProofNames = new Set((await readdir(spoolDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })).filter((name) => /^[a-f0-9]{64}\.complete\.json$/.test(name)))
    result.preexistingProofCount = preexistingProofNames.size
    const preRecordScope = { projectId, projectGeneration: 1 }
    const preRecordList = nested(await runBrowserCommand(["eval",
      `(async()=>{const scope=${JSON.stringify(preRecordScope)};const takeIds=[];let cursor;const seen=new Set();for(let page=0;page<64;page++){const r=await window.dawDesktop.audioHost.recordingSpool.list(scope,cursor);for(const take of r.takes)takeIds.push(take.takeId);if(r.nextCursor===null)return {takeIds,count:takeIds.length};if(seen.has(r.nextCursor))throw new Error('Recording-spool list cursor repeated.');seen.add(r.nextCursor);cursor=r.nextCursor}throw new Error('Recording-spool list exceeded its page bound.')})()`]))
    const preRecordTakeIds = new Set(z.array(z.string()).parse(preRecordList.takeIds))
    result.preRecordTakeCount = z.number().int().nonnegative().parse(preRecordList.count)
    if (preRecordTakeIds.size !== result.preRecordTakeCount) throw new Error("Pre-Record spool list contained duplicate take IDs.")
    if (backgroundState) markStep("Start recording click.start")
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Start recording"])
    if (backgroundState) markStep("Start recording click.end")
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Stop recording\"]')?true:null", 15000)
    if (backgroundState) markStep("Stop button observed")
    const started = performance.now()
    await delay(5000)
    const early = await diagnostics()
    nativeIntegritySamples.push({ phase: "early", lifecycle: "recording-active", ...nativeIntegritySample(early.native) })
    await retainNativeIntegritySamples()
    if (pluginProfileSource) {
      markStep("plugin checkpoint recording-early.start")
      capturePluginObservation("recording-early", early.native)
      markStep("plugin checkpoint recording-early.end")
    }
    const earlyStatus = nested(await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolStatuses.at(-1)??null)"]))
    const captureFailures = assessSpoolCapture(early.recording.transport, earlyStatus)
    if (captureFailures.length) throw new Error(`Native capture gate: ${captureFailures.join(",")}`)
    const pluginCheckpointTimers: ReturnType<typeof setTimeout>[] = []
    const pluginCheckpoints: Promise<void>[] = []
    if (pluginProfileSource) {
      // Fixed, bounded in-take checkpoints; every timer is cleared below.
      for (const checkpointMs of [15000, 30000, 45000]) {
        pluginCheckpoints.push(new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            markStep(`plugin checkpoint ${checkpointMs}ms.start`)
            void diagnostics().then((sample) => {
              capturePluginObservation(`recording-${checkpointMs}ms`, sample.native)
              markStep(`plugin checkpoint ${checkpointMs}ms.end`)
              resolve()
            }).catch(reject)
          }, Math.max(0, checkpointMs - (performance.now() - started)))
          pluginCheckpointTimers.push(timer)
        }))
      }
    }
    try {
      await Promise.all([
        backgroundState ? Promise.resolve() : delay(Math.max(0, 60000 - (performance.now() - started))),
        Promise.all(pluginCheckpoints),
      ])
    } finally {
      for (const timer of pluginCheckpointTimers) clearTimeout(timer)
    }
    if (backgroundState) {
      if (!windowControl || backgroundStartedAt === undefined || !captureWindowState)
        throw new Error("Capture window-state observation is incomplete.")
      const baselineViewport = result.viewport
      markStep("hiddenAtStart read.start")
      const hiddenAtStart = nested(await runBrowserCommand(["eval",
        "JSON.stringify({hidden:document.hidden,visibilityState:document.visibilityState})"]))
      markStep("hiddenAtStart read.end")
      markStep("AX observe start.start")
      const axAtStart = await windowControl.observe()
      markStep("AX observe start.end")
      const currentViewport = nested(await runBrowserCommand(["eval",
        "JSON.stringify({innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,body:{width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height}})"]))
      if (JSON.stringify(currentViewport) !== JSON.stringify(baselineViewport))
        throw new Error("Viewport or DPR changed during background capture.")
      await delay(Math.max(0, 60000 - (performance.now() - started)))
      markStep("hiddenAtEnd read.start")
      const hiddenAtEnd = nested(await runBrowserCommand(["eval",
        "JSON.stringify({hidden:document.hidden,visibilityState:document.visibilityState})"]))
      markStep("hiddenAtEnd read.end")
      markStep("AX observe end.start")
      const axAtEnd = await windowControl.observe()
      markStep("AX observe end.end")
      const hiddenDurationMs = performance.now() - backgroundStartedAt
      result.windowBackground = { ...result.windowBackground, state: backgroundState, captureWindowState,
        hiddenAtStart, hiddenAtEnd, axAtStart, axAtEnd, hiddenDurationMs, viewportUnchanged: true }
      result.visibilityEvents = nested(await runBrowserCommand(["eval", "JSON.stringify(window.__nativeSpoolVisibilityEvents??[])"]))
      if (hiddenDurationMs < 59000) throw new Error("Owned window was not backgrounded for the required capture interval.")
      if (backgroundState === "minimized" && (!hiddenAtStart.hidden || hiddenAtStart.visibilityState !== "hidden"
        || !hiddenAtEnd.hidden || hiddenAtEnd.visibilityState !== "hidden"))
        throw new Error("The owned app document was not hidden at both bounded observations.")
    }
    const late = await diagnostics()
    nativeIntegritySamples.push({ phase: "late", lifecycle: "recording-active", ...nativeIntegritySample(late.native) })
    await retainNativeIntegritySamples()
    if (pluginProfileSource) {
      markStep("plugin checkpoint recording-late.start")
      capturePluginObservation("recording-late", late.native)
      markStep("plugin checkpoint recording-late.end")
    }
    if (windowWasBackgrounded && windowControl) {
      markStep("restore.start")
      const restored = await windowControl.restore()
      markStep("restore.end")
      windowWasBackgrounded = false
      if (restored.minimized !== (backgroundState === "minimized"))
        throw new Error("Owned window restoration was not confirmed before Stop.")
      if (backgroundState === "occluded" && (restored.coveredIntervalMs ?? 0) < 59000)
        throw new Error("Owned opaque cover did not remain active for the capture interval.")
      result.windowBackground = { ...result.windowBackground, restoredBeforeStop: true, restored }
      result.visibilityEvents = nested(await runBrowserCommand(["eval", "JSON.stringify(window.__nativeSpoolVisibilityEvents??[])"]))
      if (backgroundState === "minimized") {
        const overflowEpochMs = z.number().nullable().parse(nested(await runBrowserCommand(["eval",
          "JSON.stringify(window.__nativeSpoolVisibilityOverflow?.()??null)"])))
        const captureEnteredAt = runnerStepMarks.find((mark) => mark.step === "capture.enter.start")?.epochMs ?? 0
        const restoreStartedAt = runnerStepMarks.findLast((mark) => mark.step === "restore.start")?.epochMs ?? Date.now()
        const visibilityEvents = z.array(z.object({ visibilityState: z.string(), hidden: z.boolean(), epochMs: z.number() })).parse(result.visibilityEvents)
        const intervalEvents = visibilityEvents.filter((event) => event.epochMs >= captureEnteredAt && event.epochMs < restoreStartedAt)
        const overflowedDuringCapture = overflowEpochMs !== null
          && overflowEpochMs >= captureEnteredAt && overflowEpochMs < restoreStartedAt
        result.visibilityGate = { overflowedDuringCapture, intervalEventCount: intervalEvents.length }
        if (overflowedDuringCapture || intervalEvents.some((event) => event.visibilityState === "visible" || !event.hidden))
          throw new Error("Minimized visibility event gate failed.")
      }
      captureMarksActive = false
    }
    const lateStatus = nested(await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolStatuses.at(-1)??null)"]))
    if (assessSpoolCapture(late.recording.transport, lateStatus).length || lateStatus.capturedFrames <= earlyStatus.capturedFrames) throw new Error("Native capture did not remain healthy and progress through sixty seconds.")
    const captureIntegrity = assessSpoolNativeIntegrity([early.native, late.native], incidentLines)
    if (captureIntegrity.length) throw new Error(`Native capture integrity: ${captureIntegrity.join(",")}`)
    if (incidentMalformed > 0) throw new Error("Native worker incident collection contained malformed events.")
    result.recordingDurationMs = performance.now() - started
    const budget = spoolObservationLimit(lateStatus.spool.writtenBytes)
    result.saveObservationLimit = budget
    stage = "stop-import-save-release"
    const stopStarted = performance.now()
    if (backgroundState) markStep("Stop recording click.start")
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop recording"])
    if (backgroundState) markStep("Stop recording click.end")
    // Size-aware bounded observation only; never Cancel/timeout the native Finish.
    await waitForBrowserValue(session, "window.__nativeSpoolReleaseEvents?.some(e=>e.kind==='release-success')?true:window.__nativeSpoolObservationFailure?{failed:true}:null", budget.timeoutMs)
    result.stopToSaveReleaseMs = performance.now() - stopStarted
    if (observer.error()) throw observer.error()
    const statuses = nested(await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolStatuses)"]))
    const complete = statuses.findLast((entry: { spool?: { state: number } }) => entry.spool?.state === 2)
    result.statuses = statuses
    const statusSummary = nested(await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolStatusSummary)"]))
    result.nativeStatusSummary = statusSummary
    result.statusOverwrites = statusSummary.overwritten
    if (!statusSummary.count || statusSummary.failed) throw new Error("Cumulative native status bounds/drop/spool gate failed.")
    result.import = nested(await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolImportEvidence)"]))
    result.releaseEvents = nested(await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolReleaseEvents)"]))
    const productDialog = z.string().parse(nested(await browserCommand(session, ["eval", "JSON.stringify(document.querySelector('[role=\"dialog\"]')?.textContent?.slice(0,256)??'')"])))
    result.dialog = productDialog
    release.succeeded = true
    if (!releasePrivate || !releaseInput || !proof) throw new Error("Missing observed proof/release.")
    await order.waitForTerminal(budget.timeoutMs)
    const durabilityIssues = assessSpoolDurability(order.evidence(), proof, {
      savedClipObserved: release.savedClipObserved, assetObserved: release.assetObserved,
      releaseCalls: release.calls, originalReleaseSucceeded: release.succeeded })
    release.receiptBeforeSourceUnlinkObserved = durabilityIssues.length === 0
    release.sourceAbsentAfter = await lstat(releasePrivate.nativeSource).then(() => false, (error) => error.code === "ENOENT")
    const receipt = JSON.parse(await readFile(releasePrivate.receiptFile, "utf8"))
    release.receiptPresent = true
    release.receiptMatchesAcknowledgment = JSON.stringify(receipt.acknowledgment) === JSON.stringify(releaseInput.acknowledgment)
    const postReleaseList = nested(await runBrowserCommand(["eval",
      `(async()=>{const scope=${JSON.stringify(releaseInput.scope)};const takeIds=[];let cursor;const seen=new Set();for(let page=0;page<64;page++){const r=await window.dawDesktop.audioHost.recordingSpool.list(scope,cursor);for(const take of r.takes)takeIds.push(take.takeId);if(r.nextCursor===null)return {takeIds,count:takeIds.length};if(seen.has(r.nextCursor))throw new Error('Recording-spool list cursor repeated.');seen.add(r.nextCursor);cursor=r.nextCursor}throw new Error('Recording-spool list exceeded its page bound.')})()`]))
    const postReleaseTakeIds = new Set(z.array(z.string()).parse(postReleaseList.takeIds))
    result.postReleaseTakeCount = z.number().int().nonnegative().parse(postReleaseList.count)
    release.listMatchesPreRecordAfter = nested(await runBrowserCommand(["eval",
      `JSON.stringify(${JSON.stringify(releaseInput.scope)}.projectId===${JSON.stringify(preRecordScope.projectId)}&&${JSON.stringify(releaseInput.scope)}.projectGeneration===${preRecordScope.projectGeneration})`])) === true
      && !preRecordTakeIds.has(releaseInput.takeId)
      && !postReleaseTakeIds.has(releaseInput.takeId)
      && postReleaseTakeIds.size === result.postReleaseTakeCount
      && postReleaseTakeIds.size === preRecordTakeIds.size
      && [...preRecordTakeIds].every((takeId) => postReleaseTakeIds.has(takeId))
    const issues = assessSpoolCompletion(complete ?? null, proof, release)
    issues.push(...durabilityIssues)
    issues.push(...assessSpoolProductDialog(productDialog))
    if (issues.length) throw new Error(`Spool completion/release gate: ${issues.join(",")}`)
    stage = "persisted-reload"
    const saved = await snapshot()
    const { clip, asset } = observeSavedSpoolClip({ beforeClips: before.clips, clips: saved.clips,
      assets: saved.assets, trackId: recordingTrackId ?? audio[0].id, savedClip: releaseInput.acknowledgment.savedClip })
    await observer.close(); observer = undefined
    await browserCommand(session, ["reload"])
    await waitForBrowserValue(session, `new URL(location.href).searchParams.get('projectId')===${JSON.stringify(projectId)}&&document.querySelector('[data-timeline-ruler="1"]')?true:null`, 30000)
    result.retainedSourcesNoticeAcknowledged = {
      ...result.retainedSourcesNoticeAcknowledged,
      afterReload: await acknowledgeNotice("afterReload"),
    }
    const reopened = await snapshot()
    const restored = observeSavedSpoolClip({ beforeClips: before.clips, clips: reopened.clips,
      assets: reopened.assets, trackId: audio[0].id, savedClip: releaseInput.acknowledgment.savedClip })
    if (JSON.stringify(restored.clip) !== JSON.stringify(clip) || JSON.stringify(restored.asset) !== JSON.stringify(asset))
      throw new Error("Reloaded saved clip or asset changed.")
    const decoded = recordedAudioContentSchema.parse(nested(await browserCommand(session, ["eval", recordedAudioContentScript(projectId, asset.id)])))
    if (assessNativeSpoolAsset(asset, decoded, proof).length) throw new Error("Reloaded recording content/proof mismatch.")
    result.decodedContent = decoded
    const afterNative = await diagnostics()
    nativeIntegritySamples.push({ phase: "after-reload", lifecycle: "post-reload-idle-unknown", ...nativeIntegritySample(afterNative.native) })
    await retainNativeIntegritySamples()
    const alreadyPlaying = nested(await browserCommand(session, ["eval", "JSON.stringify(!!document.querySelector('button[aria-label=\"Pause\"]'))"]))
    if (alreadyPlaying !== true) await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Pause\"]')?true:null", 15000)
    const reactivated = await diagnostics()
    nativeIntegritySamples.push({ phase: "after-reload-playing", lifecycle: "post-reload-active", ...nativeIntegritySample(reactivated.native) })
    await retainNativeIntegritySamples()
    const reactivatedProgress = await diagnostics()
    nativeIntegritySamples.push({ phase: "after-reload-playing-progress", lifecycle: "post-reload-active", ...nativeIntegritySample(reactivatedProgress.native) })
    await retainNativeIntegritySamples()
    const reactivationIssues = assessSpoolNativeIntegrity([reactivated.native, reactivatedProgress.native], incidentLines)
    if (pluginProfileSource && pluginTrackId && pluginInstanceId) {
      const reloadedInstances = desktopHostVstInstancesResultSchemaV1.parse(
        await command(profile, ["host", "vst-instances", projectId]),
      )
      if (!reloadedInstances.instances.some((instance) => instance.instanceId === pluginInstanceId
        && instance.targetId === pluginTrackId && instance.identity.name === "ValhallaSupermassive"
        && instance.health.state === "ready"))
        throw new Error("Reloaded plugin instance is not ready on its original stereo track.")
    }
    const postReloadVst = reactivated.native.status === "available"
      ? reactivated.native.diagnostics.vstWorkerPerformance : undefined
    const postReloadVstProgress = reactivatedProgress.native.status === "available"
      ? reactivatedProgress.native.diagnostics.vstWorkerPerformance : undefined
    const postReloadPluginActive = !pluginProfileSource || (
      postReloadVst?.activeWorkers === 1 && postReloadVstProgress?.activeWorkers === 1
      && BigInt(postReloadVst.observationCount) > 0n
      && BigInt(postReloadVstProgress.observationCount) > BigInt(postReloadVst.observationCount)
      && BigInt(postReloadVst.faults) === 0n && BigInt(postReloadVstProgress.faults) === 0n
      && BigInt(postReloadVst.watchdogMisses) === 0n && BigInt(postReloadVstProgress.watchdogMisses) === 0n
      && BigInt(postReloadVst.restarts) === 0n && BigInt(postReloadVstProgress.restarts) === 0n)
    if (pluginProfileSource && postReloadPluginActive && postReloadVst && postReloadVstProgress) {
      result.pluginIntegrity = [...result.pluginIntegrity ?? [], {
        phase: "post-reload-playing", activeWorkers: postReloadVst.activeWorkers,
        observationCount: postReloadVst.observationCount, faults: postReloadVst.faults,
        watchdogMisses: postReloadVst.watchdogMisses, restarts: postReloadVst.restarts,
      }, {
        phase: "post-reload-playing-progress", activeWorkers: postReloadVstProgress.activeWorkers,
        observationCount: postReloadVstProgress.observationCount, faults: postReloadVstProgress.faults,
        watchdogMisses: postReloadVstProgress.watchdogMisses, restarts: postReloadVstProgress.restarts,
      }]
    }
    const reactivationActive = reactivated.native.status === "available" && reactivatedProgress.native.status === "available"
      && reactivated.native.diagnostics.state === "running" && reactivatedProgress.native.diagnostics.state === "running"
      && reactivated.native.diagnostics.installedAssets > 0 && reactivatedProgress.native.diagnostics.installedAssets > 0
      && reactivated.native.diagnostics.activeRevision === reactivatedProgress.native.diagnostics.activeRevision
      && reactivated.native.diagnostics.transportEpoch === reactivatedProgress.native.diagnostics.transportEpoch
      && reactivated.native.diagnostics.callbacks < reactivatedProgress.native.diagnostics.callbacks
      && reactivated.native.diagnostics.transportFrame !== undefined && reactivatedProgress.native.diagnostics.transportFrame !== undefined
      && BigInt(reactivated.native.diagnostics.transportFrame) < BigInt(reactivatedProgress.native.diagnostics.transportFrame)
    if (!reactivationActive || !postReloadPluginActive || reactivationIssues.length || incidentMalformed > 0)
      throw new Error(`Post-reload native lifecycle integrity: ${[...reactivationIssues,
        ...(!reactivationActive ? ["active-lifecycle-progress"] : []),
        ...(!postReloadPluginActive ? ["plugin-worker-progress"] : []),
        ...(incidentMalformed > 0 ? ["incident-collector-malformed"] : [])].join(",")}`)
    const finalDialog = z.string().parse(nested(await browserCommand(session, ["eval",
      "JSON.stringify(document.querySelector('[role=\"dialog\"]')?.textContent?.slice(0,256)??'')"])))
    if (assessSpoolProductDialog(finalDialog).length) throw new Error("Product dialog appeared after reload.")
    result.dialog = finalDialog
    activeIntegrityPairs.push({ lifecycle: "recording", first: early.native, second: late.native })
    activeIntegrityPairs.push({ lifecycle: "post-reload-playback", first: reactivated.native, second: reactivatedProgress.native })
    await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])
    await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Play\"]')?true:null", 15000)
    stage = "normal-quit"
    await browserCommand(session, ["eval", "window.close()"])
    const normalExit = await waitForAcceptanceEvent(exit, 15000)
    if (!normalExit || normalExit.code !== 0 || normalExit.signal !== null) throw new Error("Normal window-close quit did not finish cleanly.")
    result.normalQuit = normalExit
    const finalIntegrityPairs = activeIntegrityPairs.map((pair) => ({
      lifecycle: pair.lifecycle,
      issues: assessSpoolNativeIntegrity([pair.first, pair.second], incidentLines),
    }))
    const finalIntegrityIssues = finalIntegrityPairs.flatMap((pair) => pair.issues.map((issue) => `${pair.lifecycle}:${issue}`))
    result.nativeIntegrityAssessment = {
      pairs: finalIntegrityPairs, incidentCount: incidentLines, incidentCollectorAvailable, incidentMalformed,
    }
    if (!incidentCollectorAvailable || incidentMalformed > 0 || finalIntegrityIssues.length)
      throw new Error(`Final native lifecycle integrity: ${finalIntegrityIssues.join(",") || "incident-collector-unavailable"}`)
    result.status = "complete"
  } catch (error) {
    result.error = (error instanceof Error ? error.message : String(error)).replace(/(?:\/Users\/|\/private\/|\/tmp\/)[^\s;,]*/g, "<private-path>").slice(0, 512)
    result.appOutputPresent = appOutput.length > 0
    if (observer?.error()) result.observerError = observer.error()?.message.replace(/(?:\/Users\/|\/private\/|\/tmp\/)[^\s;,]*/g, "<private-path>").slice(0, 512)
    if (attached) {
      if (stage === "record") result.recordingUiAfterAttempt = await browserCommand(session, ["eval",
        "JSON.stringify({startButtonPresent:!![...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Start recording'),stopButtonPresent:!![...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Stop recording'),dialogPresent:!!document.querySelector('[role=\"dialog\"]')})"])
        .then(nested).catch(() => null)
      const rendererConsole = await browserCommand(session, ["console"]).catch(() => "")
      const playbackDiagnosticLines = rendererConsole.split(/\r?\n/)
        .filter((line) => /native start failed|session\.start failed|native playback failed|native play skipped|prime-schedule/i.test(line))
        .slice(-12)
        .map((line) => line.replace(/(?:\/Users\/|\/private\/|\/tmp\/)[^\s;,"]*/g, "<private-path>").slice(0, 800))
      if (playbackDiagnosticLines.length > 0) result.rendererPlaybackDiagnostics = playbackDiagnosticLines
      const latestStatus = await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolStatuses?.at(-1)??null)"]).then(nested).catch(() => null)
      if (latestStatus !== null) result.latestStatus = latestStatus
      const imported = await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolImportEvidence??null)"]).then(nested).catch(() => null)
      if (imported !== null) result.import = imported
      const releaseEvents = await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolReleaseEvents??[])"]).then(nested).catch(() => [])
      if (Array.isArray(releaseEvents) && releaseEvents.length > 0) result.releaseEvents = releaseEvents
      const statuses = await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolStatuses??[])"]).then(nested).catch(() => [])
      if (Array.isArray(statuses) && statuses.length > 0) result.statuses = statuses
      const statusSummary = await browserCommand(session, ["eval", "JSON.stringify(window.__nativeSpoolStatusSummary??null)"]).then(nested).catch(() => null)
      if (statusSummary !== null) result.nativeStatusSummary = statusSummary
      const dialog = await browserCommand(session, ["eval", "JSON.stringify(document.querySelector('[role=\"dialog\"]')?.textContent?.slice(0,256)??'')"]).then(nested).catch(() => null)
      if (dialog !== null && dialog !== "") result.dialog = dialog
    }
    process.exitCode = 1
  } finally {
    order.close()
    await observer?.close().catch(() => undefined)
    result.stage = stage; result.proof = proof; result.release = release
    result.recordingStartEvidence = recordingStartEvidence
    result.receiptDurability = order.evidence(); result.incidents = incidents
    result.incidentCollection = {
      available: incidentCollectorAvailable, stdoutListenerAttached: app.stdout?.listenerCount("data") === 1,
      stderrListenerAttached: app.stderr?.listenerCount("data") === 1, totalLines: incidentLines,
      retainedEvents: incidents, overwrittenEvents: incidentOverwrites, malformedEvents: incidentMalformed,
    }
    // Preserve failed profiles/source ownership, never scavenge a retained take.
    // First request actual Electron window close; this is separate from owned cleanup.
    if (app.exitCode === null && app.signalCode === null) {
      if (attached) {
        if (windowWasBackgrounded && windowControl) {
          if (captureMarksActive) markStep("restore.start")
          await windowControl.restore().catch(() => undefined)
          if (captureMarksActive) markStep("restore.end")
          windowWasBackgrounded = false
        }
        if (backgroundState && result.visibilityGate === undefined)
          result.visibilityEvents = await browserCommand(session, ["eval",
            "JSON.stringify(window.__nativeSpoolVisibilityEvents??[])"]).then(nested).catch(() => null)
        await browserCommand(session, ["eval", "window.close()"]).catch(() => undefined)
        const normalExit = await waitForAcceptanceEvent(exit, 15000)
        if (normalExit) result.normalQuit = normalExit
      }
    }
    // If the app survives, cleanup may signal only independently verified owned processes.
    if (app.exitCode === null && app.signalCode === null) {
      result.cleanupFailed = !await stopOwnedSpoolProcesses({ directory: path.dirname(profile), rootPid: appPid, executable })
    }
    if (attached) await browserCommand(session, ["close"]).catch(() => undefined)
    await writePrivateArtifact(output, JSON.stringify(result, null, 2))
    console.log(`${result.status}: ${stage}; ${output}`)
  }
}
if (import.meta.main) await main()
