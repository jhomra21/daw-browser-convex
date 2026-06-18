import type { Accessor } from "solid-js";

export type TimelineBrowserTab = "assets" | "effects" | "midi-instruments";

export type TimelineLeftBrowserModel = {
  open: boolean;
  widthPx: number;
  activeTab: TimelineBrowserTab;
  searchQueryByTab: Record<TimelineBrowserTab, string>;
  scrollTopByTab: Record<TimelineBrowserTab, number>;
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
