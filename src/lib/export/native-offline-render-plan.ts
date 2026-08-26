import type { ExportRange } from '@daw-browser/audio-engine/export-range'
import { getExportRangeBounds } from '@daw-browser/audio-engine/export-range'
import {
  compilePortableExportSnapshot,
  type PortableExportSnapshot,
} from '@daw-browser/audio-engine/portable-export-snapshot'
import {
  mapNativeSessionAssets,
  serializeNativeGraph,
  serializeNativeInstrumentStates,
  serializeNativeScheduleWindow,
  type NativeHostPcmAsset,
  type NativeOfflineRenderPlan,
} from '@daw-browser/audio-engine/native-host-wire'
import { compilePortableFrameSchedule } from '~/lib/portable-frame-schedule'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { ExportFx } from '@daw-browser/audio-engine/export-mixdown'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import { nativeExternalAttachmentPlanSchema, type NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
import type { AutomationEnvelope } from '@daw-browser/shared'
import {
  nativeAudioHostMaximumAssetChannels,
  nativeAudioHostMaximumAssetFrames,
  nativeAudioHostMaximumInstalledAssets,
  nativeAudioHostMaximumScheduleRecords,
} from '@daw-browser/desktop-protocol/native-audio-host'

export const nativeExternalLatencyFrames = (
  attachments: NativeExternalAttachmentPlan | undefined,
) => {
  const latencyByNode = new Map<string, number>()
  for (const attachment of attachments?.attachments ?? []) {
    if (attachment.bypassed) continue
    const latency = attachment.declaredLatencyFrames + attachment.workerTransport.maximumFrames
    const previous = latencyByNode.get(attachment.graphNodeId) ?? 0
    if (!Number.isSafeInteger(previous + latency)) {
      throw new Error(`Native VST3 latency exceeds the supported graph range for "${attachment.graphNodeId}".`)
    }
    latencyByNode.set(attachment.graphNodeId, previous + latency)
  }
  return latencyByNode
}

const planarBytes = (planes: readonly Float32Array[]) => {
  const output = new Uint8Array(planes.reduce((total, plane) => total + plane.byteLength, 0))
  let offset = 0
  for (const plane of planes) {
    output.set(new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength), offset)
    offset += plane.byteLength
  }
  return output
}

const nativeAssets = (snapshot: Extract<PortableExportSnapshot, { supported: true }>) => {
  const sessionAssets = mapNativeSessionAssets(snapshot.assets.map(({ asset }) => asset))
  const byAssetId = new Map(snapshot.assets.map((entry) => [entry.asset.assetId, entry]))
  const assets: NativeHostPcmAsset[] = sessionAssets.map(({ asset, sessionAssetId }) => {
    const entry = byAssetId.get(asset.assetId)
    if (!entry) throw new Error(`Native export asset "${asset.assetId}" is missing PCM.`)
    return {
      sessionAssetId,
      frameCount: asset.frameCount,
      sampleRateHz: asset.sampleRateHz,
      channelCount: asset.channelCount,
      planarPcm: planarBytes(entry.pcm.planes),
    }
  })
  return { sessionAssets, assets }
}

