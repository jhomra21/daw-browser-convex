import { For, Show } from "solid-js";
import { useProjectExports } from "~/hooks/useProjectExports";
import { copyText } from "~/lib/clipboard";
import type { DashboardTimelineModel } from "./types";
import { DashboardRow, DashboardScrollView, DashboardSection, EmptyDashboardState } from "./dashboard-shared";

export function DashboardExportView(props: { model?: DashboardTimelineModel }) {
  const exports = useProjectExports({
    projectId: () => props.model?.projectMenu.currentProjectId ?? "",
    userId: () => props.model?.projectMenu.currentUserId ?? "",
    enabled: () => props.model !== undefined,
  });

  return (
    <DashboardScrollView>
      <Show when={props.model} fallback={<EmptyDashboardState title="No project context" message="Open a project to manage exports." />} keyed>
        {(model) => (
          <DashboardSection title="Export" description="Use File > Export Mixdown for the export action.">
            <DashboardRow label="Current project" value={model.projectMenu.currentProjectId} />
            <div class="space-y-2">
              <div class="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
                Export history
              </div>
              <Show
                when={exports.exports().length > 0}
                fallback={<div class="rounded border border-dashed border-neutral-800 bg-neutral-950/60 px-3 py-3 text-sm text-neutral-500">No exports yet.</div>}
              >
                <For each={exports.exports()}>
                  {(item) => (
                    <div class="flex items-center justify-between gap-3 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2">
                      <button
                        type="button"
                        disabled={!item.url}
                        class="min-w-0 flex-1 text-left disabled:cursor-default"
                        onClick={() => {
                          if (item.url) window.open(item.url, "_blank");
                        }}
                      >
                        <span class="block truncate text-sm text-neutral-200">{item.name}</span>
                        <span class="block text-xs uppercase text-neutral-500">{item.format}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!item.url}
                        class="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void copyText(item.url)}
                      >
                        Copy URL
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </DashboardSection>
        )}
      </Show>
    </DashboardScrollView>
  );
}
