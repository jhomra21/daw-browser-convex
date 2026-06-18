import { type Component } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut } from "~/components/ui/menubar";
import { cn } from "~/lib/utils";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

export const TracksMenu: Component<{ tracksMenu: TransportControlsProps["tracksMenu"] }> = (props) => {
  const tracksMenu = () => props.tracksMenu;

  return (
    <MenubarMenu value="tracks">
      <NativeMenuTrigger label="Tracks" />
      <MenubarContent class="w-64 border-neutral-800 bg-neutral-900">
        <MenubarItem
          class={cn(nativeMenuItemClass, tracksMenu().syncMix && "text-blue-300")}
          onSelect={tracksMenu().onToggleSyncMix}
        >
          Sync Mix
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem class={nativeMenuItemClass} onSelect={tracksMenu().onAddTrack}>
          <span>Add Track</span>
          <MenubarShortcut>Shift + T</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={tracksMenu().onAddReturnTrack}
        >
          <span>Return</span>
          <MenubarShortcut>Shift + R</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={tracksMenu().onAddGroupTrack}
        >
          <span>Group</span>
          <MenubarShortcut>Shift + G</MenubarShortcut>
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={tracksMenu().onAddInstrumentTrack}
        >
          <span>Instrument</span>
          <MenubarShortcut>Ctrl/Cmd + Shift + T</MenubarShortcut>
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

