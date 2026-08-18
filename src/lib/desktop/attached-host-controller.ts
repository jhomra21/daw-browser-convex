import type { Accessor } from "solid-js"
import { isLocalId } from "@daw-browser/shared"
import {
  desktopHostExportRunInputSchemaV1,
  desktopHostExportCancelInputSchemaV1,
  desktopHostVstInstancesInputSchemaV1,
  desktopHostVstParametersInputSchemaV1,
  desktopRendererControlCapabilitiesInputSchemaV1,
  desktopRendererControlSnapshotInputSchemaV1,
  desktopRendererExportInputSchemaV1,
  desktopRendererImportInputSchemaV1,
  desktopSeekInputSchemaV1,
  desktopJsonValueSchema,
  hostError,
  isDesktopControlOperation,
  parseDesktopResult,
  type ControlErrorV1,
  type HostErrorV1,
  type DesktopOperationMapV1,
  type DesktopOperationV1,
} from "@daw-browser/desktop-protocol"
import {
  controlApprovalRequestSchemaV1,
  controlCommitRequestSchemaV1,
  controlCommitResultSchemaV1,
  controlHistoryQuerySchemaV1,
  controlPreviewRequestSchemaV1,
  controlRecoveriesQuerySchemaV1,
  projectSnapshotSchemaV2,
} from "@daw-browser/control"
import { getRecordingDiagnostics } from "~/lib/recording/recording-diagnostics"
import { flushLocalProjectPendingWrites } from "~/lib/local-project-pending-writes"
import { resetAudioEngine } from "~/lib/audio-engine-singleton"
import { getLocalProject } from "~/lib/local-project-db"
import { serializeJsonValue } from "~/lib/json"
import { listLocalExternalProcessors } from "~/lib/external-plugins"
import {
  createLocalControlService,
  LocalControlServiceError,
} from "~/lib/local-control/local-control-service"
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine"
import type { ExportQueue } from "~/lib/export/export-queue"
import type { ImportSummary } from "~/hooks/useTimelineClipImport"
export type {
  DesktopPluginCatalog,
  DesktopPluginCatalogEntry,
  DesktopPluginCatalogReply,
} from "~/types/desktop-bridge"
import { createDesktopCapabilityExportOutputTargetFactory, desktopExportResourceLimits } from "~/lib/desktop/capability-export-output-targets"
import { preflightExportResources } from "~/lib/export/export-resource-preflight"
import { collectStemTracks } from "~/lib/export/run-export-job"
import type { PreparedStemExport, PreparedTimelineExport, TimelineExportInput, TimelineExportService } from "~/lib/export/timeline-export-service"

type HostRequest = {
  id: string
  operation: DesktopOperationV1
  input: unknown
  signal: AbortSignal
  actorSubject?: string
}

type HostResponse = {
  id: string
  result?: unknown
  error?: HostErrorV1 | ControlErrorV1
}

type TimelineHostController = {
  request: (request: HostRequest) => Promise<HostResponse>
  prepareToClose: () => Promise<boolean>
}

const unavailable = (id: string): HostResponse => ({
  id,
  error: { version: "v1", code: "unavailable", message: "The timeline controller is not ready." },
})

const cancelled = (id: string): HostResponse => ({
  id,
  error: { version: "v1", code: "cancelled", message: "The request was cancelled." },
})

const mountedProjectRequired = () => hostError("unavailable", "A mounted local project is required.")
const controlUnavailable = () => hostError("cancelled", "The local control request was cancelled.")
const controlFailure = () => hostError("internal", "The local control request could not be completed.")

const mountedProjectMismatch = () => hostError("invalid-request", "The requested project is not mounted.")
const projectIdForControlRequest = (request: HostRequest) => {
  switch (request.operation) {
    case "control.capabilities":
      return undefined
    case "control.snapshot":
      return desktopRendererControlSnapshotInputSchemaV1.safeParse(request.input).data?.projectId
    case "control.preview":
      return controlPreviewRequestSchemaV1.safeParse(request.input).data?.projectId
    case "control.commit":
      return controlCommitRequestSchemaV1.safeParse(request.input).data?.projectId
    case "control.requestApproval":
      return controlApprovalRequestSchemaV1.safeParse(request.input).data?.projectId
    case "control.history":
      return controlHistoryQuerySchemaV1.safeParse(request.input).data?.projectId
    case "control.recoveries":
      return controlRecoveriesQuerySchemaV1.safeParse(request.input).data?.projectId
    default:
      return undefined
  }
}

