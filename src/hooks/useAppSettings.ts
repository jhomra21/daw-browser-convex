import { createEffect, createSignal } from "solid-js";
import { useColorMode } from "@kobalte/core";
import { defaultAppSettings, loadAppSettings, saveAppSettings, type AppSettings, type AppTheme } from "~/lib/app-settings-storage";

export function useAppSettings() {
  const { colorMode, setColorMode } = useColorMode();
  const [settings, setSettings] = createSignal<AppSettings>(typeof window !== "undefined" ? loadAppSettings() : defaultAppSettings);

  createEffect(() => {
    colorMode();
    setSettings(loadAppSettings());
  });

  const setTheme = (theme: AppTheme) => setSettings((current) => {
    const next = { ...current, theme };
    saveAppSettings(next);
    setColorMode(next.theme);
    return next;
  });

  return { settings, setTheme };
}
