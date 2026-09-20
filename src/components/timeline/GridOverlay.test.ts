import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'bun:test'

describe('GridOverlay phase projection', () => {
  test('uses bounded canonical phases instead of physical or unbounded offsets', async () => {
    const source = await readFile(new URL('./GridOverlay.tsx', import.meta.url), 'utf8')

    expect(source).toContain('timelineGridPhasePx(')
    expect(source).not.toContain('visibleStartSec * props.pixelsPerSecond')
    expect(source).not.toContain('scrollLeft')
    expect(source).not.toContain('runwayOffset')
    expect(source).not.toContain('physicalAnchor')
    expect(source.indexOf("'background-position'")).toBeGreaterThan(
      source.indexOf('background:'),
    )
  })
})
