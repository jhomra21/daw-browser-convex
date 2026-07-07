import type { FunctionReturnType } from 'convex/server'
import { batch, type Accessor, type Setter } from 'solid-js'

import { buildClipCreateSnapshot, buildCreatedClipSelection, createProjectedClips, createProjectedLocalClips, pushClipCreateHistory, type BatchClipCreateItem } from '~/lib/clip-create'
import type { ClipBuffers } from '~/lib/clip-buffer-cache'
import { getTrackDeleteConflictMessage } from '~/lib/delete-conflict-messages'
import { buildTrackEffectQueryArgs } from '~/lib/effect-track-args'
import { readInstrumentParamsFromEffectRow } from '~/lib/effect-row-instrument-params'
import { audioEffectKindFromLocalEffect, getLocalEffect, listLocalEffects } from '~/lib/local-effects'
import { isAudioEffectKind, isLocalId, normalizeCompressorParams, normalizeDelayParams, normalizeEqParams, normalizeReverbParams, normalizeSaturatorParams, type AutomationEnvelope } from '@daw-browser/shared'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { buildSharedClipCreateManyOperation, publishSharedTimelineOperation } from '~/lib/shared-timeline-operations-api'
import { isClipCompatibleWithTrack } from '@daw-browser/timeline-core/track-routing'
import { createTimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import { buildTrackDeleteMutationInput } from '~/lib/track-mutation-args'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { createTimelineClipWriteAdapter } from '~/lib/timeline-clip-write-adapter'
import { createTimelineAutomationWriteAdapter } from '~/lib/timeline-automation-write-adapter'
import { createTimelineSectionClipboard, type TimelineSectionClipboard } from '~/lib/timeline-section-clipboard'
import {
  buildAutomationFragment,
  buildClipRangeDeletePatch,
  buildSectionClipFragments,
  deleteAutomationRange,
  intersectingSectionClipIds,
  pasteAutomationFragment,
  type SectionAutomationFragment,
} from '~/lib/timeline-section-edit'
import { calcNonOverlapStart, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { buildAutomationEnvelopeHistoryEntry, buildClipDeleteHistoryEntry, buildClipTimingHistoryEntry, buildTrackDeleteHistoryEntry } from '~/lib/undo/builders'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry, TrackAudioEffectSnapshot, TrackEffectSnapshot } from '~/lib/undo/types'
import type { Clip, SelectedClip, Track } from '@daw-browser/timeline-core/types'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi
type TrackDeleteResult = FunctionReturnType<ConvexApiType['tracks']['remove']>

type TrackEffectRowSnapshotInput = {
  type?: unknown
  effect?: unknown
  targetType?: unknown
  targetId?: unknown
  trackId?: unknown
  instanceId?: unknown
  index?: unknown
  params?: any
}

type TimelineClipActionsOptions = {
  tracks: Accessor<RuntimeTrack[]>
  insertLocalClip: (trackId: Track['id'], clip: RuntimeClip) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  commitClipTiming: (clipId: string, patch: { startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number }) => void
  commitClipAudioWarp: (clipId: string, audioWarp: Clip['audioWarp']) => void
  removeLocalTrack: (trackId: Track['id']) => void
  canWriteClip: (clipId: string) => boolean
  selection: TimelineSelectionController
  setPendingDeleteTrackId: Setter<Track['id'] | null>
  setConfirmOpen: Setter<boolean>
  projectId: Accessor<string | undefined>
  userId: Accessor<string | undefined>
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  audioBufferCache: ClipBuffers
  bpm: Accessor<number>
  playheadSec: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
  historyPush: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  automationEnvelopes: Accessor<AutomationEnvelope[]>
  applyAutomationEnvelope: (envelope: AutomationEnvelope | undefined, targetKey: string) => void
  grantClipWrites?: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void
  notify: (title: string, message: string) => void
}

type TimelineClipActionsHandlers = {
  onClipPointerUp: (trackId: Track['id'], clipId: string, event: PointerEvent) => void
  deleteSelectedClips: () => Promise<void>
  duplicateSelectedClips: () => Promise<void>
  duplicateTimelineSelection: () => Promise<void>
  deleteTimelineSelection: () => Promise<void>
  copyTimelineSelection: () => boolean
  pasteTimelineSelection: () => boolean
  performDeleteTrack: (trackId: Track['id']) => Promise<void>
  requestDeleteTrack: (trackId: Track['id']) => void
}

const buildSectionHistoryEntry = (projectId: string, entries: HistoryEntry[]): HistoryEntry | null => (
  entries.length > 0 ? { type: 'section-edit', projectId, data: { entries } } : null
)

export function useTimelineClipActions(options: TimelineClipActionsOptions): TimelineClipActionsHandlers {
  const {
    tracks,
    insertLocalClip,
    removeLocalClips,
    commitClipTiming,
    commitClipAudioWarp,
    removeLocalTrack,
    canWriteClip,
    selection,
    setPendingDeleteTrackId,
    setConfirmOpen,
    projectId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache,
    bpm,
    playheadSec,
    gridEnabled,
    gridDenominator,
    historyPush,
    automationEnvelopes,
    applyAutomationEnvelope,
    grantClipWrites,
    notify,
  } = options
  const sectionClipboard = createTimelineSectionClipboard()

  const onClipPointerUp = (trackId: Track['id'], clipId: string, event: PointerEvent) => {
    event.stopPropagation()
    if (event.shiftKey && selection.rangeSelection()) return
    if (!event.shiftKey) {
      selection.selectPrimaryClip({ trackId, clipId })
      return
    }
    selection.appendClipToSelection({ trackId, clipId })
  }

  const getWritableSelectedClipIds = (selectedIds: Set<string>) => new Set(
    Array.from(selectedIds).filter((clipId) => canWriteClip(clipId)),
  )

  const selectedClipIds = selection.selectedClipIds

  const showTrackDeleteFailure = (result: TrackDeleteResult | null) => {
    if (result?.status === 'conflict') {
      notify('Track delete blocked', getTrackDeleteConflictMessage(result.reason))
      return
    }
    notify('Track delete failed', 'This track could not be deleted.')
  }

  const snapshotAudioEffectRow = (row: TrackEffectRowSnapshotInput): TrackAudioEffectSnapshot | null => {
    const effect = row.type ?? row.effect
    if (!isAudioEffectKind(effect)) return null
    const instanceId = typeof row.instanceId === 'string' ? row.instanceId : undefined
    const index = typeof row.index === 'number' ? row.index : undefined
    switch (effect) {
      case 'eq':
        return { effect, instanceId, index, params: normalizeEqParams(row.params) }
      case 'compressor':
        return { effect, instanceId, index, params: normalizeCompressorParams(row.params) }
      case 'saturator':
        return { effect, instanceId, index, params: normalizeSaturatorParams(row.params) }
      case 'delay':
        return { effect, instanceId, index, params: normalizeDelayParams(row.params) }
      case 'reverb':
        return { effect, instanceId, index, params: normalizeReverbParams(row.params) }
    }
  }

  const loadTrackDeleteEffects = async (trackId: Track['id']) => {
    const rid = projectId()
    const uid = userId()
    if (!rid || !uid) {
      return {
        eq: undefined,
        compressor: undefined,
        saturator: undefined,
        delay: undefined,
        reverb: undefined,
        instrument: undefined,
        synth: undefined,
        arp: undefined,
      }
    }
    const args = buildTrackEffectQueryArgs({ projectId: rid, trackId })
    const [eqRow, compressorRow, saturatorRow, delayRow, rvRow, instrumentRow, synthRow, arpRow] = await Promise.all([
      convexClient.query(convexApi.effects.getEqForTrack, args),
      convexClient.query(convexApi.effects.getCompressorForTrack, args),
      convexClient.query(convexApi.effects.getSaturatorForTrack, args),
      convexClient.query(convexApi.effects.getDelayForTrack, args),
      convexClient.query(convexApi.effects.getReverbForTrack, args),
      convexClient.query(convexApi.effects.getInstrumentForTrack, args),
      convexClient.query(convexApi.effects.getSynthForTrack, args),
      convexClient.query(convexApi.effects.getArpeggiatorForTrack, args),
    ])
    const effectRows = await convexClient.query(convexApi.effects.listByRoom, { projectId: rid })
    const instrument = instrumentRow ? readInstrumentParamsFromEffectRow(instrumentRow) : undefined
    const audioEffects = effectRows
      .filter((row) => row.targetType === 'track' && row.trackId === trackId)
      .flatMap((row) => {
        const snapshot = snapshotAudioEffectRow(row)
        return snapshot ? [snapshot] : []
      })

    return {
      eq: eqRow?.params,
      compressor: compressorRow?.params ? normalizeCompressorParams(compressorRow.params) : undefined,
      saturator: saturatorRow?.params ? normalizeSaturatorParams(saturatorRow.params) : undefined,
      delay: delayRow?.params ? normalizeDelayParams(delayRow.params) : undefined,
      reverb: rvRow?.params ? normalizeReverbParams(rvRow.params) : undefined,
      audioEffects,
      instrument,
      synth: synthRow?.params,
      arp: arpRow?.params,
    }
  }

  const loadLocalTrackDeleteEffects = async (projectId: string, trackId: Track['id']): Promise<TrackEffectSnapshot> => {
    const [eqRow, compressorRow, saturatorRow, delayRow, rvRow, instrumentRow, synthRow, arpRow, localEffects] = await Promise.all([
      getLocalEffect<TrackEffectSnapshot['eq']>(projectId, trackId, 'eq'),
      getLocalEffect<TrackEffectSnapshot['compressor']>(projectId, trackId, 'compressor'),
      getLocalEffect<TrackEffectSnapshot['saturator']>(projectId, trackId, 'saturator'),
      getLocalEffect<TrackEffectSnapshot['delay']>(projectId, trackId, 'delay'),
      getLocalEffect<TrackEffectSnapshot['reverb']>(projectId, trackId, 'reverb'),
      getLocalEffect(projectId, trackId, 'instrument'),
      getLocalEffect<TrackEffectSnapshot['synth']>(projectId, trackId, 'synth'),
      getLocalEffect<TrackEffectSnapshot['arp']>(projectId, trackId, 'arp'),
      listLocalEffects(projectId),
    ])
    const audioEffects = localEffects
      .filter((row) => row.targetId === trackId)
      .flatMap((row) => {
        const kind = audioEffectKindFromLocalEffect(row.effect)
        if (!kind) return []
        const snapshot = snapshotAudioEffectRow({ ...row, effect: kind })
        return snapshot ? [snapshot] : []
      })

    return {
      eq: eqRow?.params,
      compressor: compressorRow?.params ? normalizeCompressorParams(compressorRow.params) : undefined,
      saturator: saturatorRow?.params ? normalizeSaturatorParams(saturatorRow.params) : undefined,
      delay: delayRow?.params ? normalizeDelayParams(delayRow.params) : undefined,
      reverb: rvRow?.params ? normalizeReverbParams(rvRow.params) : undefined,
      audioEffects,
      instrument: instrumentRow ? readInstrumentParamsFromEffectRow(instrumentRow) : undefined,
      synth: synthRow?.params,
      arp: arpRow?.params,
    }
  }

  const deleteSelectedClips = async () => {
    const selectedIds = selectedClipIds()
    if (selectedIds.size === 0) return
    const writableSelectedIds = getWritableSelectedClipIds(selectedIds)
    if (writableSelectedIds.size === 0) return

    const rid = projectId()
    const uid = userId()
    if (!rid || (!isLocalId('project', rid) && !uid)) return
    const snapshot = tracks()
    const reconcileSelectionAfterDelete = (removedIds: Set<string>) => {
      const remainingSelectedIds = new Set(Array.from(selectedIds).filter((clipId) => !removedIds.has(clipId)))
      const nextPrimary: SelectedClip = (() => {
        if (remainingSelectedIds.size === 0) return null
        for (const track of snapshot) {
          const clip = track.clips.find((entry) => remainingSelectedIds.has(entry.id))
          if (clip) return { trackId: track.id, clipId: clip.id }
        }
        return null
      })()

      batch(() => {
        selection.setSelectedClip(nextPrimary)
        selection.setSelectedClipIds(remainingSelectedIds)
        if (nextPrimary) {
          selection.setSelectedTrackId(nextPrimary.trackId)
          selection.setSelectedFXTarget(nextPrimary.trackId)
        }
      })
    }

    const removedIds = await createTimelineClipWriteAdapter({ projectId: rid, userId: uid }).deleteClips(Array.from(writableSelectedIds))
    if (removedIds.size === 0) return

    try {
      const entry = buildClipDeleteHistoryEntry({ projectId: rid, tracks: snapshot, clipIds: removedIds })
      if (entry.data.items.length > 0) historyPush(entry)
    } catch {}

    removeLocalClips(removedIds)
    reconcileSelectionAfterDelete(removedIds)
  }

  const duplicateSelectedClips = async () => {
    const selectedIds = selectedClipIds()
    if (selectedIds.size === 0) return
    const writableSelectedIds = getWritableSelectedClipIds(selectedIds)
    if (writableSelectedIds.size === 0) return

    const tsSnapshot = tracks()
    const byTrack = new Map<Track['id'], { track: RuntimeTrack; clips: RuntimeClip[] }>()
    for (const track of tsSnapshot) {
      const selected = track.clips.filter(clip => writableSelectedIds.has(clip.id))
      if (selected.length > 0) byTrack.set(track.id, { track, clips: selected })
    }

    const pending: BatchClipCreateItem[] = []

    for (const [trackId, { track, clips: clipsToDup }] of byTrack.entries()) {
      const sorted = clipsToDup.slice().sort((left, right) => left.startSec - right.startSec)
      const groupStart = Math.min(...sorted.map(clip => clip.startSec))
      const groupEnd = Math.max(...sorted.map(clip => clip.startSec + clip.duration))
      const baseStart = groupEnd + 0.0001
      let simulatedClips = track.clips.map(clip => ({ ...clip }))

      for (const clip of sorted) {
        if (!isClipCompatibleWithTrack(track, clip)) continue
        const offset = clip.startSec - groupStart
        const desiredStart = baseStart + offset
        const safeStart = gridEnabled()
          ? calcNonOverlapStartGridAligned(simulatedClips, null, desiredStart, clip.duration, bpm(), gridDenominator())
          : calcNonOverlapStart(simulatedClips, null, desiredStart, clip.duration)
        pending.push({
          trackId,
          buffer: clip.buffer ?? audioBufferCache.getBuffer(clip.id) ?? null,
          clip: {
            ...buildClipCreateSnapshot(clip, { preserveHistoryRef: false }),
            startSec: safeStart,
          },
        })
        simulatedClips = [...simulatedClips, { ...clip, startSec: safeStart }]
      }
    }

    const rid = projectId()
    if (rid && isLocalId('project', rid) && pending.length > 0) {
      const created = await createProjectedLocalClips({
        projectId: rid,
        items: pending,
        insertLocalClip,
        removeLocalClips,
        audioBufferCache: audioBufferCache.writer,
        canProject: () => projectId() === rid,
      })
      const nextSelection = buildCreatedClipSelection(created)
      if (nextSelection) {
        selection.selectClipGroup(nextSelection)
      }
      for (const item of created) {
        pushClipCreateHistory({
          historyPush,
          projectId: rid,
          trackId: item.trackId,
          trackRef: getTrackHistoryRef(tsSnapshot.find((entry) => entry.id === item.trackId)),
          clipId: item.clipId,
          clip: item.clip,
        })
      }
      return
    }

    const uid = userId()
    if (!rid || !uid || pending.length === 0) return

    const created = await createProjectedClips({
      projectId: rid,
      items: pending,
      createMany: async (items, operationId) => {
        const result = await publishSharedTimelineOperation(rid, buildSharedClipCreateManyOperation({ items }, operationId))
        return Array.isArray(result) ? result.map((item) => typeof item === 'string' ? item : null) : []
      },
      insertLocalClip,
      audioBufferCache: audioBufferCache.writer,
      grantClipWrites,
      grantScope: { projectId: rid, userId: uid },
    })

    for (const item of created) {
      pushClipCreateHistory({
        historyPush,
        projectId: rid,
        trackId: item.trackId,
        trackRef: getTrackHistoryRef(tsSnapshot.find((entry) => entry.id === item.trackId)),
        clipId: item.clipId,
        clip: item.clip,
      })
    }

    const nextSelection = buildCreatedClipSelection(created)
    if (nextSelection) {
      selection.selectClipGroup(nextSelection)
    }
  }

  const rangeAutomationFragments = (trackIds: Track['id'][], range: { startSec: number; endSec: number }) => {
    const selectedTrackIds = new Set(trackIds)
    return automationEnvelopes().flatMap((envelope): SectionAutomationFragment[] => {
      if (envelope.target.kind !== 'track' || !selectedTrackIds.has(envelope.target.trackId)) return []
      const fragment = buildAutomationFragment(envelope, range)
      return fragment ? [fragment] : []
    })
  }

  const buildTimelineSectionClipboard = (range: NonNullable<ReturnType<TimelineSelectionController['rangeSelection']>>) => ({
    durationSec: range.endSec - range.startSec,
    trackIds: range.trackIds,
    clips: buildSectionClipFragments({
      tracks: tracks(),
      section: { range, trackIds: range.trackIds },
      bpm: bpm(),
    }),
    automation: rangeAutomationFragments(range.trackIds, range),
  })

  const copyTimelineSelection = () => {
    const range = selection.rangeSelection()
    if (!range) return false
    sectionClipboard.write(buildTimelineSectionClipboard(range))
    return true
  }

  const pasteTimelineSectionAt = async (clipboard: TimelineSectionClipboard | null, destinationStartSec: number) => {
    const rid = projectId()
    if (!clipboard || !rid) return
    const historyEntries: HistoryEntry[] = []
    const pending: BatchClipCreateItem[] = clipboard.clips.map((fragment) => ({
      trackId: fragment.targetTrackId,
      buffer: fragment.buffer,
      clip: {
        ...fragment.clip,
        startSec: destinationStartSec + fragment.startOffsetSec,
      },
    }))
    const tsSnapshot = tracks()
    let created: Array<{ trackId: Track['id']; clipId: string; clip: BatchClipCreateItem['clip'] }> = []
    const uid = userId()
    if (isLocalId('project', rid)) {
      created = await createProjectedLocalClips({
        projectId: rid,
        items: pending,
        insertLocalClip,
        removeLocalClips,
        audioBufferCache: audioBufferCache.writer,
        canProject: () => projectId() === rid,
      })
    } else if (uid) {
      created = await createProjectedClips({
        projectId: rid,
        items: pending,
        createMany: async (items, operationId) => {
          const result = await publishSharedTimelineOperation(rid, buildSharedClipCreateManyOperation({ items }, operationId))
          return Array.isArray(result) ? result.map((item) => typeof item === 'string' ? item : null) : []
        },
        insertLocalClip,
        audioBufferCache: audioBufferCache.writer,
        grantClipWrites,
        grantScope: { projectId: rid, userId: uid },
      })
    }
    for (const item of created) {
      const trackRef = getTrackHistoryRef(tsSnapshot.find((entry) => entry.id === item.trackId))
      historyEntries.push({
        type: 'clip-create',
        projectId: rid,
        data: {
          trackRef,
          clip: {
            clipRef: String(item.clip.historyRef ?? item.clipId),
            currentId: item.clipId,
            ...item.clip,
          },
        },
      })
    }

    const automationWriter = createTimelineAutomationWriteAdapter({ projectId: rid, userId: uid })
    const envelopesByTargetKey = new Map(automationEnvelopes().map((envelope) => [envelope.targetKey, envelope]))
    const updatedAt = Date.now()
    for (const fragment of clipboard.automation) {
      const existing = envelopesByTargetKey.get(fragment.sourceTargetKey)
      const next = pasteAutomationFragment({
        envelope: existing,
        fragment,
        projectId: rid,
        destinationStartSec,
        updatedAt,
      })
      if (await automationWriter.setEnvelope(next)) {
        historyEntries.push(buildAutomationEnvelopeHistoryEntry({ projectId: rid, before: existing ?? null, after: next }))
        applyAutomationEnvelope(next, next.targetKey)
      }
    }
    const historyEntry = buildSectionHistoryEntry(rid, historyEntries)
    if (historyEntry) historyPush(historyEntry)
    const destinationRange = {
      startSec: destinationStartSec,
      endSec: destinationStartSec + clipboard.durationSec,
      trackIds: clipboard.trackIds,
      primaryTrackId: clipboard.trackIds[0] ?? null,
    }
    selection.selectTimeRange(destinationRange)
  }

  const pasteTimelineSelectionAt = async (destinationStartSec: number) => {
    await pasteTimelineSectionAt(sectionClipboard.read(), destinationStartSec)
  }

  const duplicateTimelineSelection = async () => {
    const range = selection.rangeSelection()
    if (!range) {
      await duplicateSelectedClips()
      return
    }
    await pasteTimelineSectionAt(buildTimelineSectionClipboard(range), range.endSec)
  }

  const pasteTimelineSelection = () => {
    if (!sectionClipboard.read() || !projectId()) return false
    const range = selection.rangeSelection()
    void pasteTimelineSelectionAt(range?.startSec ?? playheadSec())
    return true
  }

  const deleteTimelineSelection = async () => {
    const range = selection.rangeSelection()
    if (!range) {
      if (selectedClipIds().size > 0) {
        await deleteSelectedClips()
        return
      }
      const trackId = selection.selectedTrackId()
      if (trackId) requestDeleteTrack(trackId)
      return
    }
    const rid = projectId()
    const uid = userId()
    if (!rid || (!isLocalId('project', rid) && !uid)) return
    const tsSnapshot = tracks()
    const trackIndex = createTimelineTrackIndex(tsSnapshot)
    const intersectingClipIds = intersectingSectionClipIds({
      tracks: tsSnapshot,
      section: { range, trackIds: range.trackIds },
    })
    const blockedClipId = intersectingClipIds.find((clipId) => !canWriteClip(clipId))
    if (blockedClipId) {
      notify('Section delete blocked', 'You do not have permission to edit every clip in this selected range.')
      return
    }
    const patch = buildClipRangeDeletePatch({
      tracks: tsSnapshot,
      section: { range, trackIds: range.trackIds },
      bpm: bpm(),
    })
    const clipWriter = createTimelineClipWriteAdapter({ projectId: rid, userId: uid })
    const removedIds = await clipWriter.deleteClips(patch.deleteClipIds)
    if (removedIds.size !== patch.deleteClipIds.length) return
    const appliedUpdates: typeof patch.updateClips = []
    for (const update of patch.updateClips) {
      if (await clipWriter.updateClipTiming({ clipId: update.clipId, ...update.timing })) {
        appliedUpdates.push(update)
      } else {
        return
      }
    }
    let created: Array<{ trackId: Track['id']; clipId: string; clip: BatchClipCreateItem['clip'] }> = []
    if (patch.createClips.length > 0) {
      if (isLocalId('project', rid)) {
        created = await createProjectedLocalClips({
          projectId: rid,
          items: patch.createClips,
          insertLocalClip,
          removeLocalClips,
          audioBufferCache: audioBufferCache.writer,
          canProject: () => projectId() === rid,
        })
      } else if (uid) {
        created = await createProjectedClips({
          projectId: rid,
          items: patch.createClips,
          createMany: async (items, operationId) => {
            const result = await publishSharedTimelineOperation(rid, buildSharedClipCreateManyOperation({ items }, operationId))
            return Array.isArray(result) ? result.map((item) => typeof item === 'string' ? item : null) : []
          },
          insertLocalClip,
          audioBufferCache: audioBufferCache.writer,
          grantClipWrites,
          grantScope: { projectId: rid, userId: uid },
        })
      }
      if (created.length !== patch.createClips.length) return
    }
    const historyEntries: HistoryEntry[] = []
    if (removedIds.size > 0) removeLocalClips(removedIds)
    const deleteEntry = buildClipDeleteHistoryEntry({ projectId: rid, tracks: tsSnapshot, clipIds: removedIds })
    if (deleteEntry.data.items.length > 0) historyEntries.push(deleteEntry)
    for (const update of appliedUpdates) {
      commitClipTiming(update.clipId, update.timing)
      if (update.timing.audioWarp) commitClipAudioWarp(update.clipId, update.timing.audioWarp)
      const match = trackIndex.clipById.get(update.clipId)
      if (match) {
        historyEntries.push(
          buildClipTimingHistoryEntry({
            projectId: rid,
            clip: match,
            from: {
              startSec: match.startSec,
              duration: match.duration,
              leftPadSec: match.leftPadSec,
              bufferOffsetSec: match.bufferOffsetSec,
              midiOffsetBeats: match.midiOffsetBeats,
              audioWarp: match.audioWarp,
            },
            to: update.timing,
          }),
        )
      }
    }
    if (created.length > 0) {
      for (const item of created) {
        historyEntries.push({
          type: 'clip-create',
          projectId: rid,
          data: {
            trackRef: getTrackHistoryRef(trackIndex.trackById.get(item.trackId)),
            clip: {
              clipRef: String(item.clip.historyRef ?? item.clipId),
              currentId: item.clipId,
              ...item.clip,
            },
          },
        })
      }
    }
    const automationWriter = createTimelineAutomationWriteAdapter({ projectId: rid, userId: uid })
    const selectedTrackIds = new Set(range.trackIds)
    const updatedAt = Date.now()
    for (const envelope of automationEnvelopes()) {
      if (envelope.target.kind !== 'track' || !selectedTrackIds.has(envelope.target.trackId)) continue
      const next = deleteAutomationRange({ envelope, range, updatedAt })
      if (!next) continue
      if (await automationWriter.setEnvelope(next)) {
        historyEntries.push(buildAutomationEnvelopeHistoryEntry({ projectId: rid, before: envelope, after: next }))
        applyAutomationEnvelope(next, next.targetKey)
      }
    }
    const historyEntry = buildSectionHistoryEntry(rid, historyEntries)
    if (historyEntry) historyPush(historyEntry)
    selection.selectTimeRange(range)
  }

  const performDeleteTrack = async (trackId: Track['id']) => {
    const snapshot = tracks()
    const track = snapshot.find(entry => entry.id === trackId)
    if (!track) return
    const rid = projectId()
    if (!rid) return
    const collectDeletedTrackIds = (rootTrackId: Track['id']) => {
      const deletedIds = new Set<Track['id']>()
      const collect = (currentTrackId: Track['id']) => {
        if (deletedIds.has(currentTrackId)) return
        deletedIds.add(currentTrackId)
        for (const child of snapshot) {
          if (child.groupId === currentTrackId) collect(child.id)
        }
      }
      collect(rootTrackId)
      return deletedIds
    }
    const deletedTrackIds = collectDeletedTrackIds(trackId)
    const trackAutomation = automationEnvelopes().filter((envelope) => (
      envelope.target.kind === 'track' && deletedTrackIds.has(envelope.target.trackId)
    ))
    const completeDeletedTrack = (historyEntries: ReturnType<typeof buildTrackDeleteHistoryEntry>[]) => {
      const sectionEntry = buildSectionHistoryEntry(rid, historyEntries)
      if (sectionEntry) historyPush(sectionEntry)
      for (const envelope of trackAutomation) applyAutomationEnvelope(undefined, envelope.targetKey)
      for (const deletedTrackId of deletedTrackIds) removeLocalTrack(deletedTrackId)
      const next = snapshot.filter(entry => !deletedTrackIds.has(entry.id))
      batch(() => {
        if (next.length > 0) {
          selection.selectTrackTarget(next[0].id, { clearClipSelection: true })
        } else {
          selection.selectMasterTarget()
        }
      })
    }

    if (rid && isLocalId('project', rid)) {
      let historyEntries: ReturnType<typeof buildTrackDeleteHistoryEntry>[] = []
      try {
        for (const deletedTrack of snapshot.filter((entry) => deletedTrackIds.has(entry.id))) {
          historyEntries.push(buildTrackDeleteHistoryEntry({
            projectId: rid,
            track: deletedTrack,
            tracks: snapshot,
            effects: await loadLocalTrackDeleteEffects(rid, deletedTrack.id),
            automation: trackAutomation.filter((envelope) => envelope.target.kind === 'track' && envelope.target.trackId === deletedTrack.id),
          }))
        }
      } catch {
        showTrackDeleteFailure(null)
        return
      }
      for (const deletedTrackId of deletedTrackIds) {
        await createLocalTimelineRepository(rid).deleteTrack(deletedTrackId)
      }
      completeDeletedTrack(historyEntries)
      return
    }

    const uid = userId()
    if (!uid) return

    let historyEntries: ReturnType<typeof buildTrackDeleteHistoryEntry>[] = []
    try {
      if (rid) {
        for (const deletedTrack of snapshot.filter((entry) => deletedTrackIds.has(entry.id))) {
          historyEntries.push(buildTrackDeleteHistoryEntry({
            projectId: rid,
            track: deletedTrack,
            tracks: snapshot,
            effects: await loadTrackDeleteEffects(deletedTrack.id),
            automation: trackAutomation.filter((envelope) => envelope.target.kind === 'track' && envelope.target.trackId === deletedTrack.id),
          }))
        }
      }
    } catch {
      showTrackDeleteFailure(null)
      return
    }

    const result = await convexClient.mutation(
      convexApi.tracks.remove,
      buildTrackDeleteMutationInput({ trackId }),
    )
    if (result.status !== 'deleted') {
      showTrackDeleteFailure(result)
      return
    }
    completeDeletedTrack(historyEntries)
  }

  const requestDeleteTrack = (trackId: Track['id']) => {
    const track = tracks().find(entry => entry.id === trackId)
    if (!track) return

    if (track.clips.length > 0) {
      setPendingDeleteTrackId(trackId)
      setConfirmOpen(true)
      return
    }

    void performDeleteTrack(trackId)
  }

  return {
    onClipPointerUp,
    deleteSelectedClips,
    duplicateSelectedClips,
    duplicateTimelineSelection,
    deleteTimelineSelection,
    copyTimelineSelection,
    pasteTimelineSelection,
    performDeleteTrack,
    requestDeleteTrack,
  }
}
