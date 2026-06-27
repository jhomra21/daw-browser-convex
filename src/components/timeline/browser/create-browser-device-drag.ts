import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { Track } from "@daw-browser/timeline-core/types";
import { useDrag } from "~/hooks/useDrag";
import { yToLaneIndex } from "~/lib/timeline-utils";
import type { BrowserDragPayload, BrowserDragSession, BrowserDropTarget } from "./browser-drag-types";

const DRAG_THRESHOLD_PX = 4;

type BrowserDeviceDragOptions = {
  resolvePayload: (itemId: string) => BrowserDragPayload | undefined;
  tracks: Accessor<Track[]>;
  scrollElement: () => HTMLDivElement | undefined;
  effectsChainElement: () => HTMLElement | undefined;
  currentEffectsTargetId: Accessor<Track["id"] | "master">;
  canDrop: (payload: BrowserDragPayload, target: BrowserDropTarget) => boolean;
  onDrop: (payload: BrowserDragPayload, target: BrowserDropTarget) => void | Promise<void>;
};

const pointerPosition = (event: PointerEvent) => ({
  x: event.clientX,
  y: event.clientY,
});

const distanceFromStart = (start: { x: number; y: number }, pointer: { x: number; y: number }) =>
  Math.hypot(pointer.x - start.x, pointer.y - start.y);

const isInsideRect = (pointer: { x: number; y: number }, rect: DOMRect) => (
  pointer.x >= rect.left &&
  pointer.x <= rect.right &&
  pointer.y >= rect.top &&
  pointer.y <= rect.bottom
);

const resolveTimelineTrackTarget = (
  pointer: { x: number; y: number },
  scrollElement: HTMLDivElement | undefined,
  tracks: Track[],
): BrowserDropTarget => {
  if (!scrollElement) return { kind: "none" };
  if (!isInsideRect(pointer, scrollElement.getBoundingClientRect())) return { kind: "none" };
  const laneIndex = yToLaneIndex(pointer.y, scrollElement);
  if (laneIndex >= 0 && laneIndex < tracks.length) return { kind: "track", trackId: tracks[laneIndex].id, laneIndex };
  if (laneIndex >= tracks.length) return { kind: "new-track" };
  return { kind: "none" };
};

const resolveEffectChainPreview = (
  pointer: { x: number; y: number },
  chainElement: HTMLElement | undefined,
  currentTargetId: Track["id"] | "master",
): Pick<BrowserDragSession, "target" | "effectChainPreview"> | undefined => {
  if (!chainElement) return;
  const chainRect = chainElement.getBoundingClientRect();
  if (!isInsideRect(pointer, chainRect)) return;
  const cards = Array.from(chainElement.querySelectorAll("[data-effect-kind]"));
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (!(card instanceof HTMLElement)) continue;
    const rect = card.getBoundingClientRect();
    if (pointer.x < rect.left + rect.width / 2) {
      return {
        target: { kind: "effect-chain", targetId: currentTargetId, index },
        effectChainPreview: { x: rect.left, top: rect.top, height: rect.height },
      };
    }
  }
  return {
    target: { kind: "effect-chain", targetId: currentTargetId, index: cards.length },
    effectChainPreview: { x: chainRect.right, top: chainRect.top, height: chainRect.height },
  };
};

const resolveCompatibleTarget = (
  payload: BrowserDragPayload,
  pointer: { x: number; y: number },
  options: BrowserDeviceDragOptions,
): Pick<BrowserDragSession, "target" | "effectChainPreview"> => {
  if (payload.kind === "audio-effect") {
    const chain = resolveEffectChainPreview(pointer, options.effectsChainElement(), options.currentEffectsTargetId());
    if (chain) return options.canDrop(payload, chain.target) ? chain : { target: { kind: "none" } };
  }
  const tracks = options.tracks();
  const target = resolveTimelineTrackTarget(pointer, options.scrollElement(), tracks);
  if (target.kind === "track") {
    return { target: options.canDrop(payload, target) ? target : { kind: "none" } };
  }
  if (target.kind === "new-track" && !options.canDrop(payload, target)) return { target: { kind: "none" } };
  return { target };
};

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
        const target = resolveCompatibleTarget(pending.payload, pointer, options);
        setSession({ ...currentSession, pointer, target: target.target, effectChainPreview: target.effectChainPreview });
        event.preventDefault();
        return;
      }
      if (distanceFromStart(pending.start, pointer) < DRAG_THRESHOLD_PX) return;
      const target = resolveCompatibleTarget(pending.payload, pointer, options);
      setSession({
        payload: pending.payload,
        pointer,
        target: target.target,
        effectChainPreview: target.effectChainPreview,
        ghostOffset: pending.ghostOffset,
        ghostSize: pending.ghostSize,
      });
      event.preventDefault();
    },
    onDragEnd: () => {
      const droppedSession = session();
      if (droppedSession) {
        suppressNextClick();
        if (droppedSession.target.kind !== "none") {
          void Promise.resolve(options.onDrop(droppedSession.payload, droppedSession.target)).catch(() => {});
        }
      }
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
