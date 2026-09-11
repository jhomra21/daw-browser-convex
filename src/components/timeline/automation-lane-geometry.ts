import {
  valueAtAutomationTime,
  type AutomationPoint,
} from '@daw-browser/shared'

export const windowAutomationPoints = (
  points: AutomationPoint[],
  startSec: number,
  endSec: number,
  defaultValue: number,
) => {
  const windowed = points
    .filter((point) => point.timeSec >= startSec && point.timeSec <= endSec)
    .sort((left, right) => left.timeSec - right.timeSec)
  const boundaryPoints = [
    { id: 'automation-window-start', timeSec: startSec, value: valueAtAutomationTime(points, startSec, defaultValue), interpolation: 'linear' as const },
    { id: 'automation-window-end', timeSec: endSec, value: valueAtAutomationTime(points, endSec, defaultValue), interpolation: 'linear' as const },
  ]
  const unique = new Map<number, AutomationPoint>()
  for (const point of [...windowed, ...boundaryPoints]) {
    if (!unique.has(point.timeSec)) unique.set(point.timeSec, point)
  }
  return [...unique.values()].sort((left, right) => left.timeSec - right.timeSec)
}
