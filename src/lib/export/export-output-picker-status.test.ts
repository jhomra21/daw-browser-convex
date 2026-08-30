import { expect, test } from 'bun:test'

import { exportOutputPickerStatus } from '~/lib/export/export-output-picker-status'

test('notifies subscribers when the output picker opens and closes', () => {
  exportOutputPickerStatus.set(false)
  const values: boolean[] = []
  const unsubscribe = exportOutputPickerStatus.subscribe((open) => values.push(open))

  exportOutputPickerStatus.set(true)
  exportOutputPickerStatus.set(true)
  exportOutputPickerStatus.set(false)
  unsubscribe()

  expect(values).toEqual([true, false])
  expect(exportOutputPickerStatus.current()).toBe(false)
})
