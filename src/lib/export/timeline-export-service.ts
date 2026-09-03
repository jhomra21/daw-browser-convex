import { isLocalId, resolveClipSampleUrl, type ExportAudioFormat } from "@daw-browser/shared"
import type { ExportRange } from "@daw-browser/audio-engine/export-range"
import type { StemMode } from "@daw-browser/audio-engine/export-mixdown"
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types"
import type { RuntimeClip, RuntimeTrack } from "~/lib/timeline-runtime-types"
import type { ExportEncodingSettings, ExportRenderSettings } from "~/lib/export/export-settings"
import type { ExportOutputTargetFactory } from "~/lib/export/export-output-targets"
import { cloneExportEffectsProjection, createExportRenderStateSnapshot, NATIVE_EXPORT_UNAVAILABLE_MESSAGE, snapshotCloudRenderRows, type ExportAutomationPatch, type ExportCloudRenderRowsSnapshot, type ExportOutcome, type ExportProgress, type ExportRenderStateSnapshot, runStemExport, runTimelineExport } from "~/lib/export/run-export-job"
import type { ExportQueue } from "~/lib/export/export-queue"
import type { CapturedClipBufferLoadResult, CapturedClipMediaReference } from "~/hooks/useClipBuffers"
import type { EffectsPanelExportSnapshot } from "~/components/timeline/create-effects-panel-controller"
import { flushMidiProjectWrites, projectMidiProjectTracks } from "~/lib/midi/editor-persistence"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import type { NativeOfflinePcmRenderer } from "~/lib/export/desktop-native-offline-pcm-renderer"
import { snapshotAutomationPatches, snapshotExportSettings, snapshotSidechainRoutes, snapshotTimelineTracks } from "~/lib/export/timeline-export-snapshot"
import { preflightExportResources } from "~/lib/export/export-resource-preflight"
import { getLocalProject } from "~/lib/local-project-db"
import type { SampledInstrumentRegionBudget, SampledInstrumentRegionBudgetScope } from "~/lib/sampled-instrument-region-budget"
import type { SampledInstrumentSession } from "~/lib/sampled-instrument-session"
import {
  sampledInstrumentRegionBytes,
  sampledInstrumentRetainedBytes,
  type SampledInstrumentBuffer,
} from "@daw-browser/audio-engine/sampled-instrument-region"

type TimelineExportDependencies = {
  queue: ExportQueue
  nativeRendererRequired?: boolean
  runTimelineExport?: typeof runTimelineExport
  getTracks: () => RuntimeTrack[]
  getProjectGeneration: () => number
  createBuffer?: (channels: number, frames: number, sampleRate: number) => AudioBuffer
  getBpm: () => number
  getTimeSignature?: () => { numerator: number; denominator: number }
  getMasterVolume: () => number
  getProjectId: () => string | undefined
  getUserId: () => string | undefined
  getCloudRenderRows: () => ExportCloudRenderRowsSnapshot | undefined
  getAutomationPatches: () => readonly ExportAutomationPatch[]
  getEffectsExportSnapshot: () => EffectsPanelExportSnapshot | undefined
  getSidechainRoutes: () => ExternalSidechainRoute[]
  loadCapturedClipBuffer: (reference: CapturedClipMediaReference, signal: AbortSignal) => Promise<CapturedClipBufferLoadResult>
  nativeOfflinePcmRenderer?: NativeOfflinePcmRenderer
  sampledInstrumentSession?: Pick<SampledInstrumentSession, "createExportScope">
  sampledInstrumentRegionBudget?: SampledInstrumentRegionBudget
  getNativeOfflineExternalAttachments?: (input: {
    projectId: string | undefined
    localProject: boolean
    tracks: readonly RuntimeTrack[]
    renderState: ExportRenderStateSnapshot
    bpm: number
    timeSignature: { numerator: number; denominator: number }
    sidechainRoutes: readonly ExternalSidechainRoute[]
  }) => Promise<{
    plan: NativeExternalAttachmentPlan
    capturedVstStates?: readonly {
      instanceId: string
      bytes: Uint8Array
      sha256: string
    }[]
  } | undefined>
}

type ExportSettings = {
  range: ExportRange
  formats: readonly ExportAudioFormat[]
  render: ExportRenderSettings
  encoding: ExportEncodingSettings
}

export type TimelineExportInput = ExportSettings & { name?: string }
export type TimelineStemExportInput = TimelineExportInput
  & ({ stemSelection: "all-tracks"; stemMode: StemMode }
    | { stemSelection: "selected-tracks"; stemMode: StemMode; selectedTrackIds: readonly string[] })

