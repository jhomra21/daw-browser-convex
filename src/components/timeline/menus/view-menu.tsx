import { For, type Component } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { timelineBrowserTabLabels, timelineBrowserTabs } from "~/lib/timeline-left-browser-preferences";
import { cn } from "~/lib/utils";
import { gridDenominators } from "../grid-options";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "~/hooks/transport-types";
import { MenuCheckMark } from "./menu-check-mark";
import { runUserCommand } from "~/hooks/user-commands";
import { nativeMenuItemClass } from "./menu-action-types";

type ViewMenuProps = {
  toolbar: TransportControlsProps;
};

const viewMenuItemClass = cn(nativeMenuItemClass, "flex w-full items-center gap-2");

export const ViewMenu: Component<ViewMenuProps> = (props) => {
  const toolbar = () => props.toolbar;

  const selectBrowserTab = (tab: (typeof timelineBrowserTabs)[number]) => {
    toolbar().browser.onSelectTab(tab);
    toolbar().browser.onOpen();
  };

  return (
    <MenubarMenu value="view">
      <NativeMenuTrigger label="View" />
      <MenubarContent class="border-border bg-popover">
        <For each={timelineBrowserTabs}>
          {(tab) => (
            <MenubarItem class={viewMenuItemClass} onSelect={() => selectBrowserTab(tab)}>
              <span class="w-4" />
              <span>{timelineBrowserTabLabels[tab]} Browser</span>
            </MenubarItem>
          )}
        </For>
        <MenubarSeparator />
        <MenubarItem class={viewMenuItemClass} onSelect={() => runUserCommand("toggle-metronome", toolbar())}>
          <MenuCheckMark checked={toolbar().metronomeEnabled} />
          <span>Metronome</span>
        </MenubarItem>
        <MenubarItem class={viewMenuItemClass} onSelect={() => runUserCommand("toggle-loop", toolbar())}>
          <MenuCheckMark checked={toolbar().loopEnabled} />
          <span>Loop</span>
        </MenubarItem>
        <MenubarItem class={viewMenuItemClass} onSelect={() => runUserCommand("toggle-grid", toolbar())}>
          <MenuCheckMark checked={toolbar().gridEnabled} />
          <span>Grid</span>
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem class={viewMenuItemClass} onSelect={() => runUserCommand("zoom-in", toolbar())}>
          <span class="w-4" />
          <span>Zoom In</span>
        </MenubarItem>
        <MenubarItem class={viewMenuItemClass} onSelect={() => runUserCommand("zoom-out", toolbar())}>
          <span class="w-4" />
          <span>Zoom Out</span>
        </MenubarItem>
        <MenubarItem class={viewMenuItemClass} onSelect={() => runUserCommand("zoom-to-fit", toolbar())}>
          <span class="w-4" />
          <span>Zoom to Fit</span>
        </MenubarItem>
        <MenubarSeparator />
        <div class="px-2 pb-1 pt-1 text-xs text-muted-foreground">
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
