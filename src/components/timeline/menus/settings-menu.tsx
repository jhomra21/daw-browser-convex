import type { Component } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "~/hooks/transport-types";
import { runUserCommand } from "~/hooks/user-commands";
import { nativeMenuItemClass } from "./menu-action-types";

export const SettingsMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="settings">
      <NativeMenuTrigger label="Settings" />
      <MenubarContent class="border-border bg-popover">
        <MenubarItem class={nativeMenuItemClass} onSelect={() => runUserCommand("open-general-settings", toolbar())}>
          Dashboard settings
        </MenubarItem>
        <MenubarItem class={nativeMenuItemClass} onSelect={() => runUserCommand("open-timeline-settings", toolbar())}>
          Timeline / DAW dashboard
        </MenubarItem>
        <MenubarItem class={nativeMenuItemClass} onSelect={() => runUserCommand("open-audio-settings", toolbar())}>
          Audio settings
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem class={nativeMenuItemClass} onSelect={() => runUserCommand("about", toolbar())}>
          About
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};
