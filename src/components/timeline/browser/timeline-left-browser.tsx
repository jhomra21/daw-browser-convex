import { createEffect, For, onMount, type Component } from "solid-js";
import type { TimelineBrowserTab, TimelineLeftBrowserModel } from "./browser-types";
import { timelineBrowserTabLabels, timelineBrowserTabs } from "~/lib/timeline-left-browser-preferences";
import { cn } from "~/lib/utils";

const tabPlaceholder: Record<TimelineBrowserTab, string> = {
  assets: "Asset browsing arrives in Phase 3.",
  effects: "Effect rows arrive in Phase 4.",
  "midi-instruments": "MIDI instrument rows arrive in Phase 4.",
};

export const TimelineLeftBrowser: Component<{ browser: TimelineLeftBrowserModel }> = (props) => {
  let scrollRef: HTMLDivElement | undefined;

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
      <div class="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <div>
          <div class="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">Browser</div>
          <div class="text-sm font-medium text-neutral-100">{timelineBrowserTabLabels[props.browser.activeTab]}</div>
        </div>
        <button
          type="button"
          class="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100"
          onClick={props.browser.onToggle}
        >
          Hide
        </button>
      </div>

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

      <div class="border-b border-neutral-800 p-2">
        <input
          type="search"
          value={props.browser.searchQueryByTab[props.browser.activeTab]}
          placeholder={`Search ${timelineBrowserTabLabels[props.browser.activeTab].toLowerCase()}`}
          class="h-8 w-full rounded border border-neutral-800 bg-neutral-900 px-2 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
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
        <div class="rounded border border-dashed border-neutral-800 bg-neutral-900/40 p-3 text-xs leading-5 text-neutral-500">
          {tabPlaceholder[props.browser.activeTab]}
        </div>
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
