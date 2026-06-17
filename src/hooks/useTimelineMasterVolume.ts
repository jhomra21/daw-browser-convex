import type { FunctionReturnType } from 'convex/server'
import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js'

import { isLocalId, normalizeMasterVolume, type ProjectRole } from '@daw-browser/shared'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { convexApi } from '~/lib/convex'
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

export function useTimelineMasterVolume(options: UseTimelineMasterVolumeOptions) {
  const [pendingMasterVolume, setPendingMasterVolume] = createSignal<number | undefined>()

  const committedVolume = createMemo(() => {
    const projectId = options.projectId()
    if (isLocalId('project', projectId)) return options.projectMix.state().masterVolume
    return normalizeMasterVolume(options.fullViewData()?.mixerSettings.masterVolume ?? options.projectMix.state().masterVolume)
  })

  const volume = createMemo(() => pendingMasterVolume() ?? committedVolume())
  const canEdit = createMemo(() => {
    const projectId = options.projectId()
    if (isLocalId('project', projectId)) return true
    const role = options.currentProjectRole()
    return role === 'owner' || role === 'editor'
  })

  const previewVolume = (nextVolume: number) => {
    if (!canEdit()) return
    options.audioEngine.setMasterVolume(normalizeMasterVolume(nextVolume))
  }

  createEffect(() => {
    if (!options.projectMix.isHydrated()) return
    options.audioEngine.setMasterVolume(volume())
  })

  createEffect(() => {
    const projectId = options.projectId()
    const mixerSettings = options.fullViewData()?.mixerSettings
    if (!projectId || isLocalId('project', projectId) || !mixerSettings || pendingMasterVolume() !== undefined) return
    options.projectMix.setMasterVolume(mixerSettings.masterVolume)
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
    const projectId = options.projectId()
    if (isLocalId('project', projectId)) {
      options.projectMix.setMasterVolume(nextVolume)
      setPendingMasterVolume(undefined)
      return
    }
    const userId = options.userId()
    if (!projectId || !userId || (options.currentProjectRole() !== 'owner' && options.currentProjectRole() !== 'editor')) {
      setPendingMasterVolume(undefined)
      options.audioEngine.setMasterVolume(committedVolume())
      return
    }
    options.projectMix.setMasterVolume(nextVolume)
    void publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation: { kind: 'mixer.setMasterVolume', payload: { volume: nextVolume } },
      queuedResult: { status: 'applied' },
    }).catch(() => {
      if (pendingMasterVolume() !== nextVolume) return
      setPendingMasterVolume(undefined)
      options.projectMix.setMasterVolume(committedVolume())
      options.audioEngine.setMasterVolume(committedVolume())
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
