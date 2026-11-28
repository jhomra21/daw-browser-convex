import { createNativeOfflinePcmSpool, type NativeOfflinePcmSpoolSession } from '~/lib/export/native-offline-pcm-spool'

type PcmChunk = { frameCount: number; planes: readonly Float32Array[] }

// The onChunk sink of a portable render: the first chunk opens the PCM spool session, every chunk is appended to it.
// Without a channelCount the session takes the plane count of the first chunk.
export const createPortableSpoolWriter = (config: {
  sessionPrefix: string
  sampleRate: number
  channelCount?: number
  onCreate?: (session: NativeOfflinePcmSpoolSession) => void
}) => {
  let session: NativeOfflinePcmSpoolSession | undefined

  return {
    session: () => session,
    write: async (_index: number, startFrame: number, pcm: PcmChunk, totalFrames: number) => {
      if (!session) {
        session = await createNativeOfflinePcmSpool().createSession({
          sessionId: `${config.sessionPrefix}-${crypto.randomUUID()}`,
          sampleRate: config.sampleRate,
          channelCount: config.channelCount ?? pcm.planes.length,
          totalFrames,
        })
        config.onCreate?.(session)
      }

      await session.append({
        startFrame,
        frameCount: pcm.frameCount,
        channelCount: pcm.planes.length,
        planes: pcm.planes,
      })
    },
  }
}
