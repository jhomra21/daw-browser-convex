import { Link } from "@tanstack/solid-router";
import type { Component } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

export const SettingsMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="settings">
      <NativeMenuTrigger label="Settings" />
      <MenubarContent class="border-border bg-popover">
        <MenubarItem class={nativeMenuItemClass} onSelect={() => toolbar().projectMenu.onOpenDashboard("general")}>
          Dashboard settings
        </MenubarItem>
        <MenubarItem class={nativeMenuItemClass} onSelect={() => toolbar().projectMenu.onOpenDashboard("timeline")}>
          Timeline / DAW dashboard
        </MenubarItem>
        <MenubarItem class={nativeMenuItemClass} onSelect={() => toolbar().projectMenu.onOpenDashboard("audio")}>
          Audio settings
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem as={Link} to="/about" class={nativeMenuItemClass}>
          About
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};