export const compileNativeOfflineRenderPlan = (input: {
  tracks: readonly RuntimeTrack[]
  fx: ExportFx
  automationEnvelopes: readonly AutomationEnvelope[]
  sidechainRoutes: readonly ExternalSidechainRoute[]
  bpm: number
  timeSignature?: { numerator: number; denominator: number }
  range: ExportRange
  sampleRateHz: number
  channelCount: 1 | 2
  tailFrames: number
  externalAttachments?: NativeExternalAttachmentPlan
  capturedVstStates?: readonly {
    instanceId: string
    bytes: Uint8Array
    sha256: string
  }[]
}): NativeOfflineRenderPlan => {
  const sourceBounds = getExportRangeBounds(input.tracks, input.range)
  const renderRange: ExportRange = {
    mode: 'custom',
    startSec: sourceBounds.startSec,
    endSec: sourceBounds.endSec + input.tailFrames / input.sampleRateHz,
  }
  const unsupported: string[] = []
  if (input.sidechainRoutes.length > 0) unsupported.push('Native Phase A export does not support sidechain routing.')
  if (input.automationEnvelopes.some((envelope) => envelope.enabled)) {
    unsupported.push('Native Phase A export does not support automation.')
  }
  for (const track of input.tracks) {
    for (const clip of track.clips) {
      if (clip.audioWarp?.enabled === true) unsupported.push(`${clip.id}: Native Phase A export does not support warp.`)
    }
    if (input.fx.trackFx?.[track.id]?.arp?.enabled) {
      unsupported.push(`${track.id}: Native Phase A export does not support arpeggiators.`)
    }
  }
  if (unsupported.length > 0) throw new Error(unsupported.join(' '))
  const externalAttachments = input.externalAttachments
    ? nativeExternalAttachmentPlanSchema.parse(input.externalAttachments)
    : undefined
  const externalLatencyFrames = nativeExternalLatencyFrames(externalAttachments)
  const snapshot = compilePortableExportSnapshot({
    tracks: input.tracks,
    bpm: input.bpm,
    range: renderRange,
    sampleRateHz: input.sampleRateHz,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    fx: input.fx,
    sidechainRoutes: [],
    allowInstruments: true,
    externalLatencyFrames,
    capabilityTarget: 'native',
  })
  if (!snapshot.supported) throw new Error(snapshot.reasons.join(' '))
  const schedule = compilePortableFrameSchedule({
    revision: 1,
    transportEpoch: 1,
    sampleRateHz: input.sampleRateHz,
    bpm: input.bpm,
    timeOrigin: { timelineSec: sourceBounds.startSec, frame: 0 },
    rangeEndSec: sourceBounds.endSec,
    tracks: input.tracks,
    automationEnvelopes: [],
    arpeggiators: new Map(Object.keys(input.fx.trackFx ?? {}).map((trackId) => {
      const arp = input.fx.trackFx?.[trackId]?.arp
      return [trackId, arp?.enabled ? arp : undefined]
    })),
    stableNoteIds: true,
    eventRangeStartSec: sourceBounds.startSec,
    noteScheduleStartSec: sourceBounds.startSec,
  })
  if (schedule.events.some((event) => event.type !== 'note-on' && event.type !== 'note-off')) {
    throw new Error('Native Phase A export does not support MIDI expression.')
  }
  const { sessionAssets, assets } = nativeAssets(snapshot)
  if (
    assets.length > nativeAudioHostMaximumInstalledAssets
    || assets.some((asset) => asset.channelCount > nativeAudioHostMaximumAssetChannels
      || asset.frameCount > nativeAudioHostMaximumAssetFrames)
  ) {
    throw new Error('Native Phase A export exceeds the offline asset capacity.')
  }
  const totalFrames = Math.ceil((renderRange.endSec - renderRange.startSec) * input.sampleRateHz)
  const noteEvents = schedule.events.filter((event): event is Extract<typeof event, { type: 'note-on' | 'note-off' }> => (
    event.type === 'note-on' || event.type === 'note-off'
  ))
  const instrumentEvents = noteEvents.map((event) => ({
    nodeId: event.target.trackId,
    noteId: event.noteId,
    sequence: event.sequence,
    frameOffset: event.frame,
    type: event.type,
    channel: 0,
    note: event.pitch,
    value: event.type === 'note-on' ? event.velocity : 0,
  }))
  const sampleSourceEvents = snapshot.events.filter((event) => event.startFrame < totalFrames)
  const scheduleWindows: Array<Uint8Array> = []
  const sortedInstrumentEvents = [...instrumentEvents].sort((left, right) => (
    left.frameOffset - right.frameOffset || left.sequence - right.sequence
  ))
  const sortedSourceEvents = [...sampleSourceEvents].sort((left, right) => (
    left.startFrame - right.startFrame || left.sequence - right.sequence
  ))
  let windowStart = 0
  let instrumentOffset = 0
  let sourceOffset = 0
  if (sortedInstrumentEvents.length === 0 && sortedSourceEvents.length === 0) {
    scheduleWindows.push(serializeNativeScheduleWindow({
      revision: 1,
      epoch: 1,
      startFrame: 0,
      endFrame: totalFrames,
      assets: sessionAssets,
    }))
  } else {
    while (windowStart < totalFrames) {
      if (sortedInstrumentEvents[instrumentOffset] === undefined
        && sortedSourceEvents[sourceOffset] === undefined) {
        scheduleWindows.push(serializeNativeScheduleWindow({
          revision: 1,
          epoch: 1,
          startFrame: windowStart,
          endFrame: totalFrames,
          assets: sessionAssets,
        }))
        break
      }
      const windowInstrumentStart = instrumentOffset
      const windowSourceStart = sourceOffset
      let lastFrame = windowStart
      while (instrumentOffset < sortedInstrumentEvents.length
        || sourceOffset < sortedSourceEvents.length) {
        const nextInstrument = sortedInstrumentEvents[instrumentOffset]
        const nextSource = sortedSourceEvents[sourceOffset]
        const nextFrame = Math.min(
          nextInstrument?.frameOffset ?? Number.POSITIVE_INFINITY,
          nextSource?.startFrame ?? Number.POSITIVE_INFINITY,
        )
        if (!Number.isFinite(nextFrame) || nextFrame < windowStart) break
        let instrumentAtFrame = 0
        while (sortedInstrumentEvents[instrumentOffset + instrumentAtFrame]?.frameOffset === nextFrame) {
          instrumentAtFrame += 1
        }
        let sourceAtFrame = 0
        while (sortedSourceEvents[sourceOffset + sourceAtFrame]?.startFrame === nextFrame) {
          sourceAtFrame += 1
        }
        const instrumentCount = instrumentOffset - windowInstrumentStart + instrumentAtFrame
        const sourceCount = sourceOffset - windowSourceStart + sourceAtFrame
        if (
          instrumentCount > 256
          || sourceCount > 256
          || instrumentCount + sourceCount > nativeAudioHostMaximumScheduleRecords
        ) break
        instrumentOffset += instrumentAtFrame
        sourceOffset += sourceAtFrame
        lastFrame = nextFrame
        if (
          instrumentOffset - windowInstrumentStart >= 256
          || sourceOffset - windowSourceStart >= 256
          || instrumentOffset - windowInstrumentStart + sourceOffset - windowSourceStart >= nativeAudioHostMaximumScheduleRecords
        ) break
      }
      if (instrumentOffset === windowInstrumentStart && sourceOffset === windowSourceStart) {
        throw new Error('Native Phase A export contains too many events at one frame.')
      }
      const nextFrame = Math.min(
        sortedInstrumentEvents[instrumentOffset]?.frameOffset ?? totalFrames,
        sortedSourceEvents[sourceOffset]?.startFrame ?? totalFrames,
      )
      const endFrame = Math.max(windowStart + 1, nextFrame > lastFrame ? nextFrame : lastFrame + 1)
      scheduleWindows.push(serializeNativeScheduleWindow({
        revision: 1,
        epoch: 1,
        windowId: scheduleWindows.length + 1,
        startFrame: windowStart,
        endFrame: Math.min(totalFrames, endFrame),
        endsSchedule: instrumentOffset === sortedInstrumentEvents.length && sourceOffset === sortedSourceEvents.length,
        instrumentEvents: sortedInstrumentEvents.slice(windowInstrumentStart, instrumentOffset),
        sampleSourceEvents: sortedSourceEvents.slice(windowSourceStart, sourceOffset),
        assets: sessionAssets,
      }))
      windowStart = Math.min(totalFrames, endFrame)
    }
  }
  const scheduleBytes = scheduleWindows[0]
  if (!scheduleBytes) throw new Error('Native Phase A export did not produce a schedule.')
  const instrumentStates = snapshot.graph.nodes.flatMap((node) => (
    node.kind === 'instrument' && node.instrument
      ? [{ nodeId: node.id, state: node.instrument }]
      : []
  ))
  return {
    version: 1,
    sampleRateHz: input.sampleRateHz,
    channelCount: input.channelCount,
    totalFrames,
    blockFrames: Math.min(4_096, totalFrames),
    graph: serializeNativeGraph(snapshot.graph),
    externalAttachments: externalAttachments ? externalAttachments : undefined,
    capturedVstStates: input.capturedVstStates ? input.capturedVstStates : undefined,
    instrumentStates: instrumentStates.length === 0 ? undefined : serializeNativeInstrumentStates(instrumentStates, sessionAssets),
    assets,
    transport: {
      epoch: 1,
      running: true,
      frame: 0,
      bpm: input.bpm,
      timeSignatureNumerator: input.timeSignature?.numerator ?? 4,
      timeSignatureDenominator: input.timeSignature?.denominator ?? 4,
      transitionId: 1n,
    },
    schedule: scheduleBytes,
    scheduleWindows: scheduleWindows.length > 1 ? scheduleWindows : undefined,
  }
}
