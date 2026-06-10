import { For, Match, Show, Switch } from "solid-js";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import type { DashboardTimelineModel, DashboardView } from "./types";
import { DashboardSidebarItem } from "./dashboard-sidebar";
import { DashboardGeneralView } from "./general-view";
import { DashboardAccountView } from "./account-view";
import { DashboardProjectsView } from "./projects-view";
import { DashboardFilesView } from "./files-view";
import { DashboardSamplesView } from "./samples-view";
import { DashboardTimelineView } from "./timeline-view";
import { DashboardKeyboardView } from "./keyboard-view";
import { DashboardExportView } from "./export-view";

const items: readonly { view: DashboardView; label: string }[] = [
  { view: "general", label: "General" },
  { view: "projects", label: "Projects" },
  { view: "files", label: "Local Files" },
  { view: "samples", label: "Samples" },
  { view: "timeline", label: "Timeline / DAW" },
  { view: "keyboard", label: "Keyboard Shortcuts" },
  { view: "export", label: "Export" },
];

type DashboardProps = {
  view: DashboardView | null;
  setView: (view: DashboardView | null) => void;
  canClose?: boolean;
  model?: DashboardTimelineModel;
  onOpenProject?: (projectId: string) => void;
};

export function Dashboard(props: DashboardProps) {
  const selectedView = () => props.view;
  const canClose = () => props.canClose !== false;
  const close = () => {
    if (canClose()) props.setView(null);
  };

  return (
    <Show when={props.view}>
      <Dialog open preventScroll={false} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent
          showCloseButton={false}
          class="h-[min(90vh,42rem)] w-[min(94vw,64rem)] max-w-none overflow-hidden border-neutral-800 bg-neutral-950 p-0 text-neutral-100"
        >
          <div class="flex h-full min-h-0">
            <aside class="flex w-60 shrink-0 flex-col gap-1 border-r border-neutral-800 bg-neutral-900/80 p-3">
              <div class="px-3 py-2">
                <div class="text-sm font-semibold text-neutral-100">DAW Dashboard</div>
                <div class="text-xs text-neutral-500">Workspace management</div>
              </div>
              <nav class="flex flex-1 flex-col gap-1">
                <For each={items}>
                  {(item) => (
                    <DashboardSidebarItem
                      view={item.view}
                      label={item.label}
                      active={selectedView() === item.view}
                      onSelect={props.setView}
                    />
                  )}
                </For>
              </nav>
              <DashboardSidebarItem
                view="account"
                label="Account"
                active={selectedView() === "account"}
                onSelect={props.setView}
              />
            </aside>
            <section class="flex min-w-0 flex-1 flex-col">
              <Switch>
                <Match when={selectedView() === "general"}>
                  <DashboardGeneralView />
                </Match>
                <Match when={selectedView() === "account"}>
                  <DashboardAccountView />
                </Match>
                <Match when={selectedView() === "projects"}>
                  <DashboardProjectsView model={props.model} onOpenProject={props.onOpenProject} />
                </Match>
                <Match when={selectedView() === "files"}>
                  <DashboardFilesView model={props.model} />
                </Match>
                <Match when={selectedView() === "samples"}>
                  <DashboardSamplesView model={props.model} />
                </Match>
                <Match when={selectedView() === "timeline"}>
                  <DashboardTimelineView model={props.model} />
                </Match>
                <Match when={selectedView() === "keyboard"}>
                  <DashboardKeyboardView />
                </Match>
                <Match when={selectedView() === "export"}>
                  <DashboardExportView model={props.model} />
                </Match>
              </Switch>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </Show>
  );
}
