import { onCleanup } from "solid-js";
import {
  isDeviceHeaderTarget,
  isDeviceInteractiveTarget,
  REORDER_ACTIVATION_THRESHOLD_PX,
} from "~/components/timeline/device-interaction";

type EffectCardReorderDragOptions<T extends { id: string }> = {
  effect: T;
  orderedEffects: () => T[];
  canWrite: () => boolean;
  onReorder: (effect: T, targetIndex: number) => void;
  onPreviewChange: (preview: EffectCardReorderPreview<T> | undefined) => void;
};

export type EffectCardReorderPreview<T extends { id: string }> = {
  effect: T;
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
  return isDeviceHeaderTarget(event.target) && !isDeviceInteractiveTarget(event.target);
};

export function createEffectCardReorderDrag<T extends { id: string }>(options: EffectCardReorderDragOptions<T>) {
  let cardRects: Array<{ left: number; right: number; centerX: number }> = [];
  let chainRect: { top: number; height: number } | undefined;
  let sourceLeft = 0;
  let ghostOffset: { x: number; y: number } | undefined;
  let ghostSize: { width: number; height: number } | undefined;
  let pointerStart: { x: number; y: number } | undefined;
  let pointerId: number | undefined;
  let sourceElement: HTMLElement | undefined;
  let dragActivated = false;

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
    pointerStart = undefined;
    pointerId = undefined;
    sourceElement = undefined;
    dragActivated = false;
    options.onPreviewChange(undefined);
  };

  const removePointerListeners = () => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp, { capture: true })
    window.removeEventListener('pointercancel', handlePointerCancel, { capture: true })
    document.body.classList.remove('select-none', 'cursor-grabbing')
  }

  const activateDrag = (position: { x: number; y: number }) => {
      if (!sourceElement) return;
      const sourceRect = sourceElement.getBoundingClientRect();
      sourceLeft = sourceRect.left;
      ghostOffset = { x: position.x - sourceRect.left, y: position.y - sourceRect.top };
      ghostSize = { width: sourceRect.width, height: sourceRect.height };
      const parentRect = sourceElement.parentElement?.getBoundingClientRect();
      chainRect = parentRect ? { top: parentRect.top, height: parentRect.height } : undefined;
      for (const element of sourceElement.parentElement?.children ?? []) {
        if (!(element instanceof HTMLElement)) continue;
        const effectId = element.dataset.effectId;
        if (!effectId || effectId === options.effect.id) continue;
        const rect = element.getBoundingClientRect();
        cardRects.push({ left: rect.left, right: rect.right, centerX: rect.left + rect.width / 2 });
      }
      dragActivated = true;
      document.body.classList.add('select-none', 'cursor-grabbing')
      updatePreview(position);
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId || !pointerStart) return
    const position = { x: event.clientX, y: event.clientY }
    if (!dragActivated) {
      if (Math.hypot(position.x - pointerStart.x, position.y - pointerStart.y) < REORDER_ACTIVATION_THRESHOLD_PX) return
      activateDrag(position)
      return
    }
    updatePreview(position)
  }

  const finishPointer = (event: PointerEvent, cancelled: boolean) => {
    if (event.pointerId !== pointerId) return
    const position = { x: event.clientX, y: event.clientY }
    const order = options.orderedEffects()
    const currentIndex = order.findIndex((entry) => entry.id === options.effect.id)
    const targetIndex = targetIndexForPoint(position.x)
    const canReorder = !cancelled && dragActivated && cardRects.length > 0
    removePointerListeners()
    clearPreview()
    if (currentIndex < 0 || !canReorder || targetIndex === currentIndex) return
    options.onReorder(options.effect, targetIndex)
  }

  const handlePointerUp = (event: PointerEvent) => finishPointer(event, false)
  const handlePointerCancel = (event: PointerEvent) => finishPointer(event, true)

  onCleanup(() => {
    removePointerListeners()
    clearPreview()
  });

  return {
    onPointerDown: (event: PointerEvent) => {
      if (pointerId !== undefined || !options.canWrite() || event.button !== 0 || !shouldStartReorderDrag(event)) return;
      pointerId = event.pointerId
      pointerStart = { x: event.clientX, y: event.clientY }
      sourceElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
      dragActivated = false
      cardRects = []
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp, { capture: true })
      window.addEventListener('pointercancel', handlePointerCancel, { capture: true })
    },
  };
}
