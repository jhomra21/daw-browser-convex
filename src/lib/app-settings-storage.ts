import { COLOR_MODE_STORAGE_KEY, type ConfigColorMode } from "@kobalte/core";
import { canUseLocalStorage } from "~/lib/timeline-storage";

export type AppTheme = ConfigColorMode;
export type AppSettings = { theme: AppTheme };

export const defaultAppSettings: AppSettings = { theme: "system" };

const isAppTheme = (value: unknown): value is AppTheme => value === "system" || value === "light" || value === "dark";
export const parseAppTheme = (value: unknown): AppTheme => isAppTheme(value) ? value : defaultAppSettings.theme;

export const loadAppSettings = (): AppSettings => {
  if (!canUseLocalStorage()) return defaultAppSettings;
  try {
    const colorMode = localStorage.getItem(COLOR_MODE_STORAGE_KEY);
    return colorMode ? { theme: parseAppTheme(colorMode) } : defaultAppSettings;
  } catch {
    return defaultAppSettings;
  }
};

export const saveAppSettings = (settings: AppSettings) => {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(COLOR_MODE_STORAGE_KEY, settings.theme);
  } catch {}
};
