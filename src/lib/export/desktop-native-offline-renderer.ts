import type {
  NativeOfflinePcmChunk,
  NativeOfflineRenderPlan,
} from "@daw-browser/audio-engine/native-host-wire"
import {
  nativeAudioHostMaximumInMemoryPcmBytes,
  nativeOfflineRenderPcmBytes,
} from "@daw-browser/desktop-protocol/native-audio-host"

type DesktopNativeOfflineRendererBridge = {
  start(
    jobId: string,
    plan: NativeOfflineRenderPlan,
    onChunk: (chunk: NativeOfflinePcmChunk) => void | Promise<void>,
  ): Promise<{ ok: true } | { ok: false; error: string }>
  cancel(jobId: string): Promise<{ accepted: boolean }>
}

export class NativeOfflineRenderError extends Error {
  readonly owner = "native"

  constructor(message: string) {
    super(message)
    this.name = "NativeOfflineRenderError"
  }
}

export type NativeOfflineRenderer = (
  plan: NativeOfflineRenderPlan,
  signal: AbortSignal,
  onProgress: (renderedFrames: number, totalFrames: number) => void,
) => Promise<AudioBuffer>

export const createDesktopNativeOfflineRenderer = (
  renderer: DesktopNativeOfflineRendererBridge,
) => async (
  plan: NativeOfflineRenderPlan,
  signal: AbortSignal,
  onProgress: (renderedFrames: number, totalFrames: number) => void,
): Promise<AudioBuffer> => {
  const pcmBytes = nativeOfflineRenderPcmBytes(plan.totalFrames, plan.channelCount)
  if (!Number.isSafeInteger(pcmBytes) || pcmBytes > nativeAudioHostMaximumInMemoryPcmBytes) {
    throw new NativeOfflineRenderError("Native offline render exceeds the 512 MiB in-memory PCM limit.")
  }
  const jobId = `offline-${crypto.randomUUID()}`
  const buffer = new AudioBuffer({
    numberOfChannels: plan.channelCount,
    length: plan.totalFrames,
    sampleRate: plan.sampleRateHz,
  })
  let renderedFrames = 0
  let callbackError: Error | undefined
  const cancel = () => { void renderer.cancel(jobId) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    let result: Awaited<ReturnType<DesktopNativeOfflineRendererBridge["start"]>>
    try {
      result = await renderer.start(jobId, plan, (chunk) => {
        if (callbackError) return
        try {
          if (
            chunk.startFrame !== renderedFrames
            || chunk.frameCount <= 0
            || chunk.channelCount !== plan.channelCount
            || chunk.startFrame + chunk.frameCount > plan.totalFrames
            || chunk.planes.length !== plan.channelCount
          ) throw new NativeOfflineRenderError("Native offline PCM chunks are invalid or noncontiguous.")
          for (let channel = 0; channel < chunk.channelCount; channel += 1) {
            const plane = chunk.planes[channel]
            if (!plane || plane.length !== chunk.frameCount) {
              throw new NativeOfflineRenderError("Native offline PCM chunk is missing a channel.")
            }
            buffer.getChannelData(channel).set(plane, chunk.startFrame)
          }
          renderedFrames += chunk.frameCount
          onProgress(renderedFrames, plan.totalFrames)
        } catch (error) {
          callbackError = error instanceof NativeOfflineRenderError
            ? error
            : new NativeOfflineRenderError("Native offline PCM callback failed.")
          void renderer.cancel(jobId)
        }
      })
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error
      throw new NativeOfflineRenderError(error instanceof Error ? error.message : "Native offline renderer failed.")
    }
    if (callbackError) throw callbackError
    if (!result.ok) {
      if (signal.aborted) throw new DOMException("Native offline rendering canceled.", "AbortError")
      throw new NativeOfflineRenderError(result.error)
    }
    if (renderedFrames !== plan.totalFrames) {
      throw new NativeOfflineRenderError("Native offline rendering returned incomplete PCM.")
    }
    return buffer
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}
