import { createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type Accessor } from "solid-js";
import { useProjectAssetFolders, useProjectSamples, type ProjectAssetFolder } from "~/hooks/useProjectSamples";
import type { BrowserFolderRow, BrowserItem, BrowserItemSource, BrowserSection, BrowserTreeRow, TimelineLeftBrowserModel, TimelineLeftBrowserState } from "~/components/timeline/browser/browser-types";
import type { TimelineDeviceInsertActions } from "~/components/timeline/timeline-device-insert-actions";
import { SAMPLE_DRAG_DATA_TYPE, serializeSampleDragData, type SampleDragData } from "~/lib/sample-drag-data";
import { createBrowserDeviceDrag } from "~/components/timeline/browser/create-browser-device-drag";
import type { BrowserDragPayload, BrowserDropTarget } from "~/components/timeline/browser/browser-drag-types";
import type { Track } from "@daw-browser/timeline-core/types";
import type { TimelineTrackLayoutRow } from "~/lib/timeline-track-layout";
import { countBrowserTreeLeaves, createBrowserLeafRow, filterBrowserTreeRows } from "~/components/timeline/browser/browser-tree";
import { isLocalId } from "@daw-browser/shared";
import { convexApi, convexClient } from "~/lib/convex";
import { BUILTIN_AUDIO_EFFECT_CHAIN_PRESETS, type AudioEffectChainPreset } from "~/lib/audio-effect-chain-presets";
import { BUILTIN_INSTRUMENT_PRESETS, type InstrumentPreset } from "~/lib/instrument-presets";
import {
  BROWSER_AUDIO_EFFECT_CATALOG,
  BROWSER_DEVICE_CATALOG,
  BROWSER_INSTRUMENT_CATALOG,
  BROWSER_MIDI_EFFECT_CATALOG,
  deviceCatalogSearchText,
} from "~/lib/device-catalog";
import {
  createLocalAssetFolder,
  deleteEmptyLocalAssetFolder,
  moveLocalAssetToFolder,
  renameLocalAssetFolder,
} from "~/lib/local-asset-folders";
import type { DesktopPluginCatalogEntry } from "~/lib/desktop/attached-host-controller";
import {
  insertNativeVst3Effect,
  nativeVst3InsertionAvailability,
  type NativeVst3CatalogSelection,
} from "~/lib/desktop/native-vst3-insertion";
import type { ExternalProcessor } from "@daw-browser/external-plugins";
import { vst3ScanHealthLabel } from "~/lib/external-plugin-ui";

type Options = {
  projectId: Accessor<string>;
  userId: Accessor<string>;
  leftBrowser: TimelineLeftBrowserState;
  onResizePointerDown: (event: PointerEvent) => void;
  deviceInsertActions: Accessor<TimelineDeviceInsertActions | undefined>;
  canCreateTrack: Accessor<boolean>;
  tracks: Accessor<Track[]>;
  trackLayout: Accessor<TimelineTrackLayoutRow[]>;
  returnTrackLayout: Accessor<TimelineTrackLayoutRow[]>;
  returnSectionElement: () => HTMLDivElement | undefined;
  masterTimelineElement: () => HTMLDivElement | undefined;
  timelineSurfaceElement: () => HTMLDivElement | undefined;
  scrollElement: () => HTMLDivElement | undefined;
  effectsChainElement: () => HTMLElement | undefined;
  currentEffectsTargetId: Accessor<Track["id"] | "master">;
  handleInsertSample: (sample: SampleDragData) => void | Promise<void>;
  onDeviceDrop: (payload: BrowserDragPayload, target: BrowserDropTarget) => void | Promise<void>;
  onExternalPluginInsertionResult?: (title: string, message: string) => void;
  onExternalPluginInserted?: (processor: ExternalProcessor) => void | Promise<void>;
  enableNativePlayback?: () => void;
};

const effectChainItemId = (preset: AudioEffectChainPreset) => `builtin:audio-effect-chain:${preset.id}`;
const instrumentPresetItemId = (preset: InstrumentPreset) => `builtin:instrument-preset:${preset.id}`;
const externalPluginItemId = (selection: NativeVst3CatalogSelection) => (
  `vst3:${selection.entry.binaryFingerprint ?? "unscanned"}:${selection.pluginClass.classId}`
);

