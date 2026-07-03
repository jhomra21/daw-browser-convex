import { createContext, createEffect, type ParentComponent, useContext } from "solid-js"
import { useColorMode } from "@kobalte/core"
import { assert } from "@daw-browser/shared"
import {
  createPersistedAppPreferencesWithInitial,
  type AppPreferences,
  type AppTheme,
  type ResolvedAppTheme
} from "~/lib/preferences/app-preferences"

type AppPreferencesContextValue = {
  appearance: {
    theme: () => AppTheme
    resolvedTheme: () => ResolvedAppTheme
    setTheme: (theme: AppTheme) => void
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

  createEffect(() => {
    setColorMode(preferences.appearance.theme)
  })

  const setTheme = (theme: AppTheme) => {
    if (preferences.appearance.theme === theme) return
    setPreferences("appearance", "theme", theme)
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
          resolvedTheme: colorMode,
          setTheme
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
