import { render } from 'solid-js/web'
import { RouterProvider, createRouter } from '@tanstack/solid-router'
import { QueryClientProvider } from '@tanstack/solid-query'
import { ColorModeProvider, type ColorModeStorageManager } from '@kobalte/core'
import { registerSW } from 'virtual:pwa-register'
import { assert } from '@daw-browser/shared'
import { routeTree } from './routeTree.gen'
import './index.css'
import { queryClient } from '~/lib/query-client'
import { AppPreferencesProvider } from '~/context/app-preferences'
import { loadInitialAppPreferences } from '~/lib/preferences/app-preferences'

if (import.meta.env.PROD) {
  registerSW({ immediate: true })
}

// QueryClient is provided from a shared module so routes/components share cache
const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/solid-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')
assert(rootElement, 'Root element with id "root" not found in index.html')
const initialAppPreferences = loadInitialAppPreferences()
const initialColorMode = initialAppPreferences.appearance.theme
const appPreferencesColorModeManager: ColorModeStorageManager = {
  type: 'localStorage',
  get: () => initialColorMode,
  set: () => {}
}

render(() => (
  <QueryClientProvider client={queryClient}>
    <ColorModeProvider initialColorMode={initialColorMode} storageManager={appPreferencesColorModeManager}>
      <AppPreferencesProvider initialPreferences={initialAppPreferences}>
        <RouterProvider router={router} />
      </AppPreferencesProvider>
    </ColorModeProvider>
  </QueryClientProvider>
), rootElement)
