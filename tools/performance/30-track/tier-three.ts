import { createHash } from "node:crypto"
import type { ProjectSnapshotV2 } from "@daw-browser/control"
import { projectSnapshotSchemaV2, controlCapabilitiesSchemaV2, controlPreviewResultSchemaV1, controlCommitResultSchemaV1 } from "@daw-browser/control"
import { desktopHostVstInstancesResultSchemaV1, desktopHostVstParametersResultSchemaV1, desktopDiagnosticsSchemaV2 } from "@daw-browser/desktop-protocol"
import { browserCommand, waitForBrowserValue } from "../browser-harness"
import type { ProcessMetric } from "./electron"
import { z } from "zod"
import { analyzeTaskSourceEvidence, parseTaskSourceEvidence, taskSourceProbeScript, type TaskSourceEvidence } from "./task-source-liveness"

const longTaskEvidenceSchema = z.object({
  supported: z.boolean(),
  truncated: z.boolean(),
  intervals: z.array(z.object({ startEpochMs: z.number().finite(), endEpochMs: z.number().finite() }).strict()).max(64),
}).strict()
export const tierThreeAutomationObservationMs = 9_000
export const reEnableAutomationBeforePlayback = async (evaluate: (expression: string) => Promise<string>) => {
  const control = "[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')?.startsWith('Re-enable automation ('))"
  if ((await evaluate(`${control} !== undefined`)).trim() !== "true") return "control-absent" as const
  if ((await evaluate(`(()=>{const button=${control};if(!(button instanceof HTMLButtonElement))return false;button.click();return true})()`)).trim() !== "true") {
    throw new Error("Automation re-enable control disappeared.")
  }
  if ((await evaluate(`${control} !== undefined`)).trim() !== "false") throw new Error("Automation override was not cleared by visible UI.")
  return "ui-re-enabled" as const
}
export const collectLongTaskRecords = (
  evidence: z.infer<typeof longTaskEvidenceSchema>,
  records: readonly { startTime: number; duration: number }[],
  timeOrigin: number,
) => {
  for (const entry of records) {
    if (evidence.intervals.length === 64) { evidence.truncated = true; continue }
    evidence.intervals.push({ startEpochMs: timeOrigin + entry.startTime, endEpochMs: timeOrigin + entry.startTime + entry.duration })
  }
}
export const parseLongTaskEvidence = (encoded: string): z.infer<typeof longTaskEvidenceSchema> => {
  const first = z.string().max(20_000).parse(encoded)
  const nested = z.string().max(20_000).parse(JSON.parse(first))
  return longTaskEvidenceSchema.parse(JSON.parse(nested))
}

export const correlateRecordingStall = (
  worst: { returnedAtEpochMs: number; receivedAtEpochMs: number } | null,
  tasks: z.infer<typeof longTaskEvidenceSchema>,
) => {
  if (!worst || !tasks.supported || tasks.truncated) return "unknown" as const
  return tasks.intervals.some((task) => task.startEpochMs < worst.receivedAtEpochMs
    && task.endEpochMs > worst.returnedAtEpochMs) ? "renderer-longtask-overlap" as const : "no-observed-longtask-overlap" as const
}
export class TierThreeRecordingFailure extends Error {
  constructor(
    message: string,
    readonly longTasks: z.infer<typeof longTaskEvidenceSchema> | null,
    readonly stallCorrelation: ReturnType<typeof correlateRecordingStall>,
    readonly issue48LiveReEnableReason?: string,
    readonly workerAutomationAtPlayback: WorkerObservation | null = null,
    readonly taskSources: TaskSourceEvidence | null = null,
    readonly watchedMixAtPlayback: WatchedMixHost | null = null,
    readonly nativeAtPlayback: { transportEpoch: number; callbacks: number; submittedVstSegments: number | null; state: string } | null = null,
  ) {
    super(message)
  }
}

