const LOCAL_WORKER_ORIGIN = 'http://localhost:3000'

export type RendererApiRuntime = {
  isDesktop: boolean
  isDawProtocol: boolean
  browserOrigin: string
}

const isLoopbackHostname = (hostname: string) => (
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
)

const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/')

const isDefaultSampleApiUrl = (value: string) => {
  try {
    return new URL(value, 'https://renderer.invalid').pathname === '/api/default-sample'
  } catch {
    return false
  }
}

const parseConfiguredApiOrigin = (value: string | undefined): string | null => {
  if (value === undefined || value.trim() === '') return null
  try {
    const url = new URL(value)
    if (
      url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || (url.protocol !== 'https:' && (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)))
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

const isHttpOrigin = (origin: string) => {
  try {
    return new URL(origin).protocol === 'http:'
  } catch {
    return false
  }
}

export const resolveApiBaseOrigin = (
  configuredBaseUrl: string | undefined,
  runtime: RendererApiRuntime,
): string | null => {
  const configured = parseConfiguredApiOrigin(configuredBaseUrl)
  if (configured) return configured
  if (runtime.isDawProtocol) return null
  if (runtime.isDesktop && isHttpOrigin(runtime.browserOrigin)) return LOCAL_WORKER_ORIGIN
  return ''
}

export const resolveRendererApiUrl = (
  configuredBaseUrl: string | undefined,
  runtime: RendererApiRuntime,
  value: string,
): string | null => {
  const baseOrigin = resolveApiBaseOrigin(configuredBaseUrl, runtime)
  if (baseOrigin === null || value.includes('#')) return null

  try {
    const url = new URL(value)
    if (url.username || url.password || !isApiPath(url.pathname)) return null
    if (baseOrigin) return url.origin === baseOrigin ? url.toString() : null
    return url.origin === runtime.browserOrigin ? url.toString() : null
  } catch {
    if (!value.startsWith('/') || value.startsWith('//')) return null
    try {
      const url = new URL(value, 'https://renderer.invalid')
      if (!isApiPath(url.pathname)) return null
      return baseOrigin ? new URL(`${url.pathname}${url.search}`, baseOrigin).toString() : `${url.pathname}${url.search}`
    } catch {
      return null
    }
  }
}

export const resolveDefaultSampleMediaUrl = (
  configuredBaseUrl: string | undefined,
  runtime: RendererApiRuntime,
  value: string | undefined,
): string | null => {
  if (!value) return null
  try {
    const url = new URL(value, 'https://renderer.invalid')
    if (url.pathname === '/api/default-sample') {
      return resolveRendererApiUrl(configuredBaseUrl, runtime, value)
    }
    if (new URL(value).protocol === 'https:' && !url.username && !url.password && !url.hash) {
      return url.toString()
    }
  } catch {
    return null
  }
  return null
}

export const rendererApiRuntime = (): RendererApiRuntime => {
  const location = globalThis.location
  return {
    isDesktop: import.meta.env.VITE_DESKTOP === 'true',
    isDawProtocol: location?.protocol === 'daw:',
    browserOrigin: location?.origin ?? '',
  }
}

export const resolveRendererApiUrlForRuntime = (value: string) => (
  resolveRendererApiUrl(import.meta.env.VITE_API_BASE_URL, rendererApiRuntime(), value)
)

export const resolveDefaultSampleMediaUrlForRuntime = (value: string | undefined) => (
  resolveDefaultSampleMediaUrl(import.meta.env.VITE_API_BASE_URL, rendererApiRuntime(), value)
)

export const resolveSamplePlaybackUrlForRuntime = (value: string) => (
  isDefaultSampleApiUrl(value) ? resolveDefaultSampleMediaUrlForRuntime(value) : value
)
