import { For } from "solid-js";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";
import { useAppPreferences } from "~/context/app-preferences";
import { parseAppThemeSelectValue, type AppTheme } from "~/lib/preferences/app-preferences";

const themes: readonly AppTheme[] = ["system", "light", "dark"];

export function DashboardGeneralView() {
  const appPreferences = useAppPreferences();
  const updateTheme = (value: string) => {
    const theme = parseAppThemeSelectValue(value);
    if (theme) appPreferences.appearance.setTheme(theme);
  };

  return (
    <DashboardScrollView>
      <DashboardSection title="App preferences" description="Global preferences for this browser.">
        <DashboardRow
          label="Theme"
          value="Applied to the document root and saved locally."
          action={
            <select
              class="border border-border bg-background px-2 py-1 text-xs text-foreground"
              value={appPreferences.appearance.theme()}
              onChange={(event) => updateTheme(event.currentTarget.value)}
            >
              <For each={themes}>{(theme) => <option value={theme}>{theme}</option>}</For>
            </select>
          }
        />
      </DashboardSection>
    </DashboardScrollView>
  );
}
