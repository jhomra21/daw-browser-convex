import { type Component } from "solid-js";
import Icon from "~/components/ui/Icon";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import type { DashboardView } from "~/components/dashboard/types";
import { cn } from "~/lib/utils";
import { NativeMenuTrigger } from "../toolbar-context";
import { nativeMenuItemClass } from "./menu-action-types";

type MediaMenuProps = {
  onOpenDashboard: (view: DashboardView) => void;
};

const mediaMenuItemClass = cn(nativeMenuItemClass, "flex w-full items-center gap-2");

export const MediaMenu: Component<MediaMenuProps> = (props) => {
  return (
    <MenubarMenu value="media">
      <NativeMenuTrigger label="Media" />
      <MenubarContent
        class="w-full border-neutral-800 bg-neutral-900"
        style={{ width: "min(92vw, 18rem)" }}
      >
        <div class="w-full p-2">
          <div class="flex items-center justify-between px-1 pb-2">
            <span class="text-sm font-semibold text-neutral-100">Media</span>
          </div>
          <MenubarSeparator />
          <div class="max-h-80 overflow-x-hidden overflow-y-auto">
            <MenubarItem
              class={mediaMenuItemClass}
              onSelect={() => props.onOpenDashboard("samples")}
            >
              <Icon name="file-audio" class="h-4 w-4 text-neutral-400" />
              <span class="text-xs text-neutral-200">Open samples dashboard</span>
            </MenubarItem>
            <MenubarItem
              class={mediaMenuItemClass}
              onSelect={() => props.onOpenDashboard("export")}
            >
              <Icon name="file-audio" class="h-4 w-4 text-neutral-400" />
              <span class="text-xs text-neutral-200">Open export dashboard</span>
            </MenubarItem>
          </div>
        </div>
      </MenubarContent>
    </MenubarMenu>
  );
};
