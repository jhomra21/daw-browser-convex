import { Show, createSignal, type Component } from "solid-js";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useAppPreferences } from "~/context/app-preferences";
import { useAudioCpuLoad } from "~/hooks/useAudioCpuLoad";
import { cpuLoadPercent, cpuLoadValueText } from "~/lib/audio-cpu-load";
import { cn } from "~/lib/utils";

const tooltip = "Audio processing load: time to compute each audio buffer compared to its playback time.";

// Ableton's CPU meter: average in the lighter shade, current (peak) in the darker one, red once a buffer is late.
const CpuMeter: Component = () => {
  const cpuMeter = useAppPreferences().cpuMeter;
  const options = () => cpuMeter.preferences();
  const visible = () => options().average || options().current;
  const load = useAudioCpuLoad(visible);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const late = () => load().current >= 1;
  const barWidth = (value: number) => `${Math.min(1, Math.max(0, value)) * 100}%`;

  return (
    <div class="flex items-center" onContextMenu={(event) => {
      event.preventDefault();
      setMenuOpen(true);
    }}>
      <Show when={visible()}>
        <Tooltip>
          <TooltipTrigger
            as="div"
            role="meter"
            aria-label="Audio CPU load"
            aria-valuemin={0}
            aria-valuemax={999}
            aria-valuenow={cpuLoadPercent(options().text === "current" ? load().current : load().average)}
            aria-valuetext={cpuLoadValueText(load())}
            class="flex items-center gap-1.5 text-xs"
          >
            <div class="relative h-2 w-14 overflow-hidden border border-border bg-timeline-surface" aria-hidden="true">
              <Show when={options().current}>
                <div class={cn("absolute inset-y-0 left-0", late() ? "bg-red-500" : "bg-primary")} style={{ width: barWidth(load().current) }} />
              </Show>
              <Show when={options().average}>
                <div class={cn("absolute inset-y-0 left-0", late() ? "bg-red-400" : "bg-primary/50")} style={{ width: barWidth(load().average) }} />
              </Show>
            </div>
            <span class="w-[4ch] text-right tabular-nums text-foreground" aria-hidden="true">
              {cpuLoadPercent(options().text === "current" ? load().current : load().average)}%
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </Show>
      <DropdownMenu open={menuOpen()} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          as={Button}
          variant="ghost"
          size="icon"
          aria-label="CPU meter options"
          class="h-7 w-5 p-0 text-muted-foreground hover:bg-timeline-surface-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
        >
          <svg viewBox="0 0 10 10" class="h-2 w-2" aria-hidden="true">
            <path d="M1 3h8L5 8z" fill="currentColor" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="border-border bg-timeline-surface" style={{ width: "13rem" }}>
          <DropdownMenuCheckboxItem checked={options().average} onChange={cpuMeter.setAverage}>Average</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={options().current} onChange={cpuMeter.setCurrent}>Current</DropdownMenuCheckboxItem>
          <div class="px-2 pb-1 pt-2 text-xs text-muted-foreground">Meter text shows</div>
          <DropdownMenuRadioGroup
            value={options().text}
            onChange={(value) => cpuMeter.setText(value === "current" ? "current" : "average")}
          >
            <DropdownMenuRadioItem value="average">Average</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="current">Current</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default CpuMeter;
