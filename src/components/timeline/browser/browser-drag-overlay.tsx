import { Show, type Accessor, type Component } from "solid-js";
import type { BrowserDragSession } from "./browser-drag-types";

export const BrowserDragOverlay: Component<{ session: Accessor<BrowserDragSession | undefined> }> = (props) => (
  <Show when={props.session()}>
    {(session) => (
      <div
        class="pointer-events-none fixed z-50 opacity-70 shadow-2xl"
        style={{
          left: `${session().pointer.x - session().ghostOffset.x}px`,
          top: `${session().pointer.y - session().ghostOffset.y}px`,
          width: `${session().ghostSize.width}px`,
          height: `${session().ghostSize.height}px`,
        }}
      >
        <div class="border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100">
          {session().payload.label}
        </div>
      </div>
    )}
  </Show>
);
