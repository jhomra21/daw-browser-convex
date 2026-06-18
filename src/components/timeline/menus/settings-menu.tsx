import { Link, useNavigate } from "@tanstack/solid-router";
import { type Component, For, Show, createMemo } from "solid-js";
import { MenubarContent, MenubarItem, MenubarLabel, MenubarMenu, MenubarPortal, MenubarSeparator, MenubarShortcut, MenubarSub, MenubarSubContent, MenubarSubTrigger } from "~/components/ui/menubar";
import { timelineKeyboardShortcuts } from "~/components/dashboard/shortcut-registry";
import { authClient } from "~/lib/auth-client";
import { queryClient } from "~/lib/query-client";
import { useSessionQuery } from "~/lib/session";
import { cn } from "~/lib/utils";
import { gridDenominators } from "../grid-options";
import { NativeMenuTrigger } from "../toolbar-context";
import type { TransportControlsProps } from "../transport-types";
import { nativeMenuItemClass } from "./menu-action-types";

const ShortcutsSubMenu: Component<{ onOpenDashboard: () => void }> = (props) => (
  <MenubarSub>
    <MenubarSubTrigger class={nativeMenuItemClass}>Shortcuts</MenubarSubTrigger>
    <MenubarPortal>
      <MenubarSubContent
        class="border-neutral-800 bg-neutral-900 text-neutral-100"
        style={{ width: "min(92vw, 22rem)" }}
      >
        <MenubarLabel class="text-neutral-400">Timeline</MenubarLabel>
        <For each={timelineKeyboardShortcuts}>
          {(shortcut) => (
            <MenubarItem disabled>
              {shortcut.label}
              <MenubarShortcut>{shortcut.keys}</MenubarShortcut>
            </MenubarItem>
          )}
        </For>
        <MenubarSeparator />
        <MenubarItem class={nativeMenuItemClass} onSelect={props.onOpenDashboard}>
          Open shortcuts dashboard
        </MenubarItem>
        <MenubarSeparator />
        <MenubarLabel class="text-neutral-400">
          MIDI Editor (when keyboard enabled)
        </MenubarLabel>
        <MenubarItem disabled>
          Note keys
          <MenubarShortcut>A S D F G H J K L ;</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Sharp keys
          <MenubarShortcut>W E T Y U O P</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Octave down
          <MenubarShortcut>Z</MenubarShortcut>
        </MenubarItem>
        <MenubarItem disabled>
          Octave up
          <MenubarShortcut>X</MenubarShortcut>
        </MenubarItem>
      </MenubarSubContent>
    </MenubarPortal>
  </MenubarSub>
);

export const SettingsMenu: Component<{ toolbar: TransportControlsProps }> = (props) => {
  const toolbar = () => props.toolbar;
  const navigate = useNavigate();
  const session = useSessionQuery();
  const user = createMemo(() => session.data?.user);

  const handleSignOut = async () => {
    try {
      await authClient.signOut();
    } finally {
      queryClient.setQueryData(["session"], null);
      navigate({ to: "/Login" });
    }
  };

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
        <ShortcutsSubMenu onOpenDashboard={() => toolbar().projectMenu.onOpenDashboard("keyboard")} />
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
        <Show
          when={user()?.email}
          fallback={
            <MenubarItem as={Link} to="/Login" class={nativeMenuItemClass}>
              Sign in
            </MenubarItem>
          }
        >
          <MenubarItem as={Link} to="/Login" class={nativeMenuItemClass}>
            Account
          </MenubarItem>
          <MenubarItem class={nativeMenuItemClass} onSelect={handleSignOut}>
            Logout
          </MenubarItem>
        </Show>
        <MenubarItem as={Link} to="/about" class={nativeMenuItemClass}>
          About
        </MenubarItem>
      </MenubarContent>
    </MenubarMenu>
  );
};

