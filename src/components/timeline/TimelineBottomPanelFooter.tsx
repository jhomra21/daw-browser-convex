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
    active ? "border-border bg-muted text-foreground" : "border-border text-muted-foreground",
  );

  return (
    <div
      class="flex shrink-0 items-center justify-between border-t border-border bg-background"
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
        class="h-full border-x border-border bg-app-surface px-3 text-[11px] font-semibold uppercase tracking-wide text-foreground hover:bg-muted"
        onClick={props.onToggle}
      >
        {props.toggleLabel}
      </Button>
    </div>
  );
};

export default TimelineBottomPanelFooter;
