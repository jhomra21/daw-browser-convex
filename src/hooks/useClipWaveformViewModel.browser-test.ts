import { describe, expect, test } from 'bun:test'
import { createEffect, createRoot, createSignal } from 'solid-js'

import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'
import { useClipWaveformViewModel } from './useClipWaveformViewModel'

const source: AudioPcmSourceDescriptor = {
  identity: 'waveform-reactivity-test-source',
  durationSec: 1,
  frameCount: 1_000,
  sampleRate: 1_000,
  channelCount: 1,
  readPages: async function* (options = {}) {
    const startFrame = options.startFrame ?? 0
    const endFrame = options.endFrame ?? source.frameCount
    const frameCount = endFrame - startFrame
    if (frameCount <= 0) return
    yield {
      startFrame,
      frameCount,
      sampleRate: source.sampleRate,
      channelCount: source.channelCount,
      planes: [new Float32Array(frameCount)],
    }
  },
}

const clip: RuntimeClip = {
  id: 'clip:waveform-reactivity',
  name: 'Waveform reactivity',
  startSec: 0,
  duration: 1,
  sourceAssetKey: 'asset:waveform-reactivity',
  sourceDurationSec: source.durationSec,
  sourceSampleRate: source.sampleRate,
  sourceChannelCount: source.channelCount,
  color: '#ffffff',
}

describe('useClipWaveformViewModel browser reactivity', () => {
  test('does not recurse when a renderable waveform responds to zoom', async () => {
    await new Promise<void>((resolve, reject) => createRoot((dispose) => {
      const [width, setWidth] = createSignal(500)
      let resolverCalls = 0
      let loadingStarts = 0
      const resolveAudioSource: AudioPcmSourceResolver = async (_clip, signal) => {
        resolverCalls += 1
        signal?.throwIfAborted()
        return source
      }
      const waveform = useClipWaveformViewModel({
        clip: () => clip,
        cssWidthPx: width,
        projectBpm: () => 120,
        resolveAudioSource: () => resolveAudioSource,
        visibleRange: () => ({ startSec: 0, endSec: 1 }),
      })

      createEffect(() => {
        if (waveform.loading()) loadingStarts += 1
      })

      const waitForReady = () => new Promise<void>((settle) => {
        let sawLoading = false
        createEffect(() => {
          if (waveform.loading()) {
            sawLoading = true
          } else if (sawLoading) {
            settle()
          }
        })
      })

      void (async () => {
        await waitForReady()
        expect(resolverCalls).toBe(1)
        expect(loadingStarts).toBe(1)
        expect(waveform.layout().drawCols).toBe(500)

        const rerenders = { count: 0 }
        createEffect(() => {
          if (waveform.layout().drawCols > 0) rerenders.count += 1
        })
        const rerendersBeforeZoom = rerenders.count
        const zoomComplete = waitForReady()
        setWidth(600)
        await zoomComplete

        expect(rerenders.count - rerendersBeforeZoom).toBe(1)
        expect(resolverCalls).toBe(1)
        expect(loadingStarts).toBe(2)
        expect(waveform.layout().drawCols).toBe(600)
        dispose()
        resolve()
      })().catch((error) => {
        dispose()
        reject(error)
      })
    }))
  })
})
