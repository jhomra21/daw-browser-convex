import { createEffect, createSignal } from 'solid-js'

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

export type ProjectDialogProject = {
  id: string
  name: string
}

type ProjectRenameDialogProps = {
  open: boolean
  project: ProjectDialogProject | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (project: ProjectDialogProject, name: string) => void
}

export default function ProjectRenameDialog(props: ProjectRenameDialogProps) {
  const [name, setName] = createSignal('')

  createEffect(() => {
    setName(props.project?.name ?? '')
  })

  const confirmRename = () => {
    const project = props.project
    if (!project) return
    props.onConfirm(project, name())
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="border border-neutral-800 bg-neutral-900 text-neutral-100">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            confirmRename()
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>Choose a name for this local project.</DialogDescription>
          </DialogHeader>
          <TextField class="mt-4">
            <TextFieldLabel>Project name</TextFieldLabel>
            <TextFieldInput value={name()} onInput={(event) => setName(event.currentTarget.value)} />
          </TextField>
          <DialogFooter class="mt-6">
            <Button variant="outline" type="button" onClick={() => props.onOpenChange(false)} disabled={props.busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.busy}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
