import { Show } from "solid-js";
import type { DashboardTimelineModel } from "./types";
import { DashboardRow, DashboardScrollView, DashboardSection, EmptyDashboardState } from "./dashboard-shared";

export function DashboardExportView(props: { model?: DashboardTimelineModel }) {
  return <DashboardScrollView><Show when={props.model} fallback={<EmptyDashboardState title="No project context" message="Open a project to manage exports." />} keyed>{(model) => <DashboardSection title="Export" description="Export defaults and history are not persisted yet. Use File > Export Mixdown for the export action."><DashboardRow label="Current project" value={model.projectMenu.currentProjectId} /></DashboardSection>}</Show></DashboardScrollView>;
}
