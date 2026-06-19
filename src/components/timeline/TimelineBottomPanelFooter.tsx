import { type Component } from "solid-js";
import { Button } from "~/components/ui/button";
import { BOTTOM_PANEL_FOOTER_HEIGHT_PX } from "~/lib/bottom-panel-layout";
import { cn } from "~/lib/utils";

type TimelineBottomPanelFooterProps = {
  activeTab: "effects" | "clip";
  toggleLabel: "Hide" | "Show";
  onEffectsTabClick: () => void;
  onClipTabClick?: () => void;
  onToggle: () => void;
};

const TimelineBottomPanelFooter: Component<TimelineBottomPanelFooterProps> = (props) => {
  const tabClass = (active: boolean) => cn(
    "h-full border-x px-3 text-[11px] font-semibold uppercase tracking-wide",
    active ? "border-neutral-700 bg-neutral-800 text-neutral-100" : "border-neutral-800 text-neutral-500",
  );

  return (
    <div
      class="flex shrink-0 items-center justify-between border-t border-neutral-800 bg-neutral-950"
      style={{ height: `${BOTTOM_PANEL_FOOTER_HEIGHT_PX}px` }}
    >
      <div class="flex h-full items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class={tabClass(props.activeTab === "effects")}
          onClick={props.onEffectsTabClick}
        >
          Effects
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class={tabClass(props.activeTab === "clip")}
          disabled={props.activeTab !== "clip" && !props.onClipTabClick}
          onClick={props.onClipTabClick}
        >
          Clip
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="h-full border-x border-neutral-700 bg-neutral-900 px-3 text-[11px] font-semibold uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
        onClick={props.onToggle}
      >
        {props.toggleLabel}
      </Button>
    </div>
  );
};

export default TimelineBottomPanelFooter;
