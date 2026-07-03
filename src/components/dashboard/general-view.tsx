import { For } from "solid-js";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";
import { useAppPreferences } from "~/context/app-preferences";
import { type AppTheme } from "~/lib/preferences/app-preferences";
import { isThemeId, type DawThemeId } from "~/lib/theme/theme-registry";

const themes: readonly AppTheme[] = ["system", "light", "dark"];

export function DashboardGeneralView() {
  const appPreferences = useAppPreferences();
  const previewColorScheme = (theme: AppTheme) => appPreferences.appearance.previewColorScheme(theme);
  const commitColorScheme = (theme: AppTheme) => {
    appPreferences.appearance.previewColorScheme(theme);
    appPreferences.appearance.commitPreview();
  };
  const handleColorSchemeKey = (event: KeyboardEvent, theme: AppTheme) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commitColorScheme(theme);
    }
    if (event.key === "Escape") appPreferences.appearance.cancelPreview();
  };
  const previewThemeId = (value: string) => {
    if (isThemeId(value)) appPreferences.appearance.previewThemeId(value);
  };
  const commitThemeId = (value: string) => {
    if (!isThemeId(value)) return;
    appPreferences.appearance.previewThemeId(value);
    appPreferences.appearance.commitPreview();
  };
  const handleThemeKey = (event: KeyboardEvent, id: DawThemeId) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commitThemeId(id);
    }
    if (event.key === "Escape") appPreferences.appearance.cancelPreview();
  };

  return (
    <DashboardScrollView>
      <DashboardSection title="App preferences" description="Global preferences for this browser.">
        <DashboardRow
          label="Color scheme"
          value="Hover or focus previews. Click or press Enter to save."
          action={
            <div
              class="flex flex-wrap gap-1"
              onMouseLeave={appPreferences.appearance.cancelPreview}
              onFocusOut={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  appPreferences.appearance.cancelPreview();
                }
              }}
            >
              <For each={themes}>
                {(theme) => (
                  <button
                    type="button"
                    class="border border-border px-2 py-1 text-xs text-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
                    classList={{ "bg-primary text-primary-foreground": appPreferences.appearance.theme() === theme }}
                    aria-pressed={appPreferences.appearance.theme() === theme}
                    onMouseEnter={() => previewColorScheme(theme)}
                    onFocus={() => previewColorScheme(theme)}
                    onClick={() => commitColorScheme(theme)}
                    onKeyDown={(event) => handleColorSchemeKey(event, theme)}
                  >
                    {theme}
                  </button>
                )}
              </For>
            </div>
          }
        />
        <DashboardRow
          label="Theme"
          value="Hover or focus previews. Click or press Enter to save."
          action={
            <div
              class="flex flex-wrap gap-1"
              onMouseLeave={appPreferences.appearance.cancelPreview}
              onFocusOut={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  appPreferences.appearance.cancelPreview();
                }
              }}
            >
              <For each={appPreferences.appearance.themeOptions()}>
                {(theme) => (
                  <button
                    type="button"
                    class="border border-border px-2 py-1 text-xs text-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
                    classList={{ "bg-primary text-primary-foreground": appPreferences.appearance.themeId() === theme.id }}
                    aria-pressed={appPreferences.appearance.themeId() === theme.id}
                    onMouseEnter={() => previewThemeId(theme.id)}
                    onFocus={() => previewThemeId(theme.id)}
                    onClick={() => commitThemeId(theme.id)}
                    onKeyDown={(event) => handleThemeKey(event, theme.id)}
                  >
                    {theme.name}
                  </button>
                )}
              </For>
            </div>
          }
        />
      </DashboardSection>
    </DashboardScrollView>
  );
}
