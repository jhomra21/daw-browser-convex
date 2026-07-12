import { type Component, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { automationEnvelopeValueRange, automationTargetKey, type AutomationEnvelope, type AutomationParameterSelection, type AutomationTargetDeviceInstance } from "@daw-browser/shared";
import { normalizeMasterVolume } from "@daw-browser/shared";
import { TIMELINE_SIDEBAR_MIN_WIDTH } from "~/lib/timeline-layout";
import { LANE_HEIGHT, clampAutomationLaneHeight } from "~/lib/timeline-utils";
import { cn } from "~/lib/utils";
import AutomationParameterPicker from "./automation-parameter-picker";
import TimelineContextMenu, { type TimelineContextMenuItem } from "./context-menu/timeline-context-menu";

export type MasterSidebarModel = {
  selected: boolean;
  ready: boolean;
  canEditVolume: boolean;
  volume: number;
  collapsed: boolean;
  onClick: () => void;
  onToggleCollapsed: () => void;
  onVolumePreview: (volume: number) => void;
  onVolumeChange: (volume: number) => void;
};

export const MASTER_ROW_HEIGHT = Math.round(LANE_HEIGHT / 2);

type MasterSidebarRowProps = {
  master: MasterSidebarModel;
  sidebarWidth: number;
  bottomOffsetPx: number;
  automation: {
    visible: boolean;
    heightPx: number;
    selected: AutomationParameterSelection;
    effects: readonly AutomationTargetDeviceInstance[];
    automatedTargetKeys: ReadonlySet<string>;
    selectedEnvelope: AutomationEnvelope | undefined;
    evaluatedValuesByTargetKey: ReadonlyMap<string, number>;
    onToggleVisibility: () => void;
    onResizeLane: (heightPx: number) => void;
    onSelectParameter: (selection: AutomationParameterSelection) => void;
    onManualAutomationOverride: () => void;
  };
};

const MasterSidebarRow: Component<MasterSidebarRowProps> = (props) => {
  const master = () => props.master;
  const [activeVolume, setActiveVolume] = createSignal<number | undefined>();
  const committedVolume = () => normalizeMasterVolume(master().volume);
  const displayMasterVolume = () => activeVolume()
    ?? props.automation.evaluatedValuesByTargetKey.get(automationTargetKey({ kind: "master" }, "volume"))
    ?? committedVolume();
  const previewVolume = (volume: number) => {
    if (!master().canEditVolume) return;
    const nextVolume = normalizeMasterVolume(volume);
    setActiveVolume((current) => current === nextVolume ? current : nextVolume);
    master().onVolumePreview(nextVolume);
  };
  const commitVolume = () => {
    if (!master().canEditVolume) return;
    const nextVolume = activeVolume();
    if (nextVolume === undefined) return;
    setActiveVolume(undefined);
    if (nextVolume === committedVolume()) return;
    master().onVolumeChange(nextVolume);
  };
  const cancelVolume = () => {
    setActiveVolume(undefined);
    master().onVolumePreview(committedVolume());
  };
  const automationHeight = () => props.automation.heightPx;
  const rowHeight = () => MASTER_ROW_HEIGHT + (!master().collapsed && props.automation.visible ? automationHeight() : 0);
  const volumeAutomated = () => props.automation.automatedTargetKeys.has(
    automationTargetKey({ kind: "master" }, "volume"),
  );
  const volumeEnvelope = createMemo(() => (
    props.automation.selected.parameterId === "volume" && props.automation.selected.effectInstanceId === undefined
      ? props.automation.selectedEnvelope
      : undefined
  ));
  const volumeRange = () => volumeEnvelope() ? automationEnvelopeValueRange(volumeEnvelope(), { min: 0, max: 1 }) : undefined;
  let cleanupAutomationResize: (() => void) | undefined;
  const startAutomationResize = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = automationHeight();
    const move = (moveEvent: PointerEvent) => {
      props.automation.onResizeLane(clampAutomationLaneHeight(startHeight + moveEvent.clientY - startY));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      if (cleanupAutomationResize === cleanup) cleanupAutomationResize = undefined;
    };
    cleanupAutomationResize?.();
    cleanupAutomationResize = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  };
  onCleanup(() => cleanupAutomationResize?.());

  const contextMenuItems = (): TimelineContextMenuItem[] => [
    { kind: "label", label: "Master" },
    { kind: "item", label: "Open effects", onSelect: master().onClick },
    { kind: "item", label: master().collapsed ? "Expand master" : "Collapse master", onSelect: master().onToggleCollapsed },
    {
      kind: "item",
      label: props.automation.visible ? "Hide master automation lane" : "Show master automation lane",
      disabled: master().collapsed,
      onSelect: props.automation.onToggleVisibility,
    },
  ];

  const row = (
    <div
      class={cn(
        "sticky z-30 [box-shadow:inset_0_1px_0_rgb(38_38_38)]",
        master().selected ? "bg-timeline-surface-muted" : "bg-timeline-surface",
      )}
      style={{
        bottom: `${props.bottomOffsetPx}px`,
        height: `${rowHeight()}px`,
        width: `${props.sidebarWidth}px`,
        "min-width": `${TIMELINE_SIDEBAR_MIN_WIDTH}px`,
      }}
      onClick={master().onClick}
    >
      <div
        class={cn(
          "grid items-center gap-x-4",
          master().collapsed ? "px-2 py-0.5" : "p-2",
        )}
        style={{
          height: `${MASTER_ROW_HEIGHT}px`,
          "grid-template-columns": master().collapsed
            ? "minmax(0,1fr)"
            : "minmax(72px,96px) minmax(96px,1fr) 92px",
        }}
      >
        <div class="flex min-w-0 items-center gap-1 overflow-hidden">
          <button
            class={cn(
              "flex w-4 shrink-0 items-center justify-center text-xs text-muted-foreground hover:text-foreground",
              master().collapsed ? "h-6" : "h-7",
            )}
            onClick={(event) => {
              event.stopPropagation();
              master().onToggleCollapsed();
            }}
            title={master().collapsed ? "Expand master" : "Collapse master"}
          >
            {master().collapsed ? "▶" : "▼"}
          </button>
          <button
            class={cn(
              "flex flex-1 items-center justify-center border px-2 text-center text-sm font-semibold",
              master().collapsed ? "h-6" : "h-7",
              master().selected
                ? "border-border bg-muted"
                : "border-border hover:border-border",
            )}
            style={{ "border-width": "0.5px" }}
            onClick={(event) => {
              event.stopPropagation();
              master().onClick();
            }}
            title="Show master effects"
          >
            Master
          </button>
        </div>
        <Show when={!master().collapsed}>
          <div class="flex h-7 items-center border border-border bg-timeline-background px-2 text-xs text-foreground">
            Master Out
          </div>
        </Show>
        <Show when={!master().collapsed}>
          <div class="flex w-[92px] items-center gap-2">
            <div class="flex h-7 w-[72px] shrink-0 items-center gap-1 px-0.5">
              <Show when={master().ready}>
                <div class="relative flex flex-1 items-center">
                  <Show when={volumeAutomated()}>
                    <span class="absolute right-0 top-0 z-10 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.75)]" />
                  </Show>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={displayMasterVolume()}
                    disabled={!master().canEditVolume}
                    style={{
                      "--track-volume-percent": `${displayMasterVolume() * 100}%`,
                      "--track-volume-automation-start": `${(volumeRange()?.min ?? 0) * 100}%`,
                      "--track-volume-automation-end": `${(volumeRange()?.max ?? 0) * 100}%`,
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={() => {
                      props.automation.onSelectParameter({ parameterId: "volume" });
                      props.automation.onManualAutomationOverride();
                    }}
                    onInput={(event) => {
                      event.stopPropagation();
                      previewVolume(parseFloat(event.currentTarget.value));
                    }}
                    onChange={commitVolume}
                    onPointerUp={commitVolume}
                    onPointerCancel={cancelVolume}
                    class={cn(
                      "track-volume-slider w-full cursor-pointer disabled:cursor-not-allowed",
                      volumeEnvelope() && "track-volume-slider-automated",
                    )}
                    title="Master volume"
                  />
                </div>
              </Show>
              <button
                class={cn(
                  "h-7 w-7 shrink-0 border text-xs font-semibold transition-colors",
                  props.automation.visible
                    ? "border-red-400 bg-red-500/90 text-black"
                    : "border-border bg-timeline-surface-muted text-red-300 hover:bg-red-500/20",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.automation.onToggleVisibility();
                }}
                title={props.automation.visible ? "Hide master automation lane" : "Show master automation lane"}
              >
                A
              </button>
            </div>
            <div class="h-8 w-[12px] shrink-0 bg-timeline-background/70" />
          </div>
        </Show>
      </div>
      <Show when={!master().collapsed && props.automation.visible}>
        <div
          class="relative grid grid-cols-[minmax(72px,96px)_minmax(96px,1fr)_92px] items-center gap-x-4 border-t border-automation/30 bg-timeline-background/95 px-2 text-[11px] text-error-foreground"
          style={{ height: `${automationHeight()}px` }}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            class="absolute inset-x-0 top-0 h-2 -translate-y-1/2 cursor-row-resize"
            onPointerDown={startAutomationResize}
          />
          <div class="flex items-center gap-1 overflow-hidden">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" classList={{ "opacity-30": !props.automation.selectedEnvelope }} />
            <span class="truncate">Automation</span>
          </div>
          <AutomationParameterPicker
            target={{ kind: "master" }}
            effects={props.automation.effects}
            value={props.automation.selected}
            automatedTargetKeys={props.automation.automatedTargetKeys}
            onChange={props.automation.onSelectParameter}
          />
          <div class="truncate text-right text-red-200/70">
            {props.automation.selectedEnvelope?.points.length ?? 0} pts
          </div>
        </div>
      </Show>
    </div>
  );

  return (
    <TimelineContextMenu items={contextMenuItems}>
      {row}
    </TimelineContextMenu>
  );
};

export default MasterSidebarRow;
