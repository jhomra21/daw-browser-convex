import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { buildTimelineTrackLayoutRows, timelineTrackLaneHitRegion } from '~/lib/timeline-track-layout'
import { LANE_HEIGHT } from '~/lib/timeline-utils'

describe('TrackLane automation interaction path', () => {
  test('allocates the visible automation row below the clip row for the rendered lane', async () => {
    const rows = buildTimelineTrackLayoutRows({
      tracks: [{ id: 'track-2', groupId: undefined, channelRole: undefined, collapsed: false }],
      visibleByTrackId: { 'track-2': true },
      heightsByLaneOwnerKey: { 'track-2': 48 },
      visibleParameterIdsByTrackId: { 'track-2': ['automation:v2:["track","track-2",null,"volume"]'] },
    })
    const row = rows[0]
    expect(row).toMatchObject({
      topPx: 0,
      clipLaneHeightPx: LANE_HEIGHT,
      automationHeightPx: 48,
      heightPx: LANE_HEIGHT + 48,
    })
    if (!row) throw new Error('Expected a rendered track row.')
    expect(timelineTrackLaneHitRegion(row, row.clipLaneHeightPx + 10)).toBe('automation')
    expect(timelineTrackLaneHitRegion(row, row.clipLaneHeightPx - 1)).toBe('clip')

    const source = await readFile(new URL('./TrackLane.tsx', import.meta.url), 'utf8')
    expect(source).toContain('data-timeline-automation-surface="true"')
    expect(source).toContain('class="absolute inset-x-0 z-30 pointer-events-auto')
    expect(source).toContain('<AutomationLane')
    expect(source).toContain('onCommit={props.automation.onCommit}')
  })
})
