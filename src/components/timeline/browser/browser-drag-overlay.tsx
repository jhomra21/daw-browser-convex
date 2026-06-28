import { Show, type Accessor, type Component } from "solid-js";
import type { BrowserDragSession } from "./browser-drag-types";

export const BrowserDragOverlay: Component<{ session: Accessor<BrowserDragSession | undefined> }> = (props) => (
  <Show when={props.session()}>
    {(session) => (
      <>
        <Show when={session().effectChainPreview}>
          {(preview) => (
            <div
              class="pointer-events-none fixed z-50 w-px bg-cyan-300 shadow-lg"
              style={{
                left: `${preview().x}px`,
                top: `${preview().top}px`,
                height: `${preview().height}px`,
                transform: "translateX(-50%)",
              }}
            />
          )}
        </Show>
        <div
          class="pointer-events-none fixed z-50 opacity-70 shadow-2xl"
          style={{
            left: `${session().pointer.x - session().ghostOffset.x}px`,
            top: `${session().pointer.y - session().ghostOffset.y}px`,
            width: `${session().ghostSize.width}px`,
            height: `${session().ghostSize.height}px`,
          }}
        >
          <div
            class="border bg-neutral-900 px-2 py-1 text-xs text-neutral-100"
            classList={{
              "border-cyan-300": session().target.kind !== "none",
              "border-red-400": session().target.kind === "none",
            }}
          >
            {session().payload.label}
          </div>
        </div>
      </>
    )}
  </Show>
);
