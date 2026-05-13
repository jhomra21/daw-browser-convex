import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js'

import type { InsertSampleInput } from '~/hooks/useTimelineClipImport'
import { copyText } from '~/lib/clipboard'
import { useProjectSamples, type ProjectSampleListItem } from '~/hooks/useProjectSamples'
import { convexApi, convexClient } from '~/lib/convex'
import { hasAncestorDatasetValue } from '~/lib/dom-dataset'
import { SAMPLE_DRAG_DATA_TYPE, serializeSampleDragData } from '~/lib/sample-drag-data'
import type { Track } from '~/types/timeline'

type UseSamplesMenuControllerOptions = {
  currentRoomId: Accessor<string>
  currentUserId: Accessor<string | undefined>
  onInsertSample: (input: InsertSampleInput) => void | Promise<void>
  onJumpToClip: (clipId: string, trackId: Track['id'], startSec: number) => void
}

type UseSamplesMenuControllerReturn = {
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
}

export function useSamplesMenuController(
  options: UseSamplesMenuControllerOptions,
): UseSamplesMenuControllerReturn {
  const [open, setOpen] = createSignal(false)
  const [isDraggingSample, setIsDraggingSample] = createSignal(false)
  const [confirmingSampleKey, setConfirmingSampleKey] = createSignal<string | null>(null)
  const [deletingSampleKey, setDeletingSampleKey] = createSignal<string | null>(null)
  const [insertingSampleKey, setInsertingSampleKey] = createSignal<string | null>(null)
  const captureOptions = { capture: true }

  const samples = useProjectSamples({
    roomId: options.currentRoomId,
    enabled: open,
  })

  const formatBytes = (bytes?: number) => {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
    const units = ['B', 'KB', 'MB', 'GB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1)
    return `${formatted} ${units[unitIndex]}`
  }

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
    if (!sample.url) return
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
    const roomId = options.currentRoomId()
    const userId = options.currentUserId()
    if (!sample.url || !roomId || !userId) return
    setDeletingSampleKey(sample.key)
    try {
      await convexClient.mutation(convexApi.samples.removeFromRoom, {
        roomId,
        assetKey: sample.assetKey,
        userId,
      })
      setConfirmingSampleKey(null)
    } finally {
      setDeletingSampleKey(null)
    }
  }

  const handleDocMouseDown = (event: MouseEvent) => {
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
    window.addEventListener('mousedown', handleDocMouseDown, captureOptions)
    window.addEventListener('keydown', handleEscKey, captureOptions)
  })

  onCleanup(() => {
    window.removeEventListener('mousedown', handleDocMouseDown, captureOptions)
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
  }
}
