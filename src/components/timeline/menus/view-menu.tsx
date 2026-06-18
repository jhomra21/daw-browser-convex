import { For, type Component } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut } from "~/components/ui/menubar";
import { timelineBrowserTabLabels, timelineBrowserTabs } from "~/lib/timeline-left-browser-preferences";
import { cn } from "~/lib/utils";
import { gridDenominators } from "../grid-options";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { MenuCheckMark } from "./menu-check-mark";
import { nativeMenuItemClass } from "./menu-action-types";

type ViewMenuProps = {
  toolbar: TransportControlsProps;
};

const viewMenuItemClass = cn(nativeMenuItemClass, "flex w-full items-center gap-2");

export const ViewMenu: Component<ViewMenuProps> = (props) => {
  const toolbar = () => props.toolbar;

  return (
    <MenubarMenu value="view">
      <NativeMenuTrigger label="View" />
      <MenubarContent class="w-64 border-neutral-800 bg-neutral-900">
        <MenubarItem class={viewMenuItemClass} onSelect={toolbar().browser.onToggle}>
          <MenuCheckMark checked={toolbar().browser.open} />
          <span>{toolbar().browser.open ? "Hide Browser" : "Show Browser"}</span>
          <MenubarShortcut>Ctrl/Cmd + Alt + B</MenubarShortcut>
        </MenubarItem>
        <MenubarSeparator />
        <For each={timelineBrowserTabs}>
          {(tab) => (
            <MenubarItem class={viewMenuItemClass} onSelect={() => toolbar().browser.onSelectTab(tab)}>
              <span class="w-4" />
              <span>{timelineBrowserTabLabels[tab]} Browser</span>
            </MenubarItem>
          )}
        </For>
        <MenubarSeparator />
        <MenubarItem class={viewMenuItemClass} onSelect={toolbar().onToggleMetronome}>
          <MenuCheckMark checked={toolbar().metronomeEnabled} />
          <span>Metronome</span>
        </MenubarItem>
        <MenubarItem class={viewMenuItemClass} onSelect={toolbar().onToggleLoop}>
          <MenuCheckMark checked={toolbar().loopEnabled} />
          <span>Loop</span>
        </MenubarItem>
        <MenubarItem class={viewMenuItemClass} onSelect={toolbar().onToggleGrid}>
          <MenuCheckMark checked={toolbar().gridEnabled} />
          <span>Grid</span>
        </MenubarItem>
        <MenubarSeparator />
        <div class="px-2 pb-1 pt-1 text-xs text-neutral-500">
          Grid Resolution
        </div>
        <For each={gridDenominators}>
          {(denominator) => (
            <MenubarItem
              class={cn(
                viewMenuItemClass,
                toolbar().gridDenominator === denominator && "text-green-400",
              )}
              onSelect={() => toolbar().onChangeGridDenominator(denominator)}
            >
              <MenuCheckMark checked={toolbar().gridDenominator === denominator} />
              <span>1/{denominator}</span>
            </MenubarItem>
          )}
        </For>
      </MenubarContent>
    </MenubarMenu>
  );
};
