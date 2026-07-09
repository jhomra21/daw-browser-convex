import {
  parseHexColor,
  TIMELINE_DEFAULT_GROUP_COLOR,
  TIMELINE_DEFAULT_TRACK_COLOR,
  type ResolvedAppTheme
} from "./app-preferences-core"
import { DEFAULT_DAW_THEME_ID, type DawThemeId } from "~/lib/theme/theme-registry"
import type { ResolvedThemeTokens } from "~/lib/theme/theme-resolver"

const FALLBACK_COLOR_INPUT_VALUE = "#181824"
const DEFAULT_LIGHT_TIMELINE_SURFACE_INPUT_VALUE = "#e2e8f0"
const DEFAULT_DARK_TIMELINE_SURFACE_INPUT_VALUE = "#181824"

export const themeColorInputValue = (
  color: string,
  tokens: ResolvedThemeTokens,
  themeId: DawThemeId,
  mode: ResolvedAppTheme,
): string => {
  if (color === TIMELINE_DEFAULT_TRACK_COLOR || color === TIMELINE_DEFAULT_GROUP_COLOR) {
    if (themeId === DEFAULT_DAW_THEME_ID) {
      return mode === "dark" ? DEFAULT_DARK_TIMELINE_SURFACE_INPUT_VALUE : DEFAULT_LIGHT_TIMELINE_SURFACE_INPUT_VALUE
    }
    return parseHexColor(tokens[TIMELINE_DEFAULT_TRACK_COLOR], FALLBACK_COLOR_INPUT_VALUE)
  }
  return parseHexColor(color, FALLBACK_COLOR_INPUT_VALUE)
}
