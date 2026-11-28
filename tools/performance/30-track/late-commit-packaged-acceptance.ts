#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, writeSync } from "node:fs"
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { extractFile, listPackage } from "@electron/asar"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { z } from "zod"
import { controlCapabilitiesSchemaV2, controlErrorSchemaV1, projectCurrentResultSchema, projectSnapshotSchemaV2 } from "@daw-browser/control"
import { desktopDiagnosticsSchemaV2, desktopHostStatusSchemaV1, desktopHostVstInstancesResultSchemaV1, desktopTransportStatusSchemaV1, hostErrorSchemaV1 } from "@daw-browser/desktop-protocol"
import { browserCommand } from "../browser-harness"
import { cleanupSurvivors, createCleanupPlan, writePrivateArtifact } from "./electron"
import { ownedV3CdpEndpoint } from "./v3-import-acceptance"
import { command } from "./v3-import-workload"
import { stopOwnedSpoolProcesses } from "./native-spool-process"
import { installLateCommitObserver, instrumentLateCommitScript, StartupObservationInterrupted } from "./late-commit-observer"
import { acknowledgeRetainedSourcesNotice, nested, waitForAcceptanceEvent } from "./native-acceptance-ui"
import { rows } from "./v3-import-process"

const root = path.resolve(import.meta.dir, "../../..")
const executable = path.join(root, "apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app/Contents/MacOS/@daw-browser-desktop")
const asar = path.resolve(executable, "../../Resources/app.asar")
const approvedDigest = "9c960684fc6eb7d16f5086f68248a5658075c49f20faf41d9e85f2e2fa344473"
const staleDigest = "5daf7f7e0974c816af81dbdc452447819de680d39e803943f4701dcedf8618a3"
const observationSchema = z.object({
  held: z.boolean(), armed: z.boolean(), consumed: z.boolean(), overflow: z.boolean(),
  prepared: z.boolean().nullable(), active: z.boolean().nullable(), pendingOperations: z.number(),
  subscriptions: z.object({ meter: z.number(), spectrum: z.number(), schedule: z.number(), loss: z.number() }),
  counters: z.object({ begins: z.number(), commits: z.number(), starts: z.number(), stops: z.number(),
    teardowns: z.number(), mappedCreates: z.number(), leaseAcquires: z.number(), leaseReleases: z.number(),
    liveLeaseHandles: z.number(), duplicateLeaseReleases: z.number(), progressEvents: z.number(), faults: z.number() }),
  trace: z.array(z.object({ sequence: z.number(), epochMs: z.number(), event: z.string(), operation: z.string().optional(), ok: z.boolean().optional() })),
})
type Json = z.infer<ReturnType<typeof z.json>>
type DiscoveryCommand = "project current" | "host status" | "capabilities-v2" | "snapshot-v2"
const discoveryIssueCode = z.enum(["invalid_type", "invalid_value", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "custom"])
const discoveryIssuePath = z.enum(["", "project", "project.id", "project.kind", "project.projectId", "status", "ready", "transport", "capabilities", "capabilities.playback", "capabilities.diagnostics"])
type DiscoveryIssue = { code: z.infer<typeof discoveryIssueCode>; path: z.infer<typeof discoveryIssuePath> }
type DiscoveryMarker = "connection_unavailable" | "request_deadline" | "connection_closed"
  | "host_status_not_advertised" | "project_id_schema" | "missing_result" | "reply_schema"
const discoveryMarkers: { literal: string; marker: DiscoveryMarker }[] = [
  { literal: "Desktop control host is unavailable.", marker: "connection_unavailable" },
  { literal: "Desktop host request deadline exceeded.", marker: "request_deadline" },
  { literal: "Desktop host connection closed.", marker: "connection_closed" },
  { literal: "Desktop host does not advertise host.status.", marker: "host_status_not_advertised" },
  { literal: "Project IDs must be opaque URL-safe identifiers.", marker: "project_id_schema" },
  { literal: "Desktop host reply is missing a result.", marker: "missing_result" },
  { literal: "Invalid desktop host reply.", marker: "reply_schema" },
]
const safeDiscoveryIssues = (text: string): DiscoveryIssue[] => {
  const issue = z.object({ code: discoveryIssueCode, path: z.array(z.union([z.string(), z.number()])) }).passthrough()
  const issues: DiscoveryIssue[] = []
  const retain = (entry: z.infer<typeof issue>) => {
    const allowed = discoveryIssuePath.safeParse(entry.path.join("."))
    if (allowed.success) issues.push({ code: entry.code, path: allowed.data })
  }
  try {
    const entries = z.array(issue).max(30).safeParse(JSON.parse(text))
    if (entries.success) {
      entries.data.forEach(retain)
      return issues
    }
  } catch { /* Generic CLI errors may truncate a Zod issue array at 1000 characters. */ }
  if (text.startsWith("[")) {
    // Only complete allowlisted code/path pairs survive, never messages or values.
    for (const match of text.matchAll(/"code":\s*"([^"]+)"[\s\S]*?"path":\s*(\[[^\]]*\])/g)) {
      if (issues.length === 30) break
      try {
        const entry = issue.safeParse({ code: match[1], path: JSON.parse(match[2] ?? "") })
        if (entry.success) retain(entry.data)
      } catch { /* Incomplete pairs do not become evidence. */ }
    }
  }
  return issues
}
type DiscoveryCliError = {
  reason: "non_json_cli_error" | "cli_error_envelope_schema" | "cli_error_payload_schema" | "public_error";
  code?: z.infer<typeof controlErrorSchemaV1>["code"] | z.infer<typeof hostErrorSchemaV1>["code"];
  marker?: DiscoveryMarker; schemaIssues?: DiscoveryIssue[];
}
const safeDiscoveryError = (text: string, command: DiscoveryCommand): DiscoveryCliError => {
  let decoded: unknown
  try { decoded = JSON.parse(text) } catch { return { reason: "non_json_cli_error" } }
  const sourceCommand = command === "project current" ? "project" : command === "host status" ? "host" : command
  const envelope = z.object({ version: z.literal("v1"), ok: z.literal(false),
    command: z.literal(sourceCommand), error: z.unknown() }).strict().safeParse(decoded)
  if (!envelope.success) return { reason: "cli_error_envelope_schema" }
  const error = z.union([controlErrorSchemaV1, hostErrorSchemaV1]).safeParse(envelope.data.error)
  if (!error.success) return { reason: "cli_error_payload_schema" }
  return { reason: "public_error", code: error.data.code,
    marker: discoveryMarkers.find(entry => error.data.message.includes(entry.literal))?.marker,
    schemaIssues: safeDiscoveryIssues(error.data.message) }
}
type DiscoveryObservation = {
  command: DiscoveryCommand; exitCode: number; stage: string;
  outcome: "success" | "cli_failure" | "result_schema_invalid";
  canonicalStatus?: "absent" | "present"; error?: DiscoveryCliError; schemaIssues?: DiscoveryIssue[];
}
type StartupReadOutcome = { kind: "canonical-result"; value: z.infer<typeof projectCurrentResultSchema> }
  | { kind: "canonical-error" }
