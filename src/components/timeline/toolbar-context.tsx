import type { Component } from "solid-js";
import { MenubarTrigger } from "~/components/ui/menubar";
import { cn } from "~/lib/utils";

type NativeMenuTriggerProps = {
  label: string;
};

export const nativeMenuTriggerClass =
  "h-7 px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground";

export const NativeMenuTrigger: Component<NativeMenuTriggerProps> = (props) => (
  <MenubarTrigger
    class={cn(
      nativeMenuTriggerClass,
      "data-[expanded]:bg-muted data-[expanded]:text-foreground",
    )}
  >
    {props.label}
  </MenubarTrigger>
);
