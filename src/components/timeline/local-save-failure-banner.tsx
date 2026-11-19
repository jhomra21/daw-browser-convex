import { Show } from "solid-js";
import { Button } from "~/components/ui/button";

type LocalSaveFailureBannerProps = {
  message: string;
  onExportArchive?: () => void | Promise<void>;
  onDismiss: () => void;
};

export default function LocalSaveFailureBanner(props: LocalSaveFailureBannerProps) {
  return (
    <div class="border-b border-amber-900/60 bg-amber-950/50 px-4 py-3 text-sm text-amber-100">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="font-semibold">Changes could not be saved</div>
          <div class="mt-1 text-amber-100/80">
            {props.message}{" "}
            <Show when={props.onExportArchive} fallback="Retry the last action.">
              Retry the last action after freeing browser storage,
              restoring folder permission, or exporting a backup copy.
            </Show>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={props.onExportArchive}>
            {(exportArchive) => (
              <Button variant="secondary" size="sm" onClick={() => void exportArchive()()}>
                Export backup
              </Button>
            )}
          </Show>
          <Button variant="ghost" size="sm" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