export const filterNativeVst3CatalogSelections = (
  selections: readonly NativeVst3CatalogSelection[],
  role: "effect" | "instrument",
) => selections.filter((selection) => selection.pluginClass.role === role);

const visibleBrowserSections = (sections: BrowserSection[]): BrowserSection[] => {
  const visibleSections: BrowserSection[] = [];
  for (const section of sections) {
    if (section.leafCount > 0) visibleSections.push(section);
  }
  return visibleSections;
};

const visibleAssetSections = (sections: BrowserSection[]): BrowserSection[] => (
  sections.filter((section) => section.id === "project-samples" || section.leafCount > 0)
);

const createBrowserSection = (id: string, label: string, rows: BrowserTreeRow[]): BrowserSection => ({
  id,
  label,
  rows,
  leafCount: countBrowserTreeLeaves(rows),
});

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

type RenameFolderDraft = {
  folderId: string;
  projectId: string;
  name: string;
};

export function useTimelineBrowserController(options: Options): Accessor<TimelineLeftBrowserModel> {
  const [renameFolderDraft, setRenameFolderDraft] = createSignal<RenameFolderDraft | null>(null);
  const [renameFolderBusy, setRenameFolderBusy] = createSignal(false);
  const [desktopPluginEntries, setDesktopPluginEntries] = createSignal<DesktopPluginCatalogEntry[]>([]);
  const [insertingExternalPluginId, setInsertingExternalPluginId] = createSignal<string>();
  const [externalPluginStatusById, setExternalPluginStatusById] = createSignal<Record<string, string>>({});
  const refreshDesktopPluginCatalog = async () => {
    const bridge = window.dawDesktop?.pluginCatalog
    if (!bridge) return
    try {
      const result = await bridge.read()
      if ("catalog" in result) setDesktopPluginEntries(result.catalog.entries)
    } catch {
      setDesktopPluginEntries([])
    }
  }
  onMount(() => {
    if (!window.dawDesktop?.pluginCatalog) return
    void refreshDesktopPluginCatalog()
    const listener = () => void refreshDesktopPluginCatalog()
    window.addEventListener("daw-plugin-catalog-changed", listener)
    onCleanup(() => window.removeEventListener("daw-plugin-catalog-changed", listener))
  })
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
        leafCount: children.length,
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
        leafCount: unfiled.length,
        children: unfiled.map(createBrowserLeafRow),
      });
    }
    const filteredProjectRows = filterBrowserTreeRows(projectRows, query);
    const filteredDefaultRows = filterBrowserTreeRows(defaultItems.map(createBrowserLeafRow), query);
    return visibleAssetSections([
      createBrowserSection("project-samples", "Project", filteredProjectRows),
      createBrowserSection("default-samples", "Default", filteredDefaultRows),
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
  const desktopPluginSelections = createMemo<NativeVst3CatalogSelection[]>(() => (
    desktopPluginEntries().flatMap((entry) => entry.classes.map((pluginClass) => ({ entry, pluginClass })))
  ));
  const desktopPluginSelectionById = createMemo(() => {
    const selections = new Map<string, NativeVst3CatalogSelection>();
    for (const selection of desktopPluginSelections()) selections.set(externalPluginItemId(selection), selection);
    return selections;
  });
  const externalPluginItem = (selection: NativeVst3CatalogSelection): BrowserItem => {
    const id = externalPluginItemId(selection);
    const targetId = options.currentEffectsTargetId();
    const availability = nativeVst3InsertionAvailability({
      selection,
      projectId: options.projectId(),
      targetId,
      targetTrack: options.tracks().find((track) => track.id === targetId),
      canWrite: options.deviceInsertActions()?.canWrite === true,
      bridgeAvailable: window.dawDesktop?.pluginCatalog !== undefined,
      busy: insertingExternalPluginId() !== undefined,
    });
    const roleLabel = selection.pluginClass.role === "instrument" ? "instrument" : "effect";
    const catalogDetails = `${selection.pluginClass.vendor} · VST3 ${roleLabel} · ${vst3ScanHealthLabel(selection.entry.scanHealth)}`;
    return {
      id,
      source: "external-catalog",
      category: "external-plugin",
      label: selection.pluginClass.name,
      subtitle: availability.enabled
        ? externalPluginStatusById()[id] ?? `${catalogDetails} · ${availability.message}`
        : `${catalogDetails} · ${availability.message}`,
      searchText: `${selection.pluginClass.name} ${selection.pluginClass.vendor} vst3 ${selection.pluginClass.role} ${vst3ScanHealthLabel(selection.entry.scanHealth)} ${availability.enabled ? "eligible" : availability.code}`.toLowerCase(),
      disabled: !availability.enabled,
    };
  };
  const browserEffectItems = createMemo<BrowserItem[]>(() => {
    const actions = options.deviceInsertActions();
    return [...BROWSER_AUDIO_EFFECT_CATALOG, ...BROWSER_MIDI_EFFECT_CATALOG].map((entry) => ({
      id: entry.id,
      source: "builtin",
      category: entry.category,
      label: entry.label,
      subtitle: entry.description,
      searchText: deviceCatalogSearchText(entry),
      disabled: actions === undefined,
    }));
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
        leafCount: items.length,
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
    const chainRows = browserEffectChainRows();
    const rows = filterBrowserTreeRows([
      {
        kind: "folder",
        id: "builtin-audio-effects",
        source: "builtin",
        label: "Audio Effects",
        searchText: "audio effects builtin",
        leafCount: audioEffectItems.length,
        children: audioEffectItems.map(createBrowserLeafRow),
      },
      {
        kind: "folder",
        id: "builtin-audio-effect-chains",
        source: "builtin",
        label: "Audio Effect Chains",
        searchText: "audio effect chains presets builtin",
        leafCount: countBrowserTreeLeaves(chainRows),
        children: chainRows,
      },
      {
        kind: "folder",
        id: "builtin-midi-effects",
        source: "builtin",
        label: "MIDI Effects",
        searchText: "midi effects builtin",
        leafCount: midiEffectItems.length,
        children: midiEffectItems.map(createBrowserLeafRow),
      },
    ], browserDeviceQuery("effects"));
    const sections = [
      createBrowserSection("builtin-effects", "Builtin", rows),
    ];
    const pluginRows = filterBrowserTreeRows(filterNativeVst3CatalogSelections(desktopPluginSelections(), "effect")
      .map((selection) => createBrowserLeafRow(externalPluginItem(selection))), browserDeviceQuery("effects"));
    if (pluginRows.length > 0) {
      sections.push(createBrowserSection("vst3-discovery", "VST3 Plug-ins", pluginRows));
    }
    return visibleBrowserSections(sections);
  });
  const browserInstrumentItems = createMemo<BrowserItem[]>(() => {
    const actions = options.deviceInsertActions();
    return BROWSER_INSTRUMENT_CATALOG.map((entry) => ({
      id: entry.id,
      source: "builtin",
      category: entry.category,
      label: entry.label,
      subtitle: entry.description,
      searchText: deviceCatalogSearchText(entry),
      disabled: actions === undefined,
    }));
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
        leafCount: items.length,
        children: items.map(createBrowserLeafRow),
      });
    }
    return [...folders, ...unfiled.map(createBrowserLeafRow)];
  });
  const browserInstrumentSections = createMemo(() => {
    const instrumentItems = browserInstrumentItems();
    const presetRows = browserInstrumentPresetRows();
    const rows = filterBrowserTreeRows([
      {
        kind: "folder",
        id: "builtin-instruments",
        source: "builtin",
        label: "Instruments",
        searchText: "instruments builtin",
        leafCount: instrumentItems.length,
        children: instrumentItems.map(createBrowserLeafRow),
      },
      {
        kind: "folder",
        id: "builtin-instrument-presets",
        source: "builtin",
        label: "Instrument Presets",
        searchText: "instrument presets builtin",
        leafCount: countBrowserTreeLeaves(presetRows),
        children: presetRows,
      },
    ], browserDeviceQuery("midi-instruments"));
    const sections = [
      createBrowserSection("builtin-midi-instruments", "Builtin", rows),
    ];
    const pluginRows = filterBrowserTreeRows(filterNativeVst3CatalogSelections(desktopPluginSelections(), "instrument")
      .map((selection) => createBrowserLeafRow(externalPluginItem(selection))), browserDeviceQuery("midi-instruments"));
    if (pluginRows.length > 0) {
      sections.push(createBrowserSection("vst3-discovery-instruments", "VST3 Plug-ins", pluginRows));
    }
    return visibleBrowserSections(sections);
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

  const runAssetFolderAction = (action: () => Promise<void>) => {
    void action().catch((error) => {
      console.warn("Asset folder action failed", error);
    });
  };

  const currentProjectId = () => options.projectId();
  const nextAssetFolderName = () => {
    const usedNames = new Set(assetFolders.folders().map((folder) => folder.name.toLowerCase()));
    let suffix = 1;
    let name = "New Folder";
    while (usedNames.has(name.toLowerCase())) {
      suffix += 1;
      name = `New Folder ${suffix}`;
    }
    return name;
  };
  const normalizeAssetFolderName = (name: string) => name.trim() || "Folder";
  const renameFolderId = () => renameFolderDraft()?.folderId ?? null;
  const renameFolderName = () => renameFolderDraft()?.name ?? "";
  const setRenameFolderName = (name: string) =>
    setRenameFolderDraft((draft) => draft ? { ...draft, name } : draft);
  const clearRenameAssetFolder = () => setRenameFolderDraft(null);

  createEffect(() => {
    const draft = renameFolderDraft();
    if (!draft || renameFolderBusy()) return;
    if (draft.projectId !== currentProjectId() || !browserProjectFolderById().has(draft.folderId)) {
      clearRenameAssetFolder();
    }
  });

  const createAssetFolder = () => {
    const name = nextAssetFolderName();
    runAssetFolderAction(async () => {
      const projectId = currentProjectId();
      if (!projectId) return;
      if (isLocalId("project", projectId)) {
        await createLocalAssetFolder(projectId, name);
        assetFolders.refreshFolders();
        return;
      }
      await convexClient.mutation(convexApi.assetFolders.create, { projectId, name });
    });
  };

  const renameAssetFolder = (folderId: string) => {
    if (renameFolderBusy()) return;
    const projectId = currentProjectId();
    const folder = browserProjectFolderById().get(folderId);
    if (!projectId || !folder) return;
    setRenameFolderDraft({ folderId, projectId, name: folder.name });
  };

  const cancelRenameAssetFolder = () => {
    if (!renameFolderBusy()) clearRenameAssetFolder();
  };

  const confirmRenameAssetFolder = () => {
    if (renameFolderBusy()) return;
    const draft = renameFolderDraft();
    if (!draft) return;
    const projectId = draft.projectId;
    const folder = browserProjectFolderById().get(draft.folderId);
    const name = normalizeAssetFolderName(draft.name);
    if (!projectId || !folder || folder.name === name) {
      clearRenameAssetFolder();
      return;
    }
    setRenameFolderBusy(true);
    runAssetFolderAction(async () => {
      try {
        if (isLocalId("project", projectId)) {
          await renameLocalAssetFolder(projectId, draft.folderId, name);
          assetFolders.refreshFolders();
        } else {
          await convexClient.mutation(convexApi.assetFolders.rename, { projectId, folderId: draft.folderId, name });
        }
        if (untrack(renameFolderId) === draft.folderId) clearRenameAssetFolder();
      } finally {
        setRenameFolderBusy(false);
      }
    });
  };

  const deleteAssetFolder = (folderId: string) => {
    const projectId = currentProjectId();
    const folderHasSamples = Boolean(folderSampleCountById().get(folderId));
    runAssetFolderAction(async () => {
      if (!projectId || folderHasSamples) return;
      if (isLocalId("project", projectId)) {
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
      if (isLocalId("project", projectId)) {
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
    const device = BROWSER_DEVICE_CATALOG.find((entry) => entry.id === itemId);
    if (device) return device.payload;
    const chain = browserEffectChainPresetByItemId().get(itemId);
    if (chain) return { kind: "audio-effect-chain", chain, label: chain.name };
    const preset = browserInstrumentPresetByItemId().get(itemId);
    if (preset) return { kind: "instrument-preset", preset, label: preset.name };
    return undefined;
  };

  const addExternalPlugin = async (itemId: string, selection: NativeVst3CatalogSelection) => {
    const projectId = options.projectId();
    const targetId = options.currentEffectsTargetId();
    const targetTrack = options.tracks().find((track) => track.id === targetId);
    const actions = options.deviceInsertActions();
    const availability = nativeVst3InsertionAvailability({
      selection,
      projectId,
      targetId,
      targetTrack,
      canWrite: actions?.canWrite === true,
      bridgeAvailable: window.dawDesktop?.pluginCatalog !== undefined,
      busy: insertingExternalPluginId() !== undefined,
    });
    if (!availability.enabled || !window.dawDesktop?.pluginCatalog) {
      options.onExternalPluginInsertionResult?.("VST3 insertion unavailable", availability.message);
      return;
    }
    setInsertingExternalPluginId(itemId);
    try {
      const result = await insertNativeVst3Effect({
        projectId,
        targetId,
        targetTrack,
        selection,
        bridge: window.dawDesktop.pluginCatalog,
        validateBeforePersist: () => (
          options.projectId() === projectId
          && options.currentEffectsTargetId() === targetId
          && options.tracks().some((track) => track.id === targetId)
        ),
      });
      const message = result.ok
        ? "Enabled · Preflight passed. Playback uses the native VST3 graph; browser playback remains unsupported."
        : result.message;
      if (result.ok) options.enableNativePlayback?.();
      setExternalPluginStatusById((statuses) => ({ ...statuses, [itemId]: message }));
      if (!result.ok) {
        options.onExternalPluginInsertionResult?.("VST3 insertion failed", message);
        return;
      }
      try {
        await options.onExternalPluginInserted?.(result.processor);
      } catch (error) {
        options.onExternalPluginInsertionResult?.(
          "Native VST3 playback update failed",
          error instanceof Error ? error.message : "The active native graph could not be rebuilt.",
        );
      }
    } catch {
      const message = "The native VST3 host preflight failed.";
      setExternalPluginStatusById((statuses) => ({ ...statuses, [itemId]: message }));
      options.onExternalPluginInsertionResult?.("VST3 insertion failed", message);
    } finally {
      setInsertingExternalPluginId(undefined);
    }
  };

  const addBrowserEffect = (itemId: string) => {
    const externalPlugin = desktopPluginSelectionById().get(itemId);
    if (externalPlugin?.pluginClass.role === "effect") {
      void addExternalPlugin(itemId, externalPlugin);
      return;
    }
    const payload = resolveBrowserDevicePayload(itemId);
    const actions = options.deviceInsertActions();
    if (!payload || !actions?.canWrite) return;
    if (payload.kind === "audio-effect") {
      const targetId = options.currentEffectsTargetId();
      void actions.addAudioEffectToTarget(targetId, payload.effect);
      return;
    }
    if (payload.kind === "audio-effect-chain") {
      const targetId = options.currentEffectsTargetId();
      void actions.addAudioEffectChainToTarget(targetId, payload.chain);
      return;
    }
    if (payload.kind === "midi-effect") {
      const targetId = options.currentEffectsTargetId();
      if (targetId === "master" || !actions.canAddArpeggiatorToTarget(targetId)) return;
      void actions.addArpeggiatorToTarget(targetId);
    }
  };

  const addBrowserInstrument = (itemId: string) => {
    const externalPlugin = desktopPluginSelectionById().get(itemId);
    if (externalPlugin?.pluginClass.role === "instrument") {
      void addExternalPlugin(itemId, externalPlugin);
      return;
    }
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
    trackLayout: options.trackLayout,
    returnTrackLayout: options.returnTrackLayout,
    returnSectionElement: options.returnSectionElement,
    masterTimelineElement: options.masterTimelineElement,
    timelineSurfaceElement: options.timelineSurfaceElement,
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
  const controller = createMemo(() => ({
    open: options.leftBrowser.open(),
    widthPx: options.leftBrowser.widthPx(),
    activeTab: options.leftBrowser.activeTab(),
    searchQueryByTab: options.leftBrowser.searchQueryByTab(),
    scrollTopByTab: options.leftBrowser.scrollTopByTab(),
    treeExpansionByTab: options.leftBrowser.treeExpansionByTab(),
    assets: {
      sections: browserAssetSections,
      folderOptions,
      renameFolderInline: {
        folderId: renameFolderId,
        name: renameFolderName,
        busy: renameFolderBusy,
        setName: setRenameFolderName,
        onConfirm: confirmRenameAssetFolder,
        onCancel: cancelRenameAssetFolder,
      },
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
  return controller;
}
