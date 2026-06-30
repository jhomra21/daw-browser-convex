import type { ComponentProps, JSX } from "solid-js";
import { mergeProps, splitProps } from "solid-js";
import {
  Tooltip as TooltipPrimitive,
  type TooltipContentProps as KobalteTooltipContentProps,
  type TooltipRootProps,
} from "@kobalte/core/tooltip";

import { cn } from "~/lib/utils";

type TooltipProps = TooltipRootProps;

const Tooltip = (props: TooltipProps) => {
  const merged = mergeProps<TooltipProps[]>(
    {
      closeDelay: 0,
      openDelay: 250,
      placement: "top",
      gutter: 6,
    },
    props,
  );

  return <TooltipPrimitive {...merged} />;
};

const TooltipTrigger = TooltipPrimitive.Trigger;

type TooltipContentProps = KobalteTooltipContentProps<"div"> & ComponentProps<"div"> & {
  class?: string;
  children?: JSX.Element;
};

const TooltipContent = (props: TooltipContentProps) => {
  const [local, rest] = splitProps(props, ["class", "children"]);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        class={cn(
          "z-50 flex w-fit items-center rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 shadow-md",
          local.class,
        )}
        {...rest}
      >
        {local.children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
};

export { Tooltip, TooltipContent, TooltipTrigger };
