import { createMemo, type Accessor } from "solid-js";
import { useProjectAssetFolders, useProjectSamples, type ProjectAssetFolder } from "~/hooks/useProjectSamples";
import type { TimelineLeftBrowserState } from "~/components/timeline/browser/browser-types";
import type { BrowserFolderRow, BrowserItem, BrowserItemSource, BrowserSection, TimelineLeftBrowserModel, BrowserTreeRow } from "~/components/timeline/browser/browser-types";
import type { TimelineDeviceInsertActions } from "~/components/timeline/timeline-device-insert-actions";
import { SAMPLE_DRAG_DATA_TYPE, serializeSampleDragData, type SampleDragData } from "~/lib/sample-drag-data";
import { createBrowserDeviceDrag } from "~/components/timeline/browser/create-browser-device-drag";
import type { BrowserDragPayload, BrowserDropTarget } from "~/components/timeline/browser/browser-drag-types";
import type { Track } from "@daw-browser/timeline-core/types";
import { countBrowserTreeLeaves, createBrowserLeafRow, filterBrowserTreeRows } from "~/components/timeline/browser/browser-tree";
import { isLocalId } from "@daw-browser/shared";
import { convexApi, convexClient } from "~/lib/convex";
import { BUILTIN_AUDIO_EFFECT_CHAIN_PRESETS, type AudioEffectChainPreset } from "~/lib/audio-effect-chain-presets";
import { BUILTIN_INSTRUMENT_PRESETS, type InstrumentPreset } from "~/lib/instrument-presets";
import {
  createLocalAssetFolder,
  deleteEmptyLocalAssetFolder,
  moveLocalAssetToFolder,
  renameLocalAssetFolder,
} from "~/lib/local-asset-folders";

type Options = {
  projectId: Accessor<string>;
  userId: Accessor<string>;
  leftBrowser: TimelineLeftBrowserState;
  onResizePointerDown: (event: PointerEvent) => void;
  deviceInsertActions: Accessor<TimelineDeviceInsertActions | undefined>;
  canCreateTrack: Accessor<boolean>;
  tracks: Accessor<Track[]>;
  scrollElement: () => HTMLDivElement | undefined;
  effectsChainElement: () => HTMLElement | undefined;
  currentEffectsTargetId: Accessor<Track["id"] | "master">;
  handleInsertSample: (sample: SampleDragData) => void | Promise<void>;
  onDeviceDrop: (payload: BrowserDragPayload, target: BrowserDropTarget) => void | Promise<void>;
};

const BROWSER_EFFECT_ITEM_IDS = {
  eq: "builtin:audio-effect:eq",
  compressor: "builtin:audio-effect:compressor",
  saturator: "builtin:audio-effect:saturator",
  delay: "builtin:audio-effect:delay",
  reverb: "builtin:audio-effect:reverb",
  arpeggiator: "builtin:midi-effect:arpeggiator",
};
const BROWSER_INSTRUMENT_ITEM_IDS = {
  synth: "builtin:midi-instrument:synth",
  drumRack: "builtin:midi-instrument:drum-rack",
};

const effectChainItemId = (preset: AudioEffectChainPreset) => `builtin:audio-effect-chain:${preset.id}`;
const instrumentPresetItemId = (preset: InstrumentPreset) => `builtin:instrument-preset:${preset.id}`;

const visibleBrowserSections = (sections: BrowserSection[]): BrowserSection[] => {
  const visibleSections: BrowserSection[] = [];
  for (const section of sections) {
    if (countBrowserTreeLeaves(section.rows) > 0) visibleSections.push(section);
  }
  return visibleSections;
};

const visibleAssetSections = (sections: BrowserSection[]): BrowserSection[] => (
  sections.filter((section) => section.id === "project-samples" || countBrowserTreeLeaves(section.rows) > 0)
);

