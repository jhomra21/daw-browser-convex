import "fake-indexeddb/auto"
import { expect, test } from "bun:test"
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine"

import { createExportQueue } from "~/lib/export/export-queue"
import { withLocalProjectAssetLock } from "~/lib/local-project-asset-lock"
import { createLocalProject, deleteLocalProject, getLocalProject } from "~/lib/local-project-db"
import { createLocalControlService } from "~/lib/local-control/local-control-service"
import {
  createAttachedHostController,
  registerAttachedHostController,
} from "~/lib/desktop/attached-host-controller"
import type {
  PreparedTimelineExport,
  TimelineExportJobStatus,
  TimelineExportService,
} from "~/lib/export/timeline-export-service"
import type { ExportOutcome } from "~/lib/export/run-export-job"

const token = "0".repeat(64)
const exportInput = {
  mode: "mixdown",
  format: "wav",
  destination: { kind: "capability-file", token, basename: "output.wav" },
  range: { mode: "whole" },
  render: {
    sampleRate: 44_100,
    channels: 2,
    normalization: { mode: "none" },
    tail: { mode: "none" },
  },
  encoding: { wav: { codec: "pcm-s16", dither: "none" } },
  canceled: false,
}

const prepared: PreparedTimelineExport = {
  kind: "timeline",
  name: "Timeline mixdown",
  snapshot: {
    settings: {
      range: { mode: "whole" },
      formats: ["wav"],
      render: {
        sampleRate: 44_100,
        numberOfChannels: 2,
        normalization: { mode: "none" },
        tail: { mode: "none" },
      },
      encoding: {
        bitrateByFormat: {},
        wav: { codec: "pcm-s16", dither: "none" },
      },
    },
    tracks: [{
      id: "track-1",
      name: "Track",
      volume: 1,
      clips: [{
        id: "clip-1",
        name: "Clip",
        color: "#fff",
        startSec: 0,
        duration: 1,
        midi: { wave: "sine", notes: [] },
      }],
    }],
    bpm: 120,
    masterVolume: 1,
    projectId: "project-1",
    userId: "user-1",
    sidechainRoutes: [],
    renderStateSnapshot: {
      fx: { trackFx: {}, masterFxInstances: [], masterVolume: 1 },
      automationEnvelopes: [],
    },
    snapshotClips: new Map(),
  },
}

const installBridge = (terminalJobs: string[]) => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dawDesktop: {
        setRequestHandler: () => undefined,
        onPrepareToClose: () => undefined,
        readChunk: async () => new Uint8Array(),
        beginWrite: async () => ({ writerId: "writer-1" }),
        writeChunk: async (_requestId: string, _writerId: string, offset: number, chunk: Uint8Array) => ({
          nextOffset: offset + chunk.byteLength,
        }),
        commit: async () => ({ basename: "output.wav", byteLength: 1, mime: "audio/wav" }),
        abort: async () => undefined,
        exportTerminal: (jobId: string) => {
          terminalJobs.push(jobId)
        },
      },
    },
  })
}

const controlActor = "local:00000000-0000-4000-8000-000000000000"

const createController = (
  projectId: () => string,
  getMountedLocalProject?: typeof getLocalProject,
  mountedProjectGeneration: () => number = () => 0,
) => {
  const queue = createExportQueue()
  return {
    controller: createAttachedHostController({
      projectId,
      mountedProjectGeneration,
      isPlaying: () => false,
      playheadSec: () => 0,
      tracks: () => [],
      audioEngine: new AudioEngine(),
      requestPlay: async () => undefined,
      pause: async () => undefined,
      stop: async () => undefined,
      finishRecording: async () => undefined,
      exportQueue: queue,
      exportService: {
        enqueueTimelineExport: async () => ({ type: "error", message: "unused", outputs: [] }),
        enqueueStemExport: async () => ({ type: "error", message: "unused", outputs: [] }),
        submitTimelineExport: async () => {
          throw new Error("unused")
        },
        submitStemExport: async () => {
          throw new Error("unused")
        },
        prepareTimelineExport: async () => {
          throw new Error("unused")
        },
        prepareStemExport: async () => {
          throw new Error("unused")
        },
        submitPreparedTimelineExport: () => {
          throw new Error("unused")
        },
        submitPreparedStemExport: () => {
          throw new Error("unused")
        },
        cancel: () => undefined,
        status: () => undefined,
      },
      importFiles: async () => ({ outcomes: [] }),
      setPlayhead: () => undefined,
      ...(getMountedLocalProject === undefined ? {} : { getMountedLocalProject }),
    }),
    dispose: () => queue.dispose(),
  }
}

