import { createMemo, type Accessor } from "solid-js";
import { useProjectSamples } from "~/hooks/useProjectSamples";
import type { TimelineLeftBrowserState } from "~/components/timeline/browser/browser-types";
import type { BrowserItem, BrowserItemSource, BrowserSection, TimelineLeftBrowserModel } from "~/components/timeline/browser/browser-types";
import type { TimelineDeviceInsertActions } from "~/components/timeline/timeline-device-insert-actions";
import { SAMPLE_DRAG_DATA_TYPE, serializeSampleDragData, type SampleDragData } from "~/lib/sample-drag-data";
import { createBrowserDeviceDrag } from "~/components/timeline/browser/create-browser-device-drag";
import type { BrowserDragPayload, BrowserDropTarget } from "~/components/timeline/browser/browser-drag-types";
import type { Track } from "@daw-browser/timeline-core/types";

type Options = {
  projectId: Accessor<string>;
  userId: Accessor<string>;
  leftBrowser: TimelineLeftBrowserState;
  onResizePointerDown: (event: PointerEvent) => void;
  deviceInsertActions: Accessor<TimelineDeviceInsertActions | undefined>;
  tracks: Accessor<Track[]>;
  scrollElement: () => HTMLDivElement | undefined;
  effectsChainElement: () => HTMLElement | undefined;
  currentEffectsTargetId: Accessor<Track["id"] | "master">;
  handleInsertSample: (sample: SampleDragData) => void | Promise<void>;
  onDeviceDrop: (payload: BrowserDragPayload, target: BrowserDropTarget) => void | Promise<void>;
};

const BROWSER_EFFECT_ITEM_IDS = {
  eq: "builtin:audio-effect:eq",
  saturator: "builtin:audio-effect:saturator",
  delay: "builtin:audio-effect:delay",
  reverb: "builtin:audio-effect:reverb",
  arpeggiator: "builtin:midi-effect:arpeggiator",
};
const BROWSER_INSTRUMENT_ITEM_IDS = {
  synth: "builtin:midi-instrument:synth",
};

