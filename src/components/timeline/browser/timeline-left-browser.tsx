import { createEffect, createMemo, For, on, onMount, Show, type Component, type JSX } from "solid-js";
import type { BrowserFolderRow, BrowserItem, BrowserSection, BrowserTreeExpansionState, BrowserTreeRow, TimelineBrowserTab, TimelineLeftBrowserModel } from "./browser-types";
import { timelineBrowserTabLabels, timelineBrowserTabs } from "~/lib/timeline-left-browser-preferences";
import TimelineContextMenu, { type TimelineContextMenuItem } from "../context-menu/timeline-context-menu";
import { countBrowserTreeLeaves } from "./browser-tree";

const tabPlaceholder: Record<TimelineBrowserTab, string> = {
  assets: "",
  effects: "No effects match this search.",
  "midi-instruments": "No MIDI instruments match this search.",
};

const rootRowId = (sectionId: string) => `section:${sectionId}`;

const isExpanded = (expandedRows: BrowserTreeExpansionState, rowId: string) => expandedRows[rowId] !== false;

const BrowserTreeRows: Component<{
  rows: BrowserTreeRow[];
  expandedRows: BrowserTreeExpansionState;
  searchActive: boolean;
  renderItem: (item: BrowserItem) => JSX.Element;
  onRowExpandedChange: (rowId: string, expanded: boolean) => void;
  folderContextItems?: (folder: BrowserFolderRow) => TimelineContextMenuItem[];
}> = (props) => (
  <ul class="py-0.5">
    <For each={props.rows}>
      {(row) => (
        <li>
          <Show
            when={row.kind === "folder" ? row : undefined}
            fallback={row.kind === "leaf" ? props.renderItem(row.item) : null}
          >
            {(folder) => {
              const expanded = () => isExpanded(props.expandedRows, folder().id);
              const visible = () => props.searchActive || expanded();
              const toggle = () => props.onRowExpandedChange(folder().id, !expanded());
              const contextItems = () => props.folderContextItems?.(folder()) ?? [];
              const button = (
                <button
                  type="button"
                  class="flex h-6 w-full items-center gap-1 px-3 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
                  aria-expanded={visible()}
                  onClick={toggle}
                >
                  <span class="w-3 text-center text-xs text-neutral-600">{visible() ? "▾" : "▸"}</span>
                  <span class="min-w-0 flex-1 truncate">{folder().label}</span>
                  <span class="text-xs text-neutral-600">{countBrowserTreeLeaves(folder().children)}</span>
                </button>
              );
              return (
                <>
                  <Show when={contextItems().length > 0} fallback={button}>
                    <TimelineContextMenu items={contextItems}>{button}</TimelineContextMenu>
                  </Show>
                  <Show when={visible()}>
                    <div class="pl-3">
                      <BrowserTreeRows
                        rows={folder().children}
                        expandedRows={props.expandedRows}
                        searchActive={props.searchActive}
                        renderItem={props.renderItem}
                        onRowExpandedChange={props.onRowExpandedChange}
                        folderContextItems={props.folderContextItems}
                      />
                    </div>
                  </Show>
                </>
              );
            }}
          </Show>
        </li>
      )}
    </For>
  </ul>
);