const requestControl = (
  controller: ReturnType<typeof createController>["controller"],
  operation: "control.capabilities" | "control.snapshot" | "control.preview" | "control.commit" | "control.requestApproval" | "control.history" | "control.recoveries",
  input: unknown,
  signal = new AbortController().signal,
  actorSubject?: string,
) => controller.request({
  id: crypto.randomUUID(),
  operation,
  input,
  signal,
  ...(actorSubject === undefined ? {} : { actorSubject }),
})

test("accepted exports outlive the initiating request and remain queryable and cancelable", async () => {
  const terminalJobs: string[] = []
  installBridge(terminalJobs)
  let nextJob = 0
  let submissions = 0
  const jobs = new Map<string, TimelineExportJobStatus>()
  const completions = new Map<string, (outcome: ExportOutcome) => void>()
  const submit = () => {
    submissions += 1
    const id = `job-${++nextJob}`
    const completion = new Promise<ExportOutcome>((resolve) => {
      completions.set(id, resolve)
    })
    jobs.set(id, { id, status: "queued" })
    return { id, completion }
  }
  const service: TimelineExportService = {
    enqueueTimelineExport: async () => ({ type: "error", message: "unused", outputs: [] }),
    enqueueStemExport: async () => ({ type: "error", message: "unused", outputs: [] }),
    submitTimelineExport: async () => submit(),
    submitStemExport: async () => submit(),
    prepareTimelineExport: async () => prepared,
    prepareStemExport: async () => {
      throw new Error("unused")
    },
    submitPreparedTimelineExport: () => submit(),
    submitPreparedStemExport: () => submit(),
    cancel: (jobId) => {
      jobs.set(jobId, { id: jobId, status: "canceled", outcome: { type: "canceled", outputs: [] } })
      completions.get(jobId)?.({ type: "canceled", outputs: [] })
    },
    status: (jobId) => jobId ? jobs.get(jobId) : [...jobs.values()].at(-1),
  }
  const queue = createExportQueue()
  const controller = createAttachedHostController({
    projectId: () => "project-1",
    mountedProjectGeneration: () => 0,
    isPlaying: () => false,
    playheadSec: () => 0,
    tracks: () => prepared.snapshot.tracks,
    audioEngine: new AudioEngine(),
    requestPlay: async () => undefined,
    pause: async () => undefined,
    stop: async () => undefined,
    finishRecording: async () => undefined,
    exportService: service,
    exportQueue: queue,
    importFiles: async () => ({ outcomes: [] }),
    setPlayhead: () => undefined,
  })
  const unregister = registerAttachedHostController(controller)

  const firstInitiator = new AbortController()
  const firstPreflight = await controller.request({
    id: "request-1",
    operation: "host.export.run",
    input: { ...exportInput, preflightOnly: true },
    signal: firstInitiator.signal,
  })
  expect(firstPreflight.error).toBeUndefined()
  const firstAccepted = await controller.request({
    id: "request-1",
    operation: "host.export.run",
    input: exportInput,
    signal: firstInitiator.signal,
  })
  expect(firstAccepted.result).toEqual({ jobId: "job-1", status: "queued" })
  firstInitiator.abort()
  expect((await controller.request({
    id: "status-1",
    operation: "host.export.status",
    input: {},
    signal: new AbortController().signal,
  })).result).toEqual({ status: "queued", job: { id: "job-1" } })

  jobs.set("job-1", {
    id: "job-1",
    status: "completed",
    outcome: { type: "success", outputs: [] },
  })
  completions.get("job-1")?.({ type: "success", outputs: [] })
  await Promise.resolve()
  expect((await controller.request({
    id: "status-2",
    operation: "host.export.status",
    input: {},
    signal: new AbortController().signal,
  })).result).toEqual({
    status: "completed",
    job: { id: "job-1", outputs: [] },
  })
  expect(terminalJobs).toEqual(["job-1"])

  const secondInitiator = new AbortController()
  await controller.request({
    id: "request-2",
    operation: "host.export.run",
    input: { ...exportInput, preflightOnly: true },
    signal: secondInitiator.signal,
  })
  const secondAccepted = await controller.request({
    id: "request-2",
    operation: "host.export.run",
    input: exportInput,
    signal: secondInitiator.signal,
  })
  expect(secondAccepted.result).toEqual({ jobId: "job-2", status: "queued" })
  secondInitiator.abort()
  expect((await controller.request({
    id: "cancel-2",
    operation: "host.export.cancel",
    input: { jobId: "job-2" },
    signal: new AbortController().signal,
  })).result).toEqual({
    status: "canceled",
    job: { id: "job-2", outputs: [] },
  })
  expect(submissions).toBe(2)

  unregister()
  queue.dispose()
})

