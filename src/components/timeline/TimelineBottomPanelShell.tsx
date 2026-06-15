import { createEffect, createSignal, onCleanup, type Component, type JSX } from "solid-js";
import { BOTTOM_PANEL_DEFAULT_HEIGHT_PX } from "~/lib/bottom-panel-preferences";

export type TimelineBottomPanelShellControls = {
  heightPx: number;
  onHeightPreview: (heightPx: number) => void;
  onHeightCommit: (heightPx: number) => void;
};

type TimelineBottomPanelShellProps = {
  controls: TimelineBottomPanelShellControls;
  resizeLabel: string;
  children: JSX.Element;
};

const TimelineBottomPanelShell: Component<TimelineBottomPanelShellProps> = (props) => {
  const [dragStart, setDragStart] = createSignal<{ y: number; height: number }>();

  createEffect(() => {
    const start = dragStart();
    if (!start) return;
    const onMove = (event: PointerEvent) => {
      props.controls.onHeightPreview(start.height + start.y - event.clientY);
    };
    const onUp = () => {
      props.controls.onHeightCommit(props.controls.heightPx);
      setDragStart(undefined);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      props.controls.onHeightPreview(start.height);
      setDragStart(undefined);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
    window.addEventListener("blur", onUp, { once: true });
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div class="fixed left-0 right-0 bottom-0 z-50 border-t border-neutral-800 bg-neutral-900">
      <button
        type="button"
        aria-label={props.resizeLabel}
        class="absolute left-0 right-0 top-0 h-2 cursor-ns-resize bg-neutral-800/60 hover:bg-sky-500/50"
        onDblClick={() => props.controls.onHeightCommit(BOTTOM_PANEL_DEFAULT_HEIGHT_PX)}
        onPointerDown={(event) => {
          event.preventDefault();
          setDragStart({ y: event.clientY, height: props.controls.heightPx });
        }}
      />
      <div style={{ height: `${props.controls.heightPx}px` }}>
        {props.children}
      </div>
    </div>
  );
};

export default TimelineBottomPanelShell;
