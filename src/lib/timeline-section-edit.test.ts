import { describe, expect, test } from 'bun:test'
import type { AutomationEnvelope } from '@daw-browser/shared'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import {
  buildAutomationFragment,
  buildClipRangeDeletePatch,
  buildSectionClipFragments,
  deleteAutomationRange,
  intersectingSectionClipIds,
  pasteAutomationFragment,
} from './timeline-section-edit'
import { ceilSecToBar, floorSecToBar, normalizeTimelineRangeSelection, snapTimeRangeToGridColumns } from './timeline-range-selection'
import { trackIdsInYRange, trackIndexAtY } from './timeline-track-layout'

const clip = (input: Partial<Clip> & { id: string; startSec: number; duration: number }): Clip<AudioBuffer> => ({
  id: input.id,
  name: input.name ?? input.id,
  startSec: input.startSec,
  duration: input.duration,
  color: input.color ?? '#fff',
  leftPadSec: input.leftPadSec,
  bufferOffsetSec: input.bufferOffsetSec,
  midiOffsetBeats: input.midiOffsetBeats,
  sourceDurationSec: input.sourceDurationSec,
  audioWarp: input.audioWarp,
  sampleUrl: input.sampleUrl,
  midi: input.midi,
})

const track = (clips: Clip<AudioBuffer>[]): Track<AudioBuffer> => ({
  id: 'track-1',
  name: 'Track 1',
  volume: 1,
  clips,
})

const envelope = (): AutomationEnvelope => ({
  id: 'env-1',
  projectId: 'project-1',
  target: { kind: 'track', trackId: 'track-1' },
  targetKey: 'track:track-1:volume',
  parameterId: 'volume',
  enabled: true,
  points: [
    { id: 'p0', timeSec: 0, value: 0.1, interpolation: 'linear' },
    { id: 'p1', timeSec: 2, value: 0.2, interpolation: 'linear' },
    { id: 'p2', timeSec: 4, value: 0.4, interpolation: 'hold' },
    { id: 'p3', timeSec: 8, value: 0.8, interpolation: 'linear' },
  ],
  updatedAt: 1,
})

describe('timeline range selection helpers', () => {
  test('normalizes and rejects empty selections', () => {
    expect(normalizeTimelineRangeSelection({ startSec: 4, endSec: 1, trackIds: ['a'], primaryTrackId: 'a' })).toEqual({
      startSec: 1,
      endSec: 4,
      trackIds: ['a'],
      primaryTrackId: 'a',
    })
    expect(normalizeTimelineRangeSelection({ startSec: 1, endSec: 1, trackIds: ['a'], primaryTrackId: 'a' })).toBeNull()
    expect(normalizeTimelineRangeSelection({ startSec: 1, endSec: 2, trackIds: [], primaryTrackId: null })).toBeNull()
  })

  test('snaps seconds to 4/4 bars', () => {
    expect(floorSecToBar(3.9, 120)).toBe(2)
    expect(ceilSecToBar(2.1, 120)).toBe(4)
  })

  test('snaps sub-bar drag ranges to the covered grid column', () => {
    expect(snapTimeRangeToGridColumns({ startSec: 1.25, endSec: 1.3 }, 120, 16)).toEqual({
      startSec: 1.25,
      endSec: 1.375,
    })
  })

  test('hit tests expanded track rows', () => {
    const rows = [
      { trackId: 'a', topPx: 0, heightPx: 100, clipLaneHeightPx: 64, automationHeightPx: 36 },
      { trackId: 'b', topPx: 100, heightPx: 80, clipLaneHeightPx: 64, automationHeightPx: 16 },
    ]
    expect(trackIndexAtY(rows, 90)).toBe(0)
    expect(trackIdsInYRange(rows, 90, 120)).toEqual(['a', 'b'])
  })
})

