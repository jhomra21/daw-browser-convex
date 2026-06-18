import { onCleanup, type Accessor } from "solid-js";
import { clampTimelineLeftBrowserWidth } from "~/lib/timeline-left-browser-preferences";

type UseTimelineLeftBrowserResizeOptions = {
  widthPx: Accessor<number>;
  previewWidthPx: (value: number) => void;
  commitWidthPx: (value: number) => void;
  getContainerElement: () => HTMLDivElement | undefined;
  rightSidebarWidthPx: Accessor<number>;
};

export function useTimelineLeftBrowserResize(options: UseTimelineLeftBrowserResizeOptions) {
  let resizing = false;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let resizeContainerWidth = 0;
  let resizeRightSidebarWidth = 0;

  const clampWidth = (value: number) => clampTimelineLeftBrowserWidth(
    value,
    resizeContainerWidth,
    resizeRightSidebarWidth,
  );

  function onPointerMove(event: PointerEvent): void {
    if (!resizing) return;
    const delta = event.clientX - resizeStartX;
    options.previewWidthPx(clampWidth(resizeStartWidth + delta));
  }

  function onPointerUp(event: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
    const delta = event.clientX - resizeStartX;
    options.commitWidthPx(clampWidth(resizeStartWidth + delta));
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  }

  function onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    resizing = true;
    resizeStartX = event.clientX;
    resizeStartWidth = options.widthPx();
    resizeContainerWidth = options.getContainerElement()?.clientWidth ?? 0;
    resizeRightSidebarWidth = options.rightSidebarWidthPx();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  onCleanup(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  });

  return { onPointerDown };
}
