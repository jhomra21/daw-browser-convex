import type { TimelineBrowserTab } from "~/components/timeline/browser/browser-types";
import { canUseLocalStorage } from "~/lib/timeline-storage";
import {
  TIMELINE_LEFT_BROWSER_DEFAULT_WIDTH,
  TIMELINE_LEFT_BROWSER_MAX_WIDTH_RATIO,
  TIMELINE_LEFT_BROWSER_MIN_TIMELINE_WIDTH,
  TIMELINE_LEFT_BROWSER_MIN_WIDTH,
} from "~/lib/timeline-layout";

export const timelineBrowserTabs: readonly TimelineBrowserTab[] = [
  "assets",
  "effects",
  "midi-instruments",
];

export const timelineBrowserTabLabels: Record<TimelineBrowserTab, string> = {
  assets: "Assets",
  effects: "Effects",
  "midi-instruments": "MIDI Instruments",
};

type PersistedTimelineLeftBrowserState = {
  open: boolean;
  widthPx: number;
  activeTab: TimelineBrowserTab;
  searchQueryByTab: Record<TimelineBrowserTab, string>;
  scrollTopByTab: Record<TimelineBrowserTab, number>;
};

const KEY_PREFIX = "timeline-left-browser:";

const createEmptyTabRecord = <TValue,>(value: TValue): Record<TimelineBrowserTab, TValue> => ({
  assets: value,
  effects: value,
  "midi-instruments": value,
});

export const createDefaultTimelineLeftBrowserState = (): PersistedTimelineLeftBrowserState => ({
  open: true,
  widthPx: TIMELINE_LEFT_BROWSER_DEFAULT_WIDTH,
  activeTab: "assets",
  searchQueryByTab: createEmptyTabRecord(""),
  scrollTopByTab: createEmptyTabRecord(0),
});

export const clampTimelineLeftBrowserWidth = (
  widthPx: number,
  containerWidthPx: number,
  rightSidebarWidthPx: number,
) => {
  const safeWidthPx = Number.isFinite(widthPx) ? widthPx : TIMELINE_LEFT_BROWSER_DEFAULT_WIDTH;
  if (containerWidthPx <= 0) {
    return Math.max(TIMELINE_LEFT_BROWSER_MIN_WIDTH, Math.round(safeWidthPx));
  }
  const layoutMaxWidth = containerWidthPx - rightSidebarWidthPx - TIMELINE_LEFT_BROWSER_MIN_TIMELINE_WIDTH;
  const ratioMaxWidth = containerWidthPx * TIMELINE_LEFT_BROWSER_MAX_WIDTH_RATIO;
  const maxWidth = Math.max(
    TIMELINE_LEFT_BROWSER_MIN_WIDTH,
    Math.min(layoutMaxWidth, ratioMaxWidth),
  );
  return Math.min(maxWidth, Math.max(TIMELINE_LEFT_BROWSER_MIN_WIDTH, Math.round(safeWidthPx)));
};

const isTimelineBrowserTab = (value: unknown): value is TimelineBrowserTab =>
  value === "assets" || value === "effects" || value === "midi-instruments";

const readStringRecord = (value: unknown): Record<TimelineBrowserTab, string> => {
  if (!value || typeof value !== "object") return createEmptyTabRecord("");
  const record = createEmptyTabRecord("");
  for (const tab of timelineBrowserTabs) {
    const next = Reflect.get(value, tab);
    record[tab] = typeof next === "string" ? next : "";
  }
  return record;
};

const readNumberRecord = (value: unknown): Record<TimelineBrowserTab, number> => {
  if (!value || typeof value !== "object") return createEmptyTabRecord(0);
  const record = createEmptyTabRecord(0);
  for (const tab of timelineBrowserTabs) {
    const next = Reflect.get(value, tab);
    record[tab] = typeof next === "number" && Number.isFinite(next) ? Math.max(0, next) : 0;
  }
  return record;
};

export const loadTimelineLeftBrowserState = (
  scopeId: string,
  containerWidthPx: number,
  rightSidebarWidthPx: number,
) => {
  const fallback = createDefaultTimelineLeftBrowserState();
  if (!canUseLocalStorage()) {
    return {
      ...fallback,
      widthPx: clampTimelineLeftBrowserWidth(fallback.widthPx, containerWidthPx, rightSidebarWidthPx),
    };
  }

  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${scopeId}`);
    if (!raw) {
      return {
        ...fallback,
        widthPx: clampTimelineLeftBrowserWidth(fallback.widthPx, containerWidthPx, rightSidebarWidthPx),
      };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {
        ...fallback,
        widthPx: clampTimelineLeftBrowserWidth(fallback.widthPx, containerWidthPx, rightSidebarWidthPx),
      };
    }
    const width = Reflect.get(parsed, "widthPx");
    const open = Reflect.get(parsed, "open");
    const activeTab = Reflect.get(parsed, "activeTab");
    return {
      open: typeof open === "boolean" ? open : fallback.open,
      widthPx: clampTimelineLeftBrowserWidth(
        typeof width === "number" ? width : fallback.widthPx,
        containerWidthPx,
        rightSidebarWidthPx,
      ),
      activeTab: isTimelineBrowserTab(activeTab) ? activeTab : fallback.activeTab,
      searchQueryByTab: readStringRecord(Reflect.get(parsed, "searchQueryByTab")),
      scrollTopByTab: readNumberRecord(Reflect.get(parsed, "scrollTopByTab")),
    };
  } catch {
    return {
      ...fallback,
      widthPx: clampTimelineLeftBrowserWidth(fallback.widthPx, containerWidthPx, rightSidebarWidthPx),
    };
  }
};

export const saveTimelineLeftBrowserState = (
  scopeId: string,
  state: PersistedTimelineLeftBrowserState,
) => {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(`${KEY_PREFIX}${scopeId}`, JSON.stringify(state));
  } catch {}
};
