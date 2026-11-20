import type { IpcMain } from "electron"
import { createHash } from "node:crypto"
import { z } from "zod"
import { requestIdSchema } from "@daw-browser/desktop-protocol/wire-patterns"
import { offlineCancelChannel, offlineMappedPageRequestChannel, offlineMappedPageResponseChannel, offlinePcmAckChannel, offlinePcmChannel, offlineRenderChannel } from "@daw-browser/desktop-protocol/ipc-channels"
import { resolveNativeVst3AttachmentPlan } from "./native-vst3-coordinator"
import { renderNativeOffline } from "./audio-host"
import type { NativeHostMappedAssetPage, NativeOfflineRenderPlan } from "@daw-browser/audio-engine/native-host-wire"
import { nativeAudioHostMaximumMappedAssetPageBytes, nativeOfflineRenderPlanSchema } from "@daw-browser/desktop-protocol/native-audio-host"
import { createOfflinePcmAckTracker } from "./offline-pcm-ack"
import { offlinePcmAckSchema } from "./offline-pcm-protocol"
import { positiveUnsigned32Schema } from "./native-session-schemas"
import type { NativeSessionEvent } from "./ipc/native-session-access"
import type { createPluginCatalogOwner } from "./plugin-catalog-owner"
import type { RendererSession } from "./renderer-session"

const offlineRenderRequestSchema = z.object({
  jobId: z.string().min(1).max(128),
  plan: nativeOfflineRenderPlanSchema,
}).passthrough()

const offlineMappedPageResponseSchema = z.object({
  jobId: z.string().min(1).max(128),
  requestId: requestIdSchema,
  page: z.object({
    sessionAssetId: positiveUnsigned32Schema,
    startFrame: z.number().int().nonnegative().safe(),
    frameCount: positiveUnsigned32Schema,
    planarPcm: z.instanceof(Uint8Array).refine((value) => (
      value.byteLength > 0
      && value.byteLength <= nativeAudioHostMaximumMappedAssetPageBytes
    )),
  }).strict().optional(),
  error: z.string().max(256).optional(),
}).strict().refine((value) => (value.page !== undefined) !== (value.error !== undefined))

