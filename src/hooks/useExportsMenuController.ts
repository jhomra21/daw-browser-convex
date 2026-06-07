import { createSignal, type Accessor } from 'solid-js'

import { useProjectExports } from '~/hooks/useProjectExports'
import { copyText } from '~/lib/clipboard'

type UseExportsMenuControllerOptions = {
  currentProjectId: Accessor<string>
  currentUserId: Accessor<string | undefined>
  onOpenExport: () => void
}

export type ExportsMenuController = {
  open: Accessor<boolean>
  onOpenChange: (open: boolean) => void
  exports: ReturnType<typeof useProjectExports>['exports']
  copyText: (value?: string) => Promise<void>
  onOpenExport: () => void
}

export function useExportsMenuController(
  options: UseExportsMenuControllerOptions,
): ExportsMenuController {
  const [open, setOpen] = createSignal(false)
  const exportsQ = useProjectExports({
    projectId: options.currentProjectId,
    userId: () => options.currentUserId() ?? '',
    enabled: open,
  })

  return {
    open,
    onOpenChange: setOpen,
    exports: exportsQ.exports,
    copyText,
    onOpenExport: options.onOpenExport,
  }
}
