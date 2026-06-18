import { type Component } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu } from "~/components/ui/menubar";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

export const FileMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="file">
      <NativeMenuTrigger label="File" />
      <MenubarContent class="w-56 border-neutral-800 bg-neutral-900">
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onAddAudio}
        >
          Add Audio...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().projectMenu.onOpenExport}
        >
          Export Mixdown...
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

