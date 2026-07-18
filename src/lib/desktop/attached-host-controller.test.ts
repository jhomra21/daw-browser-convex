import { expect, test } from "bun:test"
import { AudioEngine } from "@daw-browser/audio-engine/audio-engine"

import { createExportQueue } from "~/lib/export/export-queue"
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
