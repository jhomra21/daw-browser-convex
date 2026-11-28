import type * as ExportMixdown from '@daw-browser/audio-engine/export-mixdown'
import { isLossyExportAudioFormat } from '@daw-browser/shared'
import type { ExportFileSink } from '~/lib/export/export-output-targets'
import type { TimelineExportRequest } from '~/lib/export/export-job-types'
import type { requireExportFormats } from '~/lib/export/export-output-formats'
import type { processNativeOfflinePcmSpool } from '~/lib/export/process-native-offline-pcm-spool'

// The encode phase of one format: the processed PCM goes to the file sink's target, or to a buffer without a sink.
export const encodeProcessedPcm = (input: {
  exportMixdown: typeof ExportMixdown
  processed: Awaited<ReturnType<typeof processNativeOfflinePcmSpool>>
  format: ReturnType<typeof requireExportFormats>[number]
  fileSink: ExportFileSink | undefined
  request: Pick<TimelineExportRequest, 'encoding' | 'signal'>
  ditherSeed: number
  onWrite: (sizeBytes: number) => void
}) => input.exportMixdown.encodeAudioChunks(input.processed.replay(), {
  format: input.format,
  bitrate: isLossyExportAudioFormat(input.format) ? input.request.encoding.bitrateByFormat[input.format] : undefined,
  target: input.fileSink?.target ?? { mode: 'buffer' },
  signal: input.request.signal,
  onWrite: input.onWrite,
  wav: input.request.encoding.wav,
  ditherSeed: input.ditherSeed,
})
