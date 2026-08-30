import { expect, test } from 'bun:test'

import { formatExportProgressLabel } from '~/lib/export/export-progress-label'

test('shows native save picker wait explicitly', () => {
  expect(formatExportProgressLabel(
    { name: 'Timeline mixdown', progress: { phase: 'tail' } },
    { choosingSaveLocation: true },
  )).toBe('Timeline mixdown: Choosing save location…')
})

test('preserves normal rendering progress when the picker is closed', () => {
  expect(formatExportProgressLabel({
    name: 'Timeline mixdown',
    progress: { phase: 'rendering' },
  })).toBe('Timeline mixdown: Rendering...')
})
