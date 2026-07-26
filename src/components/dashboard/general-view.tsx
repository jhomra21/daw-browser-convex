import { For, Match, Show, Switch } from "solid-js";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";
import { Button } from "~/components/ui/button";
import { useAppPreferences } from "~/context/app-preferences";
import { useMidiAccess } from "~/context/midi-access";
import type { AppTheme } from "~/lib/preferences/app-preferences";
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
      onMouseLeave={() => props.cancel()}
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
  const midiAccess = useMidiAccess();

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
            <div class="flex items-center gap-2">
              <input
                type="color"
                value={appPreferences.timeline.defaultTrackColorInput()}
                class="h-8 w-12 cursor-pointer border border-border bg-app-surface p-0.5"
                onChange={(event) => appPreferences.timeline.setDefaultTrackColor(event.currentTarget.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                class="h-8 rounded-none px-2 text-xs"
                onClick={appPreferences.timeline.resetDefaultTrackColor}
              >
                Reset
              </Button>
            </div>
          }
        />
        <DashboardRow
          label="Default group row color"
          value={appPreferences.timeline.defaultGroupColor()}
          action={
            <div class="flex items-center gap-2">
              <input
                type="color"
                value={appPreferences.timeline.defaultGroupColorInput()}
                class="h-8 w-12 cursor-pointer border border-border bg-app-surface p-0.5"
                onChange={(event) => appPreferences.timeline.setDefaultGroupColor(event.currentTarget.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                class="h-8 rounded-none px-2 text-xs"
                onClick={appPreferences.timeline.resetDefaultGroupColor}
              >
                Reset
              </Button>
            </div>
          }
        />
      </DashboardSection>
      <DashboardSection title="MIDI input" description="MIDI devices stay on this device and are never shared with projects.">
        <Switch>
          <Match when={midiAccess.status() === "unsupported"}>
            <DashboardRow
              label="MIDI is unavailable"
              value="This browser does not support Web MIDI input."
            />
          </Match>
          <Match when={midiAccess.status() === "idle" || midiAccess.status() === "denied" || midiAccess.status() === "error"}>
            <DashboardRow
              label="MIDI access"
              value={
                midiAccess.status() === "denied"
                  ? "Access was denied. Enable it in your browser or desktop app, then try again."
                  : midiAccess.status() === "error"
                    ? "MIDI access could not be initialized. Try again."
                    : "Enable MIDI to choose local input devices."
              }
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="h-8 rounded-none px-2 text-xs"
                  onClick={() => void midiAccess.requestAccess()}
                >
                  {midiAccess.status() === "idle" ? "Enable MIDI" : "Try again"}
                </Button>
              }
            />
          </Match>
          <Match when={midiAccess.status() === "requesting"}>
            <DashboardRow
              label="MIDI access"
              value="Waiting for the browser or desktop app to respond."
              action={<Button type="button" variant="outline" size="sm" class="h-8 rounded-none px-2 text-xs" disabled>Enabling MIDI</Button>}
            />
          </Match>
          <Match when={midiAccess.status() === "ready"}>
            <>
              <For each={midiAccess.inputs()}>
                {(input) => (
                  <DashboardRow
                    label={input.connected ? input.name ?? "MIDI input" : "Previously selected MIDI input"}
                    value={
                      input.connected
                        ? `${input.manufacturer ? `${input.manufacturer} · ` : ""}${input.selected ? "Selected" : "Not selected"}`
                        : "Unavailable until this local device reconnects."
                    }
                    action={
                      <label class="flex items-center gap-2 text-xs text-foreground">
                        <input
                          type="checkbox"
                          checked={input.selected}
                          disabled={!input.connected && !input.selected}
                          aria-label={`Use ${input.name ?? "MIDI input"} for MIDI input`}
                          onChange={(event) => midiAccess.setInputSelected(input.id, event.currentTarget.checked)}
                        />
                        Use input
                      </label>
                    }
                  />
                )}
              </For>
              <Show when={midiAccess.inputs().length === 0}>
                <DashboardRow label="No MIDI inputs found" value="Connect an input, then reopen this dashboard if needed." />
              </Show>
              <DashboardRow
                label="MIDI safety"
                value="Sends a local reset to all selected, connected MIDI input consumers."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    class="h-8 rounded-none px-2 text-xs"
                    onClick={midiAccess.panic}
                  >
                    Panic
                  </Button>
                }
              />
            </>
          </Match>
        </Switch>
      </DashboardSection>
    </DashboardScrollView>
  );
}
