import { render } from '@solidjs/web'
import { RouterProvider, createRouter } from '@tanstack/solid-router'
import { QueryClientProvider } from '@tanstack/solid-query'
import { ColorModeProvider, type ColorModeStorageManager } from '@kobalte/core'
import { registerSW } from 'virtual:pwa-register'
import { assertDefined } from '@daw-browser/shared'
import { routeTree } from './routeTree.gen'
import './index.css'
import { queryClient } from '~/lib/query-client'
import { AppPreferencesProvider } from '~/context/app-preferences'
import { MidiAccessProvider } from '~/context/midi-access'
import { loadInitialAppPreferences } from '~/lib/preferences/app-preferences'
import { isDesktopRenderer } from '~/lib/runtime'

if (import.meta.env.PROD && !isDesktopRenderer()) {
  registerSW({ immediate: true })
}

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
const resolvedRootElement = assertDefined(rootElement, 'Root element with id "root" not found in index.html')
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
        <MidiAccessProvider>
          <RouterProvider router={router} />
        </MidiAccessProvider>
      </AppPreferencesProvider>
    </ColorModeProvider>
  </QueryClientProvider>
), resolvedRootElement)
