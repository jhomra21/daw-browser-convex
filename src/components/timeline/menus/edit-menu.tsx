import { type Component } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu } from "~/components/ui/menubar";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

export const EditMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="edit">
      <NativeMenuTrigger label="Edit" />
      <MenubarContent class="w-44 border-neutral-800 bg-neutral-900">
        <MenubarItem class={nativeMenuItemClass} onSelect={toolbar().onUndo}>
          Undo
        </MenubarItem>
        <MenubarItem class={nativeMenuItemClass} onSelect={toolbar().onRedo}>
          Redo
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

