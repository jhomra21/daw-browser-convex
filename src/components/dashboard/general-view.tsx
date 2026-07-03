import { For } from "solid-js";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";
import { Button } from "~/components/ui/button";
import { useAppPreferences } from "~/context/app-preferences";
import { type AppTheme } from "~/lib/preferences/app-preferences";
import { isThemeId, type DawThemeId } from "~/lib/theme/theme-registry";

const defaultThemeId: DawThemeId = "default";

type ThemeSelectionId = AppTheme | DawThemeId;

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

  const themeOptions = () => [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    ...appPreferences.appearance.themeOptions()
      .filter((theme) => theme.id !== defaultThemeId)
      .map((theme) => ({ id: theme.id, label: theme.name }))
  ];

  const selectedThemeId = (): ThemeSelectionId => {
    const themeId = appPreferences.appearance.themeId();
    return themeId === defaultThemeId ? appPreferences.appearance.theme() : themeId;
  };

  const previewThemeSelection = (value: string) => {
    if (value === "system" || value === "light" || value === "dark") {
      appPreferences.appearance.previewThemeId(defaultThemeId);
      appPreferences.appearance.previewColorScheme(value);
      return;
    }

    if (isThemeId(value)) {
      appPreferences.appearance.previewThemeId(value);
      appPreferences.appearance.previewColorScheme("dark");
    }
  };

  const commitThemeSelection = (value: string) => {
    previewThemeSelection(value);
    appPreferences.appearance.commitPreview();
  };

  return (
    <DashboardScrollView>
      <DashboardSection title="App preferences" description="Global preferences for this browser.">
        <DashboardRow
          label="Theme"
          value="Hover or focus previews. Click or press Enter to save."
          action={
            <PreviewButtonGroup
              options={themeOptions()}
              selectedId={selectedThemeId()}
              preview={previewThemeSelection}
              commit={commitThemeSelection}
              cancel={appPreferences.appearance.cancelPreview}
            />
          }
        />
      </DashboardSection>
    </DashboardScrollView>
  );
}
