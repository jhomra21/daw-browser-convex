import { isLocalId } from '@daw-browser/shared'

import { saveCloudExport } from '~/lib/cloud-export'
import {
  chooseLocalExportDirectory,
  chooseLocalExportFile,
  createLocalExportDirectoryWritable,
  createLocalExportWritable,
  saveBlobLocally,
} from '~/lib/local-export'
import { chooseStemExportDirectory, createStemExportWritable } from '~/lib/local-stem-export'
import type { ExportFileSink, ExportOutputTargetFactory } from '~/lib/export/export-output-targets'

const createSink = (name: string, writable: Awaited<ReturnType<typeof createLocalExportWritable>>): ExportFileSink => {
  let settled = false
  const commit = async () => {
    if (settled) return
    settled = true
    await writable.writable.close()
  }
  const abort = async (reason?: unknown) => {
    if (settled) return
    settled = true
    await writable.writable.abort(reason)
  }
  return {
    name,
    target: { mode: 'stream', writable: writable.writable, close: commit, abort },
    commit,
    abort,
  }
}

export const createBrowserExportOutputTargetFactory = (): ExportOutputTargetFactory => ({
  async createMixdownTarget(input) {
    const fileHandle = input.localProject && !input.multiFormat
      ? await chooseLocalExportFile({ suggestedName: input.firstFileName, types: input.firstFileTypes })
      : undefined
    const directory = input.localProject && input.multiFormat ? await chooseLocalExportDirectory() : undefined
    return {
      openFile: async (fileName) => {
        if (fileHandle) return createSink(fileHandle.name, await createLocalExportWritable(fileHandle))
        if (directory) return createSink(fileName, await createLocalExportDirectoryWritable(directory, fileName))
        return undefined
      },
      saveBuffer: async ({ blob, fileName, types, format, durationSec, sampleRate, signal }) => {
        if (input.localProject) {
          await saveBlobLocally({ blob, suggestedName: fileName, types })
          signal.throwIfAborted()
          return { destination: 'local', name: fileName }
        }
        if (!input.projectId || isLocalId('project', input.projectId)) throw new Error('Missing room')
        const upload = await saveCloudExport({ projectId: input.projectId, blob, name: fileName, format, durationSec, sampleRate, signal })
        return { destination: 'cloud', name: fileName, url: upload.url }
      },
    }
  },
  async createStemTarget() {
    const directory = await chooseStemExportDirectory()
    return {
      openFile: async (fileName) => createSink(fileName, await createStemExportWritable(directory, fileName)),
    }
  },
})
