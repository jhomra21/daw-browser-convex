import { Button } from "~/components/ui/button";

type LocalSaveFailureBannerProps = {
  message: string;
  onExportArchive: () => void | Promise<void>;
  onDismiss: () => void;
};

export default function LocalSaveFailureBanner(props: LocalSaveFailureBannerProps) {
  return (
    <div class="border-b border-amber-900/60 bg-amber-950/50 px-4 py-3 text-sm text-amber-100">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="font-semibold">Local save needs attention</div>
          <div class="mt-1 text-amber-100/80">
            {props.message} Retry the last action after freeing browser storage,
            restoring folder permission, or exporting a backup copy.
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void props.onExportArchive()}>
            Export backup
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
