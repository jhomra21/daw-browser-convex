import { type Component, For, Show } from "solid-js";
import Icon from "~/components/ui/Icon";
import { MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator } from "~/components/ui/menubar";
import { cn } from "~/lib/utils";
import type { ExportsMenuController } from "~/hooks/useExportsMenuController";
import type { SamplesMenuController } from "~/hooks/useSamplesMenuController";
import { NativeMenuTrigger } from "./toolbar-context";

type ProjectMediaMenuProps = {
  samples: SamplesMenuController;
  exportsMenu: ExportsMenuController;
};

const stopMenuButtonEvent = (event: Event) => {
  event.stopPropagation();
  event.preventDefault();
};

const CopyUrlButton: Component<{
  label: string;
  url?: string;
  onCopy: (url?: string) => Promise<void>;
}> = (props) => (
  <button
    class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-50"
    aria-label={props.label}
    disabled={!props.url}
    onPointerDown={stopMenuButtonEvent}
    onPointerUp={stopMenuButtonEvent}
    onClick={async (event) => {
      stopMenuButtonEvent(event);
      await props.onCopy(props.url);
    }}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      class="h-4 w-4"
    >
      <g
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect width="8" height="8" x="8" y="8" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </g>
      <title>Copy URL</title>
    </svg>
  </button>
);

const InsertSampleButton: Component<{
  label: string;
  disabled: boolean;
  inserting: boolean;
  onInsert: () => Promise<void>;
}> = (props) => (
  <button
    class={cn(
      "cursor-pointer p-1 text-neutral-400 hover:text-neutral-100 disabled:opacity-50",
      props.inserting && "cursor-not-allowed opacity-60",
    )}
    aria-label={props.label}
    disabled={props.disabled || props.inserting}
    onPointerDown={stopMenuButtonEvent}
    onPointerUp={stopMenuButtonEvent}
    onClick={async (event) => {
      stopMenuButtonEvent(event);
      await props.onInsert();
    }}
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
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M4 11h16M12 4v16"
      />
      <title>Insert</title>
    </svg>
  </button>
);

