import { type Component, type JSX, Show } from "solid-js";
import TransportControls from "./TransportControls";
import LocalSaveFailureBanner from "./local-save-failure-banner";
import TimelinePanels, { type TimelinePanelsProps } from "./timeline-panels";
import type { TransportControlsProps } from "./transport-types";

type TimelineChromeProps = {
  fileInputRef: (el: HTMLInputElement) => void;
  archiveInputRef: (el: HTMLInputElement) => void;
  onFileInput: JSX.EventHandler<HTMLInputElement, Event>;
  onArchiveInput: JSX.EventHandler<HTMLInputElement, Event>;
  transport: TransportControlsProps;
  localSaveFailure: string | null;
  onExportArchive: () => void | Promise<void>;
  onDismissLocalSaveFailure: () => void;
  panels: TimelinePanelsProps;
};

const TimelineChrome: Component<TimelineChromeProps> = (props) => (
  <>
    <input
      ref={props.fileInputRef}
      type="file"
      accept="audio/*"
      class="hidden"
      onChange={props.onFileInput}
    />
    <input
      ref={props.archiveInputRef}
      type="file"
      accept=".dawproject,application/vnd.dawproject,application/zip"
      class="hidden"
      onChange={props.onArchiveInput}
    />

    <TransportControls {...props.transport} />
    <Show when={props.localSaveFailure}>
      {(message) => (
        <LocalSaveFailureBanner
          message={message()}
          onExportArchive={props.onExportArchive}
          onDismiss={props.onDismissLocalSaveFailure}
        />
      )}
    </Show>
    <TimelinePanels {...props.panels} />
  </>
);

export default TimelineChrome;
