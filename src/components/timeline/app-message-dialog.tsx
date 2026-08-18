import { Show, createEffect, createSignal, type Accessor } from "solid-js";
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
  action?: {
    label: string;
    busyLabel: string;
    onAction: () => Promise<void>;
    enabled?: Accessor<boolean>;
  };
  cancelLabel?: string;
  trustAcknowledgement?: {
    acknowledged: Accessor<boolean>;
    onChange: (acknowledged: boolean) => void;
    disclosure: Readonly<Record<"title" | "body" | "acknowledgement", string>>;
  };
};

type AppMessageDialogProps = {
  state: AppMessageDialogState | null;
  onOpenChange: (open: boolean) => void;
};

export default function AppMessageDialog(props: AppMessageDialogProps) {
  const [busy, setBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal("");
  let previousState: AppMessageDialogState | null = null;

  createEffect(() => {
    const state = props.state;
    if (state === previousState) return;
    previousState = state;
    setBusy(false);
    setActionError("");
  });

  const runAction = async () => {
    const action = props.state?.action;
    if (!action || busy()) return;
    setBusy(true);
    setActionError("");
    try {
      await action.onAction();
    } catch (error: unknown) {
      setActionError(
        error instanceof Error
          ? error.message
          : "The action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const trustAcknowledgement = () => props.state?.trustAcknowledgement;
  const actionEnabled = () => (
    props.state?.action !== undefined
    && (props.state.action.enabled?.() ?? true)
  );

  return (
    <Dialog open={Boolean(props.state)} onOpenChange={props.onOpenChange}>
      <DialogContent class="border border-border bg-app-surface text-foreground">
        <DialogHeader>
          <DialogTitle>{props.state?.title ?? ""}</DialogTitle>
          <DialogDescription>{props.state?.message ?? ""}</DialogDescription>
          <Show when={trustAcknowledgement()}>
            {(trust) => (
              <Show when={!trust().acknowledged()}>
                <div class="mt-3 border border-border px-3 py-3 text-left text-xs text-muted-foreground">
                  <p class="font-medium text-foreground">{trust().disclosure.title}</p>
                  <p class="mt-1">{trust().disclosure.body}</p>
                  <label class="mt-3 flex items-start gap-2 text-foreground">
                    <input
                      type="checkbox"
                      checked={trust().acknowledged()}
                      onChange={(event) => trust().onChange(event.currentTarget.checked)}
                    />
                    <span>{trust().disclosure.acknowledgement}</span>
                  </label>
                </div>
              </Show>
            )}
          </Show>
          <Show when={actionError()}>
            {(error) => (
              <p class="text-sm text-destructive" role="alert" aria-live="polite">
                {error()}
              </p>
            )}
          </Show>
        </DialogHeader>
        <DialogFooter>
          <Show
            when={props.state?.action}
            fallback={
              <Button variant="outline" onClick={() => props.onOpenChange(false)}>
                OK
              </Button>
            }
          >
            {(action) => (
              <>
                <Button variant="outline" onClick={() => props.onOpenChange(false)}>
                  {props.state?.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  onClick={() => void runAction()}
                  disabled={busy() || !actionEnabled()}
                >
                  {busy() ? action().busyLabel : action().label}
                </Button>
              </>
            )}
          </Show>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