export const ProjectMediaMenu: Component<ProjectMediaMenuProps> = (props) => {
  const samples = () => props.samples;
  const exportsMenu = () => props.exportsMenu;
  const hasProjectSamples = () => samples().samples().length > 0;
  const hasDefaultSamples = () => samples().defaultSamples().length > 0;
  const hasExports = () => exportsMenu().exports().length > 0;
  const hasMedia = () =>
    hasProjectSamples() || hasDefaultSamples() || hasExports();

  return (
    <MenubarMenu
      value="media"
      onOpenChange={(open) => {
        samples().onOpenChange(open);
        exportsMenu().onOpenChange(open);
      }}
    >
      <NativeMenuTrigger label="Media" />
      <MenubarContent
        class="w-full border-neutral-800 bg-neutral-900"
        style={{
          width: "min(92vw, 30rem)",
          "pointer-events": samples().isDraggingSample() ? "none" : undefined,
        }}
      >
        <div class="w-full p-2">
          <div class="flex items-center justify-between px-1 pb-2">
            <span class="text-sm font-semibold text-neutral-100">Media</span>
          </div>
          <MenubarSeparator />
          <div class="max-h-80 overflow-x-hidden overflow-y-auto">
            <Show
              when={hasMedia()}
              fallback={
                <div class="px-2 py-2 text-xs text-neutral-500">
                  No media yet
                </div>
              }
            >
              <Show when={hasProjectSamples()}>
                <div class="px-2 pb-2 pt-1 text-xs uppercase tracking-wide text-neutral-500">
                  Samples in Project
                </div>
                <For each={samples().samples()}>
                  {(sample) => {
                    const sampleKey = sample.key;
                    const isConfirming = () =>
                      samples().confirmingSampleKey() === sampleKey;
                    const isDeleting = () =>
                      samples().deletingSampleKey() === sampleKey;
                    const isInserting = () =>
                      samples().insertingSampleKey() === sampleKey;

                    return (
                      <MenubarItem
                        data-sample-key={sampleKey}
                        class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-20 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                        onSelect={() => {
                          if (sample.earliestClip) {
                            samples().onJumpToClip(
                              sample.earliestClip.clipId,
                              sample.earliestClip.trackId,
                              sample.earliestClip.startSec,
                            );
                          }
                        }}
                      >
                        <div
                          class="flex min-w-0 flex-1 items-center gap-2"
                          draggable={!!sample.url}
                          onDragStart={(event) =>
                            samples().onStartSampleDrag(event, sample)
                          }
                          onDragEnd={() => samples().setIsDraggingSample(false)}
                        >
                          <Icon
                            name="file-audio"
                            class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200"
                          />
                          <span
                            class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100"
                            title={sample.name}
                          >
                            {sample.name}
                          </span>
                          <span class="shrink-0 text-xs text-neutral-400">
                            x{sample.count}
                          </span>
                        </div>
                        <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                          <CopyUrlButton label="Copy sample URL" url={sample.url} onCopy={samples().copyText} />
                          <InsertSampleButton
                            label="Insert sample"
                            disabled={!sample.url}
                            inserting={isInserting()}
                            onInsert={() => samples().onInsertSample(sample)}
                          />
                          <Show
                            when={isConfirming()}
                            fallback={
                              <button
                                class={cn(
                                  "cursor-pointer p-1",
                                  sample.count > 0
                                    ? "cursor-not-allowed text-neutral-500 opacity-50"
                                    : "text-red-500 hover:text-red-400",
                                )}
                                aria-label={
                                  sample.count > 0
                                    ? "Cannot delete sample in use"
                                    : "Delete sample"
                                }
                                disabled={sample.count > 0}
                                onPointerDown={stopMenuButtonEvent}
                                onPointerUp={stopMenuButtonEvent}
                                onClick={(event) => {
                                  stopMenuButtonEvent(event);
                                  if (sample.count === 0) {
                                    samples().setConfirmingSampleKey(sampleKey);
                                  }
                                }}
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
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6m3 4v8m4-8v8"
                                  />
                                  <title>Delete</title>
                                </svg>
                              </button>
                            }
                          >
                            <div class="flex items-center gap-1">
                              <button
                                class={cn(
                                  "cursor-pointer p-1",
                                  isDeleting()
                                    ? "cursor-not-allowed text-neutral-400 opacity-60"
                                    : "text-green-500 hover:text-green-400",
                                )}
                                aria-label={
                                  isDeleting() ? "Deleting…" : "Confirm delete"
                                }
                                disabled={isDeleting()}
                                onPointerDown={stopMenuButtonEvent}
                                onPointerUp={stopMenuButtonEvent}
                                onClick={async (event) => {
                                  stopMenuButtonEvent(event);
                                  await samples().onDeleteSample(sample);
                                }}
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
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    d="m5 12l5 5L20 7"
                                  />
                                  <title>Confirm</title>
                                </svg>
                              </button>
                              <button
                                class="cursor-pointer p-1 text-neutral-400 hover:text-neutral-300"
                                aria-label="Cancel delete"
                                onPointerDown={stopMenuButtonEvent}
                                onPointerUp={stopMenuButtonEvent}
                                onClick={(event) => {
                                  stopMenuButtonEvent(event);
                                  samples().setConfirmingSampleKey(null);
                                }}
                              >
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 24 24"
                                  class="h-4 w-4"
                                >
                                  <path
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="m7 7l10 10M17 7L7 17"
                                  />
                                  <title>Cancel</title>
                                </svg>
                              </button>
                            </div>
                          </Show>
                        </div>
                      </MenubarItem>
                    );
                  }}
                </For>
              </Show>
              <Show when={hasDefaultSamples()}>
                <Show when={hasProjectSamples()}>
                  <MenubarSeparator class="my-2" />
                </Show>
                <div class="px-2 pb-2 pt-1 text-xs uppercase tracking-wide text-neutral-500">
                  Default Samples
                </div>
                <For each={samples().defaultSamples()}>
                  {(sample) => {
                    const isInserting = () =>
                      samples().insertingSampleKey() === sample.key;
                    const size = () => samples().formatBytes(sample.sizeBytes);

                    return (
                      <MenubarItem
                        data-sample-key={sample.key}
                        class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-16 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                      >
                        <div
                          class="flex min-w-0 flex-1 items-center gap-2"
                          draggable={!!sample.url}
                          onDragStart={(event) =>
                            samples().onStartSampleDrag(event, sample)
                          }
                          onDragEnd={() => samples().setIsDraggingSample(false)}
                        >
                          <Icon
                            name="file-audio"
                            class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200"
                          />
                          <span
                            class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100"
                            title={sample.name}
                          >
                            {sample.name}
                          </span>
                          <Show when={size()}>
                            <span class="shrink-0 text-xs text-neutral-400">
                              {size()}
                            </span>
                          </Show>
                        </div>
                        <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                          <CopyUrlButton label="Copy sample URL" url={sample.url} onCopy={samples().copyText} />
                          <InsertSampleButton
                            label="Insert default sample"
                            disabled={!sample.url}
                            inserting={isInserting()}
                            onInsert={() => samples().onInsertSample(sample)}
                          />
                        </div>
                      </MenubarItem>
                    );
                  }}
                </For>
              </Show>
              <Show when={hasExports()}>
                <Show when={hasProjectSamples() || hasDefaultSamples()}>
                  <MenubarSeparator class="my-2" />
                </Show>
                <div class="px-2 pb-2 pt-1 text-xs uppercase tracking-wide text-neutral-500">
                  Exports
                </div>
                <For each={exportsMenu().exports()}>
                  {(item) => (
                    <MenubarItem
                      class="group relative flex w-full cursor-pointer items-center justify-between gap-2 pr-12 hover:bg-neutral-800 hover:text-neutral-100 focus:bg-neutral-800 focus:text-neutral-100 data-[highlighted]:bg-neutral-800 data-[highlighted]:text-neutral-100"
                      onSelect={() => {
                        if (item.url) {
                          window.open(item.url, "_blank");
                        }
                      }}
                    >
                      <div class="flex min-w-0 flex-1 items-center gap-2">
                        <Icon
                          name="file-audio"
                          class="h-4 w-4 text-neutral-400 group-hover:text-neutral-200"
                        />
                        <span
                          class="max-w-48 truncate font-mono text-xs text-neutral-200 group-hover:text-neutral-100"
                          title={item.name}
                        >
                          {item.name}
                        </span>
                        <span class="shrink-0 text-xs uppercase text-neutral-400">
                          {item.format}
                        </span>
                      </div>
                      <div class="absolute right-2 top-1/2 -translate-y-1/2">
                        <CopyUrlButton label="Copy export URL" url={item.url} onCopy={exportsMenu().copyText} />
                      </div>
                    </MenubarItem>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </MenubarContent>
    </MenubarMenu>
  );
};
