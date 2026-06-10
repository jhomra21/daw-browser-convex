import { createSignal, onCleanup } from "solid-js";
import { defaultAppSettings, loadAppSettings, saveAppSettings, type AppSettings, type AppTheme } from "~/lib/app-settings-storage";

const applyTheme = (theme: AppTheme, prefersDark: boolean) => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && prefersDark));
};

export function useAppSettings() {
  const [settings, setSettings] = createSignal<AppSettings>(typeof window !== "undefined" ? loadAppSettings() : defaultAppSettings);
  const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const prefersDark = () => Boolean(media?.matches);

  applyTheme(settings().theme, prefersDark());

  if (media) {
    const onChange = () => applyTheme(settings().theme, prefersDark());
    media.addEventListener("change", onChange);
    onCleanup(() => media.removeEventListener("change", onChange));
  }

  const setTheme = (theme: AppTheme) => setSettings((current) => {
    const next = { ...current, theme };
    saveAppSettings(next);
    applyTheme(next.theme, prefersDark());
    return next;
  });

  return { settings, setTheme };
}
