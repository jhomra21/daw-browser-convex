import { Link, useNavigate } from "@tanstack/solid-router";
import { isLocalId } from "@daw-browser/shared";
import { type Component, Show, createMemo } from "solid-js";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { authClient } from "~/lib/auth-client";
import { queryClient } from "~/lib/query-client";
import { useSessionQuery } from "~/lib/session";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

export const FileMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;
  const navigate = useNavigate();
  const session = useSessionQuery();
  const user = createMemo(() => session.data?.user);
  const canExportArchive = () => isLocalId("project", toolbar().projectMenu.currentProjectId);

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
    } finally {
      queryClient.setQueryData(["session"], null);
      navigate({ to: "/Login" });
    }
  };

  return (
    <MenubarMenu value="file">
      <NativeMenuTrigger label="File" />
      <MenubarContent class="w-64 border-neutral-800 bg-neutral-900">
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
        <MenubarSeparator />
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={toolbar().onAddAudio}
        >
          Import Audio Files...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          onSelect={() => void toolbar().projectMenu.onImportArchive?.()}
        >
          Import .dawproject...
        </MenubarItem>
        <MenubarItem
          class={nativeMenuItemClass}
          disabled={!canExportArchive()}
          onSelect={() => void toolbar().projectMenu.onExportArchive?.()}
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
          when={user()?.email}
          fallback={
            <MenubarItem as={Link} to="/Login" class={nativeMenuItemClass}>
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
          <MenubarItem class={nativeMenuItemClass} onSelect={handleSignOut}>
            Logout
          </MenubarItem>
        </Show>
      </MenubarContent>
    </MenubarMenu>
  );
};

