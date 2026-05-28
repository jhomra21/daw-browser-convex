import { createSignal, onCleanup, type Accessor } from 'solid-js'

import { copyText } from '~/lib/clipboard'
import { getRoomShareUrl } from '~/lib/timeline-share'

type UseShareMenuControllerOptions = {
  onShare?: () => string | void | Promise<string | void>
  projectId?: Accessor<string | undefined>
}

type UseShareMenuControllerReturn = {
  open: Accessor<boolean>
  onOpenChange: (open: boolean) => void
  onOpen: () => Promise<void>
  onClose: () => void
  copied: Accessor<boolean>
  shareUrl: Accessor<string>
  shareError: Accessor<string>
  onCopy: () => Promise<void>
}

export function useShareMenuController(
  options: UseShareMenuControllerOptions,
): UseShareMenuControllerReturn {
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [generatedShareUrl, setGeneratedShareUrl] = createSignal('')
  const [shareError, setShareError] = createSignal('')
  let copiedResetTimer: number | null = null

  const clearCopiedResetTimer = () => {
    if (copiedResetTimer === null) return
    window.clearTimeout(copiedResetTimer)
    copiedResetTimer = null
  }

  const shareUrl = () => {
    const generated = generatedShareUrl()
    if (generated || options.onShare) return generated
    return getRoomShareUrl(options.projectId?.()) || ''
  }

  const onOpen = async () => {
    setShareError('')
    try {
      const nextShareUrl = await options.onShare?.()
      if (nextShareUrl) setGeneratedShareUrl(nextShareUrl)
    } catch {
      setShareError('Share invite could not be created.')
    }
    setOpen(true)
  }

  const onCopy = async () => {
    const currentShareUrl = shareUrl()
    if (!currentShareUrl) return
    await copyText(currentShareUrl)
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
      setGeneratedShareUrl('')
      setShareError('')
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
    shareError,
    onCopy,
  }
}
