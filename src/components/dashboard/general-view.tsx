import { For } from "solid-js";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";
import { useAppSettings } from "~/hooks/useAppSettings";
import { parseAppTheme, type AppTheme } from "~/lib/app-settings-storage";

const themes: readonly AppTheme[] = ["system", "light", "dark"];

export function DashboardGeneralView() {
  const appSettings = useAppSettings();
  return (
    <DashboardScrollView>
      <DashboardSection title="App preferences" description="Global preferences for this browser.">
        <DashboardRow
          label="Theme"
          value="Applied to the document root and saved locally."
          action={
            <select
              class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
              value={appSettings.settings().theme}
              onChange={(event) => appSettings.setTheme(parseAppTheme(event.currentTarget.value))}
            >
              <For each={themes}>{(theme) => <option value={theme}>{theme}</option>}</For>
            </select>
          }
        />
      </DashboardSection>
    </DashboardScrollView>
  );
}
