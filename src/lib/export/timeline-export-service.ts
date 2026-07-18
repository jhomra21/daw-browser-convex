import { resolveClipSampleUrl, type ExportAudioFormat } from "@daw-browser/shared"
import type { ExportRange } from "@daw-browser/audio-engine/export-range"
import type { StemMode } from "@daw-browser/audio-engine/export-mixdown"
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types"
import type { RuntimeClip, RuntimeTrack } from "~/lib/timeline-runtime-types"
import type { ExportEncodingSettings, ExportRenderSettings } from "~/lib/export/export-settings"
import type { ExportOutputTargetFactory } from "~/lib/export/export-output-targets"
import { createExportRenderStateSnapshot, type ExportAutomationPatch, type ExportCloudRenderRowsSnapshot, type ExportOutcome, type ExportProgress, type ExportRenderStateSnapshot, runStemExport, runTimelineExport } from "~/lib/export/run-export-job"
import type { ExportQueue } from "~/lib/export/export-queue"
import type { CapturedClipBufferLoadResult, CapturedClipMediaReference } from "~/hooks/useClipBuffers"
import type { EffectsPanelExportSnapshot } from "~/components/timeline/create-effects-panel-controller"

type TimelineExportDependencies = {
  queue: ExportQueue
  runTimelineExport?: typeof runTimelineExport
  getTracks: () => RuntimeTrack[]
  getBpm: () => number
  getMasterVolume: () => number
  getProjectId: () => string | undefined
  getUserId: () => string | undefined
  getCloudRenderRows: () => ExportCloudRenderRowsSnapshot | undefined
  getAutomationPatches: () => readonly ExportAutomationPatch[]
  getEffectsExportSnapshot: () => EffectsPanelExportSnapshot | undefined
  getSidechainRoutes: () => ExternalSidechainRoute[]
  loadCapturedClipBuffer: (reference: CapturedClipMediaReference, signal: AbortSignal) => Promise<CapturedClipBufferLoadResult>
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

type ExportRequestSnapshot = {
  settings: ExportSettings
  tracks: RuntimeTrack[]
  bpm: number
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
  cancel: (jobId: string) => void
  status: (jobId?: string) => TimelineExportJobStatus | undefined
}

export const createTimelineExportService = (dependencies: TimelineExportDependencies): TimelineExportService => {
  const jobs = new Map<string, TimelineExportJobStatus>()
  const snapshotRequest = async (settings: ExportSettings) => {
    const snapshotClips = new Map<string, RuntimeTrack["clips"][number]>()
    const tracks = dependencies.getTracks().map((track) => {
      const { clips, ...trackWithoutClips } = track
      const clonedTrack = structuredClone(trackWithoutClips)
      return {
        ...clonedTrack,
        clips: clips.map((clip) => {
          const { buffer, ...clipWithoutBuffer } = clip
          const snapshotClip = { ...structuredClone(clipWithoutBuffer), ...(buffer === undefined ? {} : { buffer }) }
          snapshotClips.set(clip.id, snapshotClip)
          return snapshotClip
        }),
      }
    })
    const effectsSnapshot = dependencies.getEffectsExportSnapshot()
    const projectId = dependencies.getProjectId()
    const userId = dependencies.getUserId()
    const bpm = dependencies.getBpm()
    const masterVolume = dependencies.getMasterVolume()
    const cloudRows = structuredClone(dependencies.getCloudRenderRows())
    const effectsProjection = effectsSnapshot
      ? structuredClone(effectsSnapshot.snapshotEffectsProjection())
      : undefined
    const automationPatches = structuredClone(dependencies.getAutomationPatches())
    const sidechainRoutes = structuredClone(effectsSnapshot?.snapshotSidechainRoutes() ?? dependencies.getSidechainRoutes())
    await effectsSnapshot?.flushPending()
    return {
      settings: structuredClone(settings),
      tracks,
      bpm,
      masterVolume,
      projectId,
      userId,
      sidechainRoutes,
      renderStateSnapshot: await createExportRenderStateSnapshot({
        projectId,
        userId,
        masterVolume,
        cloudRows,
        effectsProjection,
        automationPatches,
      }),
      snapshotClips,
    }
  }
  const baseRequest = (
    snapshot: Awaited<ReturnType<typeof snapshotRequest>>,
    signal: AbortSignal,
    onProgress: (progress: ExportProgress) => void,
  ) => ({
    ...snapshot.settings,
    getTracks: () => snapshot.tracks,
    bpm: snapshot.bpm,
    masterVolume: snapshot.masterVolume,
    projectId: snapshot.projectId,
    userId: snapshot.userId,
    sidechainRoutes: snapshot.sidechainRoutes,
    renderStateSnapshot: snapshot.renderStateSnapshot,
    loadCapturedClipBuffer: async (clip: RuntimeClip, loadSignal: AbortSignal) => {
      const detached = snapshot.snapshotClips.get(clip.id)
      if (!detached || detached.buffer) return
      const result = await dependencies.loadCapturedClipBuffer({
        projectId: snapshot.projectId,
        sampleUrl: resolveClipSampleUrl(detached),
        sourceAssetKey: detached.sourceAssetKey,
      }, loadSignal)
      if (result.status !== "ready") throw new Error(`Audio media for clip "${clip.id}" is ${result.status}.`)
      detached.buffer = result.buffer
    },
    signal,
    onProgress,
  })
  const submit = (
    name: string,
    run: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void) => Promise<ExportOutcome>,
  ): SubmittedExport => {
    const queued = dependencies.queue.submit({ name }, async (signal, onProgress, jobId) => {
      const current = jobs.get(jobId)
      if (current) jobs.set(jobId, { ...current, status: "running" })
      return await run(signal, (progress) => {
        const next = jobs.get(jobId)
        if (next) jobs.set(jobId, { ...next, status: "running", progress })
        onProgress(progress)
      })
    })
    jobs.set(queued.id, { id: queued.id, status: "queued" })
    void queued.completion.then((outcome) => {
      jobs.set(queued.id, {
        id: queued.id,
        status: outcome.type === "success" ? "completed" : outcome.type === "canceled" ? "canceled" : "failed",
        outcome,
      })
    })
    return { id: queued.id, completion: queued.completion }
  }
  const prepareTimelineExport = async (input: TimelineExportInput): Promise<PreparedTimelineExport> => ({
    kind: "timeline",
    name: input.name ?? "Timeline mixdown",
    snapshot: await snapshotRequest(input),
  })
  const prepareStemExport = async (input: TimelineStemExportInput): Promise<PreparedStemExport> => ({
    kind: "stems",
    name: input.name ?? (input.stemSelection === "all-tracks" ? "All track stems" : "Selected track stems"),
    input: structuredClone(input),
    snapshot: await snapshotRequest(input),
  })
  const submitPreparedTimelineExport = (prepared: PreparedTimelineExport, outputTargets: ExportOutputTargetFactory) => (
    submit(prepared.name, (signal, onProgress) =>
      (dependencies.runTimelineExport ?? runTimelineExport)({
        ...baseRequest(prepared.snapshot, signal, onProgress),
        outputTargets,
      }))
  )
  const submitPreparedStemExport = (prepared: PreparedStemExport, outputTargets: ExportOutputTargetFactory) => {
    const input = prepared.input
    return submit(prepared.name, (signal, onProgress) =>
      input.stemSelection === "all-tracks"
        ? runStemExport({ ...baseRequest(prepared.snapshot, signal, onProgress), stemSelection: "all-tracks", stemMode: input.stemMode, outputTargets })
        : runStemExport({ ...baseRequest(prepared.snapshot, signal, onProgress), stemSelection: "selected-tracks", stemMode: input.stemMode, selectedTrackIds: [...input.selectedTrackIds], outputTargets }))
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
