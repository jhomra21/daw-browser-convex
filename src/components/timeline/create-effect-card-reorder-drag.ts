import { isAudioEffectKind, type AudioEffectKind } from "@daw-browser/shared";
import { useDrag } from "~/hooks/useDrag";

type EffectCardReorderDragOptions = {
  effect: AudioEffectKind;
  orderedEffects: () => AudioEffectKind[];
  canWrite: () => boolean;
  onReorder: (effect: AudioEffectKind, targetIndex: number) => void;
};

const shouldStartReorderDrag = (event: PointerEvent) => {
  if (!(event.target instanceof Element)) return false;
  if (!event.target.closest('[data-effect-shell-header="true"]')) return false;
  return !event.target.closest('button,input,select,textarea,[role="slider"],[contenteditable="true"]');
};

export function createEffectCardReorderDrag(options: EffectCardReorderDragOptions) {
  let cardRects: Array<{ kind: AudioEffectKind; centerX: number }> = [];

  const targetIndexForPoint = (clientX: number) => {
    for (let index = 0; index < cardRects.length; index++) {
      if (clientX < cardRects[index].centerX) return index;
    }
    return cardRects.length;
  };

  const drag = useDrag({
    disabled: () => !options.canWrite(),
    dragCursorClass: "cursor-grabbing",
    onDragStart: (_, event) => {
      cardRects = [];
      if (!(event.currentTarget instanceof HTMLElement)) return;
      for (const element of event.currentTarget.parentElement?.children ?? []) {
        if (!(element instanceof HTMLElement)) continue;
        const kind = element.dataset.effectKind;
        if (!isAudioEffectKind(kind) || kind === options.effect) continue;
        const rect = element.getBoundingClientRect();
        cardRects.push({ kind, centerX: rect.left + rect.width / 2 });
      }
    },
    onDragEnd: (position) => {
      const order = options.orderedEffects();
      const currentIndex = order.indexOf(options.effect);
      if (currentIndex < 0 || cardRects.length === 0) return;
      const targetIndex = targetIndexForPoint(position.x);
      if (targetIndex === currentIndex) return;
      options.onReorder(options.effect, targetIndex);
    },
  });

  return {
    onPointerDown: (event: PointerEvent) => {
      if (!options.canWrite() || event.button !== 0 || !shouldStartReorderDrag(event)) return;
      drag.onPointerDown(event);
    },
  };
}
