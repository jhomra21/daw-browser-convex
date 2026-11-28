import { describe, expect, test } from 'bun:test'
import type { ProjectSnapshotV2 } from '@daw-browser/control'
import { buildTimelineRangeDeletePatchV1 } from './timeline-range-delete'

type Snapshot = Omit<ProjectSnapshotV2, 'version'>

type Clip = Snapshot['clips'][number]

const clip = (input: Partial<Clip> & Pick<Clip, 'id' | 'startSec' | 'duration'>): Clip => ({
  trackId: 'track-1',
  name: input.id,
  leftPadSec: 0,
  bufferOffsetSec: 0,
  midiOffsetBeats: 0,
  ...input,
})

const snapshotWith = (clips: Clip[], automation: Snapshot['automation'] = []): Snapshot => ({
  project: {
    id: 'project-1',
    name: 'Project',
    revision: 0,
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { enabled: false, startSec: 0, endSec: 8 },
    masterVolume: 0.8,
    updatedAt: 0,
  },
  tracks: [],
  clips,
  processors: [],
  automation,
  sidechains: [],
  assets: [],
  assetFolders: [],
})

const volumeEnvelope = (): Snapshot['automation'][number] => ({
  target: { trackId: 'track-1' },
  parameterId: 'volume',
  enabled: true,
  points: [
    { id: 'p0', timeSec: 0, value: 0.1, interpolation: 'linear' },
    { id: 'p1', timeSec: 2, value: 0.2, interpolation: 'linear' },
    { id: 'p2', timeSec: 4, value: 0.4, interpolation: 'hold' },
    { id: 'p3', timeSec: 8, value: 0.8, interpolation: 'linear' },
  ],
})

const source = (durationSec: number): Clip['source'] => ({ assetId: 'asset-1', sourceKind: 'upload', durationSec })

const deleteRange = (clips: Clip[], startSec: number, endSec: number) =>
  buildTimelineRangeDeletePatchV1(snapshotWith(clips), ['track-1'], startSec, endSec, 0)

describe('timeline range delete patch', () => {
  test('removes a clip fully contained in the range', () => {
    const patch = deleteRange([clip({ id: 'clip-1', startSec: 2, duration: 1 })], 1, 4)

    expect(patch.clipDeletes.map((entry) => entry.clipId)).toEqual(['clip-1'])
    expect(patch.clipUpdates).toEqual([])
    expect(patch.clipCreates).toEqual([])
  })

  test('shortens a clip overlapping the range start', () => {
    const patch = deleteRange([clip({ id: 'clip-1', startSec: 0, duration: 2 })], 1, 4)

    expect(patch.clipUpdates[0]?.after).toMatchObject({ startSec: 0, duration: 1 })
  })

  test('moves the start and offsets the buffer for a clip overlapping the range end', () => {
    const patch = deleteRange([clip({ id: 'clip-1', startSec: 3, duration: 3, source: source(6) })], 1, 4)

    expect(patch.clipUpdates[0]?.after).toMatchObject({ startSec: 4, duration: 2, bufferOffsetSec: 1 })
  })

  test('consumes the audio left pad before advancing the buffer offset', () => {
    const patch = deleteRange(
      [clip({ id: 'clip-1', startSec: 3, duration: 5, leftPadSec: 2, bufferOffsetSec: 1, source: source(8) })],
      1,
      4,
    )

    expect(patch.clipUpdates[0]?.after).toMatchObject({ startSec: 4, duration: 4, leftPadSec: 1, bufferOffsetSec: 1 })
  })

  test('adjusts the warp after consuming warped leading silence', () => {
    const patch = deleteRange([clip({
      id: 'clip-1',
      startSec: 3,
      duration: 5,
      source: source(5),
      audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120, sourceBeatOffset: 1 },
    })], 1, 4)

    expect(patch.clipUpdates[0]?.after).toMatchObject({
      startSec: 4,
      duration: 4,
      leftPadSec: 0,
      bufferOffsetSec: 0.5,
      audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 },
    })
    expect(patch.clipUpdates[0]?.after.audioWarp?.sourceBeatOffset).toBeUndefined()
  })

  test('splits a clip containing the range', () => {
    const patch = deleteRange([clip({ id: 'clip-1', startSec: 0, duration: 8 })], 2, 6)

    expect(patch.clipUpdates[0]?.after.duration).toBe(2)
    expect(patch.clipCreates[0]?.sourceClipId).toBe('clip-1')
    expect(patch.clipCreates[0]?.after).toMatchObject({ startSec: 6, duration: 2 })
  })

  test('keeps only the outer fades on each fragment of a middle deletion', () => {
    const patch = deleteRange([clip({
      id: 'clip-1',
      startSec: 0,
      duration: 8,
      fades: { fadeInSec: 1, fadeOutSec: 1, fadeInCurve: 0, fadeOutCurve: 0 },
    })], 2, 6)

    expect(patch.clipUpdates[0]?.after.fades).toMatchObject({ fadeInSec: 1, fadeOutSec: 0, fadeInCurve: 0, fadeOutCurve: 0 })
    expect(patch.clipCreates[0]?.after.fades).toMatchObject({ fadeInSec: 0, fadeOutSec: 1, fadeInCurve: 0, fadeOutCurve: 0 })
  })

  test('ignores clips outside the range and on unselected tracks', () => {
    const patch = buildTimelineRangeDeletePatchV1(snapshotWith([
      clip({ id: 'before', startSec: 0, duration: 1 }),
      clip({ id: 'after', startSec: 4, duration: 1 }),
      clip({ id: 'other', trackId: 'track-2', startSec: 2, duration: 1 }),
    ]), ['track-1'], 1, 4, 0)

    expect(patch).toEqual({ trackIds: ['track-1'], clipDeletes: [], clipUpdates: [], clipCreates: [], automationUpdates: [] })
  })

  test('removes interior automation points and keeps the boundary values', () => {
    const patch = buildTimelineRangeDeletePatchV1(snapshotWith([], [volumeEnvelope()]), ['track-1'], 1, 5, 0)
    const points = patch.automationUpdates[0]?.after.points

    expect(points?.map((point) => point.id)).not.toContain('p1')
    expect(points?.map((point) => point.id)).not.toContain('p2')
    expect(points?.find((point) => point.timeSec === 1)?.value).toBeCloseTo(0.15, 10)
    expect(points?.find((point) => point.timeSec === 5)?.value).toBeCloseTo(0.4, 10)
  })

  test('boundary point ids include the range time so repeated deletes do not collide', () => {
    const patch = buildTimelineRangeDeletePatchV1(snapshotWith([], [volumeEnvelope()]), ['track-1'], 1, 5, 0)
    const ids = patch.automationUpdates[0]?.after.points.map((point) => point.id)

    expect(ids).toContain('volume:delete-start:1')
    expect(ids).toContain('volume:delete-end:5')
  })

  test('skips automation with no points inside the range', () => {
    const patch = buildTimelineRangeDeletePatchV1(snapshotWith([], [volumeEnvelope()]), ['track-1'], 5, 7, 0)

    expect(patch.automationUpdates).toEqual([])
  })
})
