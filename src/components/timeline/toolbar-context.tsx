import { type Component } from "solid-js";
import { MenubarTrigger } from "~/components/ui/menubar";
import { cn } from "~/lib/utils";

type NativeMenuTriggerProps = {
  label: string;
};

export const nativeMenuTriggerClass =
  "h-7 px-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100";

export const NativeMenuTrigger: Component<NativeMenuTriggerProps> = (props) => (
  <MenubarTrigger
    class={cn(
      nativeMenuTriggerClass,
      "data-[expanded]:bg-neutral-800 data-[expanded]:text-neutral-100",
    )}
  >
    {props.label}
  </MenubarTrigger>
);
