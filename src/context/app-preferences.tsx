import { batch, createContext, createEffect, createSignal, type ParentComponent, useContext } from "solid-js"
import { useColorMode } from "@kobalte/core"
import { assert } from "@daw-browser/shared"
import {
  createPersistedAppPreferencesWithInitial,
  type AppPreferences,
  type AppTheme,
  type ResolvedAppTheme
} from "~/lib/preferences/app-preferences"
import { applyDawTheme } from "~/lib/theme/theme-resolver"
import { themeOptions, type DawThemeId, type DawThemeOption } from "~/lib/theme/theme-registry"

type AppPreferencesContextValue = {
  appearance: {
    theme: () => AppTheme
    themeId: () => DawThemeId
    themeOptions: () => readonly DawThemeOption[]
    resolvedTheme: () => ResolvedAppTheme
    setTheme: (theme: AppTheme) => void
    setThemeId: (id: DawThemeId) => void
    previewThemeId: (id: DawThemeId) => void
    previewTheme: (id: DawThemeId) => void
    previewColorScheme: (theme: AppTheme) => void
    commitPreview: () => void
    cancelPreview: () => void
  }
  agent: {
    autoApply: () => boolean
    toggleAutoApply: () => void
  }
  sidebar: {
    open: () => boolean
    setOpen: (open: boolean) => void
  }
}

const AppPreferencesContext = createContext<AppPreferencesContextValue | null>(null)

type AppPreferencesProviderProps = {
  initialPreferences: AppPreferences
}

export const AppPreferencesProvider: ParentComponent<AppPreferencesProviderProps> = (props) => {
  const { colorMode, setColorMode } = useColorMode()
  const [preferences, setPreferences] = createPersistedAppPreferencesWithInitial(props.initialPreferences)
  const [previewThemeId, setPreviewThemeId] = createSignal<DawThemeId | null>(null)
  const [previewTheme, setPreviewTheme] = createSignal<AppTheme | null>(null)

  const activeThemeId = () => previewThemeId() ?? preferences.appearance.themeId
  const activeTheme = () => previewTheme() ?? preferences.appearance.theme

  createEffect(() => {
    setColorMode(activeTheme())
  })

  createEffect(() => {
    applyDawTheme(activeThemeId(), colorMode())
  })

  const setTheme = (theme: AppTheme) => {
    if (preferences.appearance.theme === theme) return
    setPreferences("appearance", "theme", theme)
  }

  const setThemeId = (id: DawThemeId) => {
    if (preferences.appearance.themeId === id) return
    setPreferences("appearance", "themeId", id)
  }

  const commitPreview = () => {
    const nextThemeId = previewThemeId()
    const nextTheme = previewTheme()
    batch(() => {
      if (nextThemeId) setThemeId(nextThemeId)
      if (nextTheme) setTheme(nextTheme)
      setPreviewThemeId(null)
      setPreviewTheme(null)
    })
  }

  const cancelPreview = () => {
    batch(() => {
      setPreviewThemeId(null)
      setPreviewTheme(null)
    })
  }

  const toggleAgentAutoApply = () => {
    setPreferences("agent", "autoApply", (autoApply) => !autoApply)
  }

  const setSidebarOpen = (open: boolean) => {
    if (preferences.sidebar.open === open) return
    setPreferences("sidebar", "open", open)
  }

  return (
    <AppPreferencesContext.Provider
      value={{
        appearance: {
          theme: () => preferences.appearance.theme,
          themeId: () => activeThemeId(),
          themeOptions: () => themeOptions,
          resolvedTheme: colorMode,
          setTheme,
          setThemeId,
          previewThemeId: setPreviewThemeId,
          previewTheme: setPreviewThemeId,
          previewColorScheme: setPreviewTheme,
          commitPreview,
          cancelPreview
        },
        agent: {
          autoApply: () => preferences.agent.autoApply,
          toggleAutoApply: toggleAgentAutoApply
        },
        sidebar: {
          open: () => preferences.sidebar.open,
          setOpen: setSidebarOpen
        }
      }}
    >
      {props.children}
    </AppPreferencesContext.Provider>
  )
}

export const useAppPreferences = () => {
  const context = useContext(AppPreferencesContext)
  assert(context, "useAppPreferences must be used within AppPreferencesProvider.")
  return context
}
