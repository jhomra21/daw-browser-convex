import {
  benchmarkWorkerAssetUrl,
  createBrowserWorker,
  createNativeSabRecordingWriter,
} from './native-sab-recording-writer'

// Opt-in packaged benchmark only. Electron loads blob modules but fails to
// start the same bundled module directly from its custom daw: scheme.
export const createBenchmarkSabRecordingWriter = async (
  input: Parameters<typeof createNativeSabRecordingWriter>[0],
) => {
  const { default: recordingWorkerAssetUrl } = await import('../../workers/recording-writer-worker.ts?worker&url')
  const asset = new URL(recordingWorkerAssetUrl, location.href)
  if (!benchmarkWorkerAssetUrl(asset, new URL(location.href))) {
    throw new Error('SAB benchmark requires the packaged app origin.')
  }
  const response = await fetch(asset)
  if (!response.ok || !benchmarkWorkerAssetUrl(new URL(response.url), new URL(location.href))) {
    throw new Error('SAB benchmark worker asset is unavailable.')
  }
  const objectUrl = URL.createObjectURL(new Blob([await response.blob()], { type: 'text/javascript' }))
  try {
    const worker = new Worker(objectUrl, { type: 'module' })
    return createNativeSabRecordingWriter({
      ...input,
      worker: createBrowserWorker(worker, () => URL.revokeObjectURL(objectUrl)),
    })
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}
