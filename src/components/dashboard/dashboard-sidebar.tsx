import type { DashboardView } from "./types";
import { cn } from "~/lib/utils";

export function DashboardSidebarItem(props: { view: DashboardView; label: string; active: boolean; onSelect: (view: DashboardView) => void }) {
  return <button type="button" onClick={() => props.onSelect(props.view)} class={cn("h-9 px-3 text-left text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", props.active && "bg-sidebar-accent text-sidebar-accent-foreground")}>{props.label}</button>;
}
