import type { Accessor } from "solid-js";
import type { TimelineProjectMenuModel } from "~/hooks/transport-types";
import type { ProjectSampleListItem } from "~/hooks/useProjectSamples";

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