test("attaches control only to an existing mounted local project", async () => {
  installBridge([])
  const project = await createLocalProject(`Attached control ${crypto.randomUUID()}`)
  let mountedProjectId = project.id
  const { controller, dispose } = createController(() => mountedProjectId)
  const unregister = registerAttachedHostController(controller)

  const capabilities = await requestControl(controller, "control.capabilities", {}, undefined, controlActor)
  expect(capabilities.result).toMatchObject({ executionTarget: "local-project" })
  const snapshot = await requestControl(controller, "control.snapshot", { projectId: project.id }, undefined, controlActor)
  expect(snapshot.result).toMatchObject({ project: { id: project.id } })

  for (const invalidMount of ["cloud-project", `project:${crypto.randomUUID()}`, ""]) {
    mountedProjectId = invalidMount
    const response = await requestControl(controller, "control.capabilities", {}, undefined, controlActor)
    expect(response.error).toEqual({
      version: "v1",
      code: "not-found",
      message: "A mounted local project is required.",
    })
  }
  mountedProjectId = project.id
  await deleteLocalProject(project.id)
  expect((await requestControl(controller, "control.capabilities", {}, undefined, controlActor)).error).toEqual({
    version: "v1",
    code: "not-found",
    message: "A mounted local project is required.",
  })

  unregister()
  dispose()
})

test("rejects an unmounted local project without dispatching to it", async () => {
  installBridge([])
  const mounted = await createLocalProject(`Mounted ${crypto.randomUUID()}`)
  const other = await createLocalProject(`Other ${crypto.randomUUID()}`)
  const { controller, dispose } = createController(() => mounted.id)
  const unregister = registerAttachedHostController(controller)

  expect((await requestControl(controller, "control.snapshot", { projectId: other.id }, undefined, controlActor)).error).toEqual({
    version: "v1",
    code: "not-found",
    message: "A mounted local project is required.",
  })
  const otherHistory = await createLocalControlService({ actor: { subject: controlActor } })
    .history({ projectId: other.id, limit: 10 })
  expect(otherHistory.entries).toEqual([])

  unregister()
  dispose()
})

test("runs the complete local control flow with the trusted actor", async () => {
  installBridge([])
  const project = await createLocalProject(`Control flow ${crypto.randomUUID()}`)
  const { controller, dispose } = createController(() => project.id)
  const unregister = registerAttachedHostController(controller)

  const initial = await requestControl(controller, "control.snapshot", { projectId: project.id }, undefined, controlActor)
  const snapshot = initial.result
  if (typeof snapshot !== "object" || snapshot === null || !("tracks" in snapshot) || !Array.isArray(snapshot.tracks)) {
    throw new Error("Expected control snapshot tracks.")
  }
  const track = snapshot.tracks[0]
  if (typeof track !== "object" || track === null || !("id" in track) || typeof track.id !== "string") {
    throw new Error("Expected control snapshot track.")
  }
  const destructive = {
    version: "v1" as const,
    projectId: project.id,
    actions: [{ kind: "track.delete" as const, track: { source: "persisted" as const, id: track.id } }],
  }
  expect((await requestControl(controller, "control.preview", {
    version: "v1",
    projectId: project.id,
    actions: [{ kind: "project.rename", name: "Preview only" }],
  }, undefined, controlActor)).result).toMatchObject({ applied: true })
  const approval = await requestControl(controller, "control.requestApproval", destructive, undefined, controlActor)
  const approvalResult = approval.result
  if (typeof approvalResult !== "object" || approvalResult === null || !("approvalToken" in approvalResult) || typeof approvalResult.approvalToken !== "string") {
    throw new Error("Expected local control approval.")
  }
  expect((await requestControl(controller, "control.commit", {
    ...destructive,
    idempotencyKey: "attached-destructive-commit",
    approvalToken: approvalResult.approvalToken,
  }, undefined, controlActor)).result).toMatchObject({ applied: true })
  const history = await requestControl(controller, "control.history", { projectId: project.id, limit: 10 }, undefined, controlActor)
  expect(history.result).toMatchObject({ entries: [expect.objectContaining({ actorSubject: controlActor })] })
  const recoveries = await requestControl(controller, "control.recoveries", { projectId: project.id, limit: 10 }, undefined, controlActor)
  expect(recoveries.result).toMatchObject({ entries: [expect.objectContaining({ kind: "track.delete" })] })

  unregister()
  dispose()
})

