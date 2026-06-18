import { onCleanup } from 'solid-js'

import { isLocalId } from '@daw-browser/shared'
import { convexApi, convexClient } from '~/lib/convex'
import { toCloudClipId } from '~/lib/cloud-id-args'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { Clip } from '@daw-browser/timeline-core/types'

type MidiClipData = NonNullable<Clip['midi']>

type MidiEditorPersistenceOptions = {
  clipId: () => string
  projectId: () => string | undefined
  userId: () => string | undefined
  midi: () => MidiClipData
  onLocalMidiSaved?: (clipId: string, midi: MidiClipData) => void
  onCannotPersist?: () => void
}

type PendingMidiSave = {
  clipId: string
  projectId?: string
  userId?: string
  midi: MidiClipData
}

const canPersistSave = (save: PendingMidiSave) => (
  Boolean(save.projectId && isLocalId('project', save.projectId)) || Boolean(save.userId)
)

export function useMidiEditorPersistence(options: MidiEditorPersistenceOptions) {
  let saveTimer: number | null = null
  let pendingMidiSave: PendingMidiSave | null = null

  const canPersist = () => {
    const projectId = options.projectId()
    return Boolean((projectId && isLocalId('project', projectId)) || options.userId())
  }

  const saveMidi = async (save: PendingMidiSave) => {
    if (save.projectId && isLocalId('project', save.projectId)) {
      const updated = await createLocalTimelineRepository(save.projectId).updateClip({
        clipId: save.clipId,
        midi: save.midi,
      })
      if (updated && options.projectId() === save.projectId && options.clipId() === save.clipId) {
        options.onLocalMidiSaved?.(save.clipId, save.midi)
      }
      return
    }
    await convexClient.mutation(convexApi.clips.setMidi, {
      clipId: toCloudClipId(save.clipId),
      midi: save.midi,
    })
  }

  const flush = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    const save = pendingMidiSave
    pendingMidiSave = null
    if (save) void saveMidi(save).catch(() => {})
  }

  const saveSoon = () => {
    const pending = {
      clipId: options.clipId(),
      projectId: options.projectId(),
      userId: options.userId(),
      midi: options.midi(),
    }
    if (!canPersistSave(pending)) {
      options.onCannotPersist?.()
      return
    }
    pendingMidiSave = pending
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      flush()
    }, 200)
  }

  onCleanup(flush)

  return {
    canPersist,
    saveSoon,
  }
}
