import { Show } from "solid-js";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

export type CloudBackupDialogState =
  | { type: "conflict"; message: string }
  | { type: "restore" }
  | { type: "message"; title: string; message: string };

type CloudBackupDialogProps = {
  state: CloudBackupDialogState | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onOverwriteCloud: () => void;
  onRestoreCloud: () => void;
  onDuplicateCloud: () => void;
};

export default function CloudBackupDialog(props: CloudBackupDialogProps) {
  const title = () => {
    const state = props.state;
    if (state?.type === "conflict") return "Cloud backup conflict";
    if (state?.type === "restore") return "Restore cloud backup?";
    return state?.title ?? "";
  };

  const message = () => {
    const state = props.state;
    if (state?.type === "conflict") return state.message;
    if (state?.type === "restore") return "This will replace local project data with the latest cloud backup. Local changes not in the cloud backup will be replaced.";
    return state?.message ?? "";
  };

  return (
    <Dialog open={Boolean(props.state)} onOpenChange={props.onOpenChange}>
      <DialogContent class="border border-neutral-800 bg-neutral-900 text-neutral-100">
        <DialogHeader>
          <DialogTitle>{title()}</DialogTitle>
          <DialogDescription>{message()}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={props.busy}>
            <Show when={props.state?.type === "message"} fallback="Cancel">
              Close
            </Show>
          </Button>
          <Show when={props.state?.type === "conflict"}>
            <Button variant="secondary" onClick={props.onDuplicateCloud} disabled={props.busy}>
              Duplicate cloud
            </Button>
            <Button variant="secondary" onClick={props.onRestoreCloud} disabled={props.busy}>
              Restore cloud
            </Button>
            <Button onClick={props.onOverwriteCloud} disabled={props.busy}>
              Keep local
            </Button>
          </Show>
          <Show when={props.state?.type === "restore"}>
            <Button variant="destructive" onClick={props.onRestoreCloud} disabled={props.busy}>
              Restore
            </Button>
          </Show>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
