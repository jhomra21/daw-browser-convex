import { Link } from "@tanstack/solid-router";
import { type Component, For } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { cn } from "~/lib/utils";
import { gridDenominators } from "../grid-options";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

export const SettingsMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="settings">
      <NativeMenuTrigger label="Settings" />
      <MenubarContent class="w-56 border-neutral-800 bg-neutral-900">
        <MenubarItem class={nativeMenuItemClass} onSelect={() => toolbar().projectMenu.onOpenDashboard("general")}>
          Dashboard settings
        </MenubarItem>
        <MenubarItem class={nativeMenuItemClass} onSelect={() => toolbar().projectMenu.onOpenDashboard("timeline")}>
          Timeline / DAW dashboard
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onToggleMetronome}
        >
          {toolbar().metronomeEnabled ? "Disable" : "Enable"} Metronome
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onToggleLoop}
        >
          {toolbar().loopEnabled ? "Disable" : "Enable"} Loop
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onToggleGrid}
        >
          {toolbar().gridEnabled ? "Disable" : "Enable"} Grid
        </MenubarItem>
        <MenubarSeparator />
        <div class="px-2 pb-1 pt-1 text-xs text-neutral-500">
          Grid Resolution
        </div>
        <For each={gridDenominators}>
          {(denominator) => (
            <MenubarItem
              class={cn(
                nativeMenuItemClass,
                toolbar().gridDenominator === denominator && "text-green-400",
              )}
              onSelect={() => toolbar().onChangeGridDenominator(denominator)}
            >
              1/{denominator}
            </MenubarItem>
          )}
        </For>
        <MenubarSeparator />
        <MenubarItem as={Link} to="/about" class={nativeMenuItemClass}>
          About
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

