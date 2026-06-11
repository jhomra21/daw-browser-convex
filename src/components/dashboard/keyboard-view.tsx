import { For } from "solid-js";
import { timelineKeyboardShortcuts } from "./shortcut-registry";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";

export function DashboardKeyboardView() {
  return <DashboardScrollView><DashboardSection title="Keyboard shortcuts" description="Read-only list of timeline shortcuts."><For each={timelineKeyboardShortcuts}>{(shortcut) => <DashboardRow label={shortcut.label} value={shortcut.section} action={<kbd class="border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300">{shortcut.keys}</kbd>} />}</For></DashboardSection></DashboardScrollView>;
}
