import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js'

import type { InsertSampleInput } from '~/hooks/useTimelineClipImport'
import { copyText } from '~/lib/clipboard'
import { useProjectSamples, type ProjectSampleListItem } from '~/hooks/useProjectSamples'
import { hasAncestorDatasetValue } from '~/lib/dom-dataset'
import { deleteLocalAsset } from '~/lib/local-assets'
import { isLocalId } from '@daw-browser/shared'
import { deleteProjectSample } from '~/lib/project-samples-api'
import { SAMPLE_DRAG_DATA_TYPE, serializeSampleDragData } from '~/lib/sample-drag-data'
import type { Track } from '@daw-browser/timeline-core/types'
import { formatBytes } from '~/lib/format-bytes'
import type { DashboardView } from '~/components/dashboard/types'

type UseSamplesMenuControllerOptions = {
  currentProjectId: Accessor<string>
  currentUserId: Accessor<string | undefined>
  onInsertSample: (input: InsertSampleInput) => void | Promise<void>
  onJumpToClip: (clipId: string, trackId: Track['id'], startSec: number) => void
  onOpenDashboard: (view: DashboardView) => void
}

export type SamplesMenuController = {
  open: Accessor<boolean>
  onOpenChange: (open: boolean) => void
  isDraggingSample: Accessor<boolean>
  setIsDraggingSample: (value: boolean) => void
  samples: ReturnType<typeof useProjectSamples>['samples']
  defaultSamples: ReturnType<typeof useProjectSamples>['defaultSamples']
  confirmingSampleKey: Accessor<string | null>
  deletingSampleKey: Accessor<string | null>
  insertingSampleKey: Accessor<string | null>
  setConfirmingSampleKey: (value: string | null) => void
  onJumpToClip: (clipId: string, trackId: Track['id'], startSec: number) => void
  onStartSampleDrag: (event: DragEvent, sample: InsertSampleInput) => void
  onInsertSample: (sample: InsertSampleInput & { key?: string }) => Promise<void>
  onDeleteSample: (sample: ProjectSampleListItem) => Promise<void>
  formatBytes: (bytes?: number) => string
  copyText: (value?: string) => Promise<void>
  onOpenDashboard: (view: DashboardView) => void
}

export function useSamplesMenuController(
  options: UseSamplesMenuControllerOptions,
): SamplesMenuController {
  const [open, setOpen] = createSignal(false)
  const [isDraggingSample, setIsDraggingSample] = createSignal(false)
  const [confirmingSampleKey, setConfirmingSampleKey] = createSignal<string | null>(null)
  const [deletingSampleKey, setDeletingSampleKey] = createSignal<string | null>(null)
  const [insertingSampleKey, setInsertingSampleKey] = createSignal<string | null>(null)
  const captureOptions = { capture: true }

  const samples = useProjectSamples({
    projectId: options.currentProjectId,
    userId: () => options.currentUserId() ?? '',
    enabled: open,
  })

  const onStartSampleDrag = (event: DragEvent, sample: InsertSampleInput) => {
    try {
      event.dataTransfer?.setData(SAMPLE_DRAG_DATA_TYPE, serializeSampleDragData(sample))
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'copy'
      }
    } catch {}
    setIsDraggingSample(true)
  }

  const onInsertSample = async (sample: InsertSampleInput & { key?: string }) => {
    const sampleKey = sample.key ?? sample.url
    setInsertingSampleKey(sampleKey)
    try {
      await Promise.resolve(options.onInsertSample({
        url: sample.url,
        name: sample.name,
        duration: sample.duration,
        assetKey: sample.assetKey,
        sourceKind: sample.sourceKind,
        source: sample.source,
      }))
    } finally {
      setInsertingSampleKey(null)
    }
  }

  const onDeleteSample = async (sample: ProjectSampleListItem) => {
    const projectId = options.currentProjectId()
    const userId = options.currentUserId()
    if (!projectId) return
    setDeletingSampleKey(sample.key)
    try {
      if (isLocalId('project', projectId) && isLocalId('asset', sample.assetKey)) {
        if (sample.count > 0) return
        await deleteLocalAsset(projectId, sample.assetKey)
        samples.refreshSamples()
        setConfirmingSampleKey(null)
        return
      }
      if (!userId) return
      await deleteProjectSample(projectId, sample.assetKey)
      setConfirmingSampleKey(null)
    } finally {
      setDeletingSampleKey(null)
    }
  }

  const handleDocPointerDown = (event: PointerEvent) => {
    const sampleId = confirmingSampleKey()
    if (!sampleId) return
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (!hasAncestorDatasetValue(target, (element) => element.dataset.sampleKey, sampleId)) setConfirmingSampleKey(null)
  }

  const handleEscKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    if (confirmingSampleKey()) setConfirmingSampleKey(null)
  }

  onMount(() => {
    window.addEventListener('pointerdown', handleDocPointerDown, captureOptions)
    window.addEventListener('keydown', handleEscKey, captureOptions)
  })

  onCleanup(() => {
    window.removeEventListener('pointerdown', handleDocPointerDown, captureOptions)
    window.removeEventListener('keydown', handleEscKey, captureOptions)
  })

  return {
    open,
    onOpenChange: setOpen,
    isDraggingSample,
    setIsDraggingSample,
    samples: samples.samples,
    defaultSamples: samples.defaultSamples,
    confirmingSampleKey,
    deletingSampleKey,
    insertingSampleKey,
    setConfirmingSampleKey,
    onJumpToClip: options.onJumpToClip,
    onStartSampleDrag,
    onInsertSample,
    onDeleteSample,
    formatBytes,
    copyText,
    onOpenDashboard: options.onOpenDashboard,
  }
}
