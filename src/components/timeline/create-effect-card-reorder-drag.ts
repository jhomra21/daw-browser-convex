import { isAudioEffectKind, type AudioEffectKind } from "@daw-browser/shared";
import { onCleanup } from "solid-js";
import { useDrag } from "~/hooks/useDrag";

type EffectCardReorderDragOptions = {
  effect: AudioEffectKind;
  orderedEffects: () => AudioEffectKind[];
  canWrite: () => boolean;
  onReorder: (effect: AudioEffectKind, targetIndex: number) => void;
  onPreviewChange: (preview: EffectCardReorderPreview | undefined) => void;
};

export type EffectCardReorderPreview = {
  effect: AudioEffectKind;
  indicatorX: number;
  top: number;
  height: number;
  ghost: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

const shouldStartReorderDrag = (event: PointerEvent) => {
  if (!(event.target instanceof Element)) return false;
  if (!event.target.closest('[data-effect-shell-header="true"]')) return false;
  return !event.target.closest('button,input,select,textarea,[role="slider"],[contenteditable="true"]');
};

export function createEffectCardReorderDrag(options: EffectCardReorderDragOptions) {
  let cardRects: Array<{ left: number; right: number; centerX: number }> = [];
  let chainRect: { top: number; height: number } | undefined;
  let sourceLeft = 0;
  let ghostOffset: { x: number; y: number } | undefined;
  let ghostSize: { width: number; height: number } | undefined;

  const targetIndexForPoint = (clientX: number) => {
    for (let index = 0; index < cardRects.length; index++) {
      if (clientX < cardRects[index].centerX) return index;
    }
    return cardRects.length;
  };

  const indicatorXForTargetIndex = (targetIndex: number) => {
    if (cardRects.length === 0) return sourceLeft;
    if (targetIndex <= 0) return cardRects[0].left;
    if (targetIndex >= cardRects.length) return cardRects[cardRects.length - 1].right;
    return (cardRects[targetIndex - 1].right + cardRects[targetIndex].left) / 2;
  };

  const updatePreview = (position: { x: number; y: number }) => {
    if (!chainRect || !ghostOffset || !ghostSize) return;
    const targetIndex = targetIndexForPoint(position.x);
    options.onPreviewChange({
      effect: options.effect,
      indicatorX: indicatorXForTargetIndex(targetIndex),
      top: chainRect.top,
      height: chainRect.height,
      ghost: {
        left: position.x - ghostOffset.x,
        top: position.y - ghostOffset.y,
        width: ghostSize.width,
        height: ghostSize.height,
      },
    });
  };

  const clearPreview = () => {
    cardRects = [];
    chainRect = undefined;
    sourceLeft = 0;
    ghostOffset = undefined;
    ghostSize = undefined;
    options.onPreviewChange(undefined);
  };

  const drag = useDrag({
    disabled: () => !options.canWrite(),
    dragCursorClass: "cursor-grabbing",
    onDragStart: (position, event) => {
      cardRects = [];
      if (!(event.currentTarget instanceof HTMLElement)) return;
      const sourceRect = event.currentTarget.getBoundingClientRect();
      sourceLeft = sourceRect.left;
      ghostOffset = { x: position.x - sourceRect.left, y: position.y - sourceRect.top };
      ghostSize = { width: sourceRect.width, height: sourceRect.height };
      const parentRect = event.currentTarget.parentElement?.getBoundingClientRect();
      chainRect = parentRect ? { top: parentRect.top, height: parentRect.height } : undefined;
      for (const element of event.currentTarget.parentElement?.children ?? []) {
        if (!(element instanceof HTMLElement)) continue;
        const kind = element.dataset.effectKind;
        if (!isAudioEffectKind(kind) || kind === options.effect) continue;
        const rect = element.getBoundingClientRect();
        cardRects.push({ left: rect.left, right: rect.right, centerX: rect.left + rect.width / 2 });
      }
      updatePreview(position);
    },
    onDragMove: (position) => {
      updatePreview(position);
    },
    onDragEnd: (position) => {
      const order = options.orderedEffects();
      const currentIndex = order.indexOf(options.effect);
      const targetIndex = targetIndexForPoint(position.x);
      const canReorder = cardRects.length > 0;
      clearPreview();
      if (currentIndex < 0 || !canReorder || targetIndex === currentIndex) return;
      options.onReorder(options.effect, targetIndex);
    },
    onDragCancel: clearPreview,
  });

  onCleanup(clearPreview);

  return {
    onPointerDown: (event: PointerEvent) => {
      if (!options.canWrite() || event.button !== 0 || !shouldStartReorderDrag(event)) return;
      drag.onPointerDown(event);
    },
  };
}
