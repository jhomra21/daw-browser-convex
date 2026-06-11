import { For, Show } from "solid-js";
import { Button } from "~/components/ui/button";
import type { DashboardTimelineModel } from "./types";
import { DashboardRow, DashboardScrollView, DashboardSection, EmptyDashboardState } from "./dashboard-shared";
import { gridDenominators } from "~/components/timeline/grid-options";

export function DashboardTimelineView(props: { model?: DashboardTimelineModel }) {
  return (
    <DashboardScrollView>
      <Show
        when={props.model}
        fallback={<EmptyDashboardState title="No timeline context" message="Open a project to edit project-scoped DAW preferences." />}
        keyed
      >
        {(model) => (
          <DashboardSection title="Timeline / DAW" description="Project-scoped timeline preferences.">
            <DashboardRow
              label="BPM"
              value={`${model.bpm()}`}
              action={
                <input
                  class="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                  type="number"
                  min="30"
                  max="300"
                  value={model.bpm()}
                  onChange={(event) => model.setBpm(Number(event.currentTarget.value))}
                />
              }
            />
            <DashboardRow
              label="Metronome"
              value={model.metronomeEnabled() ? "Enabled" : "Disabled"}
              action={<Button size="sm" variant="secondary" onClick={model.toggleMetronome}>Toggle</Button>}
            />
            <DashboardRow
              label="Snap to grid"
              value={model.gridEnabled() ? "Enabled" : "Disabled"}
              action={<Button size="sm" variant="secondary" onClick={model.toggleGrid}>Toggle</Button>}
            />
            <DashboardRow
              label="Grid"
              value={`1/${model.gridDenominator()}`}
              action={
                <select
                  class="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
                  value={model.gridDenominator()}
                  onChange={(event) => model.setGridDenominator(Number(event.currentTarget.value))}
                >
                  <For each={gridDenominators}>{(value) => <option value={value}>1/{value}</option>}</For>
                </select>
              }
            />
            <DashboardRow
              label="Loop"
              value={model.loopEnabled() ? "Enabled" : "Disabled"}
              action={<Button size="sm" variant="secondary" onClick={model.toggleLoop}>Toggle</Button>}
            />
          </DashboardSection>
        )}
      </Show>
    </DashboardScrollView>
  );
}