test("preserves local control errors and fails closed without a trusted actor", async () => {
  installBridge([])
  const project = await createLocalProject(`Control errors ${crypto.randomUUID()}`)
  const { controller, dispose } = createController(() => project.id)
  const unregister = registerAttachedHostController(controller)

  expect((await requestControl(controller, "control.preview", {
    version: "v1",
    projectId: project.id,
    actions: [
      { kind: "recovery.restore", recovery: { id: "local-recovery:duplicate" } },
      { kind: "recovery.restore", recovery: { id: "local-recovery:duplicate" } },
    ],
  }, undefined, controlActor)).error).toMatchObject({ code: "validation", actionIndex: 1 })
  expect((await requestControl(controller, "control.snapshot", { projectId: project.id })).error).toEqual({
    version: "v1",
    code: "authorization",
    message: "A trusted local control actor is required.",
  })

  unregister()
  dispose()
})

test("cancels or rejects control requests that change mount during lookup", async () => {
  installBridge([])
  const first = await createLocalProject(`First mount ${crypto.randomUUID()}`)
  const second = await createLocalProject(`Second mount ${crypto.randomUUID()}`)
  const localProject = await getLocalProject(first.id)
  if (!localProject) throw new Error("Expected local project.")
  let mountedProjectId = first.id
  let releaseLookup: ((project: typeof localProject | undefined) => void) | undefined
  const lookup = async () => new Promise<Awaited<ReturnType<typeof getLocalProject>>>((resolve) => {
    releaseLookup = resolve
  })
  const { controller, dispose } = createController(() => mountedProjectId, lookup)
  const unregister = registerAttachedHostController(controller)

  const pending = requestControl(controller, "control.snapshot", { projectId: first.id }, undefined, controlActor)
  mountedProjectId = second.id
  releaseLookup?.(localProject)
  expect((await pending).error).toEqual({
    version: "v1",
    code: "not-found",
    message: "A mounted local project is required.",
  })

  mountedProjectId = first.id
  const abortDuringLookup = new AbortController()
  const abortedPending = requestControl(
    controller,
    "control.snapshot",
    { projectId: first.id },
    abortDuringLookup.signal,
    controlActor,
  )
  abortDuringLookup.abort()
  releaseLookup?.(localProject)
  expect((await abortedPending).error?.code).toBe("internal")

  const abort = new AbortController()
  abort.abort()
  expect((await requestControl(controller, "control.snapshot", { projectId: second.id }, abort.signal, controlActor)).error?.code).toBe("cancelled")

  unregister()
  dispose()
})

test("does not commit after cancellation while waiting for the asset lock", async () => {
  installBridge([])
  const project = await createLocalProject(`Locked cancellation ${crypto.randomUUID()}`)
  const initial = await createLocalControlService({ actor: { subject: controlActor } })
    .snapshot({ projectId: project.id })
  let releaseLock: (() => void) | undefined
  let lockHeld: (() => void) | undefined
  const lock = withLocalProjectAssetLock(project.id, async () => {
    lockHeld?.()
    await new Promise<void>((resolve) => {
      releaseLock = resolve
    })
  })
  await new Promise<void>((resolve) => {
    lockHeld = resolve
  })
  const { controller, dispose } = createController(() => project.id)
  const unregister = registerAttachedHostController(controller)
  const abort = new AbortController()
  const pending = requestControl(controller, "control.commit", {
    version: "v1",
    projectId: project.id,
    idempotencyKey: "locked-cancel",
    actions: [{ kind: "project.rename", name: "Should not commit" }],
  }, abort.signal, controlActor)
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  abort.abort()
  releaseLock?.()
  await lock
  expect((await pending).error?.code).toBe("internal")

  const inspected = createLocalControlService({ actor: { subject: controlActor } })
  expect((await inspected.snapshot({ projectId: project.id })).project).toEqual(initial.project)
  expect((await inspected.history({ projectId: project.id, limit: 10 })).entries).toEqual([])

  unregister()
  dispose()
})

