import { For, Show } from "solid-js";
import type { DashboardTimelineModel } from "./types";
import { DashboardRow, DashboardScrollView, DashboardSection, EmptyDashboardState } from "./dashboard-shared";

const formatSampleDuration = (seconds: number) => `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;

export function DashboardSamplesView(props: { model?: DashboardTimelineModel }) {
  return (
    <DashboardScrollView>
      <Show
        when={props.model}
        fallback={<EmptyDashboardState title="No project context" message="Open a project to inspect project media." />}
        keyed
      >
        {(model) => (
          <DashboardSection title="Samples" description="Samples used by this project.">
            <Show
              when={model.samples().length > 0}
              fallback={<EmptyDashboardState title="No samples" message="Import or record audio to add samples to this project." />}
            >
              <For each={model.samples()}>
                {(sample) => (
                  <DashboardRow
                    label={sample.name}
                    value={
                      <span class="flex min-w-0 flex-col gap-1">
                        <span>{sample.filePath}</span>
                        <span>{formatSampleDuration(sample.duration)}{sample.count > 0 ? `, used ${sample.count} time${sample.count === 1 ? "" : "s"}` : ""}</span>
                      </span>
                    }
                  />
                )}
              </For>
            </Show>
          </DashboardSection>
        )}
      </Show>
    </DashboardScrollView>
  );
}
