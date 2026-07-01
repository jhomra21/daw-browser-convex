import { For, Show, type Component, type JSX } from "solid-js";

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

export type TimelineContextMenuLabel = {
  kind: "label";
  label: string;
};

export type TimelineContextMenuSeparator = {
  kind: "separator";
};

export type TimelineContextMenuItem =
  | TimelineContextMenuAction
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
  const item = () => props.item;
  return (
    <>
      {(() => {
        const current = item();
        if (current.kind === "label") return <ContextMenuLabel>{current.label}</ContextMenuLabel>;
        if (current.kind === "separator") return <ContextMenuSeparator />;
        return (
          <ContextMenuItem
            disabled={current.disabled}
            onSelect={() => current.onSelect?.()}
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
