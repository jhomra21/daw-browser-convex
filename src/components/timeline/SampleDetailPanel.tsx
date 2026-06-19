import { createMemo, type Component } from "solid-js";
import type { AudioEngine } from "@daw-browser/audio-engine/audio-engine";
import type { AudioWarp, Clip } from "@daw-browser/timeline-core/types";
import type { BpmDetectionService } from "~/lib/bpm-detection-service";
import SampleClipPanel from "~/components/timeline/SampleClipPanel";
import SampleDetailWaveform from "~/components/timeline/SampleDetailWaveform";
import TimelineBottomPanelFooter from "~/components/timeline/TimelineBottomPanelFooter";
import TimelineBottomPanelShell, { type TimelineBottomPanelShellControls } from "~/components/timeline/TimelineBottomPanelShell";

type SampleDetailPanelProps = {
  clip: Clip<AudioBuffer>;
  projectBpm: number;
  audioEngine: AudioEngine;
  bpmDetection: BpmDetectionService;
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>;
  canWriteClip: (clipId: string) => boolean;
  onWarpChange: (clip: Clip, audioWarp: AudioWarp) => Promise<boolean> | boolean | void;
  onGainChange: (clip: Clip, gain: number) => Promise<boolean> | boolean | void;
  onMarkerDragStateChange?: (dragging: boolean) => void;
  shell: TimelineBottomPanelShellControls;
  onClose: () => void;
  onHide: () => void;
};

const SampleDetailPanel: Component<SampleDetailPanelProps> = (props) => {
  const canWrite = createMemo(() => props.canWriteClip(props.clip.id));

  return (
    <TimelineBottomPanelShell
      controls={props.shell}
      resizeLabel="Resize sample detail panel"
      footer={
        <TimelineBottomPanelFooter
          activeTab="clip"
          toggleLabel="Hide"
          onEffectsTabClick={props.onClose}
          onToggle={props.onHide}
        />
      }
    >
      <div class="flex h-full gap-3 overflow-x-auto px-3 py-3">
        <div class="flex w-20 shrink-0 flex-col items-center justify-center border-r border-neutral-800 pr-2">
          <span
            class="inline-flex text-sm font-semibold uppercase tracking-widest text-neutral-300"
            style={{ transform: "rotate(-90deg)", "white-space": "nowrap" }}
          >
            Sample Detail
          </span>
        </div>
        <SampleClipPanel
          audioEngine={props.audioEngine}
          sample={{
            clip: props.clip,
            projectBpm: props.projectBpm,
            bpmDetection: props.bpmDetection,
            ensureClipBuffer: props.ensureClipBuffer,
            canWrite: canWrite(),
            onWarpChange: (audioWarp) => props.onWarpChange(props.clip, audioWarp),
            onGainChange: (gain) => props.onGainChange(props.clip, gain),
          }}
        />
        <SampleDetailWaveform
          clip={props.clip}
          projectBpm={props.projectBpm}
          ensureClipBuffer={props.ensureClipBuffer}
          canWrite={canWrite()}
          onMarkerDragStateChange={props.onMarkerDragStateChange}
          onWarpChange={(audioWarp) => props.onWarpChange(props.clip, audioWarp)}
        />
      </div>
    </TimelineBottomPanelShell>
  );
};

export default SampleDetailPanel;
