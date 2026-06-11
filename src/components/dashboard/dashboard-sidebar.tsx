import type { DashboardView } from "./types";
import { cn } from "~/lib/utils";

export function DashboardSidebarItem(props: { view: DashboardView; label: string; active: boolean; onSelect: (view: DashboardView) => void }) {
  return <button type="button" onClick={() => props.onSelect(props.view)} class={cn("h-9 px-3 text-left text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100", props.active && "bg-neutral-800 text-neutral-100")}>{props.label}</button>;
}