const projectMatchesMount = (request: HostRequest, mountedProjectId: string) => (
  request.operation === "control.capabilities"
  || projectIdForControlRequest(request) === mountedProjectId
)

const mountedProjectError = (request: HostRequest, mountedProjectId: string) => (
  projectMatchesMount(request, mountedProjectId)
    ? mountedProjectRequired()
    : mountedProjectMismatch()
)
const pageValues = <Value>(values: readonly Value[], cursor: string | undefined, limit: number) => {
  const start = cursor === undefined ? 0 : Number(cursor)
  const page = values.slice(start, start + limit)
  return {
    values: page,
    nextCursor: start + page.length < values.length ? String(start + page.length) : null,
  }
}
const clampNormalizedValue = (value: number) => Math.min(1, Math.max(0, value))
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

class ControlRequestUnavailableError extends Error {}

let activeController: TimelineHostController | undefined

type CapabilityImport = { canceled: boolean; files?: { token: string; basename: string; mime: string }[] }
type CapabilityExport = {
  canceled: boolean
  preflightOnly: boolean
  mode: "mixdown" | "stems"
  output: { token: string; basename: string; directory: boolean }
  settings: TimelineExportInput
  stems?: { stemSelection: "all-tracks"; stemMode: "dry-source" | "post-track-fx" | "reachable-routing" | "channel-output" | "full-master-contribution" }
    | { stemSelection: "selected-tracks"; stemMode: "dry-source" | "post-track-fx" | "reachable-routing" | "channel-output" | "full-master-contribution"; selectedTrackIds: readonly string[] }
}

const parseCapabilityExport = (request: HostRequest): CapabilityExport | undefined => {
  const internal = desktopRendererExportInputSchemaV1.safeParse(request.input)
  if (!internal.success) return undefined
  if (internal.data.canceled) {
    const mode = internal.data.mode
    if (mode !== "mixdown" && mode !== "stems") return undefined
    return { canceled: true, preflightOnly: false, mode, output: { token: "", basename: "", directory: false }, settings: { range: { mode: "whole" }, formats: ["wav"], render: { sampleRate: 44100, numberOfChannels: 2, normalization: { mode: "none" }, tail: { mode: "none" } }, encoding: { bitrateByFormat: {}, wav: { codec: "pcm-s16", dither: "none" } } } }
  }
  const { destination } = internal.data
  const { canceled: _canceled, preflightOnly, ...exportRequest } = internal.data
  const external = desktopHostExportRunInputSchemaV1.safeParse({
    ...exportRequest,
    destination: destination.kind === "capability-file"
      ? { kind: "file", path: `/capability/${destination.basename}` }
      : { kind: "directory", path: "/capability" },
  })
  if (!external.success) return undefined
  const { channels, normalization, ...renderBase } = external.data.render
  const normalizedRender = normalization.mode === "loudness"
    ? { ...renderBase, numberOfChannels: channels, normalization: { ...normalization, truePeakCeilingDbtp: normalization.ceiling } }
    : { ...renderBase, numberOfChannels: channels, normalization }
  const bitrateByFormat: TimelineExportInput["encoding"]["bitrateByFormat"] = {}
  if (external.data.encoding.mp3Bitrate !== undefined) {
    bitrateByFormat.mp3 = external.data.encoding.mp3Bitrate
  }
  if (external.data.encoding.oggOpusBitrate !== undefined) {
    bitrateByFormat["ogg-opus"] = external.data.encoding.oggOpusBitrate
  }
  const settings: TimelineExportInput = {
    range: external.data.range,
    formats: external.data.mode === "mixdown" ? [external.data.format] : external.data.formats,
    render: normalizedRender,
    encoding: {
      bitrateByFormat,
      wav: external.data.encoding.wav,
    },
  }
  if (external.data.mode === "mixdown") return { canceled: false, preflightOnly: preflightOnly === true, mode: "mixdown", output: { token: destination.token, basename: destination.basename, directory: false }, settings }
  const stems = external.data.selection.kind === "all-tracks"
    ? { stemSelection: "all-tracks" as const, stemMode: external.data.stemMode }
    : { stemSelection: "selected-tracks" as const, stemMode: external.data.stemMode, selectedTrackIds: external.data.selection.trackIds }
  return { canceled: false, preflightOnly: preflightOnly === true, mode: "stems", output: { token: destination.token, basename: destination.basename, directory: true }, settings, stems }
}

