import type { BrowserTreeExpansionState, TimelineBrowserTab } from "~/components/timeline/browser/browser-types";
import { canUseLocalStorage } from "~/lib/timeline-storage";
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonValue,
} from "@daw-browser/shared";
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

export const timelineBrowserTabLabels = {
  assets: "Assets",
  effects: "Effects",
  "midi-instruments": "MIDI Instruments",
} satisfies Record<TimelineBrowserTab, string>;

type PersistedTimelineLeftBrowserState = {
  open: boolean;
  widthPx: number;
  activeTab: TimelineBrowserTab;
  searchQueryByTab: Record<TimelineBrowserTab, string>;
  scrollTopByTab: Record<TimelineBrowserTab, number>;
  treeExpansionByTab: Record<TimelineBrowserTab, BrowserTreeExpansionState>;
};

const KEY_PREFIX = "timeline-left-browser:";

const createEmptyTabRecord = <TValue,>(value: TValue) => ({
  assets: value,
  effects: value,
  "midi-instruments": value,
});

const createEmptyTreeExpansionByTab = () => ({
  assets: {},
  effects: {},
  "midi-instruments": {},
} satisfies Record<TimelineBrowserTab, BrowserTreeExpansionState>);

export const createDefaultTimelineLeftBrowserState = (): PersistedTimelineLeftBrowserState => ({
  open: true,
  widthPx: TIMELINE_LEFT_BROWSER_DEFAULT_WIDTH,
  activeTab: "assets",
  searchQueryByTab: createEmptyTabRecord(""),
  scrollTopByTab: createEmptyTabRecord(0),
  treeExpansionByTab: createEmptyTreeExpansionByTab(),
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

const isTimelineBrowserTab = (value: JsonValue): value is TimelineBrowserTab =>
  value === "assets" || value === "effects" || value === "midi-instruments";

const readStringRecord = (value: JsonValue) => {
  if (!isJsonObject(value)) return createEmptyTabRecord("");
  const record = createEmptyTabRecord("");
  for (const tab of timelineBrowserTabs) {
    const next = value[tab];
    record[tab] = isJsonString(next) ? next : "";
  }
  return record;
};

const readNumberRecord = (value: JsonValue) => {
  if (!isJsonObject(value)) return createEmptyTabRecord(0);
  const record = createEmptyTabRecord(0);
  for (const tab of timelineBrowserTabs) {
    const next = value[tab];
    record[tab] = isJsonNumber(next) && Number.isFinite(next) ? Math.max(0, next) : 0;
  }
  return record;
};

const readBooleanRecord = (value: JsonValue): BrowserTreeExpansionState => {
  const record: BrowserTreeExpansionState = {};
  if (!isJsonObject(value)) return record;
  for (const [key, next] of Object.entries(value)) {
    if (isJsonBoolean(next)) record[key] = next;
  }
  return record;
};

const readTreeExpansionByTab = (value: JsonValue) => {
  if (!isJsonObject(value)) return createEmptyTreeExpansionByTab();
  return {
    assets: readBooleanRecord(value.assets ?? null),
    effects: readBooleanRecord(value.effects ?? null),
    "midi-instruments": readBooleanRecord(value["midi-instruments"] ?? null),
  } satisfies Record<TimelineBrowserTab, BrowserTreeExpansionState>;
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
    if (!isJsonObject(parsed)) {
      return {
        ...fallback,
        widthPx: clampTimelineLeftBrowserWidth(fallback.widthPx, containerWidthPx, rightSidebarWidthPx),
      };
    }
    const width = parsed.widthPx;
    const open = parsed.open;
    const activeTab = parsed.activeTab;
    return {
      open: isJsonBoolean(open) ? open : fallback.open,
      widthPx: clampTimelineLeftBrowserWidth(
        isJsonNumber(width) ? width : fallback.widthPx,
        containerWidthPx,
        rightSidebarWidthPx,
      ),
      activeTab: isTimelineBrowserTab(activeTab) ? activeTab : fallback.activeTab,
      searchQueryByTab: readStringRecord(parsed.searchQueryByTab ?? null),
      scrollTopByTab: readNumberRecord(parsed.scrollTopByTab ?? null),
      treeExpansionByTab: readTreeExpansionByTab(parsed.treeExpansionByTab ?? null),
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