type StartupObserverFailure = { kind: "observer-failure" }
type PackagedLateCommitResult = {
  status: string; stage: string; inputProof: Json; expectedAsarSha256: string;
  samples: { phase: string; epochMs: number; observation?: Json; transport?: Json; native?: Json; scheduler?: Json; dialogPresent?: boolean }[];
  normalQuit?: Json; cleanupFailed?: boolean; cleanupErrors?: string[]; failure?: string;
  failureDetail?: { stage: string; code: string; exceptionCategory: string }; finalHashMatched?: boolean;
  fixtureBlocker?: string; retainedNoticeAcknowledged?: boolean; ownedSurvivors?: number;
  attemptKind: "diagnosis" | "formal-acceptance"; executedSourceSha256: string;
  finalProfileFree?: boolean;
  discovery?: { appTargetCount?: number; appTargetSelected?: boolean; canonicalRouteAgreement?: boolean; hostReady?: boolean };
  discoveryCommands?: DiscoveryObservation[];
  startupDiagnostics?: {
    registrationReturned: boolean;
    registrationMeaning: "registration-sequence-returned-not-readiness";
    exceptionOverflow: boolean;
    exceptions: { occurrence: number; category: "TypeError" | "RangeError" | "SyntaxError" | "Error" | "unknown" }[];
    nativeAcceptance: "unverified";
  };
}

const classifyFailure = (error: Error | null, stage: string) => {
  const message = error?.message ?? ""
  const code = message.includes("Target.createTarget") ? "target_create_unsupported"
    : message.includes("Kernel executable identity mismatch") ? "kernel_executable_mismatch"
    : message.includes("Owned renderer target readiness deadline") ? "renderer_ready_deadline"
    : message.includes("Ambiguous owned renderer targets") ? "renderer_target_ambiguous"
    : message.includes("Electron debugging endpoint identity does not match") ? "listener_identity_mismatch"
    : message.includes("Electron debugging endpoint has no listener") ? "listener_missing"
    : message.includes("Electron debugging endpoint is owned by another process") ? "listener_owner_mismatch"
    : message.includes("Electron root process exited") ? "root_absent"
    : message.includes("Electron process group is not runner-owned") ? "root_group_not_owned"
    : message.includes("Electron root executable identity") ? "root_executable_mismatch"
    : message.includes("Electron profile identity") ? "root_profile_mismatch"
    : message.includes("invalid browser target") ? "browser_target_invalid"
    : message.includes("Electron browser target capability is invalid") ? "browser_capability_invalid"
    : message.includes("Electron debugging capability file is invalid") ? "capability_file_invalid"
    : message.includes("Could not inspect the Electron debugging listener") ? "listener_inspection_failed"
    : message.includes("No owned process group") ? "cleanup_plan_missing"
    : error && "code" in error && error.code === "ENOENT" && stage === "listener-identity" ? "capability_file_absent"
    : error && "code" in error && error.code === "EACCES" && stage === "listener-identity" ? "capability_file_denied"
    : message.includes("Late Commit script interception") || message.includes("controller script was not intercepted")
      ? "observer_script_interception"
    : message.includes("script-ready observation deadline") ? "observer_script_ready_deadline"
    : message.includes("controller factory") || message.includes("native controller contract")
      || message.includes("Stretch lease call boundaries") ? "observer_bundle_schema_mismatch"
    : message.includes("Acceptance observation connection deadline") ? "inspector_connection_deadline"
    : message === "CONTROL_COMMAND_FAILED" ? "control_command_failed"
    : message === "RESULT_SCHEMA_INVALID" ? "result_schema_invalid"
    : message === "RENDERER_SELECTION_FAILED" ? "renderer_selection_failed"
    : message === "PROJECT_ROUTE_MISMATCH" ? "project_route_mismatch"
    : message === "HOST_NOT_READY" ? "host_not_ready"
    : message.includes("Unexpected product dialog") || message.includes("Fault dialog") ? "unexpected_dialog"
    : stage === "launch-readiness" && message.includes("readiness deadline") ? "launch_readiness_deadline"
    : stage === "launch-readiness" && message.includes("exited before debugging readiness") ? "launch_exited_early"
    : "unclassified_error"
  const name = error?.name ?? ""
  const exceptionCategory = name === "TypeError" || name === "RangeError" || name === "SyntaxError"
    ? name : error ? "Error" : "NonError"
  return { stage, code, exceptionCategory }
}

const verifyApprovedProfile = async (profile: string) => {
  const uid = process.getuid?.() ?? -1
  const privateDirectory = async (directory: string) => {
    const stat = await lstat(directory)
    return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o777) === 0o700
      && await realpath(directory) === path.join(await realpath(path.dirname(directory)), path.basename(directory))
  }
  const retained = path.dirname(profile)
  if (path.basename(profile) !== "profile" || !path.basename(retained).startsWith("daw-plugin-output-proof-")
    || !await privateDirectory(profile) || !await privateDirectory(retained))
    throw new Error("Approved disposable owner-only profile required.")
  let matches = 0
  let selected = false
  for (const entry of await readdir(path.dirname(retained), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("daw-plugin-output-proof-")) continue
    const candidate = path.join(path.dirname(retained), entry.name)
    if (!await privateDirectory(candidate) || !await privateDirectory(path.join(candidate, "profile")).catch(() => false)) continue
    const evidence = path.join(candidate, "plugin-active.png")
    const stat = await lstat(evidence).catch(() => undefined)
    if (!stat?.isFile() || stat.uid !== uid || stat.nlink !== 1) continue
    if (createHash("sha256").update(await readFile(evidence)).digest("hex") !== approvedDigest) continue
    matches++
    if (candidate === retained) selected = true
  }
  if (matches !== 1 || !selected) throw new Error("Exactly one approved disposable profile evidence match required.")
  for (const name of ["probe-stereo.wav", "enabled.wav", "bypassed.wav"]) {
    const stat = await lstat(path.join(retained, name))
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1)
      throw new Error("Approved trusted-plugin evidence set required.")
  }
  return { matches, ownerOnly: true, approvedEvidenceSha256: approvedDigest }
}

