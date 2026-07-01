import { type Component, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { automationEnvelopeValueRange, type AutomationEnvelope } from "@daw-browser/shared";
import { normalizeMasterVolume } from "@daw-browser/shared";
import { TIMELINE_SIDEBAR_MIN_WIDTH } from "~/lib/timeline-layout";
import { DEFAULT_AUTOMATION_LANE_HEIGHT, LANE_HEIGHT, clampAutomationLaneHeight } from "~/lib/timeline-utils";
import { cn } from "~/lib/utils";
import AutomationParameterPicker from "./automation-parameter-picker";
import TimelineContextMenu, { type TimelineContextMenuItem } from "./context-menu/timeline-context-menu";

export type MasterSidebarModel = {
  selected: boolean;
  ready: boolean;
  canEditVolume: boolean;
  volume: number;
  onClick: () => void;
  onVolumePreview: (volume: number) => void;
  onVolumeChange: (volume: number) => void;
};

export const MASTER_ROW_HEIGHT = Math.round(LANE_HEIGHT / 2);

type MasterSidebarRowProps = {
  master: MasterSidebarModel;
  sidebarWidth: number;
  bottomOffsetPx: number;
  automation?: {
    visible: boolean;
    heightPx: number;
    selectedParameterId: string;
    automatedParameterIds: ReadonlySet<string>;
    selectedEnvelope: AutomationEnvelope | undefined;
    onToggleVisibility: () => void;
    onResizeLane: (heightPx: number) => void;
    onSelectParameter: (parameterId: string) => void;
  };
};

const MasterSidebarRow: Component<MasterSidebarRowProps> = (props) => {
  const master = () => props.master;
  const [activeVolume, setActiveVolume] = createSignal<number | undefined>();
  const committedVolume = () => normalizeMasterVolume(master().volume);
  const displayMasterVolume = () => activeVolume() ?? committedVolume();
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
  const automationHeight = () => props.automation?.heightPx ?? DEFAULT_AUTOMATION_LANE_HEIGHT;
  const rowHeight = () => MASTER_ROW_HEIGHT + (props.automation?.visible ? automationHeight() : 0);
  const volumeAutomated = () => props.automation?.automatedParameterIds.has("volume") ?? false;
  const volumeEnvelope = createMemo(() => (
    props.automation?.selectedParameterId === "volume" ? props.automation.selectedEnvelope : undefined
  ));
  const volumeRange = () => volumeEnvelope() ? automationEnvelopeValueRange(volumeEnvelope(), { min: 0, max: 1 }) : undefined;
  let cleanupAutomationResize: (() => void) | undefined;
  const startAutomationResize = (event: PointerEvent) => {
    const automation = props.automation;
    if (!automation) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = automationHeight();
    const move = (moveEvent: PointerEvent) => {
      automation.onResizeLane(clampAutomationLaneHeight(startHeight + moveEvent.clientY - startY));
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
    {
      kind: "item",
      label: props.automation?.visible ? "Hide master automation lane" : "Show master automation lane",
      disabled: !props.automation,
      onSelect: () => props.automation?.onToggleVisibility(),
    },
  ];

  const row = (
    <div
      class={cn(
        "fixed right-0 z-30 [box-shadow:inset_0_1px_0_rgb(38_38_38)]",
        master().selected ? "bg-neutral-800" : "bg-neutral-900",
      )}
      style={{
        bottom: `${props.bottomOffsetPx}px`,
        height: `${rowHeight()}px`,
        width: `${props.sidebarWidth}px`,
        "min-width": `${TIMELINE_SIDEBAR_MIN_WIDTH}px`,
      }}
      onClick={master().onClick}
    >
      <div class="grid grid-cols-[minmax(72px,96px)_minmax(96px,1fr)_92px] items-center gap-x-4 p-2" style={{ height: `${MASTER_ROW_HEIGHT}px` }}>
        <button
          class={cn(
            "flex h-7 w-full items-center justify-center border px-2 text-center text-sm font-semibold",
            master().selected
              ? "border-neutral-600 bg-neutral-700"
              : "border-neutral-700 hover:border-neutral-600",
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
        <div class="flex h-7 items-center border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-200">
          Master Out
        </div>
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
                  onPointerDown={() => props.automation?.onSelectParameter("volume")}
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
                props.automation?.visible
                  ? "border-red-400 bg-red-500/90 text-black"
                  : "border-neutral-700 bg-neutral-800 text-red-300 hover:bg-red-500/20",
              )}
              onClick={(event) => {
                event.stopPropagation();
                props.automation?.onToggleVisibility();
              }}
              title={props.automation?.visible ? "Hide master automation lane" : "Show master automation lane"}
            >
              A
            </button>
          </div>
          <div class="h-8 w-[12px] shrink-0 bg-neutral-950/70" />
        </div>
      </div>
      <Show when={props.automation?.visible && props.automation}>
        {(automation) => (
          <div
            class="relative grid grid-cols-[minmax(72px,96px)_minmax(96px,1fr)_92px] items-center gap-x-4 border-t border-red-500/30 bg-neutral-950/95 px-2 text-[11px] text-red-100"
            style={{ height: `${automationHeight()}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              class="absolute inset-x-0 top-0 h-2 -translate-y-1/2 cursor-row-resize"
              onPointerDown={startAutomationResize}
            />
            <div class="flex items-center gap-1 overflow-hidden">
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" classList={{ "opacity-30": !automation().selectedEnvelope }} />
              <span class="truncate">Automation</span>
            </div>
            <AutomationParameterPicker
              value={automation().selectedParameterId}
              automatedParameterIds={automation().automatedParameterIds}
              onChange={automation().onSelectParameter}
            />
            <div class="truncate text-right text-red-200/70">
              {automation().selectedEnvelope?.points.length ?? 0} pts
            </div>
          </div>
        )}
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
