import type { Track } from '@daw-browser/timeline-core/types'
import {
  normalizeSharedUngroupRestoreAutomation,
  normalizeSharedUngroupRestoreEffects,
  type SharedUngroupRestoreAutomation,
  type SharedUngroupRestoreEffect,
} from '@daw-browser/shared'

import { buildTrackUngroupHistoryEntry } from './builders'
import type { HistoryEntry, TrackAutomationSnapshot, TrackEffectSnapshot } from './types'

type SharedUngroupResult = {
  status: 'applied'
  group: {
    historyRef?: string
    index: number
    kind?: string
    parentGroupId?: string
    collapsed?: boolean
    color?: string
    volume: number
    muted: boolean
    soloed: boolean
    outputTargetId?: string
    sends: Array<{ targetId: string; amount: number; tap?: 'pre-fx' | 'pre-fader' | 'post-fader' }>
  }
  children: Array<{ trackId: string; nextOutputTargetId?: string }>
  effects: SharedUngroupRestoreEffect[]
  automation: SharedUngroupRestoreAutomation[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readSendTap = (value: unknown): 'pre-fx' | 'pre-fader' | 'post-fader' | undefined => (
  value === 'pre-fx' || value === 'pre-fader' || value === 'post-fader' ? value : undefined
)

export const readSharedUngroupResult = (value: unknown): SharedUngroupResult | null => {
  if (!isRecord(value) || value.status !== 'applied' || !isRecord(value.group) || !Array.isArray(value.children)) return null
  const group = value.group
  if (
    typeof group.index !== 'number'
    || typeof group.volume !== 'number'
    || typeof group.muted !== 'boolean'
    || typeof group.soloed !== 'boolean'
    || !Array.isArray(group.sends)
  ) return null
  const children = value.children.flatMap((child) => (
    isRecord(child) && typeof child.trackId === 'string'
      ? [{ trackId: child.trackId, nextOutputTargetId: typeof child.nextOutputTargetId === 'string' ? child.nextOutputTargetId : undefined }]
      : []
  ))
  const sends = group.sends.flatMap((send) => (
    isRecord(send) && typeof send.targetId === 'string' && typeof send.amount === 'number'
      && (send.tap === undefined || send.tap === 'pre-fx' || send.tap === 'pre-fader' || send.tap === 'post-fader')
      ? [{ targetId: send.targetId, amount: send.amount, tap: readSendTap(send.tap) }]
      : []
  ))
  const effects = normalizeSharedUngroupRestoreEffects(value.effects)
  const automation = normalizeSharedUngroupRestoreAutomation(value.automation)
  if (
    children.length !== value.children.length
    || sends.length !== group.sends.length
    || !effects
    || !automation
  ) return null
  return {
    status: 'applied',
    group: {
      historyRef: typeof group.historyRef === 'string' ? group.historyRef : undefined,
      index: group.index,
      kind: typeof group.kind === 'string' ? group.kind : undefined,
      parentGroupId: typeof group.parentGroupId === 'string' ? group.parentGroupId : undefined,
      collapsed: typeof group.collapsed === 'boolean' ? group.collapsed : undefined,
      color: typeof group.color === 'string' ? group.color : undefined,
      volume: group.volume,
      muted: group.muted,
      soloed: group.soloed,
      outputTargetId: typeof group.outputTargetId === 'string' ? group.outputTargetId : undefined,
      sends,
    },
    children,
    effects,
    automation,
  }
}

export const buildCommittedSharedUngroupHistoryEntry = (input: {
  projectId: string
  tracks: Track[]
  groupTrack: Track
  effects: TrackEffectSnapshot
  automation: TrackAutomationSnapshot
  result: SharedUngroupResult
}): Extract<HistoryEntry, { type: 'track-ungroup' }> => {
  const localAudioEffects = input.effects.audioEffects ?? []
  const audioEffects = input.result.effects.flatMap((effect) => {
    const local = localAudioEffects.find((candidate) => (
      candidate.effect === effect.type && candidate.instanceId === effect.instanceId
    ))
    return local ? [{ ...local, index: effect.index ?? local.index }] : []
  })
  const effects: TrackEffectSnapshot = {
    audioEffects,
    instrument: input.result.effects.some((effect) => effect.type === 'instrument') ? input.effects.instrument : undefined,
    synth: input.result.effects.some((effect) => effect.type === 'synth') ? input.effects.synth : undefined,
    arp: input.result.effects.some((effect) => effect.type === 'arpeggiator') ? input.effects.arp : undefined,
  }
  const automationByParameterId = new Map(input.automation.map((envelope) => [envelope.parameterId, envelope]))
  const automation = input.result.automation.flatMap((committed) => {
    const local = automationByParameterId.get(committed.parameterId)
    return local ? [{ ...local, enabled: committed.enabled, points: committed.points, updatedAt: committed.updatedAt }] : []
  })
  const groupTrack: Track = {
    ...input.groupTrack,
    historyRef: input.result.group.historyRef ?? input.groupTrack.historyRef,
    kind: input.result.group.kind === 'instrument' ? 'instrument' : 'audio',
    groupId: input.result.group.parentGroupId,
    collapsed: input.result.group.collapsed,
    color: input.result.group.color,
    volume: input.result.group.volume,
    muted: input.result.group.muted,
    soloed: input.result.group.soloed,
    outputTargetId: input.result.group.outputTargetId,
    sends: input.result.group.sends,
  }
  return buildTrackUngroupHistoryEntry({
    projectId: input.projectId,
    tracks: input.tracks,
    groupTrack,
    childTrackIds: input.result.children.map((child) => child.trackId),
    nextOutputTargetIdsByTrackId: new Map(input.result.children.map((child) => [child.trackId, child.nextOutputTargetId])),
    effects,
    automation,
  })
}
