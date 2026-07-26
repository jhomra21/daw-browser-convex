import { createAuthClient } from 'better-auth/solid'
import { resolveAuthBaseUrl } from '~/lib/auth-base-url'
import { rendererApiRuntime } from '~/lib/renderer-api-url'

const resolvedBaseURL = resolveAuthBaseUrl(
  import.meta.env.VITE_AUTH_BASE_URL || import.meta.env.VITE_API_BASE_URL,
  rendererApiRuntime(),
)
const baseURL = resolvedBaseURL ?? 'https://unavailable.invalid/api/auth'

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    // Ensure cookies are sent across origins (dev server <-> worker)
    credentials: 'include',
  },
})
