import type { Accessor } from "solid-js";
import type { ProjectMutationOutcome, TimelineProject } from "~/hooks/useTimelineData";
import type { CloudBackupStatus } from "~/lib/project-save-status";
import type { DashboardView } from "~/lib/dashboard-view";
import type { TimelineBrowserTab } from "~/lib/timeline-browser/browser-types";

export type TimelineProjectMenuModel = {
  currentProjectId: string;
  currentUserId?: string;
  canManageSharing: boolean;
  projects: TimelineProject[];
  onOpenProject: (projectId: string) => void;
  onCreateProject: () => void | ProjectMutationOutcome | Promise<void | ProjectMutationOutcome>;
  onDeleteProject: (projectId: string) => void | ProjectMutationOutcome | Promise<void | ProjectMutationOutcome>;
  onRenameProject: (projectId: string, name: string) => void | ProjectMutationOutcome | Promise<void | ProjectMutationOutcome>;
  onOpenExport: () => void;
  onOpenDashboard: (view: DashboardView) => void;
  onSignIn: () => void;
  onLogout: () => void | Promise<void>;
  onAbout: () => void;
  onShare?: () => string | void | Promise<string | void>;
  onChooseProjectFolder?: () => void | Promise<void>;
  onBackUpNow?: () => void | Promise<void>;
  onDisableBackup?: () => void | Promise<void>;
  onRestoreCloudBackup?: () => void | Promise<void>;
  onDuplicateCloudBackup?: () => void | Promise<void>;
  onDownloadForOffline?: () => void | Promise<void>;
  cloudBackupStatus?: CloudBackupStatus;
  sharedOutboxStatus?: { pending: number; failed: number } | null;
  saveFailed?: boolean;
  onRetrySharedChanges?: () => void | Promise<void>;
  onExportArchive: () => void | Promise<void>;
  onImportArchive: () => void | Promise<void>;
}

export type TransportControlsProps = {
  playback: {
    isPlaying: boolean;
    isPlayPending?: boolean;
    playheadSec: number;
    onPlay: () => void;
    onPause: () => void;
    onStop: () => void;
  };
  recording: {
    isRecording: boolean;
    isRecordingPending?: boolean;
    onToggleRecord: () => void;
  };
  automation: {
    overrideCount: number;
    onReEnable: () => void;
  };
  timeline: {
    bpm: number;
    onChangeBpm: (next: number) => void;
    metronomeEnabled: boolean;
    onToggleMetronome: () => void;
    gridEnabled: boolean;
    onToggleGrid: () => void;
    followEnabled: boolean;
    onToggleFollow: () => void;
    gridDenominator: number;
    onChangeGridDenominator: (n: number) => void;
    loopEnabled: boolean;
    onToggleLoop: () => void;
    zoom: {
      onIn: () => void
      onOut: () => void
      onFit: () => void
    }
  };
  edit: {
    onUndo: () => void;
    onRedo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    canDuplicateSelection: boolean;
    canDeleteSelection: boolean;
    canCopySelection: boolean;
    canPasteSelection: boolean;
    canSelectAllClips: boolean;
    onDeleteSelection: () => void;
    onDuplicateSelection: () => void;
    onCopySelection: () => void;
    onPasteSelection: () => void;
    onSelectAllClips: () => void;
  };
  onAddAudio: () => void;
  tracksMenu: {
    syncMix: boolean;
    onToggleSyncMix: () => void;
    onAddTrack: () => void | Promise<void>;
    onAddReturnTrack: () => void | Promise<void>;
    onAddGroupTrack: () => void | Promise<void>;
    onAddInstrumentTrack: () => void | Promise<void>;
  };
  projectMenu: TimelineProjectMenuModel;
  browser: {
    open: boolean;
    onOpen: () => void;
    onToggle: () => void;
    onSelectTab: (tab: TimelineBrowserTab) => void;
  };
  midiKeyboard: {
    enabled: Accessor<boolean>;
    canPlay: Accessor<boolean>;
    targetLabel: Accessor<string | null>;
    octave: Accessor<number>;
    toggle: () => void;
  };
};
