import { For } from "solid-js";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";
import { Button } from "~/components/ui/button";
import { useAppPreferences } from "~/context/app-preferences";
import { type AppTheme } from "~/lib/preferences/app-preferences";
import { DEFAULT_DAW_THEME_ID, type DawThemeId } from "~/lib/theme/theme-registry";

type ThemeSelectionId = AppTheme | DawThemeId;

type PreviewOption = {
  id: ThemeSelectionId;
  label: string;
};

type PreviewButtonGroupProps = {
  options: readonly PreviewOption[];
  selectedId: ThemeSelectionId;
  preview: (id: ThemeSelectionId) => void;
  commit: (id: ThemeSelectionId) => void;
  cancel: () => void;
};

function PreviewButtonGroup(props: PreviewButtonGroupProps) {
  const handleKeyDown = (event: KeyboardEvent) => {
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
            onKeyDown={handleKeyDown}
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

  const themeOptions = (): readonly PreviewOption[] => [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
    ...appPreferences.appearance.themeOptions()
      .filter((theme) => theme.id !== DEFAULT_DAW_THEME_ID)
      .map((theme) => ({ id: theme.id, label: theme.name }))
  ];

  const selectedThemeId = (): ThemeSelectionId => appPreferences.appearance.activeThemeSelection();

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
              preview={appPreferences.appearance.previewThemeSelection}
              commit={appPreferences.appearance.commitThemeSelection}
              cancel={appPreferences.appearance.cancelThemePreview}
            />
          }
        />
        <DashboardRow
          label="Default track row color"
          value={appPreferences.timeline.defaultTrackColor()}
          action={
            <input
              type="color"
              value={appPreferences.timeline.defaultTrackColorInput()}
              class="h-8 w-12 cursor-pointer border border-border bg-app-surface p-0.5"
              onChange={(event) => appPreferences.timeline.setDefaultTrackColor(event.currentTarget.value)}
            />
          }
        />
        <DashboardRow
          label="Default group row color"
          value={appPreferences.timeline.defaultGroupColor()}
          action={
            <input
              type="color"
              value={appPreferences.timeline.defaultGroupColorInput()}
              class="h-8 w-12 cursor-pointer border border-border bg-app-surface p-0.5"
              onChange={(event) => appPreferences.timeline.setDefaultGroupColor(event.currentTarget.value)}
            />
          }
        />
      </DashboardSection>
    </DashboardScrollView>
  );
}
