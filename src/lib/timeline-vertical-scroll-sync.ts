import { onCleanup } from "solid-js";

export type TimelineVerticalScrollElement = {
  scrollTop: number;
  addEventListener: (
    type: "scroll",
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void;
  removeEventListener: (type: "scroll", listener: () => void) => void;
};

type TimelineVerticalScrollSyncOptions = {
  onCanonicalScrollTop: (scrollTop: number) => void;
};

export const createTimelineVerticalScrollSync = (
  options: TimelineVerticalScrollSyncOptions,
) => {
  let timelineElement: TimelineVerticalScrollElement | undefined;
  let sidebarElement: TimelineVerticalScrollElement | undefined;
  let mirroring = false;
  let canonicalScrollTop: number | undefined;

  const publishCanonicalScrollTop = (scrollTop: number) => {
    if (canonicalScrollTop === scrollTop) return;
    canonicalScrollTop = scrollTop;
    options.onCanonicalScrollTop(scrollTop);
  };

  const mirrorScrollTop = (
    source: TimelineVerticalScrollElement,
    target: TimelineVerticalScrollElement | undefined,
  ) => {
    if (!target || target.scrollTop === source.scrollTop) return;
    mirroring = true;
    target.scrollTop = source.scrollTop;
    mirroring = false;
  };

  const handleTimelineScroll = () => {
    if (mirroring || !timelineElement) return;
    publishCanonicalScrollTop(timelineElement.scrollTop);
    mirrorScrollTop(timelineElement, sidebarElement);
  };

  const handleSidebarScroll = () => {
    if (mirroring || !sidebarElement) return;
    mirrorScrollTop(sidebarElement, timelineElement);
    publishCanonicalScrollTop(timelineElement?.scrollTop ?? sidebarElement.scrollTop);
  };

  const bindTimeline = (next: TimelineVerticalScrollElement) => {
    if (timelineElement === next) return;
    timelineElement?.removeEventListener("scroll", handleTimelineScroll);
    timelineElement = next;
    next.addEventListener("scroll", handleTimelineScroll, { passive: true });
    publishCanonicalScrollTop(next.scrollTop);
    mirrorScrollTop(next, sidebarElement);
  };

  const bindSidebar = (next: TimelineVerticalScrollElement) => {
    if (sidebarElement === next) return;
    sidebarElement?.removeEventListener("scroll", handleSidebarScroll);
    sidebarElement = next;
    next.addEventListener("scroll", handleSidebarScroll, { passive: true });
    mirrorScrollTop(timelineElement ?? next, next);
  };

  onCleanup(() => {
    timelineElement?.removeEventListener("scroll", handleTimelineScroll);
    sidebarElement?.removeEventListener("scroll", handleSidebarScroll);
  });

  return { bindTimeline, bindSidebar };
};
