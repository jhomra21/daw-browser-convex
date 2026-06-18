import { createEffect, createMemo, For, onMount, Show, type Component } from "solid-js";
import type { TimelineBrowserTab, TimelineLeftBrowserModel } from "./browser-types";
import { timelineBrowserTabLabels, timelineBrowserTabs } from "~/lib/timeline-left-browser-preferences";
import { cn } from "~/lib/utils";

const tabPlaceholder: Record<TimelineBrowserTab, string> = {
  assets: "",
  effects: "No effects match this search.",
  "midi-instruments": "No MIDI instruments match this search.",
};

export const TimelineLeftBrowser: Component<{ browser: TimelineLeftBrowserModel }> = (props) => {
  let scrollRef: HTMLDivElement | undefined;
  const visibleDevices = createMemo(() => {
    if (props.browser.activeTab === "effects") return props.browser.devices.effects();
    if (props.browser.activeTab === "midi-instruments") return props.browser.devices.instruments();
    return [];
  });

  const restoreScrollTop = () => {
    if (!scrollRef) return;
    scrollRef.scrollTop = props.browser.scrollTopByTab[props.browser.activeTab] ?? 0;
  };

  onMount(restoreScrollTop);
  createEffect(restoreScrollTop);

  return (
    <aside
      class="relative flex h-full shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 text-neutral-200"
      data-timeline-left-browser="1"
      style={{
        width: `${props.browser.widthPx}px`,
        display: props.browser.open ? undefined : "none",
      }}
    >
      <div class="border-b border-neutral-800 p-2">
        <div class="grid grid-cols-1 gap-1">
          <For each={timelineBrowserTabs}>
            {(tab) => (
              <button
                type="button"
                class={cn(
                  "rounded px-2 py-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100",
                  props.browser.activeTab === tab && "bg-neutral-900 text-neutral-100",
                )}
                aria-pressed={props.browser.activeTab === tab}
                onClick={() => props.browser.onSelectTab(tab)}
              >
                {timelineBrowserTabLabels[tab]}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="border-b border-neutral-800">
        <input
          type="search"
          value={props.browser.searchQueryByTab[props.browser.activeTab]}
          placeholder={`Search ${timelineBrowserTabLabels[props.browser.activeTab].toLowerCase()}`}
          class="h-12 w-full bg-transparent px-4 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:bg-neutral-900/60"
          onInput={(event) => props.browser.onSearchQueryChange(props.browser.activeTab, event.currentTarget.value)}
        />
      </div>

      <div
        ref={(el) => {
          scrollRef = el;
        }}
        class="min-h-0 flex-1 overflow-y-auto p-3"
        onScroll={(event) => props.browser.onScrollTopChange(props.browser.activeTab, event.currentTarget.scrollTop)}
      >
        <Show
          when={props.browser.activeTab === "assets"}
          fallback={(
            <div class="space-y-1">
              <Show
                when={visibleDevices().length > 0}
                fallback={(
                  <div class="rounded border border-dashed border-neutral-800 bg-neutral-900/40 p-3 text-xs leading-5 text-neutral-500">
                    {tabPlaceholder[props.browser.activeTab]}
                  </div>
                )}
              >
                <For each={visibleDevices()}>
                  {(item) => (
                    <button
                      type="button"
                      disabled={item.disabled}
                      class="group flex w-full items-center justify-between gap-2 rounded border border-transparent px-2 py-1.5 text-left text-xs hover:border-neutral-800 hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => {
                        if (props.browser.activeTab === "effects") {
                          props.browser.devices.onAddEffect(item.id);
                          return;
                        }
                        props.browser.devices.onAddInstrument(item.id);
                      }}
                    >
                      <span class="min-w-0">
                        <span class="block truncate text-neutral-200 group-hover:text-neutral-50">{item.label}</span>
                        <span class="block truncate text-[11px] text-neutral-500">{item.subtitle}</span>
                      </span>
                      <span class="shrink-0 rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                        {item.source}
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          )}
        >
          <div class="space-y-1">
            <Show
              when={props.browser.assets.items().length > 0}
              fallback={(
                <div class="rounded border border-dashed border-neutral-800 bg-neutral-900/40 p-3 text-xs leading-5 text-neutral-500">
                  No samples match this search.
                </div>
              )}
            >
              <For each={props.browser.assets.items()}>
                {(item) => (
                  <button
                    type="button"
                    draggable={!item.disabled}
                    disabled={item.disabled}
                    class="group flex w-full items-center justify-between gap-2 rounded border border-transparent px-2 py-1.5 text-left text-xs hover:border-neutral-800 hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => props.browser.assets.onInsert(item.id)}
                    onDragStart={(event) => props.browser.assets.onDragStart(event, item.id)}
                  >
                    <span class="min-w-0">
                      <span class="block truncate text-neutral-200 group-hover:text-neutral-50">{item.label}</span>
                      <span class="block truncate text-[11px] text-neutral-500">{item.subtitle}</span>
                    </span>
                    <span class="shrink-0 rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                      {item.source}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>

      <button
        type="button"
        aria-label="Resize browser"
        class="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-transparent hover:bg-sky-500/20"
        onPointerDown={props.browser.onResizePointerDown}
      />
    </aside>
  );
};
