import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import { useProjectSamples } from "~/hooks/useProjectSamples";
import type { TimelineLeftBrowserState } from "~/components/timeline/browser/browser-types";
import type { BrowserItem, BrowserItemSource, TimelineDeviceInsertActions, TimelineLeftBrowserModel } from "~/components/timeline/browser/browser-types";
import { SAMPLE_DRAG_DATA_TYPE, serializeSampleDragData, type SampleDragData } from "~/lib/sample-drag-data";

type Options = {
  projectId: Accessor<string>;
  userId: Accessor<string>;
  leftBrowser: TimelineLeftBrowserState;
  onResizePointerDown: (event: PointerEvent) => void;
  deviceInsertActions: Accessor<TimelineDeviceInsertActions | undefined>;
  handleInsertSample: (sample: SampleDragData) => void | Promise<void>;
};

const BROWSER_ASSET_PAGE_SIZE = 200;
const BROWSER_EFFECT_ITEM_IDS = {
  eq: "builtin:audio-effect:eq",
  reverb: "builtin:audio-effect:reverb",
  arpeggiator: "builtin:midi-effect:arpeggiator",
};
const BROWSER_INSTRUMENT_ITEM_IDS = {
  synth: "builtin:midi-instrument:synth",
};

const buildBrowserSampleRow = (
  sample: {
    key: string;
    url: string;
    name: string;
    duration: number;
    assetKey: string;
    sourceKind: SampleDragData["sourceKind"];
    source: SampleDragData["source"];
  },
  options: {
    idPrefix: string;
    source: BrowserItemSource;
    subtitle: string;
  },
): { item: BrowserItem; sample: SampleDragData } => {
  const label = sample.name || "Sample";
  return {
    item: {
      id: `${options.idPrefix}:${sample.key}`,
      source: options.source,
      category: "sample",
      label,
      subtitle: options.subtitle,
      searchText: `${label} ${options.subtitle}`.toLowerCase(),
    },
    sample: {
      url: sample.url,
      name: label,
      duration: sample.duration,
      assetKey: sample.assetKey,
      sourceKind: sample.sourceKind,
      source: sample.source,
    },
  };
};

