import type { Accessor } from "solid-js";

export type TimelineBrowserTab = "assets" | "effects" | "midi-instruments";

export type BrowserItemSource = "project" | "default" | "builtin";

export type BrowserItemCategory =
  | "sample"
  | "audio-effect"
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
};

export type BrowserSection = {
  id: string;
  label: string;
  items: BrowserItem[];
};

export type BrowserAssetsModel = {
  sections: Accessor<BrowserSection[]>;
  onInsert: (itemId: string) => void;
  onDragStart: (event: DragEvent, itemId: string) => void;
};

export type BrowserDevicesModel = {
  effectSections: Accessor<BrowserSection[]>;
  instrumentSections: Accessor<BrowserSection[]>;
  onAddEffect: (itemId: string) => void;
  onAddInstrument: (itemId: string) => void;
};

export type TimelineLeftBrowserModel = {
  open: boolean;
  widthPx: number;
  activeTab: TimelineBrowserTab;
  searchQueryByTab: Record<TimelineBrowserTab, string>;
  scrollTopByTab: Record<TimelineBrowserTab, number>;
  assets: BrowserAssetsModel;
  devices: BrowserDevicesModel;
  onToggle: () => void;
  onSelectTab: (tab: TimelineBrowserTab) => void;
  onSearchQueryChange: (tab: TimelineBrowserTab, query: string) => void;
  onScrollTopChange: (tab: TimelineBrowserTab, scrollTop: number) => void;
  onResizePointerDown: (event: PointerEvent) => void;
};

export type TimelineLeftBrowserState = {
  open: Accessor<boolean>;
  widthPx: Accessor<number>;
  activeTab: Accessor<TimelineBrowserTab>;
  searchQueryByTab: Accessor<Record<TimelineBrowserTab, string>>;
  scrollTopByTab: Accessor<Record<TimelineBrowserTab, number>>;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setActiveTab: (tab: TimelineBrowserTab) => void;
  setSearchQuery: (tab: TimelineBrowserTab, query: string) => void;
  setScrollTop: (tab: TimelineBrowserTab, scrollTop: number) => void;
  previewWidthPx: (widthPx: number) => void;
  commitWidthPx: (widthPx: number) => void;
  clampWidthToLayout: () => void;
};
