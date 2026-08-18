import { createEffect, createSignal, onCleanup } from 'solid-js'

import { isLocalId, type NormalizedLegacyMidiClip } from '@daw-browser/shared'
import type { Clip } from '@daw-browser/timeline-core/types'
import {
  createMidiEditorPersistence,
  type MidiEditorPersistenceError,
  type MidiEditorOperation,
} from '~/lib/midi/editor-persistence'
import { z } from 'zod'

type MidiClipData = NonNullable<Clip['midi']>

type MidiEditorPersistenceOptions = {
  clipId: () => string
  projectId: () => string | undefined
  userId: () => string | undefined
  canWrite: () => boolean
  onLocalMidiSaved?: (clipId: string, midi: MidiClipData) => void
  onCannotPersist?: () => void
}

const midiEditorPersistenceErrorSchema = z.object({
  error: z.instanceof(Error),
  retryable: z.boolean(),
  operationIds: z.array(z.string()).optional(),
})

export const canPersistMidiEditor = (
  projectId: string | undefined,
  userId: string | undefined,
  canWrite: boolean,
) => Boolean(canWrite && projectId && (isLocalId('project', projectId) || userId))

export function useMidiEditorPersistence(options: MidiEditorPersistenceOptions) {
  let saveTimer: number | null = null
  let adapter: ReturnType<typeof createMidiEditorPersistence> | undefined
  const [error, setError] = createSignal<MidiEditorPersistenceError>()
  const [pendingVersion, setPendingVersion] = createSignal(0)

  const retainError = (cause: unknown) => {
    const persistenceError = midiEditorPersistenceErrorSchema.safeParse(cause)
    if (persistenceError.success) {
      setError(persistenceError.data)
      return
    }
    setError({
      error: cause instanceof Error ? cause : new Error('Unable to save MIDI changes.'),
      retryable: true,
    })
  }

  const canPersist = () => {
    return canPersistMidiEditor(options.projectId(), options.userId(), options.canWrite())
  }

  createEffect(() => {
    const projectId = options.projectId()
    const clipId = options.clipId()
    if (!projectId || (!isLocalId('project', projectId) && !options.userId())) {
      adapter?.dispose()
      adapter = undefined
      return
    }
    const current = createMidiEditorPersistence({
      projectId,
      clipId,
      onCommitted: (midi) => {
        setPendingVersion((version) => version + 1)
        if (isLocalId('project', projectId) && options.projectId() === projectId && options.clipId() === clipId) {
          options.onLocalMidiSaved?.(clipId, midi)
        }
      },
      onError: retainError,
      onSettled: () => setPendingVersion((version) => version + 1),
    })
    adapter?.dispose()
    adapter = current
    onCleanup(current.dispose)
  })

  const flush = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    try {
      await adapter?.flush()
      if (!adapter?.error()) setError()
      setPendingVersion((version) => version + 1)
    } catch (reason) {
      retainError(reason)
      throw reason
    }
  }

  const saveSoon = (operation: MidiEditorOperation) => {
    if (!canPersist() || !adapter) {
      options.onCannotPersist?.()
      return
    }
    adapter.enqueue(operation)
    setError()
    setPendingVersion((version) => version + 1)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      void flush().catch(() => undefined)
    }, 200)
  }

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    void flush().catch(() => undefined)
  })

  return {
    canPersist,
    saveSoon,
    flush,
    error,
    dismissError: () => {
      adapter?.dismissError()
      setError()
    },
    pendingOperations: () => {
      pendingVersion()
      return adapter?.pendingOperations() ?? []
    },
    reconcile: (midi: NormalizedLegacyMidiClip) => adapter?.reconcile(midi),
    project: (midi: NormalizedLegacyMidiClip) => {
      pendingVersion()
      return adapter?.project(midi) ?? midi
    },
  }
}
