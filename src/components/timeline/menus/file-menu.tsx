import { isLocalId } from "@daw-browser/shared";
import { type Component, Show, createMemo } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

export const FileMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;
  const canExportArchive = () => isLocalId("project", toolbar().projectMenu.currentProjectId);
  const signedIn = createMemo(() => Boolean(toolbar().projectMenu.currentUserId));

  return (
    <MenubarMenu value="file">
      <NativeMenuTrigger label="File" />
      <MenubarContent class="border-border bg-popover">
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => void toolbar().projectMenu.onCreateProject()}
        >
          New Project
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => toolbar().projectMenu.onOpenDashboard("projects")}
        >
          Open Projects Dashboard
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => toolbar().projectMenu.onOpenDashboard("samples")}
        >
          Open Samples Dashboard
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => toolbar().projectMenu.onOpenDashboard("export")}
        >
          Open Export Dashboard
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onAddAudio}
        >
          Import Audio Files...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => void toolbar().projectMenu.onImportArchive()}
        >
          Import .dawproject...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          disabled={!canExportArchive()}
          onSelect={() => void toolbar().projectMenu.onExportArchive()}
        >
          Export .dawproject...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().projectMenu.onOpenExport}
        >
          Export Mixdown...
        </MenubarItem>
        <MenubarSeparator />
        <Show
          when={signedIn()}
          fallback={
            <MenubarItem class={nativeMenuItemClass} onSelect={toolbar().projectMenu.onSignIn}>
              Sign In
            </MenubarItem>
          }
        >
          <MenubarItem
            class={nativeMenuItemClass}
            onSelect={() => toolbar().projectMenu.onOpenDashboard("account")}
          >
            Account
          </MenubarItem>
          <MenubarItem class={nativeMenuItemClass} onSelect={() => void toolbar().projectMenu.onLogout()}>
            Logout
          </MenubarItem>
        </Show>
      </MenubarContent>
    </MenubarMenu>
  );
};
