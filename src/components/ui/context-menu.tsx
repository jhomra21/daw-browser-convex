import type { Component, ComponentProps, JSX } from "solid-js";
import { splitProps } from "solid-js";

import * as ContextMenuPrimitive from "@kobalte/core/context-menu";

import { cn } from "~/lib/utils";

const ContextMenu: Component<ContextMenuPrimitive.ContextMenuRootProps> = (props) => (
  <ContextMenuPrimitive.Root gutter={4} {...props} />
);
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuPortal = ContextMenuPrimitive.Portal;
const ContextMenuSub = ContextMenuPrimitive.Sub;
const ContextMenuGroup = ContextMenuPrimitive.Group;

type ContextMenuContentProps = ContextMenuPrimitive.ContextMenuContentProps & {
  class?: string | undefined;
  children?: JSX.Element;
};

const ContextMenuContent: Component<ContextMenuContentProps> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        class={cn(
          "z-50 min-w-32 max-h-(--kb-menu-content-available-height) overflow-y-auto overflow-x-hidden border border-neutral-800 bg-neutral-900 p-0.5 text-xs text-neutral-100 shadow-md shadow-black/40 outline-none",
          local.class,
        )}
        {...rest}
      />
    </ContextMenuPrimitive.Portal>
  );
};

type ContextMenuItemProps = ContextMenuPrimitive.ContextMenuItemProps & {
  class?: string | undefined;
  children?: JSX.Element;
  inset?: boolean;
};

const ContextMenuItem: Component<ContextMenuItemProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "inset"]);
  return (
    <ContextMenuPrimitive.Item
      class={cn(
        "relative flex min-h-6 cursor-default select-none items-center gap-2 px-2 py-0.5 leading-5 outline-none transition-colors focus:bg-neutral-800 focus:text-neutral-50 data-[disabled]:pointer-events-none data-[disabled]:text-neutral-500 [&>svg]:size-3.5 [&>svg]:shrink-0",
        local.inset && "pl-6",
        local.class,
      )}
      {...rest}
    />
  );
};

const ContextMenuShortcut: Component<ComponentProps<"span">> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return <span class={cn("ml-auto pl-4 text-[11px] tracking-wide text-neutral-400", local.class)} {...rest} />;
};

type ContextMenuLabelProps = ComponentProps<"div"> & {
  inset?: boolean;
  class?: string;
};

const ContextMenuLabel: Component<ContextMenuLabelProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "inset"]);
  return (
    <div
      class={cn("px-2 py-1 text-xs font-semibold leading-5 text-neutral-100", local.inset && "pl-6", local.class)}
      {...rest}
    />
  );
};

type ContextMenuSeparatorProps = ContextMenuPrimitive.ContextMenuSeparatorProps & {
  class?: string | undefined;
};

const ContextMenuSeparator: Component<ContextMenuSeparatorProps> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <ContextMenuPrimitive.Separator
      class={cn("-mx-0.5 my-0.5 h-px bg-neutral-800", local.class)}
      {...rest}
    />
  );
};

type ContextMenuSubTriggerProps = ContextMenuPrimitive.ContextMenuSubTriggerProps & {
  class?: string | undefined;
  children?: JSX.Element;
  inset?: boolean;
};

const ContextMenuSubTrigger: Component<ContextMenuSubTriggerProps> = (props) => {
  const [local, rest] = splitProps(props, ["class", "children", "inset"]);
  return (
    <ContextMenuPrimitive.SubTrigger
      class={cn(
        "flex min-h-6 cursor-default select-none items-center gap-2 px-2 py-0.5 text-xs leading-5 outline-none focus:bg-neutral-800 data-[expanded]:bg-neutral-800 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        local.inset && "pl-6",
        local.class,
      )}
      {...rest}
    >
      {local.children}
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="ml-auto size-3.5">
        <path d="M9 6l6 6l-6 6" />
      </svg>
    </ContextMenuPrimitive.SubTrigger>
  );
};

type ContextMenuSubContentProps = ContextMenuPrimitive.ContextMenuSubContentProps & {
  class?: string | undefined;
};

const ContextMenuSubContent: Component<ContextMenuSubContentProps> = (props) => {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <ContextMenuPrimitive.SubContent
      class={cn(
        "z-50 min-w-32 overflow-hidden border border-neutral-800 bg-neutral-900 p-0.5 text-xs text-neutral-100 shadow-md shadow-black/40",
        local.class,
      )}
      {...rest}
    />
  );
};

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuGroup,
};