const visibleBrowserSections = (sections: BrowserSection[]): BrowserSection[] => {
  const visibleSections: BrowserSection[] = [];
  for (const section of sections) {
    if (section.items.length > 0) visibleSections.push(section);
  }
  return visibleSections;
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
  const label = sample.name;
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
        subtitle: sample.filePath,
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
  const browserAssetSections = createMemo(() => {
    const projectItems: BrowserItem[] = [];
    const defaultItems: BrowserItem[] = [];
    for (const item of browserAssetItems()) {
      if (item.source === "project") projectItems.push(item);
      if (item.source === "default") defaultItems.push(item);
    }
    return visibleBrowserSections([
      { id: "project-samples", label: "Project", items: projectItems },
      { id: "default-samples", label: "Default", items: defaultItems },
    ]);
  });
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
        disabled: !canWrite,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.reverb,
        source: "builtin",
        category: "audio-effect",
        label: "Reverb",
        subtitle: "Audio effect",
        searchText: "reverb audio effect space",
        disabled: !canWrite,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.saturator,
        source: "builtin",
        category: "audio-effect",
        label: "Saturator",
        subtitle: "Audio effect",
        searchText: "saturator saturation drive distortion audio effect",
        disabled: !canWrite,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.delay,
        source: "builtin",
        category: "audio-effect",
        label: "Delay",
        subtitle: "Audio effect",
        searchText: "delay echo ping pong audio effect",
        disabled: !canWrite,
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
  const browserEffectSections = createMemo(() => {
    const audioEffectItems: BrowserItem[] = [];
    const midiEffectItems: BrowserItem[] = [];
    for (const item of browserEffectItems()) {
      if (item.category === "audio-effect") audioEffectItems.push(item);
      if (item.category === "midi-effect") midiEffectItems.push(item);
    }
    return visibleBrowserSections([
      { id: "audio-effects", label: "Audio Effects", items: audioEffectItems },
      { id: "midi-effects", label: "MIDI Effects", items: midiEffectItems },
    ]);
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
  const browserInstrumentSections = createMemo(() => visibleBrowserSections([
    { id: "midi-instruments", label: "Instruments", items: browserInstrumentItems() },
  ]));

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

  const resolveBrowserDevicePayload = (itemId: string): BrowserDragPayload | undefined => {
    const actions = options.deviceInsertActions();
    if (!actions?.canWrite) return undefined;
    if (itemId === BROWSER_EFFECT_ITEM_IDS.eq) return { kind: "audio-effect", effect: "eq", label: "EQ" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.saturator) return { kind: "audio-effect", effect: "saturator", label: "Saturator" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.delay) return { kind: "audio-effect", effect: "delay", label: "Delay" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.reverb) return { kind: "audio-effect", effect: "reverb", label: "Reverb" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.arpeggiator && actions.canAddArpeggiator) return { kind: "midi-effect", effect: "arpeggiator", label: "Arpeggiator" };
    if (itemId === BROWSER_INSTRUMENT_ITEM_IDS.synth && actions.canAddMidiClip) return { kind: "midi-instrument", instrument: "synth", label: "Synth" };
    return undefined;
  };

  const addBrowserEffect = (itemId: string) => {
    const payload = resolveBrowserDevicePayload(itemId);
    const actions = options.deviceInsertActions();
    if (!payload || !actions) return;
    if (payload.kind === "audio-effect") {
      if (payload.effect === "eq" && actions.canAddEq) actions.addEq();
      if (payload.effect === "saturator" && actions.canAddSaturator) actions.addSaturator();
      if (payload.effect === "delay" && actions.canAddDelay) actions.addDelay();
      if (payload.effect === "reverb" && actions.canAddReverb) actions.addReverb();
      return;
    }
    if (payload.kind === "midi-effect") actions.addArpeggiator();
  };

  const addBrowserInstrument = (itemId: string) => {
    const payload = resolveBrowserDevicePayload(itemId);
    const actions = options.deviceInsertActions();
    if (!actions || payload?.kind !== "midi-instrument") return;
    void actions.addMidiClip();
  };

  const browserDeviceDrag = createBrowserDeviceDrag({
    resolvePayload: resolveBrowserDevicePayload,
    tracks: options.tracks,
    scrollElement: options.scrollElement,
    effectsChainElement: options.effectsChainElement,
    currentEffectsTargetId: options.currentEffectsTargetId,
    canDrop: (payload, target) => {
      const actions = options.deviceInsertActions();
      if (!actions) return false;
      if (payload.kind !== "audio-effect") return target.kind !== "effect-chain";
      if (target.kind === "effect-chain") return actions.canAddAudioEffectToTarget(target.targetId, payload.effect);
      if (target.kind === "track") return actions.canAddAudioEffectToTarget(target.trackId, payload.effect);
      if (target.kind === "new-track") return true;
      return false;
    },
    onDrop: options.onDeviceDrop,
  });

  return createMemo(() => ({
    open: options.leftBrowser.open(),
    widthPx: options.leftBrowser.widthPx(),
    activeTab: options.leftBrowser.activeTab(),
    searchQueryByTab: options.leftBrowser.searchQueryByTab(),
    scrollTopByTab: options.leftBrowser.scrollTopByTab(),
    assets: {
      sections: browserAssetSections,
      onInsert: insertBrowserSample,
      onDragStart: startBrowserSampleDrag,
    },
    devices: {
      effectSections: browserEffectSections,
      instrumentSections: browserInstrumentSections,
      dragSession: browserDeviceDrag.session,
      onAddEffect: addBrowserEffect,
      onAddInstrument: addBrowserInstrument,
      onDevicePointerDown: browserDeviceDrag.onPointerDown,
    },
    onToggle: options.leftBrowser.toggleOpen,
    onSelectTab: options.leftBrowser.setActiveTab,
    onSearchQueryChange: options.leftBrowser.setSearchQuery,
    onScrollTopChange: options.leftBrowser.setScrollTop,
    onResizePointerDown: options.onResizePointerDown,
  }));
}