const safeExportStatus = (job: ReturnType<TimelineExportService["status"]>) => {
  if (!job) return { status: "idle" as const }
  const safeJob: NonNullable<DesktopOperationMapV1["host.export.status"]["result"]["job"]> = {
    id: job.id,
  }
  if (job.progress?.phase !== undefined) safeJob.phase = job.progress.phase
  if (job.progress?.sizeBytes !== undefined) safeJob.sizeBytes = job.progress.sizeBytes
  if (job.outcome !== undefined) {
    safeJob.outputs = job.outcome.outputs.map((output) => ({
      name: output.name,
      sizeBytes: output.sizeBytes,
    }))
  }
  return {
    status: job.status,
    job: safeJob,
  }
}

const fileFromCapability = async (requestId: string, file: { token: string; basename: string; mime: string }) => {
  const bytes = await window.dawDesktop!.readChunk(requestId, file.token)
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new File([buffer], file.basename, { type: file.mime })
}

export const registerAttachedHostController = (controller: TimelineHostController) => {
  if (activeController) throw new Error("Only one timeline host controller may be attached.")
  activeController = controller
  window.dawDesktop?.setRequestHandler(controller.request)
  window.dawDesktop?.onPrepareToClose(async () => ({ flushed: await controller.prepareToClose() }))
  return () => {
    if (activeController !== controller) return
    activeController = undefined
    window.dawDesktop?.setRequestHandler(undefined)
    window.dawDesktop?.onPrepareToClose(undefined)
  }
}

