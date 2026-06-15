import { createEffect, createSignal, type Accessor } from "solid-js";
import { loadSampleDetailPanelHeight } from "~/lib/sample-detail-panel-preferences";
import { FX_PANEL_HEIGHT_PX } from "~/lib/timeline-utils";

type TimelineBottomPanelMode = "effects" | "sample-detail";

const BOTTOM_PANEL_GAP_PX = 8;

type TimelineBottomPanelStateOptions = {
  projectId: Accessor<string | null>;
};

export const useTimelineBottomPanelState = (options: TimelineBottomPanelStateOptions) => {
  const [open, setOpen] = createSignal(true);
  const [mode, setMode] = createSignal<TimelineBottomPanelMode>("effects");
  const [sampleDetailHeightPx, setSampleDetailHeightPx] = createSignal(FX_PANEL_HEIGHT_PX);
  const [agentPanelOpen, setAgentPanelOpen] = createSignal(false);
  const [sharedChatOpen, setSharedChatOpen] = createSignal(false);

  const heightPx = () => mode() === "sample-detail" ? sampleDetailHeightPx() : FX_PANEL_HEIGHT_PX;
  const chatBottomOffsetPx = () => open() ? heightPx() + BOTTOM_PANEL_GAP_PX : 0;

  createEffect(() => {
    if (mode() !== "sample-detail" || typeof window === "undefined") return;
    setSampleDetailHeightPx(loadSampleDetailPanelHeight(options.projectId() ?? "default", window.innerHeight));
  });

  return {
    open,
    setOpen,
    mode,
    setMode,
    heightPx,
    chatBottomOffsetPx,
    agentPanelOpen,
    sharedChatOpen,
    toggleAgentPanel: () => setAgentPanelOpen((value) => !value),
    toggleSharedChat: () => setSharedChatOpen((value) => !value),
    closeAgentPanel: () => setAgentPanelOpen(false),
    closeSharedChat: () => setSharedChatOpen(false),
    setSampleDetailHeightPx,
  };
};
