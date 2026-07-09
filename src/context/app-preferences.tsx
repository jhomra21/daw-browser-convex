import { batch, createContext, createEffect, createSignal, type ParentComponent, useContext } from "solid-js"
import { useColorMode } from "@kobalte/core"
import { assert } from "@daw-browser/shared"
import {
  createPersistedAppPreferencesWithInitial,
  parseHexColor,
  TIMELINE_DEFAULT_GROUP_COLOR,
  TIMELINE_DEFAULT_TRACK_COLOR,
  timelineDefaultCreateColor,
  type AppPreferences,
  type AppTheme,
  type ResolvedAppTheme
} from "~/lib/preferences/app-preferences"
import { themeColorInputValue } from "~/lib/preferences/theme-color-input"
import { applyDawTheme, resolveDawThemeById, type ResolvedThemeTokens } from "~/lib/theme/theme-resolver"
import { DEFAULT_DAW_THEME_ID, themeOptions, type DawThemeId, type DawThemeOption } from "~/lib/theme/theme-registry"

type AppPreferencesContextValue = {
  appearance: {
    theme: () => AppTheme
    themeId: () => DawThemeId
    themeOptions: () => readonly DawThemeOption[]
    resolvedTheme: () => ResolvedAppTheme
    themeTokens: () => ResolvedThemeTokens
    activeThemeSelection: () => AppTheme | DawThemeId
    setTheme: (theme: AppTheme) => void
    setThemeId: (id: DawThemeId) => void
    previewThemeSelection: (selection: AppTheme | DawThemeId) => void
    commitThemeSelection: (selection: AppTheme | DawThemeId) => void
    cancelThemePreview: () => void
  }
  agent: {
    autoApply: () => boolean
    toggleAutoApply: () => void
  }
  sidebar: {
    open: () => boolean
    setOpen: (open: boolean) => void
  }
  timeline: {
    defaultTrackColor: () => string
    defaultGroupColor: () => string
    defaultTrackColorInput: () => string
    defaultGroupColorInput: () => string
    defaultTrackCreateColor: () => string | undefined
    defaultGroupCreateColor: () => string | undefined
    setDefaultTrackColor: (color: string) => void
    setDefaultGroupColor: (color: string) => void
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
  const [themeTokens, setThemeTokens] = createSignal<ResolvedThemeTokens>(
    resolveDawThemeById(preferences.appearance.themeId, colorMode())
  )

  const activeThemeId = () => previewThemeId() ?? preferences.appearance.themeId
  const activeTheme = () => previewTheme() ?? preferences.appearance.theme
  const activeThemeSelection = () => {
    const themeId = activeThemeId()
    return themeId === DEFAULT_DAW_THEME_ID ? activeTheme() : themeId
  }

  createEffect(() => {
    setColorMode(activeTheme())
  })

  createEffect(() => {
    const result = applyDawTheme(activeThemeId(), colorMode())
    if (!result.changed) return
    setThemeTokens(result.tokens)
  })

  const setTheme = (theme: AppTheme) => {
    if (preferences.appearance.theme === theme) return
    setPreferences("appearance", "theme", theme)
  }

  const setThemeId = (id: DawThemeId) => {
    if (preferences.appearance.themeId === id) return
    setPreferences("appearance", "themeId", id)
  }

  const previewThemeSelection = (selection: AppTheme | DawThemeId) => {
    if (selection === "system" || selection === "light" || selection === "dark") {
      batch(() => {
        setPreviewThemeId(DEFAULT_DAW_THEME_ID)
        setPreviewTheme(selection)
      })
      return
    }

    batch(() => {
      setPreviewThemeId(selection)
      setPreviewTheme(null)
    })
  }

  const commitThemeSelection = (selection: AppTheme | DawThemeId) => {
    batch(() => {
      if (selection === "system" || selection === "light" || selection === "dark") {
        setThemeId(DEFAULT_DAW_THEME_ID)
        setTheme(selection)
      } else {
        setThemeId(selection)
      }
      setPreviewThemeId(null)
      setPreviewTheme(null)
    })
  }

  const cancelThemePreview = () => {
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

  const setDefaultTrackColor = (color: string) => {
    const nextColor = parseHexColor(color, preferences.timeline.defaultTrackColor)
    if (preferences.timeline.defaultTrackColor === nextColor) return
    setPreferences("timeline", "defaultTrackColor", nextColor)
  }

  const setDefaultGroupColor = (color: string) => {
    const nextColor = parseHexColor(color, preferences.timeline.defaultGroupColor)
    if (preferences.timeline.defaultGroupColor === nextColor) return
    setPreferences("timeline", "defaultGroupColor", nextColor)
  }

  const resolveDefaultTimelineColor = (color: string) => {
    if (color === TIMELINE_DEFAULT_TRACK_COLOR) return `var(--${TIMELINE_DEFAULT_TRACK_COLOR})`
    if (color === TIMELINE_DEFAULT_GROUP_COLOR) return `var(--${TIMELINE_DEFAULT_GROUP_COLOR})`
    return color
  }

  const resolveDefaultTimelineColorInput = (color: string) => {
    return themeColorInputValue(color, themeTokens(), activeThemeId(), colorMode())
  }

  return (
    <AppPreferencesContext.Provider
      value={{
        appearance: {
          theme: () => preferences.appearance.theme,
          themeId: () => activeThemeId(),
          themeOptions: () => themeOptions,
          resolvedTheme: colorMode,
          themeTokens,
          activeThemeSelection,
          setTheme,
          setThemeId,
          previewThemeSelection,
          commitThemeSelection,
          cancelThemePreview
        },
        agent: {
          autoApply: () => preferences.agent.autoApply,
          toggleAutoApply: toggleAgentAutoApply
        },
        sidebar: {
          open: () => preferences.sidebar.open,
          setOpen: setSidebarOpen
        },
        timeline: {
          defaultTrackColor: () => resolveDefaultTimelineColor(preferences.timeline.defaultTrackColor),
          defaultGroupColor: () => resolveDefaultTimelineColor(preferences.timeline.defaultGroupColor),
          defaultTrackColorInput: () => resolveDefaultTimelineColorInput(preferences.timeline.defaultTrackColor),
          defaultGroupColorInput: () => resolveDefaultTimelineColorInput(preferences.timeline.defaultGroupColor),
          defaultTrackCreateColor: () => timelineDefaultCreateColor(preferences.timeline.defaultTrackColor),
          defaultGroupCreateColor: () => timelineDefaultCreateColor(preferences.timeline.defaultGroupColor),
          setDefaultTrackColor,
          setDefaultGroupColor
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
