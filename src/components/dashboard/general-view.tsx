import { For } from "solid-js";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";
import { Button } from "~/components/ui/button";
import { useAppPreferences } from "~/context/app-preferences";
import { type AppTheme } from "~/lib/preferences/app-preferences";
import { isThemeId } from "~/lib/theme/theme-registry";

const themes: readonly AppTheme[] = ["system", "light", "dark"];

type PreviewOption = {
  id: string;
  label: string;
};

type PreviewButtonGroupProps = {
  options: readonly PreviewOption[];
  selectedId: string;
  preview: (id: string) => void;
  commit: (id: string) => void;
  cancel: () => void;
};

function PreviewButtonGroup(props: PreviewButtonGroupProps) {
  const handleKeyDown = (event: KeyboardEvent, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.commit(id);
    }
    if (event.key === "Escape") props.cancel();
  };

  return (
    <div
      class="flex flex-wrap gap-1"
      onMouseLeave={props.cancel}
      onFocusOut={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          props.cancel();
        }
      }}
    >
      <For each={props.options}>
        {(option) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="h-auto rounded-none px-2 py-1 text-xs focus:bg-accent focus:text-accent-foreground"
            classList={{ "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground": props.selectedId === option.id }}
            aria-pressed={props.selectedId === option.id}
            onMouseEnter={() => props.preview(option.id)}
            onFocus={() => props.preview(option.id)}
            onClick={() => props.commit(option.id)}
            onKeyDown={(event) => handleKeyDown(event, option.id)}
          >
            {option.label}
          </Button>
        )}
      </For>
    </div>
  );
}

export function DashboardGeneralView() {
  const appPreferences = useAppPreferences();
  const themeOptions = () => themes.map((theme) => ({ id: theme, label: theme }));
  const namedThemeOptions = () => appPreferences.appearance.themeOptions().map((theme) => ({ id: theme.id, label: theme.name }));
  const previewColorScheme = (theme: string) => {
    if (theme === "system" || theme === "light" || theme === "dark") appPreferences.appearance.previewColorScheme(theme);
  };
  const commitColorScheme = (theme: string) => {
    if (theme !== "system" && theme !== "light" && theme !== "dark") return;
    appPreferences.appearance.previewColorScheme(theme);
    appPreferences.appearance.commitPreview();
  };
  const previewThemeId = (value: string) => {
    if (isThemeId(value)) appPreferences.appearance.previewThemeId(value);
  };
  const commitThemeId = (value: string) => {
    if (!isThemeId(value)) return;
    appPreferences.appearance.previewThemeId(value);
    appPreferences.appearance.commitPreview();
  };

  return (
    <DashboardScrollView>
      <DashboardSection title="App preferences" description="Global preferences for this browser.">
        <DashboardRow
          label="Color scheme"
          value="Hover or focus previews. Click or press Enter to save."
          action={
            <PreviewButtonGroup
              options={themeOptions()}
              selectedId={appPreferences.appearance.theme()}
              preview={previewColorScheme}
              commit={commitColorScheme}
              cancel={appPreferences.appearance.cancelPreview}
            />
          }
        />
        <DashboardRow
          label="Theme"
          value="Hover or focus previews. Click or press Enter to save."
          action={
            <PreviewButtonGroup
              options={namedThemeOptions()}
              selectedId={appPreferences.appearance.themeId()}
              preview={previewThemeId}
              commit={commitThemeId}
              cancel={appPreferences.appearance.cancelPreview}
            />
          }
        />
      </DashboardSection>
    </DashboardScrollView>
  );
}
