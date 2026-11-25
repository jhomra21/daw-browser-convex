import { expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { AUDIO_EFFECT_PARAMS_VERSION, createDefaultCompressorParams, type AutomationEnvelope, type JsonValue } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import { z } from 'zod'

import { convexApi, convexClient } from '~/lib/convex'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'

import { execRedo, execUndo, type Deps } from './exec'
import { createUndoManager } from './manager'
import { normalizePersistedHistory, serializePersistedHistory } from './persisted-history'
import type { HistoryEntry } from './types'

// Regenerate with UPDATE_HISTORY_FIXTURES=1 only when the persisted format changes on purpose.
const FORMAT_FIXTURE = fileURLToPath(new URL('./history-format.fixture.json', import.meta.url))
const BEHAVIOR_FIXTURE = fileURLToPath(new URL('./history-behavior.fixture.json', import.meta.url))
const projectId = 'project:history-format'

const envelope: AutomationEnvelope = {
  id: 'automation-1',
  projectId,
  target: { kind: 'track', trackId: 'track-1' },
  targetKey: 'track:track-1:volume',
  parameterId: 'volume',
  enabled: true,
  points: [{ id: 'point-1', timeSec: 0, value: 0.5, interpolation: 'linear' }],
  updatedAt: 1,
}

const timing = { startSec: 1, duration: 2, leftPadSec: 0.5, gain: 0.8 }
const routing = { sends: [{ targetTrackRef: 'track-2', amount: 0.5, tap: 'post-fader' as const }], outputTargetRef: 'track-2' }
const fades = { fadeInSec: 0, fadeOutSec: 1, fadeInCurve: 0, fadeOutCurve: 0 }
const clip = { clipRef: 'clip-1', startSec: 0, duration: 4, name: 'Clip 1' }
const trackSnapshot = { trackRef: 'track-3', index: 2, name: 'Track 3', volume: 0.7, muted: false, soloed: false, kind: 'audio' as const, channelRole: 'track' as const, routing: { sends: [] } }
const compressor = createDefaultCompressorParams()

type EntryOfEveryType = { [Type in HistoryEntry['type']]: Extract<HistoryEntry, { type: Type }> }

const entryOfEveryType = (): EntryOfEveryType => {
  const volume: Extract<HistoryEntry, { type: 'track-volume' }> = { type: 'track-volume', projectId, data: { trackRef: 'track-1', scope: 'local', from: 0.5, to: 0.9 } }

  return {
    'section-edit': { type: 'section-edit', projectId, data: { entries: [volume, { type: 'clip-color', projectId, data: { clipRef: 'clip-1', from: undefined, to: 'track-red' } }] } },
    'control-range-delete': { type: 'control-range-delete', projectId, data: { trackRefs: ['track-1'], startSec: 0, endSec: 2, recoveryId: 'recovery-1' } },
    'clip-create': { type: 'clip-create', projectId, data: { trackRef: 'track-1', clip: { ...clip, currentId: 'clip-1' } } },
    'clip-delete': { type: 'clip-delete', projectId, data: { items: [{ trackRef: 'track-1', clip: { ...clip, recoveryId: 'recovery-1' } }] } },
    'clips-move': { type: 'clips-move', projectId, data: { moves: [{ clipRef: 'clip-1', from: { trackRef: 'track-1', startSec: 0 }, to: { trackRef: 'track-2', startSec: 3 } }] } },
    'clip-timing': { type: 'clip-timing', projectId, data: { clipRef: 'clip-1', from: { startSec: 0, duration: 4 }, to: timing } },
    'clip-fades': { type: 'clip-fades', projectId, data: { clipRef: 'clip-1', from: fades, to: { ...fades, fadeInSec: 2 } } },
    'clip-audio-warp': { type: 'clip-audio-warp', projectId, data: { clipRef: 'clip-1', from: { audioWarp: { enabled: false, mode: 'repitch' } }, to: { audioWarp: { enabled: true, mode: 'repitch' } } } },
    'clip-midi-notes': { type: 'clip-midi-notes', projectId, data: { clipRef: 'clip-1', changes: [{ id: 'note-1', after: { id: 'note-1', beat: 0, length: 1, pitch: 60, channel: 0, velocity: 100 } }] } },
    'clip-color': { type: 'clip-color', projectId, data: { clipRef: 'clip-1', from: 'track-blue', to: 'track-red' } },
    'track-create': { type: 'track-create', projectId, data: { trackRef: 'track-4', currentTrackId: 'track-4', name: 'Track 4', index: 3, kind: 'audio', channelRole: 'track', color: 'track-blue' } },
    'track-clip-create': { type: 'track-clip-create', projectId, data: { track: { trackRef: 'track-4', index: 3, name: 'Track 4' }, clip: { ...clip, trackRef: 'track-4', clipRef: 'clip-4' } } },
    'track-delete': { type: 'track-delete', projectId, data: { track: trackSnapshot, clips: [{ ...clip, clipRef: 'clip-3', recoveryId: 'recovery-3' }], automation: [envelope] } },
    'track-volume': volume,
    'track-mute': { type: 'track-mute', projectId, data: { trackRef: 'track-1', scope: 'shared', from: false, to: true } },
    'track-solo': { type: 'track-solo', projectId, data: { trackRef: 'track-1', scope: 'local', from: true, to: false } },
    'track-routing': { type: 'track-routing', projectId, data: { trackRef: 'track-1', from: { sends: [] }, to: routing } },
    'track-group': { type: 'track-group', projectId, data: { groupTrackRef: 'group-1', groupTrack: { index: 0, name: 'Group' }, childUpdates: [{ trackRef: 'track-1', nextOutputTargetRef: 'group-1' }] } },
    'track-ungroup': { type: 'track-ungroup', projectId, data: { groupTrackRef: 'group-1', sourceGroupTrackId: 'group-1', groupTrack: { ...trackSnapshot, trackRef: 'group-1', channelRole: 'group' }, childSnapshots: [{ trackRef: 'track-1', previousGroupRef: 'group-1' }] } },
    'track-color': { type: 'track-color', projectId, data: { trackRef: 'track-1', from: undefined, to: 'track-green' } },
    'track-color-cascade': { type: 'track-color-cascade', projectId, data: { tracks: [{ trackRef: 'track-1', from: undefined, to: 'track-green' }], clips: [{ clipRef: 'clip-1', from: undefined, to: 'track-green' }] } },
    'track-reorder': { type: 'track-reorder', projectId, data: { patches: [{ trackRef: 'track-1', fromIndex: 0, toIndex: 1 }, { trackRef: 'track-2', fromIndex: 1, toIndex: 0 }] } },
    'effect-params': { type: 'effect-params', projectId, data: { trackRef: 'track-1', effect: 'compressor', instanceId: 'compressor-1', from: compressor, to: { ...compressor, thresholdDb: -30 } } },
    'automation-envelope-change': { type: 'automation-envelope-change', projectId, data: { before: null, after: envelope } },
  }
}

const fixtureText = (value: JsonValue) => JSON.stringify(value, null, 2) + '\n'

const matchesFixture = (url: string, actual: string) => {
  if (process.env.UPDATE_HISTORY_FIXTURES === '1') writeFileSync(url, actual)
  expect(existsSync(url)).toBe(true)
  expect(actual).toBe(readFileSync(url, 'utf8'))
}

const history = () => {
  const entries = Object.values(entryOfEveryType())

  return { undo: entries, redo: entries.toReversed() }
}

test('persists one history holding every entry type byte for byte', () => {
  matchesFixture(FORMAT_FIXTURE, fixtureText(z.json().parse(serializePersistedHistory(history()))))
})

test('loads the committed history back to the entries that wrote it', () => {
  const loaded = normalizePersistedHistory(z.json().parse(JSON.parse(readFileSync(FORMAT_FIXTURE, 'utf8'))))
  expect(loaded).toEqual(normalizePersistedHistory(serializePersistedHistory(history())))
  expect(loaded.undo.map((entry) => entry.type)).toEqual(Object.values(entryOfEveryType()).map((entry) => entry.type))
})

const replayRepository = async () => {
  const repository = createLocalTimelineRepository(projectId)
  await repository.createTrack({ id: 'track-1' })
  await repository.createTrack({ id: 'track-2' })
  await repository.createClip({ id: 'clip-1', trackId: 'track-1', startSec: 0, duration: 4 })
}

const replayTracks = (): Track[] => ['track-1', 'track-2'].map((id) => ({
  id,
  historyRef: id,
  name: id,
  volume: 0.5,
  clips: id === 'track-1' ? [{ id: 'clip-1', historyRef: 'clip-1', name: 'Clip 1', startSec: 0, duration: 4, color: 'track-blue' }] : [],
  muted: false,
  soloed: false,
  kind: 'audio',
  channelRole: 'track',
  sends: [],
}))

const replay = async (loaded: HistoryEntry[]) => {
  const outcomes: Record<string, string[]> = {}

  for (const entry of loaded) {
    const calls: string[] = []
    const record = (name: string) => () => { calls.push(name) }

    const deps: Deps = {
      convexClient,
      convexApi,
      getTracks: replayTracks,
      getHistoryEntries: () => loaded,
      projectId,
      userId: 'user',
      persistLocalMix: () => calls.push('persistLocalMix'),
      grantTrackWrite: record('grantTrackWrite'),
      grantClipWrite: record('grantClipWrite'),
      actions: {
        insertLocalTrack: record('insertLocalTrack'),
        removeLocalTrack: record('removeLocalTrack'),
        insertLocalClip: record('insertLocalClip'),
        replaceLocalClip: record('replaceLocalClip'),
        removeLocalClips: record('removeLocalClips'),
        commitClipMoves: record('commitClipMoves'),
        commitClipTiming: record('commitClipTiming'),
        commitClipAudioWarp: record('commitClipAudioWarp'),
        commitClipFades: record('commitClipFades'),
        commitClipMidi: record('commitClipMidi'),
        rescheduleChangedClips: record('rescheduleChangedClips'),
        cancelTrackVolumeWrite: record('cancelTrackVolumeWrite'),
        cancelTrackRoutingWrite: record('cancelTrackRoutingWrite'),
        cancelTrackMixWrite: record('cancelTrackMixWrite'),
        applyTrackVolume: record('applyTrackVolume'),
        applyTrackMixState: record('applyTrackMixState'),
        applyTrackRouting: record('applyTrackRouting'),
        applyTrackPatch: record('applyTrackPatch'),
        applyAutomationEnvelope: record('applyAutomationEnvelope'),
      },
    }

    for (const [direction, run] of [['undo', execUndo], ['redo', execRedo]] as const) {
      calls.push(direction)

      try {
        await run(entry, deps)
        calls.push('ok')
      } catch (error) {
        calls.push(error instanceof Error ? error.message : String(error))
      }
    }

    outcomes[entry.type] = calls
  }

  return outcomes
}

const mergeResults = () => {
  const results: Record<string, number> = {}

  for (const entry of Object.values(entryOfEveryType())) {
    const manager = createUndoManager({})
    manager.push(entry, 'gesture')
    manager.push(entry, 'gesture')
    results[entry.type] = manager.snapshot().undo.length
  }

  const [first, second] = [{ ...entryOfEveryType()['effect-params'] }, entryOfEveryType()['effect-params']]
  const manager = createUndoManager({})
  manager.push(first, 'gesture')
  manager.push({ ...second, data: { ...second.data, instanceId: 'compressor-2' } }, 'gesture')
  results['effect-params other instance'] = manager.snapshot().undo.length

  return results
}

const legacyClipDelete = { type: 'clip-delete', projectId, data: { items: [{ trackRef: 'track-1', clip }] } }

const legacyEnvelope = () => ({
  version: 6,
  effectParamsVersions: AUDIO_EFFECT_PARAMS_VERSION,
  undo: [
    legacyClipDelete,
    { type: 'section-edit', projectId, data: { entries: [legacyClipDelete, z.json().parse(entryOfEveryType()['track-volume'])] } },
    { type: 'not-an-entry', projectId, data: {} },
  ],
  redo: [],
})

test('keeps replay outcomes, merge rules and legacy upgrades of every entry type', async () => {
  await replayRepository()
  const loaded = normalizePersistedHistory(z.json().parse(JSON.parse(readFileSync(FORMAT_FIXTURE, 'utf8')))).undo

  matchesFixture(BEHAVIOR_FIXTURE, fixtureText(z.json().parse({
    replay: await replay(loaded),
    merge: mergeResults(),
    legacyV6: normalizePersistedHistory(legacyEnvelope()),
  })))
})
