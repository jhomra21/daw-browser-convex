import { describe, expect, test } from 'bun:test'
import type { Clip } from '@daw-browser/timeline-core/types'
import { buildClipCreateSnapshot, buildClipHistorySnapshot } from './clip-create'

const clip = (input: Partial<Clip> & Pick<Clip, 'id' | 'name' | 'startSec' | 'duration' | 'color'>): Clip => ({
  ...input,
})

describe('clip create snapshots', () => {
  test('preserves explicit clip colors for create and history consumers', () => {
    const sourceClip = clip({
      id: 'clip-1',
      historyRef: 'clip-history-1',
      name: 'Clip 1',
      startSec: 1,
      duration: 2,
      color: '#ff00aa',
    })

    expect(buildClipCreateSnapshot(sourceClip)).toMatchObject({
      historyRef: 'clip-history-1',
      color: '#ff00aa',
    })
    expect(buildClipHistorySnapshot(sourceClip)).toMatchObject({
      clipRef: 'clip-history-1',
      color: '#ff00aa',
    })
  })
})