test("does not commit after a mount switch while waiting for the asset lock", async () => {
  installBridge([])
  const first = await createLocalProject(`Locked first ${crypto.randomUUID()}`)
  const second = await createLocalProject(`Locked second ${crypto.randomUUID()}`)
  const initial = await createLocalControlService({ actor: { subject: controlActor } })
    .snapshot({ projectId: first.id })
  let mountedProjectId = first.id
  let mountedProjectGeneration = 0
  let releaseLock: (() => void) | undefined
  let lockHeld: (() => void) | undefined
  const lock = withLocalProjectAssetLock(first.id, async () => {
    lockHeld?.()
    await new Promise<void>((resolve) => {
      releaseLock = resolve
    })
  })
  await new Promise<void>((resolve) => {
    lockHeld = resolve
  })
  const { controller, dispose } = createController(
    () => mountedProjectId,
    undefined,
    () => mountedProjectGeneration,
  )
  const unregister = registerAttachedHostController(controller)
  const pending = requestControl(controller, "control.commit", {
    version: "v1",
    projectId: first.id,
    idempotencyKey: "locked-switch",
    actions: [{ kind: "project.rename", name: "Should not commit" }],
  }, undefined, controlActor)
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
  mountedProjectId = second.id
  mountedProjectGeneration += 1
  mountedProjectId = first.id
  mountedProjectGeneration += 1
  releaseLock?.()
  await lock
  expect((await pending).error).toEqual({
    version: "v1",
    code: "not-found",
    message: "A mounted local project is required.",
  })

  const inspected = createLocalControlService({ actor: { subject: controlActor } })
  expect((await inspected.snapshot({ projectId: first.id })).project).toEqual(initial.project)
  expect((await inspected.history({ projectId: first.id, limit: 10 })).entries).toEqual([])

  unregister()
  dispose()
})

test("pre-accept cancellation does not retain prepared export state", async () => {
  installBridge([])
  let releasePreparation: (() => void) | undefined
  let submissions = 0
  const service: TimelineExportService = {
    enqueueTimelineExport: async () => ({ type: "error", message: "unused", outputs: [] }),
    enqueueStemExport: async () => ({ type: "error", message: "unused", outputs: [] }),
    submitTimelineExport: async () => {
      throw new Error("unused")
    },
    submitStemExport: async () => {
      throw new Error("unused")
    },
    prepareTimelineExport: async () => {
      await new Promise<void>((resolve) => {
        releasePreparation = resolve
      })
      return prepared
    },
    prepareStemExport: async () => {
      throw new Error("unused")
    },
    submitPreparedTimelineExport: () => {
      submissions += 1
      return { id: "unexpected", completion: Promise.resolve({ type: "success", outputs: [] }) }
    },
    submitPreparedStemExport: () => {
      throw new Error("unused")
    },
    cancel: () => undefined,
    status: () => undefined,
  }
  const queue = createExportQueue()
  const controller = createAttachedHostController({
    projectId: () => "project-1",
    mountedProjectGeneration: () => 0,
    isPlaying: () => false,
    playheadSec: () => 0,
    tracks: () => prepared.snapshot.tracks,
    audioEngine: new AudioEngine(),
    requestPlay: async () => undefined,
    pause: async () => undefined,
    stop: async () => undefined,
    finishRecording: async () => undefined,
    exportService: service,
    exportQueue: queue,
    importFiles: async () => ({ outcomes: [] }),
    setPlayhead: () => undefined,
  })
  const unregister = registerAttachedHostController(controller)
  const initiator = new AbortController()
  const preflight = controller.request({
    id: "request-canceled",
    operation: "host.export.run",
    input: { ...exportInput, preflightOnly: true },
    signal: initiator.signal,
  })
  initiator.abort()
  releasePreparation?.()
  expect((await preflight).error?.code).toBe("cancelled")
  const final = await controller.request({
    id: "request-canceled",
    operation: "host.export.run",
    input: exportInput,
    signal: new AbortController().signal,
  })
  expect(final.error?.code).toBe("invalid-request")
  expect(submissions).toBe(0)

  unregister()
  queue.dispose()
})
