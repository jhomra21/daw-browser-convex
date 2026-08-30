import { expect, test } from 'bun:test'

import { createDesktopRendererExportOutputTargetFactory } from '~/lib/desktop/capability-export-output-targets'
import { exportOutputPickerStatus } from '~/lib/export/export-output-picker-status'

type FilePickResult =
  | { canceled: true }
  | { canceled: false; file: { token: string; basename: string } }

test('reports the desktop save picker only while output selection is pending', async () => {
  exportOutputPickerStatus.set(false)
  let resolvePick: (result: FilePickResult) => void = () => undefined
  const bridge = {
    beginWrite: async (_requestId: string, _token: string, _relativePath?: string) => ({ writerId: 'writer-1' }),
    writeChunk: async (_requestId: string, _writerId: string, offset: number, chunk: Uint8Array) => ({
      nextOffset: offset + chunk.byteLength,
    }),
    commit: async (_requestId: string, _writerId: string) => ({
      basename: 'mixdown.wav',
      byteLength: 0,
      mime: 'audio/wav',
    }),
    abort: async (_requestId: string, _writerId: string) => undefined,
    pickOutputFile: async (_requestId: string, _format: string) => await new Promise<FilePickResult>((resolve) => {
      resolvePick = resolve
    }),
    pickOutputDirectory: async (_requestId: string) => ({ canceled: true as const }),
    releaseExportOutput: async (_requestId: string) => undefined,
  }
  const factory = createDesktopRendererExportOutputTargetFactory(bridge)
  const targetPromise = factory.createMixdownTarget({
    projectId: 'project:test-export-picker',
    localProject: true,
    multiFormat: false,
    firstFormat: 'wav',
    firstFileName: 'mixdown.wav',
    firstFileTypes: [],
  })

  expect(exportOutputPickerStatus.current()).toBe(true)
  resolvePick({ canceled: true })
  await expect(targetPromise).rejects.toMatchObject({ name: 'AbortError' })
  expect(exportOutputPickerStatus.current()).toBe(false)
})