const buildBrowserSampleRow = (
  sample: {
    key: string;
    url: string;
    name: string;
    duration: number;
    assetKey: string;
    sourceKind: SampleDragData["sourceKind"];
    source: SampleDragData["source"];
    folderId?: string;
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
      assetKey: sample.assetKey,
      folderId: sample.folderId,
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
  const assetFolders = useProjectAssetFolders({
    projectId: options.projectId,
    userId: options.userId,
    enabled: browserSamplesEnabled,
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
  const browserProjectFolderById = createMemo(() => {
    const map = new Map<string, ProjectAssetFolder>();
    for (const folder of assetFolders.folders()) map.set(folder.id, folder);
    return map;
  });
  const browserAssetSampleRowsByFolder = createMemo(() => {
    const rowsByFolderId = new Map<string, BrowserItem[]>();
    const unfiled: BrowserItem[] = [];
    const defaultItems: BrowserItem[] = [];
    for (const row of browserAssetRows()) {
      const item = row.item;
      if (item.source === "default") {
        defaultItems.push(item);
        continue;
      }
      if (!item.folderId || !browserProjectFolderById().has(item.folderId)) {
        unfiled.push(item);
        continue;
      }
      const rows = rowsByFolderId.get(item.folderId);
      if (rows) rows.push(item); else rowsByFolderId.set(item.folderId, [item]);
    }
    return { rowsByFolderId, unfiled, defaultItems };
  });
  const browserAssetSections = createMemo(() => {
    const query = browserAssetQuery();
    const { rowsByFolderId, unfiled, defaultItems } = browserAssetSampleRowsByFolder();
    const projectRows: BrowserTreeRow[] = [];
    for (const folder of assetFolders.folders()) {
      const children = rowsByFolderId.get(folder.id) ?? [];
      const row: BrowserFolderRow = {
        kind: "folder",
        id: `project-folder:${folder.id}`,
        source: "project",
        label: folder.name,
        searchText: folder.name.toLowerCase(),
        folderId: folder.id,
        children: children.map(createBrowserLeafRow),
      };
      projectRows.push(row);
    }
    if (!query || unfiled.length > 0 || assetFolders.folders().length === 0) {
      projectRows.push({
        kind: "folder",
        id: "project-samples:unfiled",
        source: "project",
        label: "Unfiled",
        searchText: "unfiled root project samples",
        children: unfiled.map(createBrowserLeafRow),
      });
    }
    return visibleAssetSections([
      { id: "project-samples", label: "Project", rows: filterBrowserTreeRows(projectRows, query) },
      { id: "default-samples", label: "Default", rows: filterBrowserTreeRows(defaultItems.map(createBrowserLeafRow), query) },
    ]);
  });
  const browserAssetSampleById = createMemo(() => {
    const map = new Map<string, SampleDragData>();
    for (const row of browserAssetRows()) map.set(row.item.id, row.sample);
    return map;
  });
  const browserAssetItemById = createMemo(() => {
    const map = new Map<string, BrowserItem>();
    for (const row of browserAssetRows()) map.set(row.item.id, row.item);
    return map;
  });
  const folderSampleCountById = createMemo(() => {
    const counts = new Map<string, number>();
    for (const sample of browserSamples.samples()) {
      if (!sample.folderId) continue;
      counts.set(sample.folderId, (counts.get(sample.folderId) ?? 0) + 1);
    }
    return counts;
  });
  const folderOptions = createMemo(() => assetFolders.folders().map((folder) => ({
    id: folder.id,
    name: folder.name,
  })));
  const browserDeviceQuery = (tab: "effects" | "midi-instruments") => options.leftBrowser.searchQueryByTab()[tab].trim().toLowerCase();
  const browserEffectItems = createMemo<BrowserItem[]>(() => {
    const actions = options.deviceInsertActions();
    const canDragDevice = actions !== undefined;
    const items: BrowserItem[] = [
      {
        id: BROWSER_EFFECT_ITEM_IDS.eq,
        source: "builtin",
        category: "audio-effect",
        label: "EQ",
        subtitle: "Audio effect",
        searchText: "eq audio effect equalizer",
        disabled: !canDragDevice,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.compressor,
        source: "builtin",
        category: "audio-effect",
        label: "Compressor",
        subtitle: "Dynamics",
        searchText: "compressor dynamics peak rms expand",
        disabled: !canDragDevice,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.saturator,
        source: "builtin",
        category: "audio-effect",
        label: "Saturator",
        subtitle: "Audio effect",
        searchText: "saturator saturation drive distortion audio effect",
        disabled: !canDragDevice,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.delay,
        source: "builtin",
        category: "audio-effect",
        label: "Delay",
        subtitle: "Audio effect",
        searchText: "delay echo ping pong audio effect",
        disabled: !canDragDevice,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.reverb,
        source: "builtin",
        category: "audio-effect",
        label: "Reverb",
        subtitle: "Audio effect",
        searchText: "reverb audio effect space",
        disabled: !canDragDevice,
      },
      {
        id: BROWSER_EFFECT_ITEM_IDS.arpeggiator,
        source: "builtin",
        category: "midi-effect",
        label: "Arpeggiator",
        subtitle: "MIDI effect",
        searchText: "arpeggiator arp midi effect",
        disabled: !canDragDevice,
      },
    ];
    return items;
  });
  const browserEffectChainItems = createMemo<BrowserItem[]>(() => {
    const actions = options.deviceInsertActions();
    return BUILTIN_AUDIO_EFFECT_CHAIN_PRESETS.map((preset) => ({
      id: effectChainItemId(preset),
      source: "builtin",
      category: "audio-effect-chain",
      label: preset.name,
      subtitle: `${preset.effects.length} audio effects`,
      searchText: `${preset.name} ${preset.folderName ?? ""} audio effect chain ${preset.effects.map((effect) => effect.kind).join(" ")}`.toLowerCase(),
      disabled: !actions,
      folderId: preset.folderId,
    }));
  });
  const browserEffectChainPresetByItemId = createMemo(() => {
    const map = new Map<string, AudioEffectChainPreset>();
    for (const preset of BUILTIN_AUDIO_EFFECT_CHAIN_PRESETS) map.set(effectChainItemId(preset), preset);
    return map;
  });
  const browserEffectChainRows = createMemo<BrowserTreeRow[]>(() => {
    const itemsByFolderId = new Map<string, BrowserItem[]>();
    const folderNamesById = new Map<string, string>();
    const unfiled: BrowserItem[] = [];
    for (const item of browserEffectChainItems()) {
      const preset = browserEffectChainPresetByItemId().get(item.id);
      if (!item.folderId || !preset?.folderName) {
        unfiled.push(item);
        continue;
      }
      folderNamesById.set(item.folderId, preset.folderName);
      const rows = itemsByFolderId.get(item.folderId);
      if (rows) rows.push(item); else itemsByFolderId.set(item.folderId, [item]);
    }
    const folders: BrowserTreeRow[] = [];
    for (const [folderId, items] of itemsByFolderId) {
      folders.push({
        kind: "folder",
        id: `builtin-audio-effect-chain-folder:${folderId}`,
        source: "builtin",
        label: folderNamesById.get(folderId) ?? folderId,
        searchText: `${folderNamesById.get(folderId) ?? folderId} audio effect chains builtin`.toLowerCase(),
        folderId,
        children: items.map(createBrowserLeafRow),
      });
    }
    return [...folders, ...unfiled.map(createBrowserLeafRow)];
  });
  const browserEffectSections = createMemo(() => {
    const audioEffectItems: BrowserItem[] = [];
    const midiEffectItems: BrowserItem[] = [];
    for (const item of browserEffectItems()) {
      if (item.category === "audio-effect") audioEffectItems.push(item);
      if (item.category === "midi-effect") midiEffectItems.push(item);
    }
    const rows = filterBrowserTreeRows([
      {
        kind: "folder",
        id: "builtin-audio-effects",
        source: "builtin",
        label: "Audio Effects",
        searchText: "audio effects builtin",
        children: audioEffectItems.map(createBrowserLeafRow),
      },
      {
        kind: "folder",
        id: "builtin-audio-effect-chains",
        source: "builtin",
        label: "Audio Effect Chains",
        searchText: "audio effect chains presets builtin",
        children: browserEffectChainRows(),
      },
      {
        kind: "folder",
        id: "builtin-midi-effects",
        source: "builtin",
        label: "MIDI Effects",
        searchText: "midi effects builtin",
        children: midiEffectItems.map(createBrowserLeafRow),
      },
    ], browserDeviceQuery("effects"));
    return visibleBrowserSections([
      { id: "builtin-effects", label: "Builtin", rows },
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
        disabled: actions === undefined,
      },
      {
        id: BROWSER_INSTRUMENT_ITEM_IDS.drumRack,
        source: "builtin",
        category: "midi-instrument",
        label: "Drum Rack",
        subtitle: "Create a MIDI clip on the selected instrument track",
        searchText: "drum rack drums sampler pads midi instrument clip",
        disabled: actions === undefined,
      },
    ];
    return items;
  });
  const browserInstrumentPresetItems = createMemo<BrowserItem[]>(() => {
    const actions = options.deviceInsertActions();
    return BUILTIN_INSTRUMENT_PRESETS.map((preset) => {
      const audioEffectCount = preset.audioEffects?.length ?? 0;
      const midiEffectCount = preset.midiEffects?.length ?? 0;
      const effectCount = audioEffectCount + midiEffectCount;
      const subtitle = effectCount > 0
        ? `${preset.instrument.kind === "synth" ? "Synth" : "Drum Rack"} + ${effectCount} effects`
        : preset.instrument.kind === "synth" ? "Synth preset" : "Drum Rack preset";
      return {
        id: instrumentPresetItemId(preset),
        source: "builtin",
        category: "instrument-preset",
        label: preset.name,
        subtitle,
        searchText: `${preset.name} ${preset.folderName ?? ""} instrument preset ${preset.instrument.kind} ${preset.midiEffects?.map((effect) => effect.kind).join(" ") ?? ""} ${preset.audioEffects?.map((effect) => effect.kind).join(" ") ?? ""}`.toLowerCase(),
        disabled: !actions,
        folderId: preset.folderId,
      };
    });
  });
  const browserInstrumentPresetByItemId = createMemo(() => {
    const map = new Map<string, InstrumentPreset>();
    for (const preset of BUILTIN_INSTRUMENT_PRESETS) map.set(instrumentPresetItemId(preset), preset);
    return map;
  });
  const browserInstrumentPresetRows = createMemo<BrowserTreeRow[]>(() => {
    const itemsByFolderId = new Map<string, BrowserItem[]>();
    const folderNamesById = new Map<string, string>();
    const unfiled: BrowserItem[] = [];
    for (const item of browserInstrumentPresetItems()) {
      const preset = browserInstrumentPresetByItemId().get(item.id);
      if (!item.folderId || !preset?.folderName) {
        unfiled.push(item);
        continue;
      }
      folderNamesById.set(item.folderId, preset.folderName);
      const rows = itemsByFolderId.get(item.folderId);
      if (rows) rows.push(item); else itemsByFolderId.set(item.folderId, [item]);
    }
    const folders: BrowserTreeRow[] = [];
    for (const [folderId, items] of itemsByFolderId) {
      folders.push({
        kind: "folder",
        id: `builtin-instrument-preset-folder:${folderId}`,
        source: "builtin",
        label: folderNamesById.get(folderId) ?? folderId,
        searchText: `${folderNamesById.get(folderId) ?? folderId} instrument presets builtin`.toLowerCase(),
        folderId,
        children: items.map(createBrowserLeafRow),
      });
    }
    return [...folders, ...unfiled.map(createBrowserLeafRow)];
  });
  const browserInstrumentSections = createMemo(() => visibleBrowserSections([
    {
      id: "builtin-midi-instruments",
      label: "Builtin",
      rows: filterBrowserTreeRows([
        {
          kind: "folder",
          id: "builtin-instruments",
          source: "builtin",
          label: "Instruments",
          searchText: "instruments builtin",
          children: browserInstrumentItems().map(createBrowserLeafRow),
        },
        {
          kind: "folder",
          id: "builtin-instrument-presets",
          source: "builtin",
          label: "Instrument Presets",
          searchText: "instrument presets builtin",
          children: browserInstrumentPresetRows(),
        },
      ], browserDeviceQuery("midi-instruments")),
    },
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

  const runAssetFolderAction = (action: () => Promise<void>) => {
    void action().catch((error) => {
      console.warn("Asset folder action failed", error);
    });
  };

  const currentProjectId = () => options.projectId();
  const currentProjectIsLocal = () => {
    const projectId = currentProjectId();
    return Boolean(projectId && isLocalId("project", projectId));
  };

  const createAssetFolder = () => {
    if (typeof window === "undefined") return;
    const name = window.prompt("Folder name");
    if (name === null) return;
    runAssetFolderAction(async () => {
      const projectId = currentProjectId();
      if (!projectId) return;
      if (currentProjectIsLocal()) {
        await createLocalAssetFolder(projectId, name);
        assetFolders.refreshFolders();
        return;
      }
      await convexClient.mutation(convexApi.assetFolders.create, { projectId, name });
    });
  };

  const renameAssetFolder = (folderId: string) => {
    if (typeof window === "undefined") return;
    const folder = browserProjectFolderById().get(folderId);
    if (!folder) return;
    const name = window.prompt("Folder name", folder.name);
    if (name === null) return;
    runAssetFolderAction(async () => {
      const projectId = currentProjectId();
      if (!projectId) return;
      if (currentProjectIsLocal()) {
        await renameLocalAssetFolder(projectId, folderId, name);
        assetFolders.refreshFolders();
        return;
      }
      await convexClient.mutation(convexApi.assetFolders.rename, { projectId, folderId, name });
    });
  };

  const deleteAssetFolder = (folderId: string) => {
    runAssetFolderAction(async () => {
      const projectId = currentProjectId();
      if (!projectId || folderSampleCountById().get(folderId)) return;
      if (currentProjectIsLocal()) {
        await deleteEmptyLocalAssetFolder(projectId, folderId);
        assetFolders.refreshFolders();
        return;
      }
      await convexClient.mutation(convexApi.assetFolders.deleteEmpty, { projectId, folderId });
    });
  };

  const moveSampleToFolder = (itemId: string, folderId: string | undefined) => {
    const item = browserAssetItemById().get(itemId);
    if (!item || item.source !== "project") return;
    if (folderId && !browserProjectFolderById().has(folderId)) return;
    runAssetFolderAction(async () => {
      const projectId = currentProjectId();
      if (!projectId || !item.assetKey) return;
      if (currentProjectIsLocal()) {
        await moveLocalAssetToFolder(projectId, item.assetKey, folderId);
        browserSamples.refreshSamples();
        return;
      }
      await convexClient.mutation(convexApi.samples.moveToFolder, {
        projectId,
        assetKey: item.assetKey,
        folderId,
      });
    });
  };

  const resolveBrowserDevicePayload = (itemId: string): BrowserDragPayload | undefined => {
    const actions = options.deviceInsertActions();
    if (!actions) return undefined;
    if (itemId === BROWSER_EFFECT_ITEM_IDS.eq) return { kind: "audio-effect", effect: "eq", label: "EQ" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.compressor) return { kind: "audio-effect", effect: "compressor", label: "Compressor" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.saturator) return { kind: "audio-effect", effect: "saturator", label: "Saturator" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.delay) return { kind: "audio-effect", effect: "delay", label: "Delay" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.reverb) return { kind: "audio-effect", effect: "reverb", label: "Reverb" };
    if (itemId === BROWSER_EFFECT_ITEM_IDS.arpeggiator) return { kind: "midi-effect", effect: "arpeggiator", label: "Arpeggiator" };
    const chain = browserEffectChainPresetByItemId().get(itemId);
    if (chain) return { kind: "audio-effect-chain", chain, label: chain.name };
    const preset = browserInstrumentPresetByItemId().get(itemId);
    if (preset) return { kind: "instrument-preset", preset, label: preset.name };
    if (itemId === BROWSER_INSTRUMENT_ITEM_IDS.synth) return { kind: "midi-instrument", instrument: "synth", label: "Synth" };
    if (itemId === BROWSER_INSTRUMENT_ITEM_IDS.drumRack) return { kind: "midi-instrument", instrument: "drum-rack", label: "Drum Rack" };
    return undefined;
  };

  const addBrowserEffect = (itemId: string) => {
    const payload = resolveBrowserDevicePayload(itemId);
    const actions = options.deviceInsertActions();
    if (!payload || !actions?.canWrite) return;
    if (payload.kind === "audio-effect") {
      if (payload.effect === "eq" && actions.canAddEq) actions.addEq();
      if (payload.effect === "compressor" && actions.canAddCompressor) actions.addCompressor();
      if (payload.effect === "saturator" && actions.canAddSaturator) actions.addSaturator();
      if (payload.effect === "delay" && actions.canAddDelay) actions.addDelay();
      if (payload.effect === "reverb" && actions.canAddReverb) actions.addReverb();
      return;
    }
    if (payload.kind === "audio-effect-chain") {
      const targetId = options.currentEffectsTargetId();
      if (actions.canAddAudioEffectChainToTarget(targetId, payload.chain)) {
        void actions.addAudioEffectChainToTarget(targetId, payload.chain);
      }
      return;
    }
    if (payload.kind === "midi-effect" && actions.canAddArpeggiator) actions.addArpeggiator();
  };

  const addBrowserInstrument = (itemId: string) => {
    const payload = resolveBrowserDevicePayload(itemId);
    const actions = options.deviceInsertActions();
    if (!actions?.canWrite || (payload?.kind !== "midi-instrument" && payload?.kind !== "instrument-preset")) return;
    const targetId = options.currentEffectsTargetId();
    if (targetId === "master") return;
    const laneIndex = options.tracks().findIndex((track) => track.id === targetId);
    if (laneIndex < 0) return;
    if (payload.kind === "midi-instrument" && !actions.canAddMidiClip) return;
    if (payload.kind === "instrument-preset" && !actions.canSetInstrumentForTarget(targetId)) return;
    void options.onDeviceDrop(payload, { kind: "track", trackId: targetId, laneIndex });
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
      if (payload.kind === "audio-effect") {
        if (target.kind === "effect-chain") return actions.canAddAudioEffectToTarget(target.targetId, payload.effect);
        if (target.kind === "track") return actions.canAddAudioEffectToTarget(target.trackId, payload.effect);
        return target.kind === "new-track" && options.canCreateTrack();
      }
      if (payload.kind === "audio-effect-chain") {
        if (target.kind === "effect-chain") return actions.canAddAudioEffectChainToTarget(target.targetId, payload.chain);
        if (target.kind === "track") return actions.canAddAudioEffectChainToTarget(target.trackId, payload.chain);
        return target.kind === "new-track" && options.canCreateTrack();
      }
      if (payload.kind === "midi-effect") {
        if (target.kind === "track") return actions.canAddArpeggiatorToTarget(target.trackId);
        return target.kind === "new-track" && options.canCreateTrack();
      }
      if (payload.kind === "instrument-preset") {
        if (target.kind === "track") {
          if (!actions.canSetInstrumentForTarget(target.trackId)) return false;
          if (payload.preset.audioEffects?.some((effect) => !actions.canAddAudioEffectToTarget(target.trackId, effect.kind))) return false;
          return true;
        }
        return target.kind === "new-track" && options.canCreateTrack();
      }
      if (target.kind === "track") return actions.canAddMidiClipToTarget(target.trackId);
      if (target.kind === "new-track") return options.canCreateTrack();
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
    treeExpansionByTab: options.leftBrowser.treeExpansionByTab(),
    assets: {
      sections: browserAssetSections,
      folderOptions,
      onInsert: insertBrowserSample,
      onDragStart: startBrowserSampleDrag,
      onCreateFolder: createAssetFolder,
      onRenameFolder: renameAssetFolder,
      onDeleteFolder: deleteAssetFolder,
      onMoveSampleToFolder: moveSampleToFolder,
      sampleFolderId: (itemId: string) => browserAssetItemById().get(itemId)?.folderId,
      folderSampleCount: (folderId: string) => folderSampleCountById().get(folderId) ?? 0,
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
    onTreeRowExpandedChange: options.leftBrowser.setTreeRowExpanded,
    onResizePointerDown: options.onResizePointerDown,
  }));
}
