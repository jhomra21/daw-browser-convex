import { Show } from "solid-js";
import { Button } from "~/components/ui/button";
import type { DashboardTimelineModel } from "./types";
import { DashboardRow, DashboardScrollView, DashboardSection, EmptyDashboardState } from "./dashboard-shared";

export function DashboardExportView(props: { model?: DashboardTimelineModel }) {
  return <DashboardScrollView><Show when={props.model} fallback={<EmptyDashboardState title="No project context" message="Open a project to manage exports." />} keyed>{(model) => <DashboardSection title="Export" description="Export defaults are not persisted yet, so this view exposes existing export actions only."><DashboardRow label="Current project" value={model.projectMenu.currentProjectId} /><DashboardRow label="Export mixdown" value="Open the existing export dialog." action={<Button size="sm" variant="secondary" onClick={model.projectMenu.onOpenExport}>Export</Button>} /></DashboardSection>}</Show></DashboardScrollView>;
}
