import { type Component, For, Show } from "solid-js";
import { Button } from "~/components/ui/button";
import { MenubarContent, MenubarItem, MenubarMenu } from "~/components/ui/menubar";
import { cn } from "~/lib/utils";
import { NativeMenuTrigger } from "../toolbar-context";

type ShareMenuController = {
  onOpenChange: (open: boolean) => void;
  onOpen: () => Promise<void>;
  onClose: () => void;
  copied: boolean;
  shareUrl: string;
  shareError: string;
  members: Array<{ userId: string; role: "editor" | "viewer" }>;
  membersLoading: boolean;
  membersError: string;
  revokingMemberId: string;
  onCopy: () => Promise<void>;
  onRevokeMember: (userId: string) => Promise<void>;
};

export const ShareMenu: Component<{ share: ShareMenuController }> = (props) => {
  const share = () => props.share;

  return (
    <MenubarMenu
      value="share"
      onOpenChange={(open) => {
        if (open) {
          void share().onOpen();
        } else {
          share().onOpenChange(false);
        }
      }}
    >
      <NativeMenuTrigger label="Share" />
      <MenubarContent
        class="w-full border-neutral-800 bg-neutral-900"
        style={{ width: "min(92vw, 24rem)" }}
      >
        <div class="w-full p-3">
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-neutral-200">
                Share this room
              </span>
            </div>
            <MenubarItem
              class="p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
              aria-label="Close"
              onSelect={share().onClose}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                class="h-4 w-4"
              >
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  d="m7 7l10 10M17 7L7 17"
                />
                <title>Close</title>
              </svg>
            </MenubarItem>
          </div>
          <div class="flex w-full items-center gap-2">
            <div class="min-w-0 w-full max-w-full border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 shadow-inner">
              <div
                class="font-mono"
                style={{
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                  "white-space": "nowrap",
                }}
              >
                {share().shareUrl}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={share().copied ? "Copied" : "Copy URL"}
              class={cn(
                "shrink-0",
                share().copied ? "text-green-500" : "text-neutral-400",
              )}
              onClick={() => void share().onCopy()}
            >
              <Show
                when={share().copied}
                fallback={
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    class="h-4 w-4"
                  >
                    <g
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <rect width="8" height="8" x="8" y="8" />
                      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                    </g>
                    <title>Copy</title>
                  </svg>
                }
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  class="h-4 w-4"
                >
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    d="m5 12l5 5L20 7"
                  />
                  <title>Copied</title>
                </svg>
              </Show>
            </Button>
          </div>
          <Show when={share().shareError}>
            <div class="mt-2 text-xs text-red-300">
              {share().shareError}
            </div>
          </Show>
          <div class="mt-4 border-t border-neutral-800 pt-3">
            <div class="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Members
            </div>
            <Show
              when={!share().membersLoading}
              fallback={<div class="text-xs text-neutral-500">Loading members...</div>}
            >
              <Show
                when={share().members.length > 0}
                fallback={<div class="text-xs text-neutral-500">No accepted members yet.</div>}
              >
                <div class="space-y-2">
                  <For each={share().members}>
                    {(member) => (
                      <div class="flex items-center justify-between gap-3 border border-neutral-800 bg-neutral-950/60 px-3 py-2">
                        <div class="min-w-0">
                          <div class="truncate text-xs text-neutral-200">{member.userId}</div>
                          <div class="text-[11px] capitalize text-neutral-500">{member.role}</div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="shrink-0 text-red-300 hover:bg-red-950/40 hover:text-red-200"
                          disabled={share().revokingMemberId === member.userId}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            void share().onRevokeMember(member.userId);
                          }}
                        >
                          {share().revokingMemberId === member.userId ? "Removing..." : "Remove"}
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={share().membersError}>
              <div class="mt-2 text-xs text-red-300">
                {share().membersError}
              </div>
            </Show>
          </div>
        </div>
      </MenubarContent>
    </MenubarMenu>
  );
};

