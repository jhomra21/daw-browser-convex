import type { Component } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { omit } from "solid-js";

import * as ContextMenuPrimitive from "@kobalte/core/context-menu";

import { cn } from "~/lib/utils";

const ContextMenu: Component<ContextMenuPrimitive.ContextMenuRootProps> = (props) => (
  <ContextMenuPrimitive.Root gutter={4} {...props} />
);

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

type ContextMenuContentProps = ContextMenuPrimitive.ContextMenuContentProps & {
  class?: string | undefined;
  children?: JSX.Element;
};

const ContextMenuContent: Component<ContextMenuContentProps> = (props) => {
  const rest = omit(props, "class");

  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        class={cn(
          "z-50 min-w-32 max-h-(--kb-menu-content-available-height) overflow-y-auto overflow-x-hidden border border-border bg-app-surface p-0.5 text-xs text-foreground shadow-md shadow-background/40 outline-none",
          props.class,
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
  const rest = omit(props, "class", "inset");

  return (
    <ContextMenuPrimitive.Item
      class={cn(
        "relative flex min-h-6 cursor-default select-none items-center gap-2 whitespace-nowrap px-2 py-0.5 leading-5 text-foreground outline-none transition-colors focus:bg-muted focus:text-foreground data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:text-muted-foreground data-[disabled]:opacity-50 [&>svg]:size-3.5 [&>svg]:shrink-0",
        props.inset && "pl-6",
        props.class,
      )}
      {...rest}
    />
  );
};

const ContextMenuShortcut: Component<ComponentProps<"span">> = (props) => {
  const rest = omit(props, "class");

  return <span class={cn("ml-auto shrink-0 whitespace-nowrap pl-4 text-xxs tracking-wide opacity-60", props.class)} {...rest} />;
};

type ContextMenuLabelProps = ComponentProps<"div"> & {
  inset?: boolean;
  class?: string;
};

const ContextMenuLabel: Component<ContextMenuLabelProps> = (props) => {
  const rest = omit(props, "class", "inset");

  return (
    <div
      class={cn("px-2 py-1 text-xs font-semibold leading-5 text-foreground", props.inset && "pl-6", props.class)}
      {...rest}
    />
  );
};

type ContextMenuSeparatorProps = ContextMenuPrimitive.ContextMenuSeparatorProps & {
  class?: string | undefined;
};

const ContextMenuSeparator: Component<ContextMenuSeparatorProps> = (props) => {
  const rest = omit(props, "class");

  return (
    <ContextMenuPrimitive.Separator
      class={cn("-mx-0.5 my-0.5 h-px border-0 bg-muted", props.class)}
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
};
