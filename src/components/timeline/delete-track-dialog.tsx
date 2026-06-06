import { type Component } from "solid-js";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { Track } from "@daw-browser/timeline-core/types";

type DeleteTrackDialogProps = {
  open: boolean;
  clipCount: number;
  pendingTrackId: Track["id"] | null;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: (trackId: Track["id"]) => void;
};

const DeleteTrackDialog: Component<DeleteTrackDialogProps> = (props) => (
  <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent class="bg-neutral-900 text-neutral-100 border border-neutral-800">
      <DialogHeader>
        <DialogTitle>Delete this track?</DialogTitle>
        <DialogDescription>
          {props.clipCount > 0
            ? `This track contains ${props.clipCount} audio clip${props.clipCount === 1 ? "" : "s"}. Deleting the track will remove them. This action cannot be undone.`
            : "This track has no audio clips. Deleting it cannot be undone."}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            if (props.pendingTrackId) props.onConfirm(props.pendingTrackId);
          }}
        >
          Delete Track
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default DeleteTrackDialog;
