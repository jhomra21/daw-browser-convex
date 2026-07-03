import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

export type AppMessageDialogState = {
  title: string;
  message: string;
};

type AppMessageDialogProps = {
  state: AppMessageDialogState | null;
  onOpenChange: (open: boolean) => void;
};

export default function AppMessageDialog(props: AppMessageDialogProps) {
  return (
    <Dialog open={Boolean(props.state)} onOpenChange={props.onOpenChange}>
      <DialogContent class="border border-border bg-app-surface text-foreground">
        <DialogHeader>
          <DialogTitle>{props.state?.title ?? ""}</DialogTitle>
          <DialogDescription>{props.state?.message ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
