import { canUseLocalStorage } from "~/lib/timeline-storage";

export type AppTheme = "system" | "light" | "dark";
export type AppSettings = { theme: AppTheme };

const APP_SETTINGS_KEY = "daw:app-settings";
export const defaultAppSettings: AppSettings = { theme: "system" };

const isAppTheme = (value: unknown): value is AppTheme => value === "system" || value === "light" || value === "dark";
export const parseAppTheme = (value: unknown): AppTheme => isAppTheme(value) ? value : defaultAppSettings.theme;

const normalizeAppSettings = (value: unknown): AppSettings => {
  if (typeof value !== "object" || value === null) return defaultAppSettings;
  const theme = "theme" in value ? value.theme : undefined;
  return { theme: parseAppTheme(theme) };
};

export const loadAppSettings = (): AppSettings => {
  if (!canUseLocalStorage()) return defaultAppSettings;
  try {
    const raw = localStorage.getItem(APP_SETTINGS_KEY);
    return raw ? normalizeAppSettings(JSON.parse(raw)) : defaultAppSettings;
  } catch {
    return defaultAppSettings;
  }
};

export const saveAppSettings = (settings: AppSettings) => {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
};
