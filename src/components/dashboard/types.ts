import type { Accessor } from "solid-js";
import type { TimelineProjectMenuModel } from "~/components/timeline/transport-types";
import type { ProjectSampleListItem } from "~/hooks/useProjectSamples";

export type DashboardView = "general" | "account" | "projects" | "files" | "samples" | "timeline" | "keyboard" | "export";

const dashboardViews: readonly DashboardView[] = ["general", "account", "projects", "files", "samples", "timeline", "keyboard", "export"];

export const parseDashboardView = (value: string | null): DashboardView | null => {
  if (!value) return null;
  return dashboardViews.find((view) => view === value) ?? null;
};

export type DashboardTimelineModel = {
  projectMenu: TimelineProjectMenuModel;
  samples: Accessor<ProjectSampleListItem[]>;
  refreshSamples: () => void;
  bpm: Accessor<number>;
  setBpm: (value: number) => void;
  metronomeEnabled: Accessor<boolean>;
  toggleMetronome: () => void;
  gridEnabled: Accessor<boolean>;
  toggleGrid: () => void;
  gridDenominator: Accessor<number>;
  setGridDenominator: (value: number) => void;
  loopEnabled: Accessor<boolean>;
  toggleLoop: () => void;
};
