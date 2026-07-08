import { describe, expect, test } from 'bun:test'
import { buildTrackTree, flattenVisibleTracks } from './timeline-track-layout'
import { resolveTimelineTracks } from './resolve-timeline-tracks'
import type { TimelineSnapshot, TimelineTrackRow } from './timeline-repository/types'
import type { Track } from '@daw-browser/timeline-core/types'

const trackRow = (input: Pick<TimelineTrackRow, 'id' | 'index'> & Partial<TimelineTrackRow>): TimelineTrackRow => ({
  historyRef: input.id,
  name: input.id,
  volume: 1,
  muted: false,
  soloed: false,
  kind: 'audio',
  channelRole: 'track',
  sends: [],
  createdAt: 0,
  updatedAt: 0,
  ...input,
})

const pendingTrack = (input: Pick<TimelineTrackRow, 'id' | 'index'> & Partial<TimelineTrackRow>): Track => {
  const row = trackRow(input)
  return {
    id: row.id,
    historyRef: row.historyRef,
    name: row.name,
    volume: row.volume,
    clips: [],
    muted: row.muted,
    soloed: row.soloed,
    kind: row.kind,
    channelRole: row.channelRole,
    sends: row.sends,
    groupId: row.groupId,
    collapsed: row.collapsed,
    color: row.color,
    outputTargetId: row.outputTargetId,
  }
}

