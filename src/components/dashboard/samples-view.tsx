import { createSignal, For, Show } from "solid-js";
import { Button } from "~/components/ui/button";
import { isLocalId } from "@daw-browser/shared";
import type { DashboardTimelineModel } from "./types";
import { DashboardRow, DashboardScrollView, DashboardSection, EmptyDashboardState } from "./dashboard-shared";
import type { ProjectSampleListItem } from "~/hooks/useProjectSamples";
import { deleteLocalAsset } from "~/lib/local-assets";
import { deleteProjectSample } from "~/lib/project-samples-api";

const formatSampleDuration = (seconds: number) => `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;

export function DashboardSamplesView(props: { model?: DashboardTimelineModel }) {
  const [deletingSampleKey, setDeletingSampleKey] = createSignal("");
  const [deleteError, setDeleteError] = createSignal("");

  const canDeleteSample = (model: DashboardTimelineModel, sample: ProjectSampleListItem) => {
    if (sample.count > 0) return false;
    if (isLocalId("project", model.projectMenu.currentProjectId)) return isLocalId("asset", sample.assetKey);
    return Boolean(model.projectMenu.currentUserId);
  };

  const deleteSample = async (model: DashboardTimelineModel, sample: ProjectSampleListItem) => {
    if (!canDeleteSample(model, sample)) return;
    const projectId = model.projectMenu.currentProjectId;
    setDeletingSampleKey(sample.key);
    setDeleteError("");
    try {
      if (isLocalId("project", projectId)) {
        await deleteLocalAsset(projectId, sample.assetKey);
      } else {
        await deleteProjectSample(projectId, sample.assetKey);
      }
      model.refreshSamples();
    } catch {
      setDeleteError("Sample could not be deleted.");
    } finally {
      setDeletingSampleKey("");
    }
  };

  return (
    <DashboardScrollView>
      <Show
        when={props.model}
        fallback={<EmptyDashboardState title="No project context" message="Open a project to inspect project media." />}
        keyed
      >
        {(model) => (
          <DashboardSection title="Samples" description="Samples used by this project.">
            <Show when={deleteError()}>
              <div class="border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
                {deleteError()}
              </div>
            </Show>
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
                    action={
                      <Button
                        size="sm"
                        variant="ghost"
                        class="text-red-300 hover:bg-red-950/40 hover:text-red-200"
                        disabled={!canDeleteSample(model, sample) || deletingSampleKey() === sample.key}
                        onClick={() => void deleteSample(model, sample)}
                      >
                        {deletingSampleKey() === sample.key ? "Deleting..." : "Delete"}
                      </Button>
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
