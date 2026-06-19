import { createEffect, createMemo, createSignal, For, onMount, Show, type Component, type JSX } from "solid-js";
import type { BrowserItem, BrowserSection, TimelineBrowserTab, TimelineLeftBrowserModel } from "./browser-types";
import { timelineBrowserTabLabels, timelineBrowserTabs } from "~/lib/timeline-left-browser-preferences";
import { cn } from "~/lib/utils";

const tabPlaceholder: Record<TimelineBrowserTab, string> = {
  assets: "",
  effects: "No effects match this search.",
  "midi-instruments": "No MIDI instruments match this search.",
};

const BrowserTree: Component<{
  sections: BrowserSection[];
  emptyText: string;
  renderItem: (item: BrowserItem) => JSX.Element;
}> = (props) => {
  const [collapsedSections, setCollapsedSections] = createSignal<Record<string, boolean>>({});
  const isCollapsed = (sectionId: string) => collapsedSections()[sectionId] === true;
  const toggleSection = (sectionId: string) => {
    setCollapsedSections((sections) => ({
      ...sections,
      [sectionId]: sections[sectionId] !== true,
    }));
  };

  return (
    <Show
      when={props.sections.length > 0}
      fallback={(
        <div class="rounded border border-dashed border-neutral-800 bg-neutral-900/40 px-2 py-2 text-xs leading-5 text-neutral-500">
          {props.emptyText}
        </div>
      )}
    >
      <div class="space-y-0.5">
        <For each={props.sections}>
          {(section) => {
            const collapsed = () => isCollapsed(section.id);
            return (
              <section>
                <button
                  type="button"
                  class="flex h-6 w-full items-center gap-1 rounded px-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                  aria-expanded={!collapsed()}
                  onClick={() => toggleSection(section.id)}
                >
                  <span class="w-3 text-center text-[10px] text-neutral-600">{collapsed() ? "▸" : "▾"}</span>
                  <span class="min-w-0 flex-1 truncate">{section.label}</span>
                  <span class="text-[10px] font-normal tracking-normal text-neutral-600">{section.items.length}</span>
                </button>
                <Show when={!collapsed()}>
                  <ul class="py-0.5">
                    <For each={section.items}>
                      {(item) => <li>{props.renderItem(item)}</li>}
                    </For>
                  </ul>
                </Show>
              </section>
            );
          }}
        </For>
      </div>
    </Show>
  );
};

const BrowserItemRow: Component<{
  item: BrowserItem;
  draggable?: boolean;
  onClick: () => void;
  onDragStart?: (event: DragEvent) => void;
}> = (props) => (
  <button
    type="button"
    draggable={props.draggable}
    disabled={props.item.disabled}
    class="group flex h-6 w-full items-center rounded px-5 text-left text-xs hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
    onClick={props.onClick}
    onDragStart={props.onDragStart}
  >
    <span class="min-w-0 flex-1 truncate text-neutral-200 group-hover:text-neutral-50">{props.item.label}</span>
  </button>
);

export const TimelineLeftBrowser: Component<{ browser: TimelineLeftBrowserModel }> = (props) => {
  let scrollRef: HTMLDivElement | undefined;
  const visibleDeviceTree = createMemo(() => {
    if (props.browser.activeTab === "effects") {
      return {
        sections: props.browser.devices.effectSections(),
        emptyText: tabPlaceholder.effects,
        onAdd: props.browser.devices.onAddEffect,
      };
    }
    return {
      sections: props.browser.devices.instrumentSections(),
      emptyText: tabPlaceholder["midi-instruments"],
      onAdd: props.browser.devices.onAddInstrument,
    };
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
                  "rounded px-2 py-1 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100",
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
          class="h-9 w-full bg-transparent px-3 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 focus:bg-neutral-900/60"
          onInput={(event) => props.browser.onSearchQueryChange(props.browser.activeTab, event.currentTarget.value)}
        />
      </div>

      <div
        ref={(el) => {
          scrollRef = el;
        }}
        class="min-h-0 flex-1 overflow-y-auto p-1.5"
        onScroll={(event) => props.browser.onScrollTopChange(props.browser.activeTab, event.currentTarget.scrollTop)}
      >
        <Show
          when={props.browser.activeTab === "assets"}
          fallback={(
            <BrowserTree
              sections={visibleDeviceTree().sections}
              emptyText={visibleDeviceTree().emptyText}
              renderItem={(item) => (
                <BrowserItemRow
                  item={item}
                  onClick={() => visibleDeviceTree().onAdd(item.id)}
                />
              )}
            />
          )}
        >
          <BrowserTree
            sections={props.browser.assets.sections()}
            emptyText="No samples match this search."
            renderItem={(item) => (
              <BrowserItemRow
                item={item}
                draggable={!item.disabled}
                onClick={() => props.browser.assets.onInsert(item.id)}
                onDragStart={(event) => props.browser.assets.onDragStart(event, item.id)}
              />
            )}
          />
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