type Parameter = { id: number; title: string; readOnly: boolean; hidden: boolean; currentValue: number }
export const selectTierThreeParameter = <T extends Parameter>(parameters: readonly T[]): T => {
  const matches = parameters.filter((parameter) => parameter.title.toLowerCase() === "mix" && !parameter.readOnly && !parameter.hidden)
  if (matches.length !== 1 || !matches[0]) throw new Error("Unique writable Valhalla Mix parameter unavailable.")
  return matches[0]
}
export const selectTierThreeSecondaryParameter = <T extends Parameter>(parameters: readonly T[], mixId: number): T => {
  const parameter = parameters.find((candidate) => candidate.id !== mixId && !candidate.readOnly && !candidate.hidden)
  if (!parameter) throw new Error("Secondary writable Valhalla parameter unavailable.")
  return parameter
}

type MidiClip = { id: string; trackId: string; midi?: { notes: readonly { pitch: number; velocity: number; length: number }[] } }
export const validateTierThreeRecording = (before: readonly MidiClip[], after: readonly MidiClip[], trackId: string, pitches: readonly number[]): string => {
  const previous = new Set(before.map((clip) => clip.id))
  const recorded = after.filter((clip) => !previous.has(clip.id) && clip.trackId === trackId
    && clip.midi && pitches.every((pitch) => clip.midi?.notes.some((note) => note.pitch === pitch && note.velocity > 0 && note.length > 0)))
  if (recorded.length !== 1 || !recorded[0]) throw new Error("Deterministic MIDI recording was not persisted on the armed instrument track.")
  return recorded[0].id
}

type AudioClip = { id: string; trackId: string; duration: number; source?: { sourceKind: string } }
export const validateTierThreeAudioRecording = (
  before: readonly AudioClip[], after: readonly AudioClip[], trackId: string, capturedFrames: number, sampleRate: number,
): string => {
  if (capturedFrames <= 0 || sampleRate <= 0) throw new Error("Native recording did not capture audio frames.")
  const previous = new Set(before.map((clip) => clip.id))
  const recorded = after.filter((clip) => !previous.has(clip.id) && clip.trackId === trackId
    && clip.source?.sourceKind === "recording" && clip.duration > 0)
  if (recorded.length !== 1 || !recorded[0]) throw new Error("Native recording did not persist one audio take on the armed track.")
  return recorded[0].id
}

type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json }
type Command = (args: readonly string[], input?: string) => Promise<Json>
type Data = <T>(schema: z.ZodType<T>, value: Json) => T

type WorkerObservation = { instanceId: string; lastParameterId: number; transportEpoch: number; sequence: string; acceptedPoints: number }
type WatchedMixHost = { instanceId: string; transportEpoch: number; published: number; projected: number; overrideSkips: number; submitted: number }
export const retainTierThreeRecordingFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  error: unknown,
  reason: string,
  worker: WorkerObservation | null,
  host: WatchedMixHost | null,
  native: { transportEpoch: number; callbacks: number; submittedVstSegments: number | null; state: string },
) => error instanceof TierThreeRecordingFailure ? error : new TierThreeRecordingFailure(
  error instanceof Error ? error.message : "Native recording failed.",
  null, "unknown", reason, worker, null, host, native,
)
export const matchingWorkerAutomation = (
  observation: WorkerObservation | null, instanceId: string, parameterId: number, epoch: number, afterSequence: string,
): boolean => observation !== null && observation.instanceId === instanceId
  && observation.lastParameterId === parameterId && observation.transportEpoch === epoch
  && observation.acceptedPoints > 0 && BigInt(observation.sequence) > BigInt(afterSequence)

