import type { InsertSampleInput } from "~/hooks/useTimelineClipImport";
import type { TimelineProject } from "~/hooks/useTimelineData";
import type { CloudBackupStatus } from "~/hooks/useLocalProjectActions";
import type { Track } from "@daw-browser/timeline-core/types";
import type { DashboardView } from "~/components/dashboard/types";
import type { TimelineBrowserTab } from "~/components/timeline/browser/browser-types";

export type TimelineProjectMenuModel = {
  currentProjectId: string;
  currentUserId?: string;
  canManageSharing: boolean;
  projects: TimelineProject[];
  onOpenProject: (projectId: string) => void;
  onCreateProject: () => void | Promise<void>;
  onDeleteProject: (projectId: string) => void | Promise<void>;
  onRenameProject: (projectId: string, name: string) => void | Promise<void>;
  onOpenExport: () => void;
  onOpenDashboard: (view: DashboardView) => void;
  onShare?: () => string | void | Promise<string | void>;
  onChooseProjectFolder?: () => void | Promise<void>;
  onBackUpNow?: () => void | Promise<void>;
  onDisableBackup?: () => void | Promise<void>;
  onRestoreCloudBackup?: () => void | Promise<void>;
  onDuplicateCloudBackup?: () => void | Promise<void>;
  onDownloadForOffline?: () => void | Promise<void>;
  cloudBackupStatus?: CloudBackupStatus;
  sharedOutboxStatus?: { pending: number; failed: number };
  onRetrySharedChanges?: () => void | Promise<void>;
  onExportArchive: () => void | Promise<void>;
  onImportArchive: () => void | Promise<void>;
}

export type TransportControlsProps = {
  isPlaying: boolean;
  playheadSec: number;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onAddAudio: () => void;
  tracksMenu: {
    syncMix: boolean;
    onToggleSyncMix: () => void;
    onAddTrack: () => void | Promise<void>;
    onAddReturnTrack: () => void | Promise<void>;
    onAddGroupTrack: () => void | Promise<void>;
    onAddInstrumentTrack: () => void | Promise<void>;
  };
  bpm: number;
  onChangeBpm: (next: number) => void;
  metronomeEnabled: boolean;
  onToggleMetronome: () => void;
  gridEnabled: boolean;
  onToggleGrid: () => void;
  gridDenominator: number;
  onChangeGridDenominator: (n: number) => void;
  loopEnabled: boolean;
  onToggleLoop: () => void;
  isRecording: boolean;
  onToggleRecord: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onJumpToClip: (
    clipId: string,
    trackId: Track["id"],
    startSec: number,
  ) => void;
  onInsertSample: (input: InsertSampleInput) => void | Promise<void>;
  projectMenu: TimelineProjectMenuModel;
  browser: {
    open: boolean;
    onOpen: () => void;
    onToggle: () => void;
    onSelectTab: (tab: TimelineBrowserTab) => void;
  };
  midiKeyboard: {
    enabled: boolean;
    canPlay: boolean;
    targetLabel: string | null;
    octave: number;
    onToggle: () => void;
  };
};
