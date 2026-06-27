import { createSignal, onCleanup, type Accessor } from "solid-js";
import { useDrag } from "~/hooks/useDrag";
import type { BrowserDragPayload, BrowserDragSession } from "./browser-drag-types";

const DRAG_THRESHOLD_PX = 4;

type BrowserDeviceDragOptions = {
  resolvePayload: (itemId: string) => BrowserDragPayload | undefined;
};

const pointerPosition = (event: PointerEvent) => ({
  x: event.clientX,
  y: event.clientY,
});

const distanceFromStart = (start: { x: number; y: number }, pointer: { x: number; y: number }) =>
  Math.hypot(pointer.x - start.x, pointer.y - start.y);

export function createBrowserDeviceDrag(options: BrowserDeviceDragOptions): {
  session: Accessor<BrowserDragSession | undefined>;
  onPointerDown: (event: PointerEvent, itemId: string) => void;
} {
  const [session, setSession] = createSignal<BrowserDragSession>();
  let clickSuppressor: ((event: MouseEvent) => void) | undefined;
  let pending:
    | {
      payload: BrowserDragPayload;
      start: { x: number; y: number };
      ghostOffset: { x: number; y: number };
      ghostSize: { width: number; height: number };
    }
    | undefined;

  const clearClickSuppressor = () => {
    if (!clickSuppressor) return;
    window.removeEventListener("click", clickSuppressor, { capture: true });
    clickSuppressor = undefined;
  };

  const suppressNextClick = () => {
    clearClickSuppressor();
    const handleClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      clearClickSuppressor();
    };
    clickSuppressor = handleClick;
    window.addEventListener("click", handleClick, { capture: true, once: true });
  };

  const cleanup = () => {
    pending = undefined;
    setSession(undefined);
  };

  const drag = useDrag({
    dragCursorClass: "cursor-grabbing",
    preventDefaultOnPointerDown: false,
    onDragMove: (pointer, event) => {
      if (!pending) return;
      const currentSession = session();
      if (currentSession) {
        setSession({ ...currentSession, pointer });
        event.preventDefault();
        return;
      }
      if (distanceFromStart(pending.start, pointer) < DRAG_THRESHOLD_PX) return;
      setSession({
        payload: pending.payload,
        pointer,
        target: { kind: "none" },
        ghostOffset: pending.ghostOffset,
        ghostSize: pending.ghostSize,
      });
      event.preventDefault();
    },
    onDragEnd: () => {
      if (session()) suppressNextClick();
      cleanup();
    },
    onDragCancel: cleanup,
  });

  const onPointerDown = (event: PointerEvent, itemId: string) => {
    if (event.button !== 0) return;
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const payload = options.resolvePayload(itemId);
    if (!payload) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = pointerPosition(event);
    pending = {
      payload,
      start,
      ghostOffset: { x: start.x - rect.left, y: start.y - rect.top },
      ghostSize: { width: rect.width, height: rect.height },
    };
    drag.onPointerDown(event);
  };

  onCleanup(() => {
    cleanup();
    clearClickSuppressor();
    drag.cancelDrag();
  });

  return {
    session,
    onPointerDown,
  };
}
