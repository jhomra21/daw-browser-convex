import { createEffect, createSignal, Show } from 'solid-js'

import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { TextField, TextFieldInput, TextFieldLabel } from '~/components/ui/text-field'
import type { LocalProjectEntry } from '~/lib/local-project-db'

type ProjectDeleteDialogProps = {
  open: boolean
  project: LocalProjectEntry | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (project: LocalProjectEntry) => void
}

export default function ProjectDeleteDialog(props: ProjectDeleteDialogProps) {
  const [confirmation, setConfirmation] = createSignal('')

  createEffect(() => {
    if (!props.open) setConfirmation('')
    props.project?.id
  })

  const confirmDelete = () => {
    const project = props.project
    if (!project || confirmation() !== project.name) return
    props.onConfirm(project)
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="border border-neutral-800 bg-neutral-900 text-neutral-100">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            confirmDelete()
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete local project?</DialogTitle>
            <DialogDescription>
              <Show when={props.project}>
                {(project) => (
                  <>
                    Type <span class="font-medium text-neutral-100">{project().name}</span> to permanently delete this local project.
                  </>
                )}
              </Show>
            </DialogDescription>
          </DialogHeader>
          <TextField class="mt-4">
            <TextFieldLabel>Project name</TextFieldLabel>
            <TextFieldInput value={confirmation()} onInput={(event) => setConfirmation(event.currentTarget.value)} />
          </TextField>
          <DialogFooter class="mt-6">
            <Button variant="outline" type="button" onClick={() => props.onOpenChange(false)} disabled={props.busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              type="submit"
              disabled={props.busy || confirmation() !== props.project?.name}
            >
              Delete
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
