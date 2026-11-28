import type { FunctionReturnType } from 'convex/server'
import { createEffect, createMemo, createSignal, untrack, type Accessor } from 'solid-js'

import { isLocalId, normalizeMasterVolume, type ProjectRole } from '@daw-browser/shared'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { convexApi } from '~/lib/convex'
import { publishDurableSharedTimelineOperation } from '~/lib/shared-outbox'
import type { ProjectMixState } from '~/lib/project-mix-state'

type FullTimelineView = FunctionReturnType<typeof convexApi.timeline.fullView>

type UseTimelineMasterVolumeOptions = {
  projectId: Accessor<string>
  userId: Accessor<string>
  currentProjectRole: Accessor<ProjectRole | null>
  fullViewData: Accessor<FullTimelineView | undefined>
  audioEngine: AudioEngine
  projectMix: {
    state: Accessor<ProjectMixState>
    isHydrated: Accessor<boolean>
    setMasterVolume: (volume: number) => void
  }
}

// 'applied' and 'rejected' settle at once; a promise is a durable write that rejects when the server refuses it.
type MasterVolumeCommit = 'applied' | 'rejected' | Promise<void>

type MasterVolumeBackend = {
  committedVolume: () => number
  canEdit: () => boolean
  // Cloud only: the server's master volume replaces the local mix state.
  serverVolume?: () => number | undefined
  commit: (volume: number) => MasterVolumeCommit
}

// A local project keeps its master volume in the local mix state and always accepts the edit.
const createLocalMasterVolumeBackend = (options: UseTimelineMasterVolumeOptions): MasterVolumeBackend => ({
  committedVolume: () => options.projectMix.state().masterVolume,
  canEdit: () => true,
  commit: (volume) => {
    options.projectMix.setMasterVolume(volume)

    return 'applied'
  },
})

// A cloud project reads the volume from the full view, and an owner or editor commits it through the shared outbox.
const createCloudMasterVolumeBackend = (options: UseTimelineMasterVolumeOptions, projectId: string): MasterVolumeBackend => ({
  committedVolume: () => normalizeMasterVolume(options.fullViewData()?.mixerSettings.masterVolume ?? options.projectMix.state().masterVolume),
  canEdit: () => {
    const role = options.currentProjectRole()

    return role === 'owner' || role === 'editor'
  },
  serverVolume: () => options.fullViewData()?.mixerSettings.masterVolume,
  commit: (volume) => {
    const userId = options.userId()
    const role = options.currentProjectRole()

    if (!projectId || !userId || (role !== 'owner' && role !== 'editor')) return 'rejected'
    options.projectMix.setMasterVolume(volume)

    return publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation: { kind: 'mixer.setMasterVolume', payload: { volume } },
      queuedResult: { status: 'applied' },
    }).then(() => undefined)
  },
})

export function useTimelineMasterVolume(options: UseTimelineMasterVolumeOptions) {
  const [pendingMasterVolume, setPendingMasterVolume] = createSignal<number | undefined>()

  const backend = createMemo(() => {
    const projectId = options.projectId()

    return isLocalId('project', projectId)
      ? createLocalMasterVolumeBackend(options)
      : createCloudMasterVolumeBackend(options, projectId)
  })

  const committedVolume = () => backend().committedVolume()

  const volume = createMemo(() => pendingMasterVolume() ?? committedVolume())

  const canEdit = () => backend().canEdit()

  const previewVolume = (nextVolume: number) => {
    if (!canEdit()) return
    options.audioEngine.setMasterVolume(normalizeMasterVolume(nextVolume))
  }

  createEffect(() => {
    if (!options.projectMix.isHydrated()) return
    options.audioEngine.setMasterVolume(volume())
  })

  createEffect(() => {
    const serverVolume = backend().serverVolume?.()

    if (!options.projectId() || serverVolume === undefined || pendingMasterVolume() !== undefined) return
    options.projectMix.setMasterVolume(serverVolume)
  })

  createEffect(() => {
    const pending = pendingMasterVolume()

    if (pending === undefined || pending !== committedVolume()) return
    setPendingMasterVolume(undefined)
  })

  const commitVolume = (nextVolumeInput: number) => {
    if (!canEdit()) return
    const nextVolume = normalizeMasterVolume(nextVolumeInput)

    if (nextVolume === volume()) return
    setPendingMasterVolume(nextVolume)
    options.audioEngine.setMasterVolume(nextVolume)
    const outcome = backend().commit(nextVolume)

    if (outcome === 'applied') {
      setPendingMasterVolume(undefined)

      return
    }

    if (outcome === 'rejected') {
      setPendingMasterVolume(undefined)
      options.audioEngine.setMasterVolume(committedVolume())

      return
    }

    void outcome.catch(() => {
      if (untrack(() => pendingMasterVolume()) !== nextVolume) return
      setPendingMasterVolume(undefined)
      const committed = untrack(committedVolume)
      options.projectMix.setMasterVolume(committed)
      options.audioEngine.setMasterVolume(committed)
    })
  }

  return {
    volume,
    ready: options.projectMix.isHydrated,
    canEdit,
    previewVolume,
    commitVolume,
  }
}
