import { createEffect, createSignal, type Accessor } from "solid-js";
import { getBottomPanelMountedFootprintPx, type BottomPanelMode } from "~/lib/bottom-panel-layout";
import { BOTTOM_PANEL_DEFAULT_HEIGHT_PX, clampBottomPanelHeight, loadBottomPanelHeight, saveBottomPanelHeight } from "~/lib/bottom-panel-preferences";

export type TimelineBottomPanelMode = BottomPanelMode;

const BOTTOM_PANEL_GAP_PX = 8;

type TimelineBottomPanelStateOptions = {
  projectId: Accessor<string | null>;
};

export const useTimelineBottomPanelState = (options: TimelineBottomPanelStateOptions) => {
  const [open, setOpen] = createSignal(true);
  const [mode, setMode] = createSignal<TimelineBottomPanelMode>("effects");
  const [heightPx, setHeightPx] = createSignal(BOTTOM_PANEL_DEFAULT_HEIGHT_PX);
  const [sharedChatOpen, setSharedChatOpen] = createSignal(false);

  const bottomPanelOffsetPx = () => getBottomPanelMountedFootprintPx({ open: open(), heightPx: heightPx() });
  const chatBottomOffsetPx = () => bottomPanelOffsetPx() > 0 ? bottomPanelOffsetPx() + BOTTOM_PANEL_GAP_PX : 0;
  const preferenceScopeId = () => options.projectId() ?? "default";
  const viewportHeightPx = () => globalThis.window?.innerHeight ?? heightPx();

  createEffect(() => {
    if (!globalThis.window) return;
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
    bottomPanelOffsetPx,
    previewHeightPx,
    commitHeightPx,
    chatBottomOffsetPx,
    sharedChatOpen,
    toggleSharedChat: () => setSharedChatOpen((value) => !value),
    closeSharedChat: () => setSharedChatOpen(false),
  };
};
