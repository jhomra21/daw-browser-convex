import { createEffect, createSignal, on, onCleanup, onMount, untrack, type Accessor } from "solid-js";
import type { TimelineBrowserTab, TimelineLeftBrowserState } from "~/components/timeline/browser/browser-types";
import {
  clampTimelineLeftBrowserWidth,
  createDefaultTimelineLeftBrowserState,
  loadTimelineLeftBrowserState,
  saveTimelineLeftBrowserState,
} from "~/lib/timeline-left-browser-preferences";

type UseTimelineLeftBrowserStateOptions = {
  projectId: Accessor<string | null>;
  rightSidebarWidthPx: Accessor<number>;
  getContainerElement: () => HTMLDivElement | undefined;
};

export const useTimelineLeftBrowserState = (
  options: UseTimelineLeftBrowserStateOptions,
): TimelineLeftBrowserState => {
  const initial = createDefaultTimelineLeftBrowserState();
  const [open, setOpenSignal] = createSignal(initial.open);
  const [widthPx, setWidthPx] = createSignal(initial.widthPx);
  const [activeTab, setActiveTabSignal] = createSignal<TimelineBrowserTab>(initial.activeTab);
  const [searchQueryByTab, setSearchQueryByTab] = createSignal(initial.searchQueryByTab);
  const [scrollTopByTab, setScrollTopByTab] = createSignal(initial.scrollTopByTab);
  const [containerWidthPx, setContainerWidthPx] = createSignal(0);
  const scopeId = () => options.projectId() ?? "default";

  const clampWidth = (value: number) =>
    clampTimelineLeftBrowserWidth(value, containerWidthPx(), options.rightSidebarWidthPx());
  const readSnapshot = () => ({
    open: open(),
    widthPx: widthPx(),
    activeTab: activeTab(),
    searchQueryByTab: searchQueryByTab(),
    scrollTopByTab: scrollTopByTab(),
  });
  const saveSnapshot = () => saveTimelineLeftBrowserState(scopeId(), untrack(readSnapshot));

  onMount(() => {
    const element = options.getContainerElement();
    if (!element) return;
    setContainerWidthPx(element.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidthPx(entry.contentRect.width);
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  createEffect(on(scopeId, () => {
    const loaded = loadTimelineLeftBrowserState(
      scopeId(),
      untrack(containerWidthPx),
      untrack(options.rightSidebarWidthPx),
    );
    setOpenSignal(loaded.open);
    setWidthPx(loaded.widthPx);
    setActiveTabSignal(loaded.activeTab);
    setSearchQueryByTab(loaded.searchQueryByTab);
    setScrollTopByTab(loaded.scrollTopByTab);
  }));

  createEffect(() => {
    const nextWidth = clampWidth(widthPx());
    setWidthPx((current) => {
      if (current === nextWidth) return current;
      return nextWidth;
    });
  });

  onMount(() => {
    window.addEventListener("pagehide", saveSnapshot);
    onCleanup(() => {
      saveSnapshot();
      window.removeEventListener("pagehide", saveSnapshot);
    });
  });

  const setOpen = (nextOpen: boolean) => {
    setOpenSignal(nextOpen);
    saveSnapshot();
  };
  const toggleOpen = () => {
    setOpenSignal((value) => !value);
    saveSnapshot();
  };
  const setActiveTab = (tab: TimelineBrowserTab) => {
    setActiveTabSignal(tab);
    setOpenSignal(true);
    saveSnapshot();
  };
  const setSearchQuery = (tab: TimelineBrowserTab, query: string) => {
    setSearchQueryByTab((current) => {
      if (current[tab] === query) return current;
      return { ...current, [tab]: query };
    });
    saveSnapshot();
  };
  const setScrollTop = (tab: TimelineBrowserTab, scrollTop: number) => {
    const nextScrollTop = Math.max(0, scrollTop);
    setScrollTopByTab((current) => {
      if (current[tab] === nextScrollTop) return current;
      return { ...current, [tab]: nextScrollTop };
    });
  };
  const previewWidthPx = (value: number) => setWidthPx(clampWidth(value));
  const commitWidthPx = (value: number) => {
    setWidthPx(clampWidth(value));
    saveSnapshot();
  };
  const clampWidthToLayout = () => setWidthPx((value) => clampWidth(value));

  return {
    open,
    widthPx,
    activeTab,
    searchQueryByTab,
    scrollTopByTab,
    setOpen,
    toggleOpen,
    setActiveTab,
    setSearchQuery,
    setScrollTop,
    previewWidthPx,
    commitWidthPx,
    clampWidthToLayout,
  };
};
