import { maxVst3WorkerFrames } from "@daw-browser/plugin-host-protocol"
import type { createTimelineExportService } from "~/lib/export/timeline-export-service"
import { compileNativeExternalAttachmentPlan } from "~/lib/desktop/native-external-attachment-plan"
import { compileLivePlaybackSnapshot } from "~/lib/live-playback-snapshot"
import { listLocalExternalProcessors, persistLocalExternalProcessorState, readLocalExternalProcessorState } from "~/lib/external-plugins"
import { desktopBridge } from "~/lib/runtime"

type NativeOfflineExternalAttachments = NonNullable<
  Parameters<typeof createTimelineExportService>[0]["getNativeOfflineExternalAttachments"]
>

export const createNativeOfflineExternalAttachments = (
  userId: () => string | undefined,
): NativeOfflineExternalAttachments => {
  return async ({ projectId: capturedProjectId, localProject, tracks, renderState, bpm, timeSignature, sidechainRoutes }) => {
    if (!capturedProjectId || !localProject) return undefined

    const processors = (await listLocalExternalProcessors(capturedProjectId))
      .filter((processor) => !processor.bypassed)

    if (processors.length === 0) return undefined

    const playback = compileLivePlaybackSnapshot({
      revision: 1,
      bpm,
      timeSignature,
      transport: {
        state: "stopped",
        playheadSec: 0,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      },
      tracks,
      renderState,
      sidechainRoutes,
    })

    if (!playback.supported) throw new Error(playback.reasons.join(" "))

    const attachmentPlan = compileNativeExternalAttachmentPlan({
      target: "native",
      graph: playback.snapshot.mixer.graph,
      processors,
      workerTransport: {
        slotCount: 2,
        maximumFrames: maxVst3WorkerFrames,
        maximumEventsPerBlock: 128,
      },
    })

    if (!attachmentPlan.supported) throw new Error(attachmentPlan.reasons.join(" "))

    const capturedVstStates = await Promise.all(attachmentPlan.plan.attachments
      .filter((attachment) => !attachment.bypassed)
      .map(async (attachment) => {
        const processor = processors.find((candidate) => candidate.instanceId === attachment.instanceId)

        if (!processor) throw new Error(`Native VST3 processor "${attachment.instanceId}" is missing.`)

        if (!processor.manifest.supportsState) return undefined
        const capture = await desktopBridge()?.audioHost?.session.captureVstState(attachment.instanceId)

        if (capture?.ok) {
          const persisted = await persistLocalExternalProcessorState(
            capturedProjectId,
            attachment.instanceId,
            capture,
            userId() ?? processor.state?.ownerId ?? processor.launchReference?.state?.ownerId ?? "",
          )

          if (!persisted) throw new Error(`Native VST3 processor "${attachment.instanceId}" was deleted during export.`)

          return { instanceId: attachment.instanceId, bytes: capture.bytes, sha256: capture.sha256 }
        }

        const persisted = await readLocalExternalProcessorState(capturedProjectId, processor)

        if (persisted) return { instanceId: attachment.instanceId, ...persisted }
        throw new Error(`Native VST3 attachment "${attachment.instanceId}" live state capture failed${capture?.error ? `: ${capture.error}` : "."}`)
      }))

    return {
      plan: attachmentPlan.plan,
      capturedVstStates: capturedVstStates.filter((state): state is NonNullable<typeof state> => state !== undefined),
    }
  }
}
