import { For } from "solid-js";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";
import { useAppPreferences } from "~/context/app-preferences";
import { parseAppTheme, type AppTheme } from "~/lib/preferences/app-preferences";

const themes: readonly AppTheme[] = ["system", "light", "dark"];

export function DashboardGeneralView() {
  const appPreferences = useAppPreferences();
  return (
    <DashboardScrollView>
      <DashboardSection title="App preferences" description="Global preferences for this browser.">
        <DashboardRow
          label="Theme"
          value="Applied to the document root and saved locally."
          action={
            <select
              class="border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
              value={appPreferences.appearance.theme()}
              onChange={(event) => appPreferences.appearance.setTheme(parseAppTheme(event.currentTarget.value))}
            >
              <For each={themes}>{(theme) => <option value={theme}>{theme}</option>}</For>
            </select>
          }
        />
      </DashboardSection>
    </DashboardScrollView>
  );
}
