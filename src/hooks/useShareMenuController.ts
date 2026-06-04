import { createSignal, onCleanup, type Accessor } from 'solid-js'

import { copyText } from '~/lib/clipboard'
import { getRoomShareUrl } from '~/lib/timeline-share'

type ProjectMember = {
  userId: string
  role: 'editor' | 'viewer'
}

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
  members: Accessor<ProjectMember[]>
  membersLoading: Accessor<boolean>
  membersError: Accessor<string>
  revokingMemberId: Accessor<string>
  onCopy: () => Promise<void>
  onRevokeMember: (userId: string) => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readProjectMembers = (value: unknown) => {
  if (!isRecord(value) || !Array.isArray(value.members)) return null
  return value.members.flatMap((member): ProjectMember[] => {
    if (!isRecord(member) || typeof member.userId !== 'string') return []
    if (member.role !== 'editor' && member.role !== 'viewer') return []
    return [{ userId: member.userId, role: member.role }]
  })
}

export function useShareMenuController(
  options: UseShareMenuControllerOptions,
): UseShareMenuControllerReturn {
  const [open, setOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [generatedShareUrl, setGeneratedShareUrl] = createSignal('')
  const [shareError, setShareError] = createSignal('')
  const [members, setMembers] = createSignal<ProjectMember[]>([])
  const [membersLoading, setMembersLoading] = createSignal(false)
  const [membersError, setMembersError] = createSignal('')
  const [revokingMemberId, setRevokingMemberId] = createSignal('')
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
    setMembersError('')
    setMembersLoading(true)
    const projectId = options.projectId?.()
    const shareTask = Promise.resolve(options.onShare?.())
      .then((nextShareUrl) => {
        if (nextShareUrl) setGeneratedShareUrl(nextShareUrl)
      })
      .catch(() => {
        setShareError('Share invite could not be created.')
      })
    const membersTask = projectId
      ? (async () => {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`)
        const nextMembers = readProjectMembers(await response.json().catch(() => null))
        if (!response.ok || !nextMembers) throw new Error('Members could not be loaded.')
        setMembers(nextMembers)
      })().catch(() => {
        setMembers([])
        setMembersError('Members could not be loaded.')
      })
      : Promise.resolve(setMembers([]))
    try {
      await Promise.all([shareTask, membersTask])
    } finally {
      setMembersLoading(false)
      setOpen(true)
    }
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
      setMembers([])
      setMembersError('')
      setRevokingMemberId('')
    }
  }

  const onClose = () => {
    onOpenChange(false)
  }

  onCleanup(() => {
    clearCopiedResetTimer()
  })

  const onRevokeMember = async (targetUserId: string) => {
    const projectId = options.projectId?.()
    if (!projectId || !targetUserId) return
    setMembersError('')
    setRevokingMemberId(targetUserId)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error('Member could not be removed.')
      setMembers((current) => current.filter((member) => member.userId !== targetUserId))
    } catch {
      setMembersError('Member could not be removed.')
    } finally {
      setRevokingMemberId('')
    }
  }

  return {
    open,
    onOpenChange,
    onOpen,
    onClose,
    copied,
    shareUrl,
    shareError,
    members,
    membersLoading,
    membersError,
    revokingMemberId,
    onCopy,
    onRevokeMember,
  }
}