describe('timeline section edit helpers', () => {
  test('select bars 1-4 and duplicate to bars 5-8', () => {
    const fragments = buildSectionClipFragments({
      tracks: [track([clip({ id: 'clip-1', startSec: 1, duration: 2 })])],
      section: { range: { startSec: 0, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(fragments[0]?.clip.startSec).toBe(1)
    expect(4 + (fragments[0]?.startOffsetSec ?? 0)).toBe(5)
  })

  test('clip fully inside range is copied with same offset', () => {
    const [fragment] = buildSectionClipFragments({
      tracks: [track([clip({ id: 'clip-1', startSec: 2, duration: 1 })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(fragment?.startOffsetSec).toBe(1)
    expect(fragment?.duration).toBe(1)
  })

  test('clip starts before range and ends inside range is trimmed on copy', () => {
    const [fragment] = buildSectionClipFragments({
      tracks: [track([clip({ id: 'clip-1', startSec: 0, duration: 2 })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(fragment?.clip.startSec).toBe(0)
    expect(fragment?.clip.duration).toBe(1)
  })

  test('midi copy trim advances missing midi offset from zero', () => {
    const [fragment] = buildSectionClipFragments({
      tracks: [track([clip({ id: 'clip-1', startSec: 0, duration: 4, midi: { wave: 'sine', notes: [] } })])],
      section: { range: { startSec: 1, endSec: 3 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(fragment?.clip.timing?.midiOffsetBeats).toBe(2)
  })

  test('clip starts inside range and ends after range is trimmed on copy', () => {
    const [fragment] = buildSectionClipFragments({
      tracks: [track([clip({ id: 'clip-1', startSec: 3, duration: 3 })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(fragment?.clip.startSec).toBe(2)
    expect(fragment?.clip.duration).toBe(1)
  })

  test('clip spans whole range creates a copied segment only', () => {
    const [fragment] = buildSectionClipFragments({
      tracks: [track([clip({ id: 'clip-1', startSec: 0, duration: 8 })])],
      section: { range: { startSec: 2, endSec: 6 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(fragment?.clip.startSec).toBe(0)
    expect(fragment?.clip.duration).toBe(4)
  })

  test('copy trim consumes audio left pad before advancing buffer offset', () => {
    const [fragment] = buildSectionClipFragments({
      tracks: [track([clip({ id: 'clip-1', startSec: 0, duration: 8, leftPadSec: 2, bufferOffsetSec: 1, sourceDurationSec: 8 })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(fragment?.clip.duration).toBe(3)
    expect(fragment?.clip.timing?.leftPadSec).toBe(1)
    expect(fragment?.clip.timing?.bufferOffsetSec).toBe(1)
  })

  test('delete fully contained clip removes it', () => {
    const patch = buildClipRangeDeletePatch({
      tracks: [track([clip({ id: 'clip-1', startSec: 2, duration: 1 })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(patch.deleteClipIds).toEqual(['clip-1'])
  })

  test('finds every clip intersecting a selected section before delete', () => {
    const ids = intersectingSectionClipIds({
      tracks: [track([
        clip({ id: 'left', startSec: 0, duration: 2 }),
        clip({ id: 'inside', startSec: 3, duration: 1 }),
        clip({ id: 'right', startSec: 7, duration: 2 }),
        clip({ id: 'outside', startSec: 10, duration: 1 }),
      ])],
      section: { range: { startSec: 1, endSec: 8 }, trackIds: ['track-1'] },
    })
    expect(ids).toEqual(['left', 'inside', 'right'])
  })

  test('delete left overlap shortens clip', () => {
    const patch = buildClipRangeDeletePatch({
      tracks: [track([clip({ id: 'clip-1', startSec: 0, duration: 2 })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(patch.updateClips[0]?.timing).toEqual({ startSec: 0, duration: 1 })
  })

  test('delete right overlap moves start and adjusts offsets', () => {
    const patch = buildClipRangeDeletePatch({
      tracks: [track([clip({ id: 'clip-1', startSec: 3, duration: 3, bufferOffsetSec: 0 })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(patch.updateClips[0]?.timing.startSec).toBe(4)
    expect(patch.updateClips[0]?.timing.duration).toBe(2)
    expect(patch.updateClips[0]?.timing.bufferOffsetSec).toBe(1)
  })

  test('delete right overlap consumes audio left pad before advancing buffer offset', () => {
    const patch = buildClipRangeDeletePatch({
      tracks: [track([clip({ id: 'clip-1', startSec: 3, duration: 5, leftPadSec: 2, bufferOffsetSec: 1, sourceDurationSec: 8 })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(patch.updateClips[0]?.timing).toEqual({
      startSec: 4,
      duration: 4,
      leftPadSec: 1,
      bufferOffsetSec: 1,
      midiOffsetBeats: undefined,
    })
  })

  test('delete right overlap persists audio warp adjustment after consuming warped leading silence', () => {
    const patch = buildClipRangeDeletePatch({
      tracks: [track([clip({
        id: 'clip-1',
        startSec: 3,
        duration: 5,
        bufferOffsetSec: 0,
        sourceDurationSec: 5,
        audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120, sourceBeatOffset: 1 },
      })])],
      section: { range: { startSec: 1, endSec: 4 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(patch.updateClips[0]?.timing).toEqual({
      startSec: 4,
      duration: 4,
      leftPadSec: 0,
      bufferOffsetSec: 0.5,
      midiOffsetBeats: undefined,
      audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120, sourceBeatOffset: undefined },
    })
  })

  test('delete middle range splits clip', () => {
    const patch = buildClipRangeDeletePatch({
      tracks: [track([clip({ id: 'clip-1', startSec: 0, duration: 8 })])],
      section: { range: { startSec: 2, endSec: 6 }, trackIds: ['track-1'] },
      bpm: 120,
    })
    expect(patch.updateClips[0]?.timing.duration).toBe(2)
    expect(patch.createClips[0]?.clip.startSec).toBe(6)
    expect(patch.createClips[0]?.clip.duration).toBe(2)
  })

  test('automation fragment includes start boundary, interior points, and end boundary', () => {
    const fragment = buildAutomationFragment(envelope(), { startSec: 1, endSec: 5 })
    expect(fragment?.points.map((point) => point.timeOffsetSec)).toEqual([0, 1, 3, 4])
  })

  test('automation paste replaces destination range points', () => {
    const fragment = buildAutomationFragment(envelope(), { startSec: 1, endSec: 5 })
    expect(fragment).not.toBeNull()
    if (!fragment) return
    const pasted = pasteAutomationFragment({
      envelope: envelope(),
      fragment,
      projectId: 'project-1',
      destinationStartSec: 8,
      updatedAt: 2,
    })
    expect(pasted.points.some((point) => point.timeSec === 8)).toBe(true)
    expect(pasted.points.some((point) => point.timeSec === 10)).toBe(false)
  })

  test('automation delete removes interior points and preserves boundary values', () => {
    const deleted = deleteAutomationRange({ envelope: envelope(), range: { startSec: 1, endSec: 5 }, updatedAt: 2 })
    expect(deleted?.points.some((point) => point.id === 'p1')).toBe(false)
    expect(deleted?.points.some((point) => point.timeSec === 1)).toBe(true)
    expect(deleted?.points.some((point) => point.timeSec === 5)).toBe(true)
  })

  test('automation delete skips ranges with no points to remove', () => {
    const deleted = deleteAutomationRange({ envelope: envelope(), range: { startSec: 5, endSec: 7 }, updatedAt: 2 })
    expect(deleted).toBeNull()
  })
})
