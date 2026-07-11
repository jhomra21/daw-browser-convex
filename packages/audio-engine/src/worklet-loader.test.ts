import { describe, expect, test } from 'bun:test'
import { loadWorkletModule } from './worklet-loader'
import { compressorWorklet, recorderWorklet, resolveWorkletModuleUrl, trackMeterWorklet } from './worklet-manifest'

describe('worklet loader', () => {
  test('deduplicates in-flight and completed registration per context', async () => {
    let calls = 0
    let resolveRegistration = () => {}
    const context = {
      audioWorklet: {
        addModule: () => {
          calls += 1
          return new Promise<void>((resolve) => {
            resolveRegistration = resolve
          })
        },
      },
    }
    const first = loadWorkletModule(context, '/processor.js')
    const second = loadWorkletModule(context, '/processor.js')
    expect(first).toBe(second)
    expect(calls).toBe(1)
    resolveRegistration()
    await first
    await loadWorkletModule(context, '/processor.js')
    expect(calls).toBe(1)
  })

  test('allows retry after registration failure', async () => {
    let calls = 0
    const context = {
      audioWorklet: {
        addModule: () => {
          calls += 1
          return calls === 1 ? Promise.reject(new Error('failed')) : Promise.resolve()
        },
      },
    }
    await expect(loadWorkletModule(context, '/processor.js')).rejects.toThrow('failed')
    await loadWorkletModule(context, '/processor.js')
    expect(calls).toBe(2)
  })
})

describe('worklet manifest', () => {
  test('resolves versioned assets below the deployment base', () => {
    expect(resolveWorkletModuleUrl(compressorWorklet.modulePath, '/studio/')).toBe(
      '/studio/audio-worklets/daw-compressor-processor-v1.js',
    )
    expect(resolveWorkletModuleUrl(trackMeterWorklet.modulePath, '/studio')).toBe(
      '/studio/audio-worklets/track-meter-processor-v2.js',
    )
    expect(resolveWorkletModuleUrl(recorderWorklet.modulePath, '/studio/')).toBe(
      '/studio/audio-worklets/daw-recorder-processor-v1.js',
    )
  })
})
