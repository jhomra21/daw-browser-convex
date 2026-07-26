import { resolveApiBaseOrigin, type RendererApiRuntime } from './renderer-api-url'

export const resolveAuthBaseUrl = (
  configuredBaseUrl: unknown,
  runtime: RendererApiRuntime,
): string | undefined => {
  const origin = resolveApiBaseOrigin(configuredBaseUrl, runtime)
  return origin === '' ? runtime.browserOrigin : origin ?? undefined
}
