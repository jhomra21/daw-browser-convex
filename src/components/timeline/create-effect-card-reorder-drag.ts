import type { AudioEffectKind } from "@daw-browser/shared";
import { useDrag } from "~/hooks/useDrag";

type EffectCardReorderDragOptions = {
  effect: AudioEffectKind;
  orderedEffects: () => AudioEffectKind[];
  canWrite: () => boolean;
  onReorder: (effect: AudioEffectKind, targetIndex: number) => void;
};

export function createEffectCardReorderDrag(options: EffectCardReorderDragOptions) {
  let startX = 0;
  let cardWidth = 0;

  const drag = useDrag({
    disabled: () => !options.canWrite(),
    dragCursorClass: "cursor-grabbing",
    onDragStart: (position, event) => {
      startX = position.x;
      cardWidth = event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect().width
        : 0;
    },
    onDragEnd: (position) => {
      const order = options.orderedEffects();
      const currentIndex = order.indexOf(options.effect);
      if (currentIndex < 0 || cardWidth <= 0) return;
      const offset = Math.round((position.x - startX) / cardWidth);
      if (offset === 0) return;
      options.onReorder(options.effect, currentIndex + offset);
    },
  });

  return {
    onPointerDown: (event: PointerEvent) => {
      if (!options.canWrite() || event.button !== 0) return;
      drag.onPointerDown(event);
    },
  };
}
