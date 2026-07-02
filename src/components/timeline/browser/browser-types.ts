import type { Accessor } from "solid-js";
import type { BrowserDragSession } from "./browser-drag-types";

export type TimelineBrowserTab = "assets" | "effects" | "midi-instruments";

export type BrowserItemSource = "project" | "default" | "builtin";

export type BrowserItemCategory =
  | "sample"
  | "audio-effect"
  | "audio-effect-chain"
  | "midi-effect"
  | "midi-instrument";

export type BrowserItem = {
  id: string;
  source: BrowserItemSource;
  category: BrowserItemCategory;
  label: string;
  subtitle?: string;
  searchText: string;
  disabled?: boolean;
  assetKey?: string;
  folderId?: string;
};

export type BrowserLeafRow = {
  kind: "leaf";
  item: BrowserItem;
};

export type BrowserFolderRow = {
  kind: "folder";
  id: string;
  source: BrowserItemSource;
  label: string;
  searchText: string;
  folderId?: string;
  children: BrowserTreeRow[];
};

export type BrowserTreeRow = BrowserLeafRow | BrowserFolderRow;

export type BrowserSection = {
  id: string;
  label: string;
  rows: BrowserTreeRow[];
};

export type BrowserTreeExpansionState = Record<string, boolean>;

export type BrowserAssetsModel = {
  sections: Accessor<BrowserSection[]>;
  folderOptions: Accessor<Array<{ id: string; name: string }>>;
  onInsert: (itemId: string) => void;
  onDragStart: (event: DragEvent, itemId: string) => void;
  onCreateFolder: () => void;
  onRenameFolder: (folderId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onMoveSampleToFolder: (itemId: string, folderId: string | undefined) => void;
  sampleFolderId: (itemId: string) => string | undefined;
  folderSampleCount: (folderId: string) => number;
};

export type BrowserDevicesModel = {
  effectSections: Accessor<BrowserSection[]>;
  instrumentSections: Accessor<BrowserSection[]>;
  dragSession: Accessor<BrowserDragSession | undefined>;
  onAddEffect: (itemId: string) => void;
  onAddInstrument: (itemId: string) => void;
  onDevicePointerDown: (event: PointerEvent, itemId: string) => void;
};

export type TimelineLeftBrowserModel = {
  open: boolean;
  widthPx: number;
  activeTab: TimelineBrowserTab;
  searchQueryByTab: Record<TimelineBrowserTab, string>;
  scrollTopByTab: Record<TimelineBrowserTab, number>;
  treeExpansionByTab: Record<TimelineBrowserTab, BrowserTreeExpansionState>;
  assets: BrowserAssetsModel;
  devices: BrowserDevicesModel;
  onToggle: () => void;
  onSelectTab: (tab: TimelineBrowserTab) => void;
  onSearchQueryChange: (tab: TimelineBrowserTab, query: string) => void;
  onScrollTopChange: (tab: TimelineBrowserTab, scrollTop: number) => void;
  onTreeRowExpandedChange: (tab: TimelineBrowserTab, rowId: string, expanded: boolean) => void;
  onResizePointerDown: (event: PointerEvent) => void;
};

export type TimelineLeftBrowserState = {
  open: Accessor<boolean>;
  widthPx: Accessor<number>;
  activeTab: Accessor<TimelineBrowserTab>;
  searchQueryByTab: Accessor<Record<TimelineBrowserTab, string>>;
  scrollTopByTab: Accessor<Record<TimelineBrowserTab, number>>;
  treeExpansionByTab: Accessor<Record<TimelineBrowserTab, BrowserTreeExpansionState>>;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setActiveTab: (tab: TimelineBrowserTab) => void;
  setSearchQuery: (tab: TimelineBrowserTab, query: string) => void;
  setScrollTop: (tab: TimelineBrowserTab, scrollTop: number) => void;
  setTreeRowExpanded: (tab: TimelineBrowserTab, rowId: string, expanded: boolean) => void;
  previewWidthPx: (widthPx: number) => void;
  commitWidthPx: (widthPx: number) => void;
  clampWidthToLayout: () => void;
};