describe('resolveTimelineTracks', () => {
  test('preserves grouping fields needed by visible track layout', () => {
    const snapshot: TimelineSnapshot = {
      projectId: 'project:local',
      tracks: [
        trackRow({ id: 'g', index: 0, channelRole: 'group', collapsed: true, color: '#22c55e' }),
        trackRow({ id: 'a', index: 1, groupId: 'g', outputTargetId: 'g' }),
        trackRow({ id: 'b', index: 2 }),
      ],
      clips: [],
    }

    const tracks = resolveTimelineTracks({
      projectId: snapshot.projectId,
      server: {
        localSnapshot: snapshot,
      },
      client: {
        mix: {
          syncMix: true,
          writableTrackIds: new Set(),
          localByTrackId: {},
          pendingSharedTrackVolumes: new Map(),
          pendingSharedTrackRouting: new Map(),
          pendingSharedMixByTrackId: new Map(),
        },
        tracks: {
          pendingEntriesById: new Map(),
          removedIds: new Set(),
          pendingLocksById: new Map(),
          historyRefsById: new Map(),
          namesByHistoryRef: new Map(),
        },
        clips: {
          pendingCreatesById: new Map(),
          removedIds: new Set(),
          committedEditsById: new Map(),
          draftEditsById: new Map(),
          previewByTrackId: new Map(),
          historyRefsById: new Map(),
        },
      },
      buffers: {
        getBuffer: () => undefined,
        getMediaStatus: () => undefined,
      },
    })

    expect(tracks.find((track) => track.id === 'a')?.groupId).toBe('g')
    expect(tracks.find((track) => track.id === 'g')?.collapsed).toBe(true)
    expect(tracks.find((track) => track.id === 'g')?.color).toBe('#22c55e')
    expect(tracks.find((track) => track.id === 'a')?.outputTargetId).toBe('g')
    expect(flattenVisibleTracks(buildTrackTree(tracks), { g: true })).toEqual(['g', 'b'])
  })

  test('preserves persisted clip colors during resolution', () => {
    const snapshot: TimelineSnapshot = {
      projectId: 'project:local',
      tracks: [trackRow({ id: 'a', index: 0 })],
      clips: [{
        id: 'clip-1',
        trackId: 'a',
        historyRef: 'clip-1',
        name: 'Clip',
        startSec: 0,
        duration: 1,
        color: '#f97316',
        createdAt: 0,
        updatedAt: 0,
      }],
    }

    const tracks = resolveTimelineTracks({
      projectId: snapshot.projectId,
      server: {
        localSnapshot: snapshot,
      },
      client: {
        mix: {
          syncMix: true,
          writableTrackIds: new Set(),
          localByTrackId: {},
          pendingSharedTrackVolumes: new Map(),
          pendingSharedTrackRouting: new Map(),
          pendingSharedMixByTrackId: new Map(),
        },
        tracks: {
          pendingEntriesById: new Map(),
          removedIds: new Set(),
          pendingLocksById: new Map(),
          historyRefsById: new Map(),
          namesByHistoryRef: new Map(),
        },
        clips: {
          pendingCreatesById: new Map(),
          removedIds: new Set(),
          committedEditsById: new Map(),
          draftEditsById: new Map(),
          previewByTrackId: new Map(),
          historyRefsById: new Map(),
        },
      },
      buffers: {
        getBuffer: () => undefined,
        getMediaStatus: () => undefined,
      },
    })

    expect(tracks[0]?.clips[0]?.color).toBe('#f97316')
  })

  test('applies pending grouping fields for existing tracks before server echo', () => {
    const snapshot: TimelineSnapshot = {
      projectId: 'project:local',
      tracks: [
        trackRow({ id: 'g', index: 0, channelRole: 'group', collapsed: false }),
        trackRow({ id: 'a', index: 1 }),
        trackRow({ id: 'b', index: 2 }),
      ],
      clips: [],
    }

    const pendingGroup = pendingTrack({ id: 'g', index: 0, channelRole: 'group', collapsed: true, color: '#22c55e' })
    const pendingChild = pendingTrack({ id: 'a', index: 1, groupId: 'g', outputTargetId: 'g' })

    const tracks = resolveTimelineTracks({
      projectId: snapshot.projectId,
      server: {
        localSnapshot: snapshot,
      },
      client: {
        mix: {
          syncMix: true,
          writableTrackIds: new Set(),
          localByTrackId: {},
          pendingSharedTrackVolumes: new Map(),
          pendingSharedTrackRouting: new Map(),
          pendingSharedMixByTrackId: new Map(),
        },
        tracks: {
          pendingEntriesById: new Map([
            ['g', { index: 0, track: pendingGroup }],
            ['a', { index: 1, track: pendingChild }],
          ]),
          removedIds: new Set(),
          pendingLocksById: new Map(),
          historyRefsById: new Map(),
          namesByHistoryRef: new Map(),
        },
        clips: {
          pendingCreatesById: new Map(),
          removedIds: new Set(),
          committedEditsById: new Map(),
          draftEditsById: new Map(),
          previewByTrackId: new Map(),
          historyRefsById: new Map(),
        },
      },
      buffers: {
        getBuffer: () => undefined,
        getMediaStatus: () => undefined,
      },
    })

    expect(tracks.find((track) => track.id === 'g')?.collapsed).toBe(true)
    expect(tracks.find((track) => track.id === 'a')?.groupId).toBe('g')
    expect(tracks.find((track) => track.id === 'a')?.outputTargetId).toBe('g')
    expect(flattenVisibleTracks(buildTrackTree(tracks), { g: true })).toEqual(['g', 'b'])
  })

  test('applies pending track routing before stale server routing', () => {
    const snapshot: TimelineSnapshot = {
      projectId: 'project:local',
      tracks: [
        trackRow({ id: 'g', index: 0, channelRole: 'group' }),
        trackRow({ id: 'a', index: 1, outputTargetId: 'g' }),
      ],
      clips: [],
    }
    const pendingChild = pendingTrack({ id: 'a', index: 1, outputTargetId: 'g' })

    const tracks = resolveTimelineTracks({
      projectId: snapshot.projectId,
      server: {
        localSnapshot: snapshot,
        trackState: {
          serverVolumes: new Map(),
          serverMuted: new Map(),
          serverSoloed: new Map(),
          serverRouting: new Map([['a', { sends: [], outputTargetId: undefined }]]),
        },
      },
      client: {
        mix: {
          syncMix: true,
          writableTrackIds: new Set(),
          localByTrackId: {},
          pendingSharedTrackVolumes: new Map(),
          pendingSharedTrackRouting: new Map(),
          pendingSharedMixByTrackId: new Map(),
        },
        tracks: {
          pendingEntriesById: new Map([['a', { index: 1, track: pendingChild }]]),
          removedIds: new Set(),
          pendingLocksById: new Map(),
          historyRefsById: new Map(),
          namesByHistoryRef: new Map(),
        },
        clips: {
          pendingCreatesById: new Map(),
          removedIds: new Set(),
          committedEditsById: new Map(),
          draftEditsById: new Map(),
          previewByTrackId: new Map(),
          historyRefsById: new Map(),
        },
      },
      buffers: {
        getBuffer: () => undefined,
        getMediaStatus: () => undefined,
      },
    })

    expect(tracks.find((track) => track.id === 'a')?.outputTargetId).toBe('g')
  })

  test('preserves pending output clears before stale server routing', () => {
    const snapshot: TimelineSnapshot = {
      projectId: 'project:local',
      tracks: [
        trackRow({ id: 'g', index: 0, channelRole: 'group' }),
        trackRow({ id: 'a', index: 1, outputTargetId: 'g' }),
      ],
      clips: [],
    }
    const pendingChild = pendingTrack({ id: 'a', index: 1 })

    const tracks = resolveTimelineTracks({
      projectId: snapshot.projectId,
      server: {
        localSnapshot: snapshot,
        trackState: {
          serverVolumes: new Map(),
          serverMuted: new Map(),
          serverSoloed: new Map(),
          serverRouting: new Map([['a', { sends: [], outputTargetId: 'g' }]]),
        },
      },
      client: {
        mix: {
          syncMix: true,
          writableTrackIds: new Set(),
          localByTrackId: {},
          pendingSharedTrackVolumes: new Map(),
          pendingSharedTrackRouting: new Map(),
          pendingSharedMixByTrackId: new Map(),
        },
        tracks: {
          pendingEntriesById: new Map([['a', { index: 1, track: pendingChild }]]),
          removedIds: new Set(),
          pendingLocksById: new Map(),
          historyRefsById: new Map(),
          namesByHistoryRef: new Map(),
        },
        clips: {
          pendingCreatesById: new Map(),
          removedIds: new Set(),
          committedEditsById: new Map(),
          draftEditsById: new Map(),
          previewByTrackId: new Map(),
          historyRefsById: new Map(),
        },
      },
      buffers: {
        getBuffer: () => undefined,
        getMediaStatus: () => undefined,
      },
    })

    expect(tracks.find((track) => track.id === 'a')?.outputTargetId).toBeUndefined()
  })
})