export function useTimelineBrowserController(options: Options): Accessor<TimelineLeftBrowserModel> {
  const browserSamplesEnabled = () => options.leftBrowser.open() && options.leftBrowser.activeTab() === "assets";
  const [browserAssetVisibleCount, setBrowserAssetVisibleCount] = createSignal(BROWSER_ASSET_PAGE_SIZE);
  const browserSamples = useProjectSamples({
    projectId: options.projectId,
    userId: options.userId,
    enabled: browserSamplesEnabled,
    includeFilePath: () => false,
    includeUsage: () => false,
  });
  const browserAssetQuery = () => options.leftBrowser.searchQueryByTab().assets.trim().toLowerCase();
  const browserAssetRows = createMemo(() => {
    const rows: Array<{ item: BrowserItem; sample: SampleDragData }> = [];
    for (const sample of browserSamples.samples()) {
      rows.push(buildBrowserSampleRow(sample, {
        idPrefix: "project",
        source: "project",
        subtitle: sample.filePath || sample.url,
      }));
    }
    for (const sample of browserSamples.defaultSamples()) {
      rows.push(buildBrowserSampleRow(sample, {
        idPrefix: "default",
        source: "default",
        subtitle: sample.url,
      }));
    }
    return rows;
  });
  const filteredBrowserAssetRows = createMemo(() => {
    const query = browserAssetQuery();
    if (!query) return browserAssetRows();
    return browserAssetRows().filter((row) => row.item.searchText.includes(query));
  });
  const browserAssetItems = createMemo(() => filteredBrowserAssetRows().map((row) => row.item));
  const browserAssetSampleById = createMemo(() => {
    const map = new Map<string, SampleDragData>();
    for (const row of filteredBrowserAssetRows()) map.set(row.item.id, row.sample);
    return map;
  });
  const browserDeviceQuery = (tab: "effects" | "midi-instruments") => options.leftBrowser.searchQueryByTab()[tab].trim().toLowerCase();
  const browserEffectItems = createMemo<BrowserItem[]>(() => {
    const actions = options.deviceInsertActions();
    const canWrite = actions?.canWrite === true;
    const items: BrowserItem[] = [
      {
        id: BROWSER_EFFECT_ITEM_IDS.eq,
        source: "builtin",
        category: "audio-effect",
        label: "EQ",
        subtitle: "Audio effect",
        searchText: "eq audio effect equalizer",
        disabled: !canWrite || actions?.canAddEq !== true,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.reverb,
        source: "builtin",
        category: "audio-effect",
        label: "Reverb",
        subtitle: "Audio effect",
        searchText: "reverb audio effect space",
        disabled: !canWrite || actions?.canAddReverb !== true,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.arpeggiator,
        source: "builtin",
        category: "midi-effect",
        label: "Arpeggiator",
        subtitle: "MIDI effect",
        searchText: "arpeggiator arp midi effect",
        disabled: !canWrite || actions?.canAddArpeggiator !== true,
      },
    ];
    const query = browserDeviceQuery("effects");
    if (!query) return items;
    return items.filter((item) => item.searchText.includes(query));
  });
  const browserInstrumentItems = createMemo<BrowserItem[]>(() => {
    const actions = options.deviceInsertActions();
    const items: BrowserItem[] = [
      {
        id: BROWSER_INSTRUMENT_ITEM_IDS.synth,
        source: "builtin",
        category: "midi-instrument",
        label: "Synth",
        subtitle: "Create a MIDI clip on the selected instrument track",
        searchText: "synth midi instrument clip",
        disabled: actions?.canWrite !== true || actions.canAddMidiClip !== true,
      },
    ];
    const query = browserDeviceQuery("midi-instruments");
    if (!query) return items;
    return items.filter((item) => item.searchText.includes(query));
  });

  createEffect(() => {
    browserAssetQuery();
    setBrowserAssetVisibleCount(BROWSER_ASSET_PAGE_SIZE);
  });

  const insertBrowserSample = (itemId: string) => {
    const sample = browserAssetSampleById().get(itemId);
    if (!sample) return;
    void options.handleInsertSample(sample);
  };

  const startBrowserSampleDrag = (event: DragEvent, itemId: string) => {
    const sample = browserAssetSampleById().get(itemId);
    if (!sample || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(SAMPLE_DRAG_DATA_TYPE, serializeSampleDragData(sample));
  };

  const addBrowserEffect = (itemId: string) => {
    const actions = options.deviceInsertActions();
    if (!actions?.canWrite) return;
    if (itemId === BROWSER_EFFECT_ITEM_IDS.eq && actions.canAddEq) actions.addEq();
    if (itemId === BROWSER_EFFECT_ITEM_IDS.reverb && actions.canAddReverb) actions.addReverb();
    if (itemId === BROWSER_EFFECT_ITEM_IDS.arpeggiator && actions.canAddArpeggiator) actions.addArpeggiator();
  };

  const addBrowserInstrument = (itemId: string) => {
    const actions = options.deviceInsertActions();
    if (!actions?.canWrite || itemId !== BROWSER_INSTRUMENT_ITEM_IDS.synth || !actions.canAddMidiClip) return;
    void actions.addMidiClip();
  };

  return createMemo(() => ({
    open: options.leftBrowser.open(),
    widthPx: options.leftBrowser.widthPx(),
    activeTab: options.leftBrowser.activeTab(),
    searchQueryByTab: options.leftBrowser.searchQueryByTab(),
    scrollTopByTab: options.leftBrowser.scrollTopByTab(),
    assets: {
      items: browserAssetItems,
      visibleCount: browserAssetVisibleCount,
      canLoadMore: () => browserAssetItems().length > browserAssetVisibleCount(),
      onLoadMore: () => setBrowserAssetVisibleCount((count) => count + BROWSER_ASSET_PAGE_SIZE),
      onInsert: insertBrowserSample,
      onDragStart: startBrowserSampleDrag,
    },
    devices: {
      effects: browserEffectItems,
      instruments: browserInstrumentItems,
      onAddEffect: addBrowserEffect,
      onAddInstrument: addBrowserInstrument,
    },
    onToggle: options.leftBrowser.toggleOpen,
    onSelectTab: options.leftBrowser.setActiveTab,
    onSearchQueryChange: options.leftBrowser.setSearchQuery,
    onScrollTopChange: options.leftBrowser.setScrollTop,
    onResizePointerDown: options.onResizePointerDown,
  }));
}