/** The renderer-driven native offline render: one job at a time, with its PCM chunks and mapped asset pages exchanged over IPC. */
export const createOfflineRender = (rendererSession: RendererSession) => {
  let offlineRenderJob: {
    jobId: string
    controller: AbortController
    nextSequence: number
    mappedPageRequests: Map<string, {
      sessionAssetId: number
      startFrame: number
      frameCount: number
      channelCount: number
      resolve: (page: NativeHostMappedAssetPage) => void
      reject: (error: Error) => void
      cleanup: () => void
    }>
  } | undefined

  const maximumPendingOfflineMappedPageRequests = 4
  const offlinePcmAcks = createOfflinePcmAckTracker()

  const abortOfflineRenderJobs = () => {
    offlinePcmAcks.cancel(new DOMException("Native offline rendering canceled.", "AbortError"))
    offlineRenderJob?.controller.abort()
  }

  const register = (options: {
    ipcMain: IpcMain
    allowed: (event: NativeSessionEvent) => boolean
    pluginCatalog: ReturnType<typeof createPluginCatalogOwner>
    hostPath: string | undefined
  }) => {
    const { ipcMain, allowed, pluginCatalog, hostPath } = options

  ipcMain.on(offlinePcmAckChannel, (event, value) => {
    if (!allowed(event)) return
    const parsed = offlinePcmAckSchema.safeParse(value)

    if (!parsed.success) {
      offlinePcmAcks.cancel(new Error("The native offline PCM acknowledgement is invalid."))

      return
    }

    offlinePcmAcks.acknowledge(parsed.data)
  })
  ipcMain.handle(offlineMappedPageResponseChannel, (event, value) => {
    if (!allowed(event)) return { accepted: false }
    const parsed = offlineMappedPageResponseSchema.safeParse(value)

    if (!parsed.success || !offlineRenderJob || parsed.data.jobId !== offlineRenderJob.jobId) {
      return { accepted: false }
    }

    const pending = offlineRenderJob.mappedPageRequests.get(parsed.data.requestId)

    if (!pending) return { accepted: false }

    if (parsed.data.page && (
      parsed.data.page.sessionAssetId !== pending.sessionAssetId
      || parsed.data.page.startFrame !== pending.startFrame
      || parsed.data.page.frameCount !== pending.frameCount
      || parsed.data.page.planarPcm.byteLength
        !== pending.frameCount * pending.channelCount * Float32Array.BYTES_PER_ELEMENT
    )) {
      offlineRenderJob.mappedPageRequests.delete(parsed.data.requestId)
      pending.cleanup()
      pending.reject(new Error("The native offline mapped page response does not match its request."))

      return { accepted: false }
    }

    offlineRenderJob.mappedPageRequests.delete(parsed.data.requestId)
    pending.cleanup()

    if (parsed.data.error) pending.reject(new Error(parsed.data.error))
    else if (parsed.data.page) pending.resolve(parsed.data.page)
    else pending.reject(new Error("The offline mapped page response is invalid."))

    return { accepted: true }
  })

  const offlinePlan = (value: NativeOfflineRenderPlan): NativeOfflineRenderPlan | undefined => {
    for (const state of value.capturedVstStates ?? []) {
      if (createHash("sha256").update(state.bytes).digest("hex") !== state.sha256) return undefined
    }

    return value
  }

  ipcMain.handle(offlineRenderChannel, async (event, value) => {
    if (!allowed(event) || !hostPath) {
      return { ok: false as const, error: "The native offline renderer is unavailable." }
    }

    const request = offlineRenderRequestSchema.safeParse(value)

    if (!request.success) {
      return { ok: false as const, error: "The native offline renderer is unavailable." }
    }

    const jobId = request.data.jobId
    const plan = offlinePlan(request.data.plan)

    if (!plan) {
      return { ok: false as const, error: "The native offline render plan is invalid." }
    }

    if (offlineRenderJob?.jobId === jobId) {
      return { ok: false as const, error: "An offline render with this job ID is already active." }
    }

    if (offlineRenderJob) {
      return { ok: false as const, error: "Only one native offline render may be active at a time." }
    }

    const controller = new AbortController()
    const cancelOnDestroy = () => controller.abort()
    event.sender.once("destroyed", cancelOnDestroy)

    const job = {
      jobId,
      controller,
      nextSequence: 1,
      mappedPageRequests: new Map<string, {
        sessionAssetId: number
        startFrame: number
        frameCount: number
        channelCount: number
        resolve: (page: NativeHostMappedAssetPage) => void
        reject: (error: Error) => void
        cleanup: () => void
      }>(),
    }

    offlineRenderJob = job

    try {
      let vstAttachments: Awaited<ReturnType<typeof resolveNativeVst3AttachmentPlan>> | undefined

      if (plan.externalAttachments) {
        if (!pluginCatalog.workerPath) {
          throw new Error("The trusted native VST3 catalog or worker is unavailable.")
        }

        vstAttachments = await resolveNativeVst3AttachmentPlan({
          plan: plan.externalAttachments,
          sampleRateHz: plan.sampleRateHz,
          workerPath: pluginCatalog.workerPath,
          catalogStore: pluginCatalog.store,
          capturedVstStates: new Map(
            (plan.capturedVstStates ?? []).map((state) => [state.instanceId, state]),
          ),
          signal: controller.signal,
        })
      }

      await renderNativeOffline({
        hostPath: hostPath,
        jobId,
        plan,
        vstAttachments,
        signal: controller.signal,
        onMappedPage: (request, signal) => new Promise((resolve, reject) => {
          if (job.mappedPageRequests.size >= maximumPendingOfflineMappedPageRequests) {
            reject(new Error("Too many native offline mapped page requests are pending."))

            return
          }

          if (job.mappedPageRequests.has(request.requestId)) {
            reject(new Error("The native offline mapped page request ID is duplicated."))

            return
          }

          const cleanup = () => signal.removeEventListener("abort", abort)

          const abort = () => {
            if (job.mappedPageRequests.get(request.requestId)?.cleanup !== cleanup) return
            job.mappedPageRequests.delete(request.requestId)
            reject(new DOMException("Native offline mapped page request canceled.", "AbortError"))
          }

          job.mappedPageRequests.set(request.requestId, {
            sessionAssetId: request.asset.sessionAssetId,
            startFrame: request.startFrame,
            frameCount: request.frameCount,
            channelCount: request.asset.channelCount,
            resolve,
            reject,
            cleanup,
          })
          signal.addEventListener("abort", abort, { once: true })

          if (!rendererSession.send(offlineMappedPageRequestChannel, request)) {
            job.mappedPageRequests.delete(request.requestId)
            cleanup()
            reject(new Error("Renderer unavailable."))
          }
        }),
        onChunk: (chunk) => {
          if (offlineRenderJob !== job) throw new Error("The native offline render is no longer active.")
          const sequence = job.nextSequence
          job.nextSequence += 1
          const endFrame = chunk.startFrame + chunk.frameCount
          const acknowledgment = offlinePcmAcks.begin({ jobId, sequence, endFrame })

          if (!rendererSession.send(offlinePcmChannel, { jobId, sequence, chunk })) {
            offlinePcmAcks.cancel(new Error("Renderer unavailable."))
          }

          return acknowledgment
        },
      })

      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "Native offline rendering failed." }
    } finally {
      for (const pending of job.mappedPageRequests.values()) {
        pending.cleanup()
        pending.reject(new Error("The native offline render is no longer active."))
      }

      job.mappedPageRequests.clear()
      offlinePcmAcks.cancel(new Error("The native offline render is no longer active."))
      event.sender.removeListener("destroyed", cancelOnDestroy)

      if (offlineRenderJob === job) offlineRenderJob = undefined
    }
  })
  ipcMain.handle(offlineCancelChannel, (event, value) => {
    if (!allowed(event)) return { accepted: false }
    const jobId = z.string().min(1).max(128).safeParse(value)

    if (!jobId.success) return { accepted: false }

    if (!offlineRenderJob || offlineRenderJob.jobId !== jobId.data) return { accepted: false }
    offlineRenderJob.controller.abort()

    return { accepted: true }
  })
  }

  return { register, abort: abortOfflineRenderJobs }
}