export type TimelineExportJobStatus = {
  id: string
  status: "queued" | "running" | "completed" | "canceled" | "failed"
  progress?: ExportProgress
  outcome?: ExportOutcome
}

type SubmittedExport = {
  id: string
  completion: Promise<ExportOutcome>
}

type ExportPreparationStage =
  | "flush-midi"
  | "flush-effects"
  | "render-state"
  | "local-project"
  | "native-attachments"

const traceExportPreparation = async <Value>(
  traceId: string,
  stage: ExportPreparationStage,
  run: () => Promise<Value>,
): Promise<Value> => {
  const startedAt = performance.now()
  console.info("[export-preparation] start", { traceId, stage })
  try {
    const value = await run()
    console.info("[export-preparation] complete", {
      traceId,
      stage,
      elapsedMs: Math.round(performance.now() - startedAt),
    })
    return value
  } catch (error) {
    console.error("[export-preparation] failed", {
      traceId,
      stage,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "Unknown export preparation failure.",
    })
    throw error
  }
}

const snapshotStemInput = (input: TimelineStemExportInput): TimelineStemExportInput => {
  const settings = snapshotExportSettings(input)
  if (input.stemSelection === "all-tracks") {
    return {
      ...settings,
      name: input.name,
      stemSelection: input.stemSelection,
      stemMode: input.stemMode,
    }
  }
  return {
    ...settings,
    name: input.name,
    stemSelection: input.stemSelection,
    stemMode: input.stemMode,
    selectedTrackIds: [...input.selectedTrackIds],
  }
}

type ExportRequestSnapshot = {
  settings: ExportSettings
  tracks: RuntimeTrack[]
  projectGeneration: number
  bpm: number
  timeSignature?: { numerator: number; denominator: number }
  masterVolume: number
  projectId: string | undefined
  userId: string | undefined
  sidechainRoutes: ExternalSidechainRoute[]
  renderStateSnapshot: ExportRenderStateSnapshot
  snapshotClips: Map<string, RuntimeTrack["clips"][number]>
}

export type PreparedTimelineExport = {
  kind: "timeline"
  name: string
  snapshot: ExportRequestSnapshot
}

export type PreparedStemExport = {
  kind: "stems"
  name: string
  input: TimelineStemExportInput
  snapshot: PreparedTimelineExport["snapshot"]
}

export type TimelineExportService = {
  enqueueTimelineExport: (input: TimelineExportInput, outputTargets: ExportOutputTargetFactory) => Promise<ExportOutcome>
  enqueueStemExport: (input: TimelineStemExportInput, outputTargets: ExportOutputTargetFactory) => Promise<ExportOutcome>
  submitTimelineExport: (input: TimelineExportInput, outputTargets: ExportOutputTargetFactory) => Promise<SubmittedExport>
  submitStemExport: (input: TimelineStemExportInput, outputTargets: ExportOutputTargetFactory) => Promise<SubmittedExport>
  prepareTimelineExport: (input: TimelineExportInput) => Promise<PreparedTimelineExport>
  prepareStemExport: (input: TimelineStemExportInput) => Promise<PreparedStemExport>
  submitPreparedTimelineExport: (prepared: PreparedTimelineExport, outputTargets: ExportOutputTargetFactory) => SubmittedExport
  submitPreparedStemExport: (prepared: PreparedStemExport, outputTargets: ExportOutputTargetFactory) => SubmittedExport
  releasePreparedExport?: (prepared: PreparedTimelineExport | PreparedStemExport) => void
  cancel: (jobId: string) => void
  status: (jobId?: string) => TimelineExportJobStatus | undefined
}

