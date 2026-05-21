import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'

import { hasAncestorDatasetValue } from '~/lib/dom-dataset'

type UseProjectsMenuControllerOptions = {
  onDeleteProject: (projectId: string) => void | Promise<void>
  onRenameProject: (projectId: string, name: string) => void | Promise<void>
}

type UseProjectsMenuControllerReturn = {
  confirmingProjectId: () => string | null
  deletingProjectId: () => string | null
  editingProjectId: () => string | null
  editingName: () => string
  renamingProjectId: () => string | null
  setConfirmingProjectId: (value: string | null) => void
  setEditingName: (value: string) => void
  beginProjectRename: (projectId: string, name: string) => void
  cancelProjectRename: () => void
  confirmProjectRename: (projectId: string) => Promise<void>
  confirmProjectDelete: (projectId: string) => Promise<void>
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

  const beginProjectRename = (projectId: string, name: string) => {
    setEditingProjectId(projectId)
    setEditingName(name)
  }

  const cancelProjectRename = () => {
    setEditingProjectId(null)
  }

  const confirmProjectRename = async (projectId: string) => {
    if (renamingProjectId() === projectId) return
    const name = editingName().trim()
    if (!name) {
      cancelProjectRename()
      return
    }
    setRenamingProjectId(projectId)
    try {
      await options.onRenameProject(projectId, name)
    } finally {
      setRenamingProjectId(null)
      cancelProjectRename()
    }
  }

  const confirmProjectDelete = async (projectId: string) => {
    setDeletingProjectId(projectId)
    try {
      await options.onDeleteProject(projectId)
    } finally {
      setDeletingProjectId(null)
      setConfirmingProjectId(null)
    }
  }

  const escapeCssValue = (value: string) => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value)
    }
    return value.replace(/["\\]/g, '\\$&')
  }

  const handleDocPointerDown = (event: PointerEvent) => {
    const confirmId = confirmingProjectId()
    const editId = editingProjectId()
    if (!confirmId && !editId) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (confirmId && !hasAncestorDatasetValue(target, (element) => element.dataset.projectRid, confirmId)) setConfirmingProjectId(null)
    if (editId && !hasAncestorDatasetValue(target, (element) => element.dataset.projectRid, editId)) setEditingProjectId(null)
  }

  const handleEscKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    if (confirmingProjectId()) setConfirmingProjectId(null)
    if (editingProjectId()) setEditingProjectId(null)
  }

  onMount(() => {
    window.addEventListener('pointerdown', handleDocPointerDown, captureOptions)
    window.addEventListener('keydown', handleEscKey, captureOptions)
  })

  onCleanup(() => {
    clearRenameFocus()
    window.removeEventListener('pointerdown', handleDocPointerDown, captureOptions)
    window.removeEventListener('keydown', handleEscKey, captureOptions)
  })

  createEffect(() => {
    const projectId = editingProjectId()
    clearRenameFocus()
    if (!projectId) return
    const tryFocus = () => {
      try {
        const element = document.querySelector(`input[data-project-input="${escapeCssValue(projectId)}"]`)
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
