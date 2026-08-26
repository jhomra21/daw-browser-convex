import { resolveApiBaseOrigin, type RendererApiRuntime } from './renderer-api-url'

export const resolveAuthBaseUrl = (
  configuredBaseUrl: string | undefined,
  runtime: RendererApiRuntime,
): string | undefined => {
  const origin = resolveApiBaseOrigin(configuredBaseUrl, runtime)
  return origin === '' ? runtime.browserOrigin : origin ?? undefined
}
