import { createEffect, createMemo, For, on, onMount, Show, type Component, type JSX } from "solid-js";
import type { BrowserAssetsModel, BrowserFolderRow, BrowserItem, BrowserSection, BrowserTreeExpansionState, BrowserTreeRow, TimelineBrowserTab, TimelineLeftBrowserModel } from "./browser-types";
import { timelineBrowserTabLabels, timelineBrowserTabs } from "~/lib/timeline-left-browser-preferences";
import TimelineContextMenu, { type TimelineContextMenuItem } from "../context-menu/timeline-context-menu";

const tabPlaceholder = {
  assets: "",
  effects: "No effects match this search.",
  "midi-instruments": "No MIDI instruments match this search.",
} satisfies Record<TimelineBrowserTab, string>;

const rootRowId = (sectionId: string) => `section:${sectionId}`;

const isExpanded = (expandedRows: BrowserTreeExpansionState, rowId: string) => expandedRows[rowId] !== false;

const BrowserFolderRenameInput: Component<{
  value: string;
  disabled: boolean;
  onInput: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => {
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    inputRef?.focus();
    inputRef?.select();
  });

  return (
    <input
      ref={(el) => {
        inputRef = el;
      }}
      value={props.value}
      disabled={props.disabled}
      class="min-w-0 flex-1 bg-transparent p-0 text-xs text-foreground outline-none selection:bg-primary/40 disabled:opacity-60"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onInput={(event) => props.onInput(event.currentTarget.value)}
      onBlur={() => props.onConfirm()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          props.onConfirm();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
    />
  );
};

