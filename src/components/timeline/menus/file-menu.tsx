import { isLocalId } from "@daw-browser/shared";
import { type Component, Show, createMemo } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "~/hooks/transport-types";
import { runUserCommand } from "~/hooks/user-commands";
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
          onSelect={() => runUserCommand("new-project", toolbar())}
        >
          New Project
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => runUserCommand("open-projects-dashboard", toolbar())}
        >
          Open Projects Dashboard
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => runUserCommand("open-samples-dashboard", toolbar())}
        >
          Open Samples Dashboard
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => runUserCommand("open-export-dashboard", toolbar())}
        >
          Open Export Dashboard
        </MenubarItem>
        <MenubarSeparator />
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => runUserCommand("import-audio", toolbar())}
        >
          Import Audio Files...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => runUserCommand("import-archive", toolbar())}
        >
          Import .dawproject...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          disabled={!canExportArchive()}
          onSelect={() => runUserCommand("export-archive", toolbar())}
        >
          Export .dawproject...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => runUserCommand("export-mixdown", toolbar())}
        >
          Export Mixdown...
        </MenubarItem>
        <MenubarSeparator />
        <Show
          when={signedIn()}
          fallback={
            <MenubarItem class={nativeMenuItemClass} onSelect={() => runUserCommand("sign-in", toolbar())}>
              Sign In
            </MenubarItem>
          }
        >
          <MenubarItem
            class={nativeMenuItemClass}
            onSelect={() => runUserCommand("open-account-dashboard", toolbar())}
          >
            Account
          </MenubarItem>
          <MenubarItem class={nativeMenuItemClass} onSelect={() => runUserCommand("logout", toolbar())}>
            Logout
          </MenubarItem>
        </Show>
      </MenubarContent>
    </MenubarMenu>
  );
};