// Tier 3 is an opt-in packaged workload, not a Tier 1/2 performance gate.
// The app and its project/profile are created and owned by the enclosing Electron benchmark.
export const diagnosticStageFailure = (stage: string, error: Error) => new Error(
  `Tier 3 ${stage} diagnostics failed: ${error.message}`,
)
export const startTraceBeforeRecordingDiagnostics = async (
  read: () => Promise<void>, startTrace: () => Promise<void>,
) => {
  await startTrace()
  await read()
}
export const runTierThree = async (
  session: string, projectId: string, command: Command, data: Data,
  sampleProcesses: () => Promise<ProcessMetric[]>,
  aroundRecording?: <T>(work: () => Promise<T>) => Promise<T>,
  startRecordingTrace?: () => Promise<void>,
) => {
  const diagnostics = async (stage: string) => {
    try {
      return data(desktopDiagnosticsSchemaV2, await command(["host", "diagnostics-v2"]))
    } catch (error) {
      throw diagnosticStageFailure(stage, error instanceof Error ? error : new Error(String(error)))
    }
  }
  const capabilities = data(controlCapabilitiesSchemaV2, await command(["capabilities-v2", "--target", "host"]))
  if (!capabilities.actionKinds.includes("external-plugin.parameters.set")) throw new Error("Local VST parameter action not advertised.")
  const discovered = data(z.object({ projects: z.array(z.object({ projectId: z.string() })) }).passthrough(), await command(["project", "list", "--target", "host"]))
  if (!discovered.projects.some((project) => project.projectId === projectId)) throw new Error("Imported project not discoverable through desktop control.")

  await browserCommand(session, ["eval", "(()=>{const url=new URL(location.href);url.searchParams.set('dashboard','plugins');history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));return true})()"])
  await waitForBrowserValue(session, "document.body.textContent?.includes('VST3 Plug-ins') ? true : null", 30_000)
  await browserCommand(session, ["eval", "(()=>{const input=document.querySelector('input[type=checkbox]');if(!(input instanceof HTMLInputElement))throw new Error('VST3 trust acknowledgement UI unavailable.');input.click();return true})()"])
  await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[role=\"dialog\"] *')].find((e)=>e.textContent?.trim()==='Catalog scan');return row?.parentElement?.textContent?.match(/[1-9]\\d* VST3 bundles? discovered/) ? true : null})()", 60_000)
  await browserCommand(session, ["press", "Escape"])
  await waitForBrowserValue(session, "document.querySelector('[data-timeline-left-browser=\"1\"]') !== null ? true : null", 30_000)
  await browserCommand(session, ["eval", "(()=>{const button=document.querySelector('button[aria-label=\"Select track 31: Tier 2 Synth\"]');if(!(button instanceof HTMLButtonElement))throw new Error('Tier 2 track unavailable.');button.click();return true})()"])
  await browserCommand(session, ["eval", "(()=>{const tab=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((button)=>button.textContent?.trim()==='Effects');if(!(tab instanceof HTMLButtonElement))throw new Error('Effects browser tab unavailable.');tab.click();return true})()"])
  await browserCommand(session, ["fill", "[data-timeline-left-browser='1'] input[type='search']", "ValhallaSupermassive"])
  await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((b)=>b.textContent?.trim()==='ValhallaSupermassive');return row && !row.disabled ? true : null})()", 60_000)
  await browserCommand(session, ["find", "role", "button", "click", "--name", "ValhallaSupermassive"])
  await waitForBrowserValue(session, "(()=>{const row=[...document.querySelectorAll('[data-timeline-left-browser=\"1\"] button')].find((b)=>b.textContent?.trim()==='ValhallaSupermassive');return row?.getAttribute('aria-description')?.includes('Enabled · Preflight passed') ? true : null})()", 60_000)

  const readSnapshot = (): Promise<ProjectSnapshotV2> => command(["snapshot-v2", projectId, "--target", "host"]).then((value) => data(projectSnapshotSchemaV2, value))
  let snapshot = await readSnapshot()
  const tier2Track = snapshot.tracks.find((track) => track.name === "Tier 2 Synth" && track.kind === "instrument")
  if (!tier2Track) throw new Error("Tier 2 instrument track missing after insertion.")
  const processor = snapshot.processors.find((entry) => "trackId" in entry.target
    && entry.target.trackId === tier2Track.id && entry.processor.kind === "external-vst3"
    && entry.processor.params.identity.name === "ValhallaSupermassive")
  if (!processor) throw new Error("ValhallaSupermassive insertion was not persisted.")

  const instances = data(desktopHostVstInstancesResultSchemaV1, await command(["host", "vst-instances", projectId]))
  const instance = instances.instances.find((entry) => entry.targetId === tier2Track.id
    && entry.identity.classId === processor.processor.params.identity.classId
    && entry.identity.name === "ValhallaSupermassive")
  if (!instance || instance.health.state !== "ready") throw new Error("Real Valhalla worker is not ready.")
  const parameters = data(desktopHostVstParametersResultSchemaV1, await command(["host", "vst-parameters", projectId, instance.instanceId]))
  const mix = selectTierThreeParameter(parameters.parameters)
  const secondary = selectTierThreeSecondaryParameter(parameters.parameters, mix.id)
  const targetValue = mix.currentValue < 0.5 ? 0.75 : 0.25
  const request = {
    version: "v1",
    projectId,
    expectedRevision: snapshot.project.revision,
    actions: [{
      kind: "external-plugin.parameters.set",
      target: { kind: "track", track: { source: "persisted", id: tier2Track.id } },
      processor: { source: "persisted", id: processor.id },
      changes: [{ parameterId: mix.id, normalizedValue: targetValue }],
    }],
  }
  // Use the public CLI's stdin request transport: no request or approval tokens are written to disk.
  // The CLI adapter requires --request -; the enclosing command callback supplies stdin.
  const preview = data(controlPreviewResultSchemaV1, await command(["preview", "--request", "-", "--target", "host"], JSON.stringify(request)))
  if (preview.approval?.required) throw new Error("Unexpected VST parameter approval requirement; Tier 3 does not auto-approve.")
  const idempotencyKey = `tier3-${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`
  data(controlCommitResultSchemaV1, await command(["commit", "--request", "-", "--target", "host"], JSON.stringify({ ...request, idempotencyKey })))
  snapshot = await readSnapshot()
  const changed = snapshot.processors.find((entry) => entry.id === processor.id)
  if (changed?.processor.kind !== "external-vst3" || changed.processor.params.parameterOverrides[String(mix.id)] !== targetValue) {
    throw new Error("Public control did not persist the changed Valhalla Mix parameter.")
  }
  const updatedParameters = data(desktopHostVstParametersResultSchemaV1, await command(["host", "vst-parameters", projectId, instance.instanceId]))
  if (updatedParameters.parameters.find((parameter) => parameter.id === mix.id)?.currentValue !== targetValue) {
    throw new Error("Public Valhalla parameter projection did not match the committed value.")
  }
  if (!capabilities.actionKinds.includes("automation.set")) throw new Error("VST automation action not advertised.")
  const automationParameterId = `vst3:${instance.instanceId}:${mix.id}`
  const secondaryAutomationParameterId = `vst3:${instance.instanceId}:${secondary.id}`
  const automationRequest = {
    version: "v1",
    projectId,
    expectedRevision: snapshot.project.revision,
    actions: [{
      kind: "automation.set",
      target: { kind: "track", track: { source: "persisted", id: tier2Track.id } },
      effect: { source: "persisted", id: processor.id },
      parameterId: secondaryAutomationParameterId,
      enabled: true,
      points: [
        { id: "tier3-valhalla-secondary-0", timeSec: 0, value: 0.2, interpolation: "linear" },
        { id: "tier3-valhalla-secondary-30", timeSec: 30, value: 0.8, interpolation: "linear" },
      ],
    }, {
      kind: "automation.set",
      target: { kind: "track", track: { source: "persisted", id: tier2Track.id } },
      effect: { source: "persisted", id: processor.id },
      parameterId: automationParameterId,
      enabled: true,
      points: [
        { id: "tier3-valhalla-mix-0", timeSec: 0, value: 0.25, interpolation: "linear" },
        { id: "tier3-valhalla-mix-4", timeSec: 4, value: 0.75, interpolation: "linear" },
        { id: "tier3-valhalla-mix-8", timeSec: 8, value: 0.25, interpolation: "linear" },
        { id: "tier3-valhalla-mix-30", timeSec: 30, value: 0.75, interpolation: "linear" },
      ],
    }],
  }
  const automationPreview = data(controlPreviewResultSchemaV1, await command(["preview", "--request", "-", "--target", "host"], JSON.stringify(automationRequest)))
  if (automationPreview.approval?.required) throw new Error("Unexpected VST automation approval requirement.")
  data(controlCommitResultSchemaV1, await command(["commit", "--request", "-", "--target", "host"], JSON.stringify({
    ...automationRequest,
    idempotencyKey: `tier3-${createHash("sha256").update(JSON.stringify(automationRequest)).digest("hex")}`,
  })))
  snapshot = await readSnapshot()
  if (!snapshot.automation.some((entry) => entry.effectInstanceId === instance.instanceId
    && entry.parameterId === automationParameterId && entry.enabled && entry.points.length === 4)) {
    throw new Error("Valhalla automation was not persisted by public project control.")
  }
  if (!snapshot.automation.some((entry) => entry.effectInstanceId === instance.instanceId
    && entry.parameterId === secondaryAutomationParameterId && entry.enabled && entry.points.length === 2)) {
    throw new Error("Secondary Valhalla automation was not persisted by public project control.")
  }
  await browserCommand(session, ["reload"])
  await waitForBrowserValue(session, `new URL(location.href).searchParams.get('projectId') === ${JSON.stringify(projectId)} && document.querySelector('[data-timeline-left-browser="1"]') !== null ? true : null`, 30_000)
  await browserCommand(session, ["eval", "(()=>{const button=document.querySelector('button[aria-label=\"Select track 31: Tier 2 Synth\"]');if(!(button instanceof HTMLButtonElement))throw new Error('Tier 2 track unavailable after reload.');button.click();return true})()"])
  await waitForBrowserValue(session, `document.querySelector('[data-external-effect-id="${instance.instanceId}"]') !== null ? true : null`, 30_000)
  const prePlaybackReEnable = await reEnableAutomationBeforePlayback(
    (expression) => browserCommand(session, ["eval", expression]))
  const beforePlayback = await diagnostics("before-playback")
  const startedAt = performance.now()
  await browserCommand(session, ["find", "role", "button", "click", "--name", "Play"])
  await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Pause\"]') !== null ? true : null", 30_000)
  await new Promise((resolve) => setTimeout(resolve, tierThreeAutomationObservationMs))
  const duringPlayback = await sampleProcesses()
  const afterPlayback = await diagnostics("after-playback")
  const durationMs = performance.now() - startedAt
  if (beforePlayback.native.status !== "available" || afterPlayback.native.status !== "available"
    || afterPlayback.native.diagnostics.callbacks <= beforePlayback.native.diagnostics.callbacks
    || afterPlayback.native.diagnostics.rejectedBlocks > beforePlayback.native.diagnostics.rejectedBlocks) {
    throw new Error("Real VST playback did not advance native callbacks without rejected blocks.")
  }
  if (duringPlayback.length === 0) throw new Error("Runner-owned Electron process metrics unavailable for Tier 3 playback.")
  // Diagnostics retain only the latest worker observation; lack of a matching
  // observation cannot certify either suppression or resumed delivery.
  let issue48LiveReEnableCertification: "not-attempted" | "passed" = "not-attempted"
  let issue48LiveReEnableReason = "No matching worker-authored automation observation during uninterrupted playback."
  if (prePlaybackReEnable === "control-absent") {
    issue48LiveReEnableReason += " Initial parameter commit may have left an override; no visible re-enable control was available."
  }
  const initial = afterPlayback.native.diagnostics.workerAutomation
  const watchedMixAtPlayback = afterPlayback.native.diagnostics.watchedMixHost ?? null
  const nativeAtPlayback = {
    transportEpoch: afterPlayback.native.diagnostics.transportEpoch,
    callbacks: afterPlayback.native.diagnostics.callbacks,
    submittedVstSegments: afterPlayback.scheduler?.submittedVstSegments ?? null,
    state: afterPlayback.native.diagnostics.state,
  }
  const epoch = afterPlayback.native.diagnostics.transportEpoch
  if (afterPlayback.native.diagnostics.state === "running"
    && matchingWorkerAutomation(initial, instance.instanceId, mix.id, epoch, "0")) {
    const editVisibleParameter = async (title: string, value: number) => {
      await browserCommand(session, ["eval", `(()=>{const card=document.querySelector('[data-external-effect-id="${instance.instanceId}"]');if(!(card instanceof HTMLElement))throw new Error('Visible Valhalla device unavailable.');const show=[...card.querySelectorAll('button')].find(button=>button.textContent?.startsWith('Show parameters'));if(show instanceof HTMLButtonElement)show.click();const input=[...card.querySelectorAll('input[type="range"]')].find(element=>element.parentElement?.textContent?.includes(${JSON.stringify(title)}));if(!(input instanceof HTMLInputElement))throw new Error('Visible Valhalla parameter unavailable.');input.value=${JSON.stringify(String(value))};input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertReplacementText'}));return true})()`])
    }
    await editVisibleParameter(mix.title, targetValue === 0.75 ? 0.25 : 0.75)
    await waitForBrowserValue(session,
      "[...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='Re-enable automation (1)') ? true : null",
      10_000)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await editVisibleParameter(secondary.title, secondary.currentValue < 0.5 ? 0.75 : 0.25)
    await waitForBrowserValue(session,
      "[...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')==='Re-enable automation (2)') ? true : null",
      10_000)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const override = await diagnostics("after-manual-override")
    const current = override.native.status === "available" ? override.native.diagnostics : null
    const watchedOverride = current?.watchedMixHost
    const watchedBefore = watchedMixAtPlayback
    if (current?.state === "running" && current.transportEpoch === epoch
      && watchedOverride?.instanceId === instance.instanceId
      && watchedBefore?.instanceId === instance.instanceId
      && watchedOverride.overrideSkips > watchedBefore.overrideSkips) {
      await browserCommand(session, ["eval", "(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')==='Re-enable automation (2)');if(!(button instanceof HTMLButtonElement))throw new Error('Re-enable control disappeared');button.click();return true})()"])
      await new Promise((resolve) => setTimeout(resolve, 6_000))
      const overrideCleared = (await browserCommand(session, ["eval", "[...document.querySelectorAll('button')].some(button=>button.getAttribute('aria-label')?.startsWith('Re-enable automation (')) ? false : true"])).trim() === "true"
      const resumed = await diagnostics("after-re-enable")
      const watchedResumed = resumed.native.status === "available" ? resumed.native.diagnostics.watchedMixHost : null
      const workerResumed = resumed.native.status === "available" ? resumed.native.diagnostics.workerAutomation : null
      if (overrideCleared && resumed.native.status === "available" && resumed.native.diagnostics.state === "running"
        && resumed.native.diagnostics.transportEpoch === epoch
        && watchedResumed?.instanceId === instance.instanceId
        && (watchedResumed.submitted > watchedOverride.submitted
          || (watchedResumed.projected > watchedOverride.projected
            && watchedResumed.overrideSkips === watchedOverride.overrideSkips)
          || matchingWorkerAutomation(workerResumed, instance.instanceId, mix.id, epoch, initial.sequence))) {
        issue48LiveReEnableCertification = "passed"
        issue48LiveReEnableReason = "Two visible Valhalla edits produced native Mix override skips and the existing global control re-enabled both parameters while Mix resumed accepted scheduling without changing transport epoch."
      } else issue48LiveReEnableReason = `No newer accepted Mix submission after visible UI re-enable. Cleared=${overrideCleared}; before=${JSON.stringify(watchedOverride)}; after=${JSON.stringify(watchedResumed)}; worker=${JSON.stringify(workerResumed)}.`
    } else issue48LiveReEnableReason = "Visible Mix edit did not produce same-epoch native override skips."
  }
  await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop"])

  const beforeClips = snapshot.clips
  const audioTrack = snapshot.tracks.find((track) => track.kind === "audio")
  if (!audioTrack) throw new Error("No audio track available for native recording.")
  const audioIndex = snapshot.tracks.filter((track) => track.kind === "audio").findIndex((track) => track.id === audioTrack.id) + 1
  await browserCommand(session, ["eval", `(()=>{const button=document.querySelector(${JSON.stringify(`button[aria-label="Arm track ${audioIndex} for recording"]`)});if(!(button instanceof HTMLButtonElement))throw new Error('Audio track record-arm control is unavailable.');button.click();return true})()`])
  const record = async () => {
  const recordingBefore = await diagnostics("before-recording")
  await browserCommand(session, ["eval", taskSourceProbeScript()])
  if (aroundRecording) await browserCommand(session, ["eval", `(()=>{const evidence={supported:false,truncated:false,intervals:[]};window.__tier3LongTasks=evidence;if(!PerformanceObserver.supportedEntryTypes?.includes('longtask'))return;const observer=new PerformanceObserver((list)=>{for(const entry of list.getEntries()){if(evidence.intervals.length===64){evidence.truncated=true;continue}evidence.intervals.push({startEpochMs:performance.timeOrigin+entry.startTime,endEpochMs:performance.timeOrigin+entry.startTime+entry.duration})}});observer.observe({type:'longtask'});evidence.supported=true;window.__tier3LongTaskObserver=observer})()`])
  await browserCommand(session, ["find", "role", "button", "click", "--name", "Start recording"])
  await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Stop recording\"]') !== null ? true : null", 10_000)
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  let recordingEarly: Awaited<ReturnType<typeof diagnostics>> | undefined
  await startTraceBeforeRecordingDiagnostics(async () => {
    recordingEarly = await diagnostics("five-seconds-recording")
  }, startRecordingTrace ?? (async () => undefined))
  if (!recordingEarly) throw new Error("Five-second recording snapshot is unavailable.")
  const recordingEarlyActive = (await browserCommand(session, ["eval", "document.querySelector('button[aria-label=\"Stop recording\"]') !== null"])).trim() === "true"
  if (recordingEarlyActive) await new Promise((resolve) => setTimeout(resolve, 55_000))
  const recordingDuring = await diagnostics("after-sixty-seconds-recording")
  const taskSources = parseTaskSourceEvidence(await browserCommand(session, ["eval", "(()=>{const probe=window.__tier3TaskSourceProbe;delete window.__tier3TaskSourceProbe;return JSON.stringify(probe.stop())})()"]))
  const longTasks = aroundRecording ? parseLongTaskEvidence(await browserCommand(session, ["eval", `(()=>{const observer=window.__tier3LongTaskObserver;if(observer){const evidence=window.__tier3LongTasks;for(const entry of observer.takeRecords()){if(evidence.intervals.length===64){evidence.truncated=true;continue}evidence.intervals.push({startEpochMs:performance.timeOrigin+entry.startTime,endEpochMs:performance.timeOrigin+entry.startTime+entry.duration})}observer.disconnect()}delete window.__tier3LongTaskObserver;const evidence=window.__tier3LongTasks;delete window.__tier3LongTasks;return JSON.stringify(evidence)})()`])) : null
  const recordingStillActive = (await browserCommand(session, ["eval", "document.querySelector('button[aria-label=\"Stop recording\"]') !== null"])).trim() === "true"
  if (recordingStillActive) await browserCommand(session, ["find", "role", "button", "click", "--name", "Stop recording"])
  await waitForBrowserValue(session, "document.querySelector('button[aria-label=\"Start recording\"]') !== null ? true : null", 30_000)
  snapshot = await readSnapshot()
  const capturedFrames = (recordingDuring.recording.capturedFrames ?? 0) - (recordingBefore.recording.capturedFrames ?? 0)
  if (!recordingEarlyActive || !recordingStillActive) {
    throw new TierThreeRecordingFailure(`Native recording ended before requested stop: ${JSON.stringify({
      activeAtFiveSeconds: recordingEarlyActive,
      activeAtEnd: recordingStillActive,
      early: {
        frames: recordingEarly.recording.capturedFrames,
        sampleRate: recordingEarly.recording.activeSampleRate,
        deviceLost: recordingEarly.recording.deviceLost,
        failure: recordingEarly.recording.lastFailurePresent,
        dropped: recordingEarly.recording.droppedFrames,
      },
      end: {
        frames: recordingDuring.recording.capturedFrames,
        deviceLost: recordingDuring.recording.deviceLost,
        failure: recordingDuring.recording.lastFailurePresent,
      },
      newClipCount: snapshot.clips.filter((clip) => !beforeClips.some((before) => before.id === clip.id)).length,
    })}`, longTasks, longTasks ? correlateRecordingStall(recordingDuring.recording.writerReturnDeliveryWorst, longTasks) : "unknown", issue48LiveReEnableReason, initial, taskSources, watchedMixAtPlayback, nativeAtPlayback)
  }
  const recordedClipId = validateTierThreeAudioRecording(beforeClips, snapshot.clips, audioTrack.id, capturedFrames, recordingDuring.recording.activeSampleRate ?? 0)
  if (recordingDuring.recording.droppedFrames !== 0 || recordingDuring.recording.overrunFrames !== 0
    || recordingDuring.recording.lastFailurePresent) throw new Error("Native recording diagnostics reported dropped frames, overruns, or failure.")
  return { recordedClipId, capturedFrames, recordingDuring, longTasks, taskSources,
    stallCorrelation: longTasks ? correlateRecordingStall(recordingDuring.recording.writerReturnDeliveryWorst, longTasks) : "unknown" }
  }
  const captured = await (async () => {
    try {
      return aroundRecording ? await aroundRecording(async () => {
        try { return await record() } finally {
          await browserCommand(session, ["eval", "(()=>{window.__tier3LongTaskObserver?.disconnect();delete window.__tier3LongTaskObserver;delete window.__tier3LongTasks;window.__tier3TaskSourceProbe?.stop();delete window.__tier3TaskSourceProbe})()"]).catch(() => undefined)
        }
      }) : await record()
    } catch (error) {
      throw retainTierThreeRecordingFailure(error, issue48LiveReEnableReason, initial, watchedMixAtPlayback, nativeAtPlayback)
    }
  })()
  const { recordedClipId, capturedFrames, recordingDuring, longTasks, taskSources, stallCorrelation } = captured
  return {
    status: "complete" as const,
    plugin: { name: instance.identity.name, version: instance.identity.version, instanceId: instance.instanceId, health: instance.health.state },
    automation: { parameterId: mix.id, before: mix.currentValue, after: targetValue, points: [0, 4, 8, 30], revision: snapshot.project.revision },
    playback: {
      durationMs,
      nativeCallbackIncrease: afterPlayback.native.diagnostics.callbacks - beforePlayback.native.diagnostics.callbacks,
      processes: duringPlayback,
    },
    recording: { trackId: audioTrack.id, clipId: recordedClipId, capturedFrames, sampleRate: recordingDuring.recording.activeSampleRate,
      writerReturnDeliveryWorst: recordingDuring.recording.writerReturnDeliveryWorst, longTasks, stallCorrelation,
      taskSources: analyzeTaskSourceEvidence(taskSources, recordingDuring.recording.writerReturnDeliveryWorst) },
    issue48LiveReEnableCertification,
    issue48LiveReEnableReason,
    watchedMixAtPlayback,
    watchedMixProcessedAtPlayback: afterPlayback.native.diagnostics.watchedMixProcessed ?? null,
  }
}