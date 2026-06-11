import { Show } from "solid-js";
import { isLocalId } from "@daw-browser/shared";
import { Button } from "~/components/ui/button";
import type { DashboardTimelineModel } from "./types";
import { DashboardRow, DashboardScrollView, DashboardSection, EmptyDashboardState } from "./dashboard-shared";

export function DashboardFilesView(props: { model?: DashboardTimelineModel }) {
  const menu = () => props.model?.projectMenu;

  return (
    <DashboardScrollView>
      <DashboardSection title="Local files and permissions" description="Browser storage access for the current project.">
        <Show when={menu()} fallback={<DashboardRow label="Project folder" value="Open a local project to manage file permissions." />}>
          {(projectMenu) => (
            <>
              <DashboardRow
                label="Storage mode"
                value={isLocalId("project", projectMenu().currentProjectId) ? "Local project storage" : "Cloud project storage"}
              />
              <DashboardRow
                label="Project folder"
                value={
                  isLocalId("project", projectMenu().currentProjectId)
                    ? "Managed by browser file permissions"
                    : "Cloud projects do not use a local project folder"
                }
                action={
                  <Show when={isLocalId("project", projectMenu().currentProjectId) && projectMenu().onChooseProjectFolder}>
                    {(chooseProjectFolder) => (
                      <Button size="sm" variant="secondary" onClick={() => void chooseProjectFolder()}>
                        Choose folder
                      </Button>
                    )}
                  </Show>
                }
              />
            </>
          )}
        </Show>
      </DashboardSection>
      <Show when={!menu()}>
        <EmptyDashboardState title="No project context" message="Open a project to inspect project file state." />
      </Show>
    </DashboardScrollView>
  );
}
