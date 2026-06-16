import { createEffect, createSignal, type Accessor } from "solid-js";
import { BOTTOM_PANEL_DEFAULT_HEIGHT_PX, clampBottomPanelHeight, loadBottomPanelHeight, saveBottomPanelHeight } from "~/lib/bottom-panel-preferences";

export type TimelineBottomPanelMode = "effects" | "sample-detail";

const BOTTOM_PANEL_GAP_PX = 8;

type TimelineBottomPanelStateOptions = {
  projectId: Accessor<string | null>;
};

export const useTimelineBottomPanelState = (options: TimelineBottomPanelStateOptions) => {
  const [open, setOpen] = createSignal(true);
  const [mode, setMode] = createSignal<TimelineBottomPanelMode>("effects");
  const [heightPx, setHeightPx] = createSignal(BOTTOM_PANEL_DEFAULT_HEIGHT_PX);
  const [agentPanelOpen, setAgentPanelOpen] = createSignal(false);
  const [sharedChatOpen, setSharedChatOpen] = createSignal(false);

  const chatBottomOffsetPx = () => open() ? heightPx() + BOTTOM_PANEL_GAP_PX : 0;
  const preferenceScopeId = () => options.projectId() ?? "default";
  const viewportHeightPx = () => typeof window === "undefined" ? heightPx() : window.innerHeight;

  createEffect(() => {
    if (typeof window === "undefined") return;
    setHeightPx(loadBottomPanelHeight(preferenceScopeId(), window.innerHeight));
  });

  const previewHeightPx = (value: number) => {
    setHeightPx(clampBottomPanelHeight(value, viewportHeightPx()));
  };

  const commitHeightPx = (value: number) => {
    setHeightPx(saveBottomPanelHeight(preferenceScopeId(), value, viewportHeightPx()));
  };

  return {
    open,
    setOpen,
    mode,
    setMode,
    heightPx,
    previewHeightPx,
    commitHeightPx,
    chatBottomOffsetPx,
    agentPanelOpen,
    sharedChatOpen,
    toggleAgentPanel: () => setAgentPanelOpen((value) => !value),
    toggleSharedChat: () => setSharedChatOpen((value) => !value),
    closeAgentPanel: () => setAgentPanelOpen(false),
    closeSharedChat: () => setSharedChatOpen(false),
  };
};