export const createTimelineExportService = (dependencies: TimelineExportDependencies): TimelineExportService => {
  const jobs = new Map<string, TimelineExportJobStatus>()
  const preparedScopes = new WeakMap<object, SampledInstrumentRegionBudgetScope>()
  const collectSampledInstrumentBuffers = (renderState: ExportRenderStateSnapshot): { sampled: SampledInstrumentBuffer; mirrors: number }[] => {
    const buffers: { sampled: SampledInstrumentBuffer; mirrors: number }[] = []
    for (const entry of Object.values(renderState.fx.trackFx ?? {})) {
      for (const buffer of entry.samplerBuffers?.values() ?? []) buffers.push({ sampled: buffer, mirrors: 1 })
      for (const buffer of entry.drumRackBuffers?.values() ?? []) buffers.push({ sampled: buffer, mirrors: 1 })
      if (entry.granularBuffer) {
        buffers.push({
          sampled: {
            buffer: entry.granularBuffer.buffer,
            sourceStartFrame: entry.granularBuffer.sourceStartFrame,
            sourceIdentity: entry.granularBuffer.sourceIdentity,
          },
          mirrors: 2,
        })
      }
    }
    return buffers
  }
  const createPreparedScope = (renderState: ExportRenderStateSnapshot) => {
    const scope = dependencies.sampledInstrumentSession?.createExportScope()
      ?? dependencies.sampledInstrumentRegionBudget?.createScope(`prepared-export:${crypto.randomUUID()}`)
    if (!scope) return undefined
    try {
      const buffers = collectSampledInstrumentBuffers(renderState)
      scope.lease(buffers.map(({ sampled, mirrors }, index) => ({
        key: sampled.sourceIdentity ?? `buffer:${index}`,
        buffer: sampled.buffer,
        bytes: sampledInstrumentRetainedBytes(sampledInstrumentRegionBytes({
          sourceStartFrame: sampled.sourceStartFrame,
          sourceEndFrame: sampled.sourceStartFrame + sampled.buffer.length,
        }, sampled.buffer.numberOfChannels), mirrors),
      })))
      return scope
    } catch (error) {
      scope.release()
      throw error
    }
  }
  const assertStemRendererAvailable = () => {
    if (dependencies.nativeRendererRequired) {
      throw new Error("Native desktop stems are unavailable in Phase A; choose Main mixdown.")
    }
  }
  const assertNativeMixdownAvailable = () => {
    if (dependencies.nativeRendererRequired && !dependencies.nativeOfflinePcmRenderer) {
      throw new Error(NATIVE_EXPORT_UNAVAILABLE_MESSAGE)
    }
  }
  const snapshotRequest = async (settings: ExportSettings) => {
    let preparedScope: SampledInstrumentRegionBudgetScope | undefined
    try {
    const traceId = crypto.randomUUID()
    console.info("[export-preparation] begin", { traceId, native: dependencies.nativeRendererRequired === true })
    let projectId = dependencies.getProjectId()
    let projectGeneration = dependencies.getProjectGeneration()
    let tracks: RuntimeTrack[] | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (projectId) {
        await traceExportPreparation(traceId, "flush-midi", () => flushMidiProjectWrites(projectId!))
      }
      if (
        dependencies.getProjectId() === projectId
        && dependencies.getProjectGeneration() === projectGeneration
      ) {
        const currentTracks = dependencies.getTracks()
        tracks = projectId ? projectMidiProjectTracks(projectId, currentTracks) : currentTracks
        if (
          dependencies.getProjectId() === projectId
          && dependencies.getProjectGeneration() === projectGeneration
        ) break
      }
      projectId = dependencies.getProjectId()
      projectGeneration = dependencies.getProjectGeneration()
    }
    if (
      !tracks
      || dependencies.getProjectId() !== projectId
      || dependencies.getProjectGeneration() !== projectGeneration
    ) {
      throw new Error("Project changed while preparing export.")
    }
    const snapshotClips = new Map<string, RuntimeTrack["clips"][number]>()
    const capturedTracks = snapshotTimelineTracks(tracks)
    for (const track of capturedTracks) {
      for (const clip of track.clips) snapshotClips.set(clip.id, clip)
    }
    preflightExportResources({
      tracks: capturedTracks,
      range: settings.range,
      formats: settings.formats,
      render: settings.render,
      encoding: settings.encoding,
      stemCount: 1,
    })
    const effectsSnapshot = dependencies.getEffectsExportSnapshot()
    if (effectsSnapshot) {
      await traceExportPreparation(traceId, "flush-effects", () => effectsSnapshot.flushPending())
    }
    if (
      dependencies.getProjectId() !== projectId
      || dependencies.getProjectGeneration() !== projectGeneration
    ) {
      throw new Error("Project changed while preparing export.")
    }
    const userId = dependencies.getUserId()
    const bpm = dependencies.getBpm()
    const timeSignature = dependencies.getTimeSignature?.() ?? { numerator: 4, denominator: 4 }
    const masterVolume = dependencies.getMasterVolume()
    const cloudRows = snapshotCloudRenderRows(dependencies.getCloudRenderRows())
    const effectsProjection = effectsSnapshot
      ? cloneExportEffectsProjection(effectsSnapshot.snapshotEffectsProjection())
      : undefined
    const automationPatches = snapshotAutomationPatches(dependencies.getAutomationPatches())
    const sidechainRoutes = snapshotSidechainRoutes(effectsSnapshot?.snapshotSidechainRoutes() ?? dependencies.getSidechainRoutes())
    const renderStateSnapshot = await traceExportPreparation(traceId, "render-state", () => createExportRenderStateSnapshot({
      projectId,
      userId,
      masterVolume,
      externalPluginPolicy: dependencies.nativeRendererRequired ? "native-offline" : undefined,
      cloudRows,
      effectsProjection,
      automationPatches,
    }))
    const hydratedRenderStateSnapshot = effectsSnapshot?.hydrateInstrumentBuffers?.(renderStateSnapshot) ?? renderStateSnapshot
    preparedScope = createPreparedScope(hydratedRenderStateSnapshot)
    const localProject = projectId
      ? isLocalId("project", projectId) || await traceExportPreparation(
        traceId,
        "local-project",
        () => getLocalProject(projectId!),
      ) !== undefined
      : false
    const nativeExternalAttachments = dependencies.nativeRendererRequired && dependencies.getNativeOfflineExternalAttachments
      ? await traceExportPreparation(traceId, "native-attachments", () => dependencies.getNativeOfflineExternalAttachments!({
        projectId: projectId ?? "",
        localProject,
        tracks: capturedTracks,
        renderState: hydratedRenderStateSnapshot,
        bpm,
        timeSignature,
        sidechainRoutes,
      }))
      : undefined
    if (
      dependencies.getProjectId() !== projectId
      || dependencies.getProjectGeneration() !== projectGeneration
    ) {
      throw new Error("Project changed while preparing export.")
    }
    console.info("[export-preparation] complete", { traceId })
    return {
      scope: preparedScope,
      snapshot: {
        settings: snapshotExportSettings(settings),
        tracks: capturedTracks,
        projectGeneration,
        bpm,
        timeSignature,
        masterVolume,
        projectId,
        userId,
        sidechainRoutes,
        renderStateSnapshot: nativeExternalAttachments
          ? {
            ...hydratedRenderStateSnapshot,
            nativeExternalAttachments: nativeExternalAttachments.plan,
            capturedVstStates: nativeExternalAttachments.capturedVstStates ? nativeExternalAttachments.capturedVstStates : undefined,
          }
          : hydratedRenderStateSnapshot,
        snapshotClips,
      },
    }
    } catch (error) {
      preparedScope?.release()
      throw error
    }
  }
  const baseRequest = (
    snapshot: ExportRequestSnapshot,
    sampledInstrumentRegionScope: SampledInstrumentRegionBudgetScope | undefined,
    signal: AbortSignal,
    onProgress: (progress: ExportProgress) => void,
  ) => {
    const timeSignature = snapshot.timeSignature ?? { numerator: 4, denominator: 4 }
    return {
    ...snapshot.settings,
    nativeRendererRequired: dependencies.nativeRendererRequired,
    getTracks: () => snapshot.tracks,
    projectGeneration: snapshot.projectGeneration,
    createBuffer: dependencies.createBuffer,
    bpm: snapshot.bpm,
    timeSignature,
    masterVolume: snapshot.masterVolume,
    projectId: snapshot.projectId,
    userId: snapshot.userId,
    sidechainRoutes: snapshot.sidechainRoutes,
    renderStateSnapshot: snapshot.renderStateSnapshot,
    nativeOfflinePcmRenderer: dependencies.nativeOfflinePcmRenderer,
    sampledInstrumentRegionScope,
    loadCapturedClipBuffer: async (clip: RuntimeClip, loadSignal: AbortSignal) => {
      const detached = snapshot.snapshotClips.get(clip.id)
      if (!detached || detached.buffer) return
      const result = await dependencies.loadCapturedClipBuffer({
        projectId: snapshot.projectId,
        sampleUrl: resolveClipSampleUrl(detached),
        sourceAssetKey: detached.sourceAssetKey,
        targetSampleRate: detached.sourceSampleRate,
      }, loadSignal)
      if (result.status !== "ready") throw new Error(`Audio media for clip "${clip.id}" is ${result.status}.`)
      detached.buffer = result.buffer
    },
    signal,
    onProgress,
    }
  }
  const takeScope = (prepared: PreparedTimelineExport | PreparedStemExport) => {
    const scope = preparedScopes.get(prepared)
    preparedScopes.delete(prepared)
    return scope
  }
  const releasePrepared = (prepared: PreparedTimelineExport | PreparedStemExport) => {
    const scope = takeScope(prepared)
    if (!scope) return
    scope.release()
  }
  const submit = (
    name: string,
    scope: SampledInstrumentRegionBudgetScope | undefined,
    run: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void, jobId: string) => Promise<ExportOutcome>,
  ): SubmittedExport => {
    let queued: ReturnType<ExportQueue["submit"]>
    try {
      queued = dependencies.queue.submit({ name }, async (signal, onProgress, jobId) => {
        const current = jobs.get(jobId)
        if (current) jobs.set(jobId, { ...current, status: "running" })
        return await run(signal, (progress) => {
          const next = jobs.get(jobId)
          if (next) jobs.set(jobId, { ...next, status: "running", progress })
          onProgress(progress)
        }, jobId)
      }, scope?.release)
    } catch (error) {
      scope?.release()
      throw error
    }
    jobs.set(queued.id, { id: queued.id, status: "queued" })
    void queued.completion.then((outcome) => {
      scope?.release()
      jobs.set(queued.id, {
        id: queued.id,
        status: outcome.type === "success" ? "completed" : outcome.type === "canceled" ? "canceled" : "failed",
        outcome,
      })
    })
    return { id: queued.id, completion: queued.completion }
  }
  const prepareTimelineExport = async (input: TimelineExportInput): Promise<PreparedTimelineExport> => {
    assertNativeMixdownAvailable()
    const captured = await snapshotRequest(input)
    const prepared: PreparedTimelineExport = {
      kind: "timeline",
      name: input.name ?? "Timeline mixdown",
      snapshot: captured.snapshot,
    }
    if (captured.scope) preparedScopes.set(prepared, captured.scope)
    return prepared
  }
  const prepareStemExport = async (input: TimelineStemExportInput): Promise<PreparedStemExport> => {
    assertStemRendererAvailable()
    const captured = await snapshotRequest(input)
    const prepared: PreparedStemExport = {
      kind: "stems",
      name: input.name ?? (input.stemSelection === "all-tracks" ? "All track stems" : "Selected track stems"),
      input: snapshotStemInput(input),
      snapshot: captured.snapshot,
    }
    if (captured.scope) preparedScopes.set(prepared, captured.scope)
    return prepared
  }
  const submitPreparedTimelineExport = (prepared: PreparedTimelineExport, outputTargets: ExportOutputTargetFactory) => {
    try {
      assertNativeMixdownAvailable()
    } catch (error) {
      releasePrepared(prepared)
      throw error
    }
    const scope = takeScope(prepared)
    return submit(prepared.name, scope, (signal, onProgress) =>
      (dependencies.runTimelineExport ?? runTimelineExport)({
        ...baseRequest(prepared.snapshot, scope, signal, onProgress),
        outputTargets,
      }))
  }
  const submitPreparedStemExport = (prepared: PreparedStemExport, outputTargets: ExportOutputTargetFactory) => {
    try {
      assertStemRendererAvailable()
    } catch (error) {
      releasePrepared(prepared)
      throw error
    }
    const input = prepared.input
    const scope = takeScope(prepared)
    return submit(prepared.name, scope, (signal, onProgress) =>
      input.stemSelection === "all-tracks"
        ? runStemExport({ ...baseRequest(prepared.snapshot, scope, signal, onProgress), stemSelection: "all-tracks", stemMode: input.stemMode, outputTargets })
        : runStemExport({ ...baseRequest(prepared.snapshot, scope, signal, onProgress), stemSelection: "selected-tracks", stemMode: input.stemMode, selectedTrackIds: [...input.selectedTrackIds], outputTargets }))
  }
  const submitTimelineExport = async (input: TimelineExportInput, outputTargets: ExportOutputTargetFactory) => {
    return submitPreparedTimelineExport(await prepareTimelineExport(input), outputTargets)
  }
  const submitStemExport = async (input: TimelineStemExportInput, outputTargets: ExportOutputTargetFactory) => {
    return submitPreparedStemExport(await prepareStemExport(input), outputTargets)
  }
  return {
    enqueueTimelineExport: async (input, outputTargets) => (await submitTimelineExport(input, outputTargets)).completion,
    enqueueStemExport: async (input, outputTargets) => (await submitStemExport(input, outputTargets)).completion,
    submitTimelineExport,
    submitStemExport,
    prepareTimelineExport,
    prepareStemExport,
    submitPreparedTimelineExport,
    submitPreparedStemExport,
    releasePreparedExport: releasePrepared,
    cancel: (jobId) => {
      dependencies.queue.cancel(jobId)
    },
    status: (jobId) => {
      if (jobId) return jobs.get(jobId)
      const active = dependencies.queue.activeJob()
      if (active) return jobs.get(active.id)
      return [...jobs.values()].at(-1)
    },
  }
}