export const createAttachedHostController = (input: {
  projectId: Accessor<string>
  mountedProjectGeneration: Accessor<number>
  isPlaying: Accessor<boolean>
  playheadSec: Accessor<number>
  tracks: Accessor<{ clips: unknown[] }[]>
  audioEngine: AudioEngine
  requestPlay: () => Promise<void>
  pause: () => Promise<void>
  stop: () => Promise<void>
  finishRecording: () => Promise<void>
  exportService: TimelineExportService
  exportQueue: ExportQueue
  importFiles: (files: readonly File[], signal?: AbortSignal) => Promise<ImportSummary>
  setPlayhead: (seconds: number) => void
  enqueueNativeVstParameter?: (event: { instanceId: string; id: number; value: number }) => Promise<boolean>
  getMountedLocalProject?: typeof getLocalProject
}): TimelineHostController => {
  const preparedExports = new Map<string, PreparedTimelineExport | PreparedStemExport>()
  const findMountedLocalProject = input.getMountedLocalProject ?? getLocalProject
  const transport = () => ({
    state: input.isPlaying() ? "playing" as const : input.playheadSec() === 0 ? "stopped" as const : "paused" as const,
    playheadSec: Math.max(0, input.playheadSec()),
  })
  const status = () => {
    const projectId = input.projectId()
    return {
      project: projectId ? { id: projectId, kind: isLocalId("project", projectId) ? "local" as const : "cloud" as const } : null,
      ready: Boolean(activeController),
      transport: transport().state,
      capabilities: { playback: true, diagnostics: true },
    }
  }
  const ensureMountedLocalProject = async (mountedProjectId: string, mountedGeneration: number, signal: AbortSignal) => {
    if (
      signal.aborted
      || activeController !== controller
      || input.projectId() !== mountedProjectId
      || input.mountedProjectGeneration() !== mountedGeneration
      || !isLocalId("project", mountedProjectId)
    ) return false
    const project = await findMountedLocalProject(mountedProjectId)
    return !signal.aborted
      && activeController === controller
      && input.projectId() === mountedProjectId
      && input.mountedProjectGeneration() === mountedGeneration
      && project !== undefined
  }
  const control = async (request_: HostRequest): Promise<HostResponse> => {
    if (!request_.actorSubject) {
      return {
        id: request_.id,
        error: { version: "v1", code: "authorization", message: "A trusted local control actor is required." },
      }
    }
    const mountedProjectId = input.projectId()
    const mountedGeneration = input.mountedProjectGeneration()
    if (!mountedProjectId) {
      return { id: request_.id, error: request_.signal.aborted ? controlUnavailable() : mountedProjectRequired() }
    }
    if (!await ensureMountedLocalProject(mountedProjectId, mountedGeneration, request_.signal)) {
      return { id: request_.id, error: request_.signal.aborted ? controlUnavailable() : mountedProjectError(request_, mountedProjectId) }
    }
    if (!projectMatchesMount(request_, mountedProjectId)) return { id: request_.id, error: mountedProjectMismatch() }
    try {
      const requestInput = desktopJsonValueSchema.parse(request_.input)
      const service = createLocalControlService({
        actor: { subject: request_.actorSubject, issuer: "daw-browser-desktop-host" },
        assertAvailable: () => {
          if (
            request_.signal.aborted
            || activeController !== controller
            || input.projectId() !== mountedProjectId
            || input.mountedProjectGeneration() !== mountedGeneration
            || !isLocalId("project", mountedProjectId)
          ) throw new ControlRequestUnavailableError()
        },
      })
      const result = request_.operation === "control.capabilities"
        ? desktopRendererControlCapabilitiesInputSchemaV1.parse(requestInput).readVersion === "v2"
          ? service.capabilitiesV2()
          : service.capabilities()
        : request_.operation === "control.snapshot"
          ? desktopRendererControlSnapshotInputSchemaV1.parse(requestInput).readVersion === "v2"
            ? await service.snapshotV2({ projectId: mountedProjectId })
            : await service.snapshot(desktopRendererControlSnapshotInputSchemaV1.parse(requestInput))
        : request_.operation === "control.preview"
            ? await service.preview(requestInput)
            : request_.operation === "control.commit"
              ? await service.commit(requestInput)
              : request_.operation === "control.requestApproval"
                ? await service.requestApproval(requestInput)
                : request_.operation === "control.history"
                  ? await service.history(requestInput)
                  : await service.recoveries(requestInput)
      if (!await ensureMountedLocalProject(mountedProjectId, mountedGeneration, request_.signal)) {
        return { id: request_.id, error: request_.signal.aborted ? controlUnavailable() : mountedProjectError(request_, mountedProjectId) }
      }
      if (request_.operation === "control.commit" && input.enqueueNativeVstParameter) {
        try {
          const commitRequest = controlCommitRequestSchemaV1.parse(requestInput)
          const commitResult = controlCommitResultSchemaV1.safeParse(result)
          if (commitResult.success && commitResult.data.applied && !commitResult.data.idempotencyReplay) {
            const changedActionIndexes = new Set(commitResult.data.changeSummary.changes
              .filter((change) => change.kind === "external-plugin.parameters.set")
              .map((change) => change.actionIndex))
            if (changedActionIndexes.size > 0) {
              const postCommitSnapshot = projectSnapshotSchemaV2.parse(await service.snapshotV2({ projectId: mountedProjectId }))
              const processorsById = new Map(postCommitSnapshot.processors.map((processor) => [processor.id, processor]))
              if (await ensureMountedLocalProject(mountedProjectId, mountedGeneration, request_.signal)) {
                const deliveries: Promise<boolean>[] = []
                for (const [actionIndex, action] of commitRequest.actions.entries()) {
                  if (action.kind !== "external-plugin.parameters.set" || !changedActionIndexes.has(actionIndex)) continue
                  const processor = processorsById.get(action.processor.id)
                  if (processor?.processor.kind !== "external-vst3" || processor.instanceId === undefined) continue
                  for (const change of action.changes) {
                    try {
                      deliveries.push(input.enqueueNativeVstParameter({
                        instanceId: processor.instanceId,
                        id: change.parameterId,
                        value: change.normalizedValue,
                      }))
                    } catch (error) {
                      deliveries.push(Promise.reject(error))
                    }
                  }
                }
                await Promise.all(deliveries)
              }
            }
          }
        } catch {}
      }
      const rendererProtocolVersion = (
        request_.operation === "control.capabilities"
        && desktopRendererControlCapabilitiesInputSchemaV1.parse(requestInput).readVersion === "v2"
      ) || (
        request_.operation === "control.snapshot"
        && desktopRendererControlSnapshotInputSchemaV1.parse(requestInput).readVersion === "v2"
      ) ? "v2" : "v1"
      return {
        id: request_.id,
        result: parseDesktopResult(
          request_.operation,
          desktopJsonValueSchema.parse(serializeJsonValue(result)),
          requestInput,
          rendererProtocolVersion,
        ),
      }
    } catch (error) {
      if (error instanceof ControlRequestUnavailableError) {
        return { id: request_.id, error: request_.signal.aborted ? controlUnavailable() : mountedProjectRequired() }
      }
      if (!await ensureMountedLocalProject(mountedProjectId, mountedGeneration, request_.signal)) {
        return { id: request_.id, error: request_.signal.aborted ? controlUnavailable() : mountedProjectError(request_, mountedProjectId) }
      }
      if (error instanceof LocalControlServiceError) return { id: request_.id, error: error.data }
      return { id: request_.id, error: controlFailure() }
    }
  }
  const request = async (request_: HostRequest): Promise<HostResponse> => {
    if (activeController !== controller) return unavailable(request_.id)
    if (request_.signal.aborted) return cancelled(request_.id)
    try {
      let result: DesktopOperationMapV1[DesktopOperationV1]["result"]
      if (request_.operation === "host.vst.instances" || request_.operation === "host.vst.parameters") {
        const parsedInput = request_.operation === "host.vst.instances"
          ? desktopHostVstInstancesInputSchemaV1.safeParse(request_.input)
          : desktopHostVstParametersInputSchemaV1.safeParse(request_.input)
        if (!parsedInput.success) {
          return { id: request_.id, error: hostError("invalid-request", "Invalid VST discovery request.") }
        }
        const projectId = parsedInput.data.projectId
        const mountedProjectId = input.projectId()
        if (!mountedProjectId || !isLocalId("project", mountedProjectId)) {
          return { id: request_.id, error: request_.signal.aborted ? cancelled(request_.id).error : mountedProjectRequired() }
        }
        if (projectId !== mountedProjectId) return { id: request_.id, error: mountedProjectMismatch() }
        const mountedGeneration = input.mountedProjectGeneration()
        if (!await ensureMountedLocalProject(mountedProjectId, mountedGeneration, request_.signal)) {
          return { id: request_.id, error: request_.signal.aborted ? cancelled(request_.id).error : mountedProjectRequired() }
        }
        const processors = await listLocalExternalProcessors(mountedProjectId)
        if (!await ensureMountedLocalProject(mountedProjectId, mountedGeneration, request_.signal)) {
          return { id: request_.id, error: request_.signal.aborted ? cancelled(request_.id).error : mountedProjectRequired() }
        }
        if (request_.operation === "host.vst.instances") {
          const instances = [...processors]
            .sort((left, right) => (
              compareText(left.targetId, right.targetId)
              || left.index - right.index
              || compareText(left.instanceId, right.instanceId)
            ))
            .map((processor) => ({
              instanceId: processor.instanceId,
              targetId: processor.targetId,
              stageIndex: processor.index,
              identity: {
                format: processor.manifest.identity.format,
                classId: processor.manifest.identity.classId,
                vendor: processor.manifest.identity.vendor,
                name: processor.manifest.identity.name,
                version: processor.manifest.identity.version,
                architecture: processor.manifest.identity.architecture,
              },
              role: processor.manifest.role,
              bypassed: processor.bypassed,
              health: processor.health,
              parameterCount: processor.manifest.parameters.length,
              supportsEditor: processor.manifest.supportsEditor,
              supportsState: processor.manifest.supportsState,
            }))
          const page = pageValues(instances, parsedInput.data.cursor, parsedInput.data.limit)
          result = { projectId, instances: page.values, nextCursor: page.nextCursor }
        } else {
          const parameterInput = desktopHostVstParametersInputSchemaV1.parse(request_.input)
          const processor = processors.find((candidate) => candidate.instanceId === parameterInput.instanceId)
          if (!processor) return { id: request_.id, error: hostError("invalid-request", "The requested VST instance was not found.") }
          const parameters = [...processor.manifest.parameters]
            .sort((left, right) => left.id - right.id)
            .map((parameter) => ({
              id: parameter.id,
              title: parameter.title,
              unit: parameter.unit,
              minimum: parameter.minimum,
              maximum: parameter.maximum,
              defaultValue: parameter.defaultValue,
              stepCount: parameter.stepCount,
              readOnly: parameter.readOnly,
              hidden: parameter.hidden,
              currentValue: clampNormalizedValue(processor.parameterOverrides[String(parameter.id)] ?? parameter.defaultValue),
            }))
          const page = pageValues(parameters, parsedInput.data.cursor, parsedInput.data.limit)
          result = { projectId, instanceId: processor.instanceId, parameters: page.values, nextCursor: page.nextCursor }
        }
        return {
          id: request_.id,
          result: parseDesktopResult(
            request_.operation,
            result,
            desktopJsonValueSchema.parse(request_.input),
          ),
        }
      }
      if (isDesktopControlOperation(request_.operation)) return control(request_)
      if (request_.operation === "host.status") result = status()
      else if (request_.operation === "host.import.audio") {
        const parsedInput = desktopRendererImportInputSchemaV1.safeParse(request_.input)
        if (!parsedInput.success) return { id: request_.id, error: { version: "v1", code: "invalid-request", message: "Invalid audio import request." } }
        const input_: CapabilityImport = parsedInput.data
        if (input_.canceled) result = { status: "canceled", count: 0 }
        else {
          const files = await Promise.all((input_.files ?? []).map((file) => fileFromCapability(request_.id, file)))
          if (request_.signal.aborted) return cancelled(request_.id)
          const summary = await input.importFiles(files, request_.signal)
          const created = summary.outcomes.filter((outcome) => outcome.status === "created").length
          const queued = summary.outcomes.filter((outcome) => outcome.status === "queued").length
          result = { status: created > 0 ? "created" : queued > 0 ? "queued" : "failed", count: created + queued }
        }
      } else if (request_.operation === "host.export.run") {
        const exportInput = parseCapabilityExport(request_)
        if (!exportInput) return { id: request_.id, error: { version: "v1", code: "invalid-request", message: "Invalid export request." } }
        if (exportInput.canceled) {
          preparedExports.delete(request_.id)
          return { id: request_.id, result: { status: "canceled" } }
        }
        if (exportInput.preflightOnly) {
          const prepared = exportInput.mode === "mixdown"
            ? await input.exportService.prepareTimelineExport(exportInput.settings)
            : exportInput.stems
              ? await input.exportService.prepareStemExport({ ...exportInput.settings, ...exportInput.stems })
              : undefined
          if (!prepared) return { id: request_.id, error: { version: "v1", code: "invalid-request", message: "Invalid stem export request." } }
          const stemCount = prepared.kind === "timeline"
            ? 1
            : collectStemTracks({ ...prepared.input, tracks: prepared.snapshot.tracks }).length
          if (stemCount === 0) throw new Error("Select at least one track to export stems.")
          preflightExportResources({
            tracks: prepared.snapshot.tracks,
            range: prepared.snapshot.settings.range,
            formats: prepared.snapshot.settings.formats,
            render: prepared.snapshot.settings.render,
            encoding: prepared.snapshot.settings.encoding,
            stemCount,
            resourceLimits: desktopExportResourceLimits,
          })
          if (request_.signal.aborted) return cancelled(request_.id)
          preparedExports.set(request_.id, prepared)
          return { id: request_.id, result: { status: "canceled" } }
        }
        const prepared = preparedExports.get(request_.id)
        preparedExports.delete(request_.id)
        if (!prepared || (exportInput.mode === "mixdown") !== (prepared.kind === "timeline")) {
          return { id: request_.id, error: { version: "v1", code: "invalid-request", message: "Export preflight is missing or stale." } }
        }
        const target = createDesktopCapabilityExportOutputTargetFactory(window.dawDesktop!, request_.id, exportInput.output)
        const submitted = prepared.kind === "timeline"
          ? input.exportService.submitPreparedTimelineExport(prepared, target)
          : input.exportService.submitPreparedStemExport(prepared, target)
        void submitted.completion.then((outcome) => {
          window.dawDesktop?.exportTerminal(
            submitted.id,
            outcome.type === "success" ? "success" : outcome.type === "canceled" ? "canceled" : "error",
          )
        })
        result = { jobId: submitted.id, status: "queued" }
      } else if (request_.operation === "host.export.status") {
        result = safeExportStatus(input.exportService.status())
      } else if (request_.operation === "host.export.cancel") {
        const parsedInput = desktopHostExportCancelInputSchemaV1.safeParse(request_.input)
        if (!parsedInput.success) return { id: request_.id, error: { version: "v1", code: "invalid-request", message: "Invalid export job ID." } }
        input.exportService.cancel(parsedInput.data.jobId)
        result = safeExportStatus(input.exportService.status(parsedInput.data.jobId))
      }
      else if (request_.operation === "transport.status") result = transport()
      else if (request_.operation === "transport.play") {
        if (request_.signal.aborted) return cancelled(request_.id)
        await input.requestPlay()
        result = transport()
      } else if (request_.operation === "transport.pause") {
        if (request_.signal.aborted) return cancelled(request_.id)
        await input.pause()
        result = transport()
      } else if (request_.operation === "transport.stop") {
        if (request_.signal.aborted) return cancelled(request_.id)
        await input.stop()
        result = transport()
      } else if (request_.operation === "transport.seek") {
        const parsedInput = desktopSeekInputSchemaV1.safeParse(request_.input)
        if (!parsedInput.success) {
          return { id: request_.id, error: { version: "v1", code: "invalid-request", message: "Invalid seek position." } }
        }
        if (request_.signal.aborted) return cancelled(request_.id)
        input.setPlayhead(parsedInput.data.seconds)
        result = transport()
      } else {
        const runtime = input.audioEngine.getRuntimeSnapshot()
        const recording = getRecordingDiagnostics()
        result = {
          audio: { state: runtime.state, sampleRate: runtime.sampleRate ?? null },
          recording: { transport: recording.transport, capturedFrames: recording.capturedFrames, droppedFrames: recording.droppedFrames, deviceLost: recording.deviceLost },
          counts: { tracks: input.tracks().length, clips: input.tracks().reduce((total, track) => total + track.clips.length, 0) },
        }
      }
      return { id: request_.id, result }
    } catch {
      return { id: request_.id, error: { version: "v1", code: "internal", message: "The timeline operation failed." } }
    }
  }
  const prepareToClose = async () => {
    try {
      await input.stop()
      input.exportQueue.dispose()
      await input.finishRecording()
      const projectId = input.projectId()
      if (isLocalId("project", projectId)) await flushLocalProjectPendingWrites(projectId)
      await Promise.resolve(input.audioEngine.close())
      resetAudioEngine()
      return true
    } catch {
      return false
    }
  }
  const controller: TimelineHostController = { request, prepareToClose }
  return controller
}
