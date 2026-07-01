import { type Component } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut } from "~/components/ui/menubar";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

export const EditMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="edit">
      <NativeMenuTrigger label="Edit" />
      <MenubarContent class="border-neutral-800 bg-neutral-900">
        <MenubarItem class={nativeMenuItemClass} onSelect={toolbar().onUndo}>
          <span>Undo</span>
          <MenubarShortcut>Ctrl/Cmd + Z</MenubarShortcut>
        </MenubarItem>
        <MenubarItem class={nativeMenuItemClass} onSelect={toolbar().onRedo}>
          <span>Redo</span>
          <MenubarShortcut>Ctrl/Cmd + Y</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onDuplicateSelection}
        >
          <span>Duplicate</span>
          <MenubarShortcut>Ctrl/Cmd + D</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onDeleteSelection}
        >
          <span>Delete</span>
          <MenubarShortcut>Delete</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => toolbar().projectMenu.onOpenDashboard("keyboard")}
        >
          Keyboard Shortcuts
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};
