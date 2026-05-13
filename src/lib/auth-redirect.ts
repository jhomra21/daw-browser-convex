type AuthRedirectSearch = {
  redirect?: string
}

const FALLBACK_REDIRECT = '/'

const readNonEmptyString = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

const readAppOrigin = () => {
  if (typeof window !== 'undefined' && typeof window.location?.origin === 'string') {
    return window.location.origin
  }
  return 'http://localhost'
}

const toAppPath = (url: URL) => {
  const path = `${url.pathname}${url.search}${url.hash}`
  return path || FALLBACK_REDIRECT
}

export function readAuthRedirectSearch(
  search: Record<string, unknown>,
): AuthRedirectSearch {
  const redirect = readNonEmptyString(search.redirect)
  return redirect ? { redirect } : {}
}

export function normalizeAppRedirect(
  input: string | null | undefined,
): string {
  const redirect = readNonEmptyString(input)
  if (!redirect) return FALLBACK_REDIRECT

  const origin = readAppOrigin()

  if (redirect.startsWith('/')) {
    if (redirect.startsWith('//')) return FALLBACK_REDIRECT
    try {
      return toAppPath(new URL(redirect, origin))
    } catch {
      return FALLBACK_REDIRECT
    }
  }

  try {
    const url = new URL(redirect)
    if (url.origin !== origin) return FALLBACK_REDIRECT
    return toAppPath(url)
  } catch {
    return FALLBACK_REDIRECT
  }
}
