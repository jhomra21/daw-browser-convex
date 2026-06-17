import { type Component, Show, createSignal } from "solid-js";
import { normalizeMasterVolume } from "@daw-browser/shared";
import { TIMELINE_SIDEBAR_MIN_WIDTH } from "~/lib/timeline-layout";
import { LANE_HEIGHT } from "~/lib/timeline-utils";
import { cn } from "~/lib/utils";

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

  return (
    <div
      class={cn(
        "fixed right-0 z-30 [box-shadow:inset_0_1px_0_rgb(38_38_38)]",
        master().selected ? "bg-neutral-800" : "bg-neutral-900",
      )}
      style={{
        bottom: `${props.bottomOffsetPx}px`,
        height: `${MASTER_ROW_HEIGHT}px`,
        width: `${props.sidebarWidth}px`,
        "min-width": `${TIMELINE_SIDEBAR_MIN_WIDTH}px`,
      }}
      onClick={master().onClick}
    >
      <div class="grid h-full grid-cols-[minmax(72px,96px)_minmax(96px,1fr)_92px] items-center gap-x-4 p-2">
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
          <div class="flex h-7 w-[72px] shrink-0 items-center px-0.5">
            <Show when={master().ready}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={displayMasterVolume()}
                disabled={!master().canEditVolume}
                style={{
                  "--track-volume-percent": `${displayMasterVolume() * 100}%`,
                }}
                onClick={(event) => event.stopPropagation()}
                onInput={(event) => {
                  event.stopPropagation();
                  previewVolume(parseFloat(event.currentTarget.value));
                }}
                onChange={commitVolume}
                onPointerUp={commitVolume}
                onPointerCancel={cancelVolume}
                class="track-volume-slider w-full cursor-pointer disabled:cursor-not-allowed"
                title="Master volume"
              />
            </Show>
          </div>
          <div class="h-8 w-[12px] shrink-0 bg-neutral-950/70" />
        </div>
      </div>
    </div>
  );
};

export default MasterSidebarRow;
