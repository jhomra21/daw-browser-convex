import type { InsertSampleInput } from "~/hooks/useTimelineClipImport";
import type { TimelineProject } from "~/hooks/useTimelineData";
import type { Track } from "~/types/timeline";

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
  onMasterFX: () => void;
  onShare?: () => void;
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
  onJumpToClip: (
    clipId: string,
    trackId: Track["id"],
    startSec: number,
  ) => void;
  onInsertSample: (input: InsertSampleInput) => void | Promise<void>;
  currentProjectId: string;
  currentUserId?: string;
  projects: TimelineProject[];
  onOpenProject: (projectId: string) => void;
  onCreateProject: () => void | Promise<void>;
  onDeleteProject: (projectId: string) => void | Promise<void>;
  onRenameProject: (projectId: string, name: string) => void | Promise<void>;
  onOpenExport: () => void;
  onChooseProjectFolder?: () => void | Promise<void>;
  onBackUpNow?: () => void | Promise<void>;
  onExportArchive?: () => void | Promise<void>;
  onImportArchive?: () => void | Promise<void>;
};
