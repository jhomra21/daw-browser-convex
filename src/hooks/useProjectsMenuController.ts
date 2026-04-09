import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'

type UseProjectsMenuControllerOptions = {
  onDeleteProject: (roomId: string) => void | Promise<void>
  onRenameProject: (roomId: string, name: string) => void | Promise<void>
}

type UseProjectsMenuControllerReturn = {
  confirmingProjectId: () => string | null
  deletingProjectId: () => string | null
  editingProjectId: () => string | null
  editingName: () => string
  renamingProjectId: () => string | null
  setConfirmingProjectId: (value: string | null) => void
  setEditingName: (value: string) => void
  beginProjectRename: (roomId: string, name: string) => void
  cancelProjectRename: () => void
  confirmProjectRename: (roomId: string) => Promise<void>
  confirmProjectDelete: (roomId: string) => Promise<void>
  stopPropagation: (event: Event) => void
  stopMenuPress: (event: Event) => void
}

export function useProjectsMenuController(
  options: UseProjectsMenuControllerOptions,
): UseProjectsMenuControllerReturn {
  const [confirmingProjectId, setConfirmingProjectId] = createSignal<string | null>(null)
  const [deletingProjectId, setDeletingProjectId] = createSignal<string | null>(null)
  const [editingProjectId, setEditingProjectId] = createSignal<string | null>(null)
  const [editingName, setEditingName] = createSignal('')
  const [renamingProjectId, setRenamingProjectId] = createSignal<string | null>(null)
  let renameFocusTimer: number | null = null
  let renameFocusFrame: number | null = null
  const captureOptions = { capture: true }

  const clearRenameFocus = () => {
    if (renameFocusTimer !== null) {
      window.clearTimeout(renameFocusTimer)
      renameFocusTimer = null
    }
    if (renameFocusFrame !== null && 'cancelAnimationFrame' in window) {
      cancelAnimationFrame(renameFocusFrame)
      renameFocusFrame = null
    }
  }

  const stopPropagation = (event: Event) => {
    event.stopPropagation()
  }

  const stopMenuPress = (event: Event) => {
    event.stopPropagation()
    event.preventDefault()
  }

  const beginProjectRename = (roomId: string, name: string) => {
    setEditingProjectId(roomId)
    setEditingName(name)
  }

  const cancelProjectRename = () => {
    setEditingProjectId(null)
  }

  const confirmProjectRename = async (roomId: string) => {
    if (renamingProjectId() === roomId) return
    const name = editingName().trim()
    if (!name) {
      cancelProjectRename()
      return
    }
    setRenamingProjectId(roomId)
    try {
      await options.onRenameProject(roomId, name)
    } finally {
      setRenamingProjectId(null)
      cancelProjectRename()
    }
  }

  const confirmProjectDelete = async (roomId: string) => {
    setDeletingProjectId(roomId)
    try {
      await options.onDeleteProject(roomId)
    } finally {
      setDeletingProjectId(null)
      setConfirmingProjectId(null)
    }
  }

  const handleDocMouseDown = (event: MouseEvent) => {
    const confirmId = confirmingProjectId()
    const editId = editingProjectId()
    if (!confirmId && !editId) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (confirmId && !target.closest(`[data-project-rid="${confirmId}"]`)) setConfirmingProjectId(null)
    if (editId && !target.closest(`[data-project-rid="${editId}"]`)) setEditingProjectId(null)
  }

  const handleEscKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    if (confirmingProjectId()) setConfirmingProjectId(null)
    if (editingProjectId()) setEditingProjectId(null)
  }

  onMount(() => {
    window.addEventListener('mousedown', handleDocMouseDown, captureOptions)
    window.addEventListener('keydown', handleEscKey, captureOptions)
  })

  onCleanup(() => {
    clearRenameFocus()
    window.removeEventListener('mousedown', handleDocMouseDown, captureOptions)
    window.removeEventListener('keydown', handleEscKey, captureOptions)
  })

  createEffect(() => {
    const roomId = editingProjectId()
    clearRenameFocus()
    if (!roomId) return
    const tryFocus = () => {
      try {
        const element = document.querySelector(`input[data-project-input="${roomId}"]`)
        if (element instanceof HTMLInputElement) {
          element.focus()
          element.select?.()
        }
      } catch {}
    }
    renameFocusFrame = requestAnimationFrame(() => {
      renameFocusFrame = null
      tryFocus()
    })
    renameFocusTimer = window.setTimeout(() => {
      renameFocusTimer = null
      tryFocus()
    }, 0)
  })

  return {
    confirmingProjectId,
    deletingProjectId,
    editingProjectId,
    editingName,
    renamingProjectId,
    setConfirmingProjectId,
    setEditingName,
    beginProjectRename,
    cancelProjectRename,
    confirmProjectRename,
    confirmProjectDelete,
    stopPropagation,
    stopMenuPress,
  }
}