const BrowserTree: Component<{
  sections: BrowserSection[];
  emptyText: string;
  expandedRows: BrowserTreeExpansionState;
  searchActive: boolean;
  renderItem: (item: BrowserItem) => JSX.Element;
  onRowExpandedChange: (rowId: string, expanded: boolean) => void;
  sectionContextItems?: (section: BrowserSection) => TimelineContextMenuItem[];
  folderContextItems?: (folder: BrowserFolderRow) => TimelineContextMenuItem[];
}> = (props) => {
  return (
    <Show
      when={props.sections.length > 0}
      fallback={(
        <div class="border border-dashed border-neutral-800 bg-neutral-900/40 px-2 py-2 text-xs leading-5 text-neutral-500">
          {props.emptyText}
        </div>
      )}
    >
      <div class="space-y-0.5">
        <For each={props.sections}>
          {(section) => {
            const rowId = rootRowId(section.id);
            const expanded = () => isExpanded(props.expandedRows, rowId);
            const visible = () => props.searchActive || expanded();
            const toggle = () => props.onRowExpandedChange(rowId, !expanded());
            const contextItems = () => props.sectionContextItems?.(section) ?? [];
            const button = (
              <button
                type="button"
                class="flex h-6 w-full items-center gap-1 px-1.5 text-left text-xs font-semibold uppercase tracking-widest text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                aria-expanded={visible()}
                onClick={toggle}
              >
                <span class="w-3 text-center text-xs text-neutral-600">{visible() ? "▾" : "▸"}</span>
                <span class="min-w-0 flex-1 truncate">{section.label}</span>
                <span class="text-xs font-normal tracking-normal text-neutral-600">{countBrowserTreeLeaves(section.rows)}</span>
              </button>
            );
            return (
              <section>
                <Show when={contextItems().length > 0} fallback={button}>
                  <TimelineContextMenu items={contextItems}>{button}</TimelineContextMenu>
                </Show>
                <Show when={visible()}>
                  <BrowserTreeRows
                    rows={section.rows}
                    expandedRows={props.expandedRows}
                    searchActive={props.searchActive}
                    renderItem={props.renderItem}
                    onRowExpandedChange={props.onRowExpandedChange}
                    folderContextItems={props.folderContextItems}
                  />
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
  onPointerDown?: (event: PointerEvent) => void;
  contextActionLabel: string;
  extraContextItems?: () => TimelineContextMenuItem[];
}> = (props) => {
  const items = (): TimelineContextMenuItem[] => {
    const entries: TimelineContextMenuItem[] = [
      { kind: "label", label: props.item.label },
      {
        kind: "item",
        label: props.contextActionLabel,
        disabled: props.item.disabled,
        onSelect: props.onClick,
      },
    ];
    const extraItems = props.extraContextItems?.() ?? [];
    if (extraItems.length > 0) {
      entries.push({ kind: "separator" });
      entries.push(...extraItems);
    }
    return entries;
  };
  const row = (
    <button
      type="button"
      draggable={props.draggable}
      disabled={props.item.disabled}
      class="group flex h-6 w-full items-center px-5 text-left text-xs hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={props.onClick}
      onDragStart={props.onDragStart}
      onPointerDown={props.onPointerDown}
    >
      <span class="min-w-0 flex-1 truncate text-neutral-200 group-hover:text-neutral-50">{props.item.label}</span>
    </button>
  );
  return <TimelineContextMenu items={items}>{row}</TimelineContextMenu>;
};

const assetSectionContextItems = (
  browser: TimelineLeftBrowserModel,
  section: BrowserSection,
): TimelineContextMenuItem[] => {
  if (section.id !== "project-samples") return [];
  return [{
    kind: "item",
    label: "New folder",
    onSelect: browser.assets.onCreateFolder,
  }];
};

const assetFolderContextItems = (
  browser: TimelineLeftBrowserModel,
  folder: BrowserFolderRow,
): TimelineContextMenuItem[] => {
  if (folder.source !== "project" || !folder.folderId) return [];
  const folderId = folder.folderId;
  return [
    { kind: "label", label: folder.label },
    {
      kind: "item",
      label: "Rename folder",
      onSelect: () => browser.assets.onRenameFolder(folderId),
    },
    {
      kind: "item",
      label: "Delete empty folder",
      disabled: browser.assets.folderSampleCount(folderId) > 0,
      onSelect: () => browser.assets.onDeleteFolder(folderId),
    },
  ];
};

const assetItemContextItems = (
  browser: TimelineLeftBrowserModel,
  item: BrowserItem,
): TimelineContextMenuItem[] => {
  if (item.source !== "project") return [];
  const entries: TimelineContextMenuItem[] = [];
  const currentFolderId = browser.assets.sampleFolderId(item.id);
  for (const folder of browser.assets.folderOptions()) {
    if (folder.id === currentFolderId) continue;
    entries.push({
      kind: "item",
      label: `Move to ${folder.name}`,
      onSelect: () => browser.assets.onMoveSampleToFolder(item.id, folder.id),
    });
  }
  if (currentFolderId) {
    entries.push({
      kind: "item",
      label: "Move to Unfiled",
      onSelect: () => browser.assets.onMoveSampleToFolder(item.id, undefined),
    });
  }
  return entries;
};

const deviceContextActionLabel = (activeTab: TimelineBrowserTab, item: BrowserItem) => {
  if (item.category === "audio-effect-chain") return "Add chain";
  if (item.category === "instrument-preset") return "Add preset";
  return activeTab === "effects" ? "Add effect" : "Add instrument";
};

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
  createEffect(on(() => props.browser.activeTab, restoreScrollTop));
  const activeTreeExpansion = () => props.browser.treeExpansionByTab[props.browser.activeTab];
  const searchActive = () => props.browser.searchQueryByTab[props.browser.activeTab].trim().length > 0;
  const setTreeRowExpanded = (rowId: string, expanded: boolean) =>
    props.browser.onTreeRowExpandedChange(props.browser.activeTab, rowId, expanded);

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
                class="px-2 py-1 text-left text-xs hover:bg-neutral-900 hover:text-neutral-100"
                classList={{
                  "bg-neutral-900 text-neutral-100": props.browser.activeTab === tab,
                  "text-neutral-400": props.browser.activeTab !== tab,
                }}
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
              expandedRows={activeTreeExpansion()}
              searchActive={searchActive()}
              onRowExpandedChange={setTreeRowExpanded}
              renderItem={(item) => (
                <BrowserItemRow
                  item={item}
                  contextActionLabel={deviceContextActionLabel(props.browser.activeTab, item)}
                  onClick={() => visibleDeviceTree().onAdd(item.id)}
                  onPointerDown={(event) => props.browser.devices.onDevicePointerDown(event, item.id)}
                />
              )}
            />
          )}
        >
          <BrowserTree
            sections={props.browser.assets.sections()}
            emptyText="No samples match this search."
            expandedRows={activeTreeExpansion()}
            searchActive={searchActive()}
            onRowExpandedChange={setTreeRowExpanded}
            sectionContextItems={(section) => assetSectionContextItems(props.browser, section)}
            folderContextItems={(folder) => assetFolderContextItems(props.browser, folder)}
            renderItem={(item) => (
              <BrowserItemRow
                item={item}
                contextActionLabel="Insert sample"
                extraContextItems={() => assetItemContextItems(props.browser, item)}
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
