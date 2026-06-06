import { disconnectAudioNodes } from './effects/chain'

export type SourceRegistry = {
  add: (clipId: string, source: AudioScheduledSourceNode) => void
  remove: (clipId: string, source: AudioScheduledSourceNode) => void
  snapshot: () => AudioScheduledSourceNode[]
  clear: () => void
  stopClip: (clipId: string) => void
}

export const stopAndDisconnectSource = (source: AudioScheduledSourceNode, stopAt?: number) => {
  try {
    if (typeof stopAt === 'number') source.stop(stopAt)
    else source.stop()
  } catch {
    try { source.stop() } catch {}
  }
  disconnectAudioNodes([source])
}

export function createSourceRegistry(): SourceRegistry {
  const activeSources: AudioScheduledSourceNode[] = []
  const activeSourcesByClip = new Map<string, Set<AudioScheduledSourceNode>>()

  const remove = (clipId: string, source: AudioScheduledSourceNode) => {
    const index = activeSources.indexOf(source)
    if (index >= 0) activeSources.splice(index, 1)
    const clipSources = activeSourcesByClip.get(clipId)
    if (!clipSources) return
    clipSources.delete(source)
    if (clipSources.size === 0) activeSourcesByClip.delete(clipId)
  }

  return {
    add: (clipId, source) => {
      activeSources.push(source)
      let clipSources = activeSourcesByClip.get(clipId)
      if (!clipSources) {
        clipSources = new Set()
        activeSourcesByClip.set(clipId, clipSources)
      }
      clipSources.add(source)
    },
    remove,
    snapshot: () => Array.from(activeSources),
    clear: () => {
      activeSources.length = 0
      activeSourcesByClip.clear()
    },
    stopClip: (clipId) => {
      const sources = activeSourcesByClip.get(clipId)
      if (!sources) return
      for (const source of Array.from(sources)) {
        stopAndDisconnectSource(source)
        remove(clipId, source)
      }
      activeSourcesByClip.delete(clipId)
    },
  }
}
