import type {
  NativeOfflinePcmChunk,
  NativeOfflineRenderPlan,
} from '@daw-browser/audio-engine/native-host-wire'

import {
  createNativeOfflinePcmSpool,
  type NativeOfflinePcmSpoolSession,
} from '~/lib/export/native-offline-pcm-spool'
import { NativeOfflineRenderError } from '~/lib/export/desktop-native-offline-renderer'

type DesktopNativeOfflinePcmRendererBridge = {
  start(
    jobId: string,
    plan: NativeOfflineRenderPlan,
    onChunk: (chunk: NativeOfflinePcmChunk) => void | Promise<void>,
  ): Promise<{ ok: true } | { ok: false; error: string }>
  cancel(jobId: string): Promise<{ accepted: boolean }>
}

type NativeOfflinePcmSpoolFactory = {
  createSession(input: {
    sessionId: string
    sampleRate: number
    channelCount: number
    totalFrames: number
  }): Promise<NativeOfflinePcmSpoolSession>
}

export type NativeOfflinePcmRenderer = (
  plan: NativeOfflineRenderPlan,
  signal: AbortSignal,
  onProgress: (renderedFrames: number, totalFrames: number) => void,
) => Promise<NativeOfflinePcmSpoolSession>

export const createDesktopNativeOfflinePcmRenderer = (
  renderer: DesktopNativeOfflinePcmRendererBridge,
  spool: NativeOfflinePcmSpoolFactory = createNativeOfflinePcmSpool(),
): NativeOfflinePcmRenderer => async (plan, signal, onProgress) => {
  signal.throwIfAborted()
  const jobId = `offline-${crypto.randomUUID()}`
  const session = await spool.createSession({
    sessionId: jobId,
    sampleRate: plan.sampleRateHz,
    channelCount: plan.channelCount,
    totalFrames: plan.totalFrames,
  })
  let renderedFrames = 0
  let callbackError: Error | undefined
  const cancel = () => { void renderer.cancel(jobId) }
  signal.addEventListener('abort', cancel, { once: true })

  try {
    let result: Awaited<ReturnType<DesktopNativeOfflinePcmRendererBridge['start']>>
    try {
      result = await renderer.start(jobId, plan, async (chunk) => {
        if (callbackError) return
        try {
          if (chunk.startFrame !== renderedFrames
            || chunk.frameCount <= 0
            || chunk.channelCount !== plan.channelCount
            || chunk.startFrame + chunk.frameCount > plan.totalFrames
            || chunk.planes.length !== plan.channelCount) {
            throw new NativeOfflineRenderError('Native offline PCM chunks are invalid or noncontiguous.')
          }
          for (const plane of chunk.planes) {
            if (plane.length !== chunk.frameCount) {
              throw new NativeOfflineRenderError('Native offline PCM chunk is missing a channel.')
            }
          }
          await session.append(chunk)
          renderedFrames += chunk.frameCount
          onProgress(renderedFrames, plan.totalFrames)
        } catch (error) {
          callbackError = error instanceof Error
            ? error
            : new NativeOfflineRenderError('Native offline PCM spool callback failed.')
          void renderer.cancel(jobId)
          throw callbackError
        }
      })
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      if (callbackError) throw callbackError
      throw new NativeOfflineRenderError(error instanceof Error ? error.message : 'Native offline renderer failed.')
    }
    if (callbackError) throw callbackError
    if (!result.ok) {
      if (signal.aborted) throw new DOMException('Native offline rendering canceled.', 'AbortError')
      throw new NativeOfflineRenderError(result.error)
    }
    if (renderedFrames !== plan.totalFrames) {
      throw new NativeOfflineRenderError('Native offline rendering returned incomplete PCM.')
    }
    await session.finalize()
    return session
  } catch (error) {
    await session.abort().catch(() => undefined)
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
