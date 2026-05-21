import { createSignal, onCleanup, type Accessor } from 'solid-js'

import { copyText } from '~/lib/clipboard'
import { getRoomShareUrl } from '~/lib/timeline-share'

type UseShareMenuControllerOptions = {
  onShare?: () => void | Promise<void>
  projectId?: Accessor<string | undefined>
}

type UseShareMenuControllerReturn = {
  open: Accessor<boolean>
  onOpenChange: (open: boolean) => void
  onOpen: () => Promise<void>
  onClose: () => void
  copied: Accessor<boolean>
  shareUrl: Accessor<string>
  onCopy: () => Promise<void>
}

export function useShareMenuController(
  options: UseShareMenuControllerOptions,
): UseShareMenuControllerReturn {
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  let copiedResetTimer: number | null = null

  const clearCopiedResetTimer = () => {
    if (copiedResetTimer === null) return
    window.clearTimeout(copiedResetTimer)
    copiedResetTimer = null
  }

  const shareUrl = () => getRoomShareUrl(options.projectId?.()) ?? ''

  const onOpen = async () => {
    try {
      await options.onShare?.()
    } catch {}
    setOpen(true)
  }

  const onCopy = async () => {
    await copyText(shareUrl())
    setCopied(true)
    clearCopiedResetTimer()
    copiedResetTimer = window.setTimeout(() => {
      copiedResetTimer = null
      setCopied(false)
    }, 1500)
  }

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      clearCopiedResetTimer()
      setCopied(false)
    }
  }

  const onClose = () => {
    onOpenChange(false)
  }

  onCleanup(() => {
    clearCopiedResetTimer()
  })

  return {
    open,
    onOpenChange,
    onOpen,
    onClose,
    copied,
    shareUrl,
    onCopy,
  }
}
