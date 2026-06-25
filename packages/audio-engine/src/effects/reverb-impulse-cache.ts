import type { ReverbParamsLite } from '@daw-browser/shared'
import { createImpulseResponseBuffer, createReverbImpulseRender } from './dsp'

type ReverbImpulseRenderContext = Pick<BaseAudioContext, 'sampleRate'>
type ReverbImpulseBufferContext = Pick<BaseAudioContext, 'sampleRate' | 'createBuffer'>

type ReverbImpulseCacheOptions<TBuffer> = {
  bucketSize?: number
  limit?: number
  createBuffer?: (ctx: ReverbImpulseRenderContext, render: ReturnType<typeof createReverbImpulseRender>) => TBuffer
}

export function createReverbImpulseCache(options?: ReverbImpulseCacheOptions<AudioBuffer>): {
  get: (ctx: ReverbImpulseBufferContext, params: ReverbParamsLite) => AudioBuffer
  clear: () => void
}
export function createReverbImpulseCache<TBuffer>(options: ReverbImpulseCacheOptions<TBuffer> & { createBuffer: (ctx: ReverbImpulseRenderContext, render: ReturnType<typeof createReverbImpulseRender>) => TBuffer }): {
  get: (ctx: ReverbImpulseRenderContext, params: ReverbParamsLite) => TBuffer
  clear: () => void
}
export function createReverbImpulseCache<TBuffer>(options?: ReverbImpulseCacheOptions<TBuffer | AudioBuffer>) {
  const cache = new Map<string, TBuffer | AudioBuffer>()

  const get = (ctx: ReverbImpulseBufferContext | ReverbImpulseRenderContext, params: ReverbParamsLite) => {
    const render = createReverbImpulseRender(ctx, params, {
      bucketSize: options?.bucketSize,
    })
    const cacheKey = `${ctx.sampleRate}:${render.info.signature}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const buffer = options?.createBuffer
      ? options.createBuffer(ctx, render)
      : createRenderedImpulseBuffer(ctx, render)
    cache.set(cacheKey, buffer)
    if (options?.limit !== undefined) {
      while (cache.size > options.limit) {
        for (const oldestKey of cache.keys()) {
          cache.delete(oldestKey)
          break
        }
      }
    }
    return buffer
  }

  return {
    get,
    clear: () => cache.clear(),
  }
}

function createRenderedImpulseBuffer(
  ctx: ReverbImpulseBufferContext | ReverbImpulseRenderContext,
  render: ReturnType<typeof createReverbImpulseRender>,
) {
  if (!hasCreateBuffer(ctx)) {
    throw new Error('Reverb impulse cache requires a buffer factory')
  }
  return createImpulseResponseBuffer(ctx, render).buffer
}

function hasCreateBuffer(ctx: ReverbImpulseBufferContext | ReverbImpulseRenderContext): ctx is ReverbImpulseBufferContext {
  return 'createBuffer' in ctx
}
