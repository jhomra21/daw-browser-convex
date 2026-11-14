import type { Accessor } from "solid-js";
import { clampTimelineLeftBrowserWidth } from "~/lib/timeline-left-browser-preferences";
import { useDrag } from "~/hooks/useDrag";

type UseTimelineLeftBrowserResizeOptions = {
  widthPx: Accessor<number>;
  previewWidthPx: (value: number) => void;
  commitWidthPx: (value: number) => void;
  getContainerElement: () => HTMLDivElement | undefined;
  rightSidebarWidthPx: Accessor<number>;
};

export function useTimelineLeftBrowserResize(options: UseTimelineLeftBrowserResizeOptions) {
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let resizeContainerWidth = 0;
  let resizeRightSidebarWidth = 0;

  const clampWidth = (value: number) => clampTimelineLeftBrowserWidth(
    value,
    resizeContainerWidth,
    resizeRightSidebarWidth,
  );

  const drag = useDrag({
    onDragStart: (pos) => {
      resizeStartX = pos.x;
      resizeStartWidth = options.widthPx();
      resizeContainerWidth = options.getContainerElement()?.clientWidth ?? 0;
      resizeRightSidebarWidth = options.rightSidebarWidthPx();
    },
    onDragMove: (pos) => options.previewWidthPx(clampWidth(resizeStartWidth + pos.x - resizeStartX)),
    onDragEnd: (pos) => options.commitWidthPx(clampWidth(resizeStartWidth + pos.x - resizeStartX)),
    onDragCancel: () => options.previewWidthPx(resizeStartWidth),
  });

  return { onPointerDown: drag.onPointerDown };
}