const verifyKernelExecutable = async (pid: number) => {
  const proc = dlopen("/usr/lib/libproc.dylib", {
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  })
  try {
    const bytes = Buffer.alloc(4096)
    const length = proc.symbols.proc_pidpath(pid, ptr(bytes), bytes.length)
    const actual = length > 0 ? bytes.toString("utf8", 0, length) : ""
    if (actual !== await realpath(executable)) throw new Error("Kernel executable identity mismatch.")
  } finally {
    proc.close()
  }
}

const verifyProfileFree = async (profile: string) => {
  const proc = dlopen("/usr/lib/libproc.dylib", {
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  })
  try {
    const inspection = Bun.spawn(["ps", "-ww", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" })
    const text = await new Response(inspection.stdout).text()
    if (await inspection.exited !== 0) throw new Error("Profile process inspection failed.")
    const canonicalExecutable = await realpath(executable)
    let matchingProfileProcesses = 0
    let packagedExecutableProcesses = 0
    for (const line of text.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (!match) continue
      const bytes = Buffer.alloc(4096)
      const length = proc.symbols.proc_pidpath(Number(match[1]), ptr(bytes), bytes.length)
      if (length > 0 && bytes.toString("utf8", 0, length) === canonicalExecutable) packagedExecutableProcesses++
      if (match[2]!.split(/\s+/).includes(`--user-data-dir=${profile}`)) matchingProfileProcesses++
    }
    if (matchingProfileProcesses || packagedExecutableProcesses)
      throw new Error("Approved profile or packaged executable is already in use.")
    return { matchingProfileProcesses, packagedExecutableProcesses }
  } finally { proc.close() }
}

const main = async () => {
  if (Bun.argv.length === 2 || (Bun.argv.length === 3 && Bun.argv[2] === "--help")) {
    console.log("Prepared only. Execution requires --execute, --diagnose-launch, --diagnose-discovery, or --diagnose-startup <absolute-new-result.json> <approved-profile> <final-ASAR-SHA256>.")
    return
  }
  const [flag, output, profile, expected] = Bun.argv.slice(2)
  if ((flag !== "--execute" && flag !== "--diagnose-launch" && flag !== "--diagnose-discovery" && flag !== "--diagnose-startup") || Bun.argv.length !== 6 || !output || !path.isAbsolute(output) || !output.endsWith(".json")
    || !profile || !path.isAbsolute(profile) || !expected || !/^[a-f0-9]{64}$/.test(expected) || expected === staleDigest)
    throw new Error("Explicit execution, absolute output/profile, and non-stale final ASAR SHA256 required.")
  for (const file of [output, `${output}.events.jsonl`, `${output}.failure.json`]) {
    const existing = await lstat(file).catch(() => undefined)
    if (!existing) continue
    if (file !== output || !existing.isFile() || existing.nlink !== 1
      || existing.uid !== (process.getuid?.() ?? -1) || (existing.mode & 0o777) !== 0o600 || existing.size !== 0)
      throw new Error("Output must be new private evidence or the empty wrapper-reserved result.")
  }
  const inputProof = await verifyApprovedProfile(profile)
  if (createHash("sha256").update(await readFile(asar)).digest("hex") !== expected)
    throw new Error("Final packaged ASAR identity mismatch.")
  if (flag === "--diagnose-startup") {
    const rendererEntries = listPackage(asar, { isPack: false }).filter((member) =>
      /^\/?\.vite\/renderer\/main_window\/assets\/index-[^/]+\.js$/.test(member))
    const rendererEntry = rendererEntries[0]
    if (rendererEntries.length !== 1 || !rendererEntry)
      throw new Error("Packaged renderer entry selection unavailable.")
    instrumentLateCommitScript(extractFile(asar, rendererEntry.replace(/^\//, "")).toString(), true)
  }
  const freeProfile = await verifyProfileFree(profile)
  const directory = path.dirname(output)
  const outputDirectory = await lstat(directory)
  if (!outputDirectory.isDirectory() || outputDirectory.uid !== process.getuid?.()
    || (outputDirectory.mode & 0o777) !== 0o700 || await realpath(directory) !== directory)
    throw new Error("Precreated canonical owner-only evidence directory required.")
  for (const file of [output, `${output}.failure.json`]) {
    if (file === output && await lstat(file).catch(() => undefined)) continue
    const artifact = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await artifact.close()
  }
  const chronology = await open(`${output}.events.jsonl`,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const record = (event: string, facts: Record<string, boolean | number> = {}) =>
    writeSync(chronology.fd, JSON.stringify({ epochMs: Date.now(), event, ...facts }) + "\n")
  const session = `daw-30-track-electron-late-commit-${crypto.randomUUID()}`
  const samples: PackagedLateCommitResult["samples"] = []
  const result: PackagedLateCommitResult = {
      status: "failed", stage: "launch-readiness", inputProof, expectedAsarSha256: expected, samples,
      attemptKind: flag === "--execute" ? "formal-acceptance" : "diagnosis",
      executedSourceSha256: createHash("sha256").update(await readFile(import.meta.path)).digest("hex"),
      discovery: { appTargetSelected: false, canonicalRouteAgreement: false, hostReady: false },
    }
  await writePrivateArtifact(output, JSON.stringify(result, null, 2))
  record("prelaunch-result-persisted", freeProfile)
  let observer: Awaited<ReturnType<typeof installLateCommitObserver>> | undefined
  let attached = false
  let ownership: Awaited<ReturnType<typeof ownedV3CdpEndpoint>>["plan"] | undefined
  let verifiedEndpoint: string | undefined
  // Only this fresh, explicitly approved disposable instance is launched. The
  // existing helper later verifies PID, executable, profile, PGID and listener.
  const app = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`], {
      cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile },
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    })
  const pid = app.pid
  if (!pid) throw new Error("Owned app PID unavailable.")
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const complete = (code: number | null, signal: NodeJS.Signals | null) => {
      record("app-exited", { exitCode: code ?? -1, signaled: signal !== null })
      resolve({ code, signal })
    }
    if (flag === "--diagnose-startup") app.once("exit", complete)
    else app.once("close", complete)
  })
  record("app-spawned")
  const browser = (...args: string[]) => browserCommand(session, args)
  const evalJson = async (expression: string) => {
    return nested(await browser("eval", `(async()=>JSON.stringify(await (${expression})))()`))
  }
  // DOM readiness is event-driven. No browser wait predicate or sampling loop.
  const dom = async (predicate: string) => evalJson(`new Promise(resolve=>{
    const check=()=>{if(${predicate}){watch.disconnect();resolve(true)}};
    const watch=new MutationObserver(check);watch.observe(document.documentElement,{childList:true,subtree:true,attributes:true});check()
  })`)
  const discoveryCommand = async <Value>(name: DiscoveryCommand, args: string[], schema: z.ZodType<Value>) => {
    // Same supported CLI, cwd and private environment as command(), but a single
    // attempt preserves the first failure before that helper truncates/retries it.
    const child = Bun.spawn(["bun", path.join(root, "packages/control-cli/dist/daw-control.js"), ...args], {
      cwd: root, env: { ...process.env, DAW_DESKTOP_USER_DATA: profile,
        DAW_CONTROL_AUTH_PATH: path.join(profile, "control-auth.json") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const exitCode = await child.exited
    const retain = (observation: DiscoveryObservation) => {
      (result.discoveryCommands ??= []).push(observation)
      writeSync(chronology.fd, JSON.stringify({ epochMs: Date.now(), event: "discovery-cli", ...observation }) + "\n")
    }
    if (exitCode !== 0) {
      retain({ command: name, exitCode, stage: result.stage, outcome: "cli_failure", error: safeDiscoveryError(stderr, name) })
      throw new Error("CONTROL_COMMAND_FAILED")
    }
    try {
      const envelope = z.object({ version: z.literal("v1"), ok: z.literal(true),
        command: z.literal(name), data: schema }).strict().safeParse(JSON.parse(stdout))
      if (!envelope.success) {
        retain({ command: name, exitCode, stage: result.stage, outcome: "result_schema_invalid",
          schemaIssues: safeDiscoveryIssues(JSON.stringify(envelope.error.issues.map(issue => ({
            code: issue.code, path: issue.path[0] === "data" ? issue.path.slice(1) : issue.path,
          })))) })
        throw new Error("RESULT_SCHEMA_INVALID")
      }
      const current = name === "project current" ? projectCurrentResultSchema.parse(envelope.data.data) : undefined
      retain({ command: name, exitCode, stage: result.stage, outcome: "success", canonicalStatus: current?.status })
      return envelope.data.data
    } catch (error) {
      if (error instanceof SyntaxError) {
        retain({ command: name, exitCode, stage: result.stage, outcome: "result_schema_invalid" })
        throw new Error("RESULT_SCHEMA_INVALID")
      }
      throw error
    }
  }
  const appRoute = (value: string) => {
    try {
      const url = new URL(value)
      return url.protocol === "daw:" && url.hostname === "app" && url.pathname === "/" && !url.hash
    } catch { return false }
  }
  const selectAppRenderer = async () => {
    let tabs: string
    try { tabs = await browser("tab") } catch { throw new Error("RENDERER_SELECTION_FAILED") }
    const candidates = [...tabs.matchAll(/^\s*(?:→\s*)?\[(t[0-9]+)\][^\n]*?\s(daw:\/\/app\/[^\s]*)\s*$/gm)]
      .flatMap((match) => match[1] && match[2] && appRoute(match[2])
        ? [{ handle: match[1], url: match[2] }] : [])
    result.discovery = { ...result.discovery, appTargetCount: candidates.length }
    record("renderer-target-discovery", { appTargetCount: candidates.length })
    if (candidates.length !== 1) throw new Error("RENDERER_SELECTION_FAILED")
    try {
      await browser("tab", candidates[0]!.handle)
      const selectedUrl = await browser("get", "url")
      if (selectedUrl !== candidates[0]!.url
        || !appRoute(selectedUrl))
        throw new Error("selected page mismatch")
    } catch { throw new Error("RENDERER_SELECTION_FAILED") }
    result.discovery = { ...result.discovery, appTargetSelected: true }
    record("renderer-target-selected", { appTargetSelected: true })
  }
  const waitForProjectRoute = async (projectId?: string) => evalJson(`new Promise(resolve=>{
    const ready=()=>{const url=new URL(location.href);return url.protocol==='daw:'&&url.hostname==='app'
      && ${projectId === undefined ? "!!url.searchParams.get('projectId')" : `url.searchParams.get('projectId')===${JSON.stringify(projectId)}`}
      && !!document.querySelector('[data-timeline-ruler="1"]');
    };
    const finish=()=>{if(!ready())return;watch.disconnect();removeEventListener('popstate',finish);resolve(true)};
    const watch=new MutationObserver(finish);watch.observe(document.documentElement,{childList:true,subtree:true,attributes:true});
    addEventListener('popstate',finish);finish()
  })`)
  const click = async (label: "Play" | "Pause" | "Stop") => {
    await observer?.invoke(`ui-${label.toLowerCase()}`)
    return evalJson(`(()=>{
    const buttons=[...document.querySelectorAll('button')].filter(b=>b.getAttribute('aria-label')===${JSON.stringify(label)});
    if(buttons.length!==1)throw new Error('Unique transport UI button required.');
    buttons[0].click();return true
    })()`)
  }
  const observe = async (operation: string) => {
    if (!observer) throw new Error("Acceptance observer unavailable.")
    return observationSchema.parse(await observer.invoke(operation))
  }
  const capture = async (phase: string, operation = "snapshot") => {
    const observation = await observe(operation)
    const transport = desktopTransportStatusSchemaV1.parse(await command(profile, ["host", "transport-status"]))
    const diagnostics = desktopDiagnosticsSchemaV2.parse(await command(profile, ["host", "diagnostics-v2"]))
    const native: Json = diagnostics.native.status === "available" ? {
      status: diagnostics.native.status, artifactVerification: diagnostics.native.artifactVerification.status,
      state: diagnostics.native.diagnostics.state, callbacks: diagnostics.native.diagnostics.callbacks,
      installedAssets: diagnostics.native.diagnostics.installedAssets, activeRevision: diagnostics.native.diagnostics.activeRevision,
      preparedRevision: diagnostics.native.diagnostics.preparedRevision, retiredRevision: diagnostics.native.diagnostics.retiredRevision,
      rejectedBlocks: diagnostics.native.diagnostics.rejectedBlocks, transportEpoch: diagnostics.native.diagnostics.transportEpoch,
      renderEpoch: diagnostics.native.diagnostics.renderEpoch, transportFrame: diagnostics.native.diagnostics.transportFrame ?? null,
      realtimePerformance: diagnostics.native.diagnostics.realtimePerformance ?? null,
      vstWorkerPerformance: diagnostics.native.diagnostics.vstWorkerPerformance ?? null,
    } : { status: diagnostics.native.status }
    const dialogPresent = z.boolean().parse(await evalJson("!!document.querySelector('[role=\"dialog\"]')"))
    samples.push({ phase, epochMs: Date.now(), observation, transport, native, scheduler: diagnostics.scheduler ?? null, dialogPresent })
    if (observation.overflow || observation.counters.faults || dialogPresent)
      throw new Error("Fault dialog, controller fault, or trace overflow.")
    return { observation, transport, native: diagnostics.native }
  }
  const stopped = (sample: Awaited<ReturnType<typeof capture>>) => {
    const { observation, transport } = sample
    if (observation.held || observation.prepared !== false || observation.active !== false
      || observation.pendingOperations || transport.state !== "stopped"
      || Object.values(observation.subscriptions).some((count) => count !== 0)
      || observation.counters.liveLeaseHandles !== 0
      || observation.counters.leaseAcquires !== observation.counters.leaseReleases
      || observation.counters.duplicateLeaseReleases)
      throw new Error("Stopped ownership/disposal settlement failed.")
  }
  const successfulStopAndTeardown = (observation: z.infer<typeof observationSchema>, after: number) => {
    const trace = observation.trace.filter((entry) => entry.sequence > after)
    const uiStop = trace.find((entry) => entry.event === "ui-request" && entry.operation === "stop")
    const stopRequest = trace.find((entry) => entry.event === "request" && entry.operation === "stop")
    const stopReply = trace.find((entry) => entry.event === "bridge-reply" && entry.operation === "stop")
    const teardownRequest = trace.find((entry) => entry.event === "request" && entry.operation === "teardown")
    const teardownReply = trace.find((entry) => entry.event === "bridge-reply" && entry.operation === "teardown")
    if (!uiStop || !stopRequest || !stopReply || !teardownRequest || !teardownReply
      || stopReply.ok !== true || teardownReply.ok !== true
      || uiStop.sequence >= stopRequest.sequence
      || stopRequest.sequence >= stopReply.sequence
      || stopReply.sequence >= teardownRequest.sequence
      || teardownRequest.sequence >= teardownReply.sequence)
      throw new Error("Successful original Stop and teardown replies were not observed for this phase.")
  }
  const cleanupErrors: string[] = []
  const cleanup = async (name: string, operation: () => Promise<void>) => {
    try { await operation() } catch {
      record(`cleanup-failed-${name}`)
      cleanupErrors.push(name)
      result.cleanupFailed = true
      process.exitCode = 1
    }
  }
  const quitThroughVerifiedBrowser = async () => {
    if (!verifiedEndpoint) throw new Error("Verified browser capability unavailable.")
    const socket = new WebSocket(verifiedEndpoint)
    socket.addEventListener("open", () => {
      record("diagnosis-normal-quit-requested")
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }))
    }, { once: true })
    socket.addEventListener("error", () => record("diagnosis-quit-socket-error"), { once: true })
    try {
      const quit = await waitForAcceptanceEvent(exited, 15000)
      result.normalQuit = quit
      if (!quit || quit.code !== 0 || quit.signal !== null) throw new Error("Normal quit failed.")
    } finally { socket.close() }
  }
  const recordDiscoveryUi = async () => {
    const readiness = z.object({ documentReady: z.boolean(), routeHasProject: z.boolean(),
      timelinePresent: z.boolean(), dialogPresent: z.boolean() }).strict().parse(await evalJson(`({
        documentReady:document.readyState!=='loading',
        routeHasProject:!!new URL(location.href).searchParams.get('projectId'),
        timelinePresent:!!document.querySelector('[data-timeline-ruler="1"]'),
        dialogPresent:!!document.querySelector('[role="dialog"]')
      })`))
    record("discovery-ui-readiness", readiness)
  }
  try {
    // Electron emits this readiness event after binding its ephemeral CDP port.
    // No ACK is intercepted, and no launch polling is installed.
    let clearReadiness = () => {}
    let announcedEndpoint = ""
    const readiness = new Promise<true>((resolve, reject) => {
      let tail = ""
      const data = (chunk: Buffer) => {
        tail = (tail + chunk.toString()).slice(-4096)
        const announcement = tail.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)(?:\r?\n|$)/)
        if (announcement?.[1]) {
          announcedEndpoint = announcement[1]
          record("stderr-debugging-announcement")
          cleanup(); resolve(true)
        }
      }
      const failed = () => { cleanup(); reject(new Error("Owned app exited before debugging readiness.")) }
      const cleanup = () => {
        app.stderr?.off("data", data); app.off("close", failed); app.off("error", failed)
      }
      clearReadiness = cleanup
      app.stderr?.on("data", data)
      app.once("close", failed); app.once("error", failed)
    })
    try {
      if (!await waitForAcceptanceEvent(readiness, 30000)) throw new Error("Owned launch readiness deadline.")
    } finally { clearReadiness() }
    // Drain output without retaining project IDs, profile paths or capabilities.
    app.stdout?.resume(); app.stderr?.resume()
    result.stage = "kernel-executable-identity"
    await verifyKernelExecutable(pid)
    record("kernel-executable-verified")
    result.stage = "listener-identity"
    const { endpoint, plan } = await ownedV3CdpEndpoint(profile, pid, executable, { announcedEndpoint, observe: record })
    ownership = plan
    verifiedEndpoint = endpoint
    record("listener-identity-verified")
    if (flag === "--diagnose-launch") {
      result.stage = "diagnosis-quit"
      // Quit only through the positively verified browser capability. Reuse the
      // existing deterministic exit deadline; no renderer or fixture is touched.
      await quitThroughVerifiedBrowser()
      result.status = "diagnosis-complete"
      return
    }
    result.stage = "install-observer"
    observer = await installLateCommitObserver(endpoint, flag === "--diagnose-startup")
    const installationInterruption = observer?.diagnosticInterrupted()
    if (flag === "--diagnose-startup" && observer && installationInterruption)
      throw new StartupObservationInterrupted(observer.diagnosticSnapshot(), installationInterruption)
    // Observer installation waits for the unique owned renderer and completes
    // the response interception/reload before agent-browser can issue CDP calls.
    result.stage = "browser-connect"
    if (!observer) throw new Error("Startup observer unavailable.")
    const activeObserver = observer
    const startupStep = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
      if (flag !== "--diagnose-startup") return operation()
      const existingInterruption = activeObserver.diagnosticInterrupted()
      if (existingInterruption)
        throw new StartupObservationInterrupted(activeObserver.diagnosticSnapshot(), existingInterruption)
      return Promise.race([
        operation(),
        activeObserver.closed.then(() => {
          throw new StartupObservationInterrupted(activeObserver.diagnosticSnapshot(), "observer-failure")
        }),
        activeObserver.diagnosticInterruption.then((reason) => {
          const diagnostic = activeObserver.diagnosticSnapshot()
          throw new StartupObservationInterrupted(diagnostic, reason)
        }),
      ])
    }
    await startupStep(() => browser("connect", endpoint)); attached = true
    result.stage = "renderer-selection"
    await startupStep(() => selectAppRenderer())
    result.stage = "renderer-ui-readiness"
    await startupStep(() => dom("document.readyState!=='loading'"))
    if (flag === "--diagnose-startup") {
      result.stage = "startup-project-current"
      const firstRead: Promise<StartupReadOutcome> = discoveryCommand(
        "project current", ["project", "current", "--target", "host"], projectCurrentResultSchema,
      ).then((value) => ({ kind: "canonical-result", value }), () => ({ kind: "canonical-error" }))
      const outcome = await Promise.race([
        firstRead,
        activeObserver.closed.then((): StartupObserverFailure => ({ kind: "observer-failure" })),
        activeObserver.diagnosticInterruption.then((kind) => ({ kind })),
      ])
      if (outcome.kind === "exception" || outcome.kind === "observer-failure") await firstRead
      const diagnostic = activeObserver.diagnosticSnapshot()
      result.startupDiagnostics = {
        ...diagnostic, registrationMeaning: "registration-sequence-returned-not-readiness",
        nativeAcceptance: "unverified",
      }
      if (outcome.kind === "exception" || outcome.kind === "observer-failure") {
        result.stage = outcome.kind === "exception" ? "startup-renderer-exception" : "startup-observer-failure"
        result.failureDetail = { stage: result.stage, code: outcome.kind, exceptionCategory: "unknown" }
        result.failure = "Startup diagnosis stopped at the first bounded observer interruption."
        process.exitCode = 1
        await writePrivateArtifact(output, JSON.stringify(result, null, 2))
        return
      }
      if (outcome.kind === "canonical-error") {
        result.stage = "startup-project-current-cli-failure"
        result.failure = "The first canonical project-current request failed; startup diagnosis stopped."
        const observation = result.discoveryCommands?.at(-1)
        const code = observation?.outcome === "result_schema_invalid" ? "result_schema_invalid"
          : observation?.outcome === "cli_failure" ? "control_command_failed" : "unclassified_error"
        result.failureDetail = { stage: result.stage, code, exceptionCategory: "Error" }
        process.exitCode = 1
        await writePrivateArtifact(output, JSON.stringify(result, null, 2))
        return
      }
      result.stage = "startup-project-current-result"
      result.status = "diagnosis-complete"
      await writePrivateArtifact(output, JSON.stringify(result, null, 2))
      return
    }
    if (flag === "--diagnose-discovery") await recordDiscoveryUi()
    result.stage = "fixture-current-project"
    let mounted = await discoveryCommand("project current", ["project", "current", "--target", "host"], projectCurrentResultSchema)
    if (mounted.status !== "present") {
      result.stage = "fixture-projects-navigation"
      await evalJson(`(()=>{
        const url=new URL(location.href);url.searchParams.set('dashboard','projects');
        history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));return true
      })()`)
      result.stage = "fixture-projects-list-readiness"
      await dom("!!document.querySelector('article button')")
      result.stage = "fixture-project-open"
      await evalJson(`(()=>{
        const buttons=[...document.querySelectorAll('article button')];
        if(buttons.length!==3)throw new Error('Exactly one approved local project must be present in Projects UI.');
        buttons[0].click();return true
      })()`)
      result.stage = "fixture-project-open-route"
      await waitForProjectRoute()
      const routeProjectId = await evalJson("new URL(location.href).searchParams.get('projectId')")
      result.discovery = { ...result.discovery, canonicalRouteAgreement: false }
      mounted = await discoveryCommand("project current", ["project", "current", "--target", "host"], projectCurrentResultSchema)
      const canonicalRouteAgreement = mounted.status === "present" && mounted.project.projectId === routeProjectId
      result.discovery = { ...result.discovery, canonicalRouteAgreement }
      record("canonical-route-agreement", { canonicalRouteAgreement })
      if (!canonicalRouteAgreement) throw new Error("PROJECT_ROUTE_MISMATCH")
    }
    if (mounted.status !== "present") throw new Error("Public mounted project unavailable.")
    result.stage = "fixture-renderer-route-reconciliation"
    await evalJson(`(()=>{
      const url=new URL(location.href);
      if(url.searchParams.get('projectId')!==${JSON.stringify(mounted.project.projectId)}){
        url.searchParams.set('projectId',${JSON.stringify(mounted.project.projectId)});
        history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'))
      }
      return true
    })()`)
    await waitForProjectRoute(mounted.project.projectId)
    result.stage = "fixture-route-canonical-verification"
    result.discovery = { ...result.discovery, canonicalRouteAgreement: false }
    const reconciled = await discoveryCommand("project current", ["project", "current", "--target", "host"], projectCurrentResultSchema)
    const canonicalRouteAgreement = reconciled.status === "present"
      && reconciled.project.projectId === mounted.project.projectId
      && await evalJson(`new URL(location.href).searchParams.get('projectId')===${JSON.stringify(mounted.project.projectId)}`) === true
    result.discovery = { ...result.discovery, canonicalRouteAgreement }
    record("canonical-route-agreement", { canonicalRouteAgreement })
    if (!canonicalRouteAgreement) throw new Error("PROJECT_ROUTE_MISMATCH")
    result.stage = "fixture-host-ready"
    result.discovery = { ...result.discovery, hostReady: false }
    const host = await discoveryCommand("host status", ["host", "status"], desktopHostStatusSchemaV1)
    result.discovery = { ...result.discovery, hostReady: host.ready }
    record("host-readiness", { hostReady: host.ready })
    if (!host.ready) throw new Error("HOST_NOT_READY")
    result.stage = "fixture-capabilities"
    const capabilities = await discoveryCommand("capabilities-v2", ["capabilities-v2", "--target", "host"], controlCapabilitiesSchemaV2)
    if (!capabilities.actionKinds.length) throw new Error("Public capability discovery unavailable.")
    result.stage = "fixture-snapshot"
    const snapshot = await discoveryCommand("snapshot-v2", ["snapshot-v2", mounted.project.projectId, "--target", "host"], projectSnapshotSchemaV2)
    if (flag === "--diagnose-discovery") {
      await recordDiscoveryUi()
      result.stage = "discovery-diagnosis-quit"
      await observer.close(); observer = undefined
      await quitThroughVerifiedBrowser()
      result.status = "diagnosis-complete"
      return
    }
    result.stage = "fixture-stretch-discovery"
    if (!snapshot.clips.some((clip) => clip.audioWarp?.enabled && clip.audioWarp.mode === "stretch" && clip.source)) {
      result.fixtureBlocker = "Construct suitable Stretch audio input through capability/snapshot/preview/approval/keyed commit or ordinary UI; runner does not create or mutate project fixtures."
      throw new Error("BLOCKER: construct a suitable Stretch audio fixture through authorized project-control or ordinary UI.")
    }
    const plugins = snapshot.processors.filter((entry) => entry.processor.kind === "external-vst3"
      && entry.processor.params.identity.name === "ValhallaSupermassive" && !entry.processor.params.bypassed)
    result.stage = "fixture-plugin-discovery"
    if (plugins.length !== 1) throw new Error("Exactly one existing enabled trusted ValhallaSupermassive required.")
    result.stage = "fixture-ui-readiness"
    await dom("!!document.querySelector('button[aria-label=\"Stop\"]')")
    result.stage = "fixture-retained-source-notice"
    result.retainedNoticeAcknowledged = await acknowledgeRetainedSourcesNotice(session, "beforePlayback")
    result.stage = "fixture-dialog-clear"
    await dom("!document.querySelector('[role=\"dialog\"]')")
    await click("Stop")
    stopped(await capture("initial-stop", "stop-settled"))
    result.stage = "late-commit-stop"
    const initial = await observe("arm")
    await click("Play")
    const held = await observe("held")
    samples.push({ phase: "commit-held", epochMs: Date.now(), observation: held })
    if (held.counters.begins !== initial.counters.begins + 1 || held.counters.commits !== initial.counters.commits + 1
      || held.counters.mappedCreates <= initial.counters.mappedCreates
      || !held.trace.some((entry) => entry.sequence > initial.trace.length
        && entry.operation === "createMappedAsset" && entry.event === "bridge-reply" && entry.ok === true)
      || held.counters.leaseAcquires <= initial.counters.leaseAcquires || held.counters.liveLeaseHandles < 1
      || held.counters.starts !== initial.counters.starts)
      {
        result.fixtureBlocker = "A fresh transaction with actual mapped creation and acquired Stretch lease was not observed; fixture needs authorized preparation."
        throw new Error("Fresh mapped/Stretch transaction coverage missing.")
      }
    await click("Stop")
    await observe("stopped")
    const whileHeld = await capture("stop-teardown-before-delivery")
    successfulStopAndTeardown(whileHeld.observation, held.trace.length)
    if (!whileHeld.observation.held || whileHeld.observation.prepared !== false
      || whileHeld.transport.state !== "stopped"
      || !whileHeld.observation.trace.some((entry) => entry.sequence > held.trace.length
        && entry.operation === "stop" && entry.event === "bridge-reply" && entry.ok === true))
      throw new Error("Actual Stop and teardown must complete while successful Commit delivery is held.")
    await observe("release")
    const settled = await capture("canceled-settled", "settle")
    stopped(settled)
    if (settled.observation.counters.starts !== initial.counters.starts)
      throw new Error("Canceled Start resurrection observed.")
    const canceledTrace = settled.observation.trace.filter((entry) => entry.sequence > initial.trace.length)
    const stageSequence = (event: string, operation?: string, after = 0) => canceledTrace.find((entry) =>
      entry.sequence > after && entry.event === event
      && (operation === undefined || entry.operation === operation))?.sequence ?? -1
    const delivered = stageSequence("renderer-delivery", "commitTransaction")
    const ordered = [
      stageSequence("bridge-reply", "commitTransaction"), stageSequence("delivery-held", "commitTransaction"),
      stageSequence("request", "stop"), stageSequence("bridge-reply", "teardown"),
      stageSequence("gate-release"), delivered,
      stageSequence("lease-release-completed", undefined, delivered), stageSequence("ownership-settled"),
    ]
    if (ordered.some((sequence, index) => sequence < 0 || (index > 0 && sequence <= ordered[index - 1]!))
      || canceledTrace.some((entry) => entry.event === "subscribe" && (entry.operation === "meter" || entry.operation === "spectrum")))
      throw new Error("Canceled reply/disposal ordering or retired subscription publication failed.")
    result.stage = "next-play"
    await click("Play")
    await observe("progress")
    const first = await capture("next-play-active", "settle")
    await observe("progress")
    const second = await capture("next-play-progress")
    if (!first.observation.prepared || !first.observation.active || first.transport.state !== "playing"
      || first.observation.counters.starts !== initial.counters.starts + 1
      || first.observation.counters.commits !== held.counters.commits + 1
      || second.observation.counters.progressEvents <= first.observation.counters.progressEvents
      || first.native.status !== "available" || second.native.status !== "available")
      throw new Error("Next Play did not prepare/start actual native playback.")
    const a = first.native.diagnostics
    const b = second.native.diagnostics
    const av = a.vstWorkerPerformance
    const bv = b.vstWorkerPerformance
    if (first.native.artifactVerification.status !== "verified" || second.native.artifactVerification.status !== "verified"
      || a.state !== "running" || b.state !== "running" || b.callbacks <= a.callbacks
      || !a.installedAssets || !b.installedAssets || a.activeRevision !== b.activeRevision
      || a.transportEpoch !== b.transportEpoch
      || !a.transportFrame || !b.transportFrame || BigInt(b.transportFrame) <= BigInt(a.transportFrame)
      || a.rejectedBlocks || b.rejectedBlocks || !av || !bv || av.activeWorkers !== 1 || bv.activeWorkers !== 1
      || BigInt(bv.observationCount) <= BigInt(av.observationCount)
      || [av, bv].some((value) => BigInt(value.faults) || BigInt(value.watchdogMisses) || BigInt(value.restarts)))
      throw new Error("Native callback/schedule/plugin progress gate failed.")
    const instances = desktopHostVstInstancesResultSchemaV1.parse(await command(profile, ["host", "vst-instances", mounted.project.projectId]))
    if (!instances.instances.some((instance) => instance.identity.name === "ValhallaSupermassive" && instance.health.state === "ready"))
      throw new Error("Trusted real plugin instance not ready on next Play.")
    const runningOwnership = createCleanupPlan(await rows(), pid)
    if (!runningOwnership || runningOwnership.processGroupId !== ownership?.processGroupId)
      throw new Error("Owned native/plugin process lineage unavailable.")
    ownership = runningOwnership
    result.stage = "ordinary-pause-resume"
    await click("Pause")
    await dom("!!document.querySelector('button[aria-label=\"Play\"]')")
    const paused = await capture("ordinary-pause", "settle")
    if (paused.transport.state !== "paused" || !paused.observation.prepared
      || paused.observation.counters.starts !== second.observation.counters.starts)
      throw new Error("Ordinary prepared pause failed.")
    await click("Play")
    await observe("progress")
    const resumed = await capture("ordinary-resume", "settle")
    if (resumed.transport.state !== "playing" || !resumed.observation.prepared
      || resumed.observation.counters.starts !== second.observation.counters.starts)
      throw new Error("Ordinary prepared resume failed.")
    result.stage = "ordinary-stop-quit"
    const ordinaryStopBoundary = (await observe("snapshot")).trace.length
    await click("Stop")
    const ordinaryStop = await capture("ordinary-stop", "stop-settled")
    successfulStopAndTeardown(ordinaryStop.observation, ordinaryStopBoundary)
    stopped(ordinaryStop)
    await observer.close(); observer = undefined
    await browser("eval", "window.close()")
    const quit = await waitForAcceptanceEvent(exited, 15000)
    result.normalQuit = quit
    if (!quit || quit.code !== 0 || quit.signal !== null) throw new Error("Normal quit failed.")
    result.finalHashMatched = createHash("sha256").update(await readFile(asar)).digest("hex") === expected
    if (!result.finalHashMatched) { result.cleanupFailed = true; cleanupErrors.push("package-identity-changed") }
    if (!result.finalHashMatched) throw new Error("Packaged ASAR changed during execution.")
    result.status = "complete"
  } catch (error) {
    // No exception text is persisted: CLI/CDP errors can contain private paths.
    result.failure = `Acceptance gate failed at ${result.stage}; no coverage is claimed beyond retained observations.`
    if (error instanceof StartupObservationInterrupted) {
      result.startupDiagnostics = {
        ...error.diagnostics, registrationMeaning: "registration-sequence-returned-not-readiness",
        nativeAcceptance: "unverified",
      }
      result.stage = error.reason === "exception" ? "startup-renderer-exception" : "startup-observer-failure"
      result.failureDetail = { stage: result.stage, code: error.reason, exceptionCategory: "unknown" }
      result.failure = "Startup diagnosis stopped at the first bounded observer interruption."
    } else result.failureDetail = classifyFailure(error instanceof Error ? error : null, result.stage)
    record(`failure-${result.failureDetail.code}`)
    try {
      await writePrivateArtifact(`${output}.failure.json`, JSON.stringify(result, null, 2))
    } catch {
      console.error("Failure sidecar could not be persisted; the original result will still be retained.")
      process.exitCode = 1
    }
    try {
      await writePrivateArtifact(output, JSON.stringify(result, null, 2))
    } catch {
      console.error("Acceptance result could not be persisted before cleanup; final persistence will be retried.")
      process.exitCode = 1
    }
    if (observer && flag !== "--diagnose-discovery" && flag !== "--diagnose-startup") samples.push({ phase: "failure-observation", epochMs: Date.now(),
      observation: await observer.invoke("snapshot").catch(() => null) })
    process.exitCode = 1
  } finally {
    // Discovery diagnosis never attempts transport, so cleanup must not invent a
    // Stop request or signal processes. Formal acceptance retains its cleanup.
    if (observer && attached && flag !== "--diagnose-discovery" && flag !== "--diagnose-startup") await cleanup("stop-ui", async () => { await click("Stop") })
    await cleanup("observer-close", async () => {
      await observer?.close()
      observer = undefined
    })
    if (app.exitCode === null && app.signalCode === null
      && (flag === "--diagnose-discovery" || flag === "--diagnose-startup")) {
      await cleanup("discovery-normal-quit", quitThroughVerifiedBrowser)
    } else if (app.exitCode === null && app.signalCode === null && attached) {
      await cleanup("window-close", async () => { await browser("eval", "window.close()") })
      await cleanup("normal-quit-wait", async () => {
        result.normalQuit = await waitForAcceptanceEvent(exited, 15000)
      })
    }
    if (app.exitCode === null && app.signalCode === null && flag !== "--diagnose-discovery" && flag !== "--diagnose-startup") await cleanup("owned-process-stop", async () => {
      await verifyKernelExecutable(pid)
      record("owned-cleanup-requested")
      const stopped = await stopOwnedSpoolProcesses({ directory: path.dirname(profile), rootPid: pid, executable })
      record("owned-cleanup-completed", { stopped })
      if (!stopped) throw new Error("Owned process cleanup did not complete.")
    })
    if (ownership) {
      await cleanup("owned-process-verification", async () => {
        const remaining = await rows()
        const ownedGroup = ownership!.processGroupId
        result.ownedSurvivors = new Set([
          ...cleanupSurvivors(ownership!, remaining),
          ...remaining.filter((row) => row.processGroupId === ownedGroup).map((row) => row.pid),
        ]).size
        record("owned-process-survivors", { count: result.ownedSurvivors })
        if (result.ownedSurvivors) throw new Error("Owned process survivors remain.")
      })
    }
    if (attached) await cleanup("browser-disconnect", async () => { await browser("close") })
    const finalProfile = await verifyProfileFree(profile).catch(() => null)
    result.finalProfileFree = finalProfile !== null
    record("final-profile-check", { free: finalProfile !== null })
    if (!finalProfile) { result.cleanupFailed = true; cleanupErrors.push("profile-process-survivors") }
    try {
      result.finalHashMatched = createHash("sha256").update(await readFile(asar)).digest("hex") === expected
      if (!result.finalHashMatched && !cleanupErrors.includes("package-identity-changed")) {
        result.cleanupFailed = true
        cleanupErrors.push("package-identity-changed")
      }
    } catch {
      result.cleanupFailed = true
      if (!cleanupErrors.includes("package-identity-unverified")) cleanupErrors.push("package-identity-unverified")
      process.exitCode = 1
    }
    if (result.cleanupFailed) { result.status = "failed"; process.exitCode = 1 }
    if (cleanupErrors.length) result.cleanupErrors = cleanupErrors
    try {
      await writePrivateArtifact(output, JSON.stringify(result, null, 2))
    } catch {
      console.error("Acceptance artifact could not be persisted; no result artifact is claimed.")
      process.exitCode = 1
    }
    if (flag === "--diagnose-startup") {
      await chronology.sync()
      const persistedResult = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await persistedResult.sync() } finally { await persistedResult.close() }
      if (cleanupErrors.length > 0 && app.exitCode === null && app.signalCode === null) {
        app.stdout?.destroy()
        app.stderr?.destroy()
        app.unref()
      }
    }
    console.log(`${result.status}: ${result.stage}`)
    await chronology.close()
  }
}
if (import.meta.main) {
  try { await main() } catch {
    console.error("Late Commit acceptance preflight failed. Check explicit arguments, private input ownership, and final package hash.")
    process.exitCode = 1
  }
}
