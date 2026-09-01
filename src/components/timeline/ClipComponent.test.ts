import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

test('virtualizes the waveform canvas backing store to the visible clip window', async () => {
  const source = await readFile(new URL('./ClipComponent.tsx', import.meta.url), 'utf8')

  expect(source).toContain('getArrangementWaveformCanvasWindow')
  expect(source).toContain('const waveformCanvasWindow = createMemo')
  expect(source).toContain('const pxW = Math.ceil(canvasWindow.widthPx * dpr)')
  expect(source).toContain('canvas.width = 1')
  expect(source).toContain('class="absolute inset-y-0 pointer-events-none z-10"')
  expect(source).not.toContain('class="absolute inset-0 size-full pointer-events-none z-10"')
})
