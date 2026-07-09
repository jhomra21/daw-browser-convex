import { For, Show, type Component, type JSX } from "solid-js";

import { colorInputValue } from "~/lib/color";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";

export type TimelineContextMenuAction = {
  kind: "item";
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect?: () => void;
};

export type TimelineContextMenuColor = {
  kind: "color";
  label: string;
  value: string;
  onChange: (color: string) => void;
};

export type TimelineContextMenuLabel = {
  kind: "label";
  label: string;
};

export type TimelineContextMenuSeparator = {
  kind: "separator";
};

export type TimelineContextMenuItem =
  | TimelineContextMenuAction
  | TimelineContextMenuColor
  | TimelineContextMenuLabel
  | TimelineContextMenuSeparator;

type TimelineContextMenuProps = {
  children: JSX.Element;
  items: () => TimelineContextMenuItem[];
  onOpenChange?: (open: boolean) => void;
};

const shouldPreserveNativeContextMenu = (target: EventTarget | null) => (
  target instanceof Element &&
  Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"))
);

const TimelineContextMenuEntry: Component<{ item: TimelineContextMenuItem }> = (props) => {
  return (
    <>
      {(() => {
        const current = props.item;
        if (current.kind === "label") return <ContextMenuLabel>{current.label}</ContextMenuLabel>;
        if (current.kind === "separator") return <ContextMenuSeparator />;
        if (current.kind === "color") {
          return (
            <div class="flex min-h-6 items-center gap-2 px-2 py-0.5 leading-5 text-foreground">
              <span class="min-w-0 flex-1 truncate">{current.label}</span>
              <input
                type="color"
                value={colorInputValue(current.value, "#000000")}
                class="h-5 w-8 cursor-pointer border border-border bg-app-surface p-0"
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                onChange={(event) => current.onChange(event.currentTarget.value)}
              />
            </div>
          );
        }
        return (
          <ContextMenuItem
            disabled={current.disabled}
            onSelect={() => {
              const action = current.onSelect;
              queueMicrotask(() => action?.());
            }}
          >
            <span class="min-w-0 flex-1 truncate">{current.label}</span>
            <Show when={current.shortcut}>
              {(shortcut) => <ContextMenuShortcut>{shortcut()}</ContextMenuShortcut>}
            </Show>
          </ContextMenuItem>
        );
      })()}
    </>
  );
};

const TimelineContextMenu: Component<TimelineContextMenuProps> = (props) => {
  return (
    <ContextMenu
      onOpenChange={props.onOpenChange}
    >
      <ContextMenuTrigger class="contents" onContextMenu={(event) => event.stopPropagation()}>
        <div
          class="contents"
          on:contextmenu={(event) => {
            if (shouldPreserveNativeContextMenu(event.target)) event.stopPropagation();
          }}
        >
          {props.children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent class="min-w-40">
        <For each={props.items()}>
          {(item) => <TimelineContextMenuEntry item={item} />}
        </For>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export default TimelineContextMenu;
