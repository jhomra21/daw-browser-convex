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
  type NativeVstAutomationSegment,
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
  nativeAudioHostMaximumInstrumentEvents,
  nativeAudioHostMaximumScheduleAutomationSegments,
  nativeAudioHostMaximumScheduleRecords,
  nativeAudioHostMaximumSourceEvents,
} from '@daw-browser/desktop-protocol/native-audio-host'
import {
  isExternalVstAutomationEnvelope,
  projectNativeVstAutomationSegments,
} from '~/lib/native-vst-automation'

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

const nativeOfflineBlockFrames = (
  totalFrames: number,
  attachments: NativeExternalAttachmentPlan | undefined,
) => Math.min(
  4_096,
  totalFrames,
  ...((attachments?.attachments ?? [])
    .filter((attachment) => !attachment.bypassed)
    .map((attachment) => attachment.workerTransport.maximumFrames)),
)

const assertNativeVstEventCapacity = (input: Readonly<{
  attachments: NativeExternalAttachmentPlan | undefined
  instrumentEvents: readonly Readonly<{ nodeId: string; frameOffset: number }>[]
  automationSegments: readonly NativeVstAutomationSegment[]
  blockFrames: number
  totalFrames: number
}>) => {
  if (!input.attachments || input.automationSegments.length === 0) return
  for (const attachment of input.attachments.attachments) {
    if (attachment.bypassed) continue
    const automationSegments = input.automationSegments.filter((segment) => (
      segment.instanceId === attachment.instanceId
    ))
    if (automationSegments.length === 0) continue
    const midiEvents = input.instrumentEvents.filter((event) => event.nodeId === attachment.graphNodeId)
    for (let startFrame = 0; startFrame < input.totalFrames; startFrame += input.blockFrames) {
      const endFrame = Math.min(input.totalFrames, startFrame + input.blockFrames)
      const midiCount = midiEvents.filter((event) => (
        event.frameOffset >= startFrame && event.frameOffset < endFrame
      )).length
      const automationCount = automationSegments.reduce((count, segment) => {
        const overlaps = segment.startFrame < endFrame && segment.endFrame > startFrame
        if (!overlaps) return count
        return count + 1 + (segment.interpolation === 'linear' && segment.endFrame < endFrame ? 1 : 0)
      }, 0)
      if (midiCount + automationCount > attachment.workerTransport.maximumEventsPerBlock) {
        throw new Error(
          `Native VST3 export exceeds the callback event capacity for "${attachment.instanceId}" at frame ${startFrame}.`,
        )
      }
    }
  }
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
  const externalAttachments = input.externalAttachments
    ? nativeExternalAttachmentPlanSchema.parse(input.externalAttachments)
    : undefined
  const unsupported: string[] = []
  if (input.sidechainRoutes.length > 0) unsupported.push('Native Phase A export does not support sidechain routing.')
  const unsupportedAutomation = input.automationEnvelopes.filter((envelope) => (
    envelope.enabled && !isExternalVstAutomationEnvelope(envelope, externalAttachments)
  ))
  if (unsupportedAutomation.length > 0) {
    unsupported.push('Native Phase A export supports VST3 parameter automation only.')
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
  const blockFrames = nativeOfflineBlockFrames(totalFrames, externalAttachments)
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
  const automationSegments: NativeVstAutomationSegment[] = []
  const sortedInstrumentEvents = [...instrumentEvents].sort((left, right) => (
    left.frameOffset - right.frameOffset || left.sequence - right.sequence
  ))
  const sortedSourceEvents = [...sampleSourceEvents].sort((left, right) => (
    left.startFrame - right.startFrame || left.sequence - right.sequence
  ))
  const automationForWindow = (startFrame: number, endFrame: number) => (
    projectNativeVstAutomationSegments({
      automationEnvelopes: input.automationEnvelopes,
      externalAttachments,
      sampleRateHz: input.sampleRateHz,
      timelineOriginSec: sourceBounds.startSec,
      startFrame,
      endFrame,
    })
  )
  let windowStart = 0
  let instrumentOffset = 0
  let sourceOffset = 0
  while (windowStart < totalFrames) {
    let windowEnd = totalFrames
    let nextInstrumentOffset = instrumentOffset
    let nextSourceOffset = sourceOffset
    let windowAutomation = automationForWindow(windowStart, windowEnd)
    for (;;) {
      nextInstrumentOffset = instrumentOffset
      while (sortedInstrumentEvents[nextInstrumentOffset]?.frameOffset < windowEnd) {
        nextInstrumentOffset += 1
      }
      nextSourceOffset = sourceOffset
      while (sortedSourceEvents[nextSourceOffset]?.startFrame < windowEnd) {
        nextSourceOffset += 1
      }
      const instrumentCount = nextInstrumentOffset - instrumentOffset
      const sourceCount = nextSourceOffset - sourceOffset
      windowAutomation = automationForWindow(windowStart, windowEnd)
      const fits = instrumentCount <= nativeAudioHostMaximumInstrumentEvents
        && sourceCount <= nativeAudioHostMaximumSourceEvents
        && windowAutomation.length <= nativeAudioHostMaximumScheduleAutomationSegments
        && instrumentCount + sourceCount + windowAutomation.length <= nativeAudioHostMaximumScheduleRecords
      if (fits) break
      if (windowEnd <= windowStart + 1) {
        throw new Error('Native Phase A export contains too many scheduled events at one frame.')
      }
      windowEnd = windowStart + Math.max(1, Math.floor((windowEnd - windowStart) / 2))
    }
    automationSegments.push(...windowAutomation)
    scheduleWindows.push(serializeNativeScheduleWindow({
      revision: 1,
      epoch: 1,
      windowId: scheduleWindows.length + 1,
      startFrame: windowStart,
      endFrame: windowEnd,
      endsSchedule: windowEnd >= totalFrames,
      instrumentEvents: sortedInstrumentEvents.slice(instrumentOffset, nextInstrumentOffset),
      sampleSourceEvents: sortedSourceEvents.slice(sourceOffset, nextSourceOffset),
      vstAutomationSegments: windowAutomation,
      assets: sessionAssets,
    }))
    instrumentOffset = nextInstrumentOffset
    sourceOffset = nextSourceOffset
    windowStart = windowEnd
  }
  assertNativeVstEventCapacity({
    attachments: externalAttachments,
    instrumentEvents,
    automationSegments,
    blockFrames,
    totalFrames,
  })
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
    blockFrames,
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