const BrowserTreeRows: Component<{
  rows: BrowserTreeRow[];
  expandedRows: BrowserTreeExpansionState;
  searchActive: boolean;
  renderItem: (item: BrowserItem) => JSX.Element;
  onRowExpandedChange: (rowId: string, expanded: boolean) => void;
  renameFolderInline?: BrowserAssetsModel["renameFolderInline"];
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
              const editing = () => {
                const folderId = folder().folderId;
                return Boolean(folderId && props.renameFolderInline?.folderId() === folderId);
              };
              const button = (
                <button
                  type="button"
                  class="flex h-6 w-full items-center gap-1 px-3 text-left text-xs text-muted-foreground hover:bg-app-surface hover:text-foreground"
                  aria-expanded={visible()}
                  onClick={toggle}
                >
                  <span class="w-3 text-center text-xs text-muted-foreground">{visible() ? "▾" : "▸"}</span>
                  <span class="min-w-0 flex-1 truncate">{folder().label}</span>
                  <span class="text-xs text-muted-foreground">{folder().leafCount}</span>
                </button>
              );
              const editingRow = () => (
                <div class="flex h-6 w-full items-center gap-1 px-3 text-left text-xs text-muted-foreground">
                  <span class="w-3 text-center text-xs text-muted-foreground">{visible() ? "▾" : "▸"}</span>
                  <BrowserFolderRenameInput
                    value={props.renameFolderInline?.name() ?? folder().label}
                    disabled={props.renameFolderInline?.busy() ?? false}
                    onInput={(value) => props.renameFolderInline?.setName(value)}
                    onConfirm={() => props.renameFolderInline?.onConfirm()}
                    onCancel={() => props.renameFolderInline?.onCancel()}
                  />
                  <span class="text-xs text-muted-foreground">{folder().leafCount}</span>
                </div>
              );
              const normalRow = (
                <Show when={contextItems().length > 0} fallback={button}>
                  <TimelineContextMenu items={contextItems}>{button}</TimelineContextMenu>
                </Show>
              );
              return (
                <>
                  {editing() ? editingRow() : normalRow}
                  <Show when={visible()}>
                    <div class="pl-3">
                      <BrowserTreeRows
                        rows={folder().children}
                        expandedRows={props.expandedRows}
                        searchActive={props.searchActive}
                        renderItem={props.renderItem}
                        onRowExpandedChange={props.onRowExpandedChange}
                        renameFolderInline={props.renameFolderInline}
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
  renameFolderInline?: BrowserAssetsModel["renameFolderInline"];
  sectionContextItems?: (section: BrowserSection) => TimelineContextMenuItem[];
  folderContextItems?: (folder: BrowserFolderRow) => TimelineContextMenuItem[];
}> = (props) => {
  return (
    <Show
      when={props.sections.length > 0}
      fallback={(
        <div class="border border-dashed border-border bg-app-surface/40 px-2 py-2 text-xs leading-5 text-muted-foreground">
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
                class="flex h-6 w-full items-center gap-1 px-1.5 text-left text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:bg-app-surface hover:text-muted-foreground"
                aria-expanded={visible()}
                onClick={toggle}
              >
                <span class="w-3 text-center text-xs text-muted-foreground">{visible() ? "▾" : "▸"}</span>
                <span class="min-w-0 flex-1 truncate">{section.label}</span>
                <span class="text-xs font-normal tracking-normal text-muted-foreground">{section.leafCount}</span>
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
                    renameFolderInline={props.renameFolderInline}
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
      title={props.item.subtitle}
      aria-description={props.item.subtitle}
      class="group flex h-6 w-full items-center px-5 text-left text-xs hover:bg-app-surface disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => props.onClick()}
      onDragStart={(event) => props.onDragStart?.(event)}
      onPointerDown={(event) => props.onPointerDown?.(event)}
    >
      <span class="min-w-0 flex-1 truncate text-foreground group-hover:text-foreground">{props.item.label}</span>
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
  if (folder.source !== "project") return [];
  if (!folder.folderId) {
    return [{
      kind: "item",
      label: "New folder",
      onSelect: browser.assets.onCreateFolder,
    }];
  }
  const folderId = folder.folderId;
  return [
    { kind: "label", label: folder.label },
    {
      kind: "item",
      label: "New folder",
      onSelect: browser.assets.onCreateFolder,
    },
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
  if (item.source === "external-catalog") return "Insert VST3 effect";
  if (item.category === "audio-effect-chain") return "Add chain";
  if (item.category === "instrument-preset") return "Add preset";
  return activeTab === "effects" ? "Add effect" : "Add instrument";
};

const emptySpaceContextItems = (
  browser: TimelineLeftBrowserModel,
): TimelineContextMenuItem[] => {
  if (browser.activeTab === "assets") {
    return [{
      kind: "item",
      label: "New folder",
      onSelect: browser.assets.onCreateFolder,
    }];
  }
  return [
    { kind: "label", label: timelineBrowserTabLabels[browser.activeTab] },
    { kind: "item", label: "No actions available", disabled: true },
  ];
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
      class="relative flex h-full shrink-0 flex-col border-r border-border bg-background text-foreground"
      data-timeline-left-browser="1"
      style={{
        width: `${props.browser.widthPx}px`,
        display: props.browser.open ? undefined : "none",
      }}
    >
      <div class="border-b border-border p-2">
        <div class="grid grid-cols-1 gap-1">
          <For each={timelineBrowserTabs}>
            {(tab) => (
              <button
                type="button"
                class="px-2 py-1 text-left text-xs hover:bg-app-surface hover:text-foreground"
                classList={{
                  "bg-app-surface text-foreground": props.browser.activeTab === tab,
                  "text-muted-foreground": props.browser.activeTab !== tab,
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

      <div class="border-b border-border">
        <input
          type="search"
          value={props.browser.searchQueryByTab[props.browser.activeTab]}
          placeholder={`Search ${timelineBrowserTabLabels[props.browser.activeTab].toLowerCase()}`}
          class="h-9 w-full bg-transparent px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:bg-app-surface/60"
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
        <TimelineContextMenu items={() => emptySpaceContextItems(props.browser)}>
          <div class="min-h-full">
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
                renameFolderInline={props.browser.assets.renameFolderInline}
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
        </TimelineContextMenu>
      </div>

      <button
        type="button"
        aria-label="Resize browser"
        class="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-transparent hover:bg-sky-500/20"
        onPointerDown={(event) => props.browser.onResizePointerDown(event)}
      />
    </aside>
  );
};
