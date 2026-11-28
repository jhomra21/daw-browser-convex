import type { Component, JSX } from "solid-js";
import { BOTTOM_PANEL_DEFAULT_HEIGHT_PX } from "~/lib/bottom-panel-preferences";
import { BOTTOM_PANEL_EDGE_PADDING_PX, BOTTOM_PANEL_RESIZE_HANDLE_OVERHANG_PX } from "~/lib/bottom-panel-layout";
import { useDrag } from "~/hooks/useDrag";

export type TimelineBottomPanelShellControls = {
  heightPx: number;
  onHeightPreview: (heightPx: number) => void;
  onHeightCommit: (heightPx: number) => void;
};

type TimelineBottomPanelShellProps = {
  controls: TimelineBottomPanelShellControls;
  resizeLabel: string;
  footer?: JSX.Element;
  children: JSX.Element;
};

const TimelineBottomPanelShell: Component<TimelineBottomPanelShellProps> = (props) => {
  let dragStartY = 0;
  let dragStartHeight = 0;

  const resizeDrag = useDrag({
    onDragStart: (pos) => {
      dragStartY = pos.y;
      dragStartHeight = props.controls.heightPx;
    },
    onDragMove: (pos) => props.controls.onHeightPreview(dragStartHeight + dragStartY - pos.y),
    onDragEnd: () => props.controls.onHeightCommit(props.controls.heightPx),
    onDragCancel: () => props.controls.onHeightPreview(dragStartHeight),
  });

  return (
    <div
      class="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-app-surface"
      style={{ "padding-bottom": `${BOTTOM_PANEL_EDGE_PADDING_PX}px` }}
    >
      <button
        type="button"
        aria-label={props.resizeLabel}
        class="group absolute left-0 right-0 top-0 z-40 -translate-y-1/2 cursor-ns-resize"
        style={{ height: `${BOTTOM_PANEL_RESIZE_HANDLE_OVERHANG_PX * 2}px` }}
        onDblClick={() => props.controls.onHeightCommit(BOTTOM_PANEL_DEFAULT_HEIGHT_PX)}
        onPointerDown={resizeDrag.onPointerDown}
      >
        <div class="pointer-events-none absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 bg-transparent group-hover:bg-sky-500/20 group-active:bg-sky-500/20" />
      </button>
      <div style={{ height: `${props.controls.heightPx}px` }}>
        {props.children}
      </div>
      {props.footer}
    </div>
  );
};

export default TimelineBottomPanelShell;
